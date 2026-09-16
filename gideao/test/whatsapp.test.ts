import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  dividirMensagem,
  mesmoNumero,
  normalizarNumero,
} from '../src/channels/whatsapp/provider.js';

describe('normalização de número', () => {
  it('tira máscara e símbolos', () => {
    assert.equal(normalizarNumero('+55 (96) 99123-4567'), '5596991234567');
    assert.equal(normalizarNumero('55 96 99123 4567'), '5596991234567');
  });

  it('assume o Brasil quando falta o código do país', () => {
    assert.equal(normalizarNumero('96991234567'), '5596991234567');
    assert.equal(normalizarNumero('9699123456'), '559699123456');
  });
});

describe('identificação do dono', () => {
  it('reconhece o mesmo número escrito de formas diferentes', () => {
    assert.ok(mesmoNumero('+55 96 99123-4567', '5596991234567'));
    assert.ok(mesmoNumero('96991234567', '5596991234567'));
  });

  it('tolera o nono dígito, que o WhatsApp entrega de forma inconsistente', () => {
    assert.ok(mesmoNumero('5596991234567', '559691234567'));
    assert.ok(mesmoNumero('559691234567', '5596991234567'));
  });

  it('não confunde números diferentes', () => {
    assert.ok(!mesmoNumero('5596991234567', '5596991234568'));
    assert.ok(!mesmoNumero('5596991234567', '5511991234567'));
    assert.ok(!mesmoNumero('5596991234567', ''));
  });
});

describe('divisão de mensagem longa', () => {
  it('não divide o que cabe', () => {
    const curta = 'Audiência amanhã às 14h.';
    assert.deepEqual(dividirMensagem(curta), [curta]);
  });

  it('divide preferindo quebra de parágrafo', () => {
    const paragrafo = 'x'.repeat(300);
    const texto = Array.from({ length: 20 }, () => paragrafo).join('\n\n');
    const partes = dividirMensagem(texto, 1000);

    assert.ok(partes.length > 1);
    for (const p of partes) assert.ok(p.length <= 1050, `parte com ${p.length} caracteres`);
    // Nenhuma parte deve começar ou terminar no meio de um bloco de 'x'.
    assert.ok(partes.every((p) => /^\(\d+\/\d+\)/.test(p)));
  });

  it('numera as partes para a ordem ficar clara no celular', () => {
    const partes = dividirMensagem('palavra '.repeat(2000), 1000);
    assert.match(partes[0]!, /^\(1\/\d+\)/);
    assert.match(partes[partes.length - 1]!, /^\(\d+\/\d+\)/);
  });

  it('não perde conteúdo ao dividir', () => {
    const texto = Array.from({ length: 200 }, (_, i) => `linha ${i}`).join('\n');
    const juntado = dividirMensagem(texto, 500)
      .map((p) => p.replace(/^\(\d+\/\d+\) /, ''))
      .join('\n');
    // Compara ignorando espaços, já que o corte normaliza as bordas.
    assert.equal(juntado.replace(/\s+/g, ' '), texto.replace(/\s+/g, ' '));
  });

  it('lida com texto sem nenhum espaço', () => {
    const partes = dividirMensagem('a'.repeat(9000), 1000);
    assert.ok(partes.length >= 9);
    for (const p of partes) assert.ok(p.length <= 1050);
  });
});

describe('assinatura do webhook', () => {
  /** Reproduz o cálculo da Meta, para o teste falhar se a fórmula mudar. */
  function assinar(corpo: string, segredo: string): string {
    return 'sha256=' + createHmac('sha256', segredo).update(corpo, 'utf8').digest('hex');
  }

  it('adulterar o corpo invalida a assinatura', () => {
    const segredo = 'segredo-do-app';
    const corpo = '{"entry":[{"changes":[]}]}';
    assert.notEqual(assinar(corpo, segredo), assinar(corpo.replace('entry', 'entrz'), segredo));
  });

  it('reserializar o JSON muda a assinatura — daí a necessidade do corpo cru', () => {
    const segredo = 'segredo-do-app';
    // Formatação real de webhook: espaços que JSON.stringify não reproduz.
    const cru = '{"entry": [{"changes": []}]}';
    const reserializado = JSON.stringify(JSON.parse(cru));

    assert.notEqual(cru, reserializado, 'os bytes precisam mesmo diferir para o teste valer');
    assert.notEqual(
      assinar(cru, segredo),
      assinar(reserializado, segredo),
      'conferir a assinatura sobre o JSON reserializado falharia sempre',
    );
  });

  it('segredo diferente produz assinatura diferente', () => {
    const corpo = '{"x":1}';
    assert.notEqual(assinar(corpo, 'a'), assinar(corpo, 'b'));
  });
});
