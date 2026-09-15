import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  BreachKind,
  DEFAULT_CONDUCT_POLICY,
  type Breach,
  breachIdFor,
  breachesInWindow,
  conductRecord,
  reopenAfterWindow,
  suspendForConduct,
} from './breach.ts';
import { StoreStatus } from '../network/store.ts';
import { addMonths, DAY } from '../shared/clock.ts';
import { asClusterId, asMemberId, asStoreId } from '../shared/ids.ts';
import { buildStore } from '../../testing/builders.ts';
import { unwrap } from '../shared/result.ts';

const LOJA = asStoreId('str_x');
const T0 = Date.parse('2026-03-09T12:00:00Z');

function quebra(at: number, kind: BreachKind = BreachKind.RECALL_SLA, evidencia = `ev_${at}`): Breach {
  return {
    id: breachIdFor(kind, evidencia),
    clusterId: asClusterId('clu_test'),
    storeId: LOJA,
    memberId: asMemberId('mbr_x'),
    kind,
    occurredAt: at,
    evidenceId: evidencia,
    overdueMinutes: 90,
  };
}

describe('identidade da quebra', () => {
  test('uma quebra por especie e agregado — e o que torna a deteccao segura', () => {
    // O varredor roda a cada minuto sobre os mesmos termos vencidos. Sem id
    // deterministico, um atraso viraria 60 quebras por hora.
    assert.equal(
      breachIdFor(BreachKind.RECALL_SLA, 'rcl_1'),
      breachIdFor(BreachKind.RECALL_SLA, 'rcl_1'),
    );
  });

  test('especies diferentes sobre o mesmo agregado sao quebras diferentes', () => {
    // Um mesmo termo pode ser abandonado em transito e, depois de retomado,
    // ficar sem aceite. Sao duas falhas, nao uma.
    assert.notEqual(
      breachIdFor(BreachKind.TRANSFER_ABANDONED, 'cst_1'),
      breachIdFor(BreachKind.DROPOFF_NOT_ACKNOWLEDGED, 'cst_1'),
    );
  });
});

describe('janela movel de 12 meses', () => {
  test('uma quebra por ano nunca chega a tres', () => {
    // E a razao de a janela ser movel: contagem vitalicia transformaria toda
    // loja antiga em candidata a suspensao por acumulo lento. Em qualquer
    // instante da serie, a janela pega no maximo duas.
    const anuais = [quebra(T0), quebra(addMonths(T0, 11)), quebra(addMonths(T0, 22))];

    for (const mes of [0, 6, 11, 17, 22, 30]) {
      const record = conductRecord(LOJA, anuais, addMonths(T0, mes));
      assert.ok(
        record.withinWindow < DEFAULT_CONDUCT_POLICY.breachesToSuspend,
        `no mes ${mes} a janela tinha ${record.withinWindow}`,
      );
      assert.equal(record.reachedThreshold, false);
    }
  });

  test('tres quebras num mes atingem o numero', () => {
    const seguidas = [quebra(T0), quebra(T0 + 5 * DAY), quebra(T0 + 9 * DAY)];
    const record = conductRecord(LOJA, seguidas, T0 + 10 * DAY);

    assert.equal(record.withinWindow, 3);
    assert.equal(record.reachedThreshold, true);
  });

  test('a mais antiga sai da janela exatamente 12 meses depois', () => {
    const tres = [quebra(T0), quebra(T0 + DAY), quebra(T0 + 2 * DAY)];
    const saida = addMonths(T0, DEFAULT_CONDUCT_POLICY.windowMonths);

    assert.equal(conductRecord(LOJA, tres, saida - 1).withinWindow, 3);
    assert.equal(conductRecord(LOJA, tres, saida).withinWindow, 2, 'no instante do fim ja saiu');
    assert.equal(conductRecord(LOJA, tres, saida).oldestExpiresAt, addMonths(T0 + DAY, 12));
  });

  test('quebra futura nao conta', () => {
    assert.equal(breachesInWindow([quebra(T0 + DAY)], T0).length, 0);
  });
});

describe('sancao e alivio', () => {
  const loja = buildStore({ id: LOJA });

  test('tres quebras suspendem o PATIO', () => {
    const record = conductRecord(LOJA, [quebra(T0), quebra(T0 + DAY), quebra(T0 + 2 * DAY)], T0 + 3 * DAY);
    const transition = unwrap(suspendForConduct(loja, record, T0 + 3 * DAY));

    assert.equal(transition.state.status, StoreStatus.SUSPENDED);
    assert.equal(transition.events[0]?.type, 'conduct.store_suspended');
  });

  test('duas quebras nao suspendem', () => {
    const record = conductRecord(LOJA, [quebra(T0), quebra(T0 + DAY)], T0 + 2 * DAY);
    assert.equal(unwrap(suspendForConduct(loja, record, T0 + 2 * DAY)).events.length, 0);
  });

  test('suspender de novo quem ja esta suspenso nao emite evento', () => {
    // O varredor roda todo minuto; sem isto, a loja suspensa geraria um aviso
    // por minuto ate alguem reparar.
    const suspensa = { ...loja, status: StoreStatus.SUSPENDED };
    const record = conductRecord(LOJA, [quebra(T0), quebra(T0 + DAY), quebra(T0 + 2 * DAY)], T0 + 3 * DAY);

    assert.equal(unwrap(suspendForConduct(suspensa, record, T0 + 3 * DAY)).events.length, 0);
  });

  test('a janela aliviando reabre o patio sozinha', () => {
    // Punicao que depende de alguem lembrar de tirar vira permanente.
    const suspensa = { ...loja, status: StoreStatus.SUSPENDED };
    const tres = [quebra(T0), quebra(T0 + DAY), quebra(T0 + 2 * DAY)];
    const depois = addMonths(T0, 12) + 2 * DAY;

    const record = conductRecord(LOJA, tres, depois);
    assert.equal(record.reachedThreshold, false, 'a mais antiga ja saiu da janela');

    const transition = unwrap(reopenAfterWindow(suspensa, record, depois));
    assert.equal(transition.state.status, StoreStatus.ACTIVE);
    assert.equal(transition.events[0]?.type, 'conduct.store_reopened');
  });

  test('nao reabre enquanto o numero continua de pe', () => {
    const suspensa = { ...loja, status: StoreStatus.SUSPENDED };
    const record = conductRecord(LOJA, [quebra(T0), quebra(T0 + DAY), quebra(T0 + 2 * DAY)], T0 + 3 * DAY);

    assert.equal(unwrap(reopenAfterWindow(suspensa, record, T0 + 3 * DAY)).events.length, 0);
  });

  test('loja desligada nao e reaberta pelo alivio da janela', () => {
    // EXITED e decisao de governanca. Uma quebra saindo da janela nao desfaz um
    // desligamento votado.
    const desligada = { ...loja, status: StoreStatus.EXITED };
    const record = conductRecord(LOJA, [], T0);

    assert.equal(unwrap(reopenAfterWindow(desligada, record, T0)).events.length, 0);
  });
});
