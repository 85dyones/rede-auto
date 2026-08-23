import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  attributeInfraction,
  buildCustodyLedger,
  custodyDurationByStore,
  resolveCustodianAt,
} from './ledger.ts';
import { TransferPurpose, checkIn, openTransfer, type CustodyTransfer } from './custody.ts';
import { PhysicalState, type Vehicle } from '../vehicle/vehicle.ts';
import { asCustodyTransferId, type StoreId } from '../shared/ids.ts';
import { DAY, HOUR } from '../shared/clock.ts';
import { unwrap } from '../shared/result.ts';
import { buildFoundingNetwork, buildSignedTerm, buildVehicle } from '../../testing/builders.ts';

const network = buildFoundingNetwork(6);
const lojaA = network.founderAt(0);
const lojaB = network.founderAt(1);
const lojaC = network.founderAt(2);

const T0 = Date.parse('2026-03-01T12:00:00Z');

/**
 * Encena o percurso real de um carro de estoque avancado:
 *   A (01/03) -> B (05/03) -> C (12/03) -> A (20/03)
 */
function threeHopHistory(): { vehicle: Vehicle; transfers: CustodyTransfer[] } {
  let vehicle = buildVehicle({ ownerStoreId: lojaA.id, createdAt: T0 });
  const transfers: CustodyTransfer[] = [];

  const hops: ReadonlyArray<readonly [StoreId, StoreId, number, number]> = [
    [lojaA.id, lojaB.id, 4 * DAY, 4 * DAY + 3 * HOUR],
    [lojaB.id, lojaC.id, 11 * DAY, 11 * DAY + 5 * HOUR],
    [lojaC.id, lojaA.id, 19 * DAY, 19 * DAY + 4 * HOUR],
  ];

  hops.forEach(([from, to, outAt, inAt], index) => {
    const opened = unwrap(
      openTransfer({
        transferId: asCustodyTransferId(`cst_${index + 1}`),
        vehicle,
        toStoreId: to,
        purpose: TransferPurpose.EXTENDED_STOCK,
        checkout: buildSignedTerm(from, T0 + outAt),
        now: T0 + outAt,
      }),
    ).state;

    const closed = unwrap(
      checkIn({
        vehicle: opened.vehicle,
        transfer: opened.transfer,
        checkin: buildSignedTerm(to, T0 + inAt),
        now: T0 + inAt,
      }),
    ).state;

    vehicle = closed.vehicle;
    transfers.push(closed.transfer);
  });

  return { vehicle, transfers };
}

describe('linha do tempo da custodia', () => {
  test('comeca no patio da loja proprietaria', () => {
    const vehicle = buildVehicle({ ownerStoreId: lojaA.id, createdAt: T0 });
    const ledger = buildCustodyLedger(vehicle, []);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]?.storeId, lojaA.id);
    assert.equal(ledger[0]?.to, null, 'periodo em curso');
  });

  test('cada entrada assinada abre um periodo novo', () => {
    const { vehicle, transfers } = threeHopHistory();
    const ledger = buildCustodyLedger(vehicle, transfers);

    assert.deepEqual(
      ledger.map((period) => period.storeId),
      [lojaA.id, lojaB.id, lojaC.id, lojaA.id],
    );
    assert.equal(ledger.at(-1)?.to, null);
  });

  test('termo aberto (em transito) nao cria periodo novo', () => {
    const vehicle = buildVehicle({ ownerStoreId: lojaA.id, createdAt: T0 });
    const opened = unwrap(
      openTransfer({
        transferId: asCustodyTransferId('cst_open'),
        vehicle,
        toStoreId: lojaB.id,
        purpose: TransferPurpose.EXTENDED_STOCK,
        checkout: buildSignedTerm(lojaA.id, T0 + DAY),
        now: T0 + DAY,
      }),
    ).state;

    const ledger = buildCustodyLedger(opened.vehicle, [opened.transfer]);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]?.storeId, lojaA.id, 'o tempo em transito pertence a origem');
  });
});

describe('atribuicao de multa pela data da infracao', () => {
  test('aponta a loja que estava com o carro naquele instante', () => {
    const { vehicle, transfers } = threeHopHistory();
    const ledger = buildCustodyLedger(vehicle, transfers);

    // 03/03: ainda na Loja A.
    assert.equal(resolveCustodianAt(ledger, T0 + 2 * DAY)?.storeId, lojaA.id);
    // 08/03: com a Loja B.
    assert.equal(resolveCustodianAt(ledger, T0 + 7 * DAY)?.storeId, lojaB.id);
    // 15/03: com a Loja C.
    assert.equal(resolveCustodianAt(ledger, T0 + 14 * DAY)?.storeId, lojaC.id);
    // 25/03: de volta com a Loja A.
    assert.equal(resolveCustodianAt(ledger, T0 + 24 * DAY)?.storeId, lojaA.id);
  });

  test('infracao durante o transito e da loja de origem', () => {
    const { vehicle, transfers } = threeHopHistory();
    const ledger = buildCustodyLedger(vehicle, transfers);
    // 05/03 as 14h: o carro saiu da A mas a B ainda nao assinou a entrada.
    const duranteTransito = T0 + 4 * DAY + HOUR;
    assert.equal(resolveCustodianAt(ledger, duranteTransito)?.storeId, lojaA.id);
  });

  test('o instante exato do check-in ja pertence ao destino', () => {
    // Sem essa convencao existiria um microssegundo com dois responsaveis.
    const { vehicle, transfers } = threeHopHistory();
    const ledger = buildCustodyLedger(vehicle, transfers);
    const checkinInstant = T0 + 4 * DAY + 3 * HOUR;

    assert.equal(resolveCustodianAt(ledger, checkinInstant - 1)?.storeId, lojaA.id);
    assert.equal(resolveCustodianAt(ledger, checkinInstant)?.storeId, lojaB.id);
  });

  test('devolve a atribuicao com o periodo que a justifica', () => {
    const { vehicle, transfers } = threeHopHistory();
    const ledger = buildCustodyLedger(vehicle, transfers);
    const attribution = attributeInfraction(ledger, T0 + 14 * DAY);

    assert.equal(attribution.resolved, true);
    if (!attribution.resolved) return;
    assert.equal(attribution.storeId, lojaC.id);
    assert.equal(attribution.period.transferId, 'cst_2');
  });

  test('nao adivinha fora do periodo em que o carro esteve na rede', () => {
    const { vehicle, transfers } = threeHopHistory();
    const ledger = buildCustodyLedger(vehicle, transfers);
    const antes = attributeInfraction(ledger, T0 - DAY);

    assert.equal(antes.resolved, false);
    assert.equal(antes.resolved === false && antes.reason, 'BEFORE_FIRST_CUSTODY');
  });

  test('depois da entrega ao consumidor, a rede nao responde mais', () => {
    const { vehicle, transfers } = threeHopHistory();
    const entregue: Vehicle = {
      ...vehicle,
      physical: { ...vehicle.physical, state: PhysicalState.DELIVERED_TO_CONSUMER, since: T0 + 30 * DAY },
    };
    const ledger = buildCustodyLedger(entregue, transfers);
    const depois = attributeInfraction(ledger, T0 + 40 * DAY);

    assert.equal(depois.resolved, false);
    assert.equal(depois.resolved === false && depois.reason, 'AFTER_DELIVERY');
  });
});

describe('tempo de patio por loja', () => {
  test('soma a permanencia de cada loja, incluindo o periodo em aberto', () => {
    const { vehicle, transfers } = threeHopHistory();
    const ledger = buildCustodyLedger(vehicle, transfers);
    const totals = custodyDurationByStore(ledger, T0 + 30 * DAY);

    // Loja A: 0 -> 4d3h (saida+entrada da B) e 19d4h -> 30d.
    const expectedA = 4 * DAY + 3 * HOUR + (30 * DAY - (19 * DAY + 4 * HOUR));
    assert.equal(totals.get(lojaA.id), expectedA);
    assert.equal(totals.get(lojaB.id), 11 * DAY + 5 * HOUR - (4 * DAY + 3 * HOUR));
  });
});
