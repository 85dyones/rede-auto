import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DamageSeverity,
  PhotoAngle,
  TransferPurpose,
  TransferStatus,
  cancelTransfer,
  checkIn,
  computeTermHash,
  declareDropOff,
  deliverToConsumer,
  detectDiscrepancies,
  openTransfer,
  sealTerm,
  verifyTerm,
  type InspectionTerm,
} from './custody.ts';
import { CommercialStatus, PhysicalState, type Vehicle } from '../vehicle/vehicle.ts';
import { asCustodyTransferId } from '../shared/ids.ts';
import { DAY, HOUR } from '../shared/clock.ts';
import { unwrap } from '../shared/result.ts';
import {
  atYardOf,
  buildFoundingNetwork,
  pointNorthOf,
  buildSignedTerm,
  buildSigner,
  buildTermContent,
  buildTermPhotos,
  buildVehicle,
} from '../../testing/builders.ts';

const network = buildFoundingNetwork(6);
const lojaA = network.founderAt(0);
const lojaB = network.founderAt(1);
const lojaC = network.founderAt(2);
const gerenteA = network.principalAt(0);

const T0 = Date.parse('2026-08-24T13:00:00Z');
const TRANSFER_ID = asCustodyTransferId('cst_0001');

const vehicleAtA = (overrides: Partial<Vehicle> = {}): Vehicle =>
  buildVehicle({ ownerStoreId: lojaA.id, createdAt: T0, ...overrides });

/** Abre o termo de saida da Loja A para a Loja B. */
function openAtoB(vehicle: Vehicle, checkout?: InspectionTerm) {
  return unwrap(
    openTransfer({
      transferId: TRANSFER_ID,
      vehicle,
      toStoreId: lojaB.id,
      purpose: TransferPurpose.EXTENDED_STOCK,
      checkout: checkout ?? buildSignedTerm(lojaA.id, T0),
      now: T0,
    }),
  ).state;
}

describe('termo de vistoria', () => {
  test('exige as fotos que sustentam uma discussao de avaria', () => {
    const semTraseira = sealTerm(
      buildTermContent({
        photos: buildTermPhotos().filter((photo) => photo.angle !== PhotoAngle.REAR),
      }),
      buildSigner(lojaA.id),
      T0,
    );
    assert.equal(semTraseira.ok, false);
    assert.equal(semTraseira.ok === false && semTraseira.error.code, 'REQUIRED_PHOTOS_MISSING');
    assert.match(
      semTraseira.ok === false ? semTraseira.error.message : '',
      /REAR/,
      'a mensagem diz qual foto falta',
    );
  });

  test('exige odometro e nivel de combustivel plausiveis', () => {
    assert.equal(sealTerm(buildTermContent({ odometerKm: -5 }), buildSigner(lojaA.id), T0).ok, false);
    assert.equal(sealTerm(buildTermContent({ fuelEighths: 9 }), buildSigner(lojaA.id), T0).ok, false);
  });

  test('exige CPF valido do responsavel que assina', () => {
    const result = sealTerm(buildTermContent(), buildSigner(lojaA.id, { document: '111.111.111-11' }), T0);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'CPF_INVALID');
  });

  test('a assinatura sela o conteudo: edicao posterior e detectada', () => {
    const term = buildSignedTerm(lojaA.id, T0);
    assert.equal(verifyTerm(term), true);

    const adulterado: InspectionTerm = { ...term, odometerKm: 30_000 };
    assert.equal(verifyTerm(adulterado), false, 'baixar o odometro depois de assinado nao passa');

    const fotoTrocada: InspectionTerm = {
      ...term,
      photos: term.photos.map((photo, index) =>
        index === 0 ? { ...photo, url: 'https://cdn.exemplo.com/outra.jpg' } : photo,
      ),
    };
    assert.equal(verifyTerm(fotoTrocada), false, 'trocar foto depois de assinado nao passa');
  });

  test('o hash independe da ordem das fotos e avarias', () => {
    const conteudo = buildTermContent({ photos: buildTermPhotos([PhotoAngle.INTERIOR]) });
    const term = unwrap(sealTerm(conteudo, buildSigner(lojaA.id), T0));
    const embaralhado = { ...term, photos: [...term.photos].reverse() };
    assert.equal(computeTermHash(embaralhado), term.signature.termHash);
  });
});

describe('saida do patio (checkout)', () => {
  test('poe o veiculo em transito e mantem a responsabilidade na origem', () => {
    const { vehicle, transfer } = openAtoB(vehicleAtA());

    assert.equal(vehicle.physical.state, PhysicalState.IN_TRANSIT);
    assert.equal(
      vehicle.physical.custodianStoreId,
      lojaA.id,
      'quem ainda nao conferiu o carro nao herda o risco dele',
    );
    assert.equal(vehicle.physical.inboundStoreId, lojaB.id);
    assert.equal(transfer.status, TransferStatus.OPEN);
  });

  test('quem assina a saida e a loja que esta com o carro', () => {
    const result = openTransfer({
      transferId: TRANSFER_ID,
      vehicle: vehicleAtA(),
      toStoreId: lojaB.id,
      purpose: TransferPurpose.EXTENDED_STOCK,
      checkout: buildSignedTerm(lojaB.id, T0),
      now: T0,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'CHECKOUT_MUST_BE_SIGNED_BY_CUSTODIAN');
  });

  test('nao ha dois termos abertos ao mesmo tempo', () => {
    const { vehicle } = openAtoB(vehicleAtA());
    const second = openTransfer({
      transferId: asCustodyTransferId('cst_0002'),
      vehicle,
      toStoreId: lojaC.id,
      purpose: TransferPurpose.TEST_DRIVE,
      checkout: buildSignedTerm(lojaA.id, T0 + HOUR),
      now: T0 + HOUR,
    });
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.error.code, 'TRANSFER_ALREADY_OPEN');
  });

  test('com trava ativa de terceiro, o carro nao vai parar num quarto patio', () => {
    // Se fosse permitido, a loja que esta negociando ficaria sem como
    // apresentar o veiculo ao cliente dela.
    const result = openTransfer({
      transferId: TRANSFER_ID,
      vehicle: vehicleAtA({ commercialStatus: CommercialStatus.LOCKED }),
      toStoreId: lojaC.id,
      purpose: TransferPurpose.EXTENDED_STOCK,
      checkout: buildSignedTerm(lojaA.id, T0),
      activeLockHolderStoreId: lojaB.id,
      now: T0,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'VEHICLE_UNDER_ACTIVE_LOCK');
  });

  test('mas quem detem a trava pode buscar o carro', () => {
    const result = openTransfer({
      transferId: TRANSFER_ID,
      vehicle: vehicleAtA({ commercialStatus: CommercialStatus.LOCKED }),
      toStoreId: lojaB.id,
      purpose: TransferPurpose.TEST_DRIVE,
      checkout: buildSignedTerm(lojaA.id, T0),
      activeLockHolderStoreId: lojaB.id,
      now: T0,
    });
    assert.equal(result.ok, true);
  });

  test('e a loja proprietaria sempre pode reaver o carro', () => {
    const noPatioDaB = atYardOf(vehicleAtA({ commercialStatus: CommercialStatus.LOCKED }), lojaB.id);
    const result = openTransfer({
      transferId: TRANSFER_ID,
      vehicle: noPatioDaB,
      toStoreId: lojaA.id,
      purpose: TransferPurpose.RECALL_RETURN,
      checkout: buildSignedTerm(lojaB.id, T0),
      activeLockHolderStoreId: lojaB.id,
      now: T0,
    });
    assert.equal(result.ok, true);
  });

  test('origem e destino iguais nao fazem sentido', () => {
    const result = openTransfer({
      transferId: TRANSFER_ID,
      vehicle: vehicleAtA(),
      toStoreId: lojaA.id,
      purpose: TransferPurpose.OTHER,
      checkout: buildSignedTerm(lojaA.id, T0),
      now: T0,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'SAME_STORE_TRANSFER');
  });
});

/**
 * Entrega e conferencia quase nunca coincidem: o motorista deixa o carro as
 * 18h40 e o gerente assina as 8h do dia seguinte. Sem um estado para essas 13
 * horas, elas ficam indistinguiveis de "carro sumido no caminho".
 */
describe('entrega declarada com geolocalizacao', () => {
  /** A coordenada do patio de destino. E contra ela que a declaracao e conferida. */
  const NO_PATIO = lojaB.profile.yard;

  function entregue(at = T0 + 2 * HOUR) {
    const opened = openAtoB(vehicleAtA());
    return unwrap(
      declareDropOff({
        vehicle: opened.vehicle,
        transfer: opened.transfer,
        actorStoreId: lojaA.id,
        actorUserId: gerenteA.id,
        destination: lojaB,
        geolocation: NO_PATIO,
        note: 'Chave na recepcao, vaga 12.',
        now: at,
      }),
    ).state;
  }

  test('declarar entrega NAO transfere a responsabilidade civil', () => {
    // O carro esta la; quem recebe ainda nao conferiu. Declarar entrega e
    // assumir uma posicao registrada, nao se livrar da responsabilidade.
    const state = entregue();

    assert.equal(state.transfer.status, TransferStatus.DROPPED_OFF);
    assert.equal(state.vehicle.physical.state, PhysicalState.AWAITING_ACCEPTANCE);
    assert.equal(
      state.vehicle.physical.custodianStoreId,
      lojaA.id,
      'continua com quem levou ate o aceite',
    );
    assert.deepEqual(state.transfer.dropOff?.geolocation, NO_PATIO);
  });

  test('sem coordenada nao ha registro', () => {
    const opened = openAtoB(vehicleAtA());
    const result = declareDropOff({
      vehicle: opened.vehicle,
      transfer: opened.transfer,
      actorStoreId: lojaA.id,
      actorUserId: gerenteA.id,
      destination: lojaB,
      geolocation: { lat: Number.NaN, lng: -49.3 },
      now: T0 + HOUR,
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'DROP_OFF_GEOLOCATION_REQUIRED');
  });

  test('coordenada longe do patio de destino e recusada na hora', () => {
    // Antes disto a coordenada era guardada e nunca lida: provava *uma*
    // posicao, nao *a* posicao. Recusar aqui impede o erro em vez de puni-lo
    // depois — e devolve a distancia para quem esta com o celular na mao.
    const opened = openAtoB(vehicleAtA());
    const result = declareDropOff({
      vehicle: opened.vehicle,
      transfer: opened.transfer,
      actorStoreId: lojaA.id,
      actorUserId: gerenteA.id,
      destination: lojaB,
      geolocation: lojaC.profile.yard,
      now: T0 + HOUR,
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'DROP_OFF_AWAY_FROM_YARD');
    const distancia = result.ok === false ? (result.error.details?.['distanceMeters'] as number) : 0;
    assert.ok(distancia > 500, 'o erro diz a distancia, para o operador resolver sem suporte');
  });

  test('erro de GPS dentro do raio ainda passa', () => {
    // 300 m: erro comum de celular em rua de centro. Um raio apertado
    // transformaria falha de sinal em acusacao de declaracao falsa.
    const opened = openAtoB(vehicleAtA());
    const result = declareDropOff({
      vehicle: opened.vehicle,
      transfer: opened.transfer,
      actorStoreId: lojaA.id,
      actorUserId: gerenteA.id,
      destination: lojaB,
      geolocation: pointNorthOf(lojaB.profile.yard, 300),
      now: T0 + HOUR,
    });

    assert.equal(result.ok, true);
  });

  test('quem declara e quem levou, nao quem recebe', () => {
    const opened = openAtoB(vehicleAtA());
    const result = declareDropOff({
      vehicle: opened.vehicle,
      transfer: opened.transfer,
      actorStoreId: lojaB.id,
      actorUserId: gerenteA.id,
      destination: lojaB,
      geolocation: NO_PATIO,
      now: T0 + HOUR,
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'DROP_OFF_MUST_BE_DECLARED_BY_CARRIER');
  });

  test('o aceite depois da entrega fecha o termo e move a custodia', () => {
    const entregueState = entregue();
    const aceiteAt = T0 + 14 * HOUR;

    const { state } = unwrap(
      checkIn({
        vehicle: entregueState.vehicle,
        transfer: entregueState.transfer,
        checkin: buildSignedTerm(lojaB.id, aceiteAt, { odometerKm: 38_430 }),
        now: aceiteAt,
      }),
    );

    assert.equal(state.transfer.status, TransferStatus.COMPLETED);
    assert.equal(state.vehicle.physical.custodianStoreId, lojaB.id);
    assert.equal(state.vehicle.physical.state, PhysicalState.AT_YARD);
    assert.notEqual(state.transfer.dropOff, null, 'a declaracao fica no historico');
  });

  test('o recebedor pode recusar: o carro volta para quem levou', () => {
    // Abriu o portao, viu que nao e o carro combinado. A declaracao
    // geolocalizada fica — e e ela que sustenta a conversa sobre o guincho.
    const entregueState = entregue();
    const { state } = unwrap(
      cancelTransfer({
        vehicle: entregueState.vehicle,
        transfer: entregueState.transfer,
        actorStoreId: lojaB.id,
        reason: 'Veiculo chegou com avaria nao declarada.',
        now: T0 + 3 * HOUR,
      }),
    );

    assert.equal(state.transfer.status, TransferStatus.CANCELLED);
    assert.equal(state.vehicle.physical.custodianStoreId, lojaA.id);
    assert.notEqual(state.transfer.dropOff, null);
  });

  test('nao se declara entrega duas vezes', () => {
    const entregueState = entregue();
    const result = declareDropOff({
      vehicle: entregueState.vehicle,
      transfer: entregueState.transfer,
      actorStoreId: lojaA.id,
      actorUserId: gerenteA.id,
      destination: lojaB,
      geolocation: NO_PATIO,
      now: T0 + 4 * HOUR,
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'TRANSFER_NOT_IN_TRANSIT');
  });
});

describe('entrada no patio (checkin)', () => {
  test('transfere a responsabilidade civil no instante da assinatura', () => {
    const opened = openAtoB(vehicleAtA());
    const checkinAt = T0 + 3 * HOUR;
    const { state } = unwrap(
      checkIn({
        vehicle: opened.vehicle,
        transfer: opened.transfer,
        checkin: buildSignedTerm(lojaB.id, checkinAt, { odometerKm: 38_430 }),
        now: checkinAt,
      }),
    );

    assert.equal(state.vehicle.physical.custodianStoreId, lojaB.id);
    assert.equal(state.vehicle.physical.state, PhysicalState.AT_YARD);
    assert.equal(state.vehicle.physical.since, checkinAt);
    assert.equal(state.transfer.status, TransferStatus.COMPLETED);
    assert.equal(state.vehicle.specs.mileageKm, 38_430, 'o odometro do anuncio acompanha a vistoria');
  });

  test('quem assina a entrada e a loja de destino', () => {
    const opened = openAtoB(vehicleAtA());
    const result = checkIn({
      vehicle: opened.vehicle,
      transfer: opened.transfer,
      checkin: buildSignedTerm(lojaC.id, T0 + HOUR),
      now: T0 + HOUR,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'CHECKIN_MUST_BE_SIGNED_BY_DESTINATION');
  });

  test('entrada nao pode ser anterior a saida', () => {
    const opened = openAtoB(vehicleAtA());
    const result = checkIn({
      vehicle: opened.vehicle,
      transfer: opened.transfer,
      checkin: buildSignedTerm(lojaB.id, T0 - HOUR),
      now: T0 + HOUR,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'CHECKIN_BEFORE_CHECKOUT');
  });

  test('fechar duas vezes o mesmo termo e bloqueado', () => {
    const opened = openAtoB(vehicleAtA());
    const closed = unwrap(
      checkIn({
        vehicle: opened.vehicle,
        transfer: opened.transfer,
        checkin: buildSignedTerm(lojaB.id, T0 + HOUR),
        now: T0 + HOUR,
      }),
    ).state;
    const again = checkIn({
      vehicle: closed.vehicle,
      transfer: closed.transfer,
      checkin: buildSignedTerm(lojaB.id, T0 + 2 * HOUR),
      now: T0 + 2 * HOUR,
    });
    assert.equal(again.ok, false);
    assert.equal(again.ok === false && again.error.code, 'TRANSFER_NOT_OPEN');
  });
});

describe('divergencias entre saida e entrada', () => {
  test('rodagem dentro da tolerancia nao vira divergencia', () => {
    const checkout = buildSignedTerm(lojaA.id, T0, { odometerKm: 38_400, fuelEighths: 4 });
    const checkin = buildSignedTerm(lojaB.id, T0 + HOUR, { odometerKm: 38_460, fuelEighths: 4 });
    assert.deepEqual(detectDiscrepancies(checkout, checkin), []);
  });

  test('rodagem excessiva e apontada com os numeros', () => {
    const checkout = buildSignedTerm(lojaA.id, T0, { odometerKm: 38_400 });
    const checkin = buildSignedTerm(lojaB.id, T0 + DAY, { odometerKm: 39_100 });
    const [first] = detectDiscrepancies(checkout, checkin);

    assert.equal(first?.kind, 'ODOMETER');
    assert.equal(first?.details['drivenKm'], 700);
  });

  test('odometro que anda para tras e sinalizado', () => {
    const checkout = buildSignedTerm(lojaA.id, T0, { odometerKm: 38_400 });
    const checkin = buildSignedTerm(lojaB.id, T0 + DAY, { odometerKm: 30_000 });
    const [first] = detectDiscrepancies(checkout, checkin);
    assert.equal(first?.kind, 'ODOMETER');
    assert.match(first?.description ?? '', /menor que na saida/);
  });

  test('combustivel consumido alem da folga aparece', () => {
    const checkout = buildSignedTerm(lojaA.id, T0, { fuelEighths: 7 });
    const checkin = buildSignedTerm(lojaB.id, T0 + DAY, { fuelEighths: 2 });
    const kinds = detectDiscrepancies(checkout, checkin).map((d) => d.kind);
    assert.ok(kinds.includes('FUEL'));
  });

  test('avaria nova e a que nao constava na saida', () => {
    const preexistente = {
      area: 'Para-choque dianteiro',
      severity: DamageSeverity.LIGHT,
      description: 'Risco superficial na pintura',
      photoUrls: [],
    };
    const nova = {
      area: 'Porta traseira esquerda',
      severity: DamageSeverity.MODERATE,
      description: 'Amassado com tinta lascada',
      photoUrls: [],
    };

    const checkout = buildSignedTerm(lojaA.id, T0, { damages: [preexistente] });
    const checkin = buildSignedTerm(lojaB.id, T0 + DAY, { damages: [preexistente, nova] });
    const found = detectDiscrepancies(checkout, checkin);

    assert.equal(found.length, 1, 'a avaria que ja existia nao e cobrada de novo');
    assert.equal(found[0]?.kind, 'NEW_DAMAGE');
    assert.equal(found[0]?.details['area'], 'Porta traseira esquerda');
  });

  test('a comparacao de area ignora acento e caixa', () => {
    const saida = { area: 'Para-choque Dianteiro', severity: DamageSeverity.LIGHT, description: 'Risco', photoUrls: [] };
    const entrada = { area: 'para-choque dianteiro', severity: DamageSeverity.LIGHT, description: 'Risco', photoUrls: [] };
    const checkout = buildSignedTerm(lojaA.id, T0, { damages: [saida] });
    const checkin = buildSignedTerm(lojaB.id, T0 + DAY, { damages: [entrada] });
    assert.deepEqual(detectDiscrepancies(checkout, checkin), []);
  });

  test('divergencias ficam no termo e geram evento proprio', () => {
    const opened = openAtoB(vehicleAtA(), buildSignedTerm(lojaA.id, T0, { odometerKm: 38_400, fuelEighths: 8 }));
    const { state, events } = unwrap(
      checkIn({
        vehicle: opened.vehicle,
        transfer: opened.transfer,
        checkin: buildSignedTerm(lojaB.id, T0 + DAY, { odometerKm: 39_500, fuelEighths: 2 }),
        now: T0 + DAY,
      }),
    );

    assert.equal(state.transfer.discrepancies.length, 2);
    assert.ok(events.some((e) => e.type === 'custody.discrepancies_found'));
  });
});

describe('cancelamento e entrega final', () => {
  test('termo cancelado devolve o carro a origem sem mover responsabilidade', () => {
    const opened = openAtoB(vehicleAtA());
    const { state } = unwrap(
      cancelTransfer({
        vehicle: opened.vehicle,
        transfer: opened.transfer,
        actorStoreId: lojaA.id,
        reason: 'Guincho nao compareceu',
        now: T0 + 2 * HOUR,
      }),
    );

    assert.equal(state.transfer.status, TransferStatus.CANCELLED);
    assert.equal(state.vehicle.physical.state, PhysicalState.AT_YARD);
    assert.equal(state.vehicle.physical.custodianStoreId, lojaA.id);
  });

  test('quem nao e parte na movimentacao nao cancela', () => {
    const opened = openAtoB(vehicleAtA());
    const result = cancelTransfer({
      vehicle: opened.vehicle,
      transfer: opened.transfer,
      actorStoreId: lojaC.id,
      reason: 'palpite',
      now: T0 + HOUR,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'NOT_A_TRANSFER_PARTY');
  });

  test('entrega ao consumidor exige venda confirmada', () => {
    const result = deliverToConsumer({
      vehicle: vehicleAtA(),
      actorStoreId: lojaA.id,
      finalTerm: buildSignedTerm(lojaA.id, T0),
      now: T0,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'VEHICLE_NOT_SOLD');
  });

  test('entrega encerra o eixo fisico', () => {
    const vendido = atYardOf(vehicleAtA({ commercialStatus: CommercialStatus.SOLD }), lojaB.id);
    const { state } = unwrap(
      deliverToConsumer({
        vehicle: vendido,
        actorStoreId: lojaB.id,
        finalTerm: buildSignedTerm(lojaB.id, T0 + DAY),
        now: T0 + DAY,
      }),
    );
    assert.equal(state.physical.state, PhysicalState.DELIVERED_TO_CONSUMER);
  });

  test('so quem esta com o carro entrega', () => {
    const vendido = atYardOf(vehicleAtA({ commercialStatus: CommercialStatus.SOLD }), lojaB.id);
    const result = deliverToConsumer({
      vehicle: vendido,
      actorStoreId: lojaA.id,
      finalTerm: buildSignedTerm(lojaA.id, T0 + DAY),
      now: T0 + DAY,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'NOT_CURRENT_CUSTODIAN');
  });
});
