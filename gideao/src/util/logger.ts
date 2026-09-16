/**
 * Logger minimalista, sem dependências: console colorido + arquivo diário.
 * Todo payload passa pela redação antes de ser escrito.
 */
import fs from 'node:fs';
import path from 'node:path';
import { redact } from './redact.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
const COLOR: Record<LogLevel, string> = {
  trace: '\x1b[90m',
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

let minLevel: LogLevel = 'info';
let fileStream: fs.WriteStream | null = null;
let currentDay = '';
let logDir: string | null = null;

export function configureLogger(opts: { level?: LogLevel; dir?: string | null }): void {
  if (opts.level) minLevel = opts.level;
  if (opts.dir === null) {
    fileStream?.end();
    fileStream = null;
    logDir = null;
  } else if (opts.dir) {
    logDir = opts.dir;
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  }
}

function stream(): fs.WriteStream | null {
  if (!logDir) return null;
  const day = new Date().toISOString().slice(0, 10);
  if (day !== currentDay || !fileStream) {
    fileStream?.end();
    currentDay = day;
    fileStream = fs.createWriteStream(path.join(logDir, `gideao-${day}.log`), {
      flags: 'a',
      mode: 0o600,
    });
  }
  return fileStream;
}

function write(level: LogLevel, scope: string, msg: string, data?: unknown): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const ts = new Date().toISOString();
  const safe = data === undefined ? undefined : redact(data);

  const line = `${COLOR[level]}${level.toUpperCase().padEnd(5)}\x1b[0m \x1b[90m${ts}\x1b[0m [${scope}] ${msg}`;
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(line + (safe === undefined ? '' : ' ' + safeStringify(safe)) + '\n');

  stream()?.write(
    JSON.stringify({ ts, level, scope, msg, ...(safe === undefined ? {} : { data: safe }) }) + '\n',
  );
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export interface Logger {
  trace(msg: string, data?: unknown): void;
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    trace: (m, d) => write('trace', scope, m, d),
    debug: (m, d) => write('debug', scope, m, d),
    info: (m, d) => write('info', scope, m, d),
    warn: (m, d) => write('warn', scope, m, d),
    error: (m, d) => write('error', scope, m, d),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

/** Normaliza qualquer erro em algo logável e apresentável ao usuário. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  return safeStringify(err);
}
