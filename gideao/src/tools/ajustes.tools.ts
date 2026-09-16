/**
 * Ajustar-se por conversa.
 *
 * "Gideão, fala mais devagar", "põe o orbe mais azul", "me chama de doutor" —
 * pedidos que não deveriam exigir abrir painel nenhum. Estas duas ferramentas
 * são o caminho: ele lê os próprios ajustes e muda o que você pediu.
 *
 * O alcance é exatamente o mesmo da engrenagem, menos os ajustes marcados
 * `somenteInterface` — a lista está em `core/settings/ajustes.ts` e é uma só
 * para os dois caminhos. O que fica de fora da conversa é o que mexe nos
 * próprios freios: o prazo de uma autorização, a confirmação de ação
 * irreversível e o observador. A regra por trás disso é simples — o que
 * protege você do sistema não se afrouxa por uma frase dita de passagem.
 */
import { z } from 'zod';
import { AJUSTES, aplicarAjustes, descreverResultado, lerAjustes } from '../core/settings/ajustes.js';
import { recarregarNoVivo } from '../core/settings/aovivo.js';
import type { ToolDefinition } from '../core/agent/tools.js';

const verAjustes: ToolDefinition<Record<string, never>> = {
  name: 'ver_ajustes',
  description:
    'Lista as configurações dele e os valores de agora: nome, fuso, voz, cor do orbe, esforço de raciocínio, temas que ele acompanha. Use antes de mudar algo, para saber a chave certa e o valor atual.',
  schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  summarize: () => 'ver os próprios ajustes',
  async run() {
    const linhas = lerAjustes().map((a) => {
      const onde = a.somenteInterface ? '  [só pela engrenagem]' : '';
      return `${a.chave} = ${JSON.stringify(a.valor)}${onde}\n    ${a.rotulo} — ${a.ajuda}`;
    });
    return { ok: true, content: linhas.join('\n') };
  },
};

const mudarAjuste: ToolDefinition<{ chave: string; valor: string }> = {
  name: 'mudar_ajuste',
  description:
    'Muda uma configuração dele. Use quando o dono pedir na conversa ("fala mais devagar", "me chama de X", "deixa o orbe mais azul"). Chame ver_ajustes antes se não tiver certeza da chave. Nenhuma chave de API, senha ou token é alcançável por aqui.',
  capability: 'config.alterar',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['chave', 'valor'],
    properties: {
      chave: {
        type: 'string',
        description: `Uma destas: ${AJUSTES.filter((a) => !a.somenteInterface).map((a) => a.chave).join(', ')}`,
      },
      valor: {
        type: 'string',
        description:
          'O valor novo. Para sim/não use "sim" ou "não". Para lista, separe por quebra de linha.',
      },
    },
  },
  validate: z.object({ chave: z.string().min(1).max(60), valor: z.string().max(4000) }),
  scopeFrom: (i) => i.chave,
  summarize: (i) => `mudar ${i.chave} para "${i.valor.slice(0, 60)}"`,
  async run(input) {
    const resultado = aplicarAjustes({ [input.chave]: input.valor }, 'conversa');
    if (resultado.aplicados.length) await recarregarNoVivo();

    return {
      ok: resultado.recusados.length === 0,
      content: descreverResultado(resultado),
      data: { aplicados: resultado.aplicados.length, recusados: resultado.recusados.length },
    };
  },
};

export const ajustesTools: Array<ToolDefinition<any>> = [verAjustes, mudarAjuste];
