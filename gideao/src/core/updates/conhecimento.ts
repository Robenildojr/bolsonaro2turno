/**
 * Estudar sozinho.
 *
 * Toda madrugada o Gideão pesquisa na internet os temas que o dono acompanha e
 * guarda o que mudou. É a frente **inofensiva** da atualização: entra
 * informação, não programa. Por isso esta é a única das três que roda sozinha
 * de ponta a ponta, sem pedir nada.
 *
 * Duas decisões que evitam que isso vire lixo acumulado:
 *
 *  1. **Pesquisa pelo servidor da Anthropic** (`web_search`), não pela rede do
 *     dono. Sai com citação da fonte, e o IP dele não aparece numa varredura
 *     diária de sites de tribunal.
 *  2. **Só o que mudou vira memória.** A instrução é explícita em ignorar o que
 *     é estável e o que já está na memória. Uma rodada que não encontra
 *     novidade deve gravar zero — e isso é acerto, não falha. Um sistema que
 *     grava alguma coisa todo dia por obrigação enche a memória de ruído e
 *     estraga justamente a recuperação que faz ele ser útil.
 */
import Anthropic from '@anthropic-ai/sdk';
import { getClient, extractStructured } from '../llm.js';
import { getMemory } from '../memory/index.js';
import { loadConfig } from '../../config.js';
import { createLogger, describeError } from '../../util/logger.js';

const log = createLogger('atualizacao:conhecimento');

const SYSTEM_PESQUISA = `Você pesquisa para um assistente pessoal de um advogado brasileiro. Sua tarefa é descobrir o que MUDOU recentemente num tema, não explicar o tema.

Regras:
- Procure mudança concreta e datada: norma alterada, entendimento firmado, sistema de tribunal que mudou de endereço ou de regra, prazo novo, funcionalidade nova.
- Ignore o que é estável e conhecido há anos. "A CLT regula o contrato de trabalho" não é notícia.
- Diga a data de cada mudança e de onde veio a informação.
- Se não houver mudança relevante no período, responda exatamente: SEM NOVIDADE.
- Não invente. Fonte que você não leu não vira afirmação.`;

const SCHEMA_MEMORIAS = {
  type: 'object',
  additionalProperties: false,
  required: ['memorias'],
  properties: {
    memorias: {
      type: 'array',
      description: 'O que merece ser lembrado. Vazio quando não houve novidade real.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['assunto', 'conteudo', 'importancia'],
        properties: {
          assunto: { type: 'string', description: 'Do que trata, em até 8 palavras.' },
          conteudo: {
            type: 'string',
            description:
              'A mudança, autossuficiente, com data e fonte. Em português, terceira pessoa.',
          },
          importancia: {
            type: 'number',
            description: '0 a 1. Acima de 0.7 só o que muda a rotina do escritório.',
          },
        },
      },
    },
  },
} as const;

export interface ResultadoEstudo {
  temas: number;
  gravadas: number;
  novidades: Array<{ assunto: string; conteudo: string }>;
}

/** Pesquisa um tema e devolve o texto bruto do que encontrou. */
async function pesquisar(tema: string, desdeDias: number): Promise<string> {
  const cfg = loadConfig();
  const res = await getClient().messages.create({
    model: cfg.model.background,
    max_tokens: 6000,
    system: SYSTEM_PESQUISA,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
    messages: [
      {
        role: 'user',
        content: `Tema: ${tema}\n\nO que mudou nos últimos ${desdeDias} dias? Hoje é ${new Date().toISOString().slice(0, 10)}.`,
      },
    ],
  });

  if (res.stop_reason === 'refusal') return '';
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

export async function estudar(desdeDias = 7): Promise<ResultadoEstudo> {
  const cfg = loadConfig();
  const temas = cfg.updates.temas.filter((t) => t.trim());
  const memoria = getMemory();
  const novidades: ResultadoEstudo['novidades'] = [];

  for (const tema of temas) {
    try {
      const bruto = await pesquisar(tema, desdeDias);
      if (!bruto || /SEM NOVIDADE/i.test(bruto)) {
        log.debug('sem novidade', { tema });
        continue;
      }

      // O que já se sabe entra no prompt, para não regravar o mesmo toda semana.
      const conhecido = await memoria.recall(tema, { limit: 12 });
      const jaSei = conhecido.map((m) => `- ${m.subject}: ${m.content}`).join('\n');

      const extraido = await extractStructured<{
        memorias: Array<{ assunto: string; conteudo: string; importancia: number }>;
      }>({
        system:
          'Você transforma o resultado de uma pesquisa em memórias de longo prazo para um assistente jurídico. Grave só o que é novo em relação ao que já se sabe, e só o que continuará útil daqui a meses. Lista vazia é resposta legítima.',
        prompt: `TEMA: ${tema}\n\nO QUE JÁ SEI:\n${jaSei || '(nada ainda)'}\n\nPESQUISA DE HOJE:\n${bruto.slice(0, 20000)}`,
        toolName: 'guardar_novidades',
        toolDescription: 'Registra o que mudou e merece ser lembrado.',
        schema: SCHEMA_MEMORIAS as unknown as Record<string, unknown>,
      });

      for (const m of extraido?.memorias ?? []) {
        await memoria.remember({
          kind: 'fato',
          subject: m.assunto,
          content: m.conteudo,
          importance: Math.min(0.9, Math.max(0.3, m.importancia)),
          confidence: 0.75, // veio de pesquisa, não do dono: confiança menor
          source: 'estudo automático',
        });
        novidades.push({ assunto: m.assunto, conteudo: m.conteudo });
      }
    } catch (err) {
      log.warn('falhou ao estudar um tema', { tema, erro: describeError(err) });
    }
  }

  log.info('estudo concluído', { temas: temas.length, gravadas: novidades.length });
  return { temas: temas.length, gravadas: novidades.length, novidades };
}
