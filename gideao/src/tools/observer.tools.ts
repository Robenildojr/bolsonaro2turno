/**
 * Ferramentas do observador.
 *
 * Repare no que o Gideão **pode** e no que **não pode** fazer aqui: ele consegue
 * ligar (passando pelo pedido de autorização de risco crítico), consultar o
 * estado e pausar. Desligar e apagar também. O que ele não consegue é ligar sem
 * o pedido chegar até você — não existe caminho no código para isso.
 */
import { z } from 'zod';
import { getObservador } from '../observer/index.js';
import { descreverPlataforma, verificarDisponibilidade } from '../observer/capture.js';
import type { ToolDefinition } from '../core/agent/tools.js';
import { loadConfig } from '../config.js';
import { formatShort } from '../util/time.js';

const controlar: ToolDefinition<{
  acao: 'ligar' | 'desligar' | 'pausar' | 'retomar' | 'estado' | 'apagar_tudo';
  area_transferencia: boolean;
  janela_ativa: boolean;
  minutos: number;
}> = {
  name: 'observador',
  description:
    'Controla a captura de contexto (área de transferência e janela ativa). Ligar exige autorização explícita do dono a cada vez que estiver desligado. Use "pausar" quando ele avisar que vai digitar algo sensível.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['acao', 'area_transferencia', 'janela_ativa', 'minutos'],
    properties: {
      acao: { type: 'string', enum: ['ligar', 'desligar', 'pausar', 'retomar', 'estado', 'apagar_tudo'] },
      area_transferencia: { type: 'boolean', description: 'Só em "ligar".' },
      janela_ativa: { type: 'boolean', description: 'Só em "ligar".' },
      minutos: { type: 'integer', description: 'Só em "pausar". 0 = 15 minutos.' },
    },
  },
  validate: z.object({
    acao: z.enum(['ligar', 'desligar', 'pausar', 'retomar', 'estado', 'apagar_tudo']),
    area_transferencia: z.boolean(),
    janela_ativa: z.boolean(),
    minutos: z.number().int().min(0).max(1440),
  }),
  summarize: (i) => `observador: ${i.acao}`,
  timeoutMs: 330_000,
  async run(input) {
    const obs = getObservador();
    const cfg = loadConfig();

    switch (input.acao) {
      case 'ligar': {
        if (!input.area_transferencia && !input.janela_ativa) {
          return { ok: false, content: 'Escolha pelo menos uma fonte: área de transferência ou janela ativa.' };
        }
        const ok = await obs.ligar({
          clipboard: input.area_transferencia,
          janela: input.janela_ativa,
        });
        if (!ok) {
          const disp = await verificarDisponibilidade();
          return {
            ok: false,
            content: disp.faltando.length
              ? `Não consegui ligar. Falta: ${disp.faltando.join('; ')}.`
              : 'Não foi autorizado.',
          };
        }
        return {
          ok: true,
          content:
            'Observador ligado. O indicador fica visível na tela enquanto estiver gravando. ' +
            'Senhas, tokens e janelas de gerenciador de senhas não são capturados, e o material cru ' +
            'se apaga sozinho em 30 dias.',
        };
      }

      case 'desligar':
        obs.desligar();
        return { ok: true, content: 'Observador desligado. Não estou mais capturando nada.' };

      case 'pausar':
        obs.pausar(input.minutos || 15);
        return { ok: true, content: `Pausado por ${input.minutos || 15} minutos. Pode digitar à vontade.` };

      case 'retomar':
        obs.retomar();
        return { ok: true, content: 'Retomei a captura.' };

      case 'apagar_tudo': {
        const total = obs.apagarTudo();
        return { ok: true, content: `Apaguei ${total} observação(ões). O que já virou memória continua.` };
      }

      case 'estado':
      default: {
        const estado = obs.estado();
        const contagem = obs.contar();
        return {
          ok: true,
          content: [
            `Observador: ${estado.ativo ? (estado.pausado ? 'LIGADO mas pausado' : 'LIGADO') : 'desligado'}`,
            `Fontes: ${estado.fontes.join(', ') || 'nenhuma'}`,
            `Plataforma: ${estado.plataforma}`,
            `Capturas hoje: ${estado.capturasHoje}`,
            `Guardadas: ${contagem.total} (${contagem.naoProcessadas} ainda não digeridas)`,
            contagem.maisAntiga
              ? `Mais antiga: ${formatShort(new Date(contagem.maisAntiga), cfg.timezone, cfg.locale)}`
              : '',
            `Retenção: ${estado.retencaoDias} dias`,
          ]
            .filter(Boolean)
            .join('\n'),
        };
      }
    }
  },
};

export const observerTools: Array<ToolDefinition<any>> = [controlar];
export { descreverPlataforma };
