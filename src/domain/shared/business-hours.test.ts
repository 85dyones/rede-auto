import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  addBusinessHours,
  brazilianNationalHolidays,
  businessMinutesBetween,
  isBusinessDay,
  isWithinBusinessHours,
  localDateKey,
  timeWindow,
  toZonedParts,
  zonedToInstant,
  type BusinessCalendar,
} from './business-hours.ts';

const SP = 'America/Sao_Paulo';

/** Seg-Sex, 08:00-18:00, sem feriados: base limpa para exercitar a aritmetica. */
const weekdaysOnly: BusinessCalendar = {
  timeZone: SP,
  workdays: [1, 2, 3, 4, 5],
  windows: [timeWindow('08:00', '18:00')],
  holidays: new Set(),
};

const at = (iso: string): number => Date.parse(iso);
const localOf = (instant: number): string => {
  const parts = toZonedParts(instant, SP);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
};

describe('conversao de fuso', () => {
  test('le a hora local de Sao Paulo a partir de um instante UTC', () => {
    assert.equal(localOf(at('2026-08-24T12:00:00Z')), '2026-08-24 09:00');
  });

  test('converte data/hora local de volta para instante UTC', () => {
    const instant = zonedToInstant(2026, 8, 24, 9 * 60, SP);
    assert.equal(new Date(instant).toISOString(), '2026-08-24T12:00:00.000Z');
  });

  test('meia-noite local nao vaza para o dia anterior', () => {
    const midnight = zonedToInstant(2026, 8, 24, 0, SP);
    assert.equal(localDateKey(midnight, SP), '2026-08-24');
    assert.equal(localOf(midnight), '2026-08-24 00:00');
  });
});

describe('addBusinessHours', () => {
  test('soma dentro do mesmo expediente', () => {
    // Segunda 09:00 + 4h uteis = segunda 13:00.
    assert.equal(localOf(addBusinessHours(at('2026-08-24T12:00:00Z'), 4, weekdaysOnly)), '2026-08-24 13:00');
  });

  test('atravessa o fechamento e retoma na abertura do dia seguinte', () => {
    // Segunda 16:00: sobram 2h ate as 18:00; as outras 2h correm terca a partir das 08:00.
    assert.equal(localOf(addBusinessHours(at('2026-08-24T19:00:00Z'), 4, weekdaysOnly)), '2026-08-25 10:00');
  });

  test('pedido feito depois do fechamento so comeca a contar na proxima abertura', () => {
    // Segunda 21:00 -> comeca terca 08:00 -> vence terca 12:00.
    assert.equal(localOf(addBusinessHours(at('2026-08-25T00:00:00Z'), 4, weekdaysOnly)), '2026-08-25 12:00');
  });

  test('pedido feito antes da abertura comeca no mesmo dia', () => {
    // Segunda 06:00 -> comeca 08:00 -> vence 12:00.
    assert.equal(localOf(addBusinessHours(at('2026-08-24T09:00:00Z'), 4, weekdaysOnly)), '2026-08-24 12:00');
  });

  test('atravessa o fim de semana inteiro', () => {
    // Sexta 17:00: 1h na sexta, 3h na segunda -> segunda 11:00.
    assert.equal(localOf(addBusinessHours(at('2026-08-21T20:00:00Z'), 4, weekdaysOnly)), '2026-08-24 11:00');
  });

  test('pedido no sabado so comeca na segunda', () => {
    assert.equal(localOf(addBusinessHours(at('2026-08-22T13:00:00Z'), 4, weekdaysOnly)), '2026-08-24 12:00');
  });

  test('pula feriado nacional', () => {
    // 2026-04-21 (Tiradentes) cai numa terca. Segunda 16:00 + 4h -> quarta 10:00.
    const withHolidays: BusinessCalendar = {
      ...weekdaysOnly,
      holidays: brazilianNationalHolidays([2026]),
    };
    assert.equal(localOf(addBusinessHours(at('2026-04-20T19:00:00Z'), 4, withHolidays)), '2026-04-22 10:00');
  });

  test('sabado com janela propria e respeitado', () => {
    const withSaturday: BusinessCalendar = {
      ...weekdaysOnly,
      workdays: [1, 2, 3, 4, 5, 6],
      windowsByWeekday: { 6: [timeWindow('09:00', '13:00')] },
    };
    // Sexta 17:00: 1h sexta + 3h sabado (09:00-12:00) -> sabado 12:00.
    assert.equal(localOf(addBusinessHours(at('2026-08-21T20:00:00Z'), 4, withSaturday)), '2026-08-22 12:00');
  });

  test('prazo maior que um dia util distribui por varios dias', () => {
    // Segunda 08:00 + 25h uteis = 10h seg + 10h ter + 5h qua -> quarta 13:00.
    assert.equal(localOf(addBusinessHours(at('2026-08-24T11:00:00Z'), 25, weekdaysOnly)), '2026-08-26 13:00');
  });

  test('prazo zero ou negativo devolve o proprio instante', () => {
    const instant = at('2026-08-24T12:00:00Z');
    assert.equal(addBusinessHours(instant, 0, weekdaysOnly), instant);
    assert.equal(addBusinessHours(instant, -3, weekdaysOnly), instant);
  });
});

describe('businessMinutesBetween', () => {
  test('conta apenas o tempo dentro do expediente', () => {
    // Segunda 16:00 -> terca 10:00 = 2h + 2h = 240 minutos uteis.
    const elapsed = businessMinutesBetween(at('2026-08-24T19:00:00Z'), at('2026-08-25T13:00:00Z'), weekdaysOnly);
    assert.equal(elapsed, 240);
  });

  test('um fim de semana inteiro nao consome SLA', () => {
    // Sexta 18:00 -> segunda 08:00.
    const elapsed = businessMinutesBetween(at('2026-08-21T21:00:00Z'), at('2026-08-24T11:00:00Z'), weekdaysOnly);
    assert.equal(elapsed, 0);
  });

  test('e a inversa de addBusinessHours', () => {
    const start = at('2026-08-21T20:00:00Z');
    const due = addBusinessHours(start, 4, weekdaysOnly);
    assert.equal(businessMinutesBetween(start, due, weekdaysOnly), 240);
  });

  test('intervalo invertido ou vazio da zero', () => {
    assert.equal(businessMinutesBetween(at('2026-08-25T13:00:00Z'), at('2026-08-24T19:00:00Z'), weekdaysOnly), 0);
  });
});

describe('feriados nacionais', () => {
  test('inclui fixos e moveis derivados da Pascoa', () => {
    const holidays = brazilianNationalHolidays([2026]);
    // Pascoa 2026: 05/04. Sexta-feira Santa 03/04, carnaval 16 e 17/02, Corpus Christi 04/06.
    for (const date of ['2026-01-01', '2026-04-21', '2026-09-07', '2026-12-25', '2026-11-20']) {
      assert.equal(holidays.has(date), true, `faltou o feriado fixo ${date}`);
    }
    for (const date of ['2026-02-16', '2026-02-17', '2026-04-03', '2026-06-04']) {
      assert.equal(holidays.has(date), true, `faltou o feriado movel ${date}`);
    }
    assert.equal(holidays.has('2026-04-06'), false, 'segunda de Pascoa nao e feriado nacional');
  });

  test('cobre varios anos sem colidir', () => {
    const holidays = brazilianNationalHolidays([2025, 2026, 2027]);
    assert.equal(holidays.has('2025-04-18'), true); // Sexta-feira Santa 2025
    assert.equal(holidays.has('2027-03-26'), true); // Sexta-feira Santa 2027
  });
});

describe('predicados de calendario', () => {
  test('identifica dia util, fim de semana e feriado', () => {
    const withHolidays: BusinessCalendar = { ...weekdaysOnly, holidays: brazilianNationalHolidays([2026]) };
    assert.equal(isBusinessDay(at('2026-08-24T15:00:00Z'), withHolidays), true); // segunda
    assert.equal(isBusinessDay(at('2026-08-23T15:00:00Z'), withHolidays), false); // domingo
    assert.equal(isBusinessDay(at('2026-04-21T15:00:00Z'), withHolidays), false); // Tiradentes
  });

  test('identifica se o instante esta dentro da janela de expediente', () => {
    assert.equal(isWithinBusinessHours(at('2026-08-24T12:00:00Z'), weekdaysOnly), true); // 09:00
    assert.equal(isWithinBusinessHours(at('2026-08-24T21:00:00Z'), weekdaysOnly), false); // 18:00 (exclusivo)
    assert.equal(isWithinBusinessHours(at('2026-08-24T10:59:00Z'), weekdaysOnly), false); // 07:59
  });
});
