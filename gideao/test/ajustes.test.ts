/**
 * Ajustes e memória de nascimento.
 *
 * O foco dos testes de ajuste é a **fronteira**, não a gravação: o que importa
 * garantir é que nem a conversa nem a tela alcancem uma chave que não está no
 * registro. Gravar um número no lugar certo é fácil; o que quebra sistema é o
 * dia em que "mudar uma configuração" passa a incluir `server.accessToken`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.GIDEAO_KDF_N = '16384';

import { AJUSTES, aplicarAjustes, lerAjustes } from '../src/core/settings/ajustes.js';
import { caminhoPadrao } from '../src/core/memory/genese.js';
import { MEMORY_KINDS } from '../src/core/memory/types.js';
import { loadConfig, saveConfig } from '../src/config.js';

let tmp: string;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gideao-aj-'));
  process.env.GIDEAO_HOME = tmp;
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.GIDEAO_HOME;
});

beforeEach(() => {
  // Volta a configuração ao padrão entre os testes.
  fs.rmSync(path.join(tmp, 'config.json'), { force: true });
  loadConfig({ reload: true });
});

describe('a fronteira do que pode ser ajustado', () => {
  it('recusa chave que não está no registro', () => {
    const r = aplicarAjustes({ 'server.accessToken': 'roubado' }, 'interface');
    assert.equal(r.aplicados.length, 0);
    assert.equal(r.recusados.length, 1);
    assert.match(r.recusados[0]!.motivo, /não é um ajuste/);
    // E o valor não entrou na configuração de jeito nenhum.
    assert.notEqual(loadConfig({ reload: true }).server.accessToken, 'roubado');
  });

  it('nenhuma chave de segredo aparece no registro', () => {
    // Lista explícita das chaves que de fato carregam segredo na configuração.
    // Nomear uma a uma em vez de usar um padrão evita as duas falhas do padrão:
    // deixar passar um segredo com nome criativo, e barrar um ajuste inocente
    // — foi o que aconteceu com `model.maxTokens`, que é tamanho de resposta e
    // não tem nada de secreto, mas casa com "token".
    const segredos = [
      'server.accessToken',
      'whatsapp.accessToken',
      'whatsapp.appSecret',
      'whatsapp.verifyToken',
      'whatsapp.phoneNumberId',
      'whatsapp.owner',
      'drive.clientId',
      'drive.clientSecret',
      'justice.datajudApiKey',
      'email.user',
      'home',
    ];
    const registradas = new Set(AJUSTES.map((a) => a.chave));
    for (const chave of segredos) {
      assert.ok(!registradas.has(chave), `${chave} não pode ser ajustável`);
    }
  });

  it('nenhum ajuste novo entra com cara de segredo sem revisão', () => {
    // Rede de segurança para nome que eu não previ. `maxTokens` está liberado
    // de propósito: é o teto de tamanho da resposta.
    const liberadas = new Set(['model.maxTokens']);
    const suspeita = /secret|senha|password|apikey|api[_-]?key|accesstoken|verifytoken/i;
    for (const a of AJUSTES) {
      if (liberadas.has(a.chave)) continue;
      assert.ok(!suspeita.test(a.chave), `${a.chave} parece segredo — confira antes de liberar`);
    }
  });

  it('o número do dono no WhatsApp fica fora — é controle de acesso', () => {
    const r = aplicarAjustes({ 'whatsapp.owner': '5511999999999' }, 'conversa');
    assert.equal(r.aplicados.length, 0);
    assert.equal(loadConfig({ reload: true }).whatsapp.owner, '');
  });
});

describe('o que a conversa pode e o que só a tela pode', () => {
  it('a conversa muda a voz e a cor', () => {
    const r = aplicarAjustes({ 'voice.velocidade': 0.9, 'ui.matiz': 200 }, 'conversa');
    assert.equal(r.aplicados.length, 2);
    const cfg = loadConfig({ reload: true });
    assert.equal(cfg.voice.velocidade, 0.9);
    assert.equal(cfg.ui.matiz, 200);
  });

  it('a conversa NÃO afrouxa a confirmação de ação irreversível', () => {
    // O ponto: os próprios freios não se soltam por uma frase dita de passagem.
    const r = aplicarAjustes({ 'permissions.confirmCritical': false }, 'conversa');
    assert.equal(r.aplicados.length, 0);
    assert.match(r.recusados[0]!.motivo, /engrenagem|linha de comando/);
    assert.equal(loadConfig({ reload: true }).permissions.confirmCritical, true);
  });

  it('a engrenagem afrouxa, porque ali é o dono na tela', () => {
    const r = aplicarAjustes({ 'permissions.confirmCritical': false }, 'interface');
    assert.equal(r.aplicados.length, 1);
    assert.equal(loadConfig({ reload: true }).permissions.confirmCritical, false);
  });
});

describe('o observador só desliga por aqui', () => {
  it('não liga pela engrenagem', () => {
    const r = aplicarAjustes({ 'observer.enabled': true }, 'interface');
    assert.equal(r.aplicados.length, 0);
    assert.match(r.recusados[0]!.motivo, /só dá para desligar/);
    assert.equal(loadConfig({ reload: true }).observer.enabled, false);
  });

  it('desliga sem discussão quando está ligado', () => {
    saveConfig({ observer: { enabled: true } });
    const r = aplicarAjustes({ 'observer.enabled': false }, 'interface');
    assert.equal(r.aplicados.length, 1);
    assert.equal(loadConfig({ reload: true }).observer.enabled, false);
  });
});

describe('validação de valor', () => {
  it('respeita mínimo e máximo', () => {
    const baixo = aplicarAjustes({ 'voice.velocidade': 0.1 }, 'interface');
    assert.match(baixo.recusados[0]!.motivo, /mínimo/);
    const alto = aplicarAjustes({ 'voice.velocidade': 9 }, 'interface');
    assert.match(alto.recusados[0]!.motivo, /máximo/);
  });

  it('entende sim e não em português', () => {
    assert.equal(aplicarAjustes({ 'ui.legendas': 'não' }, 'interface').aplicados.length, 1);
    assert.equal(loadConfig({ reload: true }).ui.legendas, false);
    aplicarAjustes({ 'ui.legendas': 'sim' }, 'interface');
    assert.equal(loadConfig({ reload: true }).ui.legendas, true);
  });

  it('só aceita as opções declaradas quando há lista', () => {
    const r = aplicarAjustes({ 'model.effort': 'turbinado' }, 'interface');
    assert.equal(r.aplicados.length, 0);
    assert.match(r.recusados[0]!.motivo, /só aceito/);
  });

  it('valor igual ao atual não conta como mudança', () => {
    const atual = loadConfig({ reload: true }).ui.matiz;
    const r = aplicarAjustes({ 'ui.matiz': atual }, 'interface');
    assert.equal(r.aplicados.length, 0);
    assert.equal(r.recusados.length, 0);
  });

  it('lista vem de texto separado por linha', () => {
    aplicarAjustes({ 'updates.temas': 'um tema\noutro tema\n\n' }, 'conversa');
    assert.deepEqual(loadConfig({ reload: true }).updates.temas, ['um tema', 'outro tema']);
  });
});

describe('leitura dos ajustes', () => {
  it('todo ajuste do registro sai com um valor', () => {
    for (const a of lerAjustes(loadConfig({ reload: true }))) {
      assert.notEqual(a.valor, undefined, `${a.chave} não tem valor`);
      assert.ok(a.rotulo && a.ajuda, `${a.chave} sem rótulo ou ajuda`);
    }
  });
});

describe('memória de nascimento', () => {
  it('o arquivo existe e está bem formado', () => {
    const arquivo = caminhoPadrao();
    assert.ok(fs.existsSync(arquivo), `não achei ${arquivo}`);
    const dados = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    assert.ok(Array.isArray(dados.memorias) && dados.memorias.length >= 10);

    for (const m of dados.memorias) {
      assert.ok(MEMORY_KINDS.includes(m.kind), `tipo desconhecido: ${m.kind}`);
      assert.ok(m.subject?.length > 3, 'assunto curto demais');
      assert.ok(m.content?.length > 40, `conteúdo raso em "${m.subject}"`);
    }
  });

  it('os assuntos são únicos — senão a fusão por assunto perderia conteúdo', () => {
    const dados = JSON.parse(fs.readFileSync(caminhoPadrao(), 'utf8'));
    const assuntos = dados.memorias.map((m: { subject: string }) => m.subject);
    assert.equal(new Set(assuntos).size, assuntos.length);
  });

  it('não carrega nada que pareça credencial', () => {
    const bruto = fs.readFileSync(caminhoPadrao(), 'utf8');
    assert.ok(!/sk-ant-|senha\s*[:=]\s*\S|token\s*[:=]\s*\S{8}/i.test(bruto));
  });
});
