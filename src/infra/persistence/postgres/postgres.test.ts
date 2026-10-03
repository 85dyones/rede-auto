import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O que so existe com banco de verdade: transacao, corrida e constraint.
 *
 * As suites de servico e de API ja rodam inteiras contra o Postgres
 * (`npm run test:pg`); estas cobrem o que a memoria nunca exercitou, porque la
 * duas requisicoes nao se cruzam (decisao 23). Sem `TEST_DATABASE_URL`, pulam.
 */

import { buildTestApplication } from '../../../testing/application.ts';
import type { Application } from '../../../bootstrap.ts';
import { FakeClock } from '../../../domain/shared/clock.ts';
import { fromReais } from '../../../domain/shared/money.ts';
import { asLockId, sequentialIdGenerator } from '../../../domain/shared/ids.ts';
import { loadConfig } from '../../../config.ts';
import { seededActor } from '../../seed.ts';
import { openCommercialLock, updateVehiclePricing } from '../../../application/inventory-service.ts';
import {
  completeCustodyTransfer,
  requestVehicleRecall,
  startCustodyTransfer,
} from '../../../application/custody-service.ts';
import { PhotoAngle, sealTerm, TransferPurpose } from '../../../domain/custody/custody.ts';
import { RecallReason } from '../../../domain/recall/recall.ts';
import { unwrap } from '../../../domain/shared/result.ts';
import type { Actor } from '../../../application/context.ts';
import { LockStatus, type CommercialLock } from '../../../domain/lock/commercial-lock.ts';
import type { Repositories } from '../repositories.ts';
import { migrate } from './migrate.ts';
import { Database, databaseConfigFrom } from './database.ts';

const url = process.env['TEST_DATABASE_URL'];
const T0 = Date.parse('2026-08-24T13:00:00Z');

async function novaApp(): Promise<Application> {
  return buildTestApplication({
    config: { ...loadConfig({}), seedDemoData: true, port: 0 },
    clock: new FakeClock(T0),
    ids: sequentialIdGenerator(),
  });
}

/**
 * Segura a primeira tentativa de cada participante ate todos chegarem — o pior
 * caso: todos leram o estado antigo antes de qualquer um gravar. Tentativas
 * seguintes passam direto, senao a nova tentativa esperaria quem ja terminou.
 */
function barreira(participantes: number): () => Promise<void> {
  let chegaram = 0;
  let soltar: () => void = () => {};
  const aberta = new Promise<void>((resolve) => {
    soltar = resolve;
  });
  return async () => {
    if (chegaram >= participantes) return;
    chegaram += 1;
    if (chegaram === participantes) soltar();
    await aberta;
  };
}

/** Faz `vehicles.save` esperar na barreira antes de gravar. */
function segurarGravacaoDeVeiculo(repos: Repositories, esperar: () => Promise<void>): void {
  const gravar = repos.vehicles.save.bind(repos.vehicles);
  repos.vehicles.save = async (vehicle) => {
    await esperar();
    await gravar(vehicle);
  };
}

describe('Postgres: corrida, transacao e constraint', { skip: url === undefined || url === '' }, () => {
  test('duas lojas travam o mesmo carro ao mesmo tempo: uma leva, a outra ouve a regra', async () => {
    // Decisao 23, o caso que a plataforma existe para impedir. As duas leram o
    // carro AVAILABLE. A segunda gravacao perde a versao, a unidade e refeita,
    // e na nova tentativa o dominio ve o carro travado e responde com a regra.
    const app = await novaApp();
    const seed = app.seed!;
    const [veloz, central] = [seededActor(seed.stores[1]!), seededActor(seed.stores[2]!)];
    const carro = seed.vehicles[0]!;
    segurarGravacaoDeVeiculo(app.context.repos, barreira(2));

    const [a, b] = await Promise.all(
      [veloz, central].map((loja) =>
        app.context.repos.unitOfWork(() =>
          openCommercialLock(app.context, loja, { vehicleId: carro.id }),
        ),
      ),
    );

    const resultados = [a, b];
    assert.equal(resultados.filter((r) => r?.ok).length, 1, 'exatamente uma trava');
    const perdedora = resultados.find((r) => r !== undefined && !r.ok);
    assert.equal(perdedora?.ok === false && perdedora.error.code, 'VEHICLE_ALREADY_LOCKED');

    const travas = await app.context.repos.locks.historyByVehicle(carro.id);
    assert.equal(travas.filter((l) => l.status === LockStatus.ACTIVE).length, 1);
    const veiculo = await app.context.repos.vehicles.byId(carro.id);
    assert.equal(veiculo?.activeLockId, travas[0]?.id, 'o veiculo aponta para a trava que ficou');
    await app.stop();
  });

  test('o indice unico segura a segunda trava ativa mesmo sem o dominio', async () => {
    // A ultima linha de defesa: se algum caminho futuro gravar trava sem passar
    // por `openLock`, o banco recusa — e a recusa chega como regra, nao como 500.
    const app = await novaApp();
    const carro = app.seed!.vehicles[0]!;
    const veloz = seededActor(app.seed!.stores[1]!);
    const aberta = await openCommercialLock(app.context, veloz, { vehicleId: carro.id });
    assert.ok(aberta.ok);

    const segunda: CommercialLock = { ...aberta.value.lock!, id: asLockId('lck_intrusa') };
    await assert.rejects(
      app.context.repos.unitOfWork(() => app.context.repos.locks.save(segunda)),
      (error: { code?: string }) => error.code === 'VEHICLE_ALREADY_LOCKED',
    );
    await app.stop();
  });

  test('gravacoes simultaneas no mesmo agregado nao se apagam', async () => {
    // O caso geral de que sao feitos o check-in duplo e a liquidacao dupla da
    // decisao 23: duas unidades leem a mesma versao e gravam. Sem o controle de
    // versao, a segunda apagaria a primeira em silencio.
    const app = await novaApp();
    const prime = seededActor(app.seed!.stores[0]!);
    const carro = app.seed!.vehicles[0]!;
    segurarGravacaoDeVeiculo(app.context.repos, barreira(2));

    await Promise.all([
      app.context.repos.unitOfWork(() =>
        updateVehiclePricing(app.context, prime, { vehicleId: carro.id, publicPrice: fromReais(95_000) }),
      ),
      app.context.repos.unitOfWork(() =>
        updateVehiclePricing(app.context, prime, { vehicleId: carro.id, netPrice: fromReais(80_000) }),
      ),
    ]);

    const depois = await app.context.repos.vehicles.byId(carro.id);
    assert.equal(depois?.pricing.publicPrice.cents, fromReais(95_000).cents, 'o publico ficou');
    assert.equal(depois?.pricing.netPrice.cents, fromReais(80_000).cents, 'o liquido tambem');
    await app.stop();
  });

  test('dois pedidos de recall ao mesmo tempo: um recall aberto, e a regra para o outro', async () => {
    // O pedido so insere uma linha nova. A versao nao pega isso — ninguem
    // regrava a mesma linha —; o indice unico de recall aberto por carro pega.
    const app = await novaApp();
    const [prime, veloz] = [seededActor(app.seed!.stores[0]!), seededActor(app.seed!.stores[1]!)];
    const carro = app.seed!.vehicles[0]!;
    const termo = (loja: Actor) =>
      unwrap(
        sealTerm(
          {
            odometerKm: 38_400,
            fuelEighths: 5,
            photos: [
              PhotoAngle.FRONT,
              PhotoAngle.REAR,
              PhotoAngle.LEFT,
              PhotoAngle.RIGHT,
              PhotoAngle.ODOMETER,
            ].map((angle) => ({ angle, url: `https://cdn.exemplo.com/${angle}.jpg` })),
            damages: [],
          },
          {
            name: loja.user.name,
            document: '529.982.247-25',
            role: 'Gerente',
            userId: loja.user.id,
            storeId: loja.store.id,
          },
          T0,
        ),
      );
    const saida = unwrap(
      await startCustodyTransfer(app.context, prime, {
        vehicleId: carro.id,
        toStoreId: veloz.store.id,
        purpose: TransferPurpose.EXTENDED_STOCK,
        checkout: termo(prime),
      }),
    );
    unwrap(await completeCustodyTransfer(app.context, veloz, saida.transfer.id, termo(veloz)));

    const esperar = barreira(2);
    const gravar = app.context.repos.recalls.save.bind(app.context.repos.recalls);
    app.context.repos.recalls.save = async (recall) => {
      await esperar();
      await gravar(recall);
    };

    const pedidos = await Promise.all(
      [1, 2].map(() =>
        app.context.repos.unitOfWork(() =>
          requestVehicleRecall(app.context, prime, { vehicleId: carro.id, reason: RecallReason.OWN_SALE }),
        ),
      ),
    );

    assert.equal(pedidos.filter((p) => p.ok).length, 1, 'um recall');
    const recusado = pedidos.find((p) => !p.ok);
    assert.equal(recusado?.ok === false && recusado.error.code, 'RECALL_ALREADY_OPEN');
    assert.equal((await app.context.repos.recalls.byVehicle(carro.id)).length, 1);
    await app.stop();
  });

  test('a unidade que falha nao deixa nada gravado', async () => {
    const app = await novaApp();
    const prime = seededActor(app.seed!.stores[0]!);
    const carro = app.seed!.vehicles[0]!;

    await assert.rejects(
      app.context.repos.unitOfWork(async () => {
        await updateVehiclePricing(app.context, prime, {
          vehicleId: carro.id,
          publicPrice: fromReais(99_000),
        });
        throw new Error('falha no meio da operacao');
      }),
      /falha no meio/,
    );

    const depois = await app.context.repos.vehicles.byId(carro.id);
    assert.equal(depois?.pricing.publicPrice.cents, carro.pricing.publicPrice.cents);
    assert.equal((await app.context.repos.audit.byAggregate(carro.id)).length, 0, 'nem a trilha');
    await app.stop();
  });

  test('um aviso que falha ao gravar nao derruba a operacao', async () => {
    // Sem o savepoint, o erro do aviso abortaria a transacao inteira, e o
    // barramento — que isola o erro do handler — nao teria como salva-la.
    const app = await novaApp();
    const prime = seededActor(app.seed!.stores[0]!);
    const carro = app.seed!.vehicles[0]!;
    const aviso = {
      id: 'aud_repetido',
      storeId: prime.store.id,
      eventType: 'teste',
      severity: 'INFO',
      title: 't',
      body: 'b',
      aggregateId: carro.id,
      occurredAt: T0,
      readAt: null,
    } as const;

    await app.context.repos.unitOfWork(async () => {
      await app.context.repos.notifications.append(aviso);
      await assert.rejects(app.context.repos.notifications.append(aviso), /duplicate key/);
      await updateVehiclePricing(app.context, prime, { vehicleId: carro.id, publicPrice: fromReais(97_000) });
    });

    const depois = await app.context.repos.vehicles.byId(carro.id);
    assert.equal(depois?.pricing.publicPrice.cents, fromReais(97_000).cents);
    await app.stop();
  });

  test('migrar duas vezes nao faz nada na segunda', async () => {
    const schema = `rede_t_mig_${Date.now().toString(36)}`;
    const db = new Database(databaseConfigFrom({ DATABASE_URL: url!, DATABASE_SCHEMA: schema })!);
    assert.deepEqual(await migrate(db), ['001_inicial']);
    assert.deepEqual(await migrate(db), []);
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  });
});
