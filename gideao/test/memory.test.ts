import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

process.env.GIDEAO_KDF_N = '16384';

import { Keyring } from '../src/core/crypto/keyring.js';
import { Store } from '../src/core/db/database.js';
import { ConversationStore } from '../src/core/memory/conversations.js';
import { LocalEmbeddings, bufferToVector, cosine, vectorToBuffer } from '../src/core/memory/embeddings.js';
import { Retriever } from '../src/core/memory/retrieval.js';
import { MemoryStore } from '../src/core/memory/store.js';
import { Consolidator } from '../src/core/memory/consolidation.js';
import { DAY } from '../src/util/time.js';

let tmp: string;
let store: Store;
let keyring: Keyring;
let memories: MemoryStore;
let retriever: Retriever;
const embeddings = new LocalEmbeddings();

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gideao-mem-'));
  keyring = new Keyring(path.join(tmp, 'k.json'));
  keyring.create('senha-mestra-forte-123!');
  store = new Store(path.join(tmp, 'gideao.db'), keyring);
  memories = new MemoryStore(store, embeddings);
  retriever = new Retriever(store, memories, embeddings);
});

after(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('embeddings locais', () => {
  it('são determinísticos', () => {
    const a = embeddings.embedOne('audiência trabalhista em Macapá');
    const b = embeddings.embedOne('audiência trabalhista em Macapá');
    assert.ok(Math.abs(cosine(a, b) - 1) < 1e-6);
  });

  it('são normalizados', () => {
    const v = embeddings.embedOne('qualquer texto aqui para medir');
    let sum = 0;
    for (const x of v) sum += x * x;
    assert.ok(Math.abs(Math.sqrt(sum) - 1) < 1e-5);
  });

  it('aproximam textos parecidos mais que textos distintos', () => {
    const base = embeddings.embedOne('audiência de instrução no TRT da 8ª região');
    const perto = embeddings.embedOne('audiência de instrução marcada no TRT 8');
    const longe = embeddings.embedOne('receita de bolo de chocolate com cobertura');
    assert.ok(cosine(base, perto) > cosine(base, longe) + 0.2);
  });

  it('toleram erro de digitação', () => {
    const certo = embeddings.embedOne('penhora de salário');
    const errado = embeddings.embedOne('penhoa de salário');
    assert.ok(cosine(certo, errado) > 0.5);
  });

  it('calibração: quase-duplicatas ficam muito acima do limiar e o resto muito abaixo', () => {
    const quaseIguais: Array<[string, string]> = [
      [
        'O dono revisa petições entre 17h e 19h.',
        'O dono revisa petições entre 17h e 19h, quase todo dia.',
      ],
      [
        'Padrão A. O dono revisa petições entre 17h e 19h.',
        'Padrão B. O dono revisa petições entre 17h e 19h.',
      ],
    ];
    const distintos: Array<[string, string]> = [
      ['João Almeida é motorista e mora em Santana.', 'João Almeida ajuizou reclamação contra a Transportes Norte.'],
      ['Audiência no TRT da 8ª região.', 'Receita de bolo de cenoura com cobertura.'],
      ['O dono prefere resumo pelo prazo mais próximo.', 'O perito entregou o laudo na sexta-feira.'],
    ];

    for (const [a, b] of quaseIguais) {
      const sim = cosine(embeddings.embedOne(a), embeddings.embedOne(b));
      assert.ok(sim > embeddings.nearDuplicate, `deveria fundir (${sim.toFixed(3)}): ${a}`);
    }
    for (const [a, b] of distintos) {
      const sim = cosine(embeddings.embedOne(a), embeddings.embedOne(b));
      assert.ok(sim < embeddings.nearDuplicate - 0.3, `não pode fundir (${sim.toFixed(3)}): ${a}`);
    }
  });

  it('sobrevivem ao ciclo buffer → vetor', () => {
    const v = embeddings.embedOne('teste de serialização');
    const back = bufferToVector(vectorToBuffer(v))!;
    assert.equal(back.length, v.length);
    assert.ok(Math.abs(cosine(v, back) - 1) < 1e-6);
  });
});

describe('gravação de memórias', () => {
  it('grava e recupera pelo id', async () => {
    const m = await memories.remember({
      kind: 'fato',
      subject: 'Comarca de atuação',
      content: 'O dono advoga principalmente na comarca de Macapá, no Amapá.',
      importance: 0.8,
    });
    const lido = memories.get(m.id)!;
    assert.equal(lido.content, 'O dono advoga principalmente na comarca de Macapá, no Amapá.');
    assert.equal(lido.kind, 'fato');
    assert.equal(lido.importance, 0.8);
  });

  it('não deixa o conteúdo legível no arquivo do banco', () => {
    const bruto = store.db.prepare('SELECT content_enc FROM memories LIMIT 1').get() as { content_enc: Buffer };
    assert.ok(!bruto.content_enc.toString('utf8').includes('Macapá'));
  });

  it('reforça em vez de duplicar quando a informação volta', async () => {
    const antes = memories.list({ kind: 'fato' }).length;
    const m = await memories.remember({
      kind: 'fato',
      subject: 'Comarca de atuação',
      content: 'O dono advoga principalmente na comarca de Macapá, no Amapá, desde 2015.',
      importance: 0.8,
    });
    assert.equal(memories.list({ kind: 'fato' }).length, antes, 'não pode criar uma segunda linha');
    assert.ok(m.content.includes('2015'), 'o texto mais rico deve prevalecer');
    assert.ok(m.confidence > 0.8, 'a confiança deve subir com o reforço');
  });

  it('separa memórias de tipos diferentes com o mesmo assunto', async () => {
    const a = await memories.remember({ kind: 'preferencia', subject: 'Resposta', content: 'Prefere resposta curta.' });
    const b = await memories.remember({ kind: 'fato', subject: 'Resposta', content: 'Respondeu ao ofício no dia 3.' });
    assert.notEqual(a.id, b.id);
  });

  it('respeita validade', async () => {
    const m = await memories.remember({
      kind: 'fato',
      subject: 'Férias do perito',
      content: 'O perito está de férias.',
      ttlDays: 10,
    });
    assert.ok(m.expiresAt && m.expiresAt > Date.now());
  });

  it('marca substituição sem apagar o histórico', async () => {
    const velha = await memories.remember({ kind: 'fato', subject: 'Telefone do cartório', content: 'Telefone: 3333-1111.' });
    const nova = await memories.remember({ kind: 'fato', subject: 'Telefone do cartório novo', content: 'Telefone: 3333-2222.' });
    memories.supersede(velha.id, nova.id);
    assert.equal(memories.get(velha.id)!.supersededBy, nova.id);
    assert.ok(!memories.list({ kind: 'fato' }).some((m) => m.id === velha.id));
  });
});

describe('recuperação híbrida', () => {
  before(async () => {
    await memories.remember({
      kind: 'processo',
      subject: 'Processo do cliente Almeida',
      content: 'Processo 0001234-56.2024.5.08.0011 do cliente João Almeida, reclamação trabalhista contra a Transportes Norte.',
      importance: 0.9,
    });
    await memories.remember({
      kind: 'pessoa',
      subject: 'João Almeida',
      content: 'João Almeida é motorista, cliente desde 2023, mora em Santana e prefere ser avisado por WhatsApp.',
      importance: 0.7,
    });
    await memories.remember({
      kind: 'preferencia',
      subject: 'Formato de resumo',
      content: 'O dono quer que resumos de processo comecem sempre pelo prazo mais próximo.',
      importance: 0.85,
    });
    await memories.remember({
      kind: 'fato',
      subject: 'Bolo',
      content: 'Receita de bolo de cenoura da avó, com cobertura de chocolate.',
      importance: 0.2,
    });
  });

  it('acha por palavra exata (número de processo)', async () => {
    const r = await retriever.search('0001234-56.2024.5.08.0011', { limit: 5 });
    assert.ok(r.length > 0);
    assert.ok(r[0]!.content.includes('Almeida'), `veio ${r[0]!.subject}`);
  });

  it('acha por sentido, sem a palavra exata', async () => {
    const r = await retriever.search('quem é o motorista que virou meu cliente', { limit: 5 });
    assert.ok(r.some((m) => m.subject === 'João Almeida'));
  });

  it('não traz o irrelevante para o topo', async () => {
    const r = await retriever.search('prazo do processo trabalhista', { limit: 3 });
    assert.ok(!r.some((m) => m.subject === 'Bolo'), 'a receita de bolo não tem nada a ver');
  });

  it('explica a pontuação', async () => {
    const r = await retriever.search('João Almeida', { limit: 1 });
    assert.ok(r[0]!.why.semantic >= 0);
    assert.ok(r[0]!.why.lexical > 0);
    assert.ok(r[0]!.score > 0);
  });

  it('conta o uso das memórias recuperadas', async () => {
    const antes = memories.list({ kind: 'pessoa' }).find((m) => m.subject === 'João Almeida')!;
    await retriever.search('João Almeida mora onde', { limit: 3 });
    const depois = memories.get(antes.id)!;
    assert.ok(depois.useCount > antes.useCount);
  });

  it('respeita o filtro por tipo', async () => {
    const r = await retriever.search('Almeida', { limit: 10, kinds: ['pessoa'] });
    assert.ok(r.every((m) => m.kind === 'pessoa'));
  });

  it('devolve vazio para pergunta sobre assunto inexistente', async () => {
    const r = await retriever.search('zqxjv plutônio interestelar', { limit: 5, minScore: 0.3 });
    assert.equal(r.length, 0);
  });
});

describe('conversas', () => {
  const conversations = () => new ConversationStore(store);

  it('cria, anexa e reconstrói na ordem', () => {
    const cs = conversations();
    const conv = cs.create('web', 'Teste');
    cs.append({ conversationId: conv.id, role: 'user', content: 'primeira', channel: 'web' });
    cs.append({ conversationId: conv.id, role: 'assistant', content: 'segunda', channel: 'web' });
    cs.append({ conversationId: conv.id, role: 'user', content: 'terceira', channel: 'web' });

    const msgs = cs.recent(conv.id, 10);
    assert.deepEqual(msgs.map((m) => m.content), ['primeira', 'segunda', 'terceira']);
    assert.equal(cs.get(conv.id)!.messageCount, 3);
  });

  it('retoma a conversa quente do mesmo canal', () => {
    const cs = conversations();
    const a = cs.current('whatsapp');
    cs.append({ conversationId: a.id, role: 'user', content: 'oi', channel: 'whatsapp' });
    const b = cs.current('whatsapp');
    assert.equal(a.id, b.id, 'deve continuar a mesma conversa');
  });

  it('preserva os blocos originais da API', () => {
    const cs = conversations();
    const conv = cs.create('web');
    const blocks = [{ type: 'text', text: 'olá' }];
    cs.append({ conversationId: conv.id, role: 'user', content: 'olá', channel: 'web', blocks });
    const api = cs.toApiMessages(conv.id, 10);
    assert.deepEqual(api[0]!.content, blocks);
  });

  it('garante que o histórico da API comece por user', () => {
    const cs = conversations();
    const conv = cs.create('web');
    cs.append({ conversationId: conv.id, role: 'assistant', content: 'resposta órfã', channel: 'web' });
    cs.append({ conversationId: conv.id, role: 'user', content: 'pergunta', channel: 'web' });
    const api = cs.toApiMessages(conv.id, 10);
    assert.equal(api[0]!.role, 'user');
  });

  /**
   * A conversa que morre para sempre.
   *
   * Um `tool_use` gravado sem o `tool_result` dele, com a conversa continuando
   * por cima, faz a API devolver 400 em TODA mensagem seguinte — não dá para
   * sair disso recarregando a página nem reiniciando. Aconteceu de verdade na
   * instalação do dono: o navegador falhou, o modelo recusou a ação seguinte, e
   * o turno morreu no meio.
   */
  it('responde chamada de ferramenta que ficou pendurada no meio da conversa', () => {
    const cs = conversations();
    const conv = cs.create('web');
    const anexar = (role: 'user' | 'assistant', blocks: unknown[]) =>
      cs.append({ conversationId: conv.id, role, content: 'x', channel: 'web', blocks: blocks as never });

    anexar('user', [{ type: 'text', text: 'abre o processo' }]);
    // O turno que morreu: chamou a ferramenta e nunca recebeu resposta.
    anexar('assistant', [{ type: 'tool_use', id: 'toolu_perdida', name: 'abrir_pagina', input: {} }]);
    // E a conversa seguiu por cima, que é o que torna o defeito permanente.
    anexar('user', [{ type: 'text', text: 'e aí, conseguiu?' }]);
    anexar('assistant', [{ type: 'text', text: 'deixa eu ver' }]);

    const api = cs.toApiMessages(conv.id, 20);

    const chamadas: string[] = [];
    const respostas: string[] = [];
    for (const m of api) {
      for (const b of (m.content as Array<Record<string, unknown>>) ?? []) {
        if (b?.type === 'tool_use') chamadas.push(String(b.id));
        if (b?.type === 'tool_result') respostas.push(String(b.tool_use_id));
      }
    }

    assert.ok(chamadas.includes('toolu_perdida'), 'a chamada continua no histórico');
    assert.ok(respostas.includes('toolu_perdida'), 'e agora tem resposta — senão a API recusa tudo');

    // A resposta sintética tem que vir IMEDIATAMENTE depois da chamada.
    const iChamada = api.findIndex((m) =>
      ((m.content as Array<Record<string, unknown>>) ?? []).some((b) => b?.type === 'tool_use'),
    );
    const seguinte = api[iChamada + 1];
    assert.equal(seguinte?.role, 'user');
    assert.ok(
      ((seguinte!.content as Array<Record<string, unknown>>) ?? []).some(
        (b) => b?.type === 'tool_result' && b.tool_use_id === 'toolu_perdida',
      ),
    );
  });

  it('não mexe numa conversa onde toda chamada já tem resposta', () => {
    const cs = conversations();
    const conv = cs.create('web');
    const anexar = (role: 'user' | 'assistant', blocks: unknown[]) =>
      cs.append({ conversationId: conv.id, role, content: 'x', channel: 'web', blocks: blocks as never });

    anexar('user', [{ type: 'text', text: 'oi' }]);
    anexar('assistant', [{ type: 'tool_use', id: 'toolu_ok', name: 'info_sistema', input: {} }]);
    anexar('user', [{ type: 'tool_result', tool_use_id: 'toolu_ok', content: 'tudo certo' }]);
    anexar('assistant', [{ type: 'text', text: 'pronto' }]);

    const api = cs.toApiMessages(conv.id, 20);
    assert.equal(api.length, 4, 'nada deveria ter sido acrescentado');
  });

  it('descarta resultado de ferramenta sem a chamada correspondente', () => {
    // O espelho do caso anterior, e a segunda metade do mesmo estrago: sobrou
    // um `tool_result` cujo `tool_use` não existe. A API recusa igual.
    const cs = conversations();
    const conv = cs.create('web');
    const anexar = (role: 'user' | 'assistant', blocks: unknown[]) =>
      cs.append({ conversationId: conv.id, role, content: 'x', channel: 'web', blocks: blocks as never });

    anexar('user', [{ type: 'text', text: 'oi' }]);
    anexar('assistant', [{ type: 'tool_use', id: 'toolu_real', name: 'info_sistema', input: {} }]);
    anexar('user', [
      { type: 'tool_result', tool_use_id: 'toolu_real', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'toolu_fantasma', content: 'sobra de um turno morto' },
    ]);
    anexar('assistant', [{ type: 'text', text: 'pronto' }]);

    const api = cs.toApiMessages(conv.id, 20);
    const resultados = api.flatMap((m) =>
      ((m.content as Array<Record<string, unknown>>) ?? [])
        .filter((b) => b?.type === 'tool_result')
        .map((b) => String(b.tool_use_id)),
    );
    assert.deepEqual(resultados, ['toolu_real'], 'o fantasma tem que sair');
  });

  it('a mensagem que só tinha resultado órfão desaparece inteira', () => {
    const cs = conversations();
    const conv = cs.create('web');
    const anexar = (role: 'user' | 'assistant', blocks: unknown[]) =>
      cs.append({ conversationId: conv.id, role, content: 'x', channel: 'web', blocks: blocks as never });

    anexar('user', [{ type: 'text', text: 'oi' }]);
    anexar('assistant', [{ type: 'text', text: 'olá' }]);
    anexar('user', [{ type: 'tool_result', tool_use_id: 'toolu_fantasma', content: 'sobra' }]);
    anexar('assistant', [{ type: 'text', text: 'seguindo' }]);

    const api = cs.toApiMessages(conv.id, 20);
    assert.ok(
      !api.some((m) =>
        ((m.content as Array<Record<string, unknown>>) ?? []).some((b) => b?.type === 'tool_result'),
      ),
      'não pode sobrar resultado nenhum',
    );
  });

  /**
   * A rede por baixo das outras.
   *
   * Em vez de listar mais um caso quebrado, este confere a **regra** em várias
   * bagunças de uma vez: saia o que sair de `toApiMessages`, cada resultado tem
   * a chamada dele imediatamente antes, e cada chamada tem o resultado dela
   * imediatamente depois. Foi a falta dessa checagem que deixou eu consertar
   * uma ponta e entregar a outra quebrada.
   */
  it('o histórico que vai para a API é sempre coerente', () => {
    const bagunças: Array<Array<[('user' | 'assistant'), unknown[]]>> = [
      [['user', [{ type: 'text', text: 'a' }]], ['assistant', [{ type: 'tool_use', id: 't1', name: 'x', input: {} }]]],
      [
        ['user', [{ type: 'text', text: 'a' }]],
        ['assistant', [{ type: 'tool_use', id: 't1', name: 'x', input: {} }]],
        ['user', [{ type: 'tool_result', tool_use_id: 't2', content: 'errado' }]],
        ['assistant', [{ type: 'text', text: 'b' }]],
      ],
      [
        ['user', [{ type: 'tool_result', tool_use_id: 't0', content: 'órfão no começo' }]],
        ['assistant', [{ type: 'tool_use', id: 't1', name: 'x', input: {} }]],
        ['user', [{ type: 'text', text: 'segue' }]],
        ['assistant', [{ type: 'tool_use', id: 't2', name: 'y', input: {} }]],
        ['user', [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }]],
        ['assistant', [{ type: 'text', text: 'fim' }]],
      ],
    ];

    for (const [n, roteiro] of bagunças.entries()) {
      const cs = conversations();
      const conv = cs.create('web');
      for (const [role, blocks] of roteiro) {
        cs.append({ conversationId: conv.id, role, content: 'x', channel: 'web', blocks: blocks as never });
      }
      const api = cs.toApiMessages(conv.id, 30);
      const blocos = (m: unknown) => ((m as { content?: unknown })?.content ?? []) as Array<Record<string, unknown>>;

      for (let i = 0; i < api.length; i++) {
        const chamadas = blocos(api[i]).filter((b) => b?.type === 'tool_use').map((b) => String(b.id));
        const respostas = blocos(api[i + 1]).filter((b) => b?.type === 'tool_result').map((b) => String(b.tool_use_id));
        assert.deepEqual(
          chamadas.slice().sort(),
          respostas.slice().sort(),
          `bagunça ${n}, posição ${i}: chamadas e respostas não batem`,
        );
      }
      if (api.length) assert.equal(api[0]!.role, 'user', `bagunça ${n}: precisa começar por user`);
    }
  });

  it('atende as duas chamadas quando o modelo pede ferramentas em paralelo', () => {
    const cs = conversations();
    const conv = cs.create('web');
    const anexar = (role: 'user' | 'assistant', blocks: unknown[]) =>
      cs.append({ conversationId: conv.id, role, content: 'x', channel: 'web', blocks: blocks as never });

    anexar('user', [{ type: 'text', text: 'faz as duas coisas' }]);
    anexar('assistant', [
      { type: 'tool_use', id: 'toolu_a', name: 'um', input: {} },
      { type: 'tool_use', id: 'toolu_b', name: 'dois', input: {} },
    ]);
    // Só uma respondeu — a API exige as duas na MESMA mensagem de resultados.
    anexar('user', [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'feito' }]);
    anexar('assistant', [{ type: 'text', text: 'e a outra?' }]);

    const api = cs.toApiMessages(conv.id, 20);
    const resultados = api.flatMap((m) =>
      ((m.content as Array<Record<string, unknown>>) ?? [])
        .filter((b) => b?.type === 'tool_result')
        .map((b) => String(b.tool_use_id)),
    );
    assert.deepEqual(resultados.sort(), ['toolu_a', 'toolu_b']);

    const comResultados = api.filter((m) =>
      ((m.content as Array<Record<string, unknown>>) ?? []).some((b) => b?.type === 'tool_result'),
    );
    assert.equal(comResultados.length, 1, 'os dois resultados vão na mesma mensagem');
  });
});

describe('envelhecimento e fusão', () => {
  it('reduz a importância do que ficou parado e preserva o fixado', async () => {
    const parada = await memories.remember({
      kind: 'fato',
      subject: 'Detalhe esquecível',
      content: 'Um detalhe qualquer que ninguém mais consultou.',
      importance: 0.6,
    });
    const fixada = await memories.remember({
      kind: 'fato',
      subject: 'Detalhe fixado',
      content: 'Algo que o dono mandou nunca esquecer.',
      importance: 0.6,
      pinned: true,
    });
    const antigo = Date.now() - 100 * DAY;
    store.db
      .prepare('UPDATE memories SET updated_at = ?, last_used_at = NULL WHERE id IN (?, ?)')
      .run(antigo, parada.id, fixada.id);

    const consolidator = new Consolidator(store, memories, new ConversationStore(store), 'Dono', embeddings);
    const changed = consolidator.decay();

    assert.ok(changed > 0);
    assert.ok(memories.get(parada.id)!.importance < 0.6, 'a parada deve desbotar');
    assert.equal(memories.get(fixada.id)!.importance, 0.6, 'a fixada não pode desbotar');
  });

  it('funde memórias quase idênticas', async () => {
    // skipDedup simula duas anotações feitas em dias diferentes — exatamente o
    // caso que a consolidação existe para resolver.
    const a = await memories.remember({
      kind: 'insight',
      subject: 'Padrão A',
      content: 'O dono costuma revisar petições no fim da tarde, entre 17h e 19h.',
      importance: 0.5,
      skipDedup: true,
    });
    const b = await memories.remember({
      kind: 'insight',
      subject: 'Padrão B',
      content: 'O dono costuma revisar petições no fim da tarde, entre 17h e 19h, quase todo dia.',
      importance: 0.55,
      skipDedup: true,
    });
    assert.notEqual(a.id, b.id, 'skipDedup precisa mesmo criar duas linhas');

    const consolidator = new Consolidator(store, memories, new ConversationStore(store), 'Dono', embeddings);
    consolidator.mergeDuplicates();

    const vivos = memories.list({ kind: 'insight' }).filter((m) => [a.id, b.id].includes(m.id));
    assert.equal(vivos.length, 1, 'só uma das duas deve sobreviver');
  });
});
