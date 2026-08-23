/**
 * Result<T, E> — falhas de negocio esperadas viajam como valor, nao como excecao.
 *
 * Regra do projeto: `throw` e reservado para bugs de programacao (invariante
 * quebrada, estado impossivel). Tudo que um usuario da rede pode causar
 * ("a trava ja expirou", "voce nao e o dono do veiculo") retorna `err(...)`.
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export function ok(): Result<void, never>;
export function ok<T>(value: T): Result<T, never>;
export function ok<T>(value?: T): Result<T | undefined, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Desembrulha um Result, lancando se for erro. Use apenas em seeds/testes. */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw new Error(`unwrap() chamado sobre um erro: ${JSON.stringify(result.error)}`);
}

/** Encadeia uma transformacao apenas no caminho feliz. */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Encadeia uma operacao que tambem pode falhar. */
export function andThen<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}

/**
 * Coleta uma lista de Results: devolve todos os valores ou o primeiro erro.
 * Util para validar varios campos de um payload de uma vez.
 */
export function all<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
}
