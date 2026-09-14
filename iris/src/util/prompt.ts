/** Entrada pelo terminal, incluindo senha sem eco na tela. */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Lê sem mostrar o que é digitado. */
export async function askSecret(question: string): Promise<string> {
  if (!stdin.isTTY) {
    // Sem terminal interativo (systemd, docker): lê uma linha da entrada padrão.
    return ask(question);
  }

  return new Promise((resolve, reject) => {
    stdout.write(question);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        switch (ch) {
          case '\n':
          case '\r':
          case '\u0004': // Ctrl-D
            cleanup();
            stdout.write('\n');
            resolve(value);
            return;
          case '\u0003': // Ctrl-C
            cleanup();
            stdout.write('\n');
            reject(new Error('cancelado'));
            return;
          case '\u007f': // backspace
          case '\b':
            value = value.slice(0, -1);
            break;
          default:
            if (ch >= ' ' && ch !== '\u007f') value += ch;
        }
      }
    };

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    stdin.on('data', onData);
  });
}

export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  const suffix = defaultYes ? ' [S/n] ' : ' [s/N] ';
  const answer = (await ask(question + suffix)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === 's' || answer === 'sim' || answer === 'y' || answer === 'yes';
}

/** Escolha numerada. Devolve o índice escolhido. */
export async function choose(question: string, options: string[], defaultIndex = 0): Promise<number> {
  stdout.write(`${question}\n`);
  options.forEach((opt, i) => stdout.write(`  ${i + 1}) ${opt}\n`));
  const answer = await ask(`Escolha [${defaultIndex + 1}]: `);
  if (!answer) return defaultIndex;
  const n = Number(answer);
  if (!Number.isInteger(n) || n < 1 || n > options.length) return defaultIndex;
  return n - 1;
}
