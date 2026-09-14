/**
 * Registro e execução de ferramentas.
 *
 * Todo caminho entre "o modelo quis fazer" e "foi feito" passa por aqui, nesta
 * ordem:
 *
 *   1. valida os argumentos contra o schema
 *   2. deriva o escopo concreto (caminho, domínio, comando, contato)
 *   3. pede autorização ao broker — ou passa direto se já houver
 *   4. troca as referências {{cofre:…}} pelos valores reais (fora da conversa)
 *   5. executa com prazo máximo
 *   6. grava na auditoria e devolve o resultado ao modelo
 *
 * O passo 4 acontece **depois** do 3 de propósito: a autorização é pedida sobre
 * o argumento com a referência, não com a senha em claro, de modo que o segredo
 * não aparece nem no pedido de permissão.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { getBroker } from '../permissions/broker.js';
import { getAudit } from '../permissions/audit.js';
import { getVault, scrubSecrets, Vault } from '../vault/vault.js';
import type { Anexo } from './attachments.js';
import { bus } from '../events/bus.js';
import { createLogger, describeError } from '../../util/logger.js';
import { clip } from '../../util/redact.js';
import { id as newId } from '../../util/ids.js';

const log = createLogger('ferramentas');

export interface ToolContext {
  conversationId: string;
  channel: string;
  /** Cancelamento: o dono interrompeu o turno. */
  signal: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  /** O que volta para o modelo. Texto puro, já resumido se for grande. */
  content: string;
  /** Dados estruturados para a UI (não vão para o modelo). */
  data?: unknown;
  /**
   * Imagens e PDFs que a ferramenta quer colocar diante dos olhos do modelo.
   *
   * Existe porque "ler um documento digitalizado" não cabe em texto: o
   * resultado útil de abrir uma petição escaneada é a página em si, não uma
   * descrição dela.
   */
  attachments?: Anexo[];
}

export interface ToolDefinition<I = Record<string, unknown>> {
  name: string;
  description: string;
  /** JSON Schema dos argumentos (usado com strict: true). */
  schema: Record<string, unknown>;
  /** Validação em runtime — o schema da API não dispensa checar aqui. */
  validate?: z.ZodType<I>;
  /** Capacidade exigida. Sem isto, a ferramenta é livre (ex.: ler memória). */
  capability?: string;
  /** Deriva o alvo concreto da autorização a partir dos argumentos. */
  scopeFrom?: (input: I) => string;
  /** Frase curta mostrada na UI e gravada na auditoria. */
  summarize?: (input: I) => string;
  /**
   * Texto que a avaliação de irreversibilidade deve examinar.
   *
   * Existe porque o **escopo** da autorização e a **ação** não são a mesma
   * coisa: o escopo do terminal é só o programa (`rm`), e é nos argumentos que
   * mora o `-rf /home/eu/processos`. Sem esta ponte, o portão de confirmação
   * avaliaria a palavra "rm" isolada e deixaria passar.
   */
  destructiveFrom?: (input: I) => string;
  /** Prazo máximo de execução. Padrão: 2 minutos. */
  timeoutMs?: number;
  run(input: I, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition<any>>();

  register<I>(tool: ToolDefinition<I>): void {
    if (this.tools.has(tool.name)) throw new Error(`ferramenta duplicada: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: Array<ToolDefinition<any>>): void {
    for (const t of tools) this.register(t);
  }

  get(name: string): ToolDefinition<any> | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * Definições no formato da API. A ordem é estável (alfabética) porque uma
   * lista de ferramentas que muda de ordem invalida o cache de prompt.
   */
  toApiTools(): Anthropic.Beta.BetaToolUnion[] {
    return [...this.tools.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.schema as Anthropic.Beta.BetaTool.InputSchema,
        strict: true,
      }));
  }

  /** Executa uma chamada do modelo, com todo o portão de segurança no caminho. */
  async execute(
    name: string,
    rawInput: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, content: `Ferramenta desconhecida: ${name}` };
    }

    const callId = newId('call');
    const started = Date.now();

    // 1. validação
    let input = rawInput as Record<string, unknown>;
    if (tool.validate) {
      const parsed = tool.validate.safeParse(rawInput);
      if (!parsed.success) {
        const problema = parsed.error.issues
          .map((i) => `${i.path.join('.') || 'raiz'}: ${i.message}`)
          .join('; ');
        return { ok: false, content: `Argumentos inválidos para ${name} — ${problema}` };
      }
      input = parsed.data as Record<string, unknown>;
    }

    const summary = safeSummary(tool, input);
    // Guardado fora do try para que o tratamento de erro também consiga limpar.
    let secretsUsed: string[] = [];
    bus.emit('tool:start', { conversationId: ctx.conversationId, tool: name, summary, id: callId });

    try {
      // 2 e 3. escopo e autorização
      if (tool.capability) {
        const scope = tool.scopeFrom ? tool.scopeFrom(input) : '*';
        const refs = Vault.refsIn(input);
        const outcome = await getBroker().request({
          capability: tool.capability,
          scope,
          reason: summary,
          actionText: safeDestructiveText(tool, input, summary),
          details: {
            ferramenta: name,
            ...(refs.length ? { credenciais: refs } : {}),
          },
          conversationId: ctx.conversationId,
        });

        if (!outcome.allowed) {
          const result: ToolResult = {
            ok: false,
            content: `Não autorizado: ${outcome.reason ?? 'o dono não liberou esta ação'}. Siga sem isto ou proponha outro caminho.`,
          };
          this.finish(callId, name, tool, input, result, ctx, started, outcome.decision);
          return result;
        }

        // 3.1 usar credencial do cofre é uma autorização própria
        for (const ref of refs) {
          const vaultOk = await getBroker().request({
            capability: 'cofre.ler',
            scope: ref,
            reason: `usar a credencial "${ref}" em ${name}`,
            details: { ferramenta: name, alvo: scope },
            conversationId: ctx.conversationId,
          });
          if (!vaultOk.allowed) {
            const result: ToolResult = {
              ok: false,
              content: `Não autorizado a usar a credencial "${ref}".`,
            };
            this.finish(callId, name, tool, input, result, ctx, started, vaultOk.decision);
            return result;
          }
        }
      }

      // 4. substituição das credenciais, no último instante
      const resolved = getVault().resolveRefs(input);
      secretsUsed = resolved.values;

      // 5. execução com prazo
      const raw = await withTimeout(
        tool.run(resolved.value, ctx),
        tool.timeoutMs ?? 120_000,
        `a ferramenta ${name} passou do tempo`,
      );

      // 6. limpeza: se a ferramenta devolveu o segredo (um `cat` no arquivo de
      // configuração, o HTML do formulário preenchido, um erro que ecoa o
      // argumento), ele some antes de voltar ao modelo e antes da auditoria.
      const result: ToolResult = {
        ...raw,
        content: scrubSecrets(raw.content, resolved.values, '<credencial-omitida>'),
      };

      this.finish(callId, name, tool, input, result, ctx, started, 'executado');
      return result;
    } catch (err) {
      const message = scrubSecrets(describeError(err), secretsUsed, '<credencial-omitida>');
      const result: ToolResult = { ok: false, content: `Erro em ${name}: ${message}` };
      log.warn('ferramenta falhou', { ferramenta: name, erro: message });
      this.finish(callId, name, tool, input, result, ctx, started, 'erro');
      return result;
    }
  }

  private finish(
    callId: string,
    name: string,
    tool: ToolDefinition<any>,
    input: unknown,
    result: ToolResult,
    ctx: ToolContext,
    started: number,
    decision: string,
  ): void {
    const durationMs = Date.now() - started;
    bus.emit('tool:end', {
      conversationId: ctx.conversationId,
      tool: name,
      ok: result.ok,
      summary: clip(result.content, 200),
      id: callId,
    });
    getAudit().record({
      action: `ferramenta.${name}`,
      capability: tool.capability ?? null,
      scope: tool.scopeFrom ? safeScope(tool, input) : null,
      decision,
      ok: result.ok,
      conversationId: ctx.conversationId,
      durationMs,
      // `input` ainda tem as referências {{cofre:…}}, não os valores.
      detail: { argumentos: input, resultado: clip(result.content, 1000) },
    });
  }
}

function safeSummary(tool: ToolDefinition<any>, input: unknown): string {
  try {
    return tool.summarize ? tool.summarize(input) : tool.name;
  } catch {
    return tool.name;
  }
}

/** O texto completo da ação, para a checagem de irreversibilidade. */
function safeDestructiveText(tool: ToolDefinition<any>, input: unknown, fallback: string): string {
  try {
    return tool.destructiveFrom ? tool.destructiveFrom(input) : fallback;
  } catch {
    return fallback;
  }
}

function safeScope(tool: ToolDefinition<any>, input: unknown): string {
  try {
    return tool.scopeFrom ? tool.scopeFrom(input) : '*';
  } catch {
    return '*';
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Corta a saída de uma ferramenta para não estourar o contexto do modelo. */
export function truncateForModel(text: string, maxChars = 24000): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.75));
  const tail = text.slice(-Math.floor(maxChars * 0.15));
  return `${head}\n\n[… ${text.length - head.length - tail.length} caracteres omitidos por tamanho …]\n\n${tail}`;
}

let singleton: ToolRegistry | null = null;

export function getRegistry(): ToolRegistry {
  if (!singleton) singleton = new ToolRegistry();
  return singleton;
}

export function resetRegistryForTests(): void {
  singleton = null;
}
