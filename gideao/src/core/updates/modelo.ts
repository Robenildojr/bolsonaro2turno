/**
 * Modelo mais novo.
 *
 * Modelo de linguagem envelhece rápido, e "não quero que fique nada defasado"
 * foi pedido explícito do dono. A checagem é simples: a própria API lista os
 * modelos disponíveis com a data de publicação de cada um, e basta comparar
 * com o que está em uso.
 *
 * Ele **avisa**, não troca. Trocar de modelo muda preço, velocidade e
 * comportamento de tudo — inclusive a forma como ele conversa, que o dono
 * acabou de calibrar. Isso é decisão de dono, feita na engrenagem ou numa
 * frase ("passa para o modelo novo"), não uma madrugada de terça.
 */
import { getClient } from '../llm.js';
import { loadConfig } from '../../config.js';
import { createLogger, describeError } from '../../util/logger.js';

const log = createLogger('atualizacao:modelo');

export interface ModeloDisponivel {
  id: string;
  nome: string;
  publicadoEm: string;
}

export interface EstadoDoModelo {
  emUso: string;
  /** Modelos publicados depois do que está em uso. Vazio = está em dia. */
  maisNovos: ModeloDisponivel[];
  erro?: string;
}

export async function verificar(): Promise<EstadoDoModelo> {
  const cfg = loadConfig();
  const emUso = cfg.model.main;

  try {
    const lista: ModeloDisponivel[] = [];
    // O SDK pagina sozinho: `for await` percorre tudo.
    for await (const m of getClient().models.list({ limit: 50 })) {
      lista.push({
        id: m.id,
        nome: m.display_name ?? m.id,
        publicadoEm: String(m.created_at ?? ''),
      });
    }

    const atual = lista.find((m) => m.id === emUso);
    if (!atual) {
      // O modelo em uso não aparece na lista: ou foi aposentado, ou o nome está
      // errado. Nos dois casos o dono precisa saber — é a diferença entre
      // "existe algo melhor" e "isto vai parar de responder".
      return {
        emUso,
        maisNovos: [],
        erro: `o modelo "${emUso}" não aparece na lista da Anthropic — confira o nome na engrenagem`,
      };
    }

    const maisNovos = lista
      .filter((m) => m.id !== emUso && m.publicadoEm > atual.publicadoEm)
      .sort((a, b) => b.publicadoEm.localeCompare(a.publicadoEm));

    log.debug('modelos conferidos', { emUso, maisNovos: maisNovos.length });
    return { emUso, maisNovos };
  } catch (err) {
    return { emUso, maisNovos: [], erro: describeError(err) };
  }
}
