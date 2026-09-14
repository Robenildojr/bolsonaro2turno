/**
 * Cofre de credenciais.
 *
 * Ideia central: o modelo **nunca vê o segredo**. Ele trabalha com referências
 * no formato `{{cofre:pje.senha}}`, e a substituição pelo valor real acontece
 * no último instante, dentro do executor da ferramenta (o campo do formulário,
 * o cabeçalho HTTP, o login IMAP). Assim a senha não entra na transcrição, não
 * vai para a API, não sobra no histórico e não aparece na auditoria.
 *
 * É exatamente o comportamento que você pediu: você informa a credencial uma
 * vez, ela fica guardada, e a Íris usa sozinha nas próximas vezes — sem
 * precisar perguntar de novo e sem espalhar o segredo por aí.
 */
import { seal, open } from '../crypto/cipher.js';
import type { Keyring } from '../crypto/keyring.js';
import type { Store } from '../db/database.js';
import { createLogger } from '../../util/logger.js';

const log = createLogger('cofre');

/** `{{cofre:nome}}` ou `{{vault:nome}}` */
export const SECRET_REF = /\{\{\s*(?:cofre|vault)\s*:\s*([a-zA-Z0-9._\-]{1,64})\s*\}\}/g;

export interface VaultMeta {
  /** Para que serve, em linguagem natural — isso o modelo pode ver. */
  description?: string;
  /** Site/serviço a que pertence (ex.: pje.trt8.jus.br). */
  service?: string;
  /** Login associado, se fizer sentido mostrar. */
  username?: string;
  /** Rótulos livres para a Íris achar a credencial certa. */
  tags?: string[];
}

export interface VaultEntry {
  name: string;
  kind: string;
  meta: VaultMeta;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  useCount: number;
}

export class Vault {
  constructor(
    private readonly store: Store,
    private readonly keyring: Keyring,
  ) {}

  private key(): Buffer {
    return this.keyring.key('vault');
  }

  set(name: string, value: string, opts: { kind?: string; meta?: VaultMeta } = {}): void {
    const clean = normalizeName(name);
    const now = Date.now();
    const valueEnc = seal(this.key(), value, `cofre:${clean}`);
    const metaEnc = seal(this.key(), JSON.stringify(opts.meta ?? {}), `cofre-meta:${clean}`);
    this.store.db
      .prepare(
        `INSERT INTO vault_items (name, kind, value_enc, meta_enc, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           kind = excluded.kind,
           value_enc = excluded.value_enc,
           meta_enc = excluded.meta_enc,
           updated_at = excluded.updated_at`,
      )
      .run(clean, opts.kind ?? 'senha', valueEnc, metaEnc, now, now);
    log.info('credencial guardada', { nome: clean, tipo: opts.kind ?? 'senha' });
  }

  /**
   * Devolve o valor em claro. Só o executor de ferramentas deve chamar isto —
   * nunca envie o retorno de volta para o modelo.
   */
  get(name: string): string | null {
    const clean = normalizeName(name);
    const row = this.store.db.prepare('SELECT value_enc FROM vault_items WHERE name = ?').get(clean) as
      | { value_enc: Buffer }
      | undefined;
    if (!row) return null;
    this.store.db
      .prepare('UPDATE vault_items SET last_used_at = ?, use_count = use_count + 1 WHERE name = ?')
      .run(Date.now(), clean);
    return open(this.key(), Buffer.from(row.value_enc), `cofre:${clean}`).toString('utf8');
  }

  has(name: string): boolean {
    const clean = normalizeName(name);
    const row = this.store.db.prepare('SELECT 1 AS x FROM vault_items WHERE name = ?').get(clean);
    return Boolean(row);
  }

  /** Lista sem nenhum valor — é isto que o modelo pode enxergar. */
  list(): VaultEntry[] {
    const rows = this.store.db
      .prepare(
        `SELECT name, kind, meta_enc, created_at, updated_at, last_used_at, use_count
         FROM vault_items ORDER BY name`,
      )
      .all() as Array<{
      name: string;
      kind: string;
      meta_enc: Buffer | null;
      created_at: number;
      updated_at: number;
      last_used_at: number | null;
      use_count: number;
    }>;

    return rows.map((r) => ({
      name: r.name,
      kind: r.kind,
      meta: this.readMeta(r.name, r.meta_enc),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastUsedAt: r.last_used_at,
      useCount: r.use_count,
    }));
  }

  delete(name: string): boolean {
    const clean = normalizeName(name);
    const res = this.store.db.prepare('DELETE FROM vault_items WHERE name = ?').run(clean);
    if (res.changes > 0) log.info('credencial removida', { nome: clean });
    return res.changes > 0;
  }

  private readMeta(name: string, blob: Buffer | null): VaultMeta {
    if (!blob) return {};
    try {
      return JSON.parse(open(this.key(), Buffer.from(blob), `cofre-meta:${name}`).toString('utf8')) as VaultMeta;
    } catch {
      return {};
    }
  }

  /**
   * Troca `{{cofre:nome}}` pelos valores reais, recursivamente, em qualquer
   * estrutura de argumentos de ferramenta. Referência inexistente vira erro —
   * é melhor a ferramenta falhar alto do que enviar um placeholder literal
   * para um formulário de login.
   */
  resolveRefs<T>(input: T): { value: T; used: string[] } {
    const used = new Set<string>();

    const walk = (v: unknown, depth: number): unknown => {
      if (depth > 12) return v;
      if (typeof v === 'string') {
        return v.replace(SECRET_REF, (_m, name: string) => {
          const clean = normalizeName(name);
          const secret = this.get(clean);
          if (secret === null) {
            throw new Error(
              `credencial "${clean}" não existe no cofre — guarde com: iris cofre set ${clean}`,
            );
          }
          used.add(clean);
          return secret;
        });
      }
      if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
      if (v && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val, depth + 1);
        return out;
      }
      return v;
    };

    const value = walk(input, 0) as T;
    if (used.size > 0) log.debug('credenciais aplicadas', { nomes: [...used] });
    return { value, used: [...used] };
  }

  /** Detecta referências sem resolvê-las (para o broker de permissões avisar). */
  static refsIn(input: unknown): string[] {
    const found = new Set<string>();
    const walk = (v: unknown, depth: number): void => {
      if (depth > 12) return;
      if (typeof v === 'string') {
        for (const m of v.matchAll(SECRET_REF)) found.add(normalizeName(m[1]!));
      } else if (Array.isArray(v)) {
        for (const x of v) walk(x, depth + 1);
      } else if (v && typeof v === 'object') {
        for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
      }
    };
    walk(input, 0);
    return [...found];
  }
}

function normalizeName(name: string): string {
  const clean = name.trim().toLowerCase().replace(/[^a-z0-9._\-]/g, '');
  if (!clean) throw new Error('nome de credencial inválido');
  return clean.slice(0, 64);
}

let singleton: Vault | null = null;

export function initVault(store: Store, keyring: Keyring): Vault {
  singleton = new Vault(store, keyring);
  return singleton;
}

export function getVault(): Vault {
  if (!singleton) throw new Error('cofre não inicializado');
  return singleton;
}
