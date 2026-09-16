/**
 * Arranque.
 *
 * A ordem importa e é sempre esta:
 *
 *   configuração → chaveiro (destrancar) → banco → cofre → auditoria →
 *   permissões → memória → agente → ferramentas → canais → agendador
 *
 * Nada que leia dado cifrado pode subir antes do chaveiro, e nenhum canal pode
 * aceitar mensagem antes de o agente existir. Se a senha-mestra não vier, o
 * processo para aqui — meio sistema no ar seria pior que sistema nenhum.
 */
import 'dotenv/config';
import { loadConfig, paths, saveConfig, type Config } from './config.js';
import { configureLogger, createLogger, describeError } from './util/logger.js';
import { getKeyring } from './core/crypto/keyring.js';
import { randomToken } from './core/crypto/cipher.js';
import { openStore, closeStore } from './core/db/database.js';
import { initVault } from './core/vault/vault.js';
import { initAudit } from './core/permissions/audit.js';
import { initBroker } from './core/permissions/broker.js';
import { initMemory } from './core/memory/index.js';
import { initAgent } from './core/agent/agent.js';
import { registerCoreTools } from './tools/index.js';
import { initHttpChannel, type HttpChannel } from './channels/http/server.js';
import { askSecret } from './util/prompt.js';
import { closeBrowser } from './integrations/browser/browser.js';

const log = createLogger('gideao');

export interface BootOptions {
  /** Não sobe canais nem agendadores — usado pela CLI. */
  headless?: boolean;
  passphrase?: string;
}

export interface BootedSystem {
  url?: string;
  shutdown: () => Promise<void>;
}

export async function boot(opts: BootOptions = {}): Promise<BootedSystem> {
  const cfg = loadConfig();

  configureLogger({
    level: cfg.log.level,
    dir: cfg.log.toFile ? paths(cfg).logs : null,
  });

  // 1. chaveiro
  const keyring = getKeyring(paths(cfg).keyring);
  if (!keyring.exists()) {
    throw new Error(
      'nenhum chaveiro encontrado neste perfil. Rode `npm run setup` para criar a senha-mestra.',
    );
  }
  const passphrase =
    opts.passphrase ?? process.env.GIDEAO_PASSPHRASE ?? (await askSecret('Senha-mestra do Gideão: '));
  keyring.unlock(passphrase);

  // 2. banco e serviços que dependem das chaves
  const store = openStore(paths(cfg).db, keyring);
  initVault(store, keyring);
  const audit = initAudit(store);
  const broker = initBroker(store, audit, cfg);
  const memory = initMemory(store, cfg);
  initAgent(memory, cfg);
  registerCoreTools();

  audit.record({ action: 'sistema.arranque', detail: { versao: 1, modelo: cfg.model.main } });

  if (opts.headless) {
    return { shutdown: () => shutdown(broker) };
  }

  // 3. token de acesso — gerado na primeira execução e guardado
  if (!cfg.server.accessToken) {
    const token = randomToken(24);
    saveConfig({ server: { accessToken: token } });
    cfg.server.accessToken = token;
    log.info('token de acesso gerado para esta instalação');
  }

  // 4. canais — o preparo vem antes da escuta para que os módulos opcionais
  //    consigam pendurar rotas (o webhook do WhatsApp mora aí).
  const http = initHttpChannel(cfg);
  await http.prepare();
  await startOptional(cfg, http);
  const url = await http.listen();

  console.log(`\n  ${cfg.assistantName} está no ar.\n  Abra: ${url}\n`);

  if (cfg.ui.abrirNavegador) {
    const { abrirNoNavegador } = await import('./util/abrir.js');
    if (await abrirNoNavegador(url)) console.log('  (abri no seu navegador)\n');
  }

  const shutdownAll = async () => {
    log.info('encerrando…');
    await http.stop().catch(() => {});
    await shutdown(broker);
  };

  for (const sinal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sinal, () => {
      void shutdownAll().then(() => process.exit(0));
    });
  }

  return { url, shutdown: shutdownAll };
}

/**
 * Sobe o que depende de configuração externa.
 *
 * Falha aqui nunca derruba o sistema: sem WhatsApp configurado ou sem o
 * agendador, o Gideão continua respondendo na tela. Cada módulo é carregado sob
 * demanda para que uma dependência opcional ausente não custe nada no arranque.
 */
async function startOptional(cfg: Config, http: HttpChannel): Promise<void> {
  for (const [nome, fn] of optionalModules(cfg, http)) {
    try {
      await fn();
    } catch (err) {
      log.warn(`módulo "${nome}" não subiu`, { erro: describeError(err) });
    }
  }
}

type OptionalModule = [string, () => Promise<void>];

/** Registrado por etapa: cada módulo entra aqui quando fica pronto. */
function optionalModules(cfg: Config, http: HttpChannel): OptionalModule[] {
  const modulos: OptionalModule[] = [];

  modulos.push([
    'agendador',
    async () => {
      const { startScheduler, stopScheduler } = await import('./core/scheduler/scheduler.js');
      await startScheduler(cfg);
      onShutdown(() => stopScheduler());
    },
  ]);

  if (cfg.observer.enabled) {
    modulos.push([
      'observador',
      async () => {
        const { startObserver, stopObserver } = await import('./observer/index.js');
        await startObserver(cfg);
        onShutdown(() => stopObserver());
      },
    ]);
  }

  if (cfg.whatsapp.enabled) {
    modulos.push([
      'whatsapp',
      async () => {
        const { startWhatsApp } = await import('./channels/whatsapp/index.js');
        const canal = await startWhatsApp(cfg, http.fastify);
        onShutdown(() => canal.stop());
      },
    ]);
  }

  return modulos;
}

/** Desligamentos de módulos opcionais, na ordem inversa da subida. */
const shutdownHooks: Array<() => void | Promise<void>> = [];

export function onShutdown(fn: () => void | Promise<void>): void {
  shutdownHooks.push(fn);
}

async function shutdown(broker: ReturnType<typeof initBroker>): Promise<void> {
  for (const hook of shutdownHooks.reverse()) {
    try {
      await hook();
    } catch (err) {
      log.warn('erro ao desligar um módulo', { erro: describeError(err) });
    }
  }
  shutdownHooks.length = 0;
  broker.shutdown();
  await closeBrowser().catch(() => {});
  getKeyring().lock();
  closeStore();
}

// Executado diretamente (npm start), não importado pela CLI.
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ''));
if (isMain) {
  boot().catch((err) => {
    console.error(`\n  Não consegui iniciar: ${describeError(err)}\n`);
    process.exit(1);
  });
}
