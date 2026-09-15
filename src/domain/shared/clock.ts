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

/**
 * Soma meses de calendario a um instante, em UTC.
 *
 * `+ 30 * DAY` nao serve: mensalidade tem competencia, e "todo dia 9" nao pode
 * virar dia 8 depois de alguns ciclos. Fevereiro obriga a decidir o caso de
 * borda — 31 de janeiro mais um mes. A escolha e GRUDAR NO ULTIMO DIA do mes
 * alvo (28 de fevereiro), e nao transbordar para marco: transbordar faria a
 * cobranca de quem assinou dia 31 pular de mes uma vez por ano.
 */
export function addMonths(instant: Instant, months: number): Instant {
  const date = new Date(instant);
  const targetMonth = date.getUTCMonth() + months;

  // Dia 1 primeiro, para o mes nao transbordar antes de sabermos o teto dele.
  const anchor = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      targetMonth,
      1,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
  const lastDayOfTarget = new Date(
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0),
  ).getUTCDate();

  anchor.setUTCDate(Math.min(date.getUTCDate(), lastDayOfTarget));
  return anchor.getTime();
}
