import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

process.env.IRIS_KDF_N = '16384';

import { Keyring } from '../src/core/crypto/keyring.js';
import { Store } from '../src/core/db/database.js';
import { Vault } from '../src/core/vault/vault.js';
import { Agenda } from '../src/core/scheduler/agenda.js';
import { MemoryStore } from '../src/core/memory/store.js';
import { LocalEmbeddings } from '../src/core/memory/embeddings.js';
import { ConversationStore } from '../src/core/memory/conversations.js';
import {
  coletar,
  desempacotar,
  empacotar,
  nomeDoArquivo,
  resumirBackup,
} from '../src/integrations/drive/bundle.js';
import { DAY } from '../src/util/time.js';

const SENHA = 'senha-mestra-forte-123!';

let tmp: string;
let store: Store;
let vault: Vault;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-backup-'));
  process.env.IRIS_HOME = tmp;

  const keyring = new Keyring(path.join(tmp, 'k.json'));
  keyring.create(SENHA);
  store = new Store(path.join(tmp, 'iris.db'), keyring);
  vault = new Vault(store, keyring);

  // Popula com material de verdade, para o backup ter o que carregar.
  const memorias = new MemoryStore(store, new LocalEmbeddings());
  await memorias.remember({
    kind: 'pessoa',
    subject: 'João Almeida',
    content: 'Cliente desde 2023, motorista, prefere ser avisado por WhatsApp.',
    importance: 0.8,
  });
  await memorias.remember({
    kind: 'preferencia',
    subject: 'Formato de resumo',
    content: 'Resumos de processo começam pelo prazo mais próximo.',
    importance: 0.9,
    pinned: true,
  });

  const conversas = new ConversationStore(store);
  const conv = conversas.create('web', 'Primeira conversa');
  conversas.append({ conversationId: conv.id, role: 'user', content: 'oi, tudo bem?', channel: 'web' });
  conversas.append({ conversationId: conv.id, role: 'assistant', content: 'tudo. o que precisa?', channel: 'web' });

  vault.set('pje.senha', 'SenhaSuperSecreta#9', {
    meta: { service: 'pje.trt8.jus.br', username: 'robenildo' },
  });

  const agenda = new Agenda(store);
  agenda.criarLembrete({
    titulo: 'Audiência Almeida x Transportes Norte',
    quando: Date.now() + 5 * DAY,
    tipo: 'audiencia',
  });
  agenda.criarTarefa({ titulo: 'Protocolar apelação', prioridade: 1 });
});

after(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.IRIS_HOME;
});

describe('coleta do backup', () => {
  it('reúne tudo que importa', () => {
    const conteudo = coletar(store, vault, { assistente: 'Íris', dono: 'Robenildo' });
    assert.equal(conteudo.memorias.length, 2);
    assert.equal(conteudo.conversas.length, 1);
    assert.equal(conteudo.mensagens.length, 2);
    assert.equal(conteudo.cofre.length, 1);
    assert.equal(conteudo.lembretes.length, 1);
    assert.equal(conteudo.tarefas.length, 1);
  });

  it('descarta as colunas cifradas e guarda o texto legível', () => {
    const conteudo = coletar(store, vault, { assistente: 'Íris', dono: 'Robenildo' });
    const memoria = conteudo.memorias[0] as Record<string, unknown>;
    assert.ok(!('content_enc' in memoria), 'a coluna cifrada não vai para o pacote');
    assert.ok(String(memoria.content).length > 10);
  });

  it('resume de forma legível', () => {
    const resumo = resumirBackup(coletar(store, vault, { assistente: 'Íris', dono: 'R' }));
    assert.match(resumo, /Memórias: 2/);
    assert.match(resumo, /Credenciais: 1/);
  });
});

describe('pacote cifrado', () => {
  it('abre com a senha certa e devolve o mesmo conteúdo', () => {
    const original = coletar(store, vault, { assistente: 'Íris', dono: 'Robenildo' });
    const pacote = empacotar(original, SENHA);
    const lido = desempacotar(pacote, SENHA);

    assert.equal(lido.memorias.length, original.memorias.length);
    assert.equal(lido.origem.dono, 'Robenildo');
    assert.deepEqual(lido.cofre, original.cofre);
  });

  it('não abre com a senha errada', () => {
    const pacote = empacotar(coletar(store, vault, { assistente: 'Í', dono: 'R' }), SENHA);
    assert.throws(() => desempacotar(pacote, 'outra-senha-mestra-456!'), /senha-mestra errada/);
  });

  it('não deixa nada legível nos bytes — é isso que o Google armazena', () => {
    const pacote = empacotar(coletar(store, vault, { assistente: 'Í', dono: 'R' }), SENHA);
    const bruto = pacote.toString('latin1');

    for (const segredo of [
      'João Almeida',
      'SenhaSuperSecreta',
      'pje.trt8.jus.br',
      'Audiência',
      'Protocolar apelação',
      'tudo. o que precisa?',
    ]) {
      assert.ok(!bruto.includes(segredo), `vazou no pacote: "${segredo}"`);
    }
  });

  it('detecta adulteração de um único bit', () => {
    const pacote = empacotar(coletar(store, vault, { assistente: 'Í', dono: 'R' }), SENHA);
    pacote[pacote.length - 5] ^= 0x01;
    assert.throws(() => desempacotar(pacote, SENHA), /errada, ou o arquivo foi corrompido/);
  });

  it('recusa arquivo que não é backup da Íris', () => {
    // Do tamanho de um pacote real, para passar da checagem de truncamento e
    // chegar na verificação da assinatura do formato.
    const outroArquivo = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200, 0x41)]);
    assert.throws(() => desempacotar(outroArquivo, SENHA), /não parece um backup/);
  });

  it('recusa arquivo truncado', () => {
    assert.throws(() => desempacotar(Buffer.alloc(10), SENHA), /truncado/);
  });

  it('comprime: o pacote é menor que o JSON em claro', () => {
    const conteudo = coletar(store, vault, { assistente: 'Í', dono: 'R' });
    const claro = Buffer.byteLength(JSON.stringify(conteudo));
    const pacote = empacotar(conteudo, SENHA);
    assert.ok(pacote.length < claro, `pacote ${pacote.length} vs claro ${claro}`);
  });

  it('dois pacotes do mesmo conteúdo têm bytes diferentes (sal e IV novos)', () => {
    const conteudo = coletar(store, vault, { assistente: 'Í', dono: 'R' });
    const a = empacotar(conteudo, SENHA);
    const b = empacotar(conteudo, SENHA);
    assert.notEqual(a.toString('base64'), b.toString('base64'));
    // …e ambos abrem.
    assert.equal(desempacotar(a, SENHA).memorias.length, desempacotar(b, SENHA).memorias.length);
  });
});

describe('restauração em máquina nova', () => {
  it('abre só com a senha-mestra, sem o chaveiro original', () => {
    // Simula o pior caso: o computador se perdeu, restou o arquivo no Drive.
    const pacote = empacotar(coletar(store, vault, { assistente: 'Íris', dono: 'Robenildo' }), SENHA);

    const outro = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-novo-'));
    try {
      // Chaveiro totalmente novo, sem relação com o original.
      const keyringNovo = new Keyring(path.join(outro, 'k.json'));
      keyringNovo.create(SENHA);

      // O pacote abre mesmo assim, porque a chave dele vem da senha + sal interno.
      const conteudo = desempacotar(pacote, SENHA);
      assert.equal(conteudo.memorias.length, 2);
      assert.equal(conteudo.origem.dono, 'Robenildo');

      const cofre = conteudo.cofre[0] as Record<string, unknown>;
      assert.equal(cofre.value, 'SenhaSuperSecreta#9', 'a credencial precisa voltar utilizável');
    } finally {
      fs.rmSync(outro, { recursive: true, force: true });
    }
  });
});

describe('nome do arquivo', () => {
  it('é ordenável por data e não tem caractere problemático', () => {
    const nome = nomeDoArquivo(new Date('2026-09-14T18:30:45Z'));
    assert.match(nome, /^iris-2026-09-14T18-30-45\.iris$/);
    assert.ok(!/[:*?"<>|]/.test(nome));
  });

  it('gera nomes crescentes', () => {
    const a = nomeDoArquivo(new Date('2026-09-14T10:00:00Z'));
    const b = nomeDoArquivo(new Date('2026-09-14T11:00:00Z'));
    assert.ok(a < b, 'ordem alfabética precisa bater com a ordem cronológica');
  });
});
