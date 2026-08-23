import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PriorityHolder,
  RecallCancelReason,
  RecallReason,
  RecallStatus,
  cancelRecall,
  flagBreachIfOverdue,
  fulfillRecall,
  isOverdue,
  remainingBusinessMinutes,
  requestRecall,
  resolvePriority,
  startSlaAfterLockRelease,
  supersedeByRecallSale,
  type ActiveLockView,
  type Recall,
  type RecallPolicy,
} from './recall.ts';
import { CommercialStatus, PhysicalState, type Vehicle } from '../vehicle/vehicle.ts';
import { timeWindow, toZonedParts, type BusinessCalendar } from '../shared/business-hours.ts';
import { DAY, HOUR } from '../shared/clock.ts';
import { asCustodyTransferId, asDealId, asRecallId } from '../shared/ids.ts';
import { unwrap } from '../shared/result.ts';
import { atYardOf, buildFoundingNetwork, buildVehicle } from '../../testing/builders.ts';

const network = buildFoundingNetwork(6);
const lojaA = network.founderAt(0);
const lojaB = network.founderAt(1);
const gerenteA = network.principalAt(0);

const SP = 'America/Sao_Paulo';
const calendar: BusinessCalendar = {
  timeZone: SP,
  workdays: [1, 2, 3, 4, 5],
  windows: [timeWindow('08:00', '18:00')],
  holidays: new Set(),
};
const policy: RecallPolicy = { slaBusinessHours: 4, calendar };

/** Segunda-feira, 09:00 em Sao Paulo. */
const T0 = Date.parse('2026-08-24T12:00:00Z');

const localOf = (instant: number): string => {
  const parts = toZonedParts(instant, SP);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
};

/** Veiculo da Loja A, fisicamente no patio da Loja B (estoque avancado). */
function atLojaB(overrides: Partial<Vehicle> = {}): Vehicle {
  return atYardOf(buildVehicle({ ownerStoreId: lojaA.id, createdAt: T0 - 30 * DAY, ...overrides }), lojaB.id, T0 - 10 * DAY);
}

const activeLock = (expiresAt: number): ActiveLockView => ({
  lockId: 'lck_0001',
  holderStoreId: lojaB.id,
  expiresAt,
});

function openRecall(vehicle: Vehicle, lock: ActiveLockView | null, now = T0): Recall {
  return unwrap(
    requestRecall({
      recallId: asRecallId('rcl_0001'),
      vehicle,
      requestedByStoreId: lojaA.id,
      requestedByUserId: gerenteA.id,
      reason: RecallReason.OWN_SALE,
      activeLock: lock,
      openRecall: null,
      now,
      policy,
    }),
  ).state;
}

describe('regra de prioridade', () => {
  test('sem trava ativa, a prioridade e da loja proprietaria', () => {
    const ruling = resolvePriority(atLojaB(), null, T0);
    assert.equal(ruling.holder, PriorityHolder.OWNER);
    assert.equal(ruling.holderStoreId, lojaA.id);
  });

  test('com trava ativa de terceiro, a prioridade e de quem travou', () => {
    const ruling = resolvePriority(atLojaB(), activeLock(T0 + 4 * HOUR), T0 + HOUR);
    assert.equal(ruling.holder, PriorityHolder.LOCK_HOLDER);
    assert.equal(ruling.holderStoreId, lojaB.id);
    assert.equal(ruling.until, T0 + 4 * HOUR);
  });

  test('trava vencida devolve a prioridade a loja proprietaria', () => {
    const ruling = resolvePriority(atLojaB(), activeLock(T0 + 4 * HOUR), T0 + 5 * HOUR);
    assert.equal(ruling.holder, PriorityHolder.OWNER);
  });

  test('trava da propria dona nao tira a prioridade dela', () => {
    const lockDaDona: ActiveLockView = { lockId: 'lck_x', holderStoreId: lojaA.id, expiresAt: T0 + 4 * HOUR };
    const ruling = resolvePriority(atLojaB(), lockDaDona, T0 + HOUR);
    assert.equal(ruling.holder, PriorityHolder.OWNER);
  });
});

describe('carro disponivel no patio de terceiro: dona tem prioridade total', () => {
  test('o SLA de 4 horas uteis comeca na hora do pedido', () => {
    const recall = openRecall(atLojaB(), null);

    assert.equal(recall.status, RecallStatus.DUE);
    assert.equal(recall.slaStartedAt, T0);
    // Segunda 09:00 + 4h uteis = segunda 13:00.
    assert.equal(localOf(recall.dueAt as number), '2026-08-24 13:00');
  });

  test('o SLA respeita expediente: pedido sexta a tarde vence na segunda', () => {
    // Sexta 17:00 em Sao Paulo: 1h util na sexta, 3h na segunda.
    const sextaTarde = Date.parse('2026-08-21T20:00:00Z');
    const recall = openRecall(atLojaB(), null, sextaTarde);
    assert.equal(localOf(recall.dueAt as number), '2026-08-24 11:00');
  });

  test('o tempo restante e contado em minutos uteis', () => {
    const recall = openRecall(atLojaB(), null);
    assert.equal(remainingBusinessMinutes(recall, T0 + HOUR, policy), 180);
    assert.equal(remainingBusinessMinutes(recall, T0 + 10 * HOUR, policy), 0);
  });

  test('a devolucao dentro do prazo encerra o recall sem apontamento', () => {
    const recall = openRecall(atLojaB(), null);
    const { state, events } = unwrap(
      fulfillRecall({
        recall,
        transferId: asCustodyTransferId('cst_ret'),
        now: T0 + 2 * HOUR,
        policy,
      }),
    );

    assert.equal(state.status, RecallStatus.FULFILLED);
    assert.equal(state.fulfilledByTransferId, 'cst_ret');
    const fulfilled = events.find((e) => e.type === 'recall.fulfilled');
    assert.equal(fulfilled?.payload['late'], false);
    assert.equal(fulfilled?.payload['elapsedBusinessMinutes'], 120);
    assert.equal(events.some((e) => e.type === 'recall.sla_breached_on_fulfillment'), false);
  });

  test('devolucao fora do prazo e registrada com o atraso em minutos uteis', () => {
    const recall = openRecall(atLojaB(), null);
    // Segunda 09:00 -> terca 10:00 = 9h uteis na segunda + 2h na terca = 660min.
    // Com SLA de 240min, o atraso e de 420 minutos uteis.
    const tercaManha = Date.parse('2026-08-25T13:00:00Z');
    const { state, events } = unwrap(
      fulfillRecall({ recall, transferId: asCustodyTransferId('cst_ret'), now: tercaManha, policy }),
    );

    assert.equal(state.status, RecallStatus.FULFILLED, 'devolver atrasado ainda encerra o recall');
    const breach = events.find((e) => e.type === 'recall.sla_breached_on_fulfillment');
    assert.ok(breach, 'mas o atraso fica registrado');
    assert.equal(breach.payload['overdueBusinessMinutes'], 420);
  });

  test('o descumprimento e sinalizado uma unica vez pelo varredor', () => {
    const recall = openRecall(atLojaB(), null);
    assert.equal(isOverdue(recall, T0 + 2 * HOUR), false);
    assert.equal(isOverdue(recall, T0 + 5 * HOUR), true);

    const first = unwrap(flagBreachIfOverdue(recall, T0 + 5 * HOUR));
    assert.equal(first.state.breachedAt, T0 + 5 * HOUR);
    assert.equal(first.events.length, 1);

    const second = unwrap(flagBreachIfOverdue(first.state, T0 + 6 * HOUR));
    assert.equal(second.events.length, 0, 'o varredor roda a cada minuto e nao pode duplicar alerta');
  });
});

describe('carro com trava ativa: a Loja B tem exclusividade ate o timer zerar', () => {
  test('o recall e aceito, mas fica aguardando e sem prazo correndo', () => {
    const recall = openRecall(atLojaB({ commercialStatus: CommercialStatus.LOCKED }), activeLock(T0 + 4 * HOUR));

    assert.equal(recall.status, RecallStatus.WAITING_LOCK_RELEASE);
    assert.equal(recall.slaStartedAt, null, 'o prazo nao corre enquanto a trava vale');
    assert.equal(recall.dueAt, null);
    assert.equal(recall.blockedByLockId, 'lck_0001');
  });

  test('quando a trava cai, o prazo comeca dali — nao retroage ao pedido', () => {
    // Cobrar o prazo retroativo puniria a Loja B por respeitar a propria trava.
    const recall = openRecall(atLojaB({ commercialStatus: CommercialStatus.LOCKED }), activeLock(T0 + 4 * HOUR));
    const { state, events } = unwrap(startSlaAfterLockRelease(recall, T0 + 4 * HOUR, policy));

    assert.equal(state.status, RecallStatus.DUE);
    assert.equal(state.slaStartedAt, T0 + 4 * HOUR);
    // Trava caiu segunda 13:00; +4h uteis = segunda 17:00.
    assert.equal(localOf(state.dueAt as number), '2026-08-24 17:00');
    assert.ok(events.some((e) => e.type === 'recall.sla_started'));
  });

  test('iniciar o SLA de um recall que nao aguardava e inofensivo', () => {
    const recall = openRecall(atLojaB(), null);
    const result = unwrap(startSlaAfterLockRelease(recall, T0 + HOUR, policy));
    assert.equal(result.events.length, 0);
    assert.equal(result.state.dueAt, recall.dueAt);
  });

  test('se a negociacao travada fechar, o recall e cancelado — nao ha o que devolver', () => {
    const recall = openRecall(atLojaB({ commercialStatus: CommercialStatus.LOCKED }), activeLock(T0 + 4 * HOUR));
    const { state, events } = unwrap(supersedeByRecallSale(recall, asDealId('dea_1'), T0 + 2 * HOUR));

    assert.equal(state.status, RecallStatus.CANCELLED);
    assert.equal(state.cancelReason, RecallCancelReason.SUPERSEDED_BY_SALE);
    // A dona precisa saber que o carro virou dinheiro em vez de voltar ao patio.
    assert.ok(events.some((e) => e.type === 'recall.superseded_by_sale'));
  });
});

describe('quem pode pedir o retorno', () => {
  test('so a loja proprietaria', () => {
    const result = requestRecall({
      recallId: asRecallId('rcl_x'),
      vehicle: atLojaB(),
      requestedByStoreId: lojaB.id,
      requestedByUserId: network.principalAt(1).id,
      reason: RecallReason.OWN_SALE,
      activeLock: null,
      openRecall: null,
      now: T0,
      policy,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'NOT_VEHICLE_OWNER');
  });

  test('nao faz sentido chamar de volta um carro que ja esta no proprio patio', () => {
    const result = requestRecall({
      recallId: asRecallId('rcl_x'),
      vehicle: buildVehicle({ ownerStoreId: lojaA.id, createdAt: T0 }),
      requestedByStoreId: lojaA.id,
      requestedByUserId: gerenteA.id,
      reason: RecallReason.YARD_RETURN,
      activeLock: null,
      openRecall: null,
      now: T0,
      policy,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'VEHICLE_ALREADY_AT_OWNER');
  });

  test('nao ha dois recalls abertos para o mesmo veiculo', () => {
    const existente = openRecall(atLojaB(), null);
    const result = requestRecall({
      recallId: asRecallId('rcl_2'),
      vehicle: atLojaB(),
      requestedByStoreId: lojaA.id,
      requestedByUserId: gerenteA.id,
      reason: RecallReason.OWN_SALE,
      activeLock: null,
      openRecall: existente,
      now: T0 + HOUR,
      policy,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'RECALL_ALREADY_OPEN');
  });

  test('carro ja vendido nao volta por recall', () => {
    const result = requestRecall({
      recallId: asRecallId('rcl_x'),
      vehicle: atLojaB({ commercialStatus: CommercialStatus.SOLD }),
      requestedByStoreId: lojaA.id,
      requestedByUserId: gerenteA.id,
      reason: RecallReason.OWN_SALE,
      activeLock: null,
      openRecall: null,
      now: T0,
      policy,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'VEHICLE_SOLD');
  });

  test('carro ja entregue ao consumidor nao volta por recall', () => {
    const entregue = atLojaB();
    const result = requestRecall({
      recallId: asRecallId('rcl_x'),
      vehicle: { ...entregue, physical: { ...entregue.physical, state: PhysicalState.DELIVERED_TO_CONSUMER } },
      requestedByStoreId: lojaA.id,
      requestedByUserId: gerenteA.id,
      reason: RecallReason.OWN_SALE,
      activeLock: null,
      openRecall: null,
      now: T0,
      policy,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'VEHICLE_DELIVERED');
  });

  test('a dona pode desistir do recall; terceiros nao', () => {
    const recall = openRecall(atLojaB(), null);
    const porTerceiro = cancelRecall({ recall, actorStoreId: lojaB.id, now: T0 + HOUR });
    assert.equal(porTerceiro.ok, false);
    assert.equal(porTerceiro.ok === false && porTerceiro.error.code, 'NOT_RECALL_REQUESTER');

    const pelaDona = unwrap(cancelRecall({ recall, actorStoreId: lojaA.id, now: T0 + HOUR })).state;
    assert.equal(pelaDona.status, RecallStatus.CANCELLED);
    assert.equal(pelaDona.cancelReason, RecallCancelReason.WITHDRAWN_BY_OWNER);
  });

  test('recall ja encerrado nao e cumprido de novo', () => {
    const recall = openRecall(atLojaB(), null);
    const cumprido = unwrap(
      fulfillRecall({ recall, transferId: asCustodyTransferId('cst_1'), now: T0 + HOUR, policy }),
    ).state;
    const denovo = fulfillRecall({
      recall: cumprido,
      transferId: asCustodyTransferId('cst_2'),
      now: T0 + 2 * HOUR,
      policy,
    });
    assert.equal(denovo.ok, false);
    assert.equal(denovo.ok === false && denovo.error.code, 'RECALL_NOT_OPEN');
  });
});
