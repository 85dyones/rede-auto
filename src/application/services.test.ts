import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildApplication, type Application } from '../bootstrap.ts';
import { loadConfig } from '../config.ts';
import { FakeClock, HOUR } from '../domain/shared/clock.ts';
import { sequentialIdGenerator } from '../domain/shared/ids.ts';
import { fromReais } from '../domain/shared/money.ts';
import { FuelType, TransmissionType } from '../domain/vehicle/vehicle.ts';
import { asClusterId, asStoreId, asUserId } from '../domain/shared/ids.ts';
import { PhotoAngle, sealTerm, TransferPurpose } from '../domain/custody/custody.ts';
import type { Actor } from './context.ts';
import { loadVehicle, openCommercialLock, registerVehicle, searchCatalog } from './inventory-service.ts';
import { startCustodyTransfer } from './custody-service.ts';
import { runSweep, startSweeper } from './scheduler.ts';

/** Termo com as cinco fotos obrigatorias — o minimo que a custodia exige. */
function termoDeVistoria(actor: Actor, odometro: number) {
  const termo = sealTerm(
    {
      odometerKm: odometro,
      fuelEighths: 6,
      photos: [
        PhotoAngle.FRONT,
        PhotoAngle.REAR,
        PhotoAngle.LEFT,
        PhotoAngle.RIGHT,
        PhotoAngle.ODOMETER,
      ].map((angle) => ({ angle, url: `https://cdn.exemplo.com/${angle.toLowerCase()}.jpg` })),
      damages: [],
    },
    {
      name: actor.user.name,
      document: '529.982.247-25',
      role: 'Gerente de patio',
      userId: actor.user.id,
      storeId: actor.store.id,
    },
    T0,
  );
  assert.ok(termo.ok);
  return termo.value;
}

/**
 * Testes dos casos de uso que a API nao exercita por completo: deduplicacao no
 * cadastro manual e o comportamento do varredor periodico.
 */

const T0 = Date.parse('2026-08-24T13:00:00Z');

async function novaApp(): Promise<{ app: Application; clock: FakeClock; lojaA: Actor; lojaB: Actor }> {
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
    lojaA: { store: seed.stores[0]!.store, user: seed.stores[0]!.principal },
    lojaB: { store: seed.stores[1]!.store, user: seed.stores[1]!.principal },
  };
}

const ficha = {
  brand: 'Chevrolet',
  model: 'Onix',
  version: '1.0 Turbo LTZ',
  manufactureYear: 2022,
  modelYear: 2023,
  mileageKm: 38_400,
  color: 'Prata',
  fuel: FuelType.FLEX,
  transmission: TransmissionType.AUTOMATIC,
  doors: 4,
  optionals: [],
  photos: [],
};

const cadastro = (plate: string, chassis: string) => ({
  plate,
  chassis,
  specs: ficha,
  publicPrice: fromReais(92_900),
  netPrice: fromReais(85_000),
});

describe('deduplicacao no cadastro manual', () => {
  test('a mesma loja nao cadastra o mesmo chassi duas vezes', async () => {
    const { app, lojaA } = await novaApp();
    const primeiro = await registerVehicle(app.context, lojaA, cadastro('RGT4B71', '9BWZZZ377VT004251'));
    assert.equal(primeiro.ok, true);

    const segundo = await registerVehicle(app.context, lojaA, cadastro('XYZ9K88', '9BWZZZ377VT004251'));
    assert.equal(segundo.ok, false);
    assert.equal(segundo.ok === false && segundo.error.code, 'DUPLICATE_VIN_IN_NETWORK');
    await app.stop();
  });

  test('outra loja da rede tambem e bloqueada — e a venda duplicada que o produto evita', async () => {
    const { app, lojaA, lojaB } = await novaApp();
    await registerVehicle(app.context, lojaA, cadastro('RGT4B71', '9BWZZZ377VT004251'));

    const daOutra = await registerVehicle(app.context, lojaB, cadastro('KLM8D42', '9BWZZZ377VT004251'));
    assert.equal(daOutra.ok, false);
    assert.match(
      daOutra.ok === false ? daOutra.error.message : '',
      /outra loja/,
      'a mensagem diz que o conflito e com outra loja, nao com o proprio estoque',
    );
    await app.stop();
  });

  test('sem laudo aprovado o veiculo nasce fora do catalogo da rede', async () => {
    const { app, lojaA } = await novaApp();
    const criado = await registerVehicle(app.context, lojaA, cadastro('RGT4B71', '9BWZZZ377VT004251'));
    assert.equal(criado.ok && criado.value.commercialStatus, 'DRAFT');
    await app.stop();
  });
});

describe('varredor periodico', () => {
  test('materializa a trava vencida e e idempotente na rodada seguinte', async () => {
    const { app, clock, lojaA, lojaB } = await novaApp();
    const veiculo = await registerVehicle(app.context, lojaA, {
      ...cadastro('RGT4B71', '9BWZZZ377VT004251'),
      inspection: {
        status: 'APPROVED',
        reportNumber: 'LC-1',
        provider: 'Cautelar Brasil',
        issuedAt: T0,
        expiresAt: T0 + 90 * 24 * HOUR,
        fileUrl: null,
      },
    });
    assert.equal(veiculo.ok, true);
    if (!veiculo.ok) return;

    await openCommercialLock(app.context, lojaB, { vehicleId: veiculo.value.id });

    const antes = await runSweep(app.context);
    assert.equal(antes.expiredLocks, 0, 'antes do vencimento nao ha nada a fazer');

    clock.advance(5 * HOUR);
    assert.equal((await runSweep(app.context)).expiredLocks, 1);
    assert.equal(
      (await runSweep(app.context)).expiredLocks,
      0,
      'a segunda passada nao pode expirar a mesma trava de novo',
    );
    await app.stop();
  });

  test('o varredor agendado roda sozinho e para quando pedido', async () => {
    const { app, clock, lojaA, lojaB } = await novaApp();
    const veiculo = await registerVehicle(app.context, lojaA, {
      ...cadastro('RGT4B71', '9BWZZZ377VT004251'),
      inspection: {
        status: 'APPROVED',
        reportNumber: 'LC-1',
        provider: 'Cautelar Brasil',
        issuedAt: T0,
        expiresAt: T0 + 90 * 24 * HOUR,
        fileUrl: null,
      },
    });
    if (!veiculo.ok) return;

    await openCommercialLock(app.context, lojaB, { vehicleId: veiculo.value.id });
    clock.advance(5 * HOUR);

    const sweeper = startSweeper(app.context, 5);
    await new Promise((resolve) => setTimeout(resolve, 60));
    sweeper.stop();

    const depois = await app.context.repos.vehicles.byId(veiculo.value.id);
    assert.equal(depois?.commercialStatus, 'AVAILABLE', 'o varredor liberou o veiculo sem ninguem pedir');
    assert.equal(depois?.activeLockId, null);
    await app.stop();
  });

  test('uma varredura que falha nao derruba o agendador', async () => {
    const { app } = await novaApp();
    const erros: unknown[] = [];

    // Repositorio quebrado: o varredor tem que absorver e continuar.
    const quebrado = {
      ...app.context,
      repos: {
        ...app.context.repos,
        locks: {
          ...app.context.repos.locks,
          dueForExpiry: async () => {
            throw new Error('banco indisponivel');
          },
        },
      },
    };

    const sweeper = startSweeper(quebrado, 5, (error) => erros.push(error));
    await new Promise((resolve) => setTimeout(resolve, 40));
    sweeper.stop();

    assert.ok(erros.length > 0, 'o erro chega ao handler');
    assert.match(String(erros[0]), /banco indisponivel/);
    await app.stop();
  });
});

/**
 * A fronteira entre pracas.
 *
 * A rede e local: o modelo inteiro (levar o carro ao showroom da parceira,
 * devolver em 4 horas uteis) so fecha porque as lojas estao a minutos umas das
 * outras. Quando a segunda praca existir, o risco nao e de usabilidade — e de
 * vazamento: preco liquido de concorrente de outra cidade, estoque que nunca
 * vai poder ser negociado, aviso de rede caindo na caixa errada.
 *
 * Estes testes existem para que a segunda praca custe uma linha de seed, e nao
 * uma auditoria de todas as consultas do sistema.
 */
describe('fronteira entre pracas', () => {
  /** Duas pracas com uma loja cada. A de Londrina nao e parceira: e estranha. */
  async function duasPracas() {
    const base = await novaApp();
    const curitiba = base.lojaA.store.clusterId;
    const londrina = asClusterId('clu_londrina');

    const forasteira: Actor = {
      store: { ...base.lojaB.store, id: asStoreId('str_forasteira'), clusterId: londrina },
      user: { ...base.lojaB.user, id: asUserId('usr_forasteira'), storeId: asStoreId('str_forasteira') },
    };
    await base.app.context.repos.stores.save(forasteira.store);
    await base.app.context.repos.users.save(forasteira.user);

    const carro = await registerVehicle(base.app.context, base.lojaA, {
      plate: 'RGT4B71',
      chassis: '9BWZZZ377VT004251',
      specs: ficha,
      publicPrice: fromReais(92_900),
      netPrice: fromReais(85_000),
    });
    assert.ok(carro.ok);

    return { ...base, curitiba, londrina, forasteira, carro: carro.value };
  }

  test('o carro nasce na praca da loja dona', async () => {
    const { app, lojaA, carro } = await duasPracas();
    assert.equal(carro.clusterId, lojaA.store.clusterId);
    await app.stop();
  });

  test('para a loja de outra praca o carro nao existe — 404, nao 403', async () => {
    const { app, forasteira, carro } = await duasPracas();

    const visto = await loadVehicle(app.context, forasteira, carro.id);
    assert.ok(!visto.ok);
    assert.equal(visto.error.kind, 'NOT_FOUND', 'distinguir "nao e seu" de "nao existe" ja entrega que existe');
    await app.stop();
  });

  test('a busca nao mistura estoque de pracas diferentes', async () => {
    const { app, lojaA, forasteira } = await duasPracas();

    const daCasa = await searchCatalog(app.context, lojaA, { limit: 50 });
    assert.equal(daCasa.total, 1, 'a loja da praca ve o proprio estoque');

    const deFora = await searchCatalog(app.context, forasteira, { limit: 50 });
    assert.equal(deFora.total, 0, 'a loja de Londrina nao ve o estoque de Curitiba');
    await app.stop();
  });

  test('nao se trava um carro de outra praca', async () => {
    const { app, forasteira, carro } = await duasPracas();

    const trava = await openCommercialLock(app.context, forasteira, { vehicleId: carro.id });
    assert.ok(!trava.ok);
    assert.equal(trava.error.kind, 'NOT_FOUND');
    await app.stop();
  });

  test('nao se pede custodia de um carro de outra praca', async () => {
    const { app, lojaA, forasteira, carro } = await duasPracas();

    const saida = await startCustodyTransfer(app.context, forasteira, {
      vehicleId: carro.id,
      toStoreId: forasteira.store.id,
      purpose: TransferPurpose.EXTENDED_STOCK,
      checkout: termoDeVistoria(lojaA, 38_400),
    });
    assert.ok(!saida.ok);
    assert.equal(saida.error.kind, 'NOT_FOUND');
    await app.stop();
  });

  test('fundadora de uma praca nao conta no quorum da outra', async () => {
    const { app, curitiba, londrina } = await duasPracas();

    const deCuritiba = await app.context.repos.stores.founders(curitiba);
    const deLondrina = await app.context.repos.stores.founders(londrina);

    assert.equal(deCuritiba.length, 6, 'as 6 fundadoras do piloto');
    assert.equal(deLondrina.length, 1, 'Londrina constitui o proprio quorum');

    const emCuritiba = new Set(deCuritiba.map((loja) => loja.id));
    for (const loja of deLondrina) {
      assert.ok(!emCuritiba.has(loja.id), 'nenhuma fundadora vota nas duas pracas');
    }
    await app.stop();
  });

  test('o aviso de rede fica dentro da praca que o gerou', async () => {
    const { app, clock, lojaA, forasteira, carro } = await duasPracas();

    await openCommercialLock(app.context, lojaA, { vehicleId: carro.id });
    clock.advance(5 * HOUR);
    await runSweep(app.context);

    const laFora = await app.context.repos.notifications.forStore({ storeId: forasteira.store.id });
    assert.equal(
      laFora.filter((aviso) => aviso.eventType === 'vehicle.available_again').length,
      0,
      'carro que voltou a rede em Curitiba nao interessa — e nao pode ser visto — em Londrina',
    );
    await app.stop();
  });
});
