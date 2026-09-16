/**
 * Primitivas de cifragem.
 *
 * Formato selado (bytes, gravado direto como BLOB no SQLite):
 *
 *   magia(4) | versão(1) | reservado(1) | iv(12) | tag(16) | texto cifrado(n)
 *   'I' 'R' 'S' 0x01
 *
 * AES-256-GCM com IV aleatório de 96 bits por registro. O `aad` amarra o
 * texto cifrado ao lugar onde ele mora (tabela:coluna:id), de modo que copiar
 * um blob de uma linha para outra quebra a autenticação em vez de passar
 * despercebido.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

const MAGIC = Buffer.from([0x49, 0x52, 0x53, 0x01]); // "IRS\x01"
const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + 2 + IV_LEN + TAG_LEN;

export class CryptoError extends Error {}

/** Deriva subchaves independentes a partir de uma raiz de 32 bytes. */
export function deriveSubkey(root: Buffer, purpose: string, length = 32): Buffer {
  return Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), Buffer.from(purpose, 'utf8'), length));
}

export function seal(key: Buffer, plaintext: Buffer | string, aad?: string): Buffer {
  if (key.length !== 32) throw new CryptoError('chave de cifragem inválida');
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, Buffer.from([VERSION, 0]), iv, tag, ct]);
}

export function open(key: Buffer, sealed: Buffer, aad?: string): Buffer {
  if (key.length !== 32) throw new CryptoError('chave de cifragem inválida');
  if (sealed.length < HEADER_LEN) throw new CryptoError('bloco cifrado truncado');
  if (!sealed.subarray(0, 4).equals(MAGIC)) throw new CryptoError('bloco cifrado com formato desconhecido');
  const version = sealed[4];
  if (version !== VERSION) throw new CryptoError(`versão de cifragem não suportada: ${version}`);

  const iv = sealed.subarray(6, 6 + IV_LEN);
  const tag = sealed.subarray(6 + IV_LEN, 6 + IV_LEN + TAG_LEN);
  const ct = sealed.subarray(HEADER_LEN);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new CryptoError('falha ao decifrar: chave errada ou dado adulterado');
  }
}

export function sealText(key: Buffer, text: string, aad?: string): Buffer {
  return seal(key, Buffer.from(text, 'utf8'), aad);
}

export function openText(key: Buffer, sealed: Buffer, aad?: string): string {
  return open(key, sealed, aad).toString('utf8');
}

export function sealJson(key: Buffer, value: unknown, aad?: string): Buffer {
  return seal(key, Buffer.from(JSON.stringify(value), 'utf8'), aad);
}

export function openJson<T>(key: Buffer, sealed: Buffer, aad?: string): T {
  return JSON.parse(open(key, sealed, aad).toString('utf8')) as T;
}

/**
 * Índice cego: permite procurar por um termo exato sem descriptografar nada.
 * Quem só tem o banco vê hashes; sem a chave de índice não dá para saber que
 * termo cada hash representa nem testar palpites em massa.
 */
export function blindIndex(indexKey: Buffer, term: string): string {
  return createHmac('sha256', indexKey).update(normalizeTerm(term)).digest('hex').slice(0, 24);
}

/** minúsculas, sem acento, sem pontuação — para o termo bater sempre igual. */
export function normalizeTerm(term: string): string {
  return term
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const STOPWORDS = new Set([
  'a','o','as','os','um','uma','de','da','do','das','dos','em','no','na','nos','nas','por','para',
  'com','sem','que','se','ao','aos','e','ou','mas','the','of','to','and','is','it','eu','voce','vc',
  'meu','minha','seu','sua','isso','isto','esse','essa','este','esta','ele','ela','foi','ser','ter',
]);

/** Extrai termos indexáveis de um texto (palavras e números úteis). */
export function extractTerms(text: string, max = 48): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of normalizeTerm(text).split(' ')) {
    if (raw.length < 3 || raw.length > 40) continue;
    if (STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= max) break;
  }
  return out;
}

export function constantTimeEqual(a: Buffer | string, b: Buffer | string): boolean {
  const ba = Buffer.isBuffer(a) ? a : Buffer.from(a, 'utf8');
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
