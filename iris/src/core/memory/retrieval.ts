/**
 * Recuperação híbrida.
 *
 * Nenhum sinal sozinho resolve:
 *  - só semântico erra em nome próprio e número de processo;
 *  - só palavra-chave erra em sinônimo e paráfrase;
 *  - sem recência, ela responde com informação vencida;
 *  - sem importância, afoga o relevante em trivialidade.
 *
 * Então combinamos os quatro e, no fim, aplicamos MMR para não devolver cinco
 * versões da mesma frase ocupando o contexto.
 */
import type { Store } from '../db/database.js';
import { cosine, type EmbeddingProvider } from './embeddings.js';
import type { MemoryStore } from './store.js';
import { RECENCY_HALFLIFE_MS, type MemoryKind, type ScoredMemory } from './types.js';
import { extractTerms } from '../crypto/cipher.js';

export interface RetrievalOptions {
  limit?: number;
  kinds?: MemoryKind[];
  /** 0 = sem diversidade (só relevância), 1 = máxima diversidade. */
  diversity?: number;
  minScore?: number;
}

const WEIGHTS = {
  semantic: 0.45,
  lexical: 0.24,
  recency: 0.13,
  importance: 0.13,
  usage: 0.05,
};

export class Retriever {
  constructor(
    private readonly store: Store,
    private readonly memories: MemoryStore,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  async search(query: string, opts: RetrievalOptions = {}): Promise<ScoredMemory[]> {
    const limit = opts.limit ?? 20;
    const diversity = opts.diversity ?? 0.3;
    const minScore = opts.minScore ?? 0.12;

    const queryTerms = extractTerms(query, 32);
    const termHashes = queryTerms.map((t) => this.store.term(t));
    const rows = this.memories.candidates(termHashes, { kinds: opts.kinds ?? undefined });
    if (rows.length === 0) return [];

    const queryVector = (await this.embeddings.embed([query]))[0]!;
    const termSet = new Set(termHashes);
    const now = Date.now();

    // Quantos termos da pergunta cada memória contém — uma consulta só.
    const lexicalHits = this.lexicalHits(rows.map((r) => r.id), termSet);

    const scored: Array<ScoredMemory & { vector: Float32Array | null }> = [];
    for (const row of rows) {
      const vector = this.memories.vectorOf(row);
      const semantic = vector && vector.length === queryVector.length ? Math.max(0, cosine(vector, queryVector)) : 0;
      const lexical = termSet.size === 0 ? 0 : (lexicalHits.get(row.id) ?? 0) / termSet.size;
      const age = now - (row.updated_at || row.created_at);
      const recency = Math.pow(0.5, age / RECENCY_HALFLIFE_MS);
      const usage = Math.min(1, Math.log1p(row.use_count) / Math.log(20));

      let score =
        WEIGHTS.semantic * semantic +
        WEIGHTS.lexical * lexical +
        WEIGHTS.recency * recency +
        WEIGHTS.importance * row.importance +
        WEIGHTS.usage * usage;

      // Fixada pelo dono: sempre relevante.
      if (row.pinned === 1) score += 0.35;
      // Confiança baixa desconta — o que ela não tem certeza não domina o contexto.
      score *= 0.6 + 0.4 * row.confidence;

      if (score < minScore) continue;

      const memory = this.memories.toMemory(row);
      scored.push({
        ...memory,
        score,
        why: { semantic, lexical, recency, importance: row.importance },
        vector,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    const selected = mmr(scored, limit, diversity);
    this.memories.touch(selected.map((m) => m.id));
    return selected.map(({ vector: _vector, ...rest }) => rest);
  }

  private lexicalHits(ids: string[], termSet: Set<string>): Map<string, number> {
    const hits = new Map<string, number>();
    if (termSet.size === 0 || ids.length === 0) return hits;
    const terms = [...termSet];

    // Divide em lotes: o SQLite tem limite de variáveis por consulta.
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const rows = this.store.db
        .prepare(
          `SELECT memory_id, COUNT(*) AS n FROM memory_terms
           WHERE memory_id IN (${chunk.map(() => '?').join(',')})
             AND term IN (${terms.map(() => '?').join(',')})
           GROUP BY memory_id`,
        )
        .all(...chunk, ...terms) as Array<{ memory_id: string; n: number }>;
      for (const r of rows) hits.set(r.memory_id, r.n);
    }
    return hits;
  }
}

/**
 * Maximal Marginal Relevance: escolhe o próximo item que maximiza
 * `(1-λ)·relevância − λ·maior semelhança com o que já foi escolhido`.
 */
function mmr<T extends { score: number; vector: Float32Array | null }>(
  items: T[],
  limit: number,
  lambda: number,
): T[] {
  if (lambda <= 0 || items.length <= limit) return items.slice(0, limit);

  const selected: T[] = [];
  const pool = [...items];

  while (selected.length < limit && pool.length > 0) {
    let bestIndex = 0;
    let bestValue = -Infinity;

    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[i]!;
      let maxSim = 0;
      if (candidate.vector) {
        for (const chosen of selected) {
          if (!chosen.vector || chosen.vector.length !== candidate.vector.length) continue;
          maxSim = Math.max(maxSim, cosine(candidate.vector, chosen.vector));
        }
      }
      const value = (1 - lambda) * candidate.score - lambda * maxSim;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }
    selected.push(pool.splice(bestIndex, 1)[0]!);
  }
  return selected;
}
