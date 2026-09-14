/**
 * Informações do sistema e autogestão.
 *
 * Inclui a ferramenta pela qual a Íris consulta as próprias autorizações. Isso
 * evita o padrão irritante de tentar uma ação, ser barrada e só então descobrir
 * que não podia — ela consegue verificar antes e propor o caminho certo.
 */
import os from 'node:os';
import { z } from 'zod';
import { loadConfig, paths } from '../config.js';
import { getBroker } from '../core/permissions/broker.js';
import { getStore } from '../core/db/database.js';
import { getMemory } from '../core/memory/index.js';
import { CAPABILITIES } from '../core/permissions/capabilities.js';
import type { ToolDefinition } from '../core/agent/tools.js';
import { formatDateTime, formatShort } from '../util/time.js';

const infoSistema: ToolDefinition<Record<string, never>> = {
  name: 'info_sistema',
  description:
    'Informações do computador e do estado da Íris: sistema operacional, memória, disco, data e hora, tamanho da base de memórias.',
  capability: 'sistema.info',
  scopeFrom: () => '*',
  schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  summarize: () => 'consultar o estado do sistema',
  async run() {
    const cfg = loadConfig();
    const stats = getStore().stats();
    const porTipo = getMemory().stats();

    const linhas = [
      `Agora: ${formatDateTime(new Date(), cfg.timezone, cfg.locale)}`,
      `Sistema: ${os.type()} ${os.release()} (${os.arch()})`,
      `Máquina: ${os.hostname()}, ${os.cpus().length} núcleos, ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB de RAM (${(os.freemem() / 1024 ** 3).toFixed(1)} GB livres)`,
      `Ligado há: ${(os.uptime() / 3600).toFixed(1)} horas`,
      `Pasta da Íris: ${paths().home}`,
      `Banco: ${(stats.arquivo_bytes! / 1024 ** 2).toFixed(1)} MB`,
      `Conversas: ${stats.conversations}, mensagens: ${stats.messages}`,
      `Memórias: ${Object.entries(porTipo).map(([k, v]) => `${k} ${v}`).join(', ') || 'nenhuma ainda'}`,
      `Credenciais no cofre: ${stats.vault_items}`,
      `Lembretes: ${stats.reminders}, tarefas: ${stats.tasks}, processos monitorados: ${stats.processes}`,
      `Modelo: ${cfg.model.main} (esforço ${cfg.model.effort})`,
      `Embeddings: ${cfg.memory.embeddings}`,
    ];
    return { ok: true, content: linhas.join('\n') };
  },
};

const minhasAutorizacoes: ToolDefinition<Record<string, never>> = {
  name: 'minhas_autorizacoes',
  description:
    'Lista o que o dono já autorizou e o que ainda não. Consulte antes de propor uma tarefa que depende de acesso, para saber se vai passar direto ou se vai aparecer um pedido para ele.',
  schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  summarize: () => 'consultar minhas autorizações',
  async run() {
    const cfg = loadConfig();
    const grants = getBroker().list();

    const concedidas = grants.filter((g) => g.decision !== 'negado_sempre');
    const negadas = grants.filter((g) => g.decision === 'negado_sempre');

    const partes: string[] = [];

    if (concedidas.length > 0) {
      partes.push(
        'AUTORIZADO (passa direto, sem perguntar):\n' +
          concedidas
            .map((g) => {
              const uso = g.lastUsedAt
                ? `${g.useCount}× · última em ${formatShort(new Date(g.lastUsedAt), cfg.timezone, cfg.locale)}`
                : 'ainda não usada';
              return `- ${g.capability} em ${g.scope} (${uso})`;
            })
            .join('\n'),
      );
    } else {
      partes.push('AUTORIZADO: nada ainda — toda ação sensível vai gerar um pedido.');
    }

    if (negadas.length > 0) {
      partes.push(
        'NEGADO PERMANENTEMENTE (nem tente):\n' + negadas.map((g) => `- ${g.capability} em ${g.scope}`).join('\n'),
      );
    }

    const semGrant = Object.values(CAPABILITIES)
      .filter((spec) => !concedidas.some((g) => g.capability === spec.id))
      .map((spec) => `- ${spec.id}: ${spec.label}`);
    if (semGrant.length > 0) {
      partes.push(`AINDA NÃO LIBERADO (vai gerar pedido na hora):\n${semGrant.join('\n')}`);
    }

    if (cfg.permissions.confirmCritical) {
      partes.push(
        'Ações irreversíveis (apagar em massa, formatar, e-mail a terceiros) confirmam mesmo quando autorizadas.',
      );
    }

    return { ok: true, content: partes.join('\n\n') };
  },
};

const pedirAutorizacao: ToolDefinition<{ capacidade: string; escopo: string; motivo: string }> = {
  name: 'pedir_autorizacao',
  description:
    'Pede ao dono uma autorização específica, de forma antecipada, antes de começar uma tarefa que vai precisar dela. Útil para não travar no meio de uma sequência longa. Se ele responder "sempre", não pergunta mais.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['capacidade', 'escopo', 'motivo'],
    properties: {
      capacidade: { type: 'string', enum: Object.keys(CAPABILITIES) },
      escopo: { type: 'string', description: 'Caminho, domínio, comando ou contato. Use * para tudo.' },
      motivo: { type: 'string', description: 'Por que precisa — é o que ele vai ler para decidir.' },
    },
  },
  validate: z.object({
    capacidade: z.string().min(3),
    escopo: z.string().min(1),
    motivo: z.string().min(5),
  }),
  summarize: (i) => `pedir autorização para ${i.capacidade} em ${i.escopo}`,
  timeoutMs: 330_000,
  async run(input, ctx) {
    const outcome = await getBroker().request({
      capability: input.capacidade,
      scope: input.escopo,
      reason: input.motivo,
      details: { antecipado: true },
      conversationId: ctx.conversationId,
    });
    return {
      ok: outcome.allowed,
      content: outcome.allowed
        ? `Autorizado (${outcome.decision}). Pode seguir.`
        : `Não autorizado (${outcome.decision}). Siga por outro caminho ou explique o que fica inviável sem isso.`,
    };
  },
};

export const systemTools: Array<ToolDefinition<any>> = [
  infoSistema,
  minhasAutorizacoes,
  pedirAutorizacao,
];
