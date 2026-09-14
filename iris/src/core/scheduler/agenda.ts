/**
 * Agenda: lembretes e tarefas.
 *
 * O que diferencia um lembrete de uma tarefa aqui: lembrete tem hora e avisa
 * sozinho; tarefa tem prioridade e fica pendente até você concluir. Audiência é
 * lembrete; "protocolar a apelação" é tarefa com prazo.
 *
 * O aviso sai com antecedência (`lead_minutes`), porque ser avisado de uma
 * audiência no minuto em que ela começa não serve para nada.
 */
import type { Store } from '../db/database.js';
import { id as newId } from '../../util/ids.js';
import { createLogger } from '../../util/logger.js';
import { bus } from '../events/bus.js';
import { formatShort, relative, DAY } from '../../util/time.js';
import { loadConfig } from '../../config.js';

const log = createLogger('agenda');

export interface Lembrete {
  id: string;
  titulo: string;
  corpo: string;
  quando: number;
  antecedenciaMin: number;
  repeticao: string | null;
  tipo: 'audiencia' | 'prazo' | 'compromisso' | 'pessoal';
  status: 'pendente' | 'avisado' | 'concluido' | 'cancelado';
  criadoEm: number;
  avisadoEm: number | null;
  origem: string;
  relacionado: string | null;
}

export interface Tarefa {
  id: string;
  titulo: string;
  notas: string;
  status: 'aberta' | 'fazendo' | 'concluida' | 'cancelada';
  prioridade: number;
  prazo: number | null;
  projeto: string | null;
  criadaEm: number;
  concluidaEm: number | null;
}

export class Agenda {
  constructor(private readonly store: Store) {}

  // ── lembretes ──────────────────────────────────────────────────────────────

  criarLembrete(dados: {
    titulo: string;
    corpo?: string;
    quando: number;
    antecedenciaMin?: number;
    tipo?: Lembrete['tipo'];
    repeticao?: string | null;
    origem?: string;
    relacionado?: string | null;
  }): Lembrete {
    const lembreteId = newId('lem');
    const agora = Date.now();
    this.store.db
      .prepare(
        `INSERT INTO reminders
           (id, title_enc, body_enc, due_at, lead_minutes, rrule, kind, status, created_at, source, related_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pendente', ?, ?, ?)`,
      )
      .run(
        lembreteId,
        this.store.encText(dados.titulo, `reminders:title:${lembreteId}`),
        this.store.encText(dados.corpo ?? '', `reminders:body:${lembreteId}`),
        dados.quando,
        dados.antecedenciaMin ?? padraoAntecedencia(dados.tipo ?? 'compromisso'),
        dados.repeticao ?? null,
        dados.tipo ?? 'compromisso',
        agora,
        dados.origem ?? 'conversa',
        dados.relacionado ?? null,
      );
    log.info('lembrete criado', { id: lembreteId, tipo: dados.tipo, quando: new Date(dados.quando).toISOString() });
    return this.obterLembrete(lembreteId)!;
  }

  obterLembrete(lembreteId: string): Lembrete | null {
    const row = this.store.db.prepare('SELECT * FROM reminders WHERE id = ?').get(lembreteId) as
      | LembreteRow
      | undefined;
    return row ? this.hidratarLembrete(row) : null;
  }

  /** Lembretes que já deveriam ter sido avisados (respeitando a antecedência). */
  vencidos(agora = Date.now()): Lembrete[] {
    const rows = this.store.db
      .prepare(
        `SELECT * FROM reminders
         WHERE status = 'pendente' AND (due_at - lead_minutes * 60000) <= ?
         ORDER BY due_at ASC LIMIT 40`,
      )
      .all(agora) as LembreteRow[];
    return rows.map((r) => this.hidratarLembrete(r));
  }

  proximos(dias = 7, limite = 40): Lembrete[] {
    const agora = Date.now();
    const rows = this.store.db
      .prepare(
        `SELECT * FROM reminders
         WHERE status IN ('pendente', 'avisado') AND due_at BETWEEN ? AND ?
         ORDER BY due_at ASC LIMIT ?`,
      )
      .all(agora - 6 * 3_600_000, agora + dias * DAY, limite) as LembreteRow[];
    return rows.map((r) => this.hidratarLembrete(r));
  }

  marcarAvisado(lembreteId: string): void {
    this.store.db
      .prepare("UPDATE reminders SET status = 'avisado', notified_at = ? WHERE id = ?")
      .run(Date.now(), lembreteId);
  }

  concluirLembrete(lembreteId: string): boolean {
    const res = this.store.db
      .prepare("UPDATE reminders SET status = 'concluido', done_at = ? WHERE id = ?")
      .run(Date.now(), lembreteId);
    return res.changes > 0;
  }

  cancelarLembrete(lembreteId: string): boolean {
    const res = this.store.db
      .prepare("UPDATE reminders SET status = 'cancelado' WHERE id = ?")
      .run(lembreteId);
    return res.changes > 0;
  }

  /** Reagenda um lembrete repetitivo. Suporta diário, semanal, mensal e anual. */
  reagendar(lembrete: Lembrete): boolean {
    if (!lembrete.repeticao) return false;
    const proximo = proximaOcorrencia(lembrete.quando, lembrete.repeticao);
    if (!proximo) return false;
    this.store.db
      .prepare("UPDATE reminders SET due_at = ?, status = 'pendente', notified_at = NULL WHERE id = ?")
      .run(proximo, lembrete.id);
    return true;
  }

  // ── tarefas ────────────────────────────────────────────────────────────────

  criarTarefa(dados: {
    titulo: string;
    notas?: string;
    prioridade?: number;
    prazo?: number | null;
    projeto?: string | null;
  }): Tarefa {
    const tarefaId = newId('tar');
    const agora = Date.now();
    this.store.db
      .prepare(
        `INSERT INTO tasks (id, title_enc, notes_enc, status, priority, due_at, project, created_at, updated_at)
         VALUES (?, ?, ?, 'aberta', ?, ?, ?, ?, ?)`,
      )
      .run(
        tarefaId,
        this.store.encText(dados.titulo, `tasks:title:${tarefaId}`),
        this.store.encText(dados.notas ?? '', `tasks:notes:${tarefaId}`),
        dados.prioridade ?? 2,
        dados.prazo ?? null,
        dados.projeto ?? null,
        agora,
        agora,
      );
    return this.obterTarefa(tarefaId)!;
  }

  obterTarefa(tarefaId: string): Tarefa | null {
    const row = this.store.db.prepare('SELECT * FROM tasks WHERE id = ?').get(tarefaId) as
      | TarefaRow
      | undefined;
    return row ? this.hidratarTarefa(row) : null;
  }

  listarTarefas(status: Tarefa['status'] | 'todas' = 'aberta', limite = 50): Tarefa[] {
    const rows =
      status === 'todas'
        ? (this.store.db
            .prepare('SELECT * FROM tasks ORDER BY priority ASC, due_at ASC LIMIT ?')
            .all(limite) as TarefaRow[])
        : (this.store.db
            .prepare(
              `SELECT * FROM tasks WHERE status = ?
               ORDER BY priority ASC, COALESCE(due_at, 9e15) ASC LIMIT ?`,
            )
            .all(status, limite) as TarefaRow[]);
    return rows.map((r) => this.hidratarTarefa(r));
  }

  atualizarTarefa(tarefaId: string, patch: Partial<Pick<Tarefa, 'status' | 'prioridade' | 'prazo' | 'notas'>>): Tarefa | null {
    const atual = this.obterTarefa(tarefaId);
    if (!atual) return null;
    const proximo = { ...atual, ...patch };
    this.store.db
      .prepare(
        `UPDATE tasks SET status = ?, priority = ?, due_at = ?, notes_enc = ?, updated_at = ?,
                          done_at = CASE WHEN ? = 'concluida' THEN ? ELSE done_at END
         WHERE id = ?`,
      )
      .run(
        proximo.status,
        proximo.prioridade,
        proximo.prazo,
        this.store.encText(proximo.notas, `tasks:notes:${tarefaId}`),
        Date.now(),
        proximo.status,
        Date.now(),
        tarefaId,
      );
    return this.obterTarefa(tarefaId);
  }

  // ── visão para o contexto do agente ────────────────────────────────────────

  /**
   * Resumo curto que entra no prompt a cada turno. Fica enxuto de propósito:
   * é contexto, não relatório.
   */
  resumoParaContexto(): string {
    const cfg = loadConfig();
    const linhas: string[] = [];

    const lembretes = this.proximos(7, 12);
    if (lembretes.length > 0) {
      linhas.push(
        'Próximos compromissos:\n' +
          lembretes
            .map((l) => {
              const quando = formatShort(new Date(l.quando), cfg.timezone, cfg.locale);
              const quanto = relative(new Date(l.quando), new Date(), cfg.locale);
              return `- ${quando} (${quanto}) · ${l.tipo}: ${l.titulo}`;
            })
            .join('\n'),
      );
    }

    const tarefas = this.listarTarefas('aberta', 10);
    if (tarefas.length > 0) {
      linhas.push(
        'Tarefas abertas:\n' +
          tarefas
            .map((t) => {
              const prazo = t.prazo
                ? ` (prazo ${formatShort(new Date(t.prazo), cfg.timezone, cfg.locale)})`
                : '';
              return `- [${'!'.repeat(Math.max(1, 4 - t.prioridade))}] ${t.titulo}${prazo}`;
            })
            .join('\n'),
      );
    }

    return linhas.join('\n\n');
  }

  /** Dispara os avisos pendentes. Chamado pelo agendador a cada minuto. */
  despacharAvisos(): number {
    const cfg = loadConfig();
    const vencidos = this.vencidos();
    for (const lembrete of vencidos) {
      const quando = formatShort(new Date(lembrete.quando), cfg.timezone, cfg.locale);
      const quanto = relative(new Date(lembrete.quando), new Date(), cfg.locale);

      bus.emit('notify', {
        id: lembrete.id,
        title: tituloDoAviso(lembrete.tipo),
        body: `${lembrete.titulo}\n${quando} (${quanto})${lembrete.corpo ? `\n${lembrete.corpo}` : ''}`,
        kind: lembrete.tipo,
        urgency: lembrete.tipo === 'audiencia' || lembrete.tipo === 'prazo' ? 'high' : 'normal',
      });

      this.marcarAvisado(lembrete.id);
      if (lembrete.repeticao) this.reagendar(lembrete);
    }
    if (vencidos.length > 0) log.info('avisos disparados', { total: vencidos.length });
    return vencidos.length;
  }

  // ── hidratação ─────────────────────────────────────────────────────────────

  private hidratarLembrete(row: LembreteRow): Lembrete {
    return {
      id: row.id,
      titulo: this.store.decText(row.title_enc, `reminders:title:${row.id}`),
      corpo: row.body_enc ? this.store.decText(row.body_enc, `reminders:body:${row.id}`) : '',
      quando: row.due_at,
      antecedenciaMin: row.lead_minutes,
      repeticao: row.rrule,
      tipo: row.kind as Lembrete['tipo'],
      status: row.status as Lembrete['status'],
      criadoEm: row.created_at,
      avisadoEm: row.notified_at,
      origem: row.source,
      relacionado: row.related_id,
    };
  }

  private hidratarTarefa(row: TarefaRow): Tarefa {
    return {
      id: row.id,
      titulo: this.store.decText(row.title_enc, `tasks:title:${row.id}`),
      notas: row.notes_enc ? this.store.decText(row.notes_enc, `tasks:notes:${row.id}`) : '',
      status: row.status as Tarefa['status'],
      prioridade: row.priority,
      prazo: row.due_at,
      projeto: row.project,
      criadaEm: row.created_at,
      concluidaEm: row.done_at,
    };
  }
}

/** Audiência avisa com um dia; prazo, com dois; compromisso comum, com uma hora. */
function padraoAntecedencia(tipo: Lembrete['tipo']): number {
  switch (tipo) {
    case 'audiencia':
      return 24 * 60;
    case 'prazo':
      return 48 * 60;
    default:
      return 60;
  }
}

function tituloDoAviso(tipo: Lembrete['tipo']): string {
  switch (tipo) {
    case 'audiencia':
      return 'Audiência chegando';
    case 'prazo':
      return 'Prazo se aproximando';
    case 'pessoal':
      return 'Lembrete';
    default:
      return 'Compromisso';
  }
}

/** Repetições simples, em português: diario, semanal, quinzenal, mensal, anual. */
export function proximaOcorrencia(atual: number, repeticao: string): number | null {
  const d = new Date(atual);
  switch (repeticao.toLowerCase()) {
    case 'diario':
    case 'diária':
    case 'diaria':
      return atual + DAY;
    case 'semanal':
      return atual + 7 * DAY;
    case 'quinzenal':
      return atual + 14 * DAY;
    case 'mensal': {
      const mes = new Date(d);
      mes.setMonth(mes.getMonth() + 1);
      return mes.getTime();
    }
    case 'anual': {
      const ano = new Date(d);
      ano.setFullYear(ano.getFullYear() + 1);
      return ano.getTime();
    }
    case 'util':
    case 'dia util':
    case 'dia útil': {
      // Pula sábado e domingo — útil para rotina de escritório.
      const prox = new Date(atual + DAY);
      while (prox.getDay() === 0 || prox.getDay() === 6) prox.setDate(prox.getDate() + 1);
      return prox.getTime();
    }
    default:
      return null;
  }
}

interface LembreteRow {
  id: string;
  title_enc: Buffer;
  body_enc: Buffer | null;
  due_at: number;
  lead_minutes: number;
  rrule: string | null;
  kind: string;
  status: string;
  created_at: number;
  notified_at: number | null;
  done_at: number | null;
  source: string;
  related_id: string | null;
}

interface TarefaRow {
  id: string;
  title_enc: Buffer;
  notes_enc: Buffer | null;
  status: string;
  priority: number;
  due_at: number | null;
  project: string | null;
  created_at: number;
  updated_at: number;
  done_at: number | null;
}

let singleton: Agenda | null = null;

export function initAgenda(store: Store): Agenda {
  singleton = new Agenda(store);
  return singleton;
}

export function getAgenda(): Agenda {
  if (!singleton) throw new Error('agenda não inicializada');
  return singleton;
}
