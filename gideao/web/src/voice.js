/**
 * Voz: reconhecimento de fala e leitura em voz alta, usando os motores do
 * próprio navegador.
 *
 * Duas limitações que vale conhecer de antemão:
 *
 *  - o reconhecimento do Chrome envia o áudio para os servidores do Google. Se
 *    isso não servir para o seu uso, use o teclado — o resto do sistema não
 *    depende de voz, e o Gideão não perde nenhuma função.
 *  - o Firefox não implementa reconhecimento de fala. Lá o botão do microfone
 *    fica desativado e o campo de texto assume.
 *
 * O analisador de áudio é separado do reconhecimento de propósito: é ele que
 * alimenta o equalizador do orbe, e ele funciona em qualquer navegador.
 */

const Reconhecimento = window.SpeechRecognition || window.webkitSpeechRecognition;

export class Voz {
  constructor({ idioma = 'pt-BR', voz = '', velocidade = 1.04, tom = 0.92, aoTexto, aoParcial, aoNivel, aoEstado } = {}) {
    this.idioma = idioma;
    /** Nome exato da voz escolhida nos ajustes. Vazio = escolha automática. */
    this.vozEscolhida = voz;
    this.velocidade = velocidade;
    this.tom = tom;
    this.aoTexto = aoTexto ?? (() => {});
    this.aoParcial = aoParcial ?? (() => {});
    this.aoNivel = aoNivel ?? (() => {});
    this.aoEstado = aoEstado ?? (() => {});

    this.gravando = false;
    this.reconhecedor = null;
    this.contexto = null;
    this.analisador = null;
    this.fluxo = null;
    this.dados = null;
    this.loopId = null;
    this.falando = false;

    /*
     * As vozes chegam depois no Chrome: a primeira chamada a `getVoices()`
     * volta vazia e o navegador dispara `voiceschanged` quando termina de
     * carregar. Sem escutar esse evento, a primeira fala do dia sairia com a
     * voz padrão do sistema — quase sempre feminina — e só a segunda sairia
     * certa.
     */
    if (this.suportaFala) {
      speechSynthesis.addEventListener?.('voiceschanged', () => {
        this.aoCarregarVozes?.(this.vozes());
      });
    }
  }

  /** Ajustes vindos do painel da engrenagem, aplicados na próxima fala. */
  configurar({ voz, velocidade, tom } = {}) {
    if (voz !== undefined) this.vozEscolhida = voz;
    if (velocidade !== undefined) this.velocidade = velocidade;
    if (tom !== undefined) this.tom = tom;
  }

  /** Vozes em português disponíveis neste navegador, para a lista dos ajustes. */
  vozes() {
    if (!this.suportaFala) return [];
    return speechSynthesis
      .getVoices()
      .filter((v) => v.lang?.toLowerCase().startsWith('pt'))
      .map((v) => ({ nome: v.name, idioma: v.lang, masculina: ehMasculina(v.name) }));
  }

  get suportaReconhecimento() {
    return Boolean(Reconhecimento);
  }

  get suportaFala() {
    return 'speechSynthesis' in window;
  }

  async alternar() {
    if (this.gravando) {
      this.parar();
      return false;
    }
    await this.iniciar();
    return true;
  }

  async iniciar() {
    if (this.gravando) return;
    // Enquanto o microfone estiver aberto, ele não fala por cima.
    this.calar();

    try {
      await this.abrirAnalisador();
    } catch (err) {
      this.aoEstado({ erro: 'não consegui acessar o microfone: ' + err.message });
      return;
    }

    if (!Reconhecimento) {
      // Sem reconhecimento: o microfone ainda anima o orbe, mas não transcreve.
      this.gravando = true;
      this.aoEstado({ gravando: true, transcreve: false });
      return;
    }

    const rec = new Reconhecimento();
    rec.lang = this.idioma;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    let finalAcumulado = '';

    rec.onresult = (evento) => {
      let parcial = '';
      for (let i = evento.resultIndex; i < evento.results.length; i++) {
        const trecho = evento.results[i][0].transcript;
        if (evento.results[i].isFinal) finalAcumulado += trecho;
        else parcial += trecho;
      }
      this.aoParcial((finalAcumulado + parcial).trim());
    };

    rec.onerror = (evento) => {
      if (evento.error === 'no-speech' || evento.error === 'aborted') return;
      this.aoEstado({ erro: `reconhecimento de voz: ${evento.error}` });
    };

    rec.onend = () => {
      const texto = finalAcumulado.trim();
      finalAcumulado = '';
      this.encerrarAnalisador();
      this.gravando = false;
      this.aoEstado({ gravando: false });
      if (texto) this.aoTexto(texto);
    };

    this.reconhecedor = rec;
    rec.start();
    this.gravando = true;
    this.aoEstado({ gravando: true, transcreve: true });
  }

  parar() {
    if (!this.gravando) return;
    if (this.reconhecedor) {
      this.reconhecedor.stop(); // onend faz a limpeza
    } else {
      this.encerrarAnalisador();
      this.gravando = false;
      this.aoEstado({ gravando: false });
    }
  }

  // ── analisador (equalizador do orbe) ───────────────────────────────────────

  async abrirAnalisador() {
    this.fluxo = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    this.contexto = new (window.AudioContext || window.webkitAudioContext)();
    const fonte = this.contexto.createMediaStreamSource(this.fluxo);
    this.analisador = this.contexto.createAnalyser();
    this.analisador.fftSize = 256;
    this.analisador.smoothingTimeConstant = 0.72;
    fonte.connect(this.analisador);
    this.dados = new Uint8Array(this.analisador.frequencyBinCount);

    const laco = () => {
      if (!this.analisador) return;
      this.analisador.getByteFrequencyData(this.dados);
      this.aoNivel(this.dados);
      this.loopId = requestAnimationFrame(laco);
    };
    laco();
  }

  encerrarAnalisador() {
    if (this.loopId) cancelAnimationFrame(this.loopId);
    this.loopId = null;
    this.analisador = null;
    this.dados = null;
    this.fluxo?.getTracks().forEach((t) => t.stop());
    this.fluxo = null;
    this.contexto?.close().catch(() => {});
    this.contexto = null;
  }

  // ── fala ───────────────────────────────────────────────────────────────────

  /** Lê um texto em voz alta. Ignora marcação e trechos longos demais. */
  falar(texto) {
    if (!this.suportaFala || !texto) return;
    const limpo = texto
      .replace(/```[\s\S]*?```/g, ' código omitido. ')
      .replace(/[*_`#>|]/g, '')
      .replace(/\[(.*?)\]\(.*?\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1200);
    if (!limpo) return;

    this.calar();
    const fala = new SpeechSynthesisUtterance(limpo);
    fala.lang = this.idioma;
    fala.rate = this.velocidade;
    fala.pitch = this.tom;

    const preferida = this.selecionarVoz();
    if (preferida) fala.voice = preferida;

    fala.onstart = () => {
      this.falando = true;
    };
    fala.onend = fala.onerror = () => {
      this.falando = false;
    };

    speechSynthesis.speak(fala);
  }

  /**
   * Qual voz usar, em ordem de preferência.
   *
   * A escolha explícita do dono ganha de tudo. Não havendo escolha, procura uma
   * voz masculina em português — porque é assim que o Gideão deve soar, e o
   * padrão do navegador em pt-BR costuma ser feminino (a "Google português do
   * Brasil" e a "Luciana" do macOS são os dois casos mais comuns).
   */
  selecionarVoz() {
    const vozes = speechSynthesis.getVoices().filter((v) => v.lang?.toLowerCase().startsWith('pt'));
    if (!vozes.length) return null;

    if (this.vozEscolhida) {
      const exata = vozes.find((v) => v.name === this.vozEscolhida);
      if (exata) return exata;
      // A voz salva pode não existir neste computador: cai para a automática.
    }

    const masculinas = vozes.filter((v) => ehMasculina(v.name));
    const brasileiras = (lista) => lista.filter((v) => /pt[-_]?BR/i.test(v.lang));

    return (
      brasileiras(masculinas).find((v) => /natural|neural|premium|enhanced/i.test(v.name)) ||
      brasileiras(masculinas)[0] ||
      masculinas[0] ||
      brasileiras(vozes)[0] ||
      vozes[0]
    );
  }

  /** Fala uma frase de amostra, para o dono ouvir antes de salvar o ajuste. */
  provar(texto = 'Oi, sou o Gideão. É assim que eu falo.') {
    this.calar();
    const fala = new SpeechSynthesisUtterance(texto);
    fala.lang = this.idioma;
    fala.rate = this.velocidade;
    fala.pitch = this.tom;
    const v = this.selecionarVoz();
    if (v) fala.voice = v;
    speechSynthesis.speak(fala);
  }

  calar() {
    if (this.suportaFala) speechSynthesis.cancel();
    this.falando = false;
  }
}

/*
 * Nome de voz masculina, por lista.
 *
 * Não existe campo de gênero na Web Speech API — `SpeechSynthesisVoice` tem
 * nome, idioma e pouco mais. Sobra reconhecer pelo nome, e os nomes são poucos
 * e estáveis por sistema: Windows entrega Daniel, macOS entrega Felipe, e as
 * vozes do Google em pt-BR são femininas. Nome desconhecido não vira masculino
 * por otimismo: fica de fora, e o dono escolhe na engrenagem.
 */
const NOMES_MASCULINOS =
  /\b(felipe|daniel|ricardo|ant[oô]nio|jorge|paulo|heitor|thiago|tiago|jo[aã]o|joaquim|eddy|reed|rocko|rishi|marcos|carlos|bruno|eduardo|male|homem|masculin)/i;

function ehMasculina(nome) {
  return NOMES_MASCULINOS.test(nome ?? '');
}
