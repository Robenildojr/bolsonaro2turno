/**
 * Montagem do conjunto de ferramentas.
 *
 * A ordem de registro não importa (o registry ordena alfabeticamente antes de
 * enviar à API, para o cache de prompt não quebrar), mas a composição sim:
 * módulos que dependem de integração opcional só entram se a integração existir.
 */
import { getRegistry, type ToolDefinition } from '../core/agent/tools.js';
import { createLogger } from '../util/logger.js';
import { browserTools } from './browser.tools.js';
import { fsTools } from './fs.tools.js';
import { memoryTools } from './memory.tools.js';
import { shellTools } from './shell.tools.js';
import { systemTools } from './system.tools.js';
import { vaultTools } from './vault.tools.js';
import { webTools } from './web.tools.js';

const log = createLogger('ferramentas');

export interface ToolSetOptions {
  /** Ferramentas que dependem de módulos carregados depois (agenda, e-mail, justiça, WhatsApp). */
  extra?: Array<ToolDefinition<any>>;
}

export function registerCoreTools(opts: ToolSetOptions = {}): void {
  const registry = getRegistry();
  const all = [
    ...fsTools,
    ...shellTools,
    ...browserTools,
    ...webTools,
    ...memoryTools,
    ...vaultTools,
    ...systemTools,
    ...(opts.extra ?? []),
  ];

  for (const tool of all) {
    if (registry.get(tool.name)) continue; // recarga em desenvolvimento
    registry.register(tool);
  }
  log.info('ferramentas registradas', { total: registry.names().length, nomes: registry.names() });
}

export {
  browserTools,
  fsTools,
  memoryTools,
  shellTools,
  systemTools,
  vaultTools,
  webTools,
};
