/**
 * Consolidação — o que acontece de madrugada.
 *
 * O cérebro humano não guarda tudo do jeito que capturou: ele repassa, junta o
 * que é parecido, reforça o que usou, deixa desbotar o que não usou e escreve
 * um resumo do dia. É isso que este módulo faz, e é daqui que vem a sensação
 * de que ele melhora a cada dia em vez de só acumular texto.
 *
 * Cinco passos:
 *   1. envelhecer  — importância cai para o que ficou parado
 *   2. fundir      — memórias quase idênticas viram uma só, mais rica
 *   3. resumir     — cada conversa do dia ganha resumo e vira memória de evento
 *   4. perceber    — procura padrões e grava insights
 *   5. retratar    — reescreve o perfil do dono
 */
import { complete, extractStructured } from '../llm.js';
import { createLogger, describeError } from '../../util/logger.js';
import { cosine, type EmbeddingProvider } from './embeddings.js';
import type { ConversationStore } from './conversations.js';
import type { MemoryStore } from './store.js';
import type { Store } from '../db/database.js';
import type { MemoryRow } from './store.js';
import { DAY } from '../../util/time.js';

const log = createLogger('consolidacao');

export interface ConsolidationReport {
  decayed: number;
  merged: number;
  summarized: number;
  insights: number;
  profileUpdated: boolean;
  durationMs: number;
}

export class Consolidator {
  constructor(
    private readonly store: Store,
    private readonly memories: MemoryStore,
    private readonly conversations: ConversationStore,
    private readonly ownerName: string,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  async run(): Promise<ConsolidationReport> {
    const started = Date.now();
    const report: ConsolidationReport = {
      decayed: 0,
      merged: 0,
      summarized: 0,
      insights: 0,
      profileUpdated: false,
      durationMs: 0,
    };

    try {
      report.decayed = this.decay();
      report.merged = this.mergeDuplicates();
      report.summarized = await this.summarizeConversations();
      report.insights = await this.findPatterns();
      report.profileUpdated = await this.rebuildProfile();
    } catch (err) {
      log.error('consolidação falhou no meio', { erro: describeError(err) });
    }

    report.durationMs = Date.now() - started;
    log.info('consolidação concluída', report as unknown as Record<string, unknown>);
    return report;
  }

  /**
   * Passo 1 — envelhecer.
   * Memória não usada perde importância devagar; memória fixada nunca perde.
   * O que cai abaixo do piso e nunca foi usado é descartado: esquecer também
   * é função da memória, senão o ruído sufoca o sinal.
   */
  decay(): number {
    const now = Date.now();
    const rows = this.store.db
      .prepare(
        `SELECT id, importance, use_count, last_used_at, updated_at, pinned
         FROM memories WHERE superseded_by IS NULL AND pinned = 0`,
      )
      .all() as Array<{
      id: string;
      importance: number;
      use_count: number;
      last_used_at: number | null;
      updated_at: number;
      pinned: number;
    }>;

    const update = this.store.db.prepare('UPDATE memories SET importance = ? WHERE id = ?');
    const drop = this.store.db.prepare('DELETE FROM memories WHERE id = ?');
    let changed = 0;

    this.store.transaction(() => {
      for (const row of rows) {
        const idleDays = (now - (row.last_used_at ?? row.updated_at)) / DAY;
        if (idleDays < 7) continue;

        // Meia-vida de 120 dias sem uso; uso frequente segura a queda.
        const resistance = 1 + Math.log1p(row.use_count);
        const factor = Math.pow(0.5, idleDays / (120 * resistance));
        const next = row.importance * factor;

        if (next < 0.08 && row.use_count === 0 && idleDays > 180) {
          drop.run(row.id);
          changed++;
          continue;
        }
        if (Math.abs(next - row.importance) > 0.01) {
          update.run(Number(next.toFixed(4)), row.id);
          changed++;
        }
      }
    });
    return changed;
  }

  /**
   * Passo 2 — fundir.
   * Duas memórias do mesmo tipo acima do limiar de quase-duplicata do provedor
   * de embeddings são a mesma coisa dita de dois jeitos. Fica a mais rica,
   * herdando a maior importância e a soma dos usos. Aqui a varredura é da base
   * inteira, não só das candidatas recentes que a gravação consegue olhar.
   */
  mergeDuplicates(): number {
    let merged = 0;
    const kinds = this.store.db
      .prepare('SELECT DISTINCT kind FROM memories WHERE superseded_by IS NULL')
      .all() as Array<{ kind: string }>;

    for (const { kind } of kinds) {
      const rows = this.store.db
        .prepare(
          `SELECT * FROM memories
           WHERE kind = ? AND superseded_by IS NULL AND embedding IS NOT NULL
           ORDER BY importance DESC, updated_at DESC LIMIT 800`,
        )
        .all(kind) as MemoryRow[];

      const absorbed = new Set<string>();
      for (let i = 0; i < rows.length; i++) {
        const a = rows[i]!;
        if (absorbed.has(a.id)) continue;
        const va = this.memories.vectorOf(a);
        if (!va) continue;

        for (let j = i + 1; j < rows.length; j++) {
          const b = rows[j]!;
          if (absorbed.has(b.id)) continue;
          const vb = this.memories.vectorOf(b);
          if (!vb || vb.length !== va.length) continue;
          if (cosine(va, vb) < this.embeddings.nearDuplicate) continue;

          const memA = this.memories.toMemory(a);
          const memB = this.memories.toMemory(b);
          const keepContent = memA.content.length >= memB.content.length ? memA.content : memB.content;

          this.memories.update(a.id, {
            content: keepContent,
            importance: Math.max(a.importance, b.importance),
            confidence: Math.min(1, Math.max(a.confidence, b.confidence) + 0.03),
          });
          this.store.db
            .prepare('UPDATE memories SET use_count = use_count + ? WHERE id = ?')
            .run(b.use_count, a.id);
          this.memories.supersede(b.id, a.id);
          absorbed.add(b.id);
          merged++;
        }
      }
    }
    if (merged > 0) log.info('memórias fundidas', { total: merged });
    return merged;
  }

  /**
   * Passo 3 — resumir.
   * Cada conversa encerrada ganha um resumo e vira uma memória de evento, com
   * data. É o que permite perguntar "o que a gente decidiu na terça?".
   */
  async summarizeConversations(): Promise<number> {
    const cutoff = Date.now() - 6 * 3_600_000; // parada há pelo menos 6 h
    const rows = this.store.db
      .prepare(
        `SELECT id, updated_at, message_count FROM conversations
         WHERE summary_enc IS NULL AND message_count >= 4 AND updated_at < ?
         ORDER BY updated_at DESC LIMIT 12`,
      )
      .all(cutoff) as Array<{ id: string; updated_at: number; message_count: number }>;

    let done = 0;
    for (const row of rows) {
      const messages = this.conversations.recent(row.id, 120);
      const transcript = messages
        .filter((m) => m.content.trim())
        .map((m) => `${m.role === 'user' ? 'DONO' : 'ASSISTENTE'}: ${m.content.slice(0, 3000)}`)
        .join('\n\n');
      if (transcript.length < 200) continue;

      const summary = await complete({
        system:
          'Resuma a conversa abaixo em no máximo 8 linhas, em português. Registre o que foi decidido, o que ficou pendente e os números, nomes e datas mencionados. Não comente a conversa nem elogie ninguém — escreva o resumo direto, como uma ata enxuta.',
        prompt: transcript,
        maxTokens: 1500,
        effort: 'low',
      });
      if (!summary) continue;

      this.conversations.setSummary(row.id, summary);
      const date = new Date(row.updated_at).toLocaleDateString('pt-BR');
      await this.memories.remember({
        kind: 'evento',
        subject: `Conversa de ${date}`,
        content: `Em ${date}: ${summary}`,
        importance: 0.45,
        confidence: 0.9,
        source: 'consolidação',
        conversationId: row.id,
      });
      done++;
    }
    if (done > 0) log.info('conversas resumidas', { total: done });
    return done;
  }

  /**
   * Passo 4 — perceber.
   * Olha as memórias recentes procurando padrões que nenhuma mensagem isolada
   * revela: repetições, rotinas, atritos recorrentes, preferências implícitas.
   */
  async findPatterns(): Promise<number> {
    const recent = this.memories
      .list({ limit: 120 })
      .filter((m) => m.kind !== 'perfil' && m.kind !== 'insight');
    if (recent.length < 15) return 0;

    const block = recent.map((m) => `- (${m.kind}) ${m.subject}: ${m.content}`).join('\n').slice(0, 24000);

    const result = await extractStructured<{ insights: Array<{ assunto: string; conteudo: string; importancia: number }> }>({
      system: `Você analisa a memória de um assistente pessoal procurando padrões que nenhuma anotação isolada mostra.

Procure por: rotinas do dono, coisas que ele repete, tipos de tarefa que sempre voltam, preferências que ele nunca disse em voz alta mas que aparecem no comportamento, gargalos que se repetem, riscos que ele parece não estar vendo.

Só registre um padrão sustentado por pelo menos três anotações distintas. Nada de psicologia barata, nada de elogio, nada de generalidade que serviria para qualquer pessoa. Se não houver padrão claro, devolva lista vazia — é a resposta certa na maior parte dos dias.`,
      prompt: `Memórias recentes:\n${block}`,
      toolName: 'registrar_padroes',
      toolDescription: 'Registra padrões observados na memória.',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['insights'],
        properties: {
          insights: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['assunto', 'conteudo', 'importancia'],
              properties: {
                assunto: { type: 'string' },
                conteudo: { type: 'string', description: 'O padrão e as evidências que o sustentam.' },
                importancia: { type: 'number' },
              },
            },
          },
        },
      },
      effort: 'medium',
      maxTokens: 4000,
    });

    let count = 0;
    for (const item of result?.insights ?? []) {
      if (!item.conteudo?.trim()) continue;
      await this.memories.remember({
        kind: 'insight',
        subject: item.assunto,
        content: item.conteudo,
        importance: Math.max(0.5, item.importancia ?? 0.5),
        confidence: 0.65,
        source: 'consolidação',
      });
      count++;
    }
    if (count > 0) log.info('padrões percebidos', { total: count });
    return count;
  }

  /**
   * Passo 5 — retratar.
   * Reescreve o perfil do dono a partir das memórias mais importantes. Esse
   * texto entra no prompt de sistema de toda conversa: é o "quem é você" que
   * faz o assistente falar com alguém específico em vez de com um usuário genérico.
   */
  async rebuildProfile(): Promise<boolean> {
    const base = this.memories
      .list({ limit: 200 })
      .filter((m) => m.kind !== 'perfil' && m.kind !== 'evento')
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 120);

    if (base.length < 8) return false;

    const block = base.map((m) => `- (${m.kind}) ${m.subject}: ${m.content}`).join('\n').slice(0, 30000);
    const previous = this.currentProfile();

    const profile = await complete({
      system: `Você escreve o retrato de referência do dono de um assistente pessoal. Este texto será lido pela assistente antes de cada resposta, então precisa ser denso e concreto.

Estruture em seções curtas com estes títulos, omitindo as que não tiverem conteúdo real:
QUEM É · TRABALHO · COMO PREFERE SER ATENDIDO · PESSOAS E CLIENTES · ROTINA · EM ANDAMENTO · CUIDADOS

Regras: no máximo 700 palavras. Só afirme o que está apoiado nas memórias. Nada de adjetivo elogioso ("é dedicado", "é competente") — descreva comportamento observado, não caráter. Use nomes e números quando existirem. Escreva na terceira pessoa. Se o retrato anterior conflitar com memórias mais recentes, as recentes vencem.`,
      prompt: `RETRATO ANTERIOR:\n${previous || '(ainda não existe)'}\n\n---\n\nMEMÓRIAS MAIS IMPORTANTES:\n${block}`,
      maxTokens: 3000,
      effort: 'medium',
    });

    if (!profile || profile.length < 80) return false;

    const existing = this.store.db
      .prepare("SELECT id FROM memories WHERE kind = 'perfil' AND superseded_by IS NULL LIMIT 1")
      .get() as { id: string } | undefined;

    if (existing) {
      this.memories.update(existing.id, {
        content: profile,
        subject: `Retrato de ${this.ownerName}`,
        importance: 1,
        pinned: true,
      });
    } else {
      await this.memories.remember({
        kind: 'perfil',
        subject: `Retrato de ${this.ownerName}`,
        content: profile,
        importance: 1,
        confidence: 0.9,
        source: 'consolidação',
        pinned: true,
      });
    }
    log.info('retrato do dono atualizado', { caracteres: profile.length });
    return true;
  }

  currentProfile(): string {
    const row = this.store.db
      .prepare("SELECT * FROM memories WHERE kind = 'perfil' AND superseded_by IS NULL ORDER BY updated_at DESC LIMIT 1")
      .get() as MemoryRow | undefined;
    return row ? this.memories.toMemory(row).content : '';
  }
}
