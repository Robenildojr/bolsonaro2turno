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
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../util/logger.js';

const execAsync = promisify(exec);
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

async function rodar(comando: string, timeoutMs = 3000): Promise<string | null> {
  try {
    const { stdout } = await execAsync(comando, {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8',
    });
    return stdout;
  } catch {
    return null;
  }
}

async function existe(comando: string): Promise<boolean> {
  const busca = process.platform === 'win32' ? `where ${comando}` : `command -v ${comando}`;
  return (await rodar(busca, 2000)) !== null;
}

// ── área de transferência ────────────────────────────────────────────────────

export async function lerClipboard(): Promise<string | null> {
  switch (process.platform) {
    case 'darwin':
      return rodar('pbpaste');

    case 'win32':
      return rodar(
        'powershell -NoProfile -NonInteractive -Command "Get-Clipboard -Raw"',
        5000,
      );

    default: {
      // Wayland primeiro: em sessão Wayland o xclip devolve vazio em silêncio.
      if (process.env.WAYLAND_DISPLAY) {
        const wl = await rodar('wl-paste --no-newline');
        if (wl !== null) return wl;
      }
      const xclip = await rodar('xclip -selection clipboard -o');
      if (xclip !== null) return xclip;
      return rodar('xsel --clipboard --output');
    }
  }
}

// ── janela ativa ─────────────────────────────────────────────────────────────

export async function lerJanelaAtiva(): Promise<string | null> {
  switch (process.platform) {
    case 'darwin': {
      const script =
        'tell application "System Events" to get name of first application process whose frontmost is true';
      const app = await rodar(`osascript -e '${script}'`, 4000);
      if (!app) return null;

      // O título do documento costuma dizer mais que o nome do aplicativo.
      const titulo = await rodar(
        `osascript -e 'tell application "System Events" to tell process "${app.trim()}" to get title of front window'`,
        4000,
      );
      return titulo?.trim() ? `${app.trim()} — ${titulo.trim()}` : app.trim();
    }

    case 'win32':
      return rodar(
        'powershell -NoProfile -NonInteractive -Command "' +
          "Add-Type -AssemblyName System.Windows.Forms; " +
          "$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | " +
          'Select-Object -First 1; if ($p) { "$($p.ProcessName) — $($p.MainWindowTitle)" }"',
        6000,
      );

    default: {
      const xdotool = await rodar('xdotool getactivewindow getwindowname');
      if (xdotool !== null) return xdotool;

      // Alternativa sem xdotool, usando as ferramentas básicas do X.
      const id = await rodar("xprop -root _NET_ACTIVE_WINDOW | awk '{print $NF}'");
      if (!id?.trim() || id.includes('0x0')) return null;
      const nome = await rodar(`xprop -id ${id.trim()} WM_NAME`);
      const m = nome ? /"(.*)"/.exec(nome) : null;
      return m?.[1] ?? null;
    }
  }
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
        wayland
          ? 'wl-clipboard (sudo apt install wl-clipboard)'
          : 'xclip (sudo apt install xclip)',
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
