/**
 * Voz: reconhecimento de fala e leitura em voz alta, usando os motores do
 * próprio navegador.
 *
 * Duas limitações que vale conhecer de antemão:
 *
 *  - o reconhecimento do Chrome envia o áudio para os servidores do Google. Se
 *    isso não servir para o seu uso, use o teclado — o resto do sistema não
 *    depende de voz, e a Íris não perde nenhuma função.
 *  - o Firefox não implementa reconhecimento de fala. Lá o botão do microfone
 *    fica desativado e o campo de texto assume.
 *
 * O analisador de áudio é separado do reconhecimento de propósito: é ele que
 * alimenta o equalizador do orbe, e ele funciona em qualquer navegador.
 */

const Reconhecimento = window.SpeechRecognition || window.webkitSpeechRecognition;

export class Voz {
  constructor({ idioma = 'pt-BR', aoTexto, aoParcial, aoNivel, aoEstado } = {}) {
    this.idioma = idioma;
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
    // Enquanto o microfone estiver aberto, ela não fala por cima.
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
    fala.rate = 1.04;
    fala.pitch = 1.0;

    const vozes = speechSynthesis.getVoices();
    const preferida =
      vozes.find((v) => v.lang === this.idioma && /natural|neural|google/i.test(v.name)) ||
      vozes.find((v) => v.lang === this.idioma) ||
      vozes.find((v) => v.lang?.startsWith('pt'));
    if (preferida) fala.voice = preferida;

    fala.onstart = () => {
      this.falando = true;
    };
    fala.onend = fala.onerror = () => {
      this.falando = false;
    };

    speechSynthesis.speak(fala);
  }

  calar() {
    if (this.suportaFala) speechSynthesis.cancel();
    this.falando = false;
  }
}
