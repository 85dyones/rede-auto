/**
 * Money — valores monetarios em centavos de Real (BRL), sempre inteiros.
 *
 * Nunca use ponto flutuante para dinheiro: uma diferenca de 1 centavo entre o
 * preco liquido acordado e o valor liquidado gera disputa entre lojistas.
 */

import { type Result, ok, err } from './result.ts';
import { type DomainError, validationError, assertInvariant } from './errors.ts';

export type Money = {
  readonly currency: 'BRL';
  /** Valor em centavos. Sempre inteiro; pode ser negativo em diferencas. */
  readonly cents: number;
};

/** Maior valor aceito: R$ 100.000.000,00 — acima disso e certamente erro de digitacao/feed. */
export const MAX_CENTS = 10_000_000_000;

export const ZERO: Money = { currency: 'BRL', cents: 0 };

export function fromCents(cents: number): Money {
  assertInvariant(Number.isSafeInteger(cents), `centavos devem ser inteiros, recebido ${cents}`);
  return { currency: 'BRL', cents };
}

/** Constroi a partir de reais (aceita decimais), arredondando para o centavo mais proximo. */
export function fromReais(reais: number): Money {
  assertInvariant(Number.isFinite(reais), `valor em reais invalido: ${reais}`);
  return fromCents(Math.round(reais * 100));
}

/**
 * Parse defensivo para entradas externas (feeds XML, JSON de API).
 * Aceita `12345` (centavos, se `unit: 'cents'`), `"89.900,00"`, `"89900.00"`,
 * `"R$ 89.900,00"` e numeros. Rejeita negativos por padrao.
 */
export function parseMoney(
  input: unknown,
  options: { field: string; unit?: 'cents' | 'reais'; allowNegative?: boolean } = {
    field: 'valor',
  },
): Result<Money, DomainError> {
  const { field, unit = 'reais', allowNegative = false } = options;

  let cents: number;

  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      return err(validationError('MONEY_INVALID', `${field}: valor numerico invalido.`));
    }
    cents = unit === 'cents' ? Math.round(input) : Math.round(input * 100);
  } else if (typeof input === 'string') {
    const parsed = parseBrazilianDecimal(input);
    if (parsed === null) {
      return err(
        validationError('MONEY_INVALID', `${field}: nao foi possivel interpretar "${input}".`, {
          field,
          received: input,
        }),
      );
    }
    cents = unit === 'cents' ? Math.round(parsed) : Math.round(parsed * 100);
  } else {
    return err(
      validationError('MONEY_INVALID', `${field}: valor ausente ou de tipo invalido.`, { field }),
    );
  }

  if (!allowNegative && cents < 0) {
    return err(
      validationError('MONEY_NEGATIVE', `${field}: valor nao pode ser negativo.`, { field, cents }),
    );
  }
  if (Math.abs(cents) > MAX_CENTS) {
    return err(
      validationError('MONEY_OUT_OF_RANGE', `${field}: valor fora da faixa aceita.`, {
        field,
        cents,
        maxCents: MAX_CENTS,
      }),
    );
  }
  return ok(fromCents(cents));
}

/**
 * Interpreta numeros escritos no padrao pt-BR ("89.900,00") e no padrao
 * internacional ("89900.00"), que convivem nos feeds dos integradores.
 */
function parseBrazilianDecimal(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, '').replace(/^R\$?/i, '');
  if (cleaned === '') return null;
  if (!/^-?[\d.,]+$/.test(cleaned)) return null;

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');

  let normalized: string;
  if (lastComma > lastDot) {
    // pt-BR: ponto e separador de milhar, virgula e decimal.
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    // en-US: virgula e separador de milhar, ponto e decimal.
    normalized = cleaned.replace(/,/g, '');
  } else {
    normalized = cleaned;
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

export function add(a: Money, b: Money): Money {
  return fromCents(a.cents + b.cents);
}

export function subtract(a: Money, b: Money): Money {
  return fromCents(a.cents - b.cents);
}

export function sum(values: readonly Money[]): Money {
  return fromCents(values.reduce((total, value) => total + value.cents, 0));
}

export function isZero(value: Money): boolean {
  return value.cents === 0;
}

export function isNegative(value: Money): boolean {
  return value.cents < 0;
}

export function isPositive(value: Money): boolean {
  return value.cents > 0;
}

export function compare(a: Money, b: Money): number {
  return a.cents - b.cents;
}

export function gte(a: Money, b: Money): boolean {
  return a.cents >= b.cents;
}

export function gt(a: Money, b: Money): boolean {
  return a.cents > b.cents;
}

export function lt(a: Money, b: Money): boolean {
  return a.cents < b.cents;
}

export function equals(a: Money, b: Money): boolean {
  return a.cents === b.cents;
}

/** Formata para exibicao ao lojista: "R$ 89.900,00". */
export function format(value: Money): string {
  const negative = value.cents < 0;
  const absolute = Math.abs(value.cents);
  const reais = Math.trunc(absolute / 100);
  const cents = absolute % 100;
  const grouped = reais.toLocaleString('pt-BR');
  return `${negative ? '-' : ''}R$ ${grouped},${String(cents).padStart(2, '0')}`;
}

/** Serializacao estavel para a API: centavos + string ja formatada. */
export function toJSON(value: Money): { cents: number; currency: 'BRL'; formatted: string } {
  return { cents: value.cents, currency: value.currency, formatted: format(value) };
}
