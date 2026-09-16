/**
 * Fazer um ajuste valer agora, sem reiniciar.
 *
 * Os módulos de longa vida — agente, portão de permissões, agendador — guardam
 * a configuração que leram na largada. Sem este empurrão, mudar a voz ou o nome
 * na engrenagem gravaria em `config.json` e não mudaria nada até o próximo
 * `npm start`, o que faz o painel parecer quebrado.
 *
 * Fica separado de `ajustes.ts` de propósito: aquele arquivo é a lista do que
 * pode mudar e não deve depender do agente nem do servidor, ou a CLI passaria a
 * carregar o sistema inteiro para mudar a cor do orbe.
 */
import { loadConfig, type Config } from '../../config.js';
import { createLogger, describeError } from '../../util/logger.js';

const log = createLogger('ajustes');

export async function recarregarNoVivo(): Promise<Config> {
  const cfg = loadConfig({ reload: true });

  // Import dinâmico: quem só quer ler ajustes não precisa carregar o agente.
  await Promise.all([
    aplicar('portão de permissões', async () => {
      const { getBroker } = await import('../permissions/broker.js');
      getBroker().refreshConfig(cfg);
    }),
    aplicar('agente', async () => {
      const { getAgent } = await import('../agent/agent.js');
      getAgent().refreshConfig(cfg);
    }),
  ]);

  return cfg;
}

/** Um módulo fora do ar não pode derrubar o ajuste dos outros. */
async function aplicar(nome: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.debug(`${nome} não recarregado`, { erro: describeError(err) });
  }
}
