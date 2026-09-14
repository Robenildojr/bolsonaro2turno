/**
 * O orbe.
 *
 * Quatro camadas desenhadas por quadro, do fundo para a frente:
 *
 *   1. brilho      — halo radial suave, respira com a energia
 *   2. equalizador — barras ao redor, reagindo ao som (ou à energia simulada)
 *   3. corpo       — o círculo; com borda quando parado, SEM borda quando responde
 *   4. pontos      — as partículas que orbitam no meio enquanto ela pensa/responde
 *
 * A diferença entre os estados não é só de cor: no repouso existe um anel
 * nítido, e no momento em que ela responde o anel se dissolve num disco sem
 * contorno com pontos dentro — que foi exatamente o que você descreveu.
 *
 * Nada aqui depende de biblioteca. É canvas 2D puro.
 */

const ESTADOS = {
  idle: { matiz: 232, energia: 0.16, pontos: 0, borda: 0.55, giro: 0.12 },
  listening: { matiz: 190, energia: 0.55, pontos: 0, borda: 0.7, giro: 0.35 },
  thinking: { matiz: 268, energia: 0.42, pontos: 7, borda: 0.0, giro: 1.0 },
  working: { matiz: 292, energia: 0.5, pontos: 9, borda: 0.0, giro: 1.35 },
  responding: { matiz: 276, energia: 0.75, pontos: 11, borda: 0.0, giro: 0.8 },
  error: { matiz: 5, energia: 0.3, pontos: 0, borda: 0.8, giro: 0.05 },
};

const BARRAS = 84;
const MAX_PONTOS = 14;

export class Orbe {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });

    this.estado = 'idle';
    this.alvo = ESTADOS.idle;

    // Valores suavizados: nada muda de repente, tudo persegue o alvo.
    this.matiz = this.alvo.matiz;
    this.energia = this.alvo.energia;
    this.borda = this.alvo.borda;
    this.pontosVivos = 0;
    this.giro = 0;

    /** Pico momentâneo: cada token recebido dá um empurrão. */
    this.pulso = 0;
    /** Espectro do microfone, 0..1 por barra. */
    this.espectro = new Float32Array(BARRAS);
    /** Ruído coerente por barra, para o equalizador não parecer aleatório. */
    this.fases = Array.from({ length: BARRAS }, () => Math.random() * Math.PI * 2);
    this.velocidades = Array.from({ length: BARRAS }, () => 0.5 + Math.random() * 1.6);

    this.pontos = Array.from({ length: MAX_PONTOS }, (_, i) => ({
      angulo: (i / MAX_PONTOS) * Math.PI * 2,
      raio: 0.22 + (i % 3) * 0.13,
      velocidade: 0.6 + ((i * 37) % 11) / 14,
      fase: (i * 1.7) % (Math.PI * 2),
    }));

    this.ondas = []; // anéis que se expandem em eventos
    this.tempo = 0;
    this.ultimo = performance.now();
    this.reduzido = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.redimensionar();
    window.addEventListener('resize', () => this.redimensionar());
    requestAnimationFrame(() => this.quadro());
  }

  redimensionar() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const { innerWidth: w, innerHeight: h } = window;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.largura = w;
    this.altura = h;
    // O orbe ocupa um terço da menor dimensão, com teto para telas grandes.
    this.raio = Math.min(Math.min(w, h) * 0.17, 210);
  }

  /** Troca de estado. A transição é suave — o alvo muda, o valor persegue. */
  definirEstado(estado) {
    if (!ESTADOS[estado]) return;
    if (estado !== this.estado) {
      this.estado = estado;
      this.alvo = ESTADOS[estado];
      if (estado === 'thinking' || estado === 'responding') this.emitirOnda(0.5);
    }
  }

  /** Chamado a cada pedaço de texto que chega — é o que faz os pontos pulsarem. */
  pulsar(intensidade = 1) {
    this.pulso = Math.min(1.6, this.pulso + 0.12 * intensidade);
  }

  /** Anel que se expande: marca começo de fala, fim de turno, notificação. */
  emitirOnda(forca = 1) {
    this.ondas.push({ raio: this.raio * 0.8, forca, vida: 1 });
    if (this.ondas.length > 6) this.ondas.shift();
  }

  /** Dados do analisador de áudio (0..255 por faixa). */
  alimentarAudio(bytes) {
    const n = Math.min(BARRAS, bytes.length);
    for (let i = 0; i < BARRAS; i++) {
      const origem = Math.floor((i / BARRAS) * n);
      const alvo = (bytes[origem] || 0) / 255;
      // Suavização assimétrica: sobe rápido, desce devagar — parece natural.
      this.espectro[i] = alvo > this.espectro[i] ? alvo : this.espectro[i] * 0.86 + alvo * 0.14;
    }
  }

  limparAudio() {
    for (let i = 0; i < BARRAS; i++) this.espectro[i] *= 0.9;
  }

  // ── laço de animação ───────────────────────────────────────────────────────

  quadro() {
    const agora = performance.now();
    const dt = Math.min(0.05, (agora - this.ultimo) / 1000);
    this.ultimo = agora;
    this.tempo += dt;

    this.atualizar(dt);
    this.desenhar();

    requestAnimationFrame(() => this.quadro());
  }

  atualizar(dt) {
    const k = this.reduzido ? 1.2 : 3.2; // velocidade de convergência
    const alvoEnergia = this.alvo.energia + this.pulso * 0.35;

    this.matiz = aproximar(this.matiz, this.alvo.matiz, dt * k * 0.7, true);
    this.energia = aproximar(this.energia, alvoEnergia, dt * k);
    this.borda = aproximar(this.borda, this.alvo.borda, dt * k);
    this.pontosVivos = aproximar(this.pontosVivos, this.alvo.pontos, dt * k * 1.4);
    this.giro += dt * this.alvo.giro * (0.6 + this.energia);

    this.pulso = Math.max(0, this.pulso - dt * 1.9);

    for (const onda of this.ondas) {
      onda.raio += dt * 150 * (0.6 + onda.forca);
      onda.vida -= dt * 0.9;
    }
    this.ondas = this.ondas.filter((o) => o.vida > 0);

    if (this.estado !== 'listening') this.limparAudio();
  }

  desenhar() {
    const ctx = this.ctx;
    const cx = this.largura / 2;
    const cy = this.altura / 2;
    const r = this.raio;

    ctx.clearRect(0, 0, this.largura, this.altura);
    ctx.save();
    ctx.translate(cx, cy);

    this.desenharBrilho(ctx, r);
    this.desenharOndas(ctx);
    this.desenharEqualizador(ctx, r);
    this.desenharCorpo(ctx, r);
    this.desenharPontos(ctx, r);

    ctx.restore();
  }

  /** 1. halo — o que dá a sensação de que o orbe emite luz. */
  desenharBrilho(ctx, r) {
    const raio = r * (2.6 + this.energia * 0.8);
    const g = ctx.createRadialGradient(0, 0, r * 0.2, 0, 0, raio);
    const h = this.matiz;
    g.addColorStop(0, `hsla(${h}, 90%, 68%, ${0.2 + this.energia * 0.22})`);
    g.addColorStop(0.35, `hsla(${h + 18}, 85%, 58%, ${0.09 + this.energia * 0.1})`);
    g.addColorStop(1, 'hsla(240, 80%, 50%, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, raio, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Anéis que se expandem e somem. */
  desenharOndas(ctx) {
    for (const onda of this.ondas) {
      ctx.beginPath();
      ctx.arc(0, 0, onda.raio, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${this.matiz + 10}, 90%, 70%, ${onda.vida * 0.22})`;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  /**
   * 2. equalizador — barras radiais.
   *
   * Ouvindo, a altura vem do microfone. Nos outros estados, de ondas senoidais
   * com frequências diferentes por barra: o resultado é um movimento orgânico
   * que nunca se repete exatamente, sem parecer ruído puro.
   */
  desenharEqualizador(ctx, r) {
    const base = r * 1.16;
    const ouvindo = this.estado === 'listening';
    const amplitude = r * (ouvindo ? 0.62 : 0.2 + this.energia * 0.3);

    ctx.lineCap = 'round';

    for (let i = 0; i < BARRAS; i++) {
      const angulo = (i / BARRAS) * Math.PI * 2 - Math.PI / 2 + this.giro * 0.08;

      let altura;
      if (ouvindo) {
        altura = this.espectro[i] ** 1.4;
      } else {
        const t = this.tempo * this.velocidades[i];
        const onda =
          Math.sin(t + this.fases[i]) * 0.5 +
          Math.sin(t * 0.47 + this.fases[i] * 1.7) * 0.3 +
          Math.sin(t * 1.9 + this.fases[i] * 0.4) * 0.2;
        altura = (onda + 1) / 2;
        altura *= 0.25 + this.energia * 0.9 + this.pulso * 0.5;
      }
      if (altura < 0.01) continue;

      const comprimento = amplitude * altura;
      const x1 = Math.cos(angulo) * base;
      const y1 = Math.sin(angulo) * base;
      const x2 = Math.cos(angulo) * (base + comprimento);
      const y2 = Math.sin(angulo) * (base + comprimento);

      const brilho = 0.18 + altura * 0.55;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = `hsla(${this.matiz + altura * 40}, 92%, ${58 + altura * 18}%, ${brilho})`;
      ctx.lineWidth = ouvindo ? 2.4 : 1.7;
      ctx.stroke();
    }
  }

  /**
   * 3. corpo.
   *
   * A borda é desenhada com opacidade `this.borda`, que vai a zero quando ela
   * pensa ou responde. É essa transição que transforma o anel nítido do repouso
   * no disco sem contorno da resposta.
   */
  desenharCorpo(ctx, r) {
    const respiro = 1 + Math.sin(this.tempo * 1.1) * 0.02 + this.pulso * 0.05;
    const raio = r * respiro;
    const h = this.matiz;

    // preenchimento interno, sempre presente
    const g = ctx.createRadialGradient(0, -raio * 0.25, raio * 0.05, 0, 0, raio);
    g.addColorStop(0, `hsla(${h + 25}, 95%, 72%, ${0.16 + this.energia * 0.3})`);
    g.addColorStop(0.7, `hsla(${h}, 88%, 58%, ${0.1 + this.energia * 0.16})`);
    g.addColorStop(1, `hsla(${h - 10}, 85%, 45%, 0.02)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, raio, 0, Math.PI * 2);
    ctx.fill();

    if (this.borda > 0.01) {
      ctx.beginPath();
      ctx.arc(0, 0, raio, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${h + 12}, 92%, 74%, ${this.borda * 0.62})`;
      ctx.lineWidth = 1.6;
      ctx.stroke();

      // segundo anel, mais fino e maior: dá profundidade ao repouso
      ctx.beginPath();
      ctx.arc(0, 0, raio * 1.075, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${h}, 85%, 68%, ${this.borda * 0.16})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  /**
   * 4. pontos internos.
   *
   * Cada ponto orbita numa elipse própria, em velocidade própria. Como as
   * velocidades não são múltiplas entre si, o desenho nunca se fecha num padrão
   * — é o que faz parecer que ela está pensando, e não tocando uma animação.
   */
  desenharPontos(ctx, r) {
    const quantidade = Math.round(this.pontosVivos);
    if (quantidade <= 0) return;

    for (let i = 0; i < quantidade; i++) {
      const p = this.pontos[i];
      const t = this.tempo * p.velocidade + this.giro;
      const angulo = p.angulo + t;
      // Elipse levemente achatada, inclinada — evita o círculo perfeito.
      const rx = r * p.raio * (1 + Math.sin(t * 0.7 + p.fase) * 0.22);
      const ry = rx * 0.78;
      const x = Math.cos(angulo) * rx;
      const y = Math.sin(angulo) * ry;

      const proximidade = (Math.sin(t * 0.7 + p.fase) + 1) / 2; // 0 = fundo, 1 = frente
      const tamanho = r * (0.022 + proximidade * 0.026) * (1 + this.pulso * 0.5);
      const alfa = (0.35 + proximidade * 0.5) * Math.min(1, this.pontosVivos - i);

      const g = ctx.createRadialGradient(x, y, 0, x, y, tamanho * 3);
      g.addColorStop(0, `hsla(${this.matiz + 30}, 100%, 82%, ${alfa})`);
      g.addColorStop(0.4, `hsla(${this.matiz + 10}, 95%, 70%, ${alfa * 0.35})`);
      g.addColorStop(1, `hsla(${this.matiz}, 90%, 60%, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, tamanho * 3, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(x, y, tamanho, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${this.matiz + 40}, 100%, 90%, ${alfa})`;
      ctx.fill();
    }
  }
}

/** Interpolação exponencial. Com `circular`, respeita a volta dos 360°. */
function aproximar(atual, alvo, taxa, circular = false) {
  const fator = 1 - Math.exp(-taxa * 6);
  if (!circular) return atual + (alvo - atual) * fator;
  let delta = ((alvo - atual + 540) % 360) - 180;
  return atual + delta * fator;
}
