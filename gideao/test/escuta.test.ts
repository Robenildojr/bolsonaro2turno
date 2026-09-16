/**
 * Reconhecer o nome dele no meio da fala.
 *
 * Este é o pedaço da escuta contínua que dá para testar sem microfone, e é
 * justamente onde o erro é mais provável: "Gideão" é nome próprio incomum, e
 * reconhecedor de fala erra nome próprio o tempo todo. Se exigir a grafia
 * exata, o recurso parece quebrado metade das vezes e a pessoa passa a gritar o
 * nome — o que não melhora em nada o reconhecimento.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// @ts-expect-error — módulo do navegador, sem tipos; o acesso a `window` é protegido.
import { acharPalavraChave, limparPalavraChave, normalizar } from '../web/src/voice.js';

const CHAVE = 'gideao';
const ouviu = (frase: string) => acharPalavraChave(normalizar(frase), CHAVE) >= 0;

describe('normalização do que foi ouvido', () => {
  it('tira acento, pontuação e maiúscula', () => {
    assert.equal(normalizar('Gideão, tudo bem?'), 'gideao tudo bem');
    assert.equal(normalizar('  ESPAÇO   demais  '), 'espaco demais');
  });
});

describe('reconhecer o nome', () => {
  it('reconhece a grafia certa', () => {
    assert.ok(ouviu('Gideão'));
    assert.ok(ouviu('gideão, me lembra da audiência'));
  });

  it('tolera as variações que o reconhecedor produz', () => {
    for (const variação of [
      'gideao abre o processo',
      'gidião, que horas é a audiência',
      'gidiao me ajuda',
      'guideão consulta isso',
      'Gedeão, anota aí',
      'gideon abre o PJe',
    ]) {
      assert.ok(ouviu(variação), `não reconheceu em: ${variação}`);
    }
  });

  it('não acorda com palavra qualquer', () => {
    for (const frase of [
      'bom dia, doutor',
      'o processo do cliente Almeida',
      'preciso protocolar a apelação hoje',
      'a audiência é na segunda',
    ]) {
      assert.ok(!ouviu(frase), `acordou à toa em: ${frase}`);
    }
  });

  it('não acorda no meio de outra palavra', () => {
    // O limite de palavra evita que "ideia" ou "guia" disparem por acidente.
    assert.ok(!ouviu('preciso de uma ideia melhor'));
    assert.ok(!ouviu('o guia do processo'));
  });
});

describe('separar o comando do nome', () => {
  it('tira o nome do começo e devolve só a ordem', () => {
    assert.equal(limparPalavraChave('Gideão, abre o processo do Almeida', CHAVE), 'abre o processo do Almeida');
    assert.equal(limparPalavraChave('gideao me lembra amanhã', CHAVE), 'me lembra amanhã');
  });

  it('não corta o nome quando ele está no meio da frase', () => {
    // Aqui o nome é assunto, não chamada — cortar mudaria o sentido do pedido.
    const frase = 'anota que o nome do sistema é Gideão';
    assert.equal(limparPalavraChave(frase, CHAVE), frase);
  });

  it('frase sem o nome volta inteira', () => {
    assert.equal(limparPalavraChave('abre o processo', CHAVE), 'abre o processo');
  });
});
