import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { z } from 'zod';

process.env.GIDEAO_KDF_N = '16384';

import { Keyring } from '../src/core/crypto/keyring.js';
import { Store } from '../src/core/db/database.js';
import { AuditLog, initAudit } from '../src/core/permissions/audit.js';
import { PermissionBroker, initBroker } from '../src/core/permissions/broker.js';
import { getVault, initVault } from '../src/core/vault/vault.js';
import { ToolRegistry, truncateForModel, withTimeout } from '../src/core/agent/tools.js';
import { ConversationStore } from '../src/core/memory/conversations.js';
import { buildContextBlock, buildSystemPrompt } from '../src/core/agent/prompt.js';
import { suportaModoRapido } from '../src/core/agent/agent.js';
import { loadConfig } from '../src/config.js';
import { bus } from '../src/core/events/bus.js';

let tmp: string;
let store: Store;
let broker: PermissionBroker;
let registry: ToolRegistry;

const ctx = { conversationId: 'conv_teste', channel: 'web', signal: new AbortController().signal };

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gideao-agent-'));
  process.env.GIDEAO_HOME = tmp;
  const keyring = new Keyring(path.join(tmp, 'k.json'));
  keyring.create('senha-mestra-forte-123!');
  store = new Store(path.join(tmp, 'gideao.db'), keyring);
  const audit: AuditLog = initAudit(store);
  broker = initBroker(store, audit, loadConfig({ reload: true }));
  initVault(store, keyring);
});

after(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.GIDEAO_HOME;
});

beforeEach(() => {
  store.db.exec('DELETE FROM capabilities; DELETE FROM audit_log; DELETE FROM vault_items;');
  broker.setFallbackPrompt(null);
  registry = new ToolRegistry();
});

function toolEco(overrides: Record<string, unknown> = {}) {
  return {
    name: 'eco',
    description: 'Repete o texto recebido.',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['texto'],
      properties: { texto: { type: 'string' } },
    },
    validate: z.object({ texto: z.string().min(1) }),
    run: async (input: { texto: string }) => ({ ok: true, content: `eco: ${input.texto}` }),
    ...overrides,
  } as never;
}

describe('registro de ferramentas', () => {
  it('recusa nome duplicado', () => {
    registry.register(toolEco());
    assert.throws(() => registry.register(toolEco()), /duplicada/);
  });

  it('exporta em ordem estável, para não quebrar o cache de prompt', () => {
    registry.register(toolEco({ name: 'zulu' }));
    registry.register(toolEco({ name: 'alfa' }));
    registry.register(toolEco({ name: 'mike' }));
    assert.deepEqual(registry.toApiTools().map((t) => t.name), ['alfa', 'mike', 'zulu']);
  });

  it('NÃO marca as ferramentas como estritas', () => {
    // Este teste já afirmou o contrário, e é por isso que o bug passou: a API
    // aceita no máximo 20 ferramentas estritas, e este sistema tem 43. Marcar
    // todas fazia a requisição voltar 400 e o agente não responder nada — coisa
    // que só aparece numa chamada real, nunca aqui. A conferência dos
    // argumentos ficou com o zod, exigido no registro.
    registry.register(toolEco());
    assert.ok(!('strict' in registry.toApiTools()[0]!));
  });

  it('responde com erro legível para ferramenta inexistente', async () => {
    const r = await registry.execute('nao_existe', {}, ctx);
    assert.ok(!r.ok);
    assert.match(r.content, /desconhecida/);
  });
});

describe('validação de argumentos', () => {
  it('rejeita argumento fora do schema com mensagem útil ao modelo', async () => {
    registry.register(toolEco());
    const r = await registry.execute('eco', { texto: '' }, ctx);
    assert.ok(!r.ok);
    assert.match(r.content, /Argumentos inválidos/);
    assert.match(r.content, /texto/);
  });

  it('aceita argumento válido', async () => {
    registry.register(toolEco());
    const r = await registry.execute('eco', { texto: 'oi' }, ctx);
    assert.ok(r.ok);
    assert.equal(r.content, 'eco: oi');
  });
});

describe('portão de permissão', () => {
  it('bloqueia a execução quando o dono nega', async () => {
    let executou = false;
    registry.register(
      toolEco({
        capability: 'arquivo.ler',
        scopeFrom: (i: { texto: string }) => i.texto,
        run: async () => {
          executou = true;
          return { ok: true, content: 'não deveria chegar aqui' };
        },
      }),
    );
    broker.setFallbackPrompt(async () => 'negado');

    const r = await registry.execute('eco', { texto: '/etc/shadow' }, ctx);
    assert.ok(!r.ok);
    assert.match(r.content, /Não autorizado/);
    assert.equal(executou, false, 'a ferramenta não pode ter rodado');
  });

  it('deriva o escopo dos argumentos', async () => {
    let escopoVisto = '';
    registry.register(
      toolEco({ capability: 'arquivo.ler', scopeFrom: (i: { texto: string }) => i.texto }),
    );
    broker.setFallbackPrompt(async (req) => {
      escopoVisto = req.scope;
      return 'uma_vez';
    });
    await registry.execute('eco', { texto: '/home/eu/processos/a.pdf' }, ctx);
    assert.equal(escopoVisto, '/home/eu/processos/a.pdf');
  });

  it('ferramenta sem capacidade não pede autorização', async () => {
    registry.register(toolEco());
    broker.setFallbackPrompt(async () => {
      throw new Error('não podia ter perguntado');
    });
    const r = await registry.execute('eco', { texto: 'livre' }, ctx);
    assert.ok(r.ok);
  });

  it('autorização gravada dispensa a pergunta nas próximas', async () => {
    registry.register(
      toolEco({ capability: 'arquivo.ler', scopeFrom: (i: { texto: string }) => i.texto }),
    );
    let perguntas = 0;
    broker.setFallbackPrompt(async () => {
      perguntas++;
      return 'categoria';
    });
    await registry.execute('eco', { texto: '/a' }, ctx);
    await registry.execute('eco', { texto: '/b' }, ctx);
    await registry.execute('eco', { texto: '/c' }, ctx);
    assert.equal(perguntas, 1);
  });
});

describe('credenciais dentro das ferramentas', () => {
  beforeEach(() => {
    getVault().set('pje.senha', 'SenhaSuperSecreta#9');
  });

  it('o valor real só aparece dentro da ferramenta', async () => {
    let recebido = '';
    registry.register(
      toolEco({
        capability: 'navegador.interagir',
        scopeFrom: () => 'pje.trt8.jus.br',
        run: async (input: { texto: string }) => {
          recebido = input.texto;
          return { ok: true, content: 'login feito' };
        },
      }),
    );
    broker.setFallbackPrompt(async () => 'sempre');

    const r = await registry.execute('eco', { texto: '{{cofre:pje.senha}}' }, ctx);
    assert.ok(r.ok);
    assert.equal(recebido, 'SenhaSuperSecreta#9', 'a ferramenta recebe o valor real');
    assert.ok(!r.content.includes('SenhaSuperSecreta'), 'mas ele não volta para o modelo');
  });

  it('usar credencial exige autorização própria', async () => {
    const pedidos: string[] = [];
    registry.register(
      toolEco({ capability: 'navegador.interagir', scopeFrom: () => 'pje.trt8.jus.br' }),
    );
    broker.setFallbackPrompt(async (req) => {
      pedidos.push(`${req.capability}:${req.scope}`);
      return 'uma_vez';
    });
    await registry.execute('eco', { texto: '{{cofre:pje.senha}}' }, ctx);
    assert.deepEqual(pedidos, ['navegador.interagir:pje.trt8.jus.br', 'cofre.ler:pje.senha']);
  });

  it('negar a credencial impede a execução', async () => {
    let executou = false;
    registry.register(
      toolEco({
        capability: 'navegador.interagir',
        scopeFrom: () => 'pje.trt8.jus.br',
        run: async () => {
          executou = true;
          return { ok: true, content: 'x' };
        },
      }),
    );
    broker.setFallbackPrompt(async (req) => (req.capability === 'cofre.ler' ? 'negado' : 'sempre'));
    const r = await registry.execute('eco', { texto: '{{cofre:pje.senha}}' }, ctx);
    assert.ok(!r.ok);
    assert.equal(executou, false);
  });

  it('o pedido de autorização mostra a referência, nunca o valor', async () => {
    registry.register(
      toolEco({ capability: 'navegador.interagir', scopeFrom: () => 'pje.trt8.jus.br' }),
    );
    let detalhes = '';
    broker.setFallbackPrompt(async (req) => {
      detalhes += JSON.stringify(req.details ?? {});
      return 'uma_vez';
    });
    await registry.execute('eco', { texto: '{{cofre:pje.senha}}' }, ctx);
    assert.ok(detalhes.includes('pje.senha'));
    assert.ok(!detalhes.includes('SenhaSuperSecreta'));
  });

  it('a auditoria guarda a referência, nunca o valor', async () => {
    registry.register(
      toolEco({ capability: 'navegador.interagir', scopeFrom: () => 'pje.trt8.jus.br' }),
    );
    broker.setFallbackPrompt(async () => 'sempre');
    await registry.execute('eco', { texto: '{{cofre:pje.senha}}' }, ctx);

    const entradas = initAudit(store).list({ limit: 20 });
    const texto = JSON.stringify(entradas);
    assert.ok(texto.includes('cofre:pje.senha'));
    assert.ok(!texto.includes('SenhaSuperSecreta'));
  });

  it('referência inexistente falha em vez de mandar o placeholder adiante', async () => {
    let recebido = '';
    registry.register(
      toolEco({
        run: async (input: { texto: string }) => {
          recebido = input.texto;
          return { ok: true, content: 'x' };
        },
      }),
    );
    const r = await registry.execute('eco', { texto: '{{cofre:nao.existe}}' }, ctx);
    assert.ok(!r.ok);
    assert.match(r.content, /não existe no cofre/);
    assert.equal(recebido, '', 'a ferramenta não pode ter recebido o placeholder literal');
  });
});

describe('robustez da execução', () => {
  it('converte exceção em resultado de erro, sem derrubar o turno', async () => {
    registry.register(
      toolEco({
        run: async () => {
          throw new Error('o site caiu');
        },
      }),
    );
    const r = await registry.execute('eco', { texto: 'x' }, ctx);
    assert.ok(!r.ok);
    assert.match(r.content, /o site caiu/);
  });

  it('respeita o prazo máximo', async () => {
    registry.register(
      toolEco({
        timeoutMs: 60,
        run: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, content: 'tarde' }), 2000)),
      }),
    );
    const r = await registry.execute('eco', { texto: 'x' }, ctx);
    assert.ok(!r.ok);
    assert.match(r.content, /passou do tempo/);
  });

  it('emite início e fim no barramento', async () => {
    const eventos: string[] = [];
    const offStart = bus.on('tool:start', (e) => eventos.push(`start:${e.tool}`));
    const offEnd = bus.on('tool:end', (e) => eventos.push(`end:${e.tool}:${e.ok}`));
    registry.register(toolEco());
    await registry.execute('eco', { texto: 'x' }, ctx);
    await new Promise((r) => setTimeout(r, 10));
    offStart();
    offEnd();
    assert.deepEqual(eventos, ['start:eco', 'end:eco:true']);
  });

  it('withTimeout limpa o temporizador ao terminar antes', async () => {
    const r = await withTimeout(Promise.resolve('rápido'), 5000, 'estourou');
    assert.equal(r, 'rápido');
  });

  it('corta saída gigante sem perder começo nem fim', () => {
    const grande = 'INÍCIO' + 'x'.repeat(50_000) + 'FIM';
    const cortado = truncateForModel(grande, 1000);
    assert.ok(cortado.length < 1400);
    assert.ok(cortado.startsWith('INÍCIO'));
    assert.ok(cortado.endsWith('FIM'));
    assert.match(cortado, /caracteres omitidos/);
  });
});

describe('janela do histórico', () => {
  let conversations: ConversationStore;
  before(() => {
    conversations = new ConversationStore(store);
  });

  it('descarta tool_result órfão no começo da janela', () => {
    const conv = conversations.create('web');
    conversations.append({
      conversationId: conv.id,
      role: 'user',
      content: '',
      channel: 'web',
      blocks: [{ type: 'tool_result', tool_use_id: 'perdido', content: 'resultado sem chamada' }],
    });
    conversations.append({ conversationId: conv.id, role: 'assistant', content: 'ok', channel: 'web' });
    conversations.append({ conversationId: conv.id, role: 'user', content: 'pergunta', channel: 'web' });

    const api = conversations.toApiMessages(conv.id, 10);
    assert.equal(api.length, 1);
    assert.equal(api[0]!.role, 'user');
    assert.equal(api[0]!.content, 'pergunta');
  });

  it('descarta tool_use sem resposta no fim da janela', () => {
    const conv = conversations.create('web');
    conversations.append({ conversationId: conv.id, role: 'user', content: 'consulta o processo', channel: 'web' });
    conversations.append({
      conversationId: conv.id,
      role: 'assistant',
      content: '',
      channel: 'web',
      blocks: [{ type: 'tool_use', id: 'tu_1', name: 'consultar', input: {} }],
    });

    const api = conversations.toApiMessages(conv.id, 10);
    assert.equal(api.length, 1, 'a chamada interrompida não pode ir para a API');
    assert.equal(api[0]!.role, 'user');
  });

  it('preserva o par tool_use/tool_result quando está completo', () => {
    const conv = conversations.create('web');
    conversations.append({ conversationId: conv.id, role: 'user', content: 'consulta', channel: 'web' });
    conversations.append({
      conversationId: conv.id,
      role: 'assistant',
      content: '',
      channel: 'web',
      blocks: [{ type: 'tool_use', id: 'tu_1', name: 'consultar', input: {} }],
    });
    conversations.append({
      conversationId: conv.id,
      role: 'user',
      content: '',
      channel: 'web',
      blocks: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'achei' }],
    });
    conversations.append({ conversationId: conv.id, role: 'assistant', content: 'o processo está...', channel: 'web' });

    const api = conversations.toApiMessages(conv.id, 10);
    assert.equal(api.length, 4);
  });
});

describe('prompt', () => {
  it('é estável entre chamadas — é isso que mantém o cache', () => {
    const cfg = loadConfig({ reload: true });
    assert.equal(buildSystemPrompt(cfg), buildSystemPrompt(cfg));
  });

  it('não carrega nada volátil', () => {
    const prompt = buildSystemPrompt(loadConfig({ reload: true }));
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(prompt), 'data no prompt de sistema quebraria o cache');
    assert.ok(!prompt.includes(String(new Date().getFullYear())));
  });

  it('o bloco de contexto carrega o que muda a cada turno', () => {
    const bloco = buildContextBlock({
      nowFormatted: 'segunda-feira, 14 de setembro de 2026 às 09:30',
      timezone: 'America/Sao_Paulo',
      profile: 'Advogado em Macapá.',
      memories: '- [mem_1] Cliente Almeida: motorista.',
      agenda: 'Audiência amanhã às 14h.',
      channel: 'web',
      observerActive: false,
    });
    assert.match(bloco, /AGORA:/);
    assert.match(bloco, /Advogado em Macapá/);
    assert.match(bloco, /mem_1/);
    assert.match(bloco, /Audiência amanhã/);
    assert.ok(!bloco.includes('OBSERVADOR LIGADO'));
  });

  it('avisa quando o observador está ligado', () => {
    const bloco = buildContextBlock({
      nowFormatted: 'x',
      timezone: 'America/Sao_Paulo',
      profile: '',
      memories: '',
      agenda: '',
      channel: 'web',
      observerActive: true,
    });
    assert.match(bloco, /OBSERVADOR LIGADO/);
  });
});

describe('modo rápido', () => {
  it('vale para a família Opus', () => {
    assert.ok(suportaModoRapido('claude-opus-5'));
    assert.ok(suportaModoRapido('claude-opus-4-8'));
  });

  it('não vale para os outros — mandar `speed` ali devolve 400 e derruba o turno', () => {
    for (const m of ['claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5-1', '']) {
      assert.ok(!suportaModoRapido(m), `${m} não suporta modo rápido`);
    }
  });
});
