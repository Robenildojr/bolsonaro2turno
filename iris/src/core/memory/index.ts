/**
 * Fachada da memória — é por aqui que o resto do sistema fala com ela.
 *
 * Ciclo completo:
 *   capturar (conversations) → refletir (reflection) → consolidar (consolidation)
 *                                      ↕
 *                            recuperar (retrieval) ← usado a cada turno
 */
import { loadConfig, type Config } from '../../config.js';
import type { Store } from '../db/database.js';
import { createLogger, describeError } from '../../util/logger.js';
import { ConversationStore, type Conversation, type StoredMessage } from './conversations.js';
import { createEmbeddingProvider, type EmbeddingProvider } from './embeddings.js';
import { Retriever, type RetrievalOptions } from './retrieval.js';
import { MemoryStore } from './store.js';
import { Reflector } from './reflection.js';
import { Consolidator, type ConsolidationReport } from './consolidation.js';
import type { Memory, MemoryInput, MemoryKind, ScoredMemory } from './types.js';

const log = createLogger('memoria');

export class MemoryEngine {
  readonly conversations: ConversationStore;
  readonly memories: MemoryStore;
  readonly retriever: Retriever;
  readonly embeddings: EmbeddingProvider;
  private readonly reflector: Reflector;
  private readonly consolidator: Consolidator;
  private turnsSinceReflection = new Map<string, number>();
  private reflecting = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly cfg: Config = loadConfig(),
  ) {
    this.embeddings = createEmbeddingProvider(cfg.memory.embeddings, cfg.memory.embeddingModel);
    this.conversations = new ConversationStore(store);
    this.memories = new MemoryStore(store, this.embeddings);
    this.retriever = new Retriever(store, this.memories, this.embeddings);
    this.reflector = new Reflector(this.memories, this.retriever);
    this.consolidator = new Consolidator(
      store,
      this.memories,
      this.conversations,
      cfg.ownerName,
      this.embeddings,
    );
    log.info('memória pronta', {
      embeddings: this.embeddings.name,
      dimensao: this.embeddings.dim,
      ...this.memories.countByKind(),
    });
  }

  // ── uso no turno ───────────────────────────────────────────────────────────

  /** Memórias relevantes para esta mensagem — vão para o contexto do modelo. */
  async recall(query: string, opts: RetrievalOptions = {}): Promise<ScoredMemory[]> {
    return this.retriever.search(query, { limit: this.cfg.memory.retrievalLimit, ...opts });
  }

  /** O retrato do dono, que abre todo prompt de sistema. */
  profile(): string {
    return this.consolidator.currentProfile();
  }

  async remember(input: MemoryInput): Promise<Memory> {
    return this.memories.remember(input);
  }

  forget(memoryId: string): boolean {
    return this.memories.forget(memoryId);
  }

  get(memoryId: string): Memory | null {
    return this.memories.get(memoryId);
  }

  list(opts: { kind?: MemoryKind; limit?: number; offset?: number } = {}): Memory[] {
    return this.memories.list(opts);
  }

  stats(): Record<string, number> {
    return this.memories.countByKind();
  }

  /**
   * Chamado ao fim de cada turno. Conta os turnos e dispara a reflexão em
   * segundo plano quando atinge o intervalo — sem travar a resposta ao dono.
   */
  noteTurn(conversationId: string): void {
    const n = (this.turnsSinceReflection.get(conversationId) ?? 0) + 1;
    if (n < this.cfg.memory.reflectEveryTurns) {
      this.turnsSinceReflection.set(conversationId, n);
      return;
    }
    this.turnsSinceReflection.set(conversationId, 0);
    void this.reflectNow(conversationId);
  }

  /** Reflexão imediata sobre a conversa. Protegida contra execução concorrente. */
  async reflectNow(conversationId: string): Promise<number> {
    if (this.reflecting.has(conversationId)) return 0;
    this.reflecting.add(conversationId);
    try {
      const window = this.cfg.memory.reflectEveryTurns * 3;
      const messages = this.conversations.recent(conversationId, Math.max(8, window));
      const { learned, title } = await this.reflector.reflect(messages, conversationId);

      const conv = this.conversations.get(conversationId);
      if (title && conv && !conv.title) this.conversations.setTitle(conversationId, title);
      return learned;
    } catch (err) {
      log.warn('reflexão falhou', { erro: describeError(err) });
      return 0;
    } finally {
      this.reflecting.delete(conversationId);
    }
  }

  /** A rotina noturna inteira. */
  async consolidate(): Promise<ConsolidationReport> {
    return this.consolidator.run();
  }

  /** Recalcula embeddings pendentes (após trocar de provedor, por exemplo). */
  async reindex(): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.memories.reindex(200);
      total += n;
      if (n === 0) break;
    }
    if (total > 0) log.info('embeddings recalculados', { total });
    return total;
  }

  /**
   * Formata as memórias recuperadas para entrar no prompt. Ordena por tipo para
   * o modelo ler um bloco coerente, não uma lista embaralhada.
   */
  formatForPrompt(memories: ScoredMemory[]): string {
    if (memories.length === 0) return '';
    const order: MemoryKind[] = [
      'perfil',
      'preferencia',
      'fato',
      'pessoa',
      'processo',
      'procedimento',
      'credencial',
      'insight',
      'evento',
    ];
    const grouped = new Map<string, ScoredMemory[]>();
    for (const m of memories) {
      const list = grouped.get(m.kind) ?? [];
      list.push(m);
      grouped.set(m.kind, list);
    }
    const titles: Record<string, string> = {
      perfil: 'RETRATO',
      preferencia: 'PREFERÊNCIAS',
      fato: 'FATOS',
      pessoa: 'PESSOAS',
      processo: 'PROCESSOS',
      procedimento: 'PROCEDIMENTOS JÁ APRENDIDOS',
      credencial: 'CREDENCIAIS DISPONÍVEIS NO COFRE',
      insight: 'PADRÕES OBSERVADOS',
      evento: 'HISTÓRICO',
    };

    const parts: string[] = [];
    for (const kind of order) {
      const items = grouped.get(kind);
      if (!items?.length) continue;
      const lines = items.map((m) => `- [${m.id}] ${m.subject}: ${m.content}`).join('\n');
      parts.push(`${titles[kind] ?? kind.toUpperCase()}:\n${lines}`);
    }
    return parts.join('\n\n');
  }
}

export type { Conversation, StoredMessage, Memory, MemoryInput, MemoryKind, ScoredMemory, ConsolidationReport };
export { MEMORY_KINDS } from './types.js';

let singleton: MemoryEngine | null = null;

export function initMemory(store: Store, cfg?: Config): MemoryEngine {
  singleton = new MemoryEngine(store, cfg);
  return singleton;
}

export function getMemory(): MemoryEngine {
  if (!singleton) throw new Error('memória não inicializada');
  return singleton;
}
