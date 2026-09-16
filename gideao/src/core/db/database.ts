/**
 * Conexão com o SQLite e camada de conveniência cifrada.
 *
 * O arquivo do banco fica com permissão 0600 dentro de um diretório 0700.
 * As colunas `_enc` só são abertas em memória, sob demanda, e apenas enquanto
 * o chaveiro estiver destrancado.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { LATEST_VERSION, MIGRATIONS } from './schema.js';
import { Keyring } from '../crypto/keyring.js';
import { blindIndex, extractTerms, openJson, openText, sealJson, sealText } from '../crypto/cipher.js';
import { createLogger } from '../../util/logger.js';

const log = createLogger('db');

export class Store {
  readonly db: Db;

  constructor(
    private readonly file: string,
    private readonly keyring: Keyring,
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* sistemas de arquivo sem suporte a chmod (ex.: alguns volumes Windows) */
    }
    this.migrate();
  }

  private migrate(): void {
    const current = Number(this.db.pragma('user_version', { simple: true }));
    if (current >= LATEST_VERSION) return;
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      log.info(`aplicando migração ${m.version}: ${m.name}`);
      const run = this.db.transaction(() => {
        this.db.exec(m.sql);
        this.db.pragma(`user_version = ${m.version}`);
      });
      run();
    }
    log.info('banco pronto', { versao: LATEST_VERSION, arquivo: this.file });
  }

  // ── cifragem ───────────────────────────────────────────────────────────────

  /** Sela texto amarrado a um lugar específico do banco. */
  encText(text: string, aad?: string): Buffer {
    return sealText(this.keyring.key('data'), text, aad);
  }

  decText(blob: Buffer | Uint8Array | null | undefined, aad?: string): string {
    if (!blob) return '';
    return openText(this.keyring.key('data'), Buffer.from(blob), aad);
  }

  encJson(value: unknown, aad?: string): Buffer {
    return sealJson(this.keyring.key('data'), value, aad);
  }

  decJson<T>(blob: Buffer | Uint8Array | null | undefined, aad?: string, fallback?: T): T {
    if (!blob) return fallback as T;
    try {
      return openJson<T>(this.keyring.key('data'), Buffer.from(blob), aad);
    } catch (err) {
      if (fallback !== undefined) return fallback;
      throw err;
    }
  }

  /** Hash de índice cego para busca exata sem decifrar. */
  term(value: string): string {
    return blindIndex(this.keyring.key('index'), value);
  }

  /** Termos indexáveis de um texto livre, já convertidos em índice cego. */
  terms(text: string, max = 48): string[] {
    const key = this.keyring.key('index');
    return extractTerms(text, max).map((t) => blindIndex(key, t));
  }

  // ── utilidades ─────────────────────────────────────────────────────────────

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Chave-valor cifrado, para estado solto (cursores, tokens OAuth, flags). */
  getKv<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value_enc FROM kv WHERE key = ?').get(key) as
      | { value_enc: Buffer }
      | undefined;
    if (!row) return fallback;
    return this.decJson<T>(row.value_enc, `kv:${key}`, fallback);
  }

  setKv(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO kv (key, value_enc, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at`,
      )
      .run(key, this.encJson(value, `kv:${key}`), Date.now());
  }

  deleteKv(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  stats(): Record<string, number> {
    const tables = [
      'conversations',
      'messages',
      'memories',
      'entities',
      'capabilities',
      'audit_log',
      'vault_items',
      'reminders',
      'tasks',
      'processes',
      'process_movements',
      'monitors',
      'observations',
      'jobs',
    ];
    const out: Record<string, number> = {};
    for (const t of tables) {
      try {
        const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
        out[t] = row.n;
      } catch {
        out[t] = 0;
      }
    }
    try {
      out.arquivo_bytes = fs.statSync(this.file).size;
    } catch {
      out.arquivo_bytes = 0;
    }
    return out;
  }

  /** Compacta o banco e limpa registros efêmeros vencidos. */
  maintenance(): void {
    const now = Date.now();
    this.db.prepare('DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?').run(now);
    this.db.prepare("DELETE FROM jobs WHERE status = 'concluido' AND updated_at < ?").run(now - 7 * 86_400_000);
    this.db.exec('PRAGMA optimize');
    this.db.exec('VACUUM');
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* já fechado */
    }
  }
}

let singleton: Store | null = null;

export function openStore(file: string, keyring: Keyring): Store {
  if (!singleton) singleton = new Store(file, keyring);
  return singleton;
}

export function getStore(): Store {
  if (!singleton) throw new Error('banco ainda não aberto — chame openStore() no arranque');
  return singleton;
}

export function closeStore(): void {
  singleton?.close();
  singleton = null;
}
