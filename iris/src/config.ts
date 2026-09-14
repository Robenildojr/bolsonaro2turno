/**
 * Configuração central da Íris.
 *
 * Três camadas, da mais fraca para a mais forte:
 *   1. padrões embutidos
 *   2. arquivo mutável em $IRIS_HOME/config.json  (a própria Íris pode alterar)
 *   3. variáveis de ambiente / .env               (sempre vencem)
 *
 * Segredos (chaves de API, senhas) nunca são gravados no config.json — eles
 * vivem no ambiente ou no cofre criptografado (core/vault).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const bool = (fallback: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return fallback;
      if (typeof v === 'boolean') return v;
      return ['1', 'true', 'yes', 'sim', 'on'].includes(v.toLowerCase());
    });

const num = (fallback: number) =>
  z
    .union([z.number(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return fallback;
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : fallback;
    });

export const ConfigSchema = z.object({
  /** Nome pelo qual a assistente se apresenta. */
  assistantName: z.string().default('Íris'),
  /** Como a Íris deve chamar o dono. */
  ownerName: z.string().default('você'),
  /** Fuso horário usado em lembretes, agenda e carimbos de memória. */
  timezone: z.string().default('America/Sao_Paulo'),
  /** Idioma principal da conversa. */
  locale: z.string().default('pt-BR'),

  /** Diretório raiz de dados (banco, chaves, cache). */
  home: z.string(),

  model: z.object({
    /** Modelo principal do diálogo. */
    main: z.string().default('claude-opus-5'),
    /** Modelo das tarefas de bastidor (consolidação de memória, resumos). */
    background: z.string().default('claude-opus-5'),
    /** low | medium | high | xhigh | max */
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
    maxTokens: num(32000),
    /** Compaction server-side: conversas sem limite de tamanho. */
    compaction: bool(true),
    /**
     * Busca e leitura na internet executadas no servidor da Anthropic.
     * É por aqui que ela "aprende com a internet" no dia a dia, com citação da
     * fonte. Desligue se preferir que toda saída para a web parta da sua máquina
     * (aí sobra a ferramenta `baixar_pagina`, que pede autorização por domínio).
     */
    webSearch: bool(true),
  })
    .default({}),

  server: z.object({
    host: z.string().default('127.0.0.1'),
    port: num(4319),
    /** Token de acesso à UI local. Gerado no setup se ausente. */
    accessToken: z.string().optional(),
  })
    .default({}),

  memory: z.object({
    /** Nº de memórias recuperadas e injetadas por turno. */
    retrievalLimit: num(24),
    /** Mensagens recentes mantidas na janela quente antes da compactação. */
    hotWindow: num(40),
    /** Extrai aprendizados a cada N turnos do usuário. */
    reflectEveryTurns: num(4),
    /** Provedor de embeddings: 'local' (offline) ou 'voyage'. */
    embeddings: z.enum(['local', 'voyage']).default('local'),
    embeddingModel: z.string().default('voyage-3'),
    /** Consolidação noturna (cron). */
    consolidationCron: z.string().default('0 3 * * *'),
  })
    .default({}),

  permissions: z.object({
    /**
     * Quando o dono autoriza uma capacidade, ela fica valendo para sempre
     * (é exatamente o comportamento pedido: autorizou uma vez, não pergunta mais).
     */
    rememberGrants: bool(true),
    /**
     * Ações irreversíveis (apagar em massa, formatar, enviar dinheiro,
     * falar com terceiros) continuam pedindo confirmação, mesmo autorizadas.
     * Pode ser desligado pelo dono — veja docs/PERMISSOES.md.
     */
    confirmCritical: bool(true),
    /** Segundos até um pedido de permissão sem resposta ser negado. */
    requestTimeoutSec: num(300),
  })
    .default({}),

  whatsapp: z.object({
    enabled: bool(false),
    /** 'cloud' (API oficial da Meta) | 'baileys' (número pessoal, não oficial) */
    provider: z.enum(['cloud', 'baileys']).default('cloud'),
    /** Número do dono em formato E.164 sem '+' (ex.: 5596991234567). */
    owner: z.string().default(''),
    phoneNumberId: z.string().default(''),
    accessToken: z.string().default(''),
    verifyToken: z.string().default(''),
    appSecret: z.string().default(''),
    graphVersion: z.string().default('v21.0'),
  })
    .default({}),

  drive: z.object({
    enabled: bool(false),
    folderName: z.string().default('Íris — Memória (criptografada)'),
    /** Cron do backup cifrado. */
    backupCron: z.string().default('0 */6 * * *'),
    clientId: z.string().default(''),
    clientSecret: z.string().default(''),
  })
    .default({}),

  email: z.object({
    enabled: bool(false),
    imapHost: z.string().default(''),
    imapPort: num(993),
    smtpHost: z.string().default(''),
    smtpPort: num(465),
    user: z.string().default(''),
    /** A senha fica no cofre, nunca aqui. */
    pollCron: z.string().default('*/10 * * * *'),
  })
    .default({}),

  justice: z.object({
    enabled: bool(true),
    /** Chave pública da API DataJud do CNJ (documentada e aberta). */
    datajudApiKey: z.string().default(''),
    monitorCron: z.string().default('0 8,14,19 * * *'),
  })
    .default({}),

  observer: z.object({
    /** NUNCA liga sozinho. Requer consentimento explícito do dono. */
    enabled: bool(false),
    clipboard: bool(false),
    activeWindow: bool(false),
    intervalMs: num(2500),
    /** Trechos que batem com estes padrões nunca são gravados. */
    redactPatterns: z
      .array(z.string())
      .default([
        '(?i)senha\\s*[:=]',
        '(?i)password\\s*[:=]',
        '(?i)secret\\s*[:=]',
        '(?i)api[_-]?key\\s*[:=]',
        'sk-[A-Za-z0-9_\\-]{16,}',
        '\\b\\d{13,19}\\b',
      ]),
  })
    .default({}),

  log: z.object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
    /** Grava log em arquivo além do console. */
    toFile: bool(true),
  })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

function defaultHome(): string {
  return process.env.IRIS_HOME || path.join(os.homedir(), '.iris');
}

function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function deepMerge<T extends Record<string, any>>(base: T, extra: Record<string, any>): T {
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k]) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/** Recorta apenas as variáveis de ambiente definidas, montando o objeto de override. */
function fromEnv(): Record<string, any> {
  const e = process.env;
  const pick = (v: string | undefined) => (v === undefined || v === '' ? undefined : v);
  return {
    assistantName: pick(e.IRIS_NAME),
    ownerName: pick(e.IRIS_OWNER_NAME),
    timezone: pick(e.IRIS_TZ),
    locale: pick(e.IRIS_LOCALE),
    model: {
      main: pick(e.IRIS_MODEL),
      background: pick(e.IRIS_MODEL_BACKGROUND),
      effort: pick(e.IRIS_EFFORT),
      maxTokens: pick(e.IRIS_MAX_TOKENS),
      compaction: pick(e.IRIS_COMPACTION),
      webSearch: pick(e.IRIS_WEB_SEARCH),
    },
    server: {
      host: pick(e.IRIS_HOST),
      port: pick(e.IRIS_PORT),
      accessToken: pick(e.IRIS_ACCESS_TOKEN),
    },
    memory: {
      embeddings: pick(e.IRIS_EMBEDDINGS),
      retrievalLimit: pick(e.IRIS_RETRIEVAL_LIMIT),
      hotWindow: pick(e.IRIS_HOT_WINDOW),
    },
    permissions: {
      rememberGrants: pick(e.IRIS_REMEMBER_GRANTS),
      confirmCritical: pick(e.IRIS_CONFIRM_CRITICAL),
    },
    whatsapp: {
      enabled: pick(e.WHATSAPP_ENABLED),
      provider: pick(e.WHATSAPP_PROVIDER),
      owner: pick(e.WHATSAPP_OWNER),
      phoneNumberId: pick(e.WHATSAPP_PHONE_NUMBER_ID),
      accessToken: pick(e.WHATSAPP_ACCESS_TOKEN),
      verifyToken: pick(e.WHATSAPP_VERIFY_TOKEN),
      appSecret: pick(e.WHATSAPP_APP_SECRET),
      graphVersion: pick(e.WHATSAPP_GRAPH_VERSION),
    },
    drive: {
      enabled: pick(e.DRIVE_ENABLED),
      clientId: pick(e.DRIVE_CLIENT_ID),
      clientSecret: pick(e.DRIVE_CLIENT_SECRET),
      folderName: pick(e.DRIVE_FOLDER_NAME),
    },
    email: {
      enabled: pick(e.EMAIL_ENABLED),
      imapHost: pick(e.EMAIL_IMAP_HOST),
      imapPort: pick(e.EMAIL_IMAP_PORT),
      smtpHost: pick(e.EMAIL_SMTP_HOST),
      smtpPort: pick(e.EMAIL_SMTP_PORT),
      user: pick(e.EMAIL_USER),
    },
    justice: {
      datajudApiKey: pick(e.DATAJUD_API_KEY),
    },
    log: {
      level: pick(e.IRIS_LOG_LEVEL),
    },
  };
}

let cached: Config | null = null;

export function configPath(home = defaultHome()): string {
  return path.join(home, 'config.json');
}

export function loadConfig(opts: { reload?: boolean } = {}): Config {
  if (cached && !opts.reload) return cached;

  const home = defaultHome();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });

  const fileCfg = readJson(configPath(home));
  const merged = deepMerge(deepMerge({ home }, fileCfg), fromEnv());
  (merged as Record<string, unknown>).home = home;

  cached = ConfigSchema.parse(merged);
  return cached;
}

/** Grava alterações persistentes (sem segredos) no config.json. */
export function saveConfig(patch: Record<string, unknown>): Config {
  const home = defaultHome();
  const file = configPath(home);
  const current = readJson(file);
  const next = deepMerge(current, patch);
  delete (next as Record<string, unknown>).home;
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
  return loadConfig({ reload: true });
}

export function paths(cfg: Config = loadConfig()) {
  return {
    home: cfg.home,
    db: path.join(cfg.home, 'iris.db'),
    keyring: path.join(cfg.home, 'keyring.json'),
    logs: path.join(cfg.home, 'logs'),
    cache: path.join(cfg.home, 'cache'),
    backups: path.join(cfg.home, 'backups'),
    browser: path.join(cfg.home, 'browser-profile'),
    whatsappSession: path.join(cfg.home, 'whatsapp-session'),
  };
}
