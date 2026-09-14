/**
 * Cola da interface: WebSocket, orbe, voz, legenda, transcrição e autorizações.
 *
 * O princípio que guia o desenho: a tela mostra **um estado por vez**. Enquanto
 * ela pensa, você vê o orbe pensando. Enquanto responde, você vê o texto
 * aparecendo como legenda. O histórico só ocupa a tela quando você pede.
 */
import { Orbe } from './orb.js';
import { Voz } from './voice.js';

const $ = (id) => document.getElementById(id);

const el = {
  canvas: $('orbe'),
  legenda: $('legenda'),
  atividade: $('atividade'),
  barra: document.querySelector('.barra'),
  form: $('form'),
  entrada: $('entrada'),
  microfone: $('btn-microfone'),
  parar: $('btn-parar'),
  transcricaoBtn: $('btn-transcricao'),
  transcricao: $('transcricao'),
  fecharTranscricao: $('btn-fechar-transcricao'),
  mensagens: $('mensagens'),
  permissao: $('permissao'),
  permRisco: $('perm-risco'),
  permTitulo: $('perm-titulo'),
  permExplica: $('perm-explica'),
  permCap: $('perm-cap'),
  permEscopo: $('perm-escopo'),
  permMotivo: $('perm-motivo'),
  permPrazo: $('perm-prazo'),
  avisos: $('avisos'),
  observador: $('observador'),
  conexao: $('conexao'),
};

const orbe = new Orbe(el.canvas);

const estado = {
  token: new URLSearchParams(location.search).get('token') || localStorage.getItem('iris_token') || '',
  conversaId: null,
  respondendo: false,
  bufferResposta: '',
  falarRespostas: localStorage.getItem('iris_voz') !== '0',
  filaPermissoes: [],
  permissaoAtual: null,
  ultimaEntradaPorVoz: false,
};

if (estado.token) {
  localStorage.setItem('iris_token', estado.token);
  // Tira o token da barra de endereço para não ficar no histórico do navegador.
  if (location.search.includes('token=')) {
    history.replaceState(null, '', location.pathname);
  }
}

// ── voz ──────────────────────────────────────────────────────────────────────

const voz = new Voz({
  idioma: 'pt-BR',
  aoNivel: (dados) => orbe.alimentarAudio(dados),
  aoParcial: (texto) => {
    el.entrada.value = texto;
    el.barra.classList.add('ativa');
  },
  aoTexto: (texto) => {
    estado.ultimaEntradaPorVoz = true;
    enviar(texto);
  },
  aoEstado: ({ gravando, erro, transcreve }) => {
    el.microfone.classList.toggle('gravando', Boolean(gravando));
    orbe.definirEstado(gravando ? 'listening' : estado.respondendo ? 'responding' : 'idle');
    if (gravando && transcreve === false) {
      mostrarAviso('Sem transcrição', 'Este navegador não reconhece fala. Use o teclado.', 'normal');
    }
    if (erro) mostrarAviso('Microfone', erro, 'normal');
  },
});

if (!voz.suportaReconhecimento) {
  el.microfone.title = 'Este navegador não reconhece fala — use o teclado';
  el.microfone.style.opacity = '0.4';
}

// ── websocket ────────────────────────────────────────────────────────────────

let socket = null;
let tentativas = 0;
let pingId = null;

function conectar() {
  const protocolo = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${protocolo}://${location.host}/ws?token=${encodeURIComponent(estado.token)}`);

  socket.addEventListener('open', () => {
    tentativas = 0;
    el.conexao.hidden = true;
    enviarSocket({ type: 'historico' });
    clearInterval(pingId);
    pingId = setInterval(() => enviarSocket({ type: 'ping' }), 25000);
  });

  socket.addEventListener('message', (evento) => {
    let msg;
    try {
      msg = JSON.parse(evento.data);
    } catch {
      return;
    }
    tratar(msg);
  });

  socket.addEventListener('close', () => {
    clearInterval(pingId);
    el.conexao.hidden = false;
    // Espera crescente, com teto de 10 s: reconecta sem martelar o servidor.
    const espera = Math.min(10000, 600 * 2 ** Math.min(tentativas++, 4));
    setTimeout(conectar, espera);
  });

  socket.addEventListener('error', () => socket?.close());
}

function enviarSocket(payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function tratar(msg) {
  switch (msg.type) {
    case 'ola':
      estado.conversaId = msg.conversaId;
      document.title = msg.assistente || 'Íris';
      el.observador.hidden = !msg.observador;
      break;

    case 'estado':
      aoMudarEstado(msg.estado, msg.detalhe);
      break;

    case 'delta':
      if (!estado.respondendo) {
        estado.respondendo = true;
        estado.bufferResposta = '';
      }
      estado.bufferResposta += msg.texto;
      orbe.pulsar(Math.min(2, msg.texto.length / 6));
      desenharLegenda(estado.bufferResposta, true);
      break;

    case 'mensagem':
      if (msg.papel === 'assistant') {
        estado.respondendo = false;
        estado.bufferResposta = msg.conteudo;
        desenharLegenda(msg.conteudo, false);
        adicionarMensagem('assistant', msg.conteudo);
        orbe.emitirOnda(0.8);
        if (estado.falarRespostas && estado.ultimaEntradaPorVoz) voz.falar(msg.conteudo);
      } else {
        adicionarMensagem('user', msg.conteudo);
      }
      break;

    case 'historico':
      estado.conversaId = msg.conversaId;
      el.mensagens.innerHTML = '';
      for (const m of msg.mensagens) adicionarMensagem(m.papel, m.conteudo, false);
      rolarParaBaixo();
      break;

    case 'ferramenta':
      if (msg.fase === 'inicio') {
        mostrarAtividade(msg.resumo || msg.nome);
      } else {
        mostrarAtividade(null);
        if (!msg.ok) adicionarMensagem('sistema', `${msg.nome}: ${msg.resumo}`);
      }
      break;

    case 'permissao':
      enfileirarPermissao(msg);
      break;

    case 'permissao_resolvida':
      if (estado.permissaoAtual?.id === msg.id) fecharPermissao();
      break;

    case 'notificacao':
      mostrarAviso(msg.title, msg.body, msg.urgency);
      orbe.emitirOnda(1.2);
      break;

    case 'observador':
      el.observador.hidden = !msg.active;
      break;

    case 'aprendi':
      if (msg.count > 0) mostrarAtividade(`guardei ${msg.count} aprendizado(s)`, 2600);
      break;

    case 'fim':
      estado.respondendo = false;
      el.parar.classList.add('oculto');
      if (msg.interrompido) adicionarMensagem('sistema', 'interrompido');
      break;

    case 'erro':
      mostrarAviso('Erro', msg.mensagem, 'high');
      orbe.definirEstado('error');
      setTimeout(() => orbe.definirEstado('idle'), 2200);
      break;
  }
}

function aoMudarEstado(novo, detalhe) {
  if (voz.gravando) return; // ouvir tem prioridade visual
  orbe.definirEstado(novo);
  el.parar.classList.toggle('oculto', novo === 'idle' || novo === 'error');
  if (novo === 'thinking') {
    estado.bufferResposta = '';
    desenharLegenda('', false);
  }
  if (novo === 'error' && detalhe) mostrarAviso('Erro', detalhe, 'high');
}

// ── envio ────────────────────────────────────────────────────────────────────

function enviar(texto) {
  const limpo = (texto ?? el.entrada.value).trim();
  if (!limpo) return;
  voz.calar();
  el.entrada.value = '';
  estado.bufferResposta = '';
  desenharLegenda('', false);
  orbe.definirEstado('thinking');
  orbe.emitirOnda(1);
  el.parar.classList.remove('oculto');
  enviarSocket({ type: 'mensagem', texto: limpo, conversaId: estado.conversaId });
}

el.form.addEventListener('submit', (evento) => {
  evento.preventDefault();
  estado.ultimaEntradaPorVoz = false;
  enviar();
});

el.microfone.addEventListener('click', () => voz.alternar());

el.parar.addEventListener('click', () => {
  enviarSocket({ type: 'interromper' });
  voz.calar();
});

// ── legenda e transcrição ────────────────────────────────────────────────────

function desenharLegenda(texto, emCurso) {
  if (!texto) {
    el.legenda.classList.remove('visivel');
    el.legenda.textContent = '';
    return;
  }
  // A legenda mostra o fim do texto: é a parte que está sendo dita agora.
  const visivel = texto.length > 900 ? '…' + texto.slice(-900) : texto;
  el.legenda.textContent = visivel;
  if (emCurso) {
    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    el.legenda.appendChild(cursor);
  }
  el.legenda.classList.add('visivel');
}

function adicionarMensagem(papel, conteudo, rolar = true) {
  if (!conteudo?.trim()) return;
  const div = document.createElement('div');
  div.className = `msg ${papel}`;
  const quem = document.createElement('span');
  quem.className = 'quem';
  quem.textContent = papel === 'user' ? 'você' : papel === 'assistant' ? 'íris' : 'sistema';
  div.appendChild(quem);
  div.appendChild(document.createTextNode(conteudo));
  el.mensagens.appendChild(div);
  if (rolar) rolarParaBaixo();
}

function rolarParaBaixo() {
  el.mensagens.scrollTop = el.mensagens.scrollHeight;
}

function alternarTranscricao(forcar) {
  const abrir = forcar ?? el.transcricao.hidden;
  el.transcricao.hidden = !abrir;
  if (abrir) rolarParaBaixo();
}

el.transcricaoBtn.addEventListener('click', () => alternarTranscricao());
el.fecharTranscricao.addEventListener('click', () => alternarTranscricao(false));

// ── atividade ────────────────────────────────────────────────────────────────

let atividadeId = null;
function mostrarAtividade(texto, duracao = 0) {
  clearTimeout(atividadeId);
  if (!texto) {
    el.atividade.classList.remove('visivel');
    return;
  }
  el.atividade.textContent = texto.length > 70 ? texto.slice(0, 70) + '…' : texto;
  el.atividade.classList.add('visivel');
  if (duracao) atividadeId = setTimeout(() => el.atividade.classList.remove('visivel'), duracao);
}

// ── autorizações ─────────────────────────────────────────────────────────────

function enfileirarPermissao(pedido) {
  if (estado.filaPermissoes.some((p) => p.id === pedido.id)) return;
  if (estado.permissaoAtual?.id === pedido.id) return;
  estado.filaPermissoes.push(pedido);
  if (!estado.permissaoAtual) proximaPermissao();
}

function proximaPermissao() {
  const pedido = estado.filaPermissoes.shift();
  if (!pedido) {
    el.permissao.hidden = true;
    estado.permissaoAtual = null;
    return;
  }
  estado.permissaoAtual = pedido;

  const detalhes = pedido.details ?? {};
  el.permRisco.textContent = `risco ${pedido.risk}`;
  el.permRisco.dataset.risco = pedido.risk;
  el.permTitulo.textContent = `Autorizar: ${detalhes.rotulo ?? pedido.capability}?`;
  el.permExplica.textContent = detalhes.explicacao ?? '';
  el.permCap.textContent = pedido.capability;
  el.permEscopo.textContent = pedido.scope;
  el.permMotivo.textContent = pedido.reason ? `Motivo: ${pedido.reason}` : '';

  const segundos = Math.max(0, Math.round((pedido.expiresAt - Date.now()) / 1000));
  el.permPrazo.textContent = segundos
    ? `Sem resposta em ${segundos}s, eu considero negado.`
    : '';

  el.permissao.hidden = false;
  el.permissao.querySelector('.acao.destaque')?.focus();
}

function fecharPermissao() {
  estado.permissaoAtual = null;
  proximaPermissao();
}

el.permissao.querySelectorAll('.acao').forEach((botao) => {
  botao.addEventListener('click', () => {
    const pedido = estado.permissaoAtual;
    if (!pedido) return;
    enviarSocket({ type: 'permissao', id: pedido.id, decisao: botao.dataset.decisao });
    fecharPermissao();
  });
});

// ── avisos ───────────────────────────────────────────────────────────────────

function mostrarAviso(titulo, corpo, urgencia = 'normal') {
  const div = document.createElement('div');
  div.className = 'aviso';
  div.dataset.urgencia = urgencia;
  const t = document.createElement('strong');
  t.textContent = titulo;
  const c = document.createElement('span');
  c.textContent = corpo ?? '';
  div.append(t, c);
  div.addEventListener('click', () => div.remove());
  el.avisos.appendChild(div);
  if (urgencia !== 'high') setTimeout(() => div.remove(), 12000);
}

// ── teclado ──────────────────────────────────────────────────────────────────

document.addEventListener('keydown', (evento) => {
  const digitando = document.activeElement === el.entrada;

  // Espaço fora do campo de texto: fala. Não vale com a autorização aberta.
  if (evento.code === 'Space' && !digitando && el.permissao.hidden) {
    evento.preventDefault();
    voz.alternar();
    return;
  }

  if (evento.key === 'Escape') {
    if (!el.permissao.hidden) return; // a autorização exige uma escolha explícita
    if (!el.transcricao.hidden) return alternarTranscricao(false);
    if (voz.gravando) return voz.parar();
    enviarSocket({ type: 'interromper' });
    voz.calar();
    return;
  }

  if (!digitando && (evento.key === 't' || evento.key === 'T')) {
    evento.preventDefault();
    alternarTranscricao();
    return;
  }

  if (!digitando && (evento.key === 'v' || evento.key === 'V')) {
    estado.falarRespostas = !estado.falarRespostas;
    localStorage.setItem('iris_voz', estado.falarRespostas ? '1' : '0');
    mostrarAtividade(estado.falarRespostas ? 'voz ligada' : 'voz desligada', 1800);
    if (!estado.falarRespostas) voz.calar();
    return;
  }

  // Qualquer tecla imprimível joga o foco para o campo de texto.
  if (!digitando && evento.key.length === 1 && !evento.ctrlKey && !evento.metaKey && !evento.altKey) {
    el.entrada.focus();
  }
});

el.entrada.addEventListener('focus', () => el.barra.classList.add('ativa'));
el.entrada.addEventListener('blur', () => {
  if (!el.entrada.value) el.barra.classList.remove('ativa');
});

// Clicar no vazio volta o foco para o campo — o gesto natural na tela limpa.
document.addEventListener('click', (evento) => {
  if (evento.target === document.body || evento.target === el.canvas) el.entrada.focus();
});

/**
 * Ponto de inspeção. Serve para depurar a interface sem precisar de um turno
 * real — `iris.simular({type:'estado', estado:'thinking'})` no console do
 * navegador põe o orbe no estado desejado, e é assim que as capturas de tela
 * da documentação são feitas.
 */
window.iris = { orbe, voz, estado, simular: tratar };

// ── início ───────────────────────────────────────────────────────────────────

if (!estado.token) {
  mostrarAviso(
    'Sem token de acesso',
    'Abra o endereço que apareceu no terminal, com ?token=… no fim.',
    'high',
  );
} else {
  conectar();
}

// As vozes do navegador carregam de forma assíncrona em alguns sistemas.
if (voz.suportaFala) speechSynthesis.getVoices();
