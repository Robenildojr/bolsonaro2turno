/**
 * Histórico bruto das conversas — cifrado, completo e para sempre.
 *
 * Isto é o alicerce do "sem limite": mesmo quando o contexto enviado ao modelo
 * é compactado, o diálogo inteiro continua aqui, recuperável por busca.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { Store } from '../db/database.js';
import { id as newId } from '../../util/ids.js';

export interface Conversation {
  id: string;
  channel: string;
  title: string;
  summary: string;
  startedAt: number;
  updatedAt: number;
  messageCount: number;
  archived: boolean;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  /** Blocos originais da API (texto, tool_use, tool_result, compaction). */
  blocks?: unknown;
  channel: string;
  tokensIn: number;
  tokensOut: number;
  createdAt: number;
}

export class ConversationStore {
  constructor(private readonly store: Store) {}

  create(channel: string, title = ''): Conversation {
    const now = Date.now();
    const conversationId = newId('conv');
    this.store.db
      .prepare(
        `INSERT INTO conversations (id, channel, title_enc, started_at, updated_at, message_count)
         VALUES (?, ?, ?, ?, ?, 0)`,
      )
      .run(conversationId, channel, this.store.encText(title, `conversations:title:${conversationId}`), now, now);
    return this.get(conversationId)!;
  }

  /**
   * Conversa corrente de um canal. Retoma a última se ainda estiver "quente"
   * (menos de 12 horas parada) — assim você continua no WhatsApp o que começou
   * na tela sem recomeçar do zero.
   */
  current(channel: string, maxIdleMs = 12 * 3_600_000): Conversation {
    const row = this.store.db
      .prepare(
        `SELECT * FROM conversations WHERE channel = ? AND archived = 0
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(channel) as ConversationRow | undefined;
    if (row && Date.now() - row.updated_at < maxIdleMs) return this.hydrate(row);
    return this.create(channel);
  }

  get(conversationId: string): Conversation | null {
    const row = this.store.db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) as
      | ConversationRow
      | undefined;
    return row ? this.hydrate(row) : null;
  }

  list(limit = 30): Conversation[] {
    const rows = this.store.db
      .prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as ConversationRow[];
    return rows.map((r) => this.hydrate(r));
  }

  setTitle(conversationId: string, title: string): void {
    this.store.db
      .prepare('UPDATE conversations SET title_enc = ? WHERE id = ?')
      .run(this.store.encText(title, `conversations:title:${conversationId}`), conversationId);
  }

  setSummary(conversationId: string, summary: string): void {
    this.store.db
      .prepare('UPDATE conversations SET summary_enc = ? WHERE id = ?')
      .run(this.store.encText(summary, `conversations:summary:${conversationId}`), conversationId);
  }

  append(msg: {
    conversationId: string;
    role: 'user' | 'assistant';
    content: string;
    blocks?: unknown;
    channel: string;
    tokensIn?: number;
    tokensOut?: number;
  }): StoredMessage {
    const now = Date.now();
    const messageId = newId('msg');
    return this.store.transaction(() => {
      const seqRow = this.store.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE conversation_id = ?')
        .get(msg.conversationId) as { next: number };

      this.store.db
        .prepare(
          `INSERT INTO messages
             (id, conversation_id, seq, role, content_enc, blocks_enc, channel, tokens_in, tokens_out, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          messageId,
          msg.conversationId,
          seqRow.next,
          msg.role,
          this.store.encText(msg.content, `messages:content:${messageId}`),
          msg.blocks ? this.store.encJson(msg.blocks, `messages:blocks:${messageId}`) : null,
          msg.channel,
          msg.tokensIn ?? 0,
          msg.tokensOut ?? 0,
          now,
        );

      this.store.db
        .prepare('UPDATE conversations SET updated_at = ?, message_count = message_count + 1 WHERE id = ?')
        .run(now, msg.conversationId);

      return {
        id: messageId,
        conversationId: msg.conversationId,
        seq: seqRow.next,
        role: msg.role,
        content: msg.content,
        blocks: msg.blocks,
        channel: msg.channel,
        tokensIn: msg.tokensIn ?? 0,
        tokensOut: msg.tokensOut ?? 0,
        createdAt: now,
      };
    });
  }

  /** As N mensagens mais recentes, em ordem cronológica. */
  recent(conversationId: string, limit = 40): StoredMessage[] {
    const rows = this.store.db
      .prepare(
        `SELECT * FROM messages WHERE conversation_id = ?
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(conversationId, limit) as MessageRow[];
    return rows.reverse().map((r) => this.hydrateMessage(r));
  }

  /** Reconstrói a lista de mensagens no formato da API, preservando os blocos. */
  toApiMessages(conversationId: string, limit: number): Anthropic.Beta.BetaMessageParam[] {
    const stored = this.recent(conversationId, limit);
    const out: Anthropic.Beta.BetaMessageParam[] = [];
    for (const m of stored) {
      const blocks = m.blocks as Anthropic.Beta.BetaContentBlockParam[] | undefined;
      if (Array.isArray(blocks) && blocks.length > 0) {
        out.push({ role: m.role, content: blocks });
      } else if (m.content.trim()) {
        out.push({ role: m.role, content: m.content });
      }
    }
    return repairWindow(out);
  }

  countMessages(conversationId: string): number {
    const row = this.store.db
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?')
      .get(conversationId) as { n: number };
    return row.n;
  }

  /** Mensagens de uma janela de tempo — usado pela consolidação noturna. */
  since(from: number, to = Date.now(), limit = 2000): StoredMessage[] {
    const rows = this.store.db
      .prepare('SELECT * FROM messages WHERE created_at BETWEEN ? AND ? ORDER BY created_at ASC LIMIT ?')
      .all(from, to, limit) as MessageRow[];
    return rows.map((r) => this.hydrateMessage(r));
  }

  archive(conversationId: string): void {
    this.store.db.prepare('UPDATE conversations SET archived = 1 WHERE id = ?').run(conversationId);
  }

  private hydrate(row: ConversationRow): Conversation {
    return {
      id: row.id,
      channel: row.channel,
      title: row.title_enc ? this.store.decText(row.title_enc, `conversations:title:${row.id}`) : '',
      summary: row.summary_enc ? this.store.decText(row.summary_enc, `conversations:summary:${row.id}`) : '',
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      messageCount: row.message_count,
      archived: row.archived === 1,
    };
  }

  private hydrateMessage(row: MessageRow): StoredMessage {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      seq: row.seq,
      role: row.role as 'user' | 'assistant',
      content: this.store.decText(row.content_enc, `messages:content:${row.id}`),
      blocks: row.blocks_enc
        ? this.store.decJson<unknown>(row.blocks_enc, `messages:blocks:${row.id}`, undefined)
        : undefined,
      channel: row.channel,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      createdAt: row.created_at,
    };
  }
}

/**
 * Conserta a janela recortada do histórico.
 *
 * Pegar "as N últimas mensagens" pode cortar no meio de uma chamada de
 * ferramenta, e a API rejeita os dois casos que isso gera:
 *
 *  - um `tool_result` órfão no começo, cujo `tool_use` ficou de fora da janela;
 *  - um `tool_use` no fim sem o `tool_result` correspondente, que é o que
 *    sobra quando o dono interrompe o turno no meio.
 *
 * Também garante que a conversa comece por `user`, como a API exige.
 */
function repairWindow(messages: Anthropic.Beta.BetaMessageParam[]): Anthropic.Beta.BetaMessageParam[] {
  const out = [...messages];

  // Começo: fora tudo que não seja um turno de usuário "de verdade".
  while (out.length > 0) {
    const first = out[0]!;
    if (first.role !== 'user' || hasBlockType(first, 'tool_result')) {
      out.shift();
      continue;
    }
    break;
  }

  // Fim: fora a chamada de ferramenta que ficou sem resposta.
  while (out.length > 0) {
    const last = out[out.length - 1]!;
    if (last.role === 'assistant' && hasBlockType(last, 'tool_use')) {
      out.pop();
      continue;
    }
    break;
  }

  return alinharChamadasEResultados(out);
}

/**
 * Alinha chamadas de ferramenta e resultados, nos dois sentidos.
 *
 * A API exige um casamento exato: cada `tool_use` precisa de um `tool_result`
 * na mensagem seguinte, e cada `tool_result` precisa do `tool_use` dele na
 * mensagem anterior. Violar qualquer um dos dois lados devolve 400 — e como o
 * histórico inteiro é reenviado a cada turno, uma conversa que quebrou uma vez
 * fica morta para sempre. Não adianta recarregar a página nem reiniciar.
 *
 * Os dois lados quebraram de verdade na instalação do dono, em sequência:
 * primeiro uma chamada sem resposta (o turno morreu entre chamar a ferramenta
 * e gravar o resultado), depois um resultado sem chamada (sobra da mesma
 * bagunça). Consertar só um lado deixou o outro aparecer no dia seguinte, e a
 * lição está aqui: em invariante de duas pontas, remendar uma ponta só é meio
 * conserto.
 *
 * A ordem das duas passagens importa. Primeiro tira o resultado órfão, senão a
 * segunda passagem "responderia" uma chamada que não existe; depois completa a
 * chamada sem resposta, inclusive as que a primeira passagem acabou de deixar
 * a descoberto.
 */
function alinharChamadasEResultados(
  messages: Anthropic.Beta.BetaMessageParam[],
): Anthropic.Beta.BetaMessageParam[] {
  // ── passagem 1: fora os resultados sem chamada ──────────────────────────────
  const semOrfaos: Anthropic.Beta.BetaMessageParam[] = [];
  for (const msg of messages) {
    if (msg.role !== 'user' || !hasBlockType(msg, 'tool_result')) {
      semOrfaos.push(msg);
      continue;
    }

    // O que vale é o que vai de fato na frente dele, não o que estava no banco.
    const anterior = semOrfaos[semOrfaos.length - 1];
    const validos = new Set(
      anterior?.role === 'assistant' ? idsDeBloco(anterior, 'tool_use') : [],
    );

    const blocos = (msg.content as unknown as Array<Record<string, unknown>>).filter(
      (b) => b?.type !== 'tool_result' || validos.has(String(b.tool_use_id ?? '')),
    );

    // Sobrou nada: a mensagem era só de órfãos e não tem por que existir.
    if (blocos.length === 0) continue;
    semOrfaos.push({ ...msg, content: blocos as unknown as Anthropic.Beta.BetaContentBlockParam[] });
  }

  // ── passagem 2: responde as chamadas que ficaram sem resposta ───────────────
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  for (let i = 0; i < semOrfaos.length; i++) {
    const msg = semOrfaos[i]!;
    out.push(msg);

    if (msg.role !== 'assistant') continue;
    const chamadas = idsDeBloco(msg, 'tool_use');
    if (!chamadas.length) continue;

    const proxima = semOrfaos[i + 1];
    const respondidas = new Set(proxima ? idsDeBloco(proxima, 'tool_result') : []);
    const faltando = chamadas.filter((id) => !respondidas.has(id));
    if (!faltando.length) continue;

    /*
     * Responder em vez de apagar a chamada é deliberado: apagar reescreveria o
     * passado, e saber que tentou e falhou é informação útil para o modelo não
     * insistir no mesmo caminho.
     */
    const remendos = faltando.map((id) => ({
      type: 'tool_result' as const,
      tool_use_id: id,
      is_error: true,
      content: 'A ferramenta não chegou a responder — o turno foi interrompido antes.',
    }));

    // Já existe um turno de resultados logo depois: os que faltam entram ali
    // dentro, porque a API exige todos os resultados na MESMA mensagem.
    if (proxima?.role === 'user' && hasBlockType(proxima, 'tool_result')) {
      const conteudo = Array.isArray(proxima.content) ? proxima.content : [];
      semOrfaos[i + 1] = { ...proxima, content: [...remendos, ...conteudo] } as typeof proxima;
      continue;
    }

    out.push({ role: 'user', content: remendos });
  }

  return out;
}

/** Ids dos blocos de um tipo dentro de uma mensagem. */
function idsDeBloco(message: Anthropic.Beta.BetaMessageParam, type: 'tool_use' | 'tool_result'): string[] {
  if (typeof message.content === 'string') return [];
  const chave = type === 'tool_use' ? 'id' : 'tool_use_id';
  return (message.content as unknown as Array<Record<string, unknown>>)
    .filter((b) => b?.type === type)
    .map((b) => String(b[chave] ?? ''))
    .filter(Boolean);
}

function hasBlockType(message: Anthropic.Beta.BetaMessageParam, type: string): boolean {
  if (typeof message.content === 'string') return false;
  return (message.content as Array<{ type?: string }>).some((b) => b?.type === type);
}

interface ConversationRow {
  id: string;
  channel: string;
  title_enc: Buffer | null;
  summary_enc: Buffer | null;
  started_at: number;
  updated_at: number;
  message_count: number;
  archived: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  role: string;
  content_enc: Buffer;
  blocks_enc: Buffer | null;
  channel: string;
  tokens_in: number;
  tokens_out: number;
  created_at: number;
}
