/**
 * Atualizar-se por comando.
 *
 * As rotinas de madrugada cobrem o dia a dia; estas ferramentas são para
 * quando o dono pergunta na hora — "tem versão nova?", "vai estudar aí sobre
 * o PJe", "aplica a atualização".
 *
 * Repare na divisão de capacidades, que não é decorativa:
 *
 *  - `verificar_atualizacoes` não pede autorização nenhuma. Olhar não muda nada.
 *  - `estudar_tema` usa `web.ler`, o mesmo de qualquer pesquisa.
 *  - `aplicar_atualizacao` usa `sistema.atualizar`, de risco crítico — ela
 *    troca o programa que roda na máquina do dono, e por isso confirma mesmo
 *    já tendo sido autorizada antes.
 */
import { z } from 'zod';
import { codigo, modelo, estudar } from '../core/updates/index.js';
import type { ToolDefinition } from '../core/agent/tools.js';

const verificar: ToolDefinition<Record<string, never>> = {
  name: 'verificar_atualizacoes',
  description:
    'Confere se há versão nova do código dele no repositório e se a Anthropic publicou modelo mais novo que o em uso. Só olha, não muda nada.',
  schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  summarize: () => 'verificar se há atualização',
  timeoutMs: 180_000,
  async run() {
    const [c, m] = await Promise.all([codigo.verificar(), modelo.verificar()]);
    const linhas: string[] = [];

    if (c.erro) {
      linhas.push(`CÓDIGO: não consegui conferir — ${c.erro}`);
    } else if (!c.pendentes.length) {
      linhas.push(`CÓDIGO: em dia (${c.ramo} em ${c.atual}).`);
    } else {
      linhas.push(
        `CÓDIGO: ${c.pendentes.length} commit(s) novo(s) no ramo ${c.ramo}, estou em ${c.atual}:`,
        ...c.pendentes.map((p) => `  · ${p.hash} ${p.assunto}`),
        c.sujo
          ? '  ATENÇÃO: há alterações locais não salvas — não dá para aplicar por cima delas.'
          : '  Dá para aplicar: puxo, instalo e rodo os testes antes de assumir.',
      );
    }

    if (m.erro) linhas.push(`MODELO: ${m.erro}`);
    else if (!m.maisNovos.length) linhas.push(`MODELO: ${m.emUso} é o mais novo disponível.`);
    else {
      linhas.push(
        `MODELO: em uso ${m.emUso}. Mais novos disponíveis:`,
        ...m.maisNovos.slice(0, 5).map((x) => `  · ${x.id} — ${x.nome}`),
      );
    }

    return {
      ok: true,
      content: linhas.join('\n'),
      data: { commitsPendentes: c.pendentes.length, modelosMaisNovos: m.maisNovos.length },
    };
  },
};

const aplicar: ToolDefinition<Record<string, never>> = {
  name: 'aplicar_atualizacao',
  description:
    'Puxa a versão nova do código, instala as dependências e roda os testes. Se os testes falharem, volta sozinho para a versão anterior. Use só quando o dono pedir explicitamente — depois é preciso reiniciar.',
  capability: 'sistema.atualizar',
  schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  summarize: () => 'aplicar a atualização do código e rodar os testes',
  timeoutMs: 900_000,
  async run() {
    const r = await codigo.aplicar();
    return { ok: r.ok, content: r.mensagem, data: { de: r.de, para: r.para, revertido: r.revertido } };
  },
};

const estudarAgora: ToolDefinition<{ tema: string; dias: number }> = {
  name: 'estudar_tema',
  description:
    'Pesquisa na internet o que mudou num tema e guarda o que for novidade como memória. Deixe o tema vazio para rodar os temas que ele já acompanha (configuráveis na engrenagem).',
  capability: 'web.ler',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['tema', 'dias'],
    properties: {
      tema: {
        type: 'string',
        description: 'O tema a pesquisar. Vazio = os temas configurados.',
      },
      dias: { type: 'integer', description: 'Janela de busca em dias. 0 = usar 7.' },
    },
  },
  validate: z.object({ tema: z.string().max(300), dias: z.number().int().min(0).max(365) }),
  scopeFrom: () => 'pesquisa de atualização',
  summarize: (i) => `estudar ${i.tema || 'os temas acompanhados'}`,
  timeoutMs: 600_000,
  async run(input) {
    const dias = input.dias || 7;

    // Tema avulso: entra na configuração só para esta rodada, sem gravar.
    if (input.tema.trim()) {
      const { loadConfig } = await import('../config.js');
      const cfg = loadConfig();
      const original = cfg.updates.temas;
      cfg.updates.temas = [input.tema.trim()];
      try {
        const r = await estudar(dias);
        return {
          ok: true,
          content: r.gravadas
            ? `Guardei ${r.gravadas} novidade(s):\n` +
              r.novidades.map((n) => `· ${n.assunto}: ${n.conteudo}`).join('\n')
            : 'Pesquisei e não achei novidade relevante nesse período.',
          data: { gravadas: r.gravadas },
        };
      } finally {
        cfg.updates.temas = original;
      }
    }

    const r = await estudar(dias);
    return {
      ok: true,
      content: r.gravadas
        ? `Estudei ${r.temas} tema(s) e guardei ${r.gravadas} novidade(s):\n` +
          r.novidades.map((n) => `· ${n.assunto}`).join('\n')
        : `Estudei ${r.temas} tema(s) e não havia novidade relevante.`,
      data: { temas: r.temas, gravadas: r.gravadas },
    };
  },
};

export const atualizacaoTools: Array<ToolDefinition<any>> = [verificar, aplicar, estudarAgora];
