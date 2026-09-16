/**
 * Abrir a interface no navegador, sozinho.
 *
 * Parece conveniência e não é: o endereço do Gideão carrega o token de acesso,
 * e sem o token a página responde "acesso negado". Isso significa que, sem esta
 * função, todo arranque termina com o dono garimpando uma linha no meio do log
 * do terminal para copiar uma URL de oitenta caracteres. Na instalação real
 * isso aconteceu três vezes antes de alguém reparar que o problema não era o
 * dono — era o passo.
 *
 * O token some da barra de endereço assim que a página carrega (a interface o
 * guarda e limpa a URL), então ele não fica no histórico do navegador.
 *
 * Nada aqui passa por shell: `execFile` com argumentos em vetor, como no resto
 * do sistema. E o endereço é conferido antes de sair daqui — abrir no navegador
 * é entregar uma URL ao sistema operacional, e isso só vale para o endereço
 * local do próprio Gideão.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger, describeError } from './logger.js';

const execFileAsync = promisify(execFile);
const log = createLogger('navegador');

/** Só o endereço local do próprio Gideão. Qualquer outra coisa não abre. */
export function enderecoLocalSeguro(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname);
  } catch {
    return false;
  }
}

export async function abrirNoNavegador(url: string): Promise<boolean> {
  if (!enderecoLocalSeguro(url)) {
    log.warn('recusei abrir um endereço que não é o local', { url });
    return false;
  }

  const [programa, args] =
    process.platform === 'win32'
      ? // O `start` é embutido do cmd, e o "" é o título da janela — sem ele, o
        // cmd trataria a URL como título e não abriria nada.
        (['cmd', ['/c', 'start', '', url]] as const)
      : process.platform === 'darwin'
        ? (['open', [url]] as const)
        : (['xdg-open', [url]] as const);

  try {
    await execFileAsync(programa, [...args], { timeout: 10_000 });
    return true;
  } catch (err) {
    // Máquina sem navegador padrão, servidor sem ambiente gráfico: o endereço
    // continua no terminal, então falhar aqui não é motivo para alarme.
    log.debug('não consegui abrir o navegador', { erro: describeError(err) });
    return false;
  }
}
