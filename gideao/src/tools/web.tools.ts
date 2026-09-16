/**
 * Web.
 *
 * Duas portas para a internet, com papéis distintos:
 *
 *  - **busca e leitura pelo servidor da Anthropic** (`web_search` / `web_fetch`,
 *    declaradas em agent.ts): rápidas, com citação, sem tocar a rede do dono.
 *    É por elas que ele "aprende com a internet" no dia a dia.
 *  - **`baixar_pagina` daqui**: busca direto da máquina do dono, sob autorização
 *    por domínio. Serve para o que a primeira não alcança — página que só
 *    responde a partir do IP dele, API com chave, arquivo para salvar em disco.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { paths } from '../config.js';
import { domainScope } from '../core/permissions/capabilities.js';
import { getBroker } from '../core/permissions/broker.js';
import { isProtectedPath, resolvePath } from './fs.tools.js';
import type { ToolDefinition } from '../core/agent/tools.js';
import { truncateForModel } from '../core/agent/tools.js';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Gideao/1.0';

/** HTML → texto legível, sem depender de biblioteca externa. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const baixarPagina: ToolDefinition<{
  url: string;
  metodo: 'GET' | 'POST';
  corpo: string;
  cabecalhos: string;
  salvar_em: string;
}> = {
  name: 'baixar_pagina',
  description:
    'Faz uma requisição HTTP a partir do computador do dono e devolve o conteúdo como texto. Use quando a busca web não bastar: API que exige chave, página que só responde do IP dele, ou arquivo que precisa ser salvo em disco (informe salvar_em). Para cabeçalho com credencial, use {{cofre:nome}}.',
  capability: 'web.ler',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['url', 'metodo', 'corpo', 'cabecalhos', 'salvar_em'],
    properties: {
      url: { type: 'string' },
      metodo: { type: 'string', enum: ['GET', 'POST'] },
      corpo: { type: 'string', description: 'Corpo do POST. Vazio para GET.' },
      cabecalhos: {
        type: 'string',
        description: 'JSON com os cabeçalhos, ex.: {"Authorization":"APIKey {{cofre:datajud}}"}. Vazio = nenhum.',
      },
      salvar_em: {
        type: 'string',
        description:
          'Caminho para salvar o arquivo baixado. Vazio = só devolver o texto. Gravar em disco pede autorização de escrita separada, além da de leitura web.',
      },
    },
  },
  validate: z.object({
    url: z.string().url(),
    metodo: z.enum(['GET', 'POST']),
    corpo: z.string(),
    cabecalhos: z.string(),
    salvar_em: z.string(),
  }),
  scopeFrom: (i) => domainScope(i.url),
  summarize: (i) => `${i.metodo} ${i.url}${i.salvar_em ? ` e salvar em ${i.salvar_em}` : ''}`,
  timeoutMs: 120_000,
  async run(input) {
    let headers: Record<string, string> = { 'user-agent': USER_AGENT, 'accept-language': 'pt-BR,pt;q=0.9' };
    if (input.cabecalhos.trim()) {
      try {
        headers = { ...headers, ...(JSON.parse(input.cabecalhos) as Record<string, string>) };
      } catch {
        throw new Error('o campo cabecalhos precisa ser um JSON válido');
      }
    }
    if (input.metodo === 'POST' && !headers['content-type'] && !headers['Content-Type']) {
      headers['content-type'] = 'application/json';
    }

    const res = await fetch(input.url, {
      method: input.metodo,
      headers,
      ...(input.metodo === 'POST' && input.corpo ? { body: input.corpo } : {}),
      redirect: 'follow',
      signal: AbortSignal.timeout(90_000),
    });

    const contentType = res.headers.get('content-type') ?? '';

    if (input.salvar_em) {
      /*
       * Gravar em disco é `arquivo.escrever`, não `web.ler`.
       *
       * Sem esta segunda autorização, uma capacidade documentada como de risco
       * baixo ("ler páginas da internet"), com escopo de domínio, escreveria em
       * qualquer caminho — ~/.bashrc, ~/.ssh/authorized_keys, o config.json da
       * próprio Gideão. O pedido que o dono viu falava de um site; o efeito seria
       * execução de código na próxima vez que ele abrisse um terminal.
       */
      const target = resolvePath(input.salvar_em);
      if (isProtectedPath(target)) {
        return {
          ok: false,
          content: 'esse caminho é material criptográfico do Gideão ou credencial do sistema.',
        };
      }

      const permitido = await getBroker().request({
        capability: 'arquivo.escrever',
        scope: target,
        reason: `gravar em ${target} o conteúdo baixado de ${input.url}`,
        actionText: target,
        details: { ferramenta: 'baixar_pagina', origem: input.url },
      });
      if (!permitido.allowed) {
        return {
          ok: false,
          content: `Não autorizado a gravar em ${target}. Posso devolver o conteúdo sem salvar.`,
        };
      }

      await fs.mkdir(path.dirname(target), { recursive: true });
      const buffer = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(target, buffer);
      return {
        ok: res.ok,
        content: `HTTP ${res.status}. Salvei ${buffer.length} bytes em ${target} (${contentType || 'tipo desconhecido'}).`,
        data: { status: res.status, file: target, bytes: buffer.length },
      };
    }

    if (/^(image|audio|video|application\/(pdf|zip|octet))/.test(contentType)) {
      return {
        ok: res.ok,
        content: `HTTP ${res.status}. O conteúdo é ${contentType}, não texto. Chame de novo informando salvar_em para gravar o arquivo em disco.`,
      };
    }

    const body = await res.text();
    const text = /json|javascript|text\/plain|xml/.test(contentType) ? body : htmlToText(body);
    return {
      ok: res.ok,
      content: `HTTP ${res.status} — ${input.url}\n\n${truncateForModel(text, 24000)}`,
      data: { status: res.status },
    };
  },
};

const salvarNoCache: ToolDefinition<{ nome: string; conteudo: string }> = {
  name: 'salvar_rascunho',
  description:
    'Guarda um texto na pasta de trabalho do Gideão para usar depois — minuta, resultado de consulta, anotação longa. Não exige autorização porque escreve só na própria pasta dela.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['nome', 'conteudo'],
    properties: {
      nome: { type: 'string' },
      conteudo: { type: 'string' },
    },
  },
  validate: z.object({ nome: z.string().min(1).max(120), conteudo: z.string() }),
  summarize: (i) => `salvar rascunho "${i.nome}"`,
  async run(input) {
    const safe = input.nome.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 100);
    const dir = path.join(paths().cache, 'rascunhos');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${safe}.txt`);
    await fs.writeFile(file, input.conteudo, 'utf8');
    return { ok: true, content: `Guardei em ${file}.`, data: { file } };
  },
};

export const webTools: Array<ToolDefinition<any>> = [baixarPagina, salvarNoCache];
