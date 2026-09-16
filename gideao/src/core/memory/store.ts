/**
 * Persistência das memórias: gravar, atualizar, deduplicar, esquecer.
 *
 * Toda memória guarda três representações do mesmo conteúdo:
 *   1. o texto cifrado  (a verdade)
 *   2. termos em índice cego (busca por palavra sem decifrar)
 *   3. o vetor de embedding  (busca por sentido)
 */
import type { Store } from '../db/database.js';
import { id as newId } from '../../util/ids.js';
import { createLogger } from '../../util/logger.js';
import {
  bufferToVector,
  cosine,
  vectorToBuffer,
  type EmbeddingProvider,
} from './embeddings.js';
import type { Memory, MemoryInput, MemoryKind } from './types.js';

const log = createLogger('memoria');

interface Row {
  id: string;
  kind: string;
  subject: string;
  content_enc: Buffer;
  importance: number;
  confidence: number;
  source: string;
  conversation_id: string | null;
  embedding: Buffer | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  use_count: number;
  pinned: number;
  expires_at: number | null;
  superseded_by: string | null;
}

export class MemoryStore {
  constructor(
    private readonly store: Store,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  private hydrate(row: Row): Memory {
    return {
      id: row.id,
      kind: row.kind as MemoryKind,
      subject: row.subject,
      content: this.store.decText(row.content_enc, `memories:content:${row.id}`),
      importance: row.importance,
      confidence: row.confidence,
      source: row.source,
      conversationId: row.conversation_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
      useCount: row.use_count,
      pinned: row.pinned === 1,
      expiresAt: row.expires_at,
      supersededBy: row.superseded_by,
    };
  }

  /**
   * Grava uma memória. Se já existir algo muito parecido (mesmo tipo e assunto,
   * ou conteúdo semanticamente quase idêntico), atualiza em vez de duplicar —
   * é isso que impede a memória de virar um depósito de repetições.
   */
  async remember(input: MemoryInput): Promise<Memory> {
    const now = Date.now();
    const subject = input.subject.trim().slice(0, 200) || input.content.slice(0, 80);
    const vector = (await this.embeddings.embed([`${subject}. ${input.content}`]))[0]!;

    const duplicate = input.skipDedup ? null : this.findDuplicate(input.kind, subject, vector);
    if (duplicate) {
      return this.reinforce(duplicate, input, vector);
    }

    const memoryId = newId('mem');
    const importance = clamp01(input.importance ?? 0.5);
    const confidence = clamp01(input.confidence ?? 0.8);
    const expiresAt = input.ttlDays ? now + input.ttlDays * 86_400_000 : null;

    this.store.transaction(() => {
      this.store.db
        .prepare(
          `INSERT INTO memories
             (id, kind, subject, content_enc, importance, confidence, source, conversation_id,
              embedding, created_at, updated_at, use_count, pinned, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          memoryId,
          input.kind,
          subject,
          this.store.encText(input.content, `memories:content:${memoryId}`),
          importance,
          confidence,
          input.source ?? 'conversa',
          input.conversationId ?? null,
          vectorToBuffer(vector),
          now,
          now,
          input.pinned ? 1 : 0,
          expiresAt,
        );
      this.indexTerms(memoryId, `${subject} ${input.content}`);
    });

    log.debug('memória nova', { id: memoryId, tipo: input.kind, assunto: subject });
    return this.get(memoryId)!;
  }

  /**
   * Reforço: a mesma informação apareceu de novo. Sobe a confiança e a
   * importância um pouco, atualiza o texto se o novo for mais rico, e renova o
   * carimbo — a memória "revisitada" vale mais que a memória parada.
   */
  private reinforce(existing: Memory, input: MemoryInput, vector: Float32Array): Memory {
    const now = Date.now();
    const richer = input.content.length > existing.content.length * 1.15;
    const content = richer ? input.content : existing.content;
    const importance = clamp01(Math.max(existing.importance, input.importance ?? 0) + 0.05);
    const confidence = clamp01(existing.confidence + 0.06);

    this.store.transaction(() => {
      this.store.db
        .prepare(
          `UPDATE memories SET content_enc = ?, importance = ?, confidence = ?, updated_at = ?,
                               embedding = ?, expires_at = ?
           WHERE id = ?`,
        )
        .run(
          this.store.encText(content, `memories:content:${existing.id}`),
          importance,
          confidence,
          now,
          vectorToBuffer(vector),
          input.ttlDays ? now + input.ttlDays * 86_400_000 : existing.expiresAt ?? null,
          existing.id,
        );
      if (richer) this.indexTerms(existing.id, `${existing.subject} ${content}`);
    });

    log.debug('memória reforçada', { id: existing.id, assunto: existing.subject });
    return this.get(existing.id)!;
  }

  /** Mesmo tipo + assunto normalizado igual, ou cosseno acima do limiar do provedor. */
  private findDuplicate(kind: MemoryKind, subject: string, vector: Float32Array): Memory | null {
    const bySubject = this.store.db
      .prepare(
        `SELECT * FROM memories
         WHERE kind = ? AND superseded_by IS NULL AND lower(subject) = lower(?) LIMIT 1`,
      )
      .get(kind, subject) as Row | undefined;
    if (bySubject) return this.hydrate(bySubject);

    const candidates = this.store.db
      .prepare(
        `SELECT * FROM memories
         WHERE kind = ? AND superseded_by IS NULL AND embedding IS NOT NULL
         ORDER BY updated_at DESC LIMIT 400`,
      )
      .all(kind) as Row[];

    for (const row of candidates) {
      const v = bufferToVector(row.embedding);
      if (!v || v.length !== vector.length) continue;
      if (cosine(v, vector) >= this.embeddings.nearDuplicate) return this.hydrate(row);
    }
    return null;
  }

  private indexTerms(memoryId: string, text: string): void {
    this.store.db.prepare('DELETE FROM memory_terms WHERE memory_id = ?').run(memoryId);
    const insert = this.store.db.prepare(
      'INSERT OR IGNORE INTO memory_terms (memory_id, term) VALUES (?, ?)',
    );
    for (const term of this.store.terms(text, 64)) insert.run(memoryId, term);
  }

  get(memoryId: string): Memory | null {
    const row = this.store.db.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId) as Row | undefined;
    return row ? this.hydrate(row) : null;
  }

  /** Marca uso — memória usada é memória que importa, e isso pesa na recuperação. */
  touch(ids: string[]): void {
    if (ids.length === 0) return;
    const now = Date.now();
    const stmt = this.store.db.prepare(
      'UPDATE memories SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?',
    );
    this.store.transaction(() => {
      for (const memoryId of ids) stmt.run(now, memoryId);
    });
  }

  /** Substitui uma memória por outra (correção). A antiga fica como histórico. */
  supersede(oldId: string, newMemoryId: string): void {
    this.store.db
      .prepare('UPDATE memories SET superseded_by = ?, updated_at = ? WHERE id = ?')
      .run(newMemoryId, Date.now(), oldId);
  }

  update(memoryId: string, patch: Partial<Pick<Memory, 'content' | 'importance' | 'confidence' | 'pinned' | 'subject'>>): Memory | null {
    const current = this.get(memoryId);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.store.transaction(() => {
      this.store.db
        .prepare(
          `UPDATE memories SET subject = ?, content_enc = ?, importance = ?, confidence = ?,
                               pinned = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          next.subject,
          this.store.encText(next.content, `memories:content:${memoryId}`),
          clamp01(next.importance),
          clamp01(next.confidence),
          next.pinned ? 1 : 0,
          Date.now(),
          memoryId,
        );
      this.indexTerms(memoryId, `${next.subject} ${next.content}`);
    });
    return this.get(memoryId);
  }

  forget(memoryId: string): boolean {
    const res = this.store.db.prepare('DELETE FROM memories WHERE id = ?').run(memoryId);
    if (res.changes > 0) log.info('memória apagada a pedido', { id: memoryId });
    return res.changes > 0;
  }

  /** Candidatos para a recuperação: união de acerto lexical, relevantes e recentes. */
  candidates(termHashes: string[], opts: { kinds?: MemoryKind[]; limit?: number } = {}): Row[] {
    const limit = opts.limit ?? 1500;
    const kindFilter = opts.kinds?.length
      ? `AND kind IN (${opts.kinds.map(() => '?').join(',')})`
      : '';
    const kindArgs = opts.kinds ?? [];

    const byTerm: Row[] = termHashes.length
      ? (this.store.db
          .prepare(
            `SELECT m.*, COUNT(t.term) AS hits FROM memories m
             JOIN memory_terms t ON t.memory_id = m.id
             WHERE t.term IN (${termHashes.map(() => '?').join(',')})
               AND m.superseded_by IS NULL ${kindFilter}
             GROUP BY m.id ORDER BY hits DESC, m.importance DESC LIMIT ?`,
          )
          .all(...termHashes, ...kindArgs, Math.ceil(limit * 0.6)) as Row[])
      : [];

    const byRelevance = this.store.db
      .prepare(
        `SELECT * FROM memories
         WHERE superseded_by IS NULL ${kindFilter}
         ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ?`,
      )
      .all(...kindArgs, Math.ceil(limit * 0.4)) as Row[];

    const merged = new Map<string, Row>();
    for (const r of [...byTerm, ...byRelevance]) merged.set(r.id, r);
    const now = Date.now();
    return [...merged.values()].filter((r) => !r.expires_at || r.expires_at > now);
  }

  toMemory(row: Row): Memory {
    return this.hydrate(row);
  }

  vectorOf(row: Row): Float32Array | null {
    return bufferToVector(row.embedding);
  }

  list(opts: { kind?: MemoryKind; limit?: number; offset?: number } = {}): Memory[] {
    const rows = opts.kind
      ? (this.store.db
          .prepare(
            `SELECT * FROM memories WHERE kind = ? AND superseded_by IS NULL
             ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ? OFFSET ?`,
          )
          .all(opts.kind, opts.limit ?? 50, opts.offset ?? 0) as Row[])
      : (this.store.db
          .prepare(
            `SELECT * FROM memories WHERE superseded_by IS NULL
             ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ? OFFSET ?`,
          )
          .all(opts.limit ?? 50, opts.offset ?? 0) as Row[]);
    return rows.map((r) => this.hydrate(r));
  }

  countByKind(): Record<string, number> {
    const rows = this.store.db
      .prepare('SELECT kind, COUNT(*) AS n FROM memories WHERE superseded_by IS NULL GROUP BY kind')
      .all() as Array<{ kind: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
  }

  /** Recalcula o embedding de memórias sem vetor (ex.: troca de provedor). */
  async reindex(batch = 200): Promise<number> {
    const rows = this.store.db
      .prepare('SELECT * FROM memories WHERE embedding IS NULL LIMIT ?')
      .all(batch) as Row[];
    if (rows.length === 0) return 0;
    const texts = rows.map((r) => `${r.subject}. ${this.store.decText(r.content_enc, `memories:content:${r.id}`)}`);
    const vectors = await this.embeddings.embed(texts);
    const stmt = this.store.db.prepare('UPDATE memories SET embedding = ? WHERE id = ?');
    this.store.transaction(() => {
      rows.forEach((r, i) => stmt.run(vectorToBuffer(vectors[i]!), r.id));
    });
    return rows.length;
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0.5));
}

export type { Row as MemoryRow };
