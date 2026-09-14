/**
 * Trilha de auditoria.
 *
 * Toda ação que a Íris executa fica registrada: o que foi, com que autorização,
 * se deu certo, quanto demorou e os argumentos (cifrados e redigidos). Isso
 * existe por um motivo prático: um agente com acesso amplo à sua vida precisa
 * ser auditável, senão você fica na posição de confiar sem poder verificar.
 *
 * `iris auditoria --hoje` lê isto.
 */
import type { Store } from '../db/database.js';
import { id as newId } from '../../util/ids.js';
import { redact } from '../../util/redact.js';

export interface AuditEntry {
  id: string;
  at: number;
  actor: string;
  action: string;
  capability: string | null;
  scope: string | null;
  decision: string | null;
  ok: boolean;
  conversationId: string | null;
  durationMs: number | null;
  detail: Record<string, unknown>;
}

export interface AuditInput {
  actor?: string;
  action: string;
  capability?: string | null;
  scope?: string | null;
  decision?: string | null;
  ok?: boolean;
  conversationId?: string | null;
  durationMs?: number | null;
  detail?: unknown;
}

export class AuditLog {
  constructor(private readonly store: Store) {}

  record(input: AuditInput): string {
    const entryId = newId('aud');
    // Redige antes de cifrar: assim nem quem tem a chave encontra uma senha aqui.
    const detail = redact(input.detail ?? {});
    this.store.db
      .prepare(
        `INSERT INTO audit_log
           (id, at, actor, action, capability, scope, decision, ok, conversation_id, duration_ms, detail_enc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entryId,
        Date.now(),
        input.actor ?? 'iris',
        input.action,
        input.capability ?? null,
        input.scope ?? null,
        input.decision ?? null,
        input.ok === false ? 0 : 1,
        input.conversationId ?? null,
        input.durationMs ?? null,
        this.store.encJson(detail, `audit:detail:${entryId}`),
      );
    return entryId;
  }

  list(opts: { since?: number; until?: number; action?: string; limit?: number } = {}): AuditEntry[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (opts.since !== undefined) {
      clauses.push('at >= ?');
      args.push(opts.since);
    }
    if (opts.until !== undefined) {
      clauses.push('at <= ?');
      args.push(opts.until);
    }
    if (opts.action) {
      clauses.push('action LIKE ?');
      args.push(`${opts.action}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.store.db
      .prepare(`SELECT * FROM audit_log ${where} ORDER BY at DESC LIMIT ?`)
      .all(...args, opts.limit ?? 100) as Row[];
    return rows.map((r) => this.hydrate(r));
  }

  /** Resumo por ação de uma janela de tempo — alimenta o panorama do dia. */
  summary(since: number): Array<{ action: string; total: number; falhas: number }> {
    return this.store.db
      .prepare(
        `SELECT action, COUNT(*) AS total, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS falhas
         FROM audit_log WHERE at >= ? GROUP BY action ORDER BY total DESC`,
      )
      .all(since) as Array<{ action: string; total: number; falhas: number }>;
  }

  /** Remove registros antigos. Padrão: guarda um ano. */
  prune(olderThanDays = 365): number {
    const res = this.store.db
      .prepare('DELETE FROM audit_log WHERE at < ?')
      .run(Date.now() - olderThanDays * 86_400_000);
    return res.changes;
  }

  private hydrate(row: Row): AuditEntry {
    return {
      id: row.id,
      at: row.at,
      actor: row.actor,
      action: row.action,
      capability: row.capability,
      scope: row.scope,
      decision: row.decision,
      ok: row.ok === 1,
      conversationId: row.conversation_id,
      durationMs: row.duration_ms,
      detail: this.store.decJson<Record<string, unknown>>(row.detail_enc, `audit:detail:${row.id}`, {}),
    };
  }
}

interface Row {
  id: string;
  at: number;
  actor: string;
  action: string;
  capability: string | null;
  scope: string | null;
  decision: string | null;
  ok: number;
  conversation_id: string | null;
  duration_ms: number | null;
  detail_enc: Buffer | null;
}

let singleton: AuditLog | null = null;

export function initAudit(store: Store): AuditLog {
  singleton = new AuditLog(store);
  return singleton;
}

export function getAudit(): AuditLog {
  if (!singleton) throw new Error('auditoria não inicializada');
  return singleton;
}
