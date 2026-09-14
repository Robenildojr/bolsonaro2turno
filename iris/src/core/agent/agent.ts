/**
 * O agente.
 *
 * Um turno é: monta contexto → conversa com o modelo em streaming → executa as
 * ferramentas que ele pedir → repete até ele terminar → persiste e aprende.
 *
 * ## Conversa sem limite
 *
 * Três mecanismos somados, porque nenhum sozinho resolve:
 *
 *  1. **Compaction do servidor** (`compact_20260112`): quando o histórico cresce
 *     demais, a própria API resume a parte antiga. Os blocos de compactação
 *     precisam voltar no histórico a cada requisição — é por isso que
 *     persistimos `response.content` inteiro, e não só o texto.
 *  2. **Janela quente local**: as N mensagens mais recentes sempre íntegras.
 *  3. **Memória de longo prazo**: tudo continua no banco, recuperável por busca.
 *     Compactar o contexto não apaga nada.
 */
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig, type Config } from '../../config.js';
import { getClient } from '../llm.js';
import { bus } from '../events/bus.js';
import { createLogger, describeError } from '../../util/logger.js';
import { formatDateTime } from '../../util/time.js';
import type { MemoryEngine } from '../memory/index.js';
import { buildContextBlock, buildSystemPrompt, WHATSAPP_HINT } from './prompt.js';
import { getRegistry, truncateForModel, type ToolContext } from './tools.js';

const log = createLogger('agente');

const COMPACT_BETA = 'compact-2026-01-12';

/**
 * Ferramentas executadas no servidor da Anthropic: buscar e ler na internet.
 * Não passam pelo broker porque não tocam a máquina do dono nem os dados dele —
 * saem do datacenter, voltam com citação da fonte. O que sai *daqui* para a web
 * continua sendo `baixar_pagina`, essa sim sob autorização por domínio.
 */
const SERVER_TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  { type: 'web_search_20260209', name: 'web_search', max_uses: 8 },
  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 8, max_content_tokens: 60000 },
];

export interface TurnInput {
  conversationId: string;
  channel: string;
  text: string;
  /** Texto extra de contexto do canal (ex.: agenda do dia). */
  extraContext?: string;
  signal?: AbortSignal;
}

export interface TurnResult {
  text: string;
  conversationId: string;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  stopReason: string;
  interrupted: boolean;
}

/** Teto de idas e voltas com ferramentas num único turno. */
const MAX_ITERATIONS = 40;

export class Agent {
  private readonly systemPrompt: string;
  private inFlight = new Map<string, AbortController>();

  constructor(
    private readonly memory: MemoryEngine,
    private cfg: Config = loadConfig(),
    /** Injetado pelo scheduler para trazer agenda/pendências ao contexto. */
    private agendaProvider: (() => string) | null = null,
  ) {
    this.systemPrompt = buildSystemPrompt(cfg);
  }

  setAgendaProvider(fn: (() => string) | null): void {
    this.agendaProvider = fn;
  }

  /** Interrompe o turno em andamento de uma conversa. */
  interrupt(conversationId: string): boolean {
    const controller = this.inFlight.get(conversationId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  get busy(): boolean {
    return this.inFlight.size > 0;
  }

  async run(input: TurnInput): Promise<TurnResult> {
    const { conversationId, channel } = input;
    const controller = new AbortController();
    if (input.signal) {
      input.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    this.inFlight.set(conversationId, controller);

    const ctx: ToolContext = { conversationId, channel, signal: controller.signal };
    const registry = getRegistry();

    let tokensIn = 0;
    let tokensOut = 0;
    let toolCalls = 0;
    let finalText = '';
    let stopReason = 'end_turn';
    let interrupted = false;

    try {
      bus.emit('agent:state', { conversationId, state: 'thinking' });

      // Persiste a mensagem do dono antes de qualquer coisa: se der erro no
      // meio do caminho, o que ele disse não se perde.
      this.memory.conversations.append({
        conversationId,
        role: 'user',
        content: input.text,
        channel,
      });

      const contextBlock = await this.buildContext(input);
      const history = this.memory.conversations.toApiMessages(conversationId, this.cfg.memory.hotWindow);

      const messages: Anthropic.Beta.BetaMessageParam[] = [...history];
      let contextInjected = false;

      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        if (controller.signal.aborted) {
          interrupted = true;
          stopReason = 'interrompido';
          break;
        }

        // O bloco de contexto entra como instrução de operador logo depois da
        // mensagem do dono — não invalida o prefixo cacheado e não fica no
        // histórico gravado.
        const request = this.buildRequest(
          contextInjected ? messages : withContext(messages, contextBlock),
          registry,
        );
        contextInjected = true;

        const message = await this.streamOnce(request, conversationId, controller.signal);
        if (!message) {
          interrupted = true;
          stopReason = 'interrompido';
          break;
        }

        tokensIn += message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0);
        tokensOut += message.usage.output_tokens;
        stopReason = message.stop_reason ?? 'end_turn';

        const text = textOf(message);
        if (text) finalText = text;

        // Guarda os blocos completos: é o que mantém tool_use/tool_result
        // pareados e preserva os blocos de compactação.
        this.memory.conversations.append({
          conversationId,
          role: 'assistant',
          content: text,
          blocks: message.content,
          channel,
          tokensIn: message.usage.input_tokens,
          tokensOut: message.usage.output_tokens,
        });
        messages.push({ role: 'assistant', content: message.content });

        if (message.stop_reason === 'refusal') {
          finalText =
            finalText ||
            'Não consigo seguir com este pedido. Se você reformular ou explicar o contexto, eu tento de novo.';
          log.warn('modelo recusou', { categoria: message.stop_details?.category });
          break;
        }

        // Ferramenta do servidor atingiu o limite interno: reenvia para continuar.
        if (message.stop_reason === 'pause_turn') continue;

        const toolUses = message.content.filter(
          (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use',
        );
        if (toolUses.length === 0) break;

        bus.emit('agent:state', { conversationId, state: 'working' });

        // Chamadas independentes rodam em paralelo; os resultados voltam
        // juntos, numa única mensagem do usuário, como a API exige.
        const results = await Promise.all(
          toolUses.map(async (use) => {
            toolCalls++;
            const result = await registry.execute(use.name, use.input, ctx);
            const block: Anthropic.Beta.BetaToolResultBlockParam = {
              type: 'tool_result',
              tool_use_id: use.id,
              content: truncateForModel(result.content),
              ...(result.ok ? {} : { is_error: true }),
            };
            return block;
          }),
        );

        this.memory.conversations.append({
          conversationId,
          role: 'user',
          content: '',
          blocks: results,
          channel,
        });
        messages.push({ role: 'user', content: results });

        if (iteration === MAX_ITERATIONS - 1) {
          log.warn('limite de iterações atingido no turno', { conversationId, toolCalls });
          finalText =
            finalText ||
            'Fiz muitas operações seguidas e parei para não entrar em laço. Me diga como quer continuar.';
        }
      }

      bus.emit('agent:state', { conversationId, state: 'idle' });
      bus.emit('agent:message', { conversationId, role: 'assistant', content: finalText, channel });

      // Reflexão em segundo plano — o dono não espera por ela.
      this.memory.noteTurn(conversationId);

      return {
        text: finalText,
        conversationId,
        toolCalls,
        tokensIn,
        tokensOut,
        stopReason,
        interrupted,
      };
    } catch (err) {
      const message = describeError(err);
      log.error('turno falhou', { conversationId, erro: message });
      bus.emit('agent:state', { conversationId, state: 'error', detail: message });
      return {
        text: friendlyError(err),
        conversationId,
        toolCalls,
        tokensIn,
        tokensOut,
        stopReason: 'erro',
        interrupted,
      };
    } finally {
      this.inFlight.delete(conversationId);
    }
  }

  // ── montagem ───────────────────────────────────────────────────────────────

  private async buildContext(input: TurnInput): Promise<string> {
    const recalled = await this.memory.recall(input.text);
    const parts = {
      nowFormatted: formatDateTime(new Date(), this.cfg.timezone, this.cfg.locale),
      timezone: this.cfg.timezone,
      profile: this.memory.profile(),
      memories: this.memory.formatForPrompt(recalled),
      agenda: [this.agendaProvider?.() ?? '', input.extraContext ?? ''].filter(Boolean).join('\n'),
      channel: input.channel,
      observerActive: this.cfg.observer.enabled,
    };
    const block = buildContextBlock(parts);
    return input.channel === 'whatsapp' ? `${block}\n\n${WHATSAPP_HINT}` : block;
  }

  private buildRequest(
    messages: Anthropic.Beta.BetaMessageParam[],
    registry = getRegistry(),
  ): Anthropic.Beta.MessageCreateParamsStreaming {
    const params: Anthropic.Beta.MessageCreateParamsStreaming = {
      model: this.cfg.model.main,
      max_tokens: this.cfg.model.maxTokens,
      system: [
        {
          type: 'text',
          text: this.systemPrompt,
          // Prompt estável + ferramentas em ordem fixa = prefixo cacheável.
          cache_control: { type: 'ephemeral' },
        },
      ],
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: this.cfg.model.effort },
      tools: this.cfg.model.webSearch
        ? [...registry.toApiTools(), ...SERVER_TOOLS]
        : registry.toApiTools(),
      messages,
      stream: true,
    };

    if (this.cfg.model.compaction) {
      params.betas = [COMPACT_BETA];
      params.context_management = { edits: [{ type: 'compact_20260112' }] };
    }
    return params;
  }

  /** Uma requisição em streaming, empurrando os deltas para o barramento. */
  private async streamOnce(
    params: Anthropic.Beta.MessageCreateParamsStreaming,
    conversationId: string,
    signal: AbortSignal,
  ): Promise<Anthropic.Beta.BetaMessage | null> {
    const stream = getClient().beta.messages.stream(params, { signal });

    let firstText = true;
    stream.on('text', (delta) => {
      if (firstText) {
        firstText = false;
        bus.emit('agent:state', { conversationId, state: 'responding' });
      }
      bus.emit('agent:delta', { conversationId, text: delta });
    });
    stream.on('thinking', (delta) => {
      bus.emit('agent:thinking', { conversationId, text: delta });
    });

    try {
      return await stream.finalMessage();
    } catch (err) {
      if (signal.aborted) {
        log.info('turno interrompido pelo dono', { conversationId });
        return null;
      }
      // Modelo sem suporte a mensagem de sistema no meio da conversa: repete
      // dobrando o contexto dentro do turno do usuário.
      if (err instanceof Anthropic.BadRequestError && /role 'system'/i.test(err.message)) {
        log.warn('modelo não aceita instrução de operador no meio — usando o modo alternativo');
        const retry = { ...params, messages: foldSystemIntoUser(params.messages) };
        return getClient().beta.messages.stream(retry, { signal }).finalMessage();
      }
      throw err;
    }
  }
}

// ── auxiliares ───────────────────────────────────────────────────────────────

function withContext(
  messages: Anthropic.Beta.BetaMessageParam[],
  contextBlock: string,
): Anthropic.Beta.BetaMessageParam[] {
  if (!contextBlock.trim()) return messages;
  return [...messages, { role: 'system', content: contextBlock } as Anthropic.Beta.BetaMessageParam];
}

/** Junta a instrução de operador ao último turno do usuário. */
function foldSystemIntoUser(
  messages: Anthropic.Beta.BetaMessageParam[],
): Anthropic.Beta.BetaMessageParam[] {
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of messages) {
    if ((m.role as string) !== 'system') {
      out.push(m);
      continue;
    }
    const text = typeof m.content === 'string' ? m.content : '';
    const previous = out.pop();
    if (previous?.role === 'user') {
      const blocks: Anthropic.Beta.BetaContentBlockParam[] =
        typeof previous.content === 'string'
          ? [{ type: 'text', text: previous.content }]
          : [...(previous.content as Anthropic.Beta.BetaContentBlockParam[])];
      blocks.unshift({ type: 'text', text });
      out.push({ role: 'user', content: blocks });
    } else if (previous) {
      out.push(previous);
    }
  }
  return out;
}

function textOf(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

function friendlyError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'A chave da API da Anthropic não foi aceita. Confira ANTHROPIC_API_KEY no .env.';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'A API está limitando as requisições agora. Tente de novo em alguns instantes.';
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Não consegui falar com a API da Anthropic — parece problema de conexão.';
  }
  if (err instanceof Anthropic.BadRequestError) {
    return `A requisição foi recusada pela API: ${err.message}`;
  }
  if (err instanceof Anthropic.APIError) {
    return `Erro ${err.status} da API: ${err.message}`;
  }
  return `Deu erro aqui: ${describeError(err)}`;
}

let singleton: Agent | null = null;

export function initAgent(memory: MemoryEngine, cfg?: Config): Agent {
  singleton = new Agent(memory, cfg);
  return singleton;
}

export function getAgent(): Agent {
  if (!singleton) throw new Error('agente não inicializado');
  return singleton;
}
