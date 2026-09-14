import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { blindIndex, extractTerms, open, seal, sealJson, openJson } from '../src/core/crypto/cipher.js';
import { Keyring, assertPassphraseStrength } from '../src/core/crypto/keyring.js';
import { Store } from '../src/core/db/database.js';
import { Vault } from '../src/core/vault/vault.js';

process.env.IRIS_KDF_N = '16384'; // custo baixo só nos testes

let tmp: string;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-test-'));
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('cifra', () => {
  const key = Buffer.alloc(32, 7);

  it('abre o que selou', () => {
    const sealed = seal(key, 'processo 0001234-56.2024.5.08.0011');
    assert.equal(open(key, sealed).toString('utf8'), 'processo 0001234-56.2024.5.08.0011');
  });

  it('recusa chave errada', () => {
    const sealed = seal(key, 'segredo');
    assert.throws(() => open(Buffer.alloc(32, 8), sealed), /falha ao decifrar/);
  });

  it('amarra o texto cifrado ao lugar dele (AAD)', () => {
    const sealed = seal(key, 'segredo', 'messages:content:abc');
    assert.throws(() => open(key, sealed, 'messages:content:xyz'), /falha ao decifrar/);
    assert.equal(open(key, sealed, 'messages:content:abc').toString('utf8'), 'segredo');
  });

  it('detecta adulteração de um único bit', () => {
    const sealed = seal(key, 'valor original');
    sealed[sealed.length - 1] ^= 0x01;
    assert.throws(() => open(key, sealed), /falha ao decifrar/);
  });

  it('nunca repete o texto cifrado para o mesmo dado', () => {
    const a = seal(key, 'igual');
    const b = seal(key, 'igual');
    assert.notEqual(a.toString('base64'), b.toString('base64'));
  });

  it('serializa e recupera JSON', () => {
    const value = { processo: '123', partes: ['a', 'b'], ativo: true };
    assert.deepEqual(openJson(key, sealJson(key, value)), value);
  });
});

describe('índice cego', () => {
  const key = Buffer.alloc(32, 3);

  it('é determinístico e insensível a acento e caixa', () => {
    assert.equal(blindIndex(key, 'Audiência'), blindIndex(key, 'audiencia'));
    assert.equal(blindIndex(key, ' AUDIENCIA '), blindIndex(key, 'audiencia'));
  });

  it('separa termos diferentes', () => {
    assert.notEqual(blindIndex(key, 'audiencia'), blindIndex(key, 'sentenca'));
  });

  it('muda com a chave', () => {
    assert.notEqual(blindIndex(key, 'x'), blindIndex(Buffer.alloc(32, 4), 'x'));
  });

  it('extrai termos úteis e descarta ruído', () => {
    const termos = extractTerms('O cliente pediu a revisão do benefício do INSS para o dia 12');
    assert.ok(termos.includes('cliente'));
    assert.ok(termos.includes('revisao'));
    assert.ok(termos.includes('inss'));
    assert.ok(!termos.includes('o'));
    assert.ok(!termos.includes('do'));
  });
});

describe('chaveiro', () => {
  it('cria, tranca e destranca', () => {
    const kr = new Keyring(path.join(tmp, 'k1.json'));
    kr.create('senha-mestra-forte-123!');
    assert.ok(kr.unlocked);
    const antes = kr.key('data').toString('hex');

    kr.lock();
    assert.equal(kr.unlocked, false);
    assert.throws(() => kr.key('data'), /trancado/);

    kr.unlock('senha-mestra-forte-123!');
    assert.equal(kr.key('data').toString('hex'), antes, 'a chave de dados precisa sobreviver ao ciclo');
  });

  it('recusa senha errada', () => {
    const kr = new Keyring(path.join(tmp, 'k2.json'));
    kr.create('senha-mestra-forte-123!');
    kr.lock();
    assert.throws(() => kr.unlock('senha errada qualquer'), /senha-mestra incorreta/);
  });

  it('deriva chaves distintas por propósito', () => {
    const kr = new Keyring(path.join(tmp, 'k3.json'));
    kr.create('senha-mestra-forte-123!');
    const usos = ['data', 'index', 'backup', 'vault', 'audit'] as const;
    const chaves = usos.map((u) => kr.key(u).toString('hex'));
    assert.equal(new Set(chaves).size, usos.length);
  });

  it('troca a senha sem invalidar os dados já cifrados', () => {
    const file = path.join(tmp, 'k4.json');
    const kr = new Keyring(file);
    kr.create('senha-mestra-forte-123!');
    const dado = seal(kr.key('data'), 'memória antiga');
    kr.lock();

    kr.changePassphrase('senha-mestra-forte-123!', 'outra-senha-mestra-456!');
    kr.lock();
    kr.unlock('outra-senha-mestra-456!');

    assert.equal(open(kr.key('data'), dado).toString('utf8'), 'memória antiga');
    assert.throws(() => new Keyring(file).unlock('senha-mestra-forte-123!'), /incorreta/);
  });

  it('exige senha com alguma força', () => {
    assert.throws(() => assertPassphraseStrength('123'), /12 caracteres/);
    assert.throws(() => assertPassphraseStrength('somenteletras'), /fraca/);
    assert.doesNotThrow(() => assertPassphraseStrength('umaFraseLongaDeSenhaQueEuLembro'));
    assert.doesNotThrow(() => assertPassphraseStrength('Curta1!curta'));
  });

  it('não sobrescreve um chaveiro existente', () => {
    const file = path.join(tmp, 'k5.json');
    const kr = new Keyring(file);
    kr.create('senha-mestra-forte-123!');
    assert.throws(() => new Keyring(file).create('outra-senha-mestra-456!'), /já existe/);
  });
});

describe('banco e cofre', () => {
  let kr: Keyring;
  let store: Store;
  let vault: Vault;

  before(() => {
    kr = new Keyring(path.join(tmp, 'kdb.json'));
    kr.create('senha-mestra-forte-123!');
    store = new Store(path.join(tmp, 'iris.db'), kr);
    vault = new Vault(store, kr);
  });

  it('aplica todas as migrações', () => {
    assert.equal(Number(store.db.pragma('user_version', { simple: true })), 3);
    const tabelas = (
      store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    ).map((r) => r.name);
    for (const t of ['memories', 'capabilities', 'vault_items', 'reminders', 'processes', 'jobs']) {
      assert.ok(tabelas.includes(t), `faltou a tabela ${t}`);
    }
  });

  it('guarda e recupera valores chave-valor cifrados', () => {
    store.setKv('teste', { a: 1, b: 'dois' });
    assert.deepEqual(store.getKv('teste', null), { a: 1, b: 'dois' });
    assert.equal(store.getKv('inexistente', 'padrão'), 'padrão');
  });

  it('grava credencial sem deixar o valor legível no arquivo', () => {
    vault.set('pje.senha', 'SenhaSuperSecreta#9', {
      meta: { service: 'pje.trt8.jus.br', username: 'robenildo' },
    });
    assert.equal(vault.get('pje.senha'), 'SenhaSuperSecreta#9');

    const bruto = store.db.prepare('SELECT value_enc FROM vault_items WHERE name = ?').get('pje.senha') as {
      value_enc: Buffer;
    };
    assert.ok(!bruto.value_enc.toString('utf8').includes('SenhaSuperSecreta'));
  });

  it('lista credenciais sem expor valores', () => {
    const itens = vault.list();
    const item = itens.find((i) => i.name === 'pje.senha');
    assert.ok(item);
    assert.equal(item!.meta.service, 'pje.trt8.jus.br');
    assert.ok(!JSON.stringify(itens).includes('SenhaSuperSecreta'));
  });

  it('substitui referências {{cofre:...}} só na hora do uso', () => {
    const args = {
      url: 'https://pje.trt8.jus.br/login',
      campos: { usuario: 'robenildo', senha: '{{cofre:pje.senha}}' },
    };
    assert.deepEqual(Vault.refsIn(args), ['pje.senha']);

    const { value, used } = vault.resolveRefs(args);
    assert.equal(value.campos.senha, 'SenhaSuperSecreta#9');
    assert.deepEqual(used, ['pje.senha']);
    // o objeto original continua sem o segredo
    assert.equal(args.campos.senha, '{{cofre:pje.senha}}');
  });

  it('falha alto quando a referência não existe', () => {
    assert.throws(() => vault.resolveRefs({ x: '{{cofre:nao.existe}}' }), /não existe no cofre/);
  });

  it('apaga credencial', () => {
    vault.set('temp.token', 'abc');
    assert.equal(vault.delete('temp.token'), true);
    assert.equal(vault.get('temp.token'), null);
  });

  after(() => store.close());
});
