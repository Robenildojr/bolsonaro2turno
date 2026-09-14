import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

process.env.IRIS_KDF_N = '16384';

import { filtrar, janelaProibida, RETENCAO_DIAS } from '../src/observer/index.js';
import { descreverPlataforma, verificarDisponibilidade } from '../src/observer/capture.js';
import { loadConfig } from '../src/config.js';

let tmp: string;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-obs-'));
  process.env.IRIS_HOME = tmp;
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.IRIS_HOME;
});

describe('filtro de conteúdo', () => {
  const cfg = () => loadConfig({ reload: true });

  it('deixa passar texto de trabalho comum', () => {
    for (const texto of [
      'Excelentíssimo Senhor Doutor Juiz da 2ª Vara do Trabalho',
      'Processo 0001234-56.2024.5.08.0011',
      'https://pje.trt8.jus.br/consulta',
      'Reunião com o Almeida na quinta às 15h',
    ]) {
      assert.equal(filtrar(texto, cfg()), texto, `deveria passar: ${texto}`);
    }
  });

  it('bloqueia chave de API', () => {
    assert.equal(filtrar('sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456', cfg()), null);
    assert.equal(filtrar('minha chave: ghp_abcdefghijklmnopqrstuvwxyz1234', cfg()), null);
    assert.equal(filtrar('token ya29.a0AfH6SMBabcdefghijklmnopqrstuv', cfg()), null);
    assert.equal(filtrar('AIzaSyD-abcdefghijklmnopqrstuvwxyz12345', cfg()), null);
  });

  it('bloqueia chave privada', () => {
    const chave = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    assert.equal(filtrar(chave, cfg()), null);
  });

  it('bloqueia o que parece cartão de crédito', () => {
    assert.equal(filtrar('4111 1111 1111 1111', cfg()), null);
    assert.equal(filtrar('cartão 5555-5555-5555-4444 validade 12/28', cfg()), null);
  });

  it('bloqueia texto com rótulo de senha', () => {
    assert.equal(filtrar('senha: MinhaSenha123', cfg()), null);
    assert.equal(filtrar('password = hunter2', cfg()), null);
    assert.equal(filtrar('api_key: abcdef', cfg()), null);
    assert.equal(filtrar('SENHA : outra', cfg()), null, 'precisa ser insensível a caixa');
  });

  it('descarta fragmento curto demais e arquivo inteiro', () => {
    assert.equal(filtrar('ok', cfg()), null);
    assert.equal(filtrar('  ', cfg()), null);
    assert.equal(filtrar('x'.repeat(25_000), cfg()), null);
  });

  it('apara as bordas', () => {
    assert.equal(filtrar('   texto com espaço   ', cfg()), 'texto com espaço');
  });

  it('padrão inválido na configuração não derruba a captura', () => {
    const configurado = cfg();
    configurado.observer.redactPatterns = ['[regex quebrada(', 'senha'];
    assert.equal(filtrar('texto inofensivo', configurado), 'texto inofensivo');
    assert.equal(filtrar('a senha é 123', configurado), null, 'o padrão válido ainda vale');
  });
});

describe('janelas bloqueadas', () => {
  it('reconhece gerenciadores de senha', () => {
    for (const titulo of [
      '1Password',
      'Bitwarden — Cofre',
      'KeePassXC',
      'Acesso às Chaves',
      'LastPass - Google Chrome',
    ]) {
      assert.ok(janelaProibida(titulo), `deveria bloquear: ${titulo}`);
    }
  });

  it('reconhece internet banking', () => {
    for (const titulo of [
      'Nubank — Conta',
      'Itau Internet Banking',
      'Banco do Brasil - Google Chrome',
      'Bradesco Net Empresa',
    ]) {
      assert.ok(janelaProibida(titulo), `deveria bloquear: ${titulo}`);
    }
  });

  it('não bloqueia janela de trabalho normal', () => {
    for (const titulo of [
      'PJe — Processo Judicial Eletrônico',
      'peticao-almeida.docx — LibreOffice Writer',
      'Gmail - Google Chrome',
      'Terminal',
    ]) {
      assert.ok(!janelaProibida(titulo), `não deveria bloquear: ${titulo}`);
    }
  });
});

describe('plataforma', () => {
  it('descreve o que está em uso', () => {
    const descricao = descreverPlataforma();
    assert.ok(descricao.length > 3);
    if (process.platform === 'linux') assert.match(descricao, /Linux/);
  });

  it('diagnostica o que falta em vez de falhar calado', async () => {
    const disp = await verificarDisponibilidade();
    assert.equal(typeof disp.clipboard, 'boolean');
    assert.equal(typeof disp.janela, 'boolean');
    assert.ok(Array.isArray(disp.faltando));
    // Se alguma fonte não está disponível, precisa dizer o que instalar.
    if (!disp.clipboard || !disp.janela) {
      assert.ok(disp.faltando.length > 0, 'faltando não pode estar vazio quando algo não funciona');
    }
  });
});

describe('padrões do observador', () => {
  it('nasce desligado', () => {
    const cfg = loadConfig({ reload: true });
    assert.equal(cfg.observer.enabled, false, 'o observador NUNCA pode vir ligado de fábrica');
    assert.equal(cfg.observer.clipboard, false);
    assert.equal(cfg.observer.activeWindow, false);
  });

  it('a retenção é finita', () => {
    assert.ok(RETENCAO_DIAS > 0 && RETENCAO_DIAS <= 90);
  });

  it('a lista de redação padrão cobre os rótulos óbvios', () => {
    const cfg = loadConfig({ reload: true });
    const juntos = cfg.observer.redactPatterns.join(' ');
    for (const termo of ['senha', 'password', 'secret', 'api']) {
      assert.ok(juntos.includes(termo), `faltou cobrir "${termo}"`);
    }
  });
});
