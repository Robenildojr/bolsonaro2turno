/**
 * Ferramentas de arquivo.
 *
 * Duas proteções que valem independentemente de autorização:
 *
 *  1. o próprio cofre do Gideão é intocável — `keyring.json` e `gideao.db` não são
 *     legíveis por ferramenta nenhuma. Se fossem, bastaria convencer o modelo a
 *     "ler um arquivo" para extrair o material criptográfico;
 *  2. caminho é sempre resolvido para absoluto antes da checagem de permissão,
 *     senão `../../` passearia por fora do escopo autorizado.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { paths } from '../config.js';
import type { ToolDefinition } from '../core/agent/tools.js';
import { truncateForModel } from '../core/agent/tools.js';

/** Resolve para absoluto, expandindo `~`. */
export function resolvePath(input: string): string {
  let p = input.trim();
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

/** Arquivos que nenhuma ferramenta abre, autorizada ou não. */
export function isProtectedPath(absolute: string): boolean {
  const p = paths();
  const protectedFiles = [p.keyring, p.db, `${p.db}-wal`, `${p.db}-shm`];
  if (protectedFiles.some((f) => absolute === f)) return true;
  // credenciais de sistema
  return /^\/etc\/(shadow|gshadow|sudoers)/.test(absolute) || /\.ssh\/id_[^/]*$/.test(absolute);
}

function guard(absolute: string): void {
  if (isProtectedPath(absolute)) {
    throw new Error(
      'este arquivo é material criptográfico do próprio Gideão (ou credencial do sistema) e não é acessível por ferramenta',
    );
  }
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const lerArquivo: ToolDefinition<{ caminho: string; linha_inicial?: number; linhas?: number }> = {
  name: 'ler_arquivo',
  description:
    'Lê o conteúdo de um arquivo de texto do computador. Para arquivos grandes, use linha_inicial e linhas para ler em partes.',
  capability: 'arquivo.ler',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['caminho', 'linha_inicial', 'linhas'],
    properties: {
      caminho: { type: 'string', description: 'Caminho do arquivo. Aceita ~ para a pasta do usuário.' },
      linha_inicial: { type: 'integer', description: 'Primeira linha a ler (1 = começo). Use 1 por padrão.' },
      linhas: { type: 'integer', description: 'Quantas linhas ler. 0 = até o fim.' },
    },
  },
  validate: z.object({
    caminho: z.string().min(1),
    linha_inicial: z.number().int().min(0).optional(),
    linhas: z.number().int().min(0).optional(),
  }),
  scopeFrom: (i) => resolvePath(i.caminho),
  summarize: (i) => `ler o arquivo ${i.caminho}`,
  async run(input) {
    const absolute = resolvePath(input.caminho);
    guard(absolute);

    const stat = await fs.stat(absolute);
    if (stat.isDirectory()) throw new Error(`${absolute} é uma pasta — use listar_pasta`);
    if (stat.size > 40 * 1024 * 1024) {
      throw new Error(`arquivo grande demais para leitura direta (${humanSize(stat.size)})`);
    }

    const raw = await fs.readFile(absolute);
    if (isBinary(raw)) {
      return {
        ok: true,
        content: `${absolute} parece um arquivo binário (${humanSize(stat.size)}). Não dá para ler como texto.`,
      };
    }

    const text = raw.toString('utf8');
    const start = Math.max(1, input.linha_inicial ?? 1);
    const count = input.linhas ?? 0;

    if (start === 1 && count === 0) {
      return { ok: true, content: truncateForModel(text) };
    }
    const lines = text.split('\n');
    const slice = lines.slice(start - 1, count > 0 ? start - 1 + count : undefined);
    return {
      ok: true,
      content: `[linhas ${start}–${start + slice.length - 1} de ${lines.length}]\n${truncateForModel(slice.join('\n'))}`,
    };
  },
};

const escreverArquivo: ToolDefinition<{ caminho: string; conteudo: string; modo: 'substituir' | 'acrescentar' }> = {
  name: 'escrever_arquivo',
  description:
    'Cria um arquivo ou altera um existente. Use modo "acrescentar" para adicionar ao final sem perder o que já estava lá.',
  capability: 'arquivo.escrever',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['caminho', 'conteudo', 'modo'],
    properties: {
      caminho: { type: 'string' },
      conteudo: { type: 'string' },
      modo: { type: 'string', enum: ['substituir', 'acrescentar'] },
    },
  },
  validate: z.object({
    caminho: z.string().min(1),
    conteudo: z.string(),
    modo: z.enum(['substituir', 'acrescentar']),
  }),
  scopeFrom: (i) => resolvePath(i.caminho),
  summarize: (i) =>
    `${i.modo === 'acrescentar' ? 'acrescentar ao' : 'gravar o'} arquivo ${i.caminho} (${i.conteudo.length} caracteres)`,
  async run(input) {
    const absolute = resolvePath(input.caminho);
    guard(absolute);
    await fs.mkdir(path.dirname(absolute), { recursive: true });

    const existed = fsSync.existsSync(absolute);
    if (input.modo === 'acrescentar') {
      await fs.appendFile(absolute, input.conteudo, 'utf8');
    } else {
      await fs.writeFile(absolute, input.conteudo, 'utf8');
    }
    const stat = await fs.stat(absolute);
    return {
      ok: true,
      content: `${existed ? 'Atualizei' : 'Criei'} ${absolute} (${humanSize(stat.size)}).`,
    };
  },
};

const listarPasta: ToolDefinition<{ caminho: string; recursivo: boolean }> = {
  name: 'listar_pasta',
  description: 'Lista os arquivos e subpastas de um diretório.',
  capability: 'arquivo.ler',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['caminho', 'recursivo'],
    properties: {
      caminho: { type: 'string' },
      recursivo: { type: 'boolean', description: 'true desce pelas subpastas (até 3 níveis).' },
    },
  },
  validate: z.object({ caminho: z.string().min(1), recursivo: z.boolean() }),
  scopeFrom: (i) => resolvePath(i.caminho),
  summarize: (i) => `listar a pasta ${i.caminho}`,
  async run(input) {
    const absolute = resolvePath(input.caminho);
    guard(absolute);

    const rows: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (rows.length >= 600) return;
        if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
        const full = path.join(dir, entry.name);
        const rel = path.relative(absolute, full) || entry.name;
        if (entry.isDirectory()) {
          rows.push(`${rel}/`);
          if (input.recursivo && depth < 3 && entry.name !== 'node_modules') await walk(full, depth + 1);
        } else {
          let size = '';
          try {
            size = ` (${humanSize((await fs.stat(full)).size)})`;
          } catch {
            /* link quebrado */
          }
          rows.push(`${rel}${size}`);
        }
      }
    };

    await walk(absolute, 0);
    if (rows.length === 0) return { ok: true, content: `${absolute} está vazia.` };
    return {
      ok: true,
      content: `${absolute} — ${rows.length} itens:\n${rows.join('\n')}`,
    };
  },
};

const buscarArquivos: ToolDefinition<{ pasta: string; padrao: string; conteudo: string }> = {
  name: 'buscar_arquivos',
  description:
    'Procura arquivos por nome e, opcionalmente, por um trecho de texto dentro deles. Útil para achar a petição ou o documento certo sem saber o caminho exato.',
  capability: 'arquivo.ler',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['pasta', 'padrao', 'conteudo'],
    properties: {
      pasta: { type: 'string', description: 'Onde procurar.' },
      padrao: { type: 'string', description: 'Parte do nome do arquivo. String vazia = qualquer nome.' },
      conteudo: { type: 'string', description: 'Texto que deve existir dentro do arquivo. Vazio = não filtra.' },
    },
  },
  validate: z.object({ pasta: z.string().min(1), padrao: z.string(), conteudo: z.string() }),
  scopeFrom: (i) => resolvePath(i.pasta),
  summarize: (i) =>
    `procurar em ${i.pasta} por "${i.padrao || 'qualquer nome'}"${i.conteudo ? ` contendo "${i.conteudo}"` : ''}`,
  timeoutMs: 90_000,
  async run(input) {
    const root = resolvePath(input.pasta);
    guard(root);
    const namePattern = input.padrao.toLowerCase();
    const needle = input.conteudo.toLowerCase();
    const found: string[] = [];
    let scanned = 0;

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (found.length >= 100 || depth > 8) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // pasta sem permissão de leitura: segue adiante
      }
      for (const entry of entries) {
        if (found.length >= 100) return;
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
          continue;
        }
        if (namePattern && !entry.name.toLowerCase().includes(namePattern)) continue;
        if (!needle) {
          found.push(full);
          continue;
        }
        scanned++;
        if (scanned > 4000) return;
        try {
          const stat = await fs.stat(full);
          if (stat.size > 8 * 1024 * 1024) continue;
          const raw = await fs.readFile(full);
          if (isBinary(raw)) continue;
          if (raw.toString('utf8').toLowerCase().includes(needle)) found.push(full);
        } catch {
          /* arquivo ilegível: ignora */
        }
      }
    };

    await walk(root, 0);
    if (found.length === 0) return { ok: true, content: 'Nenhum arquivo bate com esses critérios.' };
    return { ok: true, content: `${found.length} resultado(s):\n${found.join('\n')}` };
  },
};

const apagarArquivo: ToolDefinition<{ caminho: string }> = {
  name: 'apagar_arquivo',
  description: 'Apaga um arquivo. Não há lixeira — o arquivo some de verdade.',
  capability: 'arquivo.apagar',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['caminho'],
    properties: { caminho: { type: 'string' } },
  },
  validate: z.object({ caminho: z.string().min(1) }),
  scopeFrom: (i) => resolvePath(i.caminho),
  summarize: (i) => `APAGAR o arquivo ${i.caminho} — isto não tem desfazer`,
  async run(input) {
    const absolute = resolvePath(input.caminho);
    guard(absolute);
    const stat = await fs.stat(absolute);
    if (stat.isDirectory()) {
      throw new Error('apagar pasta inteira não é feito por ferramenta — peça ao dono no terminal');
    }
    await fs.unlink(absolute);
    return { ok: true, content: `Apaguei ${absolute} (${humanSize(stat.size)}).` };
  },
};

/** Heurística simples: byte nulo nos primeiros 8 KB indica binário. */
function isBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8192);
  return sample.includes(0);
}

export const fsTools: Array<ToolDefinition<any>> = [
  lerArquivo,
  escreverArquivo,
  listarPasta,
  buscarArquivos,
  apagarArquivo,
];
