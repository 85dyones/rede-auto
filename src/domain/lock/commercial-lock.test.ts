import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  LockStatus,
  convertLockToDeal,
  expireLockIfDue,
  extendLock,
  isActive,
  openLock,
  releaseLock,
  remainingMs,
  type CommercialLock,
  type VehicleWithLock,
} from './commercial-lock.ts';
import { DEFAULT_LOCK_POLICY, EvidenceType, type Evidence } from './evidence.ts';
import {
  CommercialStatus,
  InspectionStatus,
  PhysicalState,
  updatePricing,
  type Vehicle,
} from '../vehicle/vehicle.ts';
import { StoreStatus } from '../network/store.ts';
import { HOUR, DAY } from '../shared/clock.ts';
import { fromReais } from '../shared/money.ts';
import { asDealId, asLockId, asStoreId } from '../shared/ids.ts';
import { unwrap } from '../shared/result.ts';
import {
  atYardOf,
  buildApprovedInspection,
  buildFoundingNetwork,
  buildUser,
  buildVehicle,
} from '../../testing/builders.ts';

const network = buildFoundingNetwork(6);
/** Loja A: dona do veiculo. Loja B: quem tem o cliente. */
const lojaA = network.founderAt(0);
const lojaB = network.founderAt(1);
const lojaC = network.founderAt(2);
const vendedorB = buildUser(lojaB.id, { name: 'Vendedor da Loja B' });
const vendedorC = buildUser(lojaC.id);
const gerenteA = buildUser(lojaA.id);

const T0 = Date.parse('2026-08-24T13:00:00Z');

function availableVehicle(overrides: Partial<Vehicle> = {}): Vehicle {
  return buildVehicle({ ownerStoreId: lojaA.id, createdAt: T0, ...overrides });
}

/** Abre uma trava da Loja B sobre o veiculo dado. */
function lockedByB(vehicle: Vehicle, now = T0): VehicleWithLock {
  return unwrap(
    openLock({
      lockId: asLockId('lck_0001'),
      vehicle,
      holderStore: lojaB,
      holderUser: vendedorB,
      customerReference: 'ATD-4471',
      now,
    }),
  ).state;
}

const evidence = (
  type: Evidence['type'],
  attachment: string | null = 'https://docs.exemplo.com/comp.pdf',
): Evidence => ({
  type,
  reference: 'REF-1',
  attachmentUrl: attachment,
  note: null,
});

describe('abertura da trava', () => {
  test('congela o veiculo por 4 horas e guarda o preco liquido do momento', () => {
    const { vehicle, lock } = lockedByB(availableVehicle());

    assert.equal(vehicle.commercialStatus, CommercialStatus.LOCKED);
    assert.equal(vehicle.activeLockId, lock.id);
    assert.equal(lock.expiresAt - lock.openedAt, 4 * HOUR);
    assert.equal(lock.netPriceSnapshot.cents, fromReais(85_000).cents);
    assert.equal(lock.holderStoreId, lojaB.id);
    assert.equal(lock.customerReference, 'ATD-4471');
  });

  test('bloqueia uma segunda loja enquanto a trava esta ativa', () => {
    const { vehicle } = lockedByB(availableVehicle());
    const result = openLock({
      lockId: asLockId('lck_0002'),
      vehicle,
      holderStore: lojaC,
      holderUser: vendedorC,
      now: T0 + HOUR,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'VEHICLE_ALREADY_LOCKED');
  });

  test('bloqueia ate a propria loja dona — a exclusividade vale contra todos', () => {
    const { vehicle } = lockedByB(availableVehicle());
    const result = openLock({
      lockId: asLockId('lck_0003'),
      vehicle,
      holderStore: lojaA,
      holderUser: gerenteA,
      now: T0 + HOUR,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'VEHICLE_ALREADY_LOCKED');
  });

  test('a loja dona tambem trava o proprio carro, congelando a rede', () => {
    const { vehicle, lock } = unwrap(
      openLock({
        lockId: asLockId('lck_own'),
        vehicle: availableVehicle(),
        holderStore: lojaA,
        holderUser: gerenteA,
        now: T0,
      }),
    ).state;
    assert.equal(vehicle.commercialStatus, CommercialStatus.LOCKED);
    assert.equal(lock.holderStoreId, lojaA.id);
  });

  test('veiculo sem laudo cautelar aprovado nao pode ser travado', () => {
    const semLaudo = availableVehicle({
      commercialStatus: CommercialStatus.DRAFT,
      inspection: { status: InspectionStatus.MISSING, reportNumber: null, provider: null, issuedAt: null, expiresAt: null },
    });
    const result = openLock({
      lockId: asLockId('lck_x'),
      vehicle: semLaudo,
      holderStore: lojaB,
      holderUser: vendedorB,
      now: T0,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'VEHICLE_NOT_PUBLISHED');
  });

  test('laudo vencido bloqueia mesmo com o veiculo marcado como disponivel', () => {
    const laudoVencido = availableVehicle({
      inspection: buildApprovedInspection(T0, { expiresAt: T0 - DAY }),
    });
    const result = openLock({
      lockId: asLockId('lck_x'),
      vehicle: laudoVencido,
      holderStore: lojaB,
      holderUser: vendedorB,
      now: T0,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'INSPECTION_NOT_VALID');
  });

  test('loja suspensa nao abre trava', () => {
    const result = openLock({
      lockId: asLockId('lck_x'),
      vehicle: availableVehicle(),
      holderStore: { ...lojaB, status: StoreStatus.SUSPENDED },
      holderUser: vendedorB,
      now: T0,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'STORE_NOT_ACTIVE');
  });
});

describe('expiracao por decurso de prazo', () => {
  test('segue ativa ate o ultimo instante e expira exatamente no vencimento', () => {
    const { lock } = lockedByB(availableVehicle());
    assert.equal(isActive(lock, T0 + 4 * HOUR - 1), true);
    assert.equal(isActive(lock, T0 + 4 * HOUR), false, 'no instante do vencimento ja esta expirada');
    assert.equal(remainingMs(lock, T0 + HOUR), 3 * HOUR);
  });

  test('ao expirar, o veiculo volta a ficar disponivel para toda a rede', () => {
    const locked = lockedByB(availableVehicle());
    const { state, events } = unwrap(expireLockIfDue(locked.vehicle, locked.lock, T0 + 4 * HOUR));

    assert.equal(state.lock.status, LockStatus.EXPIRED);
    assert.equal(state.vehicle.commercialStatus, CommercialStatus.AVAILABLE);
    assert.equal(state.vehicle.activeLockId, null);
    assert.ok(events.some((e) => e.type === 'lock.expired'));
    assert.ok(events.some((e) => e.type === 'vehicle.available_again'));
  });

  test('A LOCALIZACAO FISICA NAO MUDA quando a trava cai', () => {
    // O nucleo do produto: o carro esta no showroom da Loja B como estoque
    // avancado. O cliente desistiu, a trava caiu — e nao ha frete de devolucao.
    const noPatioDaB = atYardOf(availableVehicle(), lojaB.id, T0 - DAY);
    const locked = lockedByB(noPatioDaB);
    const { state, events } = unwrap(expireLockIfDue(locked.vehicle, locked.lock, T0 + 4 * HOUR));

    assert.equal(state.vehicle.commercialStatus, CommercialStatus.AVAILABLE, 'livre para a rede');
    assert.equal(state.vehicle.physical.custodianStoreId, lojaB.id, 'segue no patio da Loja B');
    assert.equal(state.vehicle.physical.state, PhysicalState.AT_YARD);
    assert.equal(state.vehicle.physical.since, T0 - DAY, 'a custodia nem sequer teve a data tocada');

    const evento = events.find((e) => e.type === 'vehicle.available_again');
    assert.equal(evento?.payload['onExtendedCustody'], true);
  });

  test('depois de expirar, qualquer loja trava de novo — inclusive a que perdeu o prazo', () => {
    // O carro esta no patio da Loja B: para ela, virou oportunidade de balcao.
    const noPatioDaB = atYardOf(availableVehicle(), lojaB.id);
    const locked = lockedByB(noPatioDaB);
    const expired = unwrap(expireLockIfDue(locked.vehicle, locked.lock, T0 + 4 * HOUR)).state;

    const reopenedByB = openLock({
      lockId: asLockId('lck_re'),
      vehicle: expired.vehicle,
      holderStore: lojaB,
      holderUser: vendedorB,
      now: T0 + 4 * HOUR + 60_000,
    });
    assert.equal(reopenedByB.ok, true, 'sem carencia: a Loja B pode travar de novo imediatamente');

    const reopenedByC = openLock({
      lockId: asLockId('lck_re2'),
      vehicle: expired.vehicle,
      holderStore: lojaC,
      holderUser: vendedorC,
      now: T0 + 4 * HOUR + 60_000,
    });
    assert.equal(reopenedByC.ok, true, 'e qualquer outro membro tambem');
  });

  test('expirar e idempotente: varredor e leitura podem chamar a vontade', () => {
    const locked = lockedByB(availableVehicle());
    const first = unwrap(expireLockIfDue(locked.vehicle, locked.lock, T0 + 5 * HOUR));
    const second = unwrap(expireLockIfDue(first.state.vehicle, first.state.lock, T0 + 6 * HOUR));

    assert.equal(second.events.length, 0, 'a segunda chamada nao emite eventos');
    assert.equal(second.state.lock.endedAt, T0 + 5 * HOUR, 'mantem o instante do primeiro encerramento');
  });

  test('antes do vencimento, nada acontece', () => {
    const locked = lockedByB(availableVehicle());
    const result = unwrap(expireLockIfDue(locked.vehicle, locked.lock, T0 + 3 * HOUR));
    assert.equal(result.state.lock.status, LockStatus.ACTIVE);
    assert.equal(result.events.length, 0);
  });

  test('laudo que venceu durante a trava impede a volta ao catalogo', () => {
    const vehicle = availableVehicle({ inspection: buildApprovedInspection(T0, { expiresAt: T0 + 2 * HOUR }) });
    const locked = lockedByB(vehicle);
    const expired = unwrap(expireLockIfDue(locked.vehicle, locked.lock, T0 + 4 * HOUR)).state;

    assert.equal(expired.vehicle.commercialStatus, CommercialStatus.DRAFT);
  });

  test('carro removido do feed do dono e parado no patio dele sai da rede', () => {
    const locked = lockedByB(availableVehicle({ missingFromFeed: true }));
    const expired = unwrap(expireLockIfDue(locked.vehicle, locked.lock, T0 + 4 * HOUR)).state;
    assert.equal(expired.vehicle.commercialStatus, CommercialStatus.WITHDRAWN);
  });

  test('mas se ele estiver no patio de outra loja, continua disponivel e sinalizado', () => {
    // Retirar da rede sozinho aqui seria decidir logistica por conta propria:
    // o carro esta com terceiro e alguem precisa combinar o retorno.
    const locked = lockedByB(atYardOf(availableVehicle({ missingFromFeed: true }), lojaB.id));
    const expired = unwrap(expireLockIfDue(locked.vehicle, locked.lock, T0 + 4 * HOUR)).state;

    assert.equal(expired.vehicle.commercialStatus, CommercialStatus.AVAILABLE);
    assert.equal(expired.vehicle.missingFromFeed, true);
  });
});

describe('extensao por evidencia de avanco no funil', () => {
  test('proposta bancaria em analise soma 4 horas', () => {
    const locked = lockedByB(availableVehicle());
    const extended = unwrap(
      extendLock({
        vehicle: locked.vehicle,
        lock: locked.lock,
        actorStoreId: lojaB.id,
        actorUserId: vendedorB.id,
        evidence: evidence(EvidenceType.BANK_PROPOSAL_SUBMITTED, null),
        now: T0 + 3 * HOUR,
      }),
    ).state;

    assert.equal(extended.lock.expiresAt, T0 + 8 * HOUR, 'soma sobre o vencimento, nao sobre "agora"');
    assert.equal(extended.lock.extensions.length, 1);
  });

  test('comprovante de sinal soma 48 horas', () => {
    const locked = lockedByB(availableVehicle());
    const extended = unwrap(
      extendLock({
        vehicle: locked.vehicle,
        lock: locked.lock,
        actorStoreId: lojaB.id,
        actorUserId: vendedorB.id,
        evidence: evidence(EvidenceType.DEPOSIT_RECEIPT),
        now: T0 + HOUR,
      }),
    ).state;
    assert.equal(extended.lock.expiresAt, T0 + 52 * HOUR);
  });

  test('evidencia forte exige anexo do comprovante', () => {
    const locked = lockedByB(availableVehicle());
    const result = extendLock({
      vehicle: locked.vehicle,
      lock: locked.lock,
      actorStoreId: lojaB.id,
      actorUserId: vendedorB.id,
      evidence: evidence(EvidenceType.DEPOSIT_RECEIPT, null),
      now: T0 + HOUR,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'EVIDENCE_ATTACHMENT_REQUIRED');
  });

  test('a mesma evidencia nao estica a trava indefinidamente', () => {
    let current = lockedByB(availableVehicle());
    for (let i = 0; i < 2; i += 1) {
      current = unwrap(
        extendLock({
          vehicle: current.vehicle,
          lock: current.lock,
          actorStoreId: lojaB.id,
          actorUserId: vendedorB.id,
          evidence: evidence(EvidenceType.BANK_PROPOSAL_SUBMITTED, null),
          now: T0 + HOUR,
        }),
      ).state;
    }
    const third = extendLock({
      vehicle: current.vehicle,
      lock: current.lock,
      actorStoreId: lojaB.id,
      actorUserId: vendedorB.id,
      evidence: evidence(EvidenceType.BANK_PROPOSAL_SUBMITTED, null),
      now: T0 + HOUR,
    });
    assert.equal(third.ok, false);
    assert.equal(third.ok === false && third.error.code, 'EVIDENCE_QUOTA_EXCEEDED');
  });

  test('trava ja expirada nao ressuscita — e preciso disputar de novo', () => {
    const locked = lockedByB(availableVehicle());
    const result = extendLock({
      vehicle: locked.vehicle,
      lock: locked.lock,
      actorStoreId: lojaB.id,
      actorUserId: vendedorB.id,
      evidence: evidence(EvidenceType.SIGNED_ORDER),
      now: T0 + 5 * HOUR,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'LOCK_NOT_ACTIVE');
  });

  test('so o detentor estende', () => {
    const locked = lockedByB(availableVehicle());
    const result = extendLock({
      vehicle: locked.vehicle,
      lock: locked.lock,
      actorStoreId: lojaC.id,
      actorUserId: vendedorC.id,
      evidence: evidence(EvidenceType.BANK_PROPOSAL_SUBMITTED, null),
      now: T0 + HOUR,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'NOT_LOCK_HOLDER');
  });

  test('o teto absoluto corta a extensao e o sinaliza', () => {
    const locked = lockedByB(availableVehicle());
    // Pedido assinado (+72h) leva a trava a 76h. O sinal (+48h) pediria 124h,
    // mas o teto de 5 dias corta em 120h.
    const comPedido = unwrap(
      extendLock({
        vehicle: locked.vehicle,
        lock: locked.lock,
        actorStoreId: lojaB.id,
        actorUserId: vendedorB.id,
        evidence: evidence(EvidenceType.SIGNED_ORDER),
        now: T0 + HOUR,
      }),
    ).state;
    assert.equal(comPedido.lock.expiresAt, T0 + 76 * HOUR);

    const capped = unwrap(
      extendLock({
        vehicle: comPedido.vehicle,
        lock: comPedido.lock,
        actorStoreId: lojaB.id,
        actorUserId: vendedorB.id,
        evidence: evidence(EvidenceType.DEPOSIT_RECEIPT),
        now: T0 + 2 * HOUR,
      }),
    ).state;

    assert.equal(capped.lock.expiresAt, T0 + DEFAULT_LOCK_POLICY.maxTotalMs, 'travado no teto de 5 dias');
    assert.equal(capped.lock.extensions.at(-1)?.cappedByPolicy, true);
    assert.equal(capped.lock.extensions.at(-1)?.grantedMs, 44 * HOUR, 'concede so o que cabe ate o teto');
  });

  test('no teto, novas extensoes sao recusadas com mensagem acionavel', () => {
    const locked = lockedByB(availableVehicle());
    const atCap: CommercialLock = { ...locked.lock, expiresAt: T0 + DEFAULT_LOCK_POLICY.maxTotalMs };
    const result = extendLock({
      vehicle: locked.vehicle,
      lock: atCap,
      actorStoreId: lojaB.id,
      actorUserId: vendedorB.id,
      evidence: evidence(EvidenceType.TRADE_IN_APPRAISAL, null),
      now: T0 + 4 * DAY,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'LOCK_MAX_DURATION_REACHED');
  });
});

describe('preco liquido durante a trava', () => {
  test('a dona pode reprecificar, mas o novo liquido so vale depois da trava', () => {
    const locked = lockedByB(availableVehicle());
    const reprecificado = unwrap(
      updatePricing({
        vehicle: locked.vehicle,
        actorStoreId: lojaA.id,
        netPrice: fromReais(89_000),
        now: T0 + HOUR,
      }),
    );

    assert.equal(reprecificado.state.pricing.netPrice.cents, fromReais(85_000).cents, 'o vigente nao muda');
    assert.equal(reprecificado.state.pendingNetPrice?.cents, fromReais(89_000).cents, 'fica represado');
    assert.ok(reprecificado.events.some((e) => e.type === 'vehicle.net_price_deferred'));

    // A Loja B negocia sobre o numero que travou.
    assert.equal(locked.lock.netPriceSnapshot.cents, fromReais(85_000).cents);

    const expired = unwrap(
      expireLockIfDue(reprecificado.state, locked.lock, T0 + 4 * HOUR),
    ).state;
    assert.equal(expired.vehicle.pricing.netPrice.cents, fromReais(89_000).cents, 'passa a valer no fim da trava');
    assert.equal(expired.vehicle.pendingNetPrice, null);
  });

  test('sem trava ativa, a reprecificacao vale na hora', () => {
    const updated = unwrap(
      updatePricing({
        vehicle: availableVehicle(),
        actorStoreId: lojaA.id,
        netPrice: fromReais(83_000),
        now: T0 + HOUR,
      }),
    );
    assert.equal(updated.state.pricing.netPrice.cents, fromReais(83_000).cents);
    assert.equal(updated.state.pendingNetPrice, null);
  });

  test('quem nao e dono nao precifica', () => {
    const result = updatePricing({
      vehicle: availableVehicle(),
      actorStoreId: lojaB.id,
      netPrice: fromReais(70_000),
      now: T0,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'NOT_VEHICLE_OWNER');
  });
});

describe('liberacao antecipada e conversao em venda', () => {
  test('o detentor libera antes do prazo e o carro volta a rede na hora', () => {
    const noPatioDaB = atYardOf(availableVehicle(), lojaB.id);
    const locked = lockedByB(noPatioDaB);
    const released = unwrap(
      releaseLock({
        vehicle: locked.vehicle,
        lock: locked.lock,
        actorStoreId: lojaB.id,
        reason: 'Cliente desistiu',
        now: T0 + 90 * 60_000,
      }),
    ).state;

    assert.equal(released.lock.status, LockStatus.RELEASED);
    assert.equal(released.vehicle.commercialStatus, CommercialStatus.AVAILABLE);
    assert.equal(released.vehicle.physical.custodianStoreId, lojaB.id, 'o carro continua onde estava');
  });

  test('a loja dona NAO cancela a trava de terceiro', () => {
    // Se pudesse, a exclusividade que a Loja B comprou ao assumir o cliente
    // valeria nada. Para reaver o carro, a dona usa recall.
    const locked = lockedByB(availableVehicle());
    const result = releaseLock({
      vehicle: locked.vehicle,
      lock: locked.lock,
      actorStoreId: lojaA.id,
      now: T0 + HOUR,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'NOT_LOCK_HOLDER');
  });

  test('conversao em venda marca o veiculo como vendido', () => {
    const locked = lockedByB(availableVehicle());
    const converted = unwrap(
      convertLockToDeal({
        vehicle: locked.vehicle,
        lock: locked.lock,
        dealId: asDealId('dea_0001'),
        now: T0 + 2 * HOUR,
      }),
    ).state;

    assert.equal(converted.lock.status, LockStatus.CONVERTED);
    assert.equal(converted.lock.dealId, 'dea_0001');
    assert.equal(converted.vehicle.commercialStatus, CommercialStatus.SOLD);
    assert.equal(converted.vehicle.activeLockId, null);
  });

  test('trava expirada nao vira venda', () => {
    const locked = lockedByB(availableVehicle());
    const result = convertLockToDeal({
      vehicle: locked.vehicle,
      lock: locked.lock,
      dealId: asDealId('dea_0002'),
      now: T0 + 5 * HOUR,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'LOCK_NOT_ACTIVE');
  });

  test('liberar uma trava ja encerrada e inofensivo', () => {
    const locked = lockedByB(availableVehicle());
    const expired = unwrap(expireLockIfDue(locked.vehicle, locked.lock, T0 + 4 * HOUR)).state;
    const result = unwrap(
      releaseLock({
        vehicle: expired.vehicle,
        lock: expired.lock,
        actorStoreId: lojaB.id,
        now: T0 + 5 * HOUR,
      }),
    );
    assert.equal(result.events.length, 0);
    assert.equal(result.state.lock.status, LockStatus.EXPIRED);
  });
});

/** Guarda contra um id de loja inventado escapar por engano nos fixtures. */
test('fixtures usam ids de loja consistentes', () => {
  assert.notEqual(lojaA.id, asStoreId('str_desconhecida'));
});
