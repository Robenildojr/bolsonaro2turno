/**
 * Terminal.
 *
 * O escopo da autorização é o **primeiro token** do comando (`git`, `ls`,
 * `pdftotext`). Assim autorizar "sempre" para `git` não libera `rm`, e a
 * liberação vai acontecendo programa a programa, conforme o uso.
 *
 * O comando roda sem shell interpretador por padrão para evitar que `;` e `|`
 * escondam um segundo comando fora do escopo autorizado. Quando o dono
 * realmente precisa de pipe, existe `usar_shell: true` — e aí o escopo passa a
 * ser a linha inteira, para a autorização não ser mais larga do que parece.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import { z } from 'zod';
import { resolvePath } from './fs.tools.js';
import type { ToolDefinition } from '../core/agent/tools.js';
import { truncateForModel } from '../core/agent/tools.js';

interface ShellInput {
  comando: string;
  pasta: string;
  usar_shell: boolean;
  segundos: number;
}

/** Primeiro token real do comando, ignorando prefixos de ambiente. */
export function commandScope(comando: string, usarShell: boolean): string {
  if (usarShell) return comando.trim().slice(0, 200);
  const tokens = comando.trim().split(/\s+/);
  for (const token of tokens) {
    if (/^[A-Z_][A-Z0-9_]*=/.test(token)) continue; // VAR=valor
    if (token === 'sudo' || token === 'env' || token === 'nohup') return token;
    return token;
  }
  return comando.trim().slice(0, 60);
}

/** Divide respeitando aspas, sem invocar shell. */
export function splitArgs(comando: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const ch of comando.trim()) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

const executarComando: ToolDefinition<ShellInput> = {
  name: 'executar_comando',
  description:
    'Roda um comando no terminal do computador e devolve a saída. Por padrão o comando é executado diretamente, sem interpretador: se precisar de pipe, redirecionamento ou encadeamento, marque usar_shell.',
  capability: 'shell.executar',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['comando', 'pasta', 'usar_shell', 'segundos'],
    properties: {
      comando: { type: 'string', description: 'A linha de comando completa.' },
      pasta: { type: 'string', description: 'Pasta onde rodar. Vazio = pasta do usuário.' },
      usar_shell: {
        type: 'boolean',
        description:
          'true só quando precisar de recurso do shell (| > && ;). Amplia o escopo da autorização, então use apenas quando necessário.',
      },
      segundos: { type: 'integer', description: 'Tempo máximo de execução. 0 = usar o padrão de 60 s.' },
    },
  },
  validate: z.object({
    comando: z.string().min(1).max(8000),
    pasta: z.string(),
    usar_shell: z.boolean(),
    segundos: z.number().int().min(0).max(600),
  }),
  scopeFrom: (i) => commandScope(i.comando, i.usar_shell),
  summarize: (i) => `executar: ${i.comando.slice(0, 160)}`,
  timeoutMs: 620_000,
  async run(input, ctx) {
    const cwd = input.pasta ? resolvePath(input.pasta) : os.homedir();
    const timeoutMs = (input.segundos || 60) * 1000;

    const args = input.usar_shell ? [] : splitArgs(input.comando);
    const program = input.usar_shell ? input.comando : args[0];
    if (!program) throw new Error('comando vazio');

    return new Promise((resolve) => {
      const child = input.usar_shell
        ? spawn(input.comando, { cwd, shell: true, env: process.env })
        : spawn(program, args.slice(1), { cwd, env: process.env });

      let stdout = '';
      let stderr = '';
      let finished = false;
      const cap = 400_000;

      const timer = setTimeout(() => {
        if (!finished) {
          child.kill('SIGKILL');
          finished = true;
          resolve({
            ok: false,
            content: `O comando passou de ${input.segundos || 60}s e foi encerrado.\n\nSaída até ali:\n${truncateForModel(stdout + stderr)}`,
          });
        }
      }, timeoutMs);

      const onAbort = () => {
        child.kill('SIGKILL');
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (d: Buffer) => {
        if (stdout.length < cap) stdout += d.toString('utf8');
      });
      child.stderr?.on('data', (d: Buffer) => {
        if (stderr.length < cap) stderr += d.toString('utf8');
      });

      child.on('error', (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        const msg = /ENOENT/.test(err.message)
          ? `comando não encontrado: ${program}`
          : err.message;
        resolve({ ok: false, content: `Não consegui executar — ${msg}` });
      });

      child.on('close', (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);

        const partes: string[] = [];
        if (stdout.trim()) partes.push(stdout.trim());
        if (stderr.trim()) partes.push(`[erro padrão]\n${stderr.trim()}`);
        const saida = partes.join('\n\n') || '(sem saída)';

        resolve({
          ok: code === 0,
          content:
            code === 0
              ? truncateForModel(saida)
              : `Código de saída ${code}.\n\n${truncateForModel(saida)}`,
          data: { code },
        });
      });
    });
  },
};

export const shellTools: Array<ToolDefinition<any>> = [executarComando];
