import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  add,
  compare,
  format,
  fromCents,
  fromReais,
  gte,
  parseMoney,
  subtract,
  sum,
  ZERO,
} from './money.ts';
import { unwrap } from './result.ts';

describe('Money', () => {
  test('opera em centavos inteiros, sem erro de ponto flutuante', () => {
    // 0.1 + 0.2 !== 0.3 em float; em centavos a soma e exata.
    const total = add(fromReais(0.1), fromReais(0.2));
    assert.equal(total.cents, 30);
    assert.equal(format(total), 'R$ 0,30');
  });

  test('soma de lista e subtracao mantem exatidao', () => {
    const parcelas = [fromReais(33.33), fromReais(33.33), fromReais(33.34)];
    assert.equal(sum(parcelas).cents, 10_000);
    assert.equal(subtract(fromReais(100), sum(parcelas)).cents, 0);
    assert.equal(sum([]).cents, ZERO.cents);
  });

  test('formata no padrao brasileiro com separador de milhar', () => {
    assert.equal(format(fromReais(89_900)), 'R$ 89.900,00');
    assert.equal(format(fromCents(1)), 'R$ 0,01');
    assert.equal(format(fromCents(-250)), '-R$ 2,50');
    assert.equal(format(fromReais(1_234_567.89)), 'R$ 1.234.567,89');
  });

  describe('parseMoney com entradas de feed', () => {
    test('aceita o formato pt-BR com ponto de milhar e virgula decimal', () => {
      assert.equal(unwrap(parseMoney('89.900,00', { field: 'preco' })).cents, 8_990_000);
      assert.equal(unwrap(parseMoney('1.234.567,89', { field: 'preco' })).cents, 123_456_789);
    });

    test('aceita o formato internacional com ponto decimal', () => {
      assert.equal(unwrap(parseMoney('89900.00', { field: 'preco' })).cents, 8_990_000);
      assert.equal(unwrap(parseMoney('89,900.00', { field: 'preco' })).cents, 8_990_000);
    });

    test('aceita prefixo R$ e espacos, comuns em feeds mal formatados', () => {
      assert.equal(unwrap(parseMoney('R$ 89.900,00', { field: 'preco' })).cents, 8_990_000);
    });

    test('trata numero cru como reais e, sob demanda, como centavos', () => {
      assert.equal(unwrap(parseMoney(89_900, { field: 'preco' })).cents, 8_990_000);
      assert.equal(unwrap(parseMoney(8_990_000, { field: 'preco', unit: 'cents' })).cents, 8_990_000);
    });

    test('valor sem casa decimal e interpretado integralmente como reais', () => {
      assert.equal(unwrap(parseMoney('89900', { field: 'preco' })).cents, 8_990_000);
    });

    test('rejeita lixo, negativo e valores absurdos', () => {
      for (const invalid of ['', 'sob consulta', null, undefined, {}, Number.NaN]) {
        const result = parseMoney(invalid, { field: 'preco' });
        assert.equal(result.ok, false, `deveria rejeitar ${JSON.stringify(invalid)}`);
      }

      const negative = parseMoney('-100', { field: 'preco' });
      assert.equal(negative.ok, false);
      assert.equal(negative.ok === false && negative.error.code, 'MONEY_NEGATIVE');

      const huge = parseMoney('999999999999', { field: 'preco' });
      assert.equal(huge.ok, false);
      assert.equal(huge.ok === false && huge.error.code, 'MONEY_OUT_OF_RANGE');
    });

    test('permite negativo explicitamente quando a diferenca faz sentido', () => {
      const diff = parseMoney('-1500', { field: 'diferenca', allowNegative: true });
      assert.equal(diff.ok, true);
      assert.equal(unwrap(diff).cents, -150_000);
    });
  });

  test('comparacoes suportam ordenacao e checagem de suficiencia de pagamento', () => {
    const devido = fromReais(85_000);
    assert.equal(gte(fromReais(85_000), devido), true);
    assert.equal(gte(fromReais(84_999.99), devido), false);
    assert.deepEqual(
      [fromReais(3), fromReais(1), fromReais(2)].sort(compare).map((money) => money.cents),
      [100, 200, 300],
    );
  });
});
