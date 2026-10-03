import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { previewNotification, NotificationSeverity } from './notifications.ts';
import { domainEvent } from '../domain/shared/events.ts';
import { buildApplication, type Application } from '../bootstrap.ts';
import { loadConfig } from '../config.ts';
import { FakeClock, HOUR } from '../domain/shared/clock.ts';
import { sequentialIdGenerator } from '../domain/shared/ids.ts';
import { seededActor } from '../infra/seed.ts';
import { fromReais } from '../domain/shared/money.ts';
import {
  FuelType,
  InspectionStatus,
  TradeInStance,
  TransmissionType,
  VehicleAngle,
} from '../domain/vehicle/vehicle.ts';
import { openCommercialLock, registerVehicle } from './inventory-service.ts';
import { requestVehicleRecall } from './custody-service.ts';
import { runSweep } from './scheduler.ts';
import {
  startCustodyTransfer,
  completeCustodyTransfer,
  declareVehicleDropOff,
} from './custody-service.ts';
import { publishMaterial } from './material-service.ts';
import { syncStoreFeed } from './feed-service.ts';
import { endorseApplication, submitApplication } from './governance-service.ts';
import { revendaMaisFeed } from '../testing/fixtures/feeds.ts';
import { sealTerm, PhotoAngle, TransferPurpose } from '../domain/custody/custody.ts';
import { RecallReason } from '../domain/recall/recall.ts';
import { unwrap } from '../domain/shared/result.ts';
import type { Actor } from './context.ts';

const T0 = Date.parse('2026-08-24T13:00:00Z');

describe('mapa de eventos para avisos', () => {
  test('a liberacao de um carro em estoque avancado destaca a oportunidade', () => {
    const noPatioDeTerceiro = previewNotification(
      domainEvent('vehicle.available_again', 'veh_1', T0, { onExtendedCustody: true }),
    );
    assert.match(noPatioDeTerceiro?.body ?? '', /pátio de uma loja parceira/);

    const noPatioDaDona = previewNotification(
      domainEvent('vehicle.available_again', 'veh_1', T0, { onExtendedCustody: false }),
    );
    assert.equal(noPatioDaDona?.body.includes('parceira'), false);
  });

  test('recall represado por trava explica que a exclusividade continua valendo', () => {
    const represado = previewNotification(
      domainEvent('recall.requested', 'veh_1', T0, {
        custodianStoreId: 'str_b',
        blockedByLockId: 'lck_1',
      }),
    );
    assert.equal(represado?.severity, NotificationSeverity.ACTION_REQUIRED);
    assert.match(represado?.body ?? '', /trava comercial segue valendo/);
    assert.deepEqual(represado?.to, ['str_b'], 'quem precisa agir e a loja custodiante');
  });

  test('SLA estourado alerta os dois lados', () => {
    const aviso = previewNotification(
      domainEvent('recall.sla_breached', 'veh_1', T0, {
        custodianStoreId: 'str_b',
        requestedByStoreId: 'str_a',
      }),
    );
    assert.equal(aviso?.severity, NotificationSeverity.ALERT);
    assert.deepEqual(aviso?.to, ['str_b', 'str_a']);
  });

  test('candidatura vai so para as fundadoras, menos a padrinho', () => {
    const aviso = previewNotification(
      domainEvent('membership.application_opened', 'app_1', T0, {
        clusterId: 'clu_test',
        candidateTradeName: 'Nova Garagem',
        sponsorStoreId: 'str_a',
      }),
    );
    assert.equal(aviso?.broadcast?.foundersOnly, true);
    assert.equal(aviso?.broadcast?.clusterId, 'clu_test', 'broadcast sem praca nao entrega a ninguem');
    assert.deepEqual(aviso?.except, ['str_a'], 'quem apresentou nao precisa ser avisado');
  });

  test('carro novo no feed vai a praca, menos a propria loja que publicou', () => {
    const aviso = previewNotification(
      domainEvent('feed.vehicle_created', 'veh_1', T0, {
        clusterId: 'clu_test',
        storeId: 'str_a',
        plate: 'ABC1D23',
        commercialStatus: 'AVAILABLE',
      }),
    );
    assert.equal(aviso?.broadcast?.clusterId, 'clu_test', 'sem destino o aviso nao chega a ninguem');
    assert.deepEqual(aviso?.except, ['str_a']);
  });

  test('carro em rascunho nao e anunciado: ele nao esta no estoque compartilhado', () => {
    const aviso = previewNotification(
      domainEvent('feed.vehicle_created', 'veh_1', T0, {
        clusterId: 'clu_test',
        storeId: 'str_a',
        plate: 'ABC1D23',
        commercialStatus: 'DRAFT',
      }),
    );
    assert.equal(aviso, null);
  });

  test('sumico do feed so notifica quando exige decisao humana', () => {
    const comTerceiro = previewNotification(
      domainEvent('feed.vehicle_missing', 'veh_1', T0, {
        action: 'FLAGGED_ON_EXTENDED_CUSTODY',
        storeId: 'str_a',
        custodianStoreId: 'str_b',
      }),
    );
    assert.equal(comTerceiro?.severity, NotificationSeverity.ACTION_REQUIRED);

    const retiradoSozinho = previewNotification(
      domainEvent('feed.vehicle_missing', 'veh_1', T0, { action: 'WITHDRAWN', storeId: 'str_a' }),
    );
    assert.equal(retiradoSozinho, null, 'retirada rotineira nao vira ruido');
  });

  test('material novo avisa a rede, menos a loja que publicou', () => {
    const aviso = previewNotification(
      domainEvent('vehicle.neutral_photos_published', 'veh_1', T0, {
        clusterId: 'clu_test',
        ownerStoreId: 'str_a',
        photoCount: 4,
      }),
    );
    assert.equal(aviso?.severity, NotificationSeverity.INFO);
    assert.equal(aviso?.broadcast?.clusterId, 'clu_test', 'sem destino o aviso nao chega a ninguem');
    assert.deepEqual(aviso?.except, ['str_a']);
  });

  test('eventos sem interesse operacional nao notificam', () => {
    for (const type of ['lock.opened', 'lock.extended', 'vehicle.net_price_changed', 'deal.opened']) {
      assert.equal(previewNotification(domainEvent(type, 'veh_1', T0, {})), null, type);
    }
  });
});

describe('entrega das notificacoes', () => {
  async function cenario(): Promise<{ app: Application; clock: FakeClock; lojaA: Actor; lojaB: Actor; lojaC: Actor }> {
    const clock = new FakeClock(T0);
    const app = await buildApplication({
      config: { ...loadConfig({}), seedDemoData: true, port: 0 },
      clock,
      ids: sequentialIdGenerator(),
      seedVehicles: false,
    });
    const seed = app.seed!;
    return {
      app,
      clock,
      lojaA: seededActor(seed.stores[0]!),
      lojaB: seededActor(seed.stores[1]!),
      lojaC: seededActor(seed.stores[2]!),
    };
  }

  const termo = (actor: Actor, at: number, km: number) =>
    unwrap(
      sealTerm(
        {
          odometerKm: km,
          fuelEighths: 5,
          photos: [PhotoAngle.FRONT, PhotoAngle.REAR, PhotoAngle.LEFT, PhotoAngle.RIGHT, PhotoAngle.ODOMETER].map(
            (angle) => ({ angle, url: `https://cdn.exemplo.com/${angle}.jpg` }),
          ),
          damages: [],
        },
        {
          name: actor.user.name,
          document: '529.982.247-25',
          role: 'Gerente',
          userId: actor.user.id,
          storeId: actor.store.id,
        },
        at,
      ),
    );

  test('a rede inteira e avisada quando a trava expira e o carro volta', async () => {
    const { app, clock, lojaA, lojaB, lojaC } = await cenario();
    const veiculo = unwrap(
      await registerVehicle(app.context, lojaA, {
        plate: 'RGT4B71',
        chassis: '9BWZZZ377VT004251',
        specs: {
          brand: 'Chevrolet', model: 'Onix', version: '1.0 LTZ',
          manufactureYear: 2022, modelYear: 2023, mileageKm: 38_400, color: 'Prata',
          fuel: FuelType.FLEX, transmission: TransmissionType.AUTOMATIC,
          doors: 4, optionals: [], photos: [],
        },
        inspection: {
          status: InspectionStatus.APPROVED,
          reportNumber: 'LC-1', provider: 'Cautelar Brasil',
          issuedAt: T0, expiresAt: T0 + 90 * 24 * HOUR, fileUrl: null,
        },
        publicPrice: fromReais(92_900),
        netPrice: fromReais(85_000),
        tradeInStance: TradeInStance.CONSIDERS,
      }),
    );

    await openCommercialLock(app.context, lojaB, { vehicleId: veiculo.id });
    clock.advance(5 * HOUR);
    await runSweep(app.context);

    for (const [nome, loja] of [['A', lojaA], ['B', lojaB], ['C', lojaC]] as const) {
      const avisos = await app.context.repos.notifications.forStore({ storeId: loja.store.id });
      assert.ok(
        avisos.some((aviso) => aviso.eventType === 'vehicle.available_again'),
        `a loja ${nome} deveria ter sido avisada`,
      );
    }
    await app.stop();
  });

  test('o recall notifica so quem precisa agir, e marcar como lido e idempotente', async () => {
    const { app, clock, lojaA, lojaB, lojaC } = await cenario();
    const veiculo = unwrap(
      await registerVehicle(app.context, lojaA, {
        plate: 'RGT4B71',
        chassis: '9BWZZZ377VT004251',
        specs: {
          brand: 'Chevrolet', model: 'Onix', version: '1.0 LTZ',
          manufactureYear: 2022, modelYear: 2023, mileageKm: 38_400, color: 'Prata',
          fuel: FuelType.FLEX, transmission: TransmissionType.AUTOMATIC,
          doors: 4, optionals: [], photos: [],
        },
        inspection: {
          status: InspectionStatus.APPROVED,
          reportNumber: 'LC-1', provider: 'Cautelar Brasil',
          issuedAt: T0, expiresAt: T0 + 90 * 24 * HOUR, fileUrl: null,
        },
        publicPrice: fromReais(92_900),
        netPrice: fromReais(85_000),
        tradeInStance: TradeInStance.CONSIDERS,
      }),
    );

    const saida = unwrap(
      await startCustodyTransfer(app.context, lojaA, {
        vehicleId: veiculo.id,
        toStoreId: lojaB.store.id,
        purpose: TransferPurpose.EXTENDED_STOCK,
        checkout: termo(lojaA, clock.now(), 38_400),
      }),
    );
    clock.advance(HOUR);
    await completeCustodyTransfer(app.context, lojaB, saida.transfer.id, termo(lojaB, clock.now(), 38_420));

    await requestVehicleRecall(app.context, lojaA, {
      vehicleId: veiculo.id,
      reason: RecallReason.OWN_SALE,
    });

    const daB = await app.context.repos.notifications.forStore({ storeId: lojaB.store.id, unreadOnly: true });
    const recallParaB = daB.find((aviso) => aviso.eventType === 'recall.requested');
    assert.ok(recallParaB, 'a loja custodiante precisa ser avisada');

    const daC = await app.context.repos.notifications.forStore({ storeId: lojaC.store.id });
    assert.equal(
      daC.some((aviso) => aviso.eventType === 'recall.requested'),
      false,
      'quem nao esta envolvido nao recebe',
    );

    const antes = await app.context.repos.notifications.unreadCount(lojaB.store.id);
    const lido = await app.context.repos.notifications.markRead(recallParaB.id, lojaB.store.id, clock.now());
    assert.equal(lido?.readAt, clock.now());
    assert.equal(await app.context.repos.notifications.unreadCount(lojaB.store.id), antes - 1);

    clock.advance(HOUR);
    const relido = await app.context.repos.notifications.markRead(recallParaB.id, lojaB.store.id, clock.now());
    assert.equal(relido?.readAt, lido?.readAt, 'reler nao muda o instante da primeira leitura');
    await app.stop();
  });

  /*
   * Os quatro testes abaixo conferem a ENTREGA, nao o rascunho. Os testes de
   * `previewNotification` passavam com tres destes avisos chegando a ninguem:
   * conferiam `except`, e nao havia nem `to` nem `broadcast` para onde entregar.
   */
  const avisosDe = async (app: Application, loja: Actor, tipo: string) =>
    (await app.context.repos.notifications.forStore({ storeId: loja.store.id })).filter(
      (aviso) => aviso.eventType === tipo,
    );

  const carroAprovado = (app: Application, loja: Actor) =>
    registerVehicle(app.context, loja, {
      plate: 'RGT4B71',
      chassis: '9BWZZZ377VT004251',
      specs: {
        brand: 'Chevrolet', model: 'Onix', version: '1.0 LTZ',
        manufactureYear: 2022, modelYear: 2023, mileageKm: 38_400, color: 'Prata',
        fuel: FuelType.FLEX, transmission: TransmissionType.AUTOMATIC,
        doors: 4, optionals: [], photos: [],
      },
      inspection: {
        status: InspectionStatus.APPROVED,
        reportNumber: 'LC-1', provider: 'Cautelar Brasil',
        issuedAt: T0, expiresAt: T0 + 90 * 24 * HOUR, fileUrl: null,
      },
      publicPrice: fromReais(92_900),
      netPrice: fromReais(85_000),
      tradeInStance: TradeInStance.CONSIDERS,
    });

  test('material novo chega a rede, menos a loja que publicou', async () => {
    const { app, lojaA, lojaB, lojaC } = await cenario();
    const veiculo = unwrap(await carroAprovado(app, lojaA));

    unwrap(
      await publishMaterial(app.context, lojaA, {
        vehicleId: veiculo.id,
        photos: [VehicleAngle.FRONT, VehicleAngle.REAR, VehicleAngle.INTERIOR].map((angle) => ({
          angle,
          url: `https://cdn.exemplo.com/neutra-${angle}.jpg`,
        })),
      }),
    );

    assert.equal((await avisosDe(app, lojaB, 'vehicle.neutral_photos_published')).length, 1);
    assert.equal((await avisosDe(app, lojaC, 'vehicle.neutral_photos_published')).length, 1);
    assert.equal(
      (await avisosDe(app, lojaA, 'vehicle.neutral_photos_published')).length,
      0,
      'quem publicou nao precisa ser avisado',
    );
    await app.stop();
  });

  test('carro novo publicado pelo feed chega a rede; rascunho sem laudo nao', async () => {
    // O texto diz "publicou um veiculo novo no estoque compartilhado". Carro
    // sem laudo aprovado nasce em rascunho e NAO esta no estoque compartilhado:
    // anuncia-lo levaria a parceira a procurar no catalogo um carro que nao esta la.
    const { app, lojaA, lojaB } = await cenario();
    unwrap(
      await syncStoreFeed(app.context, lojaA, {
        xml: revendaMaisFeed([
          { id: 'RM-1', placa: 'ABC1D23', chassi: '9BWZZZ377VT004251' },
          { id: 'RM-2', placa: 'KLM8D42', chassi: '9BWZZZ377VT004252', laudo: 'REPROVADO' },
        ]),
      }),
    );

    const daB = await avisosDe(app, lojaB, 'feed.vehicle_created');
    assert.equal(daB.length, 1, 'so o carro que entrou no catalogo e anunciado');
    assert.match(daB[0]?.body ?? '', /ABC1D23/);
    assert.equal((await avisosDe(app, lojaA, 'feed.vehicle_created')).length, 0);
    await app.stop();
  });

  test('loja credenciada e anunciada a rede, pelo nome fantasia', async () => {
    const { app, lojaA, lojaB } = await cenario();
    const candidatura = unwrap(
      await submitApplication(app.context, lojaA, {
        legalName: 'Nova Garagem Veiculos LTDA',
        tradeName: 'Nova Garagem',
        cnpj: '07.526.557/0001-00',
        city: 'Curitiba',
        state: 'PR',
        phone: '(41) 99876-5432',
        email: 'contato@novagaragem.com.br',
        responsibleName: 'Joao Pereira',
        yard: { lat: -25.5307, lng: -49.2064 },
      }),
    );
    for (const indice of [1, 2, 3]) {
      unwrap(
        await endorseApplication(
          app.context,
          seededActor(app.seed!.stores[indice]!),
          candidatura.application.id,
        ),
      );
    }

    const daB = await avisosDe(app, lojaB, 'network.member_admitted');
    assert.equal(daB.length, 1);
    assert.match(daB[0]?.body ?? '', /^Nova Garagem foi credenciada/);
    await app.stop();
  });

  test('entrega declarada avisa quem precisa dar o aceite — e so ela', async () => {
    // Sem o aceite no prazo a entrega vira quebra de protocolo de quem recebe.
    // Cobrar um prazo de quem nunca foi avisado dele e a punicao que o protocolo
    // existe para nao aplicar.
    const { app, clock, lojaA, lojaB, lojaC } = await cenario();
    const veiculo = unwrap(await carroAprovado(app, lojaA));
    const saida = unwrap(
      await startCustodyTransfer(app.context, lojaA, {
        vehicleId: veiculo.id,
        toStoreId: lojaB.store.id,
        purpose: TransferPurpose.EXTENDED_STOCK,
        checkout: termo(lojaA, clock.now(), 38_400),
      }),
    );
    clock.advance(HOUR);
    unwrap(
      await declareVehicleDropOff(app.context, lojaA, saida.transfer.id, lojaB.store.profile.yard),
    );

    const daB = await avisosDe(app, lojaB, 'custody.dropped_off');
    assert.equal(daB.length, 1);
    assert.equal(daB[0]?.severity, NotificationSeverity.ACTION_REQUIRED);
    assert.equal((await avisosDe(app, lojaC, 'custody.dropped_off')).length, 0);
    assert.equal(
      (await avisosDe(app, lojaA, 'custody.dropped_off')).length,
      0,
      'quem declarou sabe que declarou',
    );
    await app.stop();
  });

  test('uma loja nao le a caixa de outra', async () => {
    const { app, lojaB } = await cenario();
    const inexistente = await app.context.repos.notifications.markRead('aud_9999', lojaB.store.id, T0);
    assert.equal(inexistente, undefined);
    await app.stop();
  });
});
