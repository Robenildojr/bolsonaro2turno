/**
 * Abrir no navegador é entregar uma URL ao sistema operacional.
 *
 * Por isso a conferência existe: a URL sai da configuração, e configuração é
 * arquivo que pode ser editado. O destino só pode ser o endereço local do
 * próprio Gideão.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { enderecoLocalSeguro } from '../src/util/abrir.js';

describe('endereço que pode ser aberto', () => {
  it('aceita o endereço local do Gideão', () => {
    assert.ok(enderecoLocalSeguro('http://127.0.0.1:4319/?token=abc'));
    assert.ok(enderecoLocalSeguro('http://localhost:4319/'));
    assert.ok(enderecoLocalSeguro('https://127.0.0.1:8443/'));
  });

  it('recusa endereço de fora', () => {
    for (const url of [
      'http://exemplo.com/',
      'http://192.168.0.10:4319/',
      'http://127.0.0.1.evil.com/',
      'https://pje.trt8.jus.br/',
    ]) {
      assert.ok(!enderecoLocalSeguro(url), `não podia aceitar: ${url}`);
    }
  });

  it('recusa protocolo que não é http', () => {
    for (const url of [
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      'data:text/html,<script>x</script>',
      'nao-e-url',
      '',
    ]) {
      assert.ok(!enderecoLocalSeguro(url), `não podia aceitar: ${url}`);
    }
  });
});
