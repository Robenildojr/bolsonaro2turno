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
import { createHash } from 'node:crypto';
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

/**
 * Programas que executam **outro** programa. O escopo precisa atravessá-los.
 *
 * Sem isto, autorizar `env LANG=C pdftotext …` uma vez com "sempre" gravaria a
 * autorização no nome `env` — e `env sh -c 'curl … | sh'` passaria direto,
 * porque também começa com `env`. O mesmo vale para `sudo`, que seria ainda
 * pior. A promessa da documentação ("autorizar sempre para git não libera rm")
 * só se sustenta se o escopo for o programa que de fato roda.
 */
const INVOLUCROS = new Set([
  'sudo',
  'doas',
  'env',
  'nohup',
  'nice',
  'ionice',
  'setsid',
  'stdbuf',
  'time',
  'timeout',
  'xargs',
  'command',
  'exec',
]);

/**
 * O programa que realmente será executado, para servir de escopo.
 *
 * Deriva de `splitArgs` — os mesmos tokens que vão para o `spawn` — e não de um
 * split por espaço à parte: duas formas diferentes de separar abririam a porta
 * para o escopo divergir do que executa.
 */
export function commandScope(comando: string, usarShell: boolean): string {
  if (usarShell) return escopoDeLinhaInteira(comando);

  const tokens = splitArgs(comando);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue; // VAR=valor
    if (!INVOLUCROS.has(basename(token))) return basename(token);
    // É invólucro: pula as opções dele até achar o programa de verdade.
    for (i++; i < tokens.length; i++) {
      const proximo = tokens[i]!;
      if (proximo.startsWith('-')) continue;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(proximo)) continue;
      // `timeout 30 curl …`: o argumento numérico é do invólucro, não o alvo.
      if (/^\d+(\.\d+)?[smhd]?$/.test(proximo)) continue;
      i--;
      break;
    }
  }
  return comando.trim().slice(0, 60) || '(vazio)';
}

/** `/usr/bin/curl` e `curl` são o mesmo programa para efeito de autorização. */
function basename(token: string): string {
  const corte = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  return corte >= 0 ? token.slice(corte + 1) : token;
}

/**
 * Com shell, o escopo é a linha inteira. Linhas longas ganham um resumo
 * criptográfico no fim: cortar em 200 caracteres faria dois comandos com o
 * mesmo prefixo compartilharem a mesma autorização gravada.
 */
function escopoDeLinhaInteira(comando: string): string {
  const limpo = comando.trim();
  if (limpo.length <= 200) return limpo;
  const resumo = createHash('sha256').update(limpo).digest('hex').slice(0, 12);
  return `${limpo.slice(0, 180)}…#${resumo}`;
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
  // O escopo é só o programa; a avaliação de irreversibilidade precisa da linha.
  destructiveFrom: (i) => i.comando,
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
