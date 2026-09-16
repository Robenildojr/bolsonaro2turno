/**
 * Ferramentas de memória.
 *
 * A memória automática (reflexão + consolidação) cobre o dia a dia. Estas
 * ferramentas existem para o **controle consciente**: quando o dono diz "guarda
 * isso", "esquece aquilo", "na verdade é assim", ele merece ação imediata e
 * verificável, não a promessa de que algum processo de fundo vai reparar.
 *
 * Não exigem autorização: mexer na própria memória é a função do assistente, e
 * pedir permissão a cada anotação transformaria a conversa num interrogatório.
 */
import { z } from 'zod';
import { getMemory } from '../core/memory/index.js';
import { MEMORY_KINDS, type MemoryKind } from '../core/memory/types.js';
import type { ToolDefinition } from '../core/agent/tools.js';
import { formatShort } from '../util/time.js';
import { loadConfig } from '../config.js';

const lembrar: ToolDefinition<{
  tipo: string;
  assunto: string;
  conteudo: string;
  importancia: number;
  fixar: boolean;
}> = {
  name: 'lembrar',
  description:
    'Guarda algo na memória de longo prazo agora. Use quando o dono pedir explicitamente ("anota isso", "não esquece") ou quando aparecer uma informação que claramente vai importar depois. Use fixar=true para memória que nunca deve desbotar.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['tipo', 'assunto', 'conteudo', 'importancia', 'fixar'],
    properties: {
      tipo: { type: 'string', enum: MEMORY_KINDS.filter((k) => k !== 'perfil') },
      assunto: { type: 'string', description: 'Até 8 palavras. É a chave de deduplicação — seja consistente.' },
      conteudo: {
        type: 'string',
        description: 'A informação completa, escrita para ser entendida daqui a um ano sem o contexto da conversa.',
      },
      importancia: { type: 'number', description: '0 a 1.' },
      fixar: { type: 'boolean', description: 'true = nunca desbota nem é descartada pela consolidação.' },
    },
  },
  validate: z.object({
    tipo: z.string(),
    assunto: z.string().min(1).max(200),
    conteudo: z.string().min(3),
    importancia: z.number().min(0).max(1),
    fixar: z.boolean(),
  }),
  summarize: (i) => `guardar na memória: ${i.assunto}`,
  async run(input, ctx) {
    const kind = (MEMORY_KINDS as string[]).includes(input.tipo) ? (input.tipo as MemoryKind) : 'fato';
    const memory = await getMemory().remember({
      kind,
      subject: input.assunto,
      content: input.conteudo,
      importance: input.importancia,
      confidence: 0.95,
      source: 'pedido direto do dono',
      conversationId: ctx.conversationId,
      pinned: input.fixar,
    });
    return {
      ok: true,
      content: `Guardado [${memory.id}] como ${kind}${input.fixar ? ', fixado' : ''}.`,
      data: { id: memory.id },
    };
  },
};

const buscarMemoria: ToolDefinition<{ pergunta: string; tipo: string; limite: number }> = {
  name: 'buscar_memoria',
  description:
    'Procura na memória por algo específico. O contexto de cada turno já traz o que é relevante automaticamente — use esta ferramenta quando precisar de mais, de um período diferente ou de um tipo específico.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['pergunta', 'tipo', 'limite'],
    properties: {
      pergunta: { type: 'string' },
      tipo: {
        type: 'string',
        description: `Filtra por tipo. Vazio = todos. Opções: ${MEMORY_KINDS.join(', ')}.`,
      },
      limite: { type: 'integer', description: 'Quantas trazer. 0 = usar o padrão (15).' },
    },
  },
  validate: z.object({
    pergunta: z.string().min(1),
    tipo: z.string(),
    limite: z.number().int().min(0).max(80),
  }),
  summarize: (i) => `buscar na memória: ${i.pergunta.slice(0, 80)}`,
  async run(input) {
    const cfg = loadConfig();
    const kinds = (MEMORY_KINDS as string[]).includes(input.tipo) ? [input.tipo as MemoryKind] : undefined;
    const found = await getMemory().recall(input.pergunta, {
      limit: input.limite || 15,
      ...(kinds ? { kinds } : {}),
    });
    if (found.length === 0) return { ok: true, content: 'Nada na memória sobre isso.' };

    const linhas = found.map((m) => {
      const quando = formatShort(new Date(m.updatedAt), cfg.timezone, cfg.locale);
      return `[${m.id}] (${m.kind}, ${quando}, relevância ${m.score.toFixed(2)}) ${m.subject}: ${m.content}`;
    });
    return { ok: true, content: linhas.join('\n\n') };
  },
};

const corrigirMemoria: ToolDefinition<{ id: string; novo_conteudo: string; motivo: string }> = {
  name: 'corrigir_memoria',
  description:
    'Corrige uma memória errada. A anotação antiga não some — fica marcada como substituída, de modo que dá para auditar o que ela achava antes.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'novo_conteudo', 'motivo'],
    properties: {
      id: { type: 'string', description: 'O id mostrado no contexto, no formato mem_…' },
      novo_conteudo: { type: 'string' },
      motivo: { type: 'string' },
    },
  },
  validate: z.object({ id: z.string().min(3), novo_conteudo: z.string().min(3), motivo: z.string() }),
  summarize: (i) => `corrigir a memória ${i.id}`,
  async run(input, ctx) {
    const memory = getMemory();
    const old = memory.get(input.id);
    if (!old) return { ok: false, content: `Não achei a memória ${input.id}.` };

    const replacement = await memory.remember({
      kind: old.kind,
      subject: old.subject,
      content: input.novo_conteudo,
      importance: Math.max(old.importance, 0.6),
      confidence: 0.95,
      source: `correção: ${input.motivo}`.slice(0, 200),
      conversationId: ctx.conversationId,
      pinned: old.pinned,
      skipDedup: true,
    });
    memory.memories.supersede(old.id, replacement.id);
    return { ok: true, content: `Corrigido. Agora vale [${replacement.id}].` };
  },
};

const esquecer: ToolDefinition<{ id: string }> = {
  name: 'esquecer',
  description:
    'Apaga uma memória de vez, quando o dono pedir. Diferente de corrigir: aqui a informação sai do banco e não volta.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string' } },
  },
  validate: z.object({ id: z.string().min(3) }),
  summarize: (i) => `apagar a memória ${i.id}`,
  async run(input) {
    const memory = getMemory();
    const existing = memory.get(input.id);
    if (!existing) return { ok: false, content: `Não achei a memória ${input.id}.` };
    memory.forget(input.id);
    return { ok: true, content: `Apaguei "${existing.subject}". Não vou mais lembrar disso.` };
  },
};

const revisarAprendizado: ToolDefinition<Record<string, never>> = {
  name: 'revisar_aprendizado',
  description:
    'Roda agora a extração de aprendizados desta conversa, em vez de esperar o ciclo automático. Use quando o dono ensinar algo denso e você quiser garantir que ficou guardado antes de mudar de assunto.',
  schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  summarize: () => 'consolidar o que aprendi nesta conversa',
  timeoutMs: 180_000,
  async run(_input, ctx) {
    const aprendidas = await getMemory().reflectNow(ctx.conversationId);
    return {
      ok: true,
      content:
        aprendidas > 0
          ? `Guardei ${aprendidas} aprendizado(s) desta conversa.`
          : 'Revisei a conversa e não havia nada novo que valesse guardar.',
    };
  },
};

export const memoryTools: Array<ToolDefinition<any>> = [
  lembrar,
  buscarMemoria,
  corrigirMemoria,
  esquecer,
  revisarAprendizado,
];
