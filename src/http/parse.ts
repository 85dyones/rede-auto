/**
 * Leitura de campos do corpo da requisicao.
 *
 * Toda entrada externa entra por aqui e sai tipada ou como `DomainError`. O
 * objetivo e que nenhum handler precise escrever `as string` — o cast e onde a
 * validacao costuma sumir.
 */

import { type Result, err, ok } from '../domain/shared/result.ts';
import { type DomainError, validationError } from '../domain/shared/errors.ts';
import { type Money, parseMoney } from '../domain/shared/money.ts';
import { requireOneOf, requireText } from '../domain/shared/validation.ts';

export function asObject(body: unknown): Result<Record<string, unknown>, DomainError> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return err(validationError('BODY_REQUIRED', 'Envie um corpo JSON valido.'));
  }
  return ok(body as Record<string, unknown>);
}

export function field(body: Record<string, unknown>, name: string): unknown {
  return body[name];
}

export function text(
  body: Record<string, unknown>,
  name: string,
  options: { min?: number; max?: number } = {},
): Result<string, DomainError> {
  return requireText(body[name], name, options);
}

export function optionalText(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function optionalBoolean(body: Record<string, unknown>, name: string): boolean | undefined {
  const value = body[name];
  return typeof value === 'boolean' ? value : undefined;
}

export function optionalInteger(body: Record<string, unknown>, name: string): number | undefined {
  const value = body[name];
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function oneOf<T extends string>(
  body: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
): Result<T, DomainError> {
  return requireOneOf(body[name], name, allowed);
}

export function optionalOneOf<T extends string>(
  body: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const value = body[name];
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/**
 * Dinheiro pode chegar como `{ centavos: 8500000 }` ou como `"85.000,00"`.
 * O primeiro e o que o cliente proprio manda; o segundo, o que vem de
 * integracao e de teste manual.
 */
export function money(
  body: Record<string, unknown>,
  name: string,
): Result<Money, DomainError> {
  const value = body[name];
  if (typeof value === 'object' && value !== null && 'centavos' in value) {
    return parseMoney((value as { centavos: unknown }).centavos, { field: name, unit: 'cents' });
  }
  if (typeof value === 'object' && value !== null && 'cents' in value) {
    return parseMoney((value as { cents: unknown }).cents, { field: name, unit: 'cents' });
  }
  return parseMoney(value, { field: name });
}

export function optionalMoney(
  body: Record<string, unknown>,
  name: string,
): Result<Money | undefined, DomainError> {
  if (body[name] === undefined || body[name] === null) return ok(undefined);
  return money(body, name);
}

export function queryInteger(query: URLSearchParams, name: string): number | undefined {
  const raw = query.get(name);
  if (raw === null) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function queryText(query: URLSearchParams, name: string): string | undefined {
  const raw = query.get(name)?.trim();
  return raw !== undefined && raw.length > 0 ? raw : undefined;
}

export function queryInstant(query: URLSearchParams, name: string): Result<number, DomainError> {
  const raw = query.get(name);
  if (raw === null) {
    return err(validationError('INSTANT_REQUIRED', `Informe ${name} como data/hora ISO-8601.`));
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    return err(
      validationError('INSTANT_INVALID', `${name}: data/hora invalida.`, { received: raw }),
    );
  }
  return ok(parsed);
}
