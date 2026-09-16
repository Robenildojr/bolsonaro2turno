/**
 * Anexos: imagens e PDFs.
 *
 * O problema que este módulo resolve não é "mandar a imagem para o modelo" —
 * isso é uma linha. É o que acontece **depois**: uma foto de documento vira
 * ~2 MB em base64, e guardar isso no histórico significa (a) inchar o banco e
 * (b) reenviar a imagem inteira em todo turno seguinte, para sempre.
 *
 * A solução aqui tem três partes:
 *
 *  1. o arquivo vai para o disco, em `~/.gideao/cache/anexos`, cifrado;
 *  2. o histórico guarda apenas uma **referência** (`gideao_anexo`), leve;
 *  3. na hora de montar a requisição, as referências recentes são
 *     reidratadas em blocos de verdade e as antigas viram texto.
 *
 * O resultado prático: você manda a foto da intimação, faz cinco perguntas
 * sobre ela, e a partir daí a conversa segue leve — mas a imagem continua
 * guardada e recuperável se você voltar ao assunto.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { paths } from '../../config.js';
import { getStore } from '../db/database.js';
import { id as newId } from '../../util/ids.js';
import { createLogger } from '../../util/logger.js';

const log = createLogger('anexos');

/** Formatos que o modelo enxerga de verdade. */
const IMAGENS: Record<string, 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Limites da API. Ultrapassar não dá erro bonito, então cortamos antes. */
const MAX_IMAGEM = 5 * 1024 * 1024;
const MAX_PDF = 30 * 1024 * 1024;

/** Quantas mensagens para trás os anexos continuam sendo enviados inteiros. */
export const JANELA_ANEXOS = 8;

export interface Anexo {
  id: string;
  nome: string;
  mime: string;
  bytes: number;
  tipo: 'imagem' | 'pdf' | 'texto';
  criadoEm: number;
}

/** Bloco leve que fica gravado no histórico no lugar do conteúdo. */
export interface ReferenciaAnexo {
  type: 'gideao_anexo';
  id: string;
  nome: string;
  mime: string;
  bytes: number;
  tipo: Anexo['tipo'];
}

export function ehReferencia(bloco: unknown): bloco is ReferenciaAnexo {
  return Boolean(bloco) && (bloco as { type?: string }).type === 'gideao_anexo';
}

function pastaAnexos(): string {
  const dir = path.join(paths().cache, 'anexos');
  fsSync.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function classificar(mime: string, nome: string): Anexo['tipo'] | null {
  const ext = nome.split('.').pop()?.toLowerCase() ?? '';
  if (mime.startsWith('image/') || IMAGENS[ext]) return 'imagem';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mime.startsWith('text/') || ['txt', 'md', 'csv', 'json', 'xml'].includes(ext)) return 'texto';
  return null;
}

function normalizarMime(mime: string, nome: string, tipo: Anexo['tipo']): string {
  if (tipo === 'pdf') return 'application/pdf';
  if (tipo === 'texto') return 'text/plain';
  const ext = nome.split('.').pop()?.toLowerCase() ?? '';
  // A API só aceita quatro tipos de imagem; qualquer outra coisa é recusada.
  return IMAGENS[ext] ?? (mime in Object.values(IMAGENS) ? mime : 'image/jpeg');
}

/**
 * Guarda um anexo. O conteúdo vai cifrado para o disco, como todo o resto.
 */
export async function guardar(
  conteudo: Buffer,
  opts: { nome: string; mime?: string },
): Promise<Anexo> {
  const nome = opts.nome.replace(/[/\\]/g, '_').slice(0, 120) || 'anexo';
  const tipo = classificar(opts.mime ?? '', nome);

  if (!tipo) {
    throw new Error(
      `não sei ler "${nome}" (${opts.mime || 'tipo desconhecido'}). ` +
        'Envie imagem (jpg, png, gif, webp), PDF ou texto.',
    );
  }

  const limite = tipo === 'pdf' ? MAX_PDF : tipo === 'imagem' ? MAX_IMAGEM : 2 * 1024 * 1024;
  if (conteudo.length > limite) {
    throw new Error(
      `"${nome}" tem ${(conteudo.length / 1024 / 1024).toFixed(1)} MB e o limite para ` +
        `${tipo} é ${(limite / 1024 / 1024).toFixed(0)} MB.`,
    );
  }

  const anexoId = newId('anx');
  const arquivo = path.join(pastaAnexos(), anexoId);
  const store = getStore();
  await fs.writeFile(arquivo, store.encText(conteudo.toString('base64'), `anexos:${anexoId}`), {
    mode: 0o600,
  });

  const anexo: Anexo = {
    id: anexoId,
    nome,
    mime: normalizarMime(opts.mime ?? '', nome, tipo),
    bytes: conteudo.length,
    tipo,
    criadoEm: Date.now(),
  };

  store.setKv(`anexo:${anexoId}`, anexo);
  log.info('anexo guardado', { id: anexoId, nome, tipo, kb: Math.round(conteudo.length / 1024) });
  return anexo;
}

export function metadados(anexoId: string): Anexo | null {
  return getStore().getKv<Anexo | null>(`anexo:${anexoId}`, null);
}

export async function carregar(anexoId: string): Promise<Buffer | null> {
  try {
    const cifrado = await fs.readFile(path.join(pastaAnexos(), anexoId));
    const base64 = getStore().decText(cifrado, `anexos:${anexoId}`);
    return Buffer.from(base64, 'base64');
  } catch {
    return null;
  }
}

export function referencia(anexo: Anexo): ReferenciaAnexo {
  return {
    type: 'gideao_anexo',
    id: anexo.id,
    nome: anexo.nome,
    mime: anexo.mime,
    bytes: anexo.bytes,
    tipo: anexo.tipo,
  };
}

/** Texto que substitui um anexo antigo demais para continuar sendo enviado. */
export function descrever(ref: ReferenciaAnexo): string {
  const tamanho =
    ref.bytes > 1024 * 1024
      ? `${(ref.bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.round(ref.bytes / 1024)} KB`;
  return `[${ref.tipo} enviado antes nesta conversa: "${ref.nome}", ${tamanho}. O conteúdo não está mais no contexto — peça para reenviar se precisar olhar de novo.]`;
}

/**
 * Converte uma referência no bloco que a API entende.
 *
 * PDF vira bloco `document`, que o modelo lê com layout e tudo; imagem vira
 * bloco `image`; texto vira texto mesmo, que é mais barato que documento.
 */
export async function hidratar(
  ref: ReferenciaAnexo,
): Promise<Anthropic.Beta.BetaContentBlockParam | null> {
  const conteudo = await carregar(ref.id);
  if (!conteudo) {
    log.warn('anexo não encontrado no disco', { id: ref.id, nome: ref.nome });
    return { type: 'text', text: `[anexo "${ref.nome}" não está mais disponível no disco]` };
  }

  switch (ref.tipo) {
    case 'imagem':
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: ref.mime as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: conteudo.toString('base64'),
        },
      };

    case 'pdf':
      return {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: conteudo.toString('base64'),
        },
        title: ref.nome,
      };

    case 'texto':
      return {
        type: 'text',
        text: `Conteúdo de "${ref.nome}":\n\n${conteudo.toString('utf8').slice(0, 200_000)}`,
      };

    default:
      return null;
  }
}

/**
 * Percorre o histórico trocando referências por conteúdo real — mas só nas
 * mensagens recentes. As antigas viram a descrição de texto.
 */
export async function hidratarHistorico(
  mensagens: Anthropic.Beta.BetaMessageParam[],
  janela = JANELA_ANEXOS,
): Promise<Anthropic.Beta.BetaMessageParam[]> {
  const corte = Math.max(0, mensagens.length - janela);
  const saida: Anthropic.Beta.BetaMessageParam[] = [];

  for (const [indice, mensagem] of mensagens.entries()) {
    if (typeof mensagem.content === 'string') {
      saida.push(mensagem);
      continue;
    }

    const blocos = mensagem.content as unknown[];
    if (!blocos.some(ehReferencia)) {
      saida.push(mensagem);
      continue;
    }

    const recente = indice >= corte;
    const convertidos: Anthropic.Beta.BetaContentBlockParam[] = [];

    for (const bloco of blocos) {
      if (!ehReferencia(bloco)) {
        convertidos.push(bloco as Anthropic.Beta.BetaContentBlockParam);
        continue;
      }
      if (recente) {
        const hidratado = await hidratar(bloco);
        if (hidratado) convertidos.push(hidratado);
      } else {
        convertidos.push({ type: 'text', text: descrever(bloco) });
      }
    }

    saida.push({ ...mensagem, content: convertidos });
  }

  return saida;
}

/** Limpa anexos com mais de N dias que não estão mais em nenhuma conversa. */
export async function limparAntigos(dias = 90): Promise<number> {
  const store = getStore();
  const corte = Date.now() - dias * 86_400_000;
  let removidos = 0;

  const chaves = store.db
    .prepare("SELECT key FROM kv WHERE key LIKE 'anexo:%'")
    .all() as Array<{ key: string }>;

  for (const { key } of chaves) {
    const anexo = store.getKv<Anexo | null>(key, null);
    if (!anexo || anexo.criadoEm > corte) continue;
    await fs.unlink(path.join(pastaAnexos(), anexo.id)).catch(() => {});
    store.deleteKv(key);
    removidos++;
  }

  if (removidos > 0) log.info('anexos antigos descartados', { total: removidos, dias });
  return removidos;
}

export function tiposAceitos(): string {
  return 'imagem (jpg, png, gif, webp), PDF, ou texto (txt, md, csv, json)';
}
