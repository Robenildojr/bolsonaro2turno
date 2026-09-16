/**
 * Memória de nascimento.
 *
 * Um agente que lembra tudo tem um problema no primeiro dia: ele não lembra
 * nada. A conversa em que o Gideão foi construído tinha o que ele precisa
 * saber — quem é o dono, como falar com ele, por que cada decisão do sistema é
 * como é — e essa conversa aconteceu fora dele, num lugar que ele não alcança.
 *
 * Este módulo é a ponte: `seed/genese.json` carrega o que ficou estabelecido
 * ali, e a importação transforma cada item numa memória de verdade, que entra
 * na recuperação como qualquer outra.
 *
 * Duas propriedades importam:
 *
 *  - **é idempotente.** A gravação já funde por `subject`, então rodar duas
 *    vezes atualiza em vez de duplicar. Isso permite reimportar depois de
 *    editar o arquivo, sem limpar nada antes.
 *  - **não é imutável.** São memórias comuns: o dono pode corrigir na conversa
 *    e a correção vence, como em qualquer outra. Semear não é gravar em pedra;
 *    é começar com alguma coisa em vez de com nada.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { getMemory } from './index.js';
import { MEMORY_KINDS } from './types.js';
import { createLogger } from '../../util/logger.js';

const log = createLogger('genese');

const ItemSchema = z.object({
  kind: z.enum(MEMORY_KINDS as [string, ...string[]]),
  subject: z.string().min(1).max(200),
  content: z.string().min(1).max(4000),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  pinned: z.boolean().optional(),
});

const ArquivoSchema = z.object({
  versao: z.number().optional(),
  descricao: z.string().optional(),
  memorias: z.array(ItemSchema).min(1),
});

/** Caminho do arquivo que vem junto com o código. */
export function caminhoPadrao(): string {
  const aqui = path.dirname(fileURLToPath(import.meta.url));
  // Em desenvolvimento roda de src/, compilado roda de dist/: sobe até achar.
  for (const acima of ['../../..', '../../../..']) {
    const tentativa = path.resolve(aqui, acima, 'seed/genese.json');
    if (fs.existsSync(tentativa)) return tentativa;
  }
  return path.resolve(aqui, '../../../seed/genese.json');
}

export interface ResultadoGenese {
  gravadas: number;
  arquivo: string;
  assuntos: string[];
}

export async function semear(arquivo = caminhoPadrao()): Promise<ResultadoGenese> {
  const bruto = fs.readFileSync(arquivo, 'utf8');
  const dados = ArquivoSchema.parse(JSON.parse(bruto));
  const memoria = getMemory();

  const assuntos: string[] = [];
  for (const item of dados.memorias) {
    await memoria.remember({
      kind: item.kind as (typeof MEMORY_KINDS)[number],
      subject: item.subject,
      content: item.content,
      importance: item.importance ?? 0.8,
      confidence: item.confidence ?? 0.95,
      pinned: item.pinned ?? false,
      source: 'gênese',
    });
    assuntos.push(item.subject);
  }

  log.info('memória de nascimento importada', { total: assuntos.length, arquivo });
  return { gravadas: assuntos.length, arquivo, assuntos };
}
