/**
 * Cliente da API da Anthropic, compartilhado entre o agente e as tarefas de
 * bastidor (reflexão, consolidação, resumos).
 *
 * Aqui ficam só as chamadas simples e utilitárias. O laço conversacional com
 * streaming e ferramentas vive em core/agent/agent.ts.
 */
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.js';
import { createLogger, describeError } from '../util/logger.js';

const log = createLogger('llm');

let client: Anthropic | null = null;

export function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      log.warn('ANTHROPIC_API_KEY não definida — o SDK vai tentar o perfil de `ant auth login`');
    }
    client = new Anthropic({ maxRetries: 3, timeout: 10 * 60_000 });
  }
  return client;
}

/** Resposta em texto simples, sem ferramentas. Para tarefas de bastidor. */
export async function complete(opts: {
  system: string;
  prompt: string;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  model?: string;
}): Promise<string> {
  const cfg = loadConfig();
  const res = await getClient().messages.create({
    model: opts.model ?? cfg.model.background,
    max_tokens: opts.maxTokens ?? 8000,
    system: opts.system,
    thinking: { type: 'adaptive' },
    output_config: { effort: opts.effort ?? 'medium' },
    messages: [{ role: 'user', content: opts.prompt }],
  });

  if (res.stop_reason === 'refusal') {
    log.warn('modelo recusou a tarefa de bastidor', { categoria: res.stop_details?.category });
    return '';
  }
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Extração estruturada: força uma chamada de ferramenta com `strict: true`,
 * que garante que os argumentos batem exatamente com o schema. É mais
 * confiável do que pedir JSON em texto e torcer.
 */
export async function extractStructured<T>(opts: {
  system: string;
  prompt: string;
  toolName: string;
  toolDescription: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  model?: string;
}): Promise<T | null> {
  const cfg = loadConfig();
  try {
    const res = await getClient().messages.create({
      model: opts.model ?? cfg.model.background,
      max_tokens: opts.maxTokens ?? 8000,
      system: opts.system,
      thinking: { type: 'adaptive' },
      output_config: { effort: opts.effort ?? 'medium' },
      tools: [
        {
          name: opts.toolName,
          description: opts.toolDescription,
          input_schema: opts.schema as Anthropic.Tool.InputSchema,
          strict: true,
        },
      ],
      tool_choice: { type: 'tool', name: opts.toolName },
      messages: [{ role: 'user', content: opts.prompt }],
    });

    const block = res.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === opts.toolName,
    );
    return block ? (block.input as T) : null;
  } catch (err) {
    log.error('falha na extração estruturada', { tool: opts.toolName, erro: describeError(err) });
    return null;
  }
}

/** Conta tokens de um texto usando a própria API — sem heurística de caractere. */
export async function countTokens(text: string, model?: string): Promise<number> {
  const cfg = loadConfig();
  try {
    const res = await getClient().messages.countTokens({
      model: model ?? cfg.model.main,
      messages: [{ role: 'user', content: text }],
    });
    return res.input_tokens;
  } catch {
    // Estimativa grosseira de emergência: ~3,6 caracteres por token em português.
    return Math.ceil(text.length / 3.6);
  }
}

export function resetClientForTests(): void {
  client = null;
}
