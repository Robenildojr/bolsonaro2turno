/**
 * Painel da engrenagem.
 *
 * A tela do Gideão é o orbe e mais nada. Tudo que é configuração vive aqui
 * dentro, atrás de um ícone que quase não se vê — e a lista de campos não é
 * escrita nesta página: ela vem de `/api/ajustes`, montada a partir do registro
 * em `src/core/settings/ajustes.ts`.
 *
 * Isso é de propósito. Existem três formas de mudar um ajuste (esta tela, a
 * conversa e a linha de comando) e uma lista só. Acrescentar um ajuste novo no
 * servidor faz ele aparecer aqui sozinho, e nenhuma das três pode mexer no que
 * a lista não declara — nem o token de acesso, nem o segredo do WhatsApp.
 *
 * Salva ao mudar, sem botão "aplicar": interruptor e lista salvam na hora,
 * texto e número salvam 600 ms depois da última tecla. Botão de salvar num
 * painel de meia dúzia de campos é atrito sem função — e, pior, deixa o dono
 * sem saber se o que ele mexeu valeu.
 */

const GRUPO_ORDEM = ['Identidade', 'Voz', 'Tela', 'Raciocínio', 'Atualização', 'Segurança'];

export class PainelAjustes {
  /**
   * @param {object} opcoes
   * @param {string} opcoes.token          token de acesso da interface
   * @param {import('./voice.js').Voz} opcoes.voz
   * @param {(cfg: object) => void} opcoes.aoMudar  avisa a página do valor novo
   */
  constructor({ token, voz, aoMudar }) {
    this.token = token;
    this.voz = voz;
    this.aoMudar = aoMudar ?? (() => {});

    this.painel = document.getElementById('ajustes');
    this.botao = document.getElementById('btn-ajustes');
    this.corpo = document.getElementById('ajustes-corpo');
    this.estado = document.getElementById('ajustes-estado');
    this.fechar = document.getElementById('btn-fechar-ajustes');

    this.ajustes = [];
    this.pendentes = new Map(); // chave → timer do debounce
    this.aberto = false;

    this.botao?.addEventListener('click', () => this.alternar());
    this.fechar?.addEventListener('click', () => this.esconder());

    // Esc fecha, mas só quando o painel está aberto: fora dele, Esc interrompe
    // a resposta, e roubar essa tecla seria pior que não ter atalho nenhum.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.aberto) {
        e.stopPropagation();
        this.esconder();
      }
    });
  }

  alternar() {
    return this.aberto ? this.esconder() : this.mostrar();
  }

  async mostrar() {
    this.aberto = true;
    this.painel.hidden = false;
    this.botao?.setAttribute('aria-expanded', 'true');
    this.fechar?.focus();
    await this.carregar();
  }

  esconder() {
    this.aberto = false;
    this.painel.hidden = true;
    this.botao?.setAttribute('aria-expanded', 'false');
    this.botao?.focus();
  }

  // ── dados ──────────────────────────────────────────────────────────────────

  async pedir(caminho, opcoes = {}) {
    const resposta = await fetch(caminho, {
      ...opcoes,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
        ...(opcoes.headers ?? {}),
      },
    });
    if (!resposta.ok) throw new Error(`${resposta.status} ${resposta.statusText}`);
    return resposta.status === 204 ? null : resposta.json();
  }

  async carregar() {
    try {
      const [{ ajustes }, { autorizacoes }] = await Promise.all([
        this.pedir('/api/ajustes'),
        this.pedir('/api/autorizacoes').catch(() => ({ autorizacoes: [] })),
      ]);
      this.ajustes = ajustes;
      this.desenhar(ajustes, autorizacoes ?? []);
    } catch (err) {
      this.corpo.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'ajustes-carregando';
      p.textContent = `não consegui carregar os ajustes: ${err.message}`;
      this.corpo.append(p);
    }
  }

  /** Recebe a lista já atualizada pelo WebSocket, sem ir ao servidor de novo. */
  atualizar(ajustes) {
    if (!this.aberto) {
      this.ajustes = ajustes;
      return;
    }
    // Com o painel aberto, não redesenha: o dono pode estar digitando num campo.
    this.ajustes = ajustes;
  }

  // ── desenho ────────────────────────────────────────────────────────────────

  desenhar(ajustes, autorizacoes) {
    this.corpo.innerHTML = '';
    const grupos = new Map();
    for (const a of ajustes) {
      if (!grupos.has(a.grupo)) grupos.set(a.grupo, []);
      grupos.get(a.grupo).push(a);
    }

    const ordenados = [...grupos.keys()].sort((a, b) => {
      const ia = GRUPO_ORDEM.indexOf(a);
      const ib = GRUPO_ORDEM.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

    for (const nome of ordenados) {
      const secao = document.createElement('section');
      secao.className = 'ajustes-grupo';
      const h = document.createElement('h3');
      h.textContent = nome;
      secao.append(h);
      for (const a of grupos.get(nome)) secao.append(this.campo(a));
      this.corpo.append(secao);
    }

    this.corpo.append(this.secaoAutorizacoes(autorizacoes));
  }

  campo(a) {
    const div = document.createElement('div');
    div.className = 'ajuste';
    const id = `aj-${a.chave.replace(/\./g, '-')}`;

    const linha = document.createElement('div');
    linha.className = 'ajuste-linha';
    const label = document.createElement('label');
    label.setAttribute('for', id);
    label.textContent = a.rotulo;
    linha.append(label);

    let controle;
    switch (a.tipo) {
      case 'booleano': {
        const chave = document.createElement('span');
        chave.className = 'chave';
        controle = document.createElement('input');
        controle.type = 'checkbox';
        controle.id = id;
        controle.checked = Boolean(a.valor);
        // "Só desligar" fica travado quando já está desligado: o caminho de
        // ligar é a conversa ou a CLI, onde o consentimento é explícito.
        if (a.somenteDesligar && !a.valor) controle.disabled = true;
        chave.append(controle, document.createElement('span'));
        linha.append(chave);
        div.append(linha);
        controle.addEventListener('change', () => this.salvar(a.chave, controle.checked, 0));
        break;
      }

      case 'numero': {
        const valor = document.createElement('span');
        valor.className = 'valor';
        const casas = (a.passo ?? 1) < 1 ? 2 : 0;
        valor.textContent = Number(a.valor ?? 0).toFixed(casas);
        linha.append(valor);
        div.append(linha);
        controle = document.createElement('input');
        controle.type = 'range';
        controle.id = id;
        controle.min = a.min ?? 0;
        controle.max = a.max ?? 100;
        controle.step = a.passo ?? 1;
        controle.value = Number(a.valor ?? 0);
        controle.addEventListener('input', () => {
          valor.textContent = Number(controle.value).toFixed(casas);
          this.previa(a.chave, Number(controle.value));
          this.salvar(a.chave, Number(controle.value), 400);
        });
        div.append(controle);
        break;
      }

      case 'escolha': {
        div.append(linha);
        controle = document.createElement('select');
        controle.id = id;
        for (const o of this.opcoesDe(a)) {
          const op = document.createElement('option');
          op.value = o.valor;
          op.textContent = o.rotulo;
          if (String(a.valor ?? '') === o.valor) op.selected = true;
          controle.append(op);
        }
        controle.addEventListener('change', () => {
          this.previa(a.chave, controle.value);
          this.salvar(a.chave, controle.value, 0);
        });
        div.append(controle);
        break;
      }

      case 'lista': {
        div.append(linha);
        controle = document.createElement('textarea');
        controle.id = id;
        controle.value = Array.isArray(a.valor) ? a.valor.join('\n') : String(a.valor ?? '');
        controle.addEventListener('input', () =>
          this.salvar(a.chave, controle.value.split('\n'), 900),
        );
        div.append(controle);
        break;
      }

      default: {
        div.append(linha);
        controle = document.createElement('input');
        controle.type = 'text';
        controle.id = id;
        controle.value = String(a.valor ?? '');
        controle.addEventListener('input', () => this.salvar(a.chave, controle.value, 600));
        div.append(controle);
      }
    }

    if (a.ajuda) {
      const ajuda = document.createElement('p');
      ajuda.className = 'ajuda';
      ajuda.textContent = a.ajuda + (a.reiniciar ? ' Só vale depois de reiniciar.' : '');
      div.append(ajuda);
    }

    // Ouvir antes de decidir vale mais que qualquer descrição de voz.
    if (a.chave === 'voice.nome' || a.chave === 'voice.velocidade' || a.chave === 'voice.tom') {
      if (a.chave === 'voice.nome') {
        const provar = document.createElement('button');
        provar.type = 'button';
        provar.className = 'ajuste-acao';
        provar.textContent = 'ouvir';
        provar.addEventListener('click', () => this.voz?.provar());
        div.append(provar);
      }
    }

    return div;
  }

  /**
   * A lista de vozes não vem do servidor — ela depende do navegador e do
   * sistema de quem abriu a página. O servidor declara o campo; o navegador
   * preenche as opções.
   */
  opcoesDe(a) {
    if (a.chave !== 'voice.nome') return a.opcoes ?? [];
    const vozes = this.voz?.vozes() ?? [];
    // Sem vozes, o texto entra na PRÓPRIA opção automática. Uma segunda opção
    // com o mesmo valor vazio faria o select mostrar a errada como escolhida.
    const opcoes = [
      {
        valor: '',
        rotulo: vozes.length
          ? 'automática (procura voz masculina)'
          : 'automática — nenhuma voz em português instalada',
      },
    ];
    for (const v of vozes) {
      opcoes.push({ valor: v.nome, rotulo: `${v.nome}${v.masculina ? ' — masculina' : ''}` });
    }
    return opcoes;
  }

  secaoAutorizacoes(lista) {
    const secao = document.createElement('section');
    secao.className = 'ajustes-grupo';
    const h = document.createElement('h3');
    h.textContent = 'Autorizações';
    secao.append(h);

    if (!lista.length) {
      const p = document.createElement('p');
      p.className = 'ajuda';
      p.textContent = 'Nada autorizado ainda. Ele vai pedir na hora de cada ação.';
      secao.append(p);
      return secao;
    }

    for (const g of lista) {
      const item = document.createElement('div');
      item.className = 'autorizacao';
      const texto = document.createElement('div');
      const cap = document.createElement('span');
      cap.className = 'cap';
      cap.textContent = g.capability;
      const escopo = document.createElement('span');
      escopo.className = 'escopo';
      escopo.textContent = g.scope;
      texto.append(cap, escopo);

      const revogar = document.createElement('button');
      revogar.type = 'button';
      revogar.textContent = 'revogar';
      revogar.addEventListener('click', async () => {
        revogar.disabled = true;
        try {
          await this.pedir(`/api/autorizacao/${encodeURIComponent(g.id)}`, { method: 'DELETE' });
          item.remove();
          this.avisar('autorização revogada', 'ok');
        } catch (err) {
          revogar.disabled = false;
          this.avisar(`não consegui revogar: ${err.message}`, 'erro');
        }
      });

      item.append(texto, revogar);
      secao.append(item);
    }
    return secao;
  }

  // ── gravação ───────────────────────────────────────────────────────────────

  /** Aplica na hora o que é visual, antes mesmo de o servidor confirmar. */
  previa(chave, valor) {
    if (chave === 'voice.nome') this.voz?.configurar({ voz: valor });
    if (chave === 'voice.velocidade') this.voz?.configurar({ velocidade: valor });
    if (chave === 'voice.tom') this.voz?.configurar({ tom: valor });
    if (chave === 'ui.matiz') this.aoMudar({ ui: { matiz: valor } });
  }

  salvar(chave, valor, atraso) {
    clearTimeout(this.pendentes.get(chave));
    const disparar = async () => {
      this.pendentes.delete(chave);
      try {
        const r = await this.pedir('/api/ajustes', {
          method: 'PATCH',
          body: JSON.stringify({ [chave]: valor }),
        });
        if (r.recusados?.length) {
          this.avisar(r.recusados.map((x) => x.motivo).join('; '), 'erro');
          return;
        }
        this.previa(chave, valor);
        this.avisar(
          r.precisaReiniciar ? 'salvo — vale no próximo arranque' : 'salvo',
          'ok',
        );
      } catch (err) {
        this.avisar(`não salvou: ${err.message}`, 'erro');
      }
    };
    if (atraso > 0) this.pendentes.set(chave, setTimeout(disparar, atraso));
    else void disparar();
  }

  avisar(texto, classe = '') {
    if (!this.estado) return;
    this.estado.textContent = texto;
    this.estado.className = `ajustes-estado ${classe}`;
    clearTimeout(this.timerAviso);
    this.timerAviso = setTimeout(() => {
      this.estado.textContent = '';
      this.estado.className = 'ajustes-estado';
    }, 3200);
  }
}
