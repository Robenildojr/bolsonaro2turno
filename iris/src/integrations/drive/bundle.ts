/**
 * Pacote de backup cifrado.
 *
 * O formato é **autossuficiente**: a chave é derivada da senha-mestra usando um
 * sal que viaja dentro do próprio arquivo. Consequência prática — se o seu
 * computador se perder inteiro, keyring e tudo, você restaura num computador
 * novo só com a senha-mestra. Não existe nada mais a guardar.
 *
 *   IRISBK  (6) | versão (1) | reservado (1) | sal (32) | IV (12) | tag (16) | ciphertext
 *                                                                              └ gzip(JSON)
 *
 * O Google armazena isto. Sem a senha-mestra, são bytes aleatórios para ele.
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { deriveSubkey } from '../../core/crypto/cipher.js';
import { DEFAULT_KDF } from '../../core/crypto/keyring.js';
import type { Store } from '../../core/db/database.js';
import type { Vault } from '../../core/vault/vault.js';
import { createLogger } from '../../util/logger.js';

const log = createLogger('backup');

const MAGIC = Buffer.from('IRISBK', 'ascii');
const VERSAO = 1;
const SAL_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const CABECALHO = MAGIC.length + 2 + SAL_LEN + IV_LEN + TAG_LEN;

export interface ConteudoBackup {
  versao: number;
  geradoEm: string;
  origem: { assistente: string; dono: string };
  memorias: unknown[];
  conversas: unknown[];
  mensagens: unknown[];
  cofre: unknown[];
  autorizacoes: unknown[];
  lembretes: unknown[];
  tarefas: unknown[];
  processos: unknown[];
  movimentacoes: unknown[];
  perfil: string;
}

/** Deriva a chave do arquivo a partir da senha e do sal que viaja nele. */
function chaveDoArquivo(senha: string, sal: Buffer): Buffer {
  const kek = scryptSync(senha.normalize('NFKC'), sal, DEFAULT_KDF.keyLen, {
    N: DEFAULT_KDF.N,
    r: DEFAULT_KDF.r,
    p: DEFAULT_KDF.p,
    maxmem: 256 * DEFAULT_KDF.N * DEFAULT_KDF.r,
  });
  const chave = deriveSubkey(kek, 'iris:backup-file:v1');
  kek.fill(0);
  return chave;
}

export function empacotar(conteudo: ConteudoBackup, senha: string): Buffer {
  const sal = randomBytes(SAL_LEN);
  const chave = chaveDoArquivo(senha, sal);
  const iv = randomBytes(IV_LEN);

  // Comprimir antes de cifrar: depois de cifrado não há padrão para comprimir.
  const comprimido = gzipSync(Buffer.from(JSON.stringify(conteudo), 'utf8'), { level: 9 });

  const cipher = createCipheriv('aes-256-gcm', chave, iv);
  cipher.setAAD(Buffer.concat([MAGIC, Buffer.from([VERSAO])]));
  const cifrado = Buffer.concat([cipher.update(comprimido), cipher.final()]);
  const tag = cipher.getAuthTag();
  chave.fill(0);

  return Buffer.concat([MAGIC, Buffer.from([VERSAO, 0]), sal, iv, tag, cifrado]);
}

export function desempacotar(pacote: Buffer, senha: string): ConteudoBackup {
  if (pacote.length < CABECALHO) throw new Error('arquivo de backup truncado');
  if (!pacote.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('isto não parece um backup da Íris');
  }
  const versao = pacote[MAGIC.length];
  if (versao !== VERSAO) throw new Error(`backup versão ${versao} não é suportado por esta versão`);

  let pos = MAGIC.length + 2;
  const sal = pacote.subarray(pos, (pos += SAL_LEN));
  const iv = pacote.subarray(pos, (pos += IV_LEN));
  const tag = pacote.subarray(pos, (pos += TAG_LEN));
  const cifrado = pacote.subarray(pos);

  const chave = chaveDoArquivo(senha, sal);
  const decipher = createDecipheriv('aes-256-gcm', chave, iv);
  decipher.setAAD(Buffer.concat([MAGIC, Buffer.from([VERSAO])]));
  decipher.setAuthTag(tag);

  let comprimido: Buffer;
  try {
    comprimido = Buffer.concat([decipher.update(cifrado), decipher.final()]);
  } catch {
    chave.fill(0);
    throw new Error('senha-mestra errada, ou o arquivo foi corrompido');
  }
  chave.fill(0);

  return JSON.parse(gunzipSync(comprimido).toString('utf8')) as ConteudoBackup;
}

/**
 * Lê o banco inteiro e monta o conteúdo do backup **em claro**.
 *
 * Em claro aqui é proposital: o pacote inteiro é cifrado logo em seguida com a
 * chave derivada da senha. Se guardássemos os registros ainda cifrados com as
 * chaves da máquina atual, o backup só abriria naquela máquina — que é o
 * oposto do que um backup serve para fazer.
 */
export function coletar(
  store: Store,
  vault: Vault,
  info: { assistente: string; dono: string },
): ConteudoBackup {
  const db = store.db;

  const memorias = (
    db.prepare('SELECT * FROM memories').all() as Array<Record<string, unknown>>
  ).map((r) => ({
    ...semBinarios(r),
    content: store.decText(r.content_enc as Buffer, `memories:content:${r.id as string}`),
    termos: (
      db.prepare('SELECT term FROM memory_terms WHERE memory_id = ?').all(r.id) as Array<{ term: string }>
    ).map((t) => t.term),
  }));

  const conversas = (
    db.prepare('SELECT * FROM conversations').all() as Array<Record<string, unknown>>
  ).map((r) => ({
    ...semBinarios(r),
    title: r.title_enc ? store.decText(r.title_enc as Buffer, `conversations:title:${r.id as string}`) : '',
    summary: r.summary_enc
      ? store.decText(r.summary_enc as Buffer, `conversations:summary:${r.id as string}`)
      : '',
  }));

  const mensagens = (
    db.prepare('SELECT * FROM messages ORDER BY created_at ASC').all() as Array<Record<string, unknown>>
  ).map((r) => ({
    ...semBinarios(r),
    content: store.decText(r.content_enc as Buffer, `messages:content:${r.id as string}`),
    blocks: r.blocks_enc
      ? store.decJson<unknown>(r.blocks_enc as Buffer, `messages:blocks:${r.id as string}`, null)
      : null,
  }));

  const lembretes = (
    db.prepare('SELECT * FROM reminders').all() as Array<Record<string, unknown>>
  ).map((r) => ({
    ...semBinarios(r),
    title: store.decText(r.title_enc as Buffer, `reminders:title:${r.id as string}`),
    body: r.body_enc ? store.decText(r.body_enc as Buffer, `reminders:body:${r.id as string}`) : '',
  }));

  const tarefas = (db.prepare('SELECT * FROM tasks').all() as Array<Record<string, unknown>>).map((r) => ({
    ...semBinarios(r),
    title: store.decText(r.title_enc as Buffer, `tasks:title:${r.id as string}`),
    notes: r.notes_enc ? store.decText(r.notes_enc as Buffer, `tasks:notes:${r.id as string}`) : '',
  }));

  const processos = (
    db.prepare('SELECT * FROM processes').all() as Array<Record<string, unknown>>
  ).map((r) => ({
    ...semBinarios(r),
    label: r.label_enc ? store.decText(r.label_enc as Buffer, `processes:label:${r.id as string}`) : '',
    data: r.data_enc ? store.decJson<unknown>(r.data_enc as Buffer, `processes:data:${r.id as string}`, null) : null,
  }));

  const movimentacoes = (
    db.prepare('SELECT * FROM process_movements').all() as Array<Record<string, unknown>>
  ).map((r) => ({
    ...semBinarios(r),
    content: store.decJson<unknown>(r.content_enc as Buffer, `movements:content:${r.id as string}`, null),
  }));

  const autorizacoes = (
    db.prepare('SELECT * FROM capabilities').all() as Array<Record<string, unknown>>
  ).map((r) => semBinarios(r));

  // O cofre é lido pela API dele, que conhece a própria chave.
  const cofre = vault.list().map((item) => ({
    name: item.name,
    kind: item.kind,
    meta: item.meta,
    value: vault.get(item.name),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));

  const perfilRow = db
    .prepare("SELECT * FROM memories WHERE kind = 'perfil' AND superseded_by IS NULL LIMIT 1")
    .get() as Record<string, unknown> | undefined;

  return {
    versao: 1,
    geradoEm: new Date().toISOString(),
    origem: info,
    memorias,
    conversas,
    mensagens,
    cofre,
    autorizacoes,
    lembretes,
    tarefas,
    processos,
    movimentacoes,
    perfil: perfilRow
      ? store.decText(perfilRow.content_enc as Buffer, `memories:content:${perfilRow.id as string}`)
      : '',
  };
}

/** Remove as colunas `_enc` e blobs — elas já viraram campos legíveis. */
function semBinarios(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.endsWith('_enc')) continue;
    if (Buffer.isBuffer(v)) {
      out[k] = v.toString('base64');
      continue;
    }
    out[k] = v;
  }
  return out;
}

export function resumirBackup(conteudo: ConteudoBackup): string {
  return [
    `Backup de ${new Date(conteudo.geradoEm).toLocaleString('pt-BR')}`,
    `Memórias: ${conteudo.memorias.length}`,
    `Conversas: ${conteudo.conversas.length} (${conteudo.mensagens.length} mensagens)`,
    `Credenciais: ${conteudo.cofre.length}`,
    `Autorizações: ${conteudo.autorizacoes.length}`,
    `Lembretes: ${conteudo.lembretes.length}, tarefas: ${conteudo.tarefas.length}`,
    `Processos: ${conteudo.processos.length} (${conteudo.movimentacoes.length} movimentações)`,
  ].join('\n');
}

export function nomeDoArquivo(data = new Date()): string {
  const iso = data.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `iris-${iso}.iris`;
}

export { log as logBackup };
