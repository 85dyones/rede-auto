/**
 * Clock — o tempo e uma dependencia injetada, nunca lido de `Date.now()` direto
 * dentro do dominio.
 *
 * Toda a regra central do produto (trava de 4h, SLA de recall em horas uteis,
 * validade de link white-label) e funcao do tempo. Sem um relogio injetavel
 * esses comportamentos so poderiam ser testados esperando de verdade.
 */

/** Instante em milissegundos desde a epoca Unix, em UTC. */
export type Instant = number;

export type Clock = {
  now(): Instant;
};

export const SystemClock: Clock = {
  now: () => Date.now(),
};

/** Relogio controlado para testes e simulacoes. */
export class FakeClock implements Clock {
  #current: Instant;

  constructor(start: Instant | string | Date = 0) {
    this.#current = toInstant(start);
  }

  now(): Instant {
    return this.#current;
  }

  set(value: Instant | string | Date): void {
    this.#current = toInstant(value);
  }

  advance(milliseconds: number): Instant {
    this.#current += milliseconds;
    return this.#current;
  }

  advanceHours(hours: number): Instant {
    return this.advance(hours * HOUR);
  }

  advanceMinutes(minutes: number): Instant {
    return this.advance(minutes * MINUTE);
  }

  advanceDays(days: number): Instant {
    return this.advance(days * DAY);
  }
}

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function toInstant(value: Instant | string | Date): Instant {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`Data/hora invalida: ${value}`);
  return parsed;
}

/** Representacao ISO-8601 em UTC, usada em toda serializacao. */
export function toIso(instant: Instant): string {
  return new Date(instant).toISOString();
}

/** Diferenca legivel para mensagens ao lojista ("faltam 3h 12min"). */
export function formatDuration(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds / MINUTE));
  const days = Math.floor(total / (24 * 60));
  const hours = Math.floor((total % (24 * 60)) / 60);
  const minutes = total % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}min`);
  return parts.join(' ');
}
