/**
 * Atualização contínua — as três frentes juntas.
 *
 * O dono pediu que o Gideão "não fique defasado". Isso se decompõe em três
 * coisas muito diferentes, e tratá-las como se fossem a mesma é o erro que
 * este arquivo existe para evitar:
 *
 *   | frente        | o que entra        | roda sozinho? |
 *   |---------------|--------------------|---------------|
 *   | conhecimento  | informação         | sim           |
 *   | modelo        | nada — só um aviso | sim (o aviso) |
 *   | código        | programa novo      | **não**       |
 *
 * Informação entrando sozinha é inofensiva: no pior caso ele aprende uma
 * bobagem, e o dono corrige. Programa entrando sozinho é outra história — quem
 * controla a origem do código controla a máquina, o cofre e o e-mail. Daí a
 * assimetria: os dois primeiros acontecem enquanto o dono dorme, o terceiro
 * espera ele acordar.
 */
import { bus } from '../events/bus.js';
import { loadConfig } from '../../config.js';
import { createLogger, describeError } from '../../util/logger.js';
import * as codigo from './codigo.js';
import * as modelo from './modelo.js';
import { estudar } from './conhecimento.js';

export { codigo, modelo, estudar };

const log = createLogger('atualizacao');

/** Roda o estudo noturno e avisa só quando encontrou alguma coisa. */
export async function rotinaConhecimento(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.updates.conhecimento) return;

  try {
    const r = await estudar();
    if (!r.gravadas) return; // silêncio quando não há novidade é o certo

    bus.emit('notify', {
      id: `estudo_${Date.now()}`,
      title: 'Aprendi coisa nova',
      body: r.novidades
        .slice(0, 5)
        .map((n) => `• ${n.assunto}`)
        .join('\n'),
      kind: 'estudo',
      urgency: 'low',
    });
  } catch (err) {
    log.warn('rotina de conhecimento falhou', { erro: describeError(err) });
  }
}

/** Confere código e modelo, e avisa quando houver o que decidir. */
export async function rotinaVersoes(): Promise<void> {
  const cfg = loadConfig();
  const partes: string[] = [];

  if (cfg.updates.codigo) {
    try {
      const c = await codigo.verificar();
      if (c.pendentes.length) {
        partes.push(
          `Tem ${c.pendentes.length} atualização(ões) de código esperando:\n` +
            c.pendentes
              .slice(0, 5)
              .map((p) => `• ${p.assunto}`)
              .join('\n') +
            '\n\nMe manda aplicar que eu rodo os testes antes de assumir.',
        );
      }
    } catch (err) {
      log.debug('verificação de código falhou', { erro: describeError(err) });
    }
  }

  if (cfg.updates.modelo) {
    try {
      const m = await modelo.verificar();
      if (m.erro) partes.push(`Sobre o modelo: ${m.erro}`);
      else if (m.maisNovos.length) {
        partes.push(
          `Saiu modelo mais novo que o meu (${m.emUso}): ` +
            m.maisNovos
              .slice(0, 3)
              .map((x) => x.nome)
              .join(', ') +
            '. Se quiser trocar, é na engrenagem ou é só me pedir.',
        );
      }
    } catch (err) {
      log.debug('verificação de modelo falhou', { erro: describeError(err) });
    }
  }

  if (!partes.length) return;

  bus.emit('notify', {
    id: `versoes_${Date.now()}`,
    title: 'Tem atualização',
    body: partes.join('\n\n'),
    kind: 'atualizacao',
    urgency: 'normal',
  });
}
