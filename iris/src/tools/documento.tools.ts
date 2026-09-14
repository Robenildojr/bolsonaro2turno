/**
 * Leitura de documento.
 *
 * Separada das ferramentas de arquivo por um motivo concreto: `ler_arquivo`
 * devolve texto, e petição digitalizada não tem texto — tem imagem de papel.
 * Esta ferramenta põe a página em si diante do modelo, que é a única forma de
 * ler um PDF escaneado, uma foto de intimação ou um print de sistema.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { guardar, tiposAceitos } from '../core/agent/attachments.js';
import { resolvePath, isProtectedPath } from './fs.tools.js';
import type { ToolDefinition } from '../core/agent/tools.js';

const lerDocumento: ToolDefinition<{ caminho: string }> = {
  name: 'ler_documento',
  description:
    'Abre um PDF, uma imagem ou um documento digitalizado do computador e coloca o conteúdo diante dos seus olhos — você passa a enxergar as páginas. Use para petição escaneada, intimação fotografada, print de sistema e PDF com tabela ou carimbo. Para arquivo de texto puro, `ler_arquivo` é mais barato.',
  capability: 'arquivo.ler',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['caminho'],
    properties: {
      caminho: { type: 'string', description: 'Caminho do arquivo. Aceita ~ para a pasta do usuário.' },
    },
  },
  validate: z.object({ caminho: z.string().min(1) }),
  scopeFrom: (i) => resolvePath(i.caminho),
  summarize: (i) => `abrir o documento ${i.caminho}`,
  timeoutMs: 120_000,
  async run(input) {
    const absoluto = resolvePath(input.caminho);
    if (isProtectedPath(absoluto)) {
      return { ok: false, content: 'este arquivo é material criptográfico da própria Íris.' };
    }

    const stat = await fs.stat(absoluto);
    if (stat.isDirectory()) {
      return { ok: false, content: `${absoluto} é uma pasta — use listar_pasta.` };
    }

    const conteudo = await fs.readFile(absoluto);
    const nome = path.basename(absoluto);

    try {
      const anexo = await guardar(conteudo, { nome, mime: mimePorExtensao(nome) });
      return {
        ok: true,
        content: `Abri "${nome}" (${anexo.tipo}, ${Math.round(anexo.bytes / 1024)} KB). O conteúdo está logo abaixo.`,
        attachments: [anexo],
      };
    } catch (err) {
      return {
        ok: false,
        content: `${String(err instanceof Error ? err.message : err)} Aceito: ${tiposAceitos()}.`,
      };
    }
  },
};

function mimePorExtensao(nome: string): string {
  const ext = nome.split('.').pop()?.toLowerCase() ?? '';
  const mapa: Record<string, string> = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    txt: 'text/plain',
    md: 'text/plain',
    csv: 'text/plain',
    json: 'text/plain',
  };
  return mapa[ext] ?? '';
}

export const documentoTools: Array<ToolDefinition<any>> = [lerDocumento];
