/**
 * Horario comercial e aritmetica de horas uteis.
 *
 * O SLA de recall do contrato de rede e "ate 4 horas UTEIS". Somar 4 * 3600_000
 * ao instante atual daria um prazo vencendo as 2h da manha de domingo — e o
 * lojista seria cobrado por um atraso impossivel de evitar. Este modulo faz a
 * conta certa: pula noites, fins de semana e feriados nacionais, no fuso da rede.
 *
 * Fuso: resolvido via `Intl`, entao horario de verao (se voltar a existir no
 * Brasil, ou se a rede se expandir para outro pais) e tratado corretamente.
 */

import type { Instant } from './clock.ts';

export type TimeWindow = {
  /** Minutos desde a meia-noite local. 08:00 => 480. */
  readonly startMinute: number;
  /** Minutos desde a meia-noite local, exclusivo. 18:00 => 1080. */
  readonly endMinute: number;
};

export type BusinessCalendar = {
  readonly timeZone: string;
  /** Dias uteis: 0 = domingo ... 6 = sabado. */
  readonly workdays: readonly number[];
  /** Janelas de expediente dentro de um dia util, em ordem crescente. */
  readonly windows: readonly TimeWindow[];
  /** Datas nao uteis no formato `YYYY-MM-DD` (data local). */
  readonly holidays: ReadonlySet<string>;
};

export function timeWindow(start: `${number}:${number}`, end: `${number}:${number}`): TimeWindow {
  return { startMinute: parseHourMinute(start), endMinute: parseHourMinute(end) };
}

function parseHourMinute(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (match === null) throw new Error(`Horario invalido: ${value}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59) throw new Error(`Horario invalido: ${value}`);
  return hours * 60 + minutes;
}

/**
 * Expediente padrao da rede: segunda a sexta 08:00-18:00 e sabado 09:00-13:00,
 * fuso de Sao Paulo. Lojas de seminovos abrem sabado, e ignorar isso inflaria
 * artificialmente todo prazo pedido numa sexta a tarde.
 */
export function defaultBusinessCalendar(years: readonly number[] = defaultHolidayYears()): BusinessCalendar {
  return {
    timeZone: 'America/Sao_Paulo',
    workdays: [1, 2, 3, 4, 5, 6],
    windows: [timeWindow('08:00', '18:00')],
    holidays: brazilianNationalHolidays(years),
  };
}

function defaultHolidayYears(): number[] {
  const current = new Date().getUTCFullYear();
  return [current - 1, current, current + 1, current + 2];
}

/**
 * Sabado tem janela mais curta. Modelado como calendario proprio porque
 * `windows` e global ao calendario; a rede pode sobrescrever no config.
 */
export function withSaturdayWindow(
  calendar: BusinessCalendar,
  saturday: TimeWindow,
): BusinessCalendar & { readonly saturdayWindow: TimeWindow } {
  return { ...calendar, saturdayWindow: saturday };
}

function windowsForWeekday(calendar: BusinessCalendar, weekday: number): readonly TimeWindow[] {
  const withSaturday = calendar as BusinessCalendar & { saturdayWindow?: TimeWindow };
  if (weekday === 6 && withSaturday.saturdayWindow !== undefined) {
    return [withSaturday.saturdayWindow];
  }
  return calendar.windows;
}

// ---------------------------------------------------------------------------
// Conversao entre instante UTC e data/hora local do fuso da rede
// ---------------------------------------------------------------------------

export type ZonedParts = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** 0 = domingo ... 6 = sabado. */
  readonly weekday: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function toZonedParts(instant: Instant, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const lookup: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') lookup[part.type] = part.value;
  }
  const hour = Number(lookup['hour']);
  return {
    year: Number(lookup['year']),
    month: Number(lookup['month']),
    day: Number(lookup['day']),
    // Alguns ambientes formatam meia-noite como "24" com hourCycle h23/h24.
    hour: hour === 24 ? 0 : hour,
    minute: Number(lookup['minute']),
    second: Number(lookup['second']),
    weekday: WEEKDAY_INDEX[lookup['weekday'] ?? 'Sun'] ?? 0,
  };
}

/** Deslocamento do fuso naquele instante, em milissegundos (local - UTC). */
function zoneOffset(instant: Instant, timeZone: string): number {
  const parts = toZonedParts(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // O formatter descarta os milissegundos; devolvemos ao instante antes de comparar.
  return asUtc - (instant - mod(instant, 1000));
}

function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

/**
 * Converte uma data/hora local do fuso para instante UTC.
 * Faz duas passadas para acertar transicoes de horario de verao.
 */
export function zonedToInstant(
  year: number,
  month: number,
  day: number,
  minutesFromMidnight: number,
  timeZone: string,
): Instant {
  const naive = Date.UTC(year, month - 1, day) + minutesFromMidnight * 60_000;
  const firstGuess = naive - zoneOffset(naive, timeZone);
  const secondOffset = zoneOffset(firstGuess, timeZone);
  return naive - secondOffset;
}

export function localDateKey(instant: Instant, timeZone: string): string {
  const parts = toZonedParts(instant, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// Aritmetica de horas uteis
// ---------------------------------------------------------------------------

/** Limite de seguranca: nenhum prazo de negocio deve varrer mais de ~1 ano. */
const MAX_DAYS_SCANNED = 500;

export function isBusinessDay(instant: Instant, calendar: BusinessCalendar): boolean {
  const parts = toZonedParts(instant, calendar.timeZone);
  if (!calendar.workdays.includes(parts.weekday)) return false;
  return !calendar.holidays.has(localDateKey(instant, calendar.timeZone));
}

export function isWithinBusinessHours(instant: Instant, calendar: BusinessCalendar): boolean {
  if (!isBusinessDay(instant, calendar)) return false;
  const parts = toZonedParts(instant, calendar.timeZone);
  const minuteOfDay = parts.hour * 60 + parts.minute;
  return windowsForWeekday(calendar, parts.weekday).some(
    (window) => minuteOfDay >= window.startMinute && minuteOfDay < window.endMinute,
  );
}

/**
 * Soma `minutes` minutos UTEIS a partir de `from`.
 *
 * Se `from` cai fora do expediente, a contagem comeca na proxima abertura —
 * um pedido feito as 22h de sexta comeca a correr as 08h de segunda.
 */
export function addBusinessMinutes(
  from: Instant,
  minutes: number,
  calendar: BusinessCalendar,
): Instant {
  if (minutes <= 0) return from;

  let remaining = minutes;
  let cursor = from;

  for (let scanned = 0; scanned < MAX_DAYS_SCANNED; scanned += 1) {
    const parts = toZonedParts(cursor, calendar.timeZone);
    const dayKey = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
    const isWorkday =
      calendar.workdays.includes(parts.weekday) && !calendar.holidays.has(dayKey);

    if (isWorkday) {
      for (const window of windowsForWeekday(calendar, parts.weekday)) {
        const windowStart = zonedToInstant(
          parts.year,
          parts.month,
          parts.day,
          window.startMinute,
          calendar.timeZone,
        );
        const windowEnd = zonedToInstant(
          parts.year,
          parts.month,
          parts.day,
          window.endMinute,
          calendar.timeZone,
        );
        const effectiveStart = Math.max(cursor, windowStart);
        if (effectiveStart >= windowEnd) continue;

        const availableMinutes = (windowEnd - effectiveStart) / 60_000;
        if (remaining <= availableMinutes) {
          return effectiveStart + remaining * 60_000;
        }
        remaining -= availableMinutes;
      }
    }

    // Avanca para a meia-noite local do dia seguinte.
    cursor = zonedToInstant(parts.year, parts.month, parts.day + 1, 0, calendar.timeZone);
  }

  throw new Error(
    `addBusinessMinutes nao convergiu apos ${MAX_DAYS_SCANNED} dias — calendario sem dias uteis?`,
  );
}

export function addBusinessHours(
  from: Instant,
  hours: number,
  calendar: BusinessCalendar,
): Instant {
  return addBusinessMinutes(from, Math.round(hours * 60), calendar);
}

/** Minutos uteis decorridos entre dois instantes. Usado nos relatorios de SLA. */
export function businessMinutesBetween(
  start: Instant,
  end: Instant,
  calendar: BusinessCalendar,
): number {
  if (end <= start) return 0;

  let total = 0;
  let cursor = start;

  for (let scanned = 0; scanned < MAX_DAYS_SCANNED; scanned += 1) {
    if (cursor >= end) return Math.round(total);

    const parts = toZonedParts(cursor, calendar.timeZone);
    const dayKey = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
    const isWorkday =
      calendar.workdays.includes(parts.weekday) && !calendar.holidays.has(dayKey);

    if (isWorkday) {
      for (const window of windowsForWeekday(calendar, parts.weekday)) {
        const windowStart = zonedToInstant(
          parts.year,
          parts.month,
          parts.day,
          window.startMinute,
          calendar.timeZone,
        );
        const windowEnd = zonedToInstant(
          parts.year,
          parts.month,
          parts.day,
          window.endMinute,
          calendar.timeZone,
        );
        const overlapStart = Math.max(cursor, windowStart);
        const overlapEnd = Math.min(end, windowEnd);
        if (overlapEnd > overlapStart) total += (overlapEnd - overlapStart) / 60_000;
      }
    }

    cursor = zonedToInstant(parts.year, parts.month, parts.day + 1, 0, calendar.timeZone);
  }

  throw new Error(`businessMinutesBetween nao convergiu apos ${MAX_DAYS_SCANNED} dias.`);
}

// ---------------------------------------------------------------------------
// Feriados nacionais brasileiros
// ---------------------------------------------------------------------------

/**
 * Feriados nacionais fixos + moveis (dependentes da Pascoa).
 *
 * Nao inclui feriados estaduais/municipais: cada loja da rede fica num
 * municipio diferente, e um SLA de rede precisa de um calendario comum.
 * Feriados locais podem ser somados via `config` da instalacao.
 */
export function brazilianNationalHolidays(years: readonly number[]): Set<string> {
  const holidays = new Set<string>();
  for (const year of years) {
    for (const date of holidaysForYear(year)) holidays.add(date);
  }
  return holidays;
}

function holidaysForYear(year: number): string[] {
  const fixed = [
    `${year}-01-01`, // Confraternizacao Universal
    `${year}-04-21`, // Tiradentes
    `${year}-05-01`, // Dia do Trabalho
    `${year}-09-07`, // Independencia
    `${year}-10-12`, // Nossa Senhora Aparecida
    `${year}-11-02`, // Finados
    `${year}-11-15`, // Proclamacao da Republica
    `${year}-11-20`, // Consciencia Negra (nacional desde 2024)
    `${year}-12-25`, // Natal
  ];

  const easter = easterSunday(year);
  const movable = [
    addDaysToDateKey(easter, -48), // Segunda de carnaval
    addDaysToDateKey(easter, -47), // Terca de carnaval
    addDaysToDateKey(easter, -2), // Sexta-feira Santa
    addDaysToDateKey(easter, 60), // Corpus Christi
  ];

  return [...fixed, ...movable];
}

/** Algoritmo gregoriano anonimo (Meeus/Jones/Butcher) para o Domingo de Pascoa. */
function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function addDaysToDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}
