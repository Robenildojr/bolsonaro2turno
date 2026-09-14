/**
 * Broker de permissões — o portão entre o que o modelo quer fazer e o que ele
 * pode fazer.
 *
 * A regra que você pediu está implementada literalmente: **autorizou uma vez,
 * não pergunta mais**. Quando você responde "sempre", a autorização vira uma
 * linha no banco e todas as chamadas futuras que caírem naquele escopo passam
 * direto, sem pergunta, sem atrito, para sempre — até você revogar.
 *
 * Duas exceções, e só duas:
 *
 *  1. Ação irreversível (apagar em massa, formatar disco, mandar e-mail para
 *     terceiro) continua confirmando, mesmo autorizada. Isso é ligável e
 *     desligável em `permissions.confirmCritical`.
 *  2. Negação gravada ("nunca") também é para sempre, e nem chega a perguntar.
 *
 * Se ninguém responder dentro do prazo, o pedido é **negado**. Silêncio nunca
 * vira consentimento.
 */
import { bus } from '../events/bus.js';
import type { Store } from '../db/database.js';
import type { AuditLog } from './audit.js';
import { id as newId } from '../../util/ids.js';
import { createLogger } from '../../util/logger.js';
import { loadConfig, type Config } from '../../config.js';
import {
  capabilitySpec,
  isDestructive,
  scopeMatches,
  type Decision,
  type Risk,
} from './capabilities.js';

const log = createLogger('permissoes');

export interface PermissionRequest {
  capability: string;
  /** O alvo concreto: caminho, domínio, comando, contato. */
  scope: string;
  /** Por que a Íris quer fazer isso — aparece no pedido. */
  reason: string;
  /**
   * A ação por extenso (a linha de comando inteira, o caminho completo).
   *
   * Separado de `scope` porque o escopo é deliberadamente estreito — `rm`, e
   * não `rm -rf /home/eu` — para que uma autorização não fique mais larga do
   * que aparenta. Mas a avaliação de irreversibilidade precisa do oposto: o
   * texto completo. Quem só olhasse o escopo veria a palavra "rm" e deixaria
   * passar.
   */
  actionText?: string;
  /** Contexto extra mostrado ao dono (argumentos resumidos). */
  details?: Record<string, unknown>;
  conversationId?: string | null;
}

export interface PermissionOutcome {
  allowed: boolean;
  decision: Decision | 'auto';
  /** Autorização gravada que cobriu o pedido, quando houve. */
  grantId?: string;
  reason?: string;
}

export interface Grant {
  id: string;
  capability: string;
  scope: string;
  decision: Decision;
  risk: Risk;
  grantedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  useCount: number;
  lastUsedAt: number | null;
  note: string;
}

interface Pending {
  id: string;
  request: PermissionRequest;
  risk: Risk;
  resolve: (decision: Decision) => void;
  timer: NodeJS.Timeout;
  createdAt: number;
}

export class PermissionBroker {
  private pending = new Map<string, Pending>();
  /** Quando não há canal escutando, cai para este modo (usado na CLI). */
  private fallbackPrompt: ((req: PermissionRequest, risk: Risk) => Promise<Decision>) | null = null;

  constructor(
    private readonly store: Store,
    private readonly audit: AuditLog,
    private cfg: Config = loadConfig(),
  ) {}

  setFallbackPrompt(fn: ((req: PermissionRequest, risk: Risk) => Promise<Decision>) | null): void {
    this.fallbackPrompt = fn;
  }

  refreshConfig(cfg: Config = loadConfig({ reload: true })): void {
    this.cfg = cfg;
  }

  /** Quantos pedidos estão esperando resposta agora. */
  get pendingCount(): number {
    return this.pending.size;
  }

  // ── decisão ────────────────────────────────────────────────────────────────

  async request(req: PermissionRequest): Promise<PermissionOutcome> {
    const spec = capabilitySpec(req.capability);
    const destructive = isDestructive(
      req.capability,
      req.scope,
      `${req.actionText ?? ''} ${JSON.stringify(req.details ?? {})}`,
    );
    const risk: Risk = destructive ? 'critico' : spec.risk;

    const grant = this.findGrant(req.capability, req.scope);

    if (grant?.decision === 'negado_sempre') {
      this.audit.record({
        action: 'permissao.negada',
        capability: req.capability,
        scope: req.scope,
        decision: 'negado_sempre',
        ok: false,
        conversationId: req.conversationId ?? null,
        detail: { motivo: 'negação gravada pelo dono' },
      });
      return { allowed: false, decision: 'negado_sempre', reason: 'você negou isto permanentemente' };
    }

    // Autorização gravada cobre o pedido: passa direto.
    if (grant) {
      const needsConfirm = risk === 'critico' && this.cfg.permissions.confirmCritical;
      if (!needsConfirm) {
        this.markUsed(grant.id);
        return { allowed: true, decision: 'auto', grantId: grant.id };
      }
      log.info('ação irreversível: confirmando mesmo com autorização gravada', {
        capacidade: req.capability,
        escopo: req.scope,
      });
    }

    const decision = await this.ask(req, risk);
    const allowed = decision === 'uma_vez' || decision === 'sempre' || decision === 'categoria';

    if (decision === 'sempre' || decision === 'categoria' || decision === 'negado_sempre') {
      if (this.cfg.permissions.rememberGrants || decision === 'negado_sempre') {
        this.persist(req, decision, risk);
      }
    }

    this.audit.record({
      action: allowed ? 'permissao.concedida' : 'permissao.negada',
      capability: req.capability,
      scope: req.scope,
      decision,
      ok: allowed,
      conversationId: req.conversationId ?? null,
      detail: { motivo: req.reason, risco: risk, detalhes: req.details ?? {} },
    });

    return {
      allowed,
      decision,
      ...(allowed ? {} : { reason: 'você não autorizou esta ação' }),
    };
  }

  /** Pergunta ao dono pelo canal ativo e espera. Silêncio = negado. */
  private ask(req: PermissionRequest, risk: Risk): Promise<Decision> {
    if (this.fallbackPrompt) return this.fallbackPrompt(req, risk);

    const requestId = newId('perm');
    const timeoutMs = this.cfg.permissions.requestTimeoutSec * 1000;

    return new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        log.warn('pedido de autorização expirou sem resposta — negando', {
          capacidade: req.capability,
          escopo: req.scope,
        });
        bus.emit('permission:resolved', { id: requestId, decision: 'negado' });
        resolve('negado');
      }, timeoutMs);
      // Sem unref de propósito: enquanto a Íris espera a sua decisão, o
      // processo precisa continuar vivo. Encerrar com um pedido pendente
      // significaria agir (ou desistir) sem resposta, e nenhum dos dois serve.

      this.pending.set(requestId, {
        id: requestId,
        request: req,
        risk,
        resolve,
        timer,
        createdAt: Date.now(),
      });

      const spec = capabilitySpec(req.capability);
      bus.emit('permission:request', {
        id: requestId,
        capability: req.capability,
        scope: req.scope,
        risk,
        reason: req.reason,
        details: {
          rotulo: spec.label,
          explicacao: spec.explain,
          tipo_escopo: spec.scopeKind,
          ...(req.details ?? {}),
        },
        expiresAt: Date.now() + timeoutMs,
      });

      log.info('aguardando autorização do dono', {
        id: requestId,
        capacidade: req.capability,
        escopo: req.scope,
        risco: risk,
      });
    });
  }

  /** Chamado pelo canal quando o dono decide. */
  resolve(requestId: string, decision: Decision): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    bus.emit('permission:resolved', { id: requestId, decision });
    p.resolve(decision);
    return true;
  }

  listPending(): Array<{ id: string; capability: string; scope: string; risk: Risk; reason: string; createdAt: number }> {
    return [...this.pending.values()].map((p) => ({
      id: p.id,
      capability: p.request.capability,
      scope: p.request.scope,
      risk: p.risk,
      reason: p.request.reason,
      createdAt: p.createdAt,
    }));
  }

  // ── autorizações gravadas ──────────────────────────────────────────────────

  private findGrant(capability: string, scope: string): Grant | null {
    const rows = this.store.db
      .prepare(
        `SELECT * FROM capabilities
         WHERE capability = ? AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .all(capability, Date.now()) as Row[];

    // Negação gravada tem precedência sobre qualquer permissão.
    const denial = rows.find((r) => r.decision === 'negado_sempre' && scopeMatches(r.scope, scope));
    if (denial) return this.hydrate(denial);

    const match = rows.find(
      (r) => (r.decision === 'sempre' || r.decision === 'categoria') && scopeMatches(r.scope, scope),
    );
    return match ? this.hydrate(match) : null;
  }

  private persist(req: PermissionRequest, decision: Decision, risk: Risk): string {
    const scope = decision === 'categoria' ? '*' : req.scope;
    const grantId = newId('cap');
    const now = Date.now();
    this.store.db
      .prepare(
        `INSERT INTO capabilities (id, capability, scope, decision, risk, granted_at, note_enc)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(capability, scope) DO UPDATE SET
           decision = excluded.decision,
           risk = excluded.risk,
           granted_at = excluded.granted_at,
           revoked_at = NULL,
           note_enc = excluded.note_enc`,
      )
      .run(
        grantId,
        req.capability,
        scope,
        decision,
        risk,
        now,
        this.store.encText(req.reason.slice(0, 500), noteAad(req.capability, scope)),
      );

    log.info(decision === 'negado_sempre' ? 'negação gravada' : 'autorização gravada — não pergunto mais', {
      capacidade: req.capability,
      escopo: scope,
    });
    return grantId;
  }

  /** Concede sem perguntar — usado pelo assistente de instalação e pela CLI. */
  grant(capability: string, scope: string, note = 'concedido pelo dono'): string {
    return this.persist({ capability, scope, reason: note }, scope === '*' ? 'categoria' : 'sempre', capabilitySpec(capability).risk);
  }

  deny(capability: string, scope: string, note = 'negado pelo dono'): string {
    return this.persist({ capability, scope, reason: note }, 'negado_sempre', capabilitySpec(capability).risk);
  }

  private markUsed(grantId: string): void {
    this.store.db
      .prepare('UPDATE capabilities SET use_count = use_count + 1, last_used_at = ? WHERE id = ?')
      .run(Date.now(), grantId);
  }

  list(includeRevoked = false): Grant[] {
    const rows = this.store.db
      .prepare(
        `SELECT * FROM capabilities ${includeRevoked ? '' : 'WHERE revoked_at IS NULL'}
         ORDER BY capability, scope`,
      )
      .all() as Row[];
    return rows.map((r) => this.hydrate(r));
  }

  revoke(grantId: string): boolean {
    const res = this.store.db
      .prepare('UPDATE capabilities SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(Date.now(), grantId);
    if (res.changes > 0) {
      this.audit.record({ action: 'permissao.revogada', detail: { id: grantId } });
      log.info('autorização revogada', { id: grantId });
    }
    return res.changes > 0;
  }

  revokeByCapability(capability: string): number {
    const res = this.store.db
      .prepare('UPDATE capabilities SET revoked_at = ? WHERE capability = ? AND revoked_at IS NULL')
      .run(Date.now(), capability);
    if (res.changes > 0) this.audit.record({ action: 'permissao.revogada', detail: { capability } });
    return res.changes;
  }

  /** Botão de pânico: derruba tudo e nega os pedidos que estavam esperando. */
  revokeAll(): number {
    const res = this.store.db
      .prepare('UPDATE capabilities SET revoked_at = ? WHERE revoked_at IS NULL')
      .run(Date.now());
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve('negado');
    }
    this.pending.clear();
    this.audit.record({ action: 'permissao.revogada.tudo', detail: { total: res.changes } });
    log.warn('todas as autorizações foram revogadas', { total: res.changes });
    return res.changes;
  }

  /**
   * A nota é amarrada ao par (capacidade, escopo), não ao id da linha: o
   * ON CONFLICT do upsert mantém o id original, então um AAD baseado no id
   * novo deixaria a nota indecifrável depois de reconceder o mesmo escopo.
   */
  private readNote(row: Row): string {
    try {
      return this.store.decText(row.note_enc!, noteAad(row.capability, row.scope));
    } catch {
      return '';
    }
  }

  /** Encerra o broker: nega e limpa tudo que estava esperando resposta. */
  shutdown(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve('negado');
    }
    this.pending.clear();
  }

  private hydrate(row: Row): Grant {
    return {
      id: row.id,
      capability: row.capability,
      scope: row.scope,
      decision: row.decision as Decision,
      risk: row.risk as Risk,
      grantedAt: row.granted_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      useCount: row.use_count,
      lastUsedAt: row.last_used_at,
      note: row.note_enc ? this.readNote(row) : '',
    };
  }
}

function noteAad(capability: string, scope: string): string {
  return `capabilities:note:${capability}:${scope}`;
}

interface Row {
  id: string;
  capability: string;
  scope: string;
  decision: string;
  risk: string;
  granted_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  use_count: number;
  last_used_at: number | null;
  note_enc: Buffer | null;
}

let singleton: PermissionBroker | null = null;

export function initBroker(store: Store, audit: AuditLog, cfg?: Config): PermissionBroker {
  singleton = new PermissionBroker(store, audit, cfg);
  return singleton;
}

export function getBroker(): PermissionBroker {
  if (!singleton) throw new Error('broker de permissões não inicializado');
  return singleton;
}
