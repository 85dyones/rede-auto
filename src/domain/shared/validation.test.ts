import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatCnpj,
  maskPlate,
  normalizePlate,
  parseBuyerDocument,
  parseChassis,
  parseCnpj,
  parseCpf,
  parseFuelEighths,
  parseHttpUrl,
  parseModelYear,
  parseOdometer,
  parsePlate,
  requireOneOf,
  requireText,
} from './validation.ts';
import { unwrap } from './result.ts';

describe('placa', () => {
  test('aceita padrao Mercosul e antigo, normalizando mascara', () => {
    assert.deepEqual(unwrap(parsePlate('abc-1d23')), { plate: 'ABC1D23', format: 'MERCOSUL' });
    assert.deepEqual(unwrap(parsePlate('ABC 1234')), { plate: 'ABC1234', format: 'LEGACY' });
  });

  test('rejeita formatos que nao existem', () => {
    for (const invalid of ['AB1234', 'ABCD123', '1234ABC', 'ABC12D3', '', 'ABC1D2']) {
      assert.equal(parsePlate(invalid).ok, false, `deveria rejeitar "${invalid}"`);
    }
  });

  test('mascara preserva apenas o prefixo, para uso white-label', () => {
    // A placa completa permite consulta publica que revela o proprietario.
    assert.equal(maskPlate('ABC1D23'), 'ABC****');
    assert.equal(normalizePlate('abc1d23'), 'ABC1D23');
  });
});

describe('chassi (VIN)', () => {
  test('aceita 17 caracteres do alfabeto valido', () => {
    assert.equal(unwrap(parseChassis('9BWZZZ377VT004251')), '9BWZZZ377VT004251');
  });

  test('rejeita I, O e Q — excluidos do VIN por confusao com 1 e 0', () => {
    assert.equal(parseChassis('9BWZZZ377VT00425I').ok, false);
    assert.equal(parseChassis('9BWZZZ377VT00425O').ok, false);
    assert.equal(parseChassis('9BWZZZ377VT00425Q').ok, false);
  });

  test('rejeita comprimento errado', () => {
    assert.equal(parseChassis('9BWZZZ377VT0042').ok, false);
    assert.equal(parseChassis('9BWZZZ377VT004251X').ok, false);
  });
});

describe('CNPJ e CPF', () => {
  test('valida digitos verificadores reais', () => {
    assert.equal(unwrap(parseCnpj('11.222.333/0001-81')), '11222333000181');
    assert.equal(parseCnpj('11.222.333/0001-82').ok, false, 'DV errado deve falhar');
  });

  test('rejeita sequencias repetidas que passariam so no modulo', () => {
    assert.equal(parseCnpj('11.111.111/1111-11').ok, false);
    assert.equal(parseCpf('111.111.111-11').ok, false);
  });

  test('valida CPF com digitos verificadores', () => {
    assert.equal(unwrap(parseCpf('529.982.247-25')), '52998224725');
    assert.equal(parseCpf('529.982.247-24').ok, false);
  });

  test('formata CNPJ para exibicao', () => {
    assert.equal(formatCnpj('11222333000181'), '11.222.333/0001-81');
  });

  test('documento do comprador aceita CPF ou CNPJ e identifica o tipo', () => {
    assert.deepEqual(unwrap(parseBuyerDocument('529.982.247-25')), {
      document: '52998224725',
      type: 'CPF',
    });
    assert.deepEqual(unwrap(parseBuyerDocument('11.222.333/0001-81')), {
      document: '11222333000181',
      type: 'CNPJ',
    });
    assert.equal(parseBuyerDocument('123').ok, false);
  });
});

describe('campos do veiculo', () => {
  test('ano-modelo aceita ate dois anos a frente do ano corrente', () => {
    assert.equal(unwrap(parseModelYear('2026', 'anoModelo', 2025)), 2026);
    assert.equal(unwrap(parseModelYear(2027, 'anoModelo', 2025)), 2027);
    assert.equal(parseModelYear(2030, 'anoModelo', 2025).ok, false);
    assert.equal(parseModelYear(1899, 'anoModelo', 2025).ok, false);
  });

  test('odometro rejeita negativo e valores impossiveis', () => {
    assert.equal(unwrap(parseOdometer('48500')), 48_500);
    assert.equal(parseOdometer(-1).ok, false);
    assert.equal(parseOdometer(3_000_000).ok, false);
  });

  test('combustivel e medido em oitavos, como o ponteiro do painel', () => {
    assert.equal(unwrap(parseFuelEighths(4)), 4);
    assert.equal(parseFuelEighths(9).ok, false);
    assert.equal(parseFuelEighths(-1).ok, false);
  });

  test('URL de foto aceita apenas http(s)', () => {
    assert.equal(unwrap(parseHttpUrl('https://cdn.exemplo.com/foto.jpg')), 'https://cdn.exemplo.com/foto.jpg');
    assert.equal(parseHttpUrl('javascript:alert(1)').ok, false);
    assert.equal(parseHttpUrl('file:///etc/passwd').ok, false);
  });
});

describe('guardas genericas', () => {
  test('requireText apara espacos e aplica limites', () => {
    assert.equal(unwrap(requireText('  Onix LTZ  ', 'versao')), 'Onix LTZ');
    assert.equal(requireText('   ', 'versao').ok, false);
    assert.equal(requireText('x'.repeat(600), 'versao', { max: 500 }).ok, false);
    assert.equal(requireText(42, 'versao').ok, false);
  });

  test('requireOneOf restringe a um conjunto conhecido', () => {
    const combustiveis = ['FLEX', 'GASOLINA', 'DIESEL'] as const;
    assert.equal(unwrap(requireOneOf('FLEX', 'combustivel', combustiveis)), 'FLEX');
    assert.equal(requireOneOf('ALCOOL', 'combustivel', combustiveis).ok, false);
  });
});
