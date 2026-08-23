/**
 * Catalogo de erros de dominio.
 *
 * Cada erro carrega um `code` estavel (contrato com clientes da API), uma
 * `message` em pt-BR voltada ao lojista, e `details` opcionais para diagnostico.
 * O `kind` mapeia para a familia de status HTTP sem que o dominio conheca HTTP.
 */

export const ErrorKind = {
  /** Payload malformado ou valor invalido. -> 400 */
  VALIDATION: 'VALIDATION',
  /** Quem chamou nao tem permissao para esta acao neste recurso. -> 403 */
  FORBIDDEN: 'FORBIDDEN',
  /** Recurso inexistente. -> 404 */
  NOT_FOUND: 'NOT_FOUND',
  /** A acao contradiz o estado atual do agregado. -> 409 */
  CONFLICT: 'CONFLICT',
  /** Regra de negocio violada (limites, quoruns, prazos). -> 422 */
  RULE_VIOLATION: 'RULE_VIOLATION',
} as const;

export type ErrorKind = (typeof ErrorKind)[keyof typeof ErrorKind];

export type DomainError = {
  readonly kind: ErrorKind;
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
};

function make(kind: ErrorKind) {
  return (code: string, message: string, details?: Record<string, unknown>): DomainError =>
    details === undefined ? { kind, code, message } : { kind, code, message, details };
}

export const validationError = make(ErrorKind.VALIDATION);
export const forbiddenError = make(ErrorKind.FORBIDDEN);
export const notFoundError = make(ErrorKind.NOT_FOUND);
export const conflictError = make(ErrorKind.CONFLICT);
export const ruleViolation = make(ErrorKind.RULE_VIOLATION);

export function isDomainError(value: unknown): value is DomainError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    'code' in value &&
    'message' in value
  );
}

/** Erro de programacao: invariante do agregado quebrada. Nunca deve chegar ao usuario. */
export class InvariantViolationError extends Error {
  override readonly name = 'InvariantViolationError';
  constructor(message: string) {
    super(`Invariante violada: ${message}`);
  }
}

export function assertInvariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantViolationError(message);
}
