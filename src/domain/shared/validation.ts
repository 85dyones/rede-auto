/**
 * Validacao de dados brasileiros do dominio automotivo.
 *
 * Vale a pena validar de verdade (digito verificador de CNPJ, formato Mercosul
 * de placa, alfabeto restrito do chassi) porque estes campos sao a chave de
 * deduplicacao da rede: um chassi digitado errado cria um veiculo fantasma e
 * abre a porta para o exato problema que a plataforma existe para evitar —
 * duas lojas vendendo o mesmo carro.
 */

import { type Result, ok, err } from './result.ts';
import { type DomainError, validationError } from './errors.ts';

// ---------------------------------------------------------------------------
// Texto
// ---------------------------------------------------------------------------

export function requireText(
  value: unknown,
  field: string,
  options: { min?: number; max?: number } = {},
): Result<string, DomainError> {
  const { min = 1, max = 500 } = options;
  if (typeof value !== 'string') {
    return err(validationError('FIELD_REQUIRED', `${field}: campo obrigatorio.`, { field }));
  }
  const trimmed = value.trim();
  if (trimmed.length < min) {
    return err(
      validationError('FIELD_TOO_SHORT', `${field}: precisa de ao menos ${min} caractere(s).`, {
        field,
        min,
      }),
    );
  }
  if (trimmed.length > max) {
    return err(
      validationError('FIELD_TOO_LONG', `${field}: excede ${max} caracteres.`, { field, max }),
    );
  }
  return ok(trimmed);
}

export function requireInteger(
  value: unknown,
  field: string,
  options: { min?: number; max?: number } = {},
): Result<number, DomainError> {
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = options;
  const parsed = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    return err(
      validationError('FIELD_NOT_A_NUMBER', `${field}: valor numerico obrigatorio.`, { field }),
    );
  }
  const rounded = Math.round(parsed);
  if (rounded < min || rounded > max) {
    return err(
      validationError('FIELD_OUT_OF_RANGE', `${field}: deve estar entre ${min} e ${max}.`, {
        field,
        min,
        max,
        received: rounded,
      }),
    );
  }
  return ok(rounded);
}

export function requireOneOf<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): Result<T, DomainError> {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return ok(value as T);
  }
  return err(
    validationError('FIELD_NOT_ALLOWED', `${field}: valor invalido.`, {
      field,
      allowed,
      received: value,
    }),
  );
}

// ---------------------------------------------------------------------------
// Placa
// ---------------------------------------------------------------------------

const PLATE_LEGACY = /^[A-Z]{3}\d{4}$/;
const PLATE_MERCOSUL = /^[A-Z]{3}\d[A-Z]\d{2}$/;

export type PlateFormat = 'LEGACY' | 'MERCOSUL';

/** Normaliza para maiusculas sem hifen/espaco: "abc-1d23" -> "ABC1D23". */
export function normalizePlate(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function parsePlate(
  value: unknown,
  field = 'placa',
): Result<{ plate: string; format: PlateFormat }, DomainError> {
  const text = requireText(value, field, { min: 7, max: 10 });
  if (!text.ok) return text;

  const plate = normalizePlate(text.value);
  if (PLATE_MERCOSUL.test(plate)) return ok({ plate, format: 'MERCOSUL' });
  if (PLATE_LEGACY.test(plate)) return ok({ plate, format: 'LEGACY' });

  return err(
    validationError('PLATE_INVALID', `${field}: formato invalido (esperado ABC1D23 ou ABC1234).`, {
      field,
      received: text.value,
    }),
  );
}

/** Mascara para exibicao interna: "ABC1D23" -> "ABC-1D23". */
export function formatPlate(plate: string): string {
  return plate.length === 7 ? `${plate.slice(0, 3)}-${plate.slice(3)}` : plate;
}

/**
 * Placa parcialmente oculta no material que circula: "ABC1D23" -> "ABC****".
 * A placa completa permite consulta publica que revela o proprietario — o
 * oposto do que o material neutro precisa entregar.
 */
export function maskPlate(plate: string): string {
  return plate.length >= 3 ? `${plate.slice(0, 3)}${'*'.repeat(plate.length - 3)}` : '***';
}

// ---------------------------------------------------------------------------
// Chassi (VIN)
// ---------------------------------------------------------------------------

// I, O e Q sao excluidos do alfabeto do VIN justamente por confusao com 1 e 0.
const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

export function parseChassis(value: unknown, field = 'chassi'): Result<string, DomainError> {
  const text = requireText(value, field, { min: 17, max: 20 });
  if (!text.ok) return text;

  const chassis = text.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!VIN_PATTERN.test(chassis)) {
    return err(
      validationError(
        'CHASSIS_INVALID',
        `${field}: deve ter 17 caracteres alfanumericos (sem I, O ou Q).`,
        { field, received: text.value },
      ),
    );
  }
  return ok(chassis);
}

// ---------------------------------------------------------------------------
// CNPJ / CPF
// ---------------------------------------------------------------------------

export function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

export function parseCnpj(value: unknown, field = 'cnpj'): Result<string, DomainError> {
  const text = requireText(value, field, { min: 14, max: 18 });
  if (!text.ok) return text;

  const digits = onlyDigits(text.value);
  if (digits.length !== 14 || !hasValidCnpjCheckDigits(digits)) {
    return err(
      validationError('CNPJ_INVALID', `${field}: CNPJ invalido.`, { field, received: text.value }),
    );
  }
  return ok(digits);
}

export function formatCnpj(digits: string): string {
  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
}

function hasValidCnpjCheckDigits(digits: string): boolean {
  if (/^(\d)\1{13}$/.test(digits)) return false;
  const firstWeights = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const secondWeights = [6, ...firstWeights];
  const first = checkDigit(digits.slice(0, 12), firstWeights);
  const second = checkDigit(digits.slice(0, 13), secondWeights);
  return digits[12] === String(first) && digits[13] === String(second);
}

function checkDigit(base: string, weights: readonly number[]): number {
  let total = 0;
  for (let index = 0; index < base.length; index += 1) {
    total += Number(base[index]) * (weights[index] ?? 0);
  }
  const remainder = total % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

export function parseCpf(value: unknown, field = 'cpf'): Result<string, DomainError> {
  const text = requireText(value, field, { min: 11, max: 14 });
  if (!text.ok) return text;

  const digits = onlyDigits(text.value);
  if (digits.length !== 11 || !hasValidCpfCheckDigits(digits)) {
    return err(
      validationError('CPF_INVALID', `${field}: CPF invalido.`, { field, received: text.value }),
    );
  }
  return ok(digits);
}

function hasValidCpfCheckDigits(digits: string): boolean {
  if (/^(\d)\1{10}$/.test(digits)) return false;
  for (const [length, factor] of [
    [9, 10],
    [10, 11],
  ] as const) {
    let total = 0;
    for (let index = 0; index < length; index += 1) {
      total += Number(digits[index]) * (factor - index);
    }
    const remainder = (total * 10) % 11;
    const expected = remainder === 10 ? 0 : remainder;
    if (expected !== Number(digits[length])) return false;
  }
  return true;
}

/** Documento do comprador final no ATPV-e: pessoa fisica ou juridica. */
export function parseBuyerDocument(
  value: unknown,
  field = 'documento do comprador',
): Result<{ document: string; type: 'CPF' | 'CNPJ' }, DomainError> {
  if (typeof value === 'string') {
    const digits = onlyDigits(value);
    if (digits.length === 11) {
      const cpf = parseCpf(value, field);
      return cpf.ok ? ok({ document: cpf.value, type: 'CPF' as const }) : cpf;
    }
    if (digits.length === 14) {
      const cnpj = parseCnpj(value, field);
      return cnpj.ok ? ok({ document: cnpj.value, type: 'CNPJ' as const }) : cnpj;
    }
  }
  return err(
    validationError('DOCUMENT_INVALID', `${field}: informe um CPF ou CNPJ valido.`, { field }),
  );
}

// ---------------------------------------------------------------------------
// Outros campos do veiculo
// ---------------------------------------------------------------------------

const EARLIEST_MODEL_YEAR = 1900;

export function parseModelYear(
  value: unknown,
  field: string,
  currentYear: number,
): Result<number, DomainError> {
  // Ano-modelo pode ser o proximo ano civil (carro 2026 vendido em 2025).
  return requireInteger(value, field, { min: EARLIEST_MODEL_YEAR, max: currentYear + 2 });
}

export function parseOdometer(value: unknown, field = 'odometro'): Result<number, DomainError> {
  return requireInteger(value, field, { min: 0, max: 2_000_000 });
}

/**
 * Nivel de combustivel em oitavos (0 a 8), como o ponteiro do painel.
 * Vistoria de patio se faz olhando o marcador, nao medindo litros.
 */
export function parseFuelEighths(
  value: unknown,
  field = 'nivel de combustivel',
): Result<number, DomainError> {
  return requireInteger(value, field, { min: 0, max: 8 });
}

const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:']);

export function parseHttpUrl(value: unknown, field = 'url'): Result<string, DomainError> {
  const text = requireText(value, field, { min: 8, max: 2048 });
  if (!text.ok) return text;
  try {
    const url = new URL(text.value);
    if (!ALLOWED_URL_PROTOCOLS.has(url.protocol)) {
      return err(
        validationError('URL_PROTOCOL_NOT_ALLOWED', `${field}: apenas http(s) e aceito.`, {
          field,
        }),
      );
    }
    return ok(url.toString());
  } catch {
    return err(validationError('URL_INVALID', `${field}: URL invalida.`, { field }));
  }
}
