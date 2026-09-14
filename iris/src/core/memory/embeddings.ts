/**
 * Embeddings.
 *
 * Dois provedores:
 *
 *  - `local`  — determinístico, offline, zero custo, zero vazamento: nenhum texto
 *               sai da máquina. Usa o truque do hashing (random projection) sobre
 *               palavras e trigramas de caractere. Captura bem similaridade
 *               lexical e razoavelmente bem similaridade de tema.
 *  - `voyage`  — API da Voyage AI, bem mais preciso semanticamente. Exige
 *               VOYAGE_API_KEY e envia o texto para lá.
 *
 * O padrão é `local`: privacidade primeiro, o dono decide se quer trocar.
 */
import { createHash } from 'node:crypto';
import { normalizeTerm } from '../crypto/cipher.js';
import { createLogger } from '../../util/logger.js';

const log = createLogger('embeddings');

export const LOCAL_DIM = 512;

export interface EmbeddingProvider {
  readonly name: string;
  readonly dim: number;
  /**
   * Cosseno a partir do qual dois textos são "a mesma coisa dita de dois jeitos".
   * Vale tanto para a deduplicação na gravação quanto para a fusão noturna — a
   * diferença entre as duas não é o critério, é o alcance: a gravação compara
   * com as candidatas recentes, a consolidação varre a base inteira.
   *
   * O limiar pertence ao provedor, não ao sistema, porque cada família de
   * embedding tem a sua escala. Medido (test/memory.test.ts § calibração):
   * o provedor local coloca quase-duplicatas entre 0,84 e 0,88 e conteúdo
   * genuinamente distinto abaixo de 0,25 — 0,80 fica no meio desse vão, longe
   * das duas pontas. A Voyage tem espaço semântico de verdade e aproxima também
   * paráfrases legítimas, então exige limiar bem mais alto para não fundir duas
   * anotações que apenas tratam do mesmo assunto.
   */
  readonly nearDuplicate: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

// ── provedor local ───────────────────────────────────────────────────────────

function hashToSlot(token: string, dim: number): { index: number; sign: number } {
  const h = createHash('sha1').update(token).digest();
  const index = ((h[0]! << 16) | (h[1]! << 8) | h[2]!) % dim;
  const sign = (h[3]! & 1) === 0 ? 1 : -1;
  return { index, sign };
}

function charNgrams(word: string, n = 3): string[] {
  if (word.length <= n) return [word];
  const out: string[] = [];
  const padded = `^${word}$`;
  for (let i = 0; i + n <= padded.length; i++) out.push(padded.slice(i, i + n));
  return out;
}

export class LocalEmbeddings implements EmbeddingProvider {
  readonly name = 'local';
  readonly dim = LOCAL_DIM;
  readonly nearDuplicate = 0.8;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.embedOne(t));
  }

  embedOne(text: string): Float32Array {
    const vec = new Float32Array(this.dim);
    const words = normalizeTerm(text).split(' ').filter(Boolean);
    if (words.length === 0) return vec;

    // Frequência sublinear: repetir uma palavra 10x não vale 10x.
    const counts = new Map<string, number>();
    for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);

    for (const [word, count] of counts) {
      const weight = 1 + Math.log(count);
      const { index, sign } = hashToSlot(`w:${word}`, this.dim);
      vec[index]! += sign * weight;

      // Trigramas dão robustez a erro de digitação e a flexão de palavra.
      const grams = charNgrams(word);
      const gramWeight = weight * (0.45 / Math.sqrt(grams.length));
      for (const g of grams) {
        const s = hashToSlot(`g:${g}`, this.dim);
        vec[s.index]! += s.sign * gramWeight;
      }
    }

    // Bigramas de palavra capturam um pouco de ordem ("prazo fatal" ≠ "fatal prazo").
    for (let i = 0; i + 1 < words.length && i < 400; i++) {
      const s = hashToSlot(`b:${words[i]}_${words[i + 1]}`, this.dim);
      vec[s.index]! += s.sign * 0.6;
    }

    return l2normalize(vec);
  }
}

// ── provedor Voyage ──────────────────────────────────────────────────────────

export class VoyageEmbeddings implements EmbeddingProvider {
  readonly name = 'voyage';
  readonly dim = 1024;
  readonly nearDuplicate = 0.93;

  constructor(
    private readonly apiKey: string,
    private readonly model = 'voyage-3',
  ) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    // A API aceita lotes; 96 por vez é confortável.
    for (let i = 0; i < texts.length; i += 96) {
      const batch = texts.slice(i, i + 96).map((t) => t.slice(0, 8000));
      const res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: batch, input_type: 'document' }),
      });
      if (!res.ok) {
        throw new Error(`Voyage respondeu ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const json = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
      const sorted = [...json.data].sort((a, b) => a.index - b.index);
      for (const item of sorted) out.push(l2normalize(Float32Array.from(item.embedding)));
    }
    return out;
  }
}

// ── fábrica e utilidades ─────────────────────────────────────────────────────

export function createEmbeddingProvider(kind: 'local' | 'voyage', model?: string): EmbeddingProvider {
  if (kind === 'voyage') {
    const key = process.env.VOYAGE_API_KEY;
    if (!key) {
      log.warn('IRIS_EMBEDDINGS=voyage mas VOYAGE_API_KEY está vazia — voltando para o provedor local');
      return new LocalEmbeddings();
    }
    return new VoyageEmbeddings(key, model);
  }
  return new LocalEmbeddings();
}

export function l2normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const norm = Math.sqrt(sum);
  if (norm === 0) return v;
  for (let i = 0; i < v.length; i++) v[i]! /= norm;
  return v;
}

/** Com vetores normalizados, o produto interno já é o cosseno. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}

export function vectorToBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function bufferToVector(buf: Buffer | Uint8Array | null | undefined): Float32Array | null {
  if (!buf || buf.byteLength === 0 || buf.byteLength % 4 !== 0) return null;
  const b = Buffer.from(buf);
  // `Buffer` pode não estar alinhado a 4 bytes; copiar garante o alinhamento.
  const copy = new ArrayBuffer(b.byteLength);
  new Uint8Array(copy).set(b);
  return new Float32Array(copy);
}
