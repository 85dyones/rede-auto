import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildApplication, type Application } from '../bootstrap.ts';
import { loadConfig } from '../config.ts';
import { FakeClock, HOUR } from '../domain/shared/clock.ts';
import { sequentialIdGenerator } from '../domain/shared/ids.ts';
import { fromReais } from '../domain/shared/money.ts';
import { FuelType, TransmissionType } from '../domain/vehicle/vehicle.ts';
import type { Actor } from './context.ts';
import { openCommercialLock, registerVehicle } from './inventory-service.ts';
import { runSweep, startSweeper } from './scheduler.ts';

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
