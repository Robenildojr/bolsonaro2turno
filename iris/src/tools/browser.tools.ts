/**
 * Ferramentas de navegador.
 *
 * Separadas em três capacidades com riscos diferentes, de propósito:
 *
 *  - `navegador.abrir`     — só olhar (abrir página, ler texto)
 *  - `navegador.interagir` — preencher, clicar, fazer login
 *  - `navegador.baixar`    — trazer arquivo para o disco
 *
 * Você pode liberar a leitura de um site sem liberar o preenchimento de
 * formulários nele, que é justamente onde mora o risco de uma ação indevida.
 */
import path from 'node:path';
import { z } from 'zod';
import { paths } from '../config.js';
import { getBrowser } from '../integrations/browser/browser.js';
import { domainScope } from '../core/permissions/capabilities.js';

import type { ToolDefinition } from '../core/agent/tools.js';
import { truncateForModel } from '../core/agent/tools.js';

/**
 * Escopo das ferramentas que agem sobre a página já aberta.
 *
 * Antes era `*`, e isso tinha uma consequência que só aparece depois: ao
 * responder "sempre aqui" num pedido de `clicar`, a autorização era gravada com
 * escopo `*` e passava a valer em **todos** os sites, para sempre. Bastaria a
 * página seguinte ser de outra pessoa para um `preencher_campo` com
 * `{{cofre:...}}` digitar a senha do PJe num formulário alheio.
 *
 * Agora o escopo é o domínio em que o navegador está de fato. Sem página
 * aberta, devolve um valor que nenhum domínio casa — a autorização é pedida.
 */
function escopoDaPaginaAberta(): string {
  return getBrowser().dominioAtual || '(nenhuma página aberta)';
}

const abrirPagina: ToolDefinition<{ url: string }> = {
  name: 'abrir_pagina',
  description:
    'Abre um endereço num navegador de verdade e devolve o texto da página. Use para sites que exigem login ou que montam o conteúdo com JavaScript — sistemas de tribunal, por exemplo. O login feito uma vez continua valendo nas próximas sessões.',
  capability: 'navegador.abrir',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['url'],
    properties: { url: { type: 'string', description: 'Endereço completo, com https://' } },
  },
  validate: z.object({
    url: z
      .string()
      .url()
      .refine((u) => /^https?:$/.test(safeProtocol(u)), {
        message:
          'só abro endereços http e https. `file:` daria acesso a qualquer arquivo do disco por ' +
          'fora da autorização de arquivo, inclusive ao chaveiro da própria Íris.',
      }),
  }),
  scopeFrom: (i) => domainScope(i.url),
  summarize: (i) => `abrir ${i.url}`,
  timeoutMs: 120_000,
  async run(input) {
    const browser = getBrowser();
    const { title, url } = await browser.goto(input.url);
    const texto = await browser.readText();
    return {
      ok: true,
      content: `Página: ${title}\nEndereço final: ${url}\n\n${truncateForModel(texto, 20000)}`,
      data: { title, url },
    };
  },
};

const lerPaginaAtual: ToolDefinition<{ incluir_campos: boolean }> = {
  name: 'ler_pagina_atual',
  description:
    'Lê de novo a página que já está aberta no navegador, sem recarregar. Com incluir_campos, lista também os campos e botões disponíveis — use antes de preencher um formulário que você não conhece.',
  capability: 'navegador.abrir',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['incluir_campos'],
    properties: { incluir_campos: { type: 'boolean' } },
  },
  validate: z.object({ incluir_campos: z.boolean() }),
  scopeFrom: escopoDaPaginaAberta,
  summarize: () => 'ler a página aberta no navegador',
  async run(input) {
    const browser = getBrowser();
    const page = await browser.currentPage();
    const texto = await browser.readText();
    const partes = [`Endereço: ${page.url()}`, truncateForModel(texto, 18000)];
    if (input.incluir_campos) {
      const campos = await browser.describeForm();
      partes.push(`CAMPOS E BOTÕES DA PÁGINA:\n${campos || '(nenhum encontrado)'}`);
    }
    return { ok: true, content: partes.join('\n\n') };
  },
};

const preencherCampo: ToolDefinition<{ seletor: string; valor: string }> = {
  name: 'preencher_campo',
  description:
    'Digita um valor num campo da página aberta. Para senha, passe a referência do cofre no formato {{cofre:nome}} — o valor real é inserido na hora, sem passar pela conversa.',
  capability: 'navegador.interagir',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['seletor', 'valor'],
    properties: {
      seletor: { type: 'string', description: 'Seletor CSS do campo, como #usuario ou input[name="senha"].' },
      valor: { type: 'string', description: 'O que digitar. Aceita {{cofre:nome}}.' },
    },
  },
  validate: z.object({ seletor: z.string().min(1), valor: z.string() }),
  scopeFrom: escopoDaPaginaAberta,
  summarize: (i) => `preencher ${i.seletor}`,
  async run(input) {
    const browser = getBrowser();
    await browser.fill(input.seletor, input.valor);
    return { ok: true, content: `Preenchi ${input.seletor}.` };
  },
};

const clicar: ToolDefinition<{ seletor: string }> = {
  name: 'clicar',
  description: 'Clica num elemento da página aberta e espera o carregamento seguinte.',
  capability: 'navegador.interagir',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['seletor'],
    properties: { seletor: { type: 'string', description: 'Seletor CSS, ou text="Entrar" para achar pelo rótulo.' } },
  },
  validate: z.object({ seletor: z.string().min(1) }),
  scopeFrom: escopoDaPaginaAberta,
  summarize: (i) => `clicar em ${i.seletor}`,
  timeoutMs: 90_000,
  async run(input) {
    const browser = getBrowser();
    await browser.click(input.seletor);
    const page = await browser.currentPage();
    const texto = await browser.readText();
    return {
      ok: true,
      content: `Cliquei em ${input.seletor}.\nAgora em: ${page.url()}\n\n${truncateForModel(texto, 12000)}`,
    };
  },
};

const teclar: ToolDefinition<{ seletor: string; tecla: string }> = {
  name: 'teclar',
  description: 'Pressiona uma tecla num campo — tipicamente Enter para enviar um formulário.',
  capability: 'navegador.interagir',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['seletor', 'tecla'],
    properties: {
      seletor: { type: 'string' },
      tecla: { type: 'string', description: 'Enter, Tab, Escape, ArrowDown…' },
    },
  },
  validate: z.object({ seletor: z.string().min(1), tecla: z.string().min(1).max(20) }),
  scopeFrom: escopoDaPaginaAberta,
  summarize: (i) => `pressionar ${i.tecla} em ${i.seletor}`,
  async run(input) {
    const browser = getBrowser();
    await browser.press(input.seletor, input.tecla);
    const texto = await browser.readText();
    return { ok: true, content: `Pressionei ${input.tecla}.\n\n${truncateForModel(texto, 12000)}` };
  },
};

const capturarTela: ToolDefinition<{ nome: string }> = {
  name: 'capturar_tela',
  description:
    'Salva uma imagem da página aberta. Útil quando a informação está num gráfico, num PDF embutido ou numa tela que não vira texto.',
  capability: 'navegador.abrir',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['nome'],
    properties: { nome: { type: 'string', description: 'Nome do arquivo, sem extensão.' } },
  },
  validate: z.object({ nome: z.string().min(1).max(80) }),
  scopeFrom: escopoDaPaginaAberta,
  summarize: () => 'capturar a tela do navegador',
  async run(input) {
    const safe = input.nome.replace(/[^a-zA-Z0-9._-]/g, '_');
    const file = path.join(paths().cache, `${safe}-${Date.now()}.png`);
    const browser = getBrowser();
    await browser.screenshot(file);
    return { ok: true, content: `Capturei a tela em ${file}.`, data: { file } };
  },
};

const fecharNavegador: ToolDefinition<Record<string, never>> = {
  name: 'fechar_navegador',
  description: 'Fecha o navegador. A sessão de login continua guardada no perfil para a próxima vez.',
  schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  summarize: () => 'fechar o navegador',
  async run() {
    const browser = getBrowser();
    if (!browser.isOpen) return { ok: true, content: 'O navegador já estava fechado.' };
    await browser.close();
    return { ok: true, content: 'Navegador fechado. O login continua salvo no perfil.' };
  },
};

function safeProtocol(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
}

export const browserTools: Array<ToolDefinition<any>> = [
  abrirPagina,
  lerPaginaAtual,
  preencherCampo,
  clicar,
  teclar,
  capturarTela,
  fecharNavegador,
];
