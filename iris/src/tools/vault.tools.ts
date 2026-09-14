/**
 * Ferramentas de cofre.
 *
 * Repare no que **não** existe aqui: nenhuma ferramenta que leia um valor. O
 * modelo pode guardar uma credencial e saber que ela existe, mas não tem como
 * pedir o conteúdo — nem se alguém tentar convencê-lo a isso. O uso acontece
 * pela referência `{{cofre:nome}}`, resolvida dentro do executor.
 */
import { z } from 'zod';
import { getVault } from '../core/vault/vault.js';
import { getMemory } from '../core/memory/index.js';
import type { ToolDefinition } from '../core/agent/tools.js';
import { formatShort } from '../util/time.js';
import { loadConfig } from '../config.js';

const guardarCredencial: ToolDefinition<{
  nome: string;
  valor: string;
  servico: string;
  usuario: string;
  descricao: string;
}> = {
  name: 'guardar_credencial',
  description:
    'Guarda uma senha, token ou chave no cofre cifrado. Use quando o dono informar uma credencial na conversa — assim ela fica disponível para as próximas vezes e ele não precisa repetir. Depois de guardar, use sempre {{cofre:nome}} em vez do valor. Escolha nomes previsíveis: pje.trt8.senha, email.senha, datajud.chave.',
  capability: 'cofre.gravar',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['nome', 'valor', 'servico', 'usuario', 'descricao'],
    properties: {
      nome: { type: 'string', description: 'Identificador curto, minúsculo, com pontos. Ex.: pje.trt8.senha' },
      valor: { type: 'string', description: 'O segredo. Não repita este valor em nenhuma resposta.' },
      servico: { type: 'string', description: 'Site ou sistema a que pertence. Ex.: pje.trt8.jus.br' },
      usuario: { type: 'string', description: 'Login associado, se houver.' },
      descricao: { type: 'string', description: 'Para que serve, em uma frase.' },
    },
  },
  validate: z.object({
    nome: z.string().min(2).max(64),
    valor: z.string().min(1),
    servico: z.string(),
    usuario: z.string(),
    descricao: z.string(),
  }),
  scopeFrom: (i) => i.nome.toLowerCase(),
  summarize: (i) => `guardar a credencial "${i.nome}" (${i.servico || 'sem serviço informado'}) no cofre`,
  async run(input) {
    getVault().set(input.nome, input.valor, {
      kind: 'senha',
      meta: {
        service: input.servico,
        username: input.usuario,
        description: input.descricao,
      },
    });

    // Registra na memória que a credencial existe — sem o valor. É isso que
    // permite a ela lembrar, na próxima consulta, que já tem o acesso.
    await getMemory().remember({
      kind: 'credencial',
      subject: `Credencial ${input.nome}`,
      content: `Existe no cofre a credencial "${input.nome}" para ${input.servico || 'um serviço'}${
        input.usuario ? `, usuário ${input.usuario}` : ''
      }. ${input.descricao}. Para usar, referencie {{cofre:${input.nome}}} no argumento da ferramenta — o valor não aparece na conversa.`,
      importance: 0.75,
      confidence: 1,
      source: 'cofre',
      pinned: true,
    });

    return {
      ok: true,
      content: `Guardei no cofre como "${input.nome}". A partir de agora eu uso sozinha, você não precisa informar de novo. O valor não fica na conversa.`,
    };
  },
};

const listarCredenciais: ToolDefinition<Record<string, never>> = {
  name: 'listar_credenciais',
  description:
    'Lista quais credenciais existem no cofre, com serviço e usuário — nunca os valores. Use para saber se já tem acesso a um sistema antes de pedir a senha ao dono.',
  schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  summarize: () => 'ver quais credenciais existem no cofre',
  async run() {
    const cfg = loadConfig();
    const itens = getVault().list();
    if (itens.length === 0) {
      return { ok: true, content: 'O cofre está vazio.' };
    }
    const linhas = itens.map((i) => {
      const usado = i.lastUsedAt
        ? `usada ${i.useCount}×, última em ${formatShort(new Date(i.lastUsedAt), cfg.timezone, cfg.locale)}`
        : 'nunca usada';
      const detalhe = [i.meta.service, i.meta.username && `usuário ${i.meta.username}`, i.meta.description]
        .filter(Boolean)
        .join(' · ');
      return `{{cofre:${i.name}}} — ${detalhe || 'sem descrição'} (${usado})`;
    });
    return {
      ok: true,
      content: `${itens.length} credencial(is) no cofre:\n${linhas.join('\n')}`,
    };
  },
};

export const vaultTools: Array<ToolDefinition<any>> = [guardarCredencial, listarCredenciais];
