/**
 * Cola da interface: WebSocket, orbe, voz, legenda, transcrição e autorizações.
 *
 * O princípio que guia o desenho: a tela mostra **um estado por vez**. Enquanto
 * ele pensa, você vê o orbe pensando. Enquanto responde, você vê o texto
 * aparecendo como legenda. O histórico só ocupa a tela quando você pede.
 */
import { Orbe } from './orb.js';
import { Voz } from './voice.js';
import { PainelAjustes } from './ajustes.js';

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
  anexoBtn: $('btn-anexo'),
  arquivo: $('arquivo'),
  anexos: $('anexos'),
  soltar: $('soltar'),
};

const orbe = new Orbe(el.canvas);

const estado = {
  token: new URLSearchParams(location.search).get('token') || localStorage.getItem('gideao_token') || '',
  conversaId: null,
  respondendo: false,
  bufferResposta: '',
  falarRespostas: localStorage.getItem('gideao_voz') !== '0',
  legendas: true,
  assistente: 'Gideão',
  filaPermissoes: [],
  permissaoAtual: null,
  ultimaEntradaPorVoz: false,
  /** Anexos já enviados ao servidor, esperando a próxima mensagem. */
  anexos: [],
};

if (estado.token) {
  localStorage.setItem('gideao_token', estado.token);
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

// ── ajustes ──────────────────────────────────────────────────────────────────

const painel = new PainelAjustes({
  token: estado.token,
  voz,
  aoMudar: (cfg) => aplicarPreferencias(cfg),
});

/**
 * Aplica no que está na tela o que veio da configuração.
 *
 * Chamado no arranque (com o estado que o servidor manda) e a cada ajuste
 * salvo. Aceita configuração parcial porque a prévia do painel manda só o
 * campo que o dono está mexendo, enquanto ele arrasta o controle.
 */
function aplicarPreferencias(cfg = {}) {
  if (cfg.voz) {
    voz.configurar({
      voz: cfg.voz.nome,
      velocidade: cfg.voz.velocidade,
      tom: cfg.voz.tom,
    });
    if (typeof cfg.voz.falarAuto === 'boolean') {
      estado.falarRespostas = cfg.voz.falarAuto;
    }
  }
  if (cfg.tela) {
    if (typeof cfg.tela.matiz === 'number') orbe.definirMatiz(cfg.tela.matiz);
    if (typeof cfg.tela.legendas === 'boolean') {
      estado.legendas = cfg.tela.legendas;
      if (!cfg.tela.legendas) {
        el.legenda.classList.remove('visivel');
        el.legenda.textContent = '';
      }
    }
  }
  // Forma curta usada pela prévia do painel: { ui: { matiz } }.
  if (cfg.ui && typeof cfg.ui.matiz === 'number') orbe.definirMatiz(cfg.ui.matiz);
}

/** Converte a lista plana do servidor no formato que `aplicarPreferencias` usa. */
function preferenciasDe(ajustes = []) {
  const valor = (chave) => ajustes.find((a) => a.chave === chave)?.valor;
  return {
    voz: {
      nome: valor('voice.nome'),
      velocidade: valor('voice.velocidade'),
      tom: valor('voice.tom'),
      falarAuto: valor('voice.falarAuto'),
    },
    tela: { matiz: valor('ui.matiz'), legendas: valor('ui.legendas') },
  };
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
      estado.assistente = msg.assistente || 'Gideão';
      document.title = estado.assistente;
      el.observador.hidden = !msg.observador;
      aplicarPreferencias({ voz: msg.voz, tela: msg.tela });
      break;

    case 'ajustes':
      // Outra aba (ou a conversa) mexeu num ajuste. Recarrega o painel e
      // reaplica o que é visual, para as abas não divergirem.
      painel.atualizar(msg.ajustes);
      aplicarPreferencias(preferenciasDe(msg.ajustes));
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

// ── anexos ───────────────────────────────────────────────────────────────────

const MAX_ANEXO = 30 * 1024 * 1024;

async function anexar(arquivos) {
  for (const arquivo of arquivos) {
    if (arquivo.size > MAX_ANEXO) {
      mostrarAviso('Arquivo grande demais', `${arquivo.name} passa de 30 MB.`, 'normal');
      continue;
    }

    // Cartão otimista: o arquivo aparece na tela enquanto sobe.
    const cartao = cartaoAnexo(arquivo);
    estado.anexos.push(cartao);
    desenharAnexos();

    try {
      const base64 = await lerBase64(arquivo);
      const resposta = await fetch('/api/anexo', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${estado.token}` },
        body: JSON.stringify({ nome: arquivo.name, mime: arquivo.type, base64 }),
      });

      const corpo = await resposta.json();
      if (!resposta.ok) throw new Error(corpo.erro ?? `HTTP ${resposta.status}`);

      cartao.id = corpo.id;
      cartao.tipo = corpo.tipo;
      cartao.estado = 'pronto';
    } catch (err) {
      cartao.estado = 'erro';
      cartao.erro = String(err.message ?? err);
      mostrarAviso('Não consegui anexar', `${arquivo.name}: ${cartao.erro}`, 'normal');
    }
    desenharAnexos();
  }
  el.barra.classList.add('ativa');
}

function cartaoAnexo(arquivo) {
  return {
    chave: `${arquivo.name}-${arquivo.size}-${Date.now()}-${Math.random()}`,
    nome: arquivo.name,
    tipo: arquivo.type.startsWith('image/') ? 'imagem' : arquivo.type === 'application/pdf' ? 'pdf' : 'texto',
    // A miniatura é local: não espera o servidor para aparecer.
    previa: arquivo.type.startsWith('image/') ? URL.createObjectURL(arquivo) : null,
    id: null,
    estado: 'enviando',
  };
}

function lerBase64(arquivo) {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(String(leitor.result).split(',')[1] ?? '');
    leitor.onerror = () => reject(new Error('não consegui ler o arquivo'));
    leitor.readAsDataURL(arquivo);
  });
}

function desenharAnexos() {
  el.anexos.textContent = '';
  el.anexos.hidden = estado.anexos.length === 0;

  for (const anexo of estado.anexos) {
    const div = document.createElement('div');
    div.className = 'anexo';
    div.dataset.estado = anexo.estado;

    if (anexo.previa) {
      const img = document.createElement('img');
      img.src = anexo.previa;
      img.alt = '';
      div.appendChild(img);
    } else {
      const icone = document.createElement('span');
      icone.className = 'icone';
      // Imagem sem miniatura acontece quando o anexo não veio do seletor local
      // (mídia do WhatsApp, por exemplo) — o rótulo tem de dizer a verdade.
      icone.textContent = anexo.tipo === 'pdf' ? 'PDF' : anexo.tipo === 'imagem' ? 'IMG' : 'TXT';
      div.appendChild(icone);
    }

    const nome = document.createElement('span');
    nome.className = 'nome';
    nome.textContent = anexo.nome;
    div.appendChild(nome);

    const tirar = document.createElement('button');
    tirar.className = 'tirar';
    tirar.textContent = '×';
    tirar.title = 'Remover';
    tirar.addEventListener('click', () => {
      if (anexo.previa) URL.revokeObjectURL(anexo.previa);
      estado.anexos = estado.anexos.filter((a) => a.chave !== anexo.chave);
      desenharAnexos();
    });
    div.appendChild(tirar);

    el.anexos.appendChild(div);
  }
}

function limparAnexos() {
  for (const anexo of estado.anexos) {
    if (anexo.previa) URL.revokeObjectURL(anexo.previa);
  }
  estado.anexos = [];
  desenharAnexos();
}

el.anexoBtn.addEventListener('click', () => el.arquivo.click());
el.arquivo.addEventListener('change', () => {
  void anexar([...el.arquivo.files]);
  el.arquivo.value = '';
});

// Colar imagem direto da área de transferência — o gesto mais rápido de todos.
document.addEventListener('paste', (evento) => {
  const arquivos = [...(evento.clipboardData?.files ?? [])];
  if (arquivos.length === 0) return;
  evento.preventDefault();
  void anexar(arquivos);
});

// Arrastar e soltar em qualquer lugar da tela.
let arrastando = 0;
document.addEventListener('dragenter', (evento) => {
  if (![...(evento.dataTransfer?.types ?? [])].includes('Files')) return;
  arrastando++;
  el.soltar.hidden = false;
});
document.addEventListener('dragover', (evento) => evento.preventDefault());
document.addEventListener('dragleave', () => {
  if (--arrastando <= 0) {
    arrastando = 0;
    el.soltar.hidden = true;
  }
});
document.addEventListener('drop', (evento) => {
  evento.preventDefault();
  arrastando = 0;
  el.soltar.hidden = true;
  const arquivos = [...(evento.dataTransfer?.files ?? [])];
  if (arquivos.length) void anexar(arquivos);
});

// ── envio ────────────────────────────────────────────────────────────────────

function enviar(texto) {
  const limpo = (texto ?? el.entrada.value).trim();
  const prontos = estado.anexos.filter((a) => a.estado === 'pronto');
  const subindo = estado.anexos.some((a) => a.estado === 'enviando');

  if (subindo) {
    mostrarAtividade('esperando o anexo subir…', 2000);
    return;
  }
  // Anexo sozinho é mensagem válida: a foto já diz o que ele quer.
  if (!limpo && prontos.length === 0) return;

  voz.calar();
  el.entrada.value = '';
  estado.bufferResposta = '';
  desenharLegenda('', false);
  orbe.definirEstado('thinking');
  orbe.emitirOnda(1);
  el.parar.classList.remove('oculto');

  enviarSocket({
    type: 'mensagem',
    texto: limpo,
    conversaId: estado.conversaId,
    anexos: prontos.map((a) => a.id),
  });
  limparAnexos();
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
  if (!texto || !estado.legendas) {
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
  quem.textContent =
    papel === 'user' ? 'você' : papel === 'assistant' ? estado.assistente.toLowerCase() : 'sistema';
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
    localStorage.setItem('gideao_voz', estado.falarRespostas ? '1' : '0');
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
 * real — `gideao.simular({type:'estado', estado:'thinking'})` no console do
 * navegador põe o orbe no estado desejado, e é assim que as capturas de tela
 * da documentação são feitas.
 */
window.gideao = { orbe, voz, estado, painel, simular: tratar, desenharAnexos, anexar };

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
