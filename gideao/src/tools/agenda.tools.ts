/**
 * Ferramentas de agenda, processos e e-mail.
 *
 * A data chega do modelo em ISO 8601 já resolvida ("2026-09-15T14:00:00"). Isso
 * é de propósito: o modelo sabe que dia é hoje (vem no contexto do turno) e
 * converte "amanhã às 14h" muito melhor do que um interpretador de linguagem
 * natural feito à mão — que erraria em "terça que vem" e em "daqui a 15 dias
 * úteis" justamente quando o erro custa um prazo.
 */
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { getAgenda } from '../core/scheduler/agenda.js';
import { getProcessos } from '../integrations/justice/monitor.js';
import { getEmail } from '../integrations/email/mail.js';
import { descreverProcesso, formatarNumero } from '../integrations/justice/datajud.js';
import type { ToolDefinition } from '../core/agent/tools.js';
import { truncateForModel } from '../core/agent/tools.js';
import { formatShort, relative } from '../util/time.js';

/** Converte ISO local para epoch no fuso do dono. */
function paraEpoch(iso: string): number {
  const cfg = loadConfig();
  // Sem fuso explícito, interpreta como horário local do dono.
  const temFuso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso);
  if (temFuso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) throw new Error(`data inválida: "${iso}"`);
    return t;
  }

  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(iso.trim());
  if (!m) throw new Error(`use o formato AAAA-MM-DDTHH:MM — recebi "${iso}"`);
  const [, ano, mes, dia, hora, minuto, segundo] = m;

  // Descobre o deslocamento do fuso naquele instante e corrige.
  const comoUtc = Date.UTC(
    Number(ano),
    Number(mes) - 1,
    Number(dia),
    Number(hora),
    Number(minuto),
    Number(segundo ?? 0),
  );
  const local = new Date(comoUtc).toLocaleString('sv-SE', { timeZone: cfg.timezone });
  const deslocamento = comoUtc - new Date(`${local.replace(' ', 'T')}Z`).getTime();
  return comoUtc + deslocamento;
}

const criarLembrete: ToolDefinition<{
  titulo: string;
  quando: string;
  tipo: 'audiencia' | 'prazo' | 'compromisso' | 'pessoal';
  detalhes: string;
  antecedencia_minutos: number;
  repeticao: string;
}> = {
  name: 'criar_lembrete',
  description:
    'Marca um lembrete com hora. Use para audiência, prazo, reunião e compromisso pessoal. Converta você mesmo a data relativa ("amanhã às 14h") para o formato AAAA-MM-DDTHH:MM usando a data de hoje que está no contexto.',
  capability: 'agenda.gravar',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['titulo', 'quando', 'tipo', 'detalhes', 'antecedencia_minutos', 'repeticao'],
    properties: {
      titulo: { type: 'string', description: 'Curto e específico. "Audiência Almeida x Transportes Norte".' },
      quando: { type: 'string', description: 'AAAA-MM-DDTHH:MM no fuso do dono.' },
      tipo: { type: 'string', enum: ['audiencia', 'prazo', 'compromisso', 'pessoal'] },
      detalhes: { type: 'string', description: 'Vara, endereço, o que levar, número do processo.' },
      antecedencia_minutos: {
        type: 'integer',
        description:
          'Com quanta antecedência avisar. 0 = padrão do tipo (audiência 1 dia, prazo 2 dias, resto 1 hora).',
      },
      repeticao: {
        type: 'string',
        description: 'Vazio, ou: diario, util, semanal, quinzenal, mensal, anual.',
      },
    },
  },
  validate: z.object({
    titulo: z.string().min(2).max(300),
    quando: z.string().min(10),
    tipo: z.enum(['audiencia', 'prazo', 'compromisso', 'pessoal']),
    detalhes: z.string(),
    antecedencia_minutos: z.number().int().min(0).max(20160),
    repeticao: z.string(),
  }),
  scopeFrom: () => '*',
  summarize: (i) => `marcar ${i.tipo}: ${i.titulo} em ${i.quando}`,
  async run(input) {
    const cfg = loadConfig();
    const quando = paraEpoch(input.quando);
    if (quando < Date.now() - 60_000) {
      return {
        ok: false,
        content: `${input.quando} já passou. Confirme a data com o dono antes de marcar.`,
      };
    }

    const lembrete = getAgenda().criarLembrete({
      titulo: input.titulo,
      corpo: input.detalhes,
      quando,
      ...(input.antecedencia_minutos > 0 ? { antecedenciaMin: input.antecedencia_minutos } : {}),
      tipo: input.tipo,
      repeticao: input.repeticao.trim() || null,
    });

    const data = new Date(quando);
    return {
      ok: true,
      content: `Marcado: ${input.titulo} em ${formatShort(data, cfg.timezone, cfg.locale)} (${relative(data, new Date(), cfg.locale)}). Aviso ${lembrete.antecedenciaMin} min antes. [${lembrete.id}]`,
      data: { id: lembrete.id },
    };
  },
};

const verAgenda: ToolDefinition<{ dias: number }> = {
  name: 'ver_agenda',
  description:
    'Lista compromissos e tarefas. O resumo dos próximos dias já vem no contexto de cada turno — use esta ferramenta para olhar mais adiante ou conferir detalhes.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['dias'],
    properties: { dias: { type: 'integer', description: 'Quantos dias olhar à frente. 0 = 7 dias.' } },
  },
  validate: z.object({ dias: z.number().int().min(0).max(365) }),
  summarize: (i) => `ver a agenda dos próximos ${i.dias || 7} dias`,
  async run(input) {
    const cfg = loadConfig();
    const agenda = getAgenda();
    const lembretes = agenda.proximos(input.dias || 7, 60);
    const tarefas = agenda.listarTarefas('aberta', 30);

    const partes: string[] = [];
    if (lembretes.length > 0) {
      partes.push(
        'COMPROMISSOS:\n' +
          lembretes
            .map(
              (l) =>
                `[${l.id}] ${formatShort(new Date(l.quando), cfg.timezone, cfg.locale)} (${relative(new Date(l.quando), new Date(), cfg.locale)}) · ${l.tipo}: ${l.titulo}${l.corpo ? `\n    ${l.corpo.replace(/\n/g, ' ').slice(0, 200)}` : ''}`,
            )
            .join('\n'),
      );
    }
    if (tarefas.length > 0) {
      partes.push(
        'TAREFAS ABERTAS:\n' +
          tarefas
            .map((t) => {
              const prazo = t.prazo
                ? ` · prazo ${formatShort(new Date(t.prazo), cfg.timezone, cfg.locale)}`
                : '';
              return `[${t.id}] prioridade ${t.prioridade}${prazo}: ${t.titulo}`;
            })
            .join('\n'),
      );
    }
    return {
      ok: true,
      content: partes.join('\n\n') || `Nada marcado nos próximos ${input.dias || 7} dias.`,
    };
  },
};

const gerenciarTarefa: ToolDefinition<{
  acao: 'criar' | 'concluir' | 'cancelar' | 'listar';
  id: string;
  titulo: string;
  notas: string;
  prioridade: number;
  prazo: string;
}> = {
  name: 'tarefa',
  description:
    'Cria, conclui, cancela ou lista tarefas. Tarefa é o que fica pendente até alguém fazer; para algo com hora marcada, use criar_lembrete.',
  capability: 'agenda.gravar',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['acao', 'id', 'titulo', 'notas', 'prioridade', 'prazo'],
    properties: {
      acao: { type: 'string', enum: ['criar', 'concluir', 'cancelar', 'listar'] },
      id: { type: 'string', description: 'Obrigatório em concluir e cancelar. Vazio nos demais.' },
      titulo: { type: 'string', description: 'Obrigatório em criar.' },
      notas: { type: 'string' },
      prioridade: { type: 'integer', description: '1 urgente, 2 normal, 3 quando der. 0 = 2.' },
      prazo: { type: 'string', description: 'AAAA-MM-DDTHH:MM ou vazio.' },
    },
  },
  validate: z.object({
    acao: z.enum(['criar', 'concluir', 'cancelar', 'listar']),
    id: z.string(),
    titulo: z.string(),
    notas: z.string(),
    prioridade: z.number().int().min(0).max(5),
    prazo: z.string(),
  }),
  scopeFrom: () => '*',
  summarize: (i) => `${i.acao} tarefa${i.titulo ? `: ${i.titulo}` : ''}`,
  async run(input) {
    const agenda = getAgenda();

    switch (input.acao) {
      case 'criar': {
        if (!input.titulo.trim()) return { ok: false, content: 'Informe o título da tarefa.' };
        const tarefa = agenda.criarTarefa({
          titulo: input.titulo,
          notas: input.notas,
          prioridade: input.prioridade || 2,
          prazo: input.prazo.trim() ? paraEpoch(input.prazo) : null,
        });
        return { ok: true, content: `Anotei: ${tarefa.titulo} [${tarefa.id}]` };
      }
      case 'concluir': {
        const t = agenda.atualizarTarefa(input.id, { status: 'concluida' });
        return t
          ? { ok: true, content: `Concluída: ${t.titulo}` }
          : { ok: false, content: `Não achei a tarefa ${input.id}.` };
      }
      case 'cancelar': {
        const t = agenda.atualizarTarefa(input.id, { status: 'cancelada' });
        return t
          ? { ok: true, content: `Cancelada: ${t.titulo}` }
          : { ok: false, content: `Não achei a tarefa ${input.id}.` };
      }
      case 'listar':
      default: {
        const tarefas = agenda.listarTarefas('aberta', 40);
        return {
          ok: true,
          content:
            tarefas.map((t) => `[${t.id}] p${t.prioridade}: ${t.titulo}`).join('\n') ||
            'Nenhuma tarefa aberta.',
        };
      }
    }
  },
};

const concluirLembrete: ToolDefinition<{ id: string; acao: 'concluir' | 'cancelar' }> = {
  name: 'fechar_lembrete',
  description: 'Marca um lembrete como concluído ou cancelado.',
  capability: 'agenda.gravar',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'acao'],
    properties: {
      id: { type: 'string' },
      acao: { type: 'string', enum: ['concluir', 'cancelar'] },
    },
  },
  validate: z.object({ id: z.string().min(3), acao: z.enum(['concluir', 'cancelar']) }),
  scopeFrom: () => '*',
  summarize: (i) => `${i.acao} o lembrete ${i.id}`,
  async run(input) {
    const agenda = getAgenda();
    const ok =
      input.acao === 'concluir' ? agenda.concluirLembrete(input.id) : agenda.cancelarLembrete(input.id);
    return ok
      ? { ok: true, content: `Lembrete ${input.acao === 'concluir' ? 'concluído' : 'cancelado'}.` }
      : { ok: false, content: `Não achei o lembrete ${input.id}.` };
  },
};

// ── processos ────────────────────────────────────────────────────────────────

const consultarProcesso: ToolDefinition<{ numero: string; acompanhar: boolean; rotulo: string }> = {
  name: 'consultar_processo',
  description:
    'Consulta um processo pelo número CNJ na base pública do CNJ (DataJud) e devolve classe, órgão e movimentações. Com acompanhar=true, passa a verificar sozinha e avisa quando houver movimentação nova. A base pública não tem peças nem processo em segredo de justiça — para isso é preciso entrar no sistema do tribunal com as credenciais do dono.',
  capability: 'processo.consultar',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['numero', 'acompanhar', 'rotulo'],
    properties: {
      numero: { type: 'string', description: 'Número CNJ, com ou sem máscara.' },
      acompanhar: { type: 'boolean', description: 'true = monitorar daqui para frente.' },
      rotulo: { type: 'string', description: 'Como chamar este processo. Ex.: "Almeida x Transportes Norte".' },
    },
  },
  validate: z.object({
    numero: z.string().min(15),
    acompanhar: z.boolean(),
    rotulo: z.string(),
  }),
  scopeFrom: () => 'datajud.cnj.jus.br',
  summarize: (i) => `consultar o processo ${formatarNumero(i.numero)}${i.acompanhar ? ' e acompanhar' : ''}`,
  timeoutMs: 90_000,
  async run(input) {
    const monitor = getProcessos();

    if (input.acompanhar) {
      const { dados } = await monitor.acompanhar(input.numero, input.rotulo);
      if (!dados) {
        return {
          ok: true,
          content: `Não achei ${formatarNumero(input.numero)} na base pública do CNJ agora, mas já estou acompanhando: se aparecer, eu aviso. Pode ser processo novo (a base atualiza com atraso) ou em segredo de justiça.`,
        };
      }
      return {
        ok: true,
        content: `${descreverProcesso(dados)}\n\nAcompanhando a partir de agora — aviso quando houver movimentação nova.`,
      };
    }

    const { DataJud } = await import('../integrations/justice/datajud.js');
    const dados = await new DataJud().consultar(input.numero);
    if (!dados) {
      return {
        ok: true,
        content: `Não encontrei ${formatarNumero(input.numero)} na base pública do CNJ. Pode ser processo recente (a base tem atraso de dias), em segredo de justiça, ou o número pode estar errado.`,
      };
    }
    return { ok: true, content: truncateForModel(descreverProcesso(dados, 30)) };
  },
};

const listarProcessos: ToolDefinition<Record<string, never>> = {
  name: 'listar_processos',
  description: 'Lista os processos que estão sendo acompanhados.',
  schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  summarize: () => 'listar os processos acompanhados',
  async run() {
    const cfg = loadConfig();
    const lista = getProcessos().listar(true);
    if (lista.length === 0) {
      return { ok: true, content: 'Nenhum processo sendo acompanhado ainda.' };
    }
    return {
      ok: true,
      content: lista
        .map((p) => {
          const mov = p.ultimaMovimentacao
            ? formatShort(new Date(p.ultimaMovimentacao), cfg.timezone, cfg.locale)
            : 'sem registro';
          return `${p.numero}${p.rotulo ? ` — ${p.rotulo}` : ''} (${p.tribunal}) · última movimentação: ${mov}`;
        })
        .join('\n'),
    };
  },
};

// ── e-mail ───────────────────────────────────────────────────────────────────

const lerEmails: ToolDefinition<{ quantidade: number; apenas_nao_lidos: boolean }> = {
  name: 'ler_emails',
  description: 'Lê as mensagens mais recentes da caixa de entrada do dono.',
  capability: 'email.ler',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['quantidade', 'apenas_nao_lidos'],
    properties: {
      quantidade: { type: 'integer', description: 'Quantas trazer. 0 = 10.' },
      apenas_nao_lidos: { type: 'boolean' },
    },
  },
  validate: z.object({
    quantidade: z.number().int().min(0).max(50),
    apenas_nao_lidos: z.boolean(),
  }),
  scopeFrom: () => loadConfig().email.user || 'caixa-de-entrada',
  summarize: (i) => `ler ${i.quantidade || 10} e-mails${i.apenas_nao_lidos ? ' não lidos' : ''}`,
  timeoutMs: 120_000,
  async run(input) {
    const mensagens = await getEmail().listar({
      limite: input.quantidade || 10,
      apenasNaoLidas: input.apenas_nao_lidos,
    });
    if (mensagens.length === 0) return { ok: true, content: 'Nenhuma mensagem encontrada.' };

    return {
      ok: true,
      content: truncateForModel(
        mensagens
          .map(
            (m) =>
              `De: ${m.de}\nAssunto: ${m.assunto}\nData: ${m.data.toLocaleString('pt-BR')}${m.temAnexo ? '\n[tem anexo]' : ''}\n\n${m.corpo.slice(0, 1500)}`,
          )
          .join('\n\n---\n\n'),
      ),
    };
  },
};

const enviarEmail: ToolDefinition<{ para: string; assunto: string; corpo: string }> = {
  name: 'enviar_email',
  description:
    'Envia um e-mail em nome do dono. A mensagem sai de verdade e não tem desfazer — mostre o texto a ele antes, a menos que ele já tenha aprovado o conteúdo exato.',
  capability: 'email.enviar',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['para', 'assunto', 'corpo'],
    properties: {
      para: { type: 'string' },
      assunto: { type: 'string' },
      corpo: { type: 'string' },
    },
  },
  validate: z.object({
    para: z.string().email(),
    assunto: z.string().min(1).max(300),
    corpo: z.string().min(1),
  }),
  scopeFrom: (i) => i.para.toLowerCase(),
  summarize: (i) => `ENVIAR E-MAIL para ${i.para}: "${i.assunto}"`,
  timeoutMs: 90_000,
  async run(input) {
    const id = await getEmail().enviar({
      para: input.para,
      assunto: input.assunto,
      corpo: input.corpo,
    });
    return { ok: true, content: `E-mail enviado para ${input.para}. (${id})` };
  },
};

export const agendaTools: Array<ToolDefinition<any>> = [
  criarLembrete,
  verAgenda,
  gerenciarTarefa,
  concluirLembrete,
];

export const justiceTools: Array<ToolDefinition<any>> = [consultarProcesso, listarProcessos];

export const emailTools: Array<ToolDefinition<any>> = [lerEmails, enviarEmail];
