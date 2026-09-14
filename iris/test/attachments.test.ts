import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';

process.env.IRIS_KDF_N = '16384';

import { Keyring } from '../src/core/crypto/keyring.js';
import { openStore, closeStore } from '../src/core/db/database.js';
import {
  carregar,
  descrever,
  ehReferencia,
  guardar,
  hidratar,
  hidratarHistorico,
  limparAntigos,
  metadados,
  referencia,
  JANELA_ANEXOS,
} from '../src/core/agent/attachments.js';
import { paths } from '../src/config.js';

/** PNG 1×1 de verdade, para o caminho ser o mesmo de uma foto real. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
/** Cabeçalho mínimo de PDF. */
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(500, 0x20), Buffer.from('\n%%EOF')]);

let tmp: string;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-anexo-'));
  process.env.IRIS_HOME = tmp;
  const keyring = new Keyring(path.join(tmp, 'k.json'));
  keyring.create('senha-mestra-forte-123!');
  openStore(path.join(tmp, 'iris.db'), keyring);
});

after(() => {
  closeStore();
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.IRIS_HOME;
});

describe('guardar anexo', () => {
  it('guarda imagem e devolve os metadados', async () => {
    const anexo = await guardar(PNG, { nome: 'intimacao.png', mime: 'image/png' });
    assert.equal(anexo.tipo, 'imagem');
    assert.equal(anexo.mime, 'image/png');
    assert.equal(anexo.bytes, PNG.length);
    assert.match(anexo.id, /^anx_/);
  });

  it('reconhece PDF pela extensão mesmo sem mime', async () => {
    const anexo = await guardar(PDF, { nome: 'peticao.pdf' });
    assert.equal(anexo.tipo, 'pdf');
    assert.equal(anexo.mime, 'application/pdf');
  });

  it('normaliza o mime da imagem para um dos quatro que a API aceita', async () => {
    const anexo = await guardar(PNG, { nome: 'foto.jpg', mime: 'image/pjpeg' });
    assert.equal(anexo.mime, 'image/jpeg', 'image/pjpeg seria recusado pela API');
  });

  it('recusa tipo que o modelo não lê', async () => {
    await assert.rejects(
      () => guardar(Buffer.from('MZ'), { nome: 'programa.exe', mime: 'application/x-msdownload' }),
      /não sei ler/,
    );
  });

  it('recusa arquivo acima do limite, com o número na mensagem', async () => {
    await assert.rejects(
      () => guardar(Buffer.alloc(6 * 1024 * 1024), { nome: 'enorme.png', mime: 'image/png' }),
      /6\.0 MB e o limite/,
    );
  });

  it('não deixa o conteúdo legível no disco', async () => {
    const texto = 'CONFIDENCIAL: dados do cliente João Almeida';
    const anexo = await guardar(Buffer.from(texto), { nome: 'nota.txt', mime: 'text/plain' });
    const bruto = fs.readFileSync(path.join(paths().cache, 'anexos', anexo.id));
    assert.ok(!bruto.toString('utf8').includes('João Almeida'));
    assert.ok(!bruto.toString('utf8').includes('CONFIDENCIAL'));
  });

  it('recupera o conteúdo idêntico ao original', async () => {
    const anexo = await guardar(PNG, { nome: 'igual.png', mime: 'image/png' });
    const voltou = await carregar(anexo.id);
    assert.ok(voltou);
    assert.equal(voltou!.toString('base64'), PNG.toString('base64'));
  });

  it('devolve nulo para id inexistente em vez de estourar', async () => {
    assert.equal(await carregar('anx_naoexiste'), null);
    assert.equal(metadados('anx_naoexiste'), null);
  });

  it('limpa barra do nome para não escapar da pasta', async () => {
    const anexo = await guardar(PNG, { nome: '../../etc/passwd.png', mime: 'image/png' });
    assert.ok(!anexo.nome.includes('/'));
    assert.ok(!anexo.nome.includes('\\'));
  });
});

describe('referência no histórico', () => {
  it('a referência é leve — sem base64 dentro', async () => {
    const anexo = await guardar(PNG, { nome: 'leve.png', mime: 'image/png' });
    const ref = referencia(anexo);
    assert.ok(ehReferencia(ref));
    const serializada = JSON.stringify(ref);
    assert.ok(serializada.length < 300, `referência com ${serializada.length} bytes`);
    assert.ok(!serializada.includes(PNG.toString('base64')));
  });

  it('não confunde outros blocos com referência', () => {
    assert.ok(!ehReferencia({ type: 'text', text: 'oi' }));
    assert.ok(!ehReferencia({ type: 'image' }));
    assert.ok(!ehReferencia(null));
  });

  it('descreve o anexo antigo de forma útil', async () => {
    const anexo = await guardar(PDF, { nome: 'antiga.pdf' });
    const texto = descrever(referencia(anexo));
    assert.match(texto, /antiga\.pdf/);
    assert.match(texto, /pdf/);
    assert.match(texto, /reenviar/);
  });
});

describe('hidratação', () => {
  it('imagem vira bloco image com base64', async () => {
    const anexo = await guardar(PNG, { nome: 'a.png', mime: 'image/png' });
    const bloco = (await hidratar(referencia(anexo)))!;
    assert.equal(bloco.type, 'image');
    const fonte = (bloco as { source: { type: string; media_type: string; data: string } }).source;
    assert.equal(fonte.type, 'base64');
    assert.equal(fonte.media_type, 'image/png');
    assert.equal(fonte.data, PNG.toString('base64'));
  });

  it('PDF vira bloco document', async () => {
    const anexo = await guardar(PDF, { nome: 'p.pdf' });
    const bloco = (await hidratar(referencia(anexo)))!;
    assert.equal(bloco.type, 'document');
    assert.equal((bloco as { title?: string }).title, 'p.pdf');
  });

  it('texto vira texto — mais barato que documento', async () => {
    const anexo = await guardar(Buffer.from('linha um\nlinha dois'), {
      nome: 'n.txt',
      mime: 'text/plain',
    });
    const bloco = (await hidratar(referencia(anexo)))!;
    assert.equal(bloco.type, 'text');
    assert.match((bloco as { text: string }).text, /linha um/);
  });

  it('anexo sumido do disco vira aviso, não exceção', async () => {
    const anexo = await guardar(PNG, { nome: 'some.png', mime: 'image/png' });
    fs.unlinkSync(path.join(paths().cache, 'anexos', anexo.id));
    const bloco = (await hidratar(referencia(anexo)))!;
    assert.equal(bloco.type, 'text');
    assert.match((bloco as { text: string }).text, /não está mais disponível/);
  });
});

describe('janela de anexos no histórico', () => {
  async function historicoCom(anexoRef: unknown, quantasMensagens: number) {
    const mensagens: Anthropic.Beta.BetaMessageParam[] = [
      { role: 'user', content: [anexoRef, { type: 'text', text: 'o que diz aqui?' }] as never },
    ];
    for (let i = 0; i < quantasMensagens; i++) {
      mensagens.push({ role: 'assistant', content: `resposta ${i}` });
      mensagens.push({ role: 'user', content: `pergunta ${i}` });
    }
    return mensagens;
  }

  it('anexo recente é enviado inteiro', async () => {
    const anexo = await guardar(PNG, { nome: 'recente.png', mime: 'image/png' });
    const historico = await historicoCom(referencia(anexo), 1);
    const hidratado = await hidratarHistorico(historico);

    const blocos = hidratado[0]!.content as Array<{ type: string }>;
    assert.equal(blocos[0]!.type, 'image', 'o conteúdo precisa estar lá');
  });

  it('anexo antigo vira descrição de texto — é isso que segura o custo', async () => {
    const anexo = await guardar(PNG, { nome: 'antigo.png', mime: 'image/png' });
    const historico = await historicoCom(referencia(anexo), JANELA_ANEXOS + 4);
    const hidratado = await hidratarHistorico(historico);

    const blocos = hidratado[0]!.content as Array<{ type: string; text?: string }>;
    assert.equal(blocos[0]!.type, 'text');
    assert.match(blocos[0]!.text!, /antigo\.png/);
    assert.match(blocos[0]!.text!, /reenviar/);
  });

  it('não sobra nenhuma referência crua depois da hidratação', async () => {
    const anexo = await guardar(PNG, { nome: 'x.png', mime: 'image/png' });
    const historico = await historicoCom(referencia(anexo), 12);
    const hidratado = await hidratarHistorico(historico);

    const serializado = JSON.stringify(hidratado);
    assert.ok(
      !serializado.includes('iris_anexo'),
      'a API recusaria um bloco de tipo desconhecido',
    );
  });

  it('mensagens sem anexo passam intactas', async () => {
    const historico: Anthropic.Beta.BetaMessageParam[] = [
      { role: 'user', content: 'texto simples' },
      { role: 'assistant', content: [{ type: 'text', text: 'resposta' }] },
    ];
    const hidratado = await hidratarHistorico(historico);
    assert.deepEqual(hidratado, historico);
  });
});

describe('limpeza', () => {
  it('descarta anexo vencido e mantém o recente', async () => {
    const velho = await guardar(PNG, { nome: 'velho.png', mime: 'image/png' });
    const novo = await guardar(PNG, { nome: 'novo.png', mime: 'image/png' });

    // Envelhece o registro, como o tempo faria.
    const { getStore } = await import('../src/core/db/database.js');
    getStore().setKv(`anexo:${velho.id}`, {
      ...metadados(velho.id)!,
      criadoEm: Date.now() - 200 * 86_400_000,
    });

    const removidos = await limparAntigos(90);
    assert.ok(removidos >= 1);
    assert.equal(metadados(velho.id), null);
    assert.ok(metadados(novo.id) !== null, 'o recente precisa sobreviver');
  });
});
