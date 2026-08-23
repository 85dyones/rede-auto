/**
 * Estilo unico de transicao de estado no dominio.
 *
 * Todo agregado e um dado imutavel; toda regra e uma funcao pura
 * `(estado, comando) -> Result<{ estado', eventos }, DomainError>`.
 *
 * A vantagem pratica: testar "trava expirada nao pode ser estendida" nao exige
 * banco, relogio real nem servidor — e uma chamada de funcao. E como o novo
 * estado so existe no retorno, nao ha meio-caminho persistido quando uma regra
 * rejeita o comando.
 */

import type { DomainEvent } from './events.ts';
import type { DomainError } from './errors.ts';
import { type Result, ok } from './result.ts';

export type Transitioned<TState> = {
  readonly state: TState;
  readonly events: readonly DomainEvent[];
};

export type Transition<TState> = Result<Transitioned<TState>, DomainError>;

export function transitioned<TState>(
  state: TState,
  events: readonly DomainEvent[] = [],
): Transition<TState> {
  return ok({ state, events });
}

/** Estado inalterado — usado quando o comando e idempotente e ja foi aplicado. */
export function unchanged<TState>(state: TState): Transition<TState> {
  return ok({ state, events: [] });
}
