import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildApplication, type Application } from '../bootstrap.ts';
import { loadConfig } from '../config.ts';
import { DAY, FakeClock, HOUR, addMonths } from '../domain/shared/clock.ts';
import { sequentialIdGenerator } from '../domain/shared/ids.ts';
import { seededActor } from '../infra/seed.ts';
import { fromReais } from '../domain/shared/money.ts';
import { unwrap } from '../domain/shared/result.ts';
import { FuelType, TradeInStance, TransmissionType } from '../domain/vehicle/vehicle.ts';
import { asClusterId, asMemberId, asStoreId, asUserId } from '../domain/shared/ids.ts';
import { PhotoAngle, sealTerm, TransferPurpose } from '../domain/custody/custody.ts';
import type { Actor } from './context.ts';
import { loadVehicle, openCommercialLock, registerVehicle, searchCatalog } from './inventory-service.ts';
import {
  completeCustodyTransfer,
  declareVehicleDropOff,
  requestVehicleRecall,
  startCustodyTransfer,
} from './custody-service.ts';
import { BreachKind } from '../domain/conduct/breach.ts';
import { RecallReason } from '../domain/recall/recall.ts';
import { runConductSweep, storeConduct } from './conduct-service.ts';
import { cancelExit, exitStatus, requestExit, sweepCompletedExits } from './exit-service.ts';
import { endorseApplication, submitApplication, viewApplication } from './governance-service.ts';
import { MemberKind, MemberStatus, type Member } from '../domain/network/member.ts';
import { StoreStatus, canTransact } from '../domain/network/store.ts';
import { ChargeKind } from '../domain/billing/charge.ts';
import { PILOT_TARIFF } from '../domain/billing/tariff.ts';
import {
  chargeAdhesion,
  memberStatement,
  registerChargePayment,
  runBillingSweep,
} from './billing-service.ts';
import { openStoreBranch } from './governance-service.ts';
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
    lojaA: seededActor(seed.stores[0]!),
    lojaB: seededActor(seed.stores[1]!),
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
  tradeInStance: TradeInStance.CONSIDERS,
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
      member: {
        ...base.lojaB.member,
        id: asMemberId('mbr_forasteira'),
        cnpjRoot: '99887766',
        clusterId: londrina,
      },
      store: {
        ...base.lojaB.store,
        id: asStoreId('str_forasteira'),
        memberId: asMemberId('mbr_forasteira'),
        clusterId: londrina,
      },
      user: { ...base.lojaB.user, id: asUserId('usr_forasteira'), storeId: asStoreId('str_forasteira') },
    };
    await base.app.context.repos.members.save(forasteira.member);
    await base.app.context.repos.stores.save(forasteira.store);
    await base.app.context.repos.users.save(forasteira.user);

    const carro = await registerVehicle(base.app.context, base.lojaA, {
      plate: 'RGT4B71',
      chassis: '9BWZZZ377VT004251',
      specs: ficha,
      publicPrice: fromReais(92_900),
      netPrice: fromReais(85_000),
      tradeInStance: TradeInStance.CONSIDERS,
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

  test('fundadora de uma praca nao conta no rol da outra', async () => {
    const { app, curitiba, londrina } = await duasPracas();

    const deCuritiba = await app.context.repos.members.founders(curitiba);
    const deLondrina = await app.context.repos.members.founders(londrina);

    assert.equal(deCuritiba.length, 10, 'as 10 fundadoras do piloto');
    assert.equal(deLondrina.length, 1, 'Londrina constitui a propria fundacao');

    const emCuritiba = new Set(deCuritiba.map((empresa) => empresa.id));
    for (const empresa of deLondrina) {
      assert.ok(!emCuritiba.has(empresa.id), 'nenhuma fundadora endossa nas duas pracas');
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

const candidata = {
  legalName: 'Nova Garagem Veiculos LTDA',
  tradeName: 'Nova Garagem',
  cnpj: '07.526.557/0001-00',
  city: 'Sao Jose dos Pinhais',
  state: 'PR',
  phone: '(41) 99876-5432',
  email: 'contato@novagaragem.com.br',
  responsibleName: 'Joao Pereira',
  yard: { lat: -25.5307, lng: -49.2064 },
};

/** Apresenta a candidata pela empresa 0 e junta os tres endossos das 1..3. */
async function credenciarNova(app: Application): Promise<Member> {
  const seed = app.seed!;

  const aberta = await submitApplication(app.context, seededActor(seed.stores[0]!), candidata);
  assert.ok(aberta.ok);

  let ultima = aberta;
  for (const i of [1, 2, 3]) {
    const passo = await endorseApplication(
      app.context,
      seededActor(seed.stores[i]!),
      aberta.value.application.id,
    );
    assert.ok(passo.ok);
    ultima = passo;
  }

  assert.equal(ultima.value.application.status, 'APPROVED');
  assert.ok(ultima.value.admittedMember !== null, 'o terceiro endosso ja credencia');
  return ultima.value.admittedMember;
}

describe('janela de fundacao: quem entrar na janela, leva', () => {
  test('credenciada dentro da janela, a EMPRESA nasce FUNDADORA', async () => {
    const { app } = await novaApp();

    const empresa = await credenciarNova(app);
    assert.equal(empresa.kind, MemberKind.FOUNDER);

    const fundadoras = await app.context.repos.members.founders(empresa.clusterId);
    assert.equal(fundadoras.length, 11, 'o rol cresce — e por isso que ele e contado, nao declarado');

    // E nasce com exatamente um patio: os seguintes sao `openBranch`, e e la
    // que a linha de R$ 159 aparece.
    const patios = await app.context.repos.stores.byMember(empresa.id);
    assert.equal(patios.length, 1);
    await app.stop();
  });

  test('fechada a janela, a mesma candidatura vira MEMBER', async () => {
    const { app, clock } = await novaApp();
    const praca = (await app.context.repos.clusters.byId(app.seed!.cluster.id))!;

    // Um dia depois do fim da janela. Nada mais muda: mesma candidata, mesmos
    // tres endossos, mesmas fundadoras.
    clock.set(praca.foundingWindowEndsAt + DAY);

    const empresa = await credenciarNova(app);
    assert.equal(empresa.kind, MemberKind.MEMBER);

    const fundadoras = await app.context.repos.members.founders(empresa.clusterId);
    assert.equal(fundadoras.length, 10, 'o rol de fundadoras esta fechado');
    await app.stop();
  });

  test('a apuracao acompanha a praca em vez de repetir um numero de politica', async () => {
    const { app } = await novaApp();
    const seed = app.seed!;

    const aberta = await submitApplication(app.context, seededActor(seed.stores[0]!), candidata);
    assert.ok(aberta.ok);
    // 10 fundadoras, menos a padrinho.
    assert.equal(aberta.value.tally.foundersYetToEndorse, 9);
    assert.equal(aberta.value.tally.reachable, true);

    // Suspender fundadoras tira cada uma da conta: quem nao pode endossar nao
    // deve aparecer como se pudesse.
    // Suspensao da EMPRESA: e ela que endossa, e e ela que a inadimplencia
    // atinge. Fechar o patio nao tira o endosso de quem esta em dia.
    for (const i of [1, 2, 3, 4, 5, 6, 7]) {
      await app.context.repos.members.save({
        ...seed.stores[i]!.member,
        status: MemberStatus.SUSPENDED,
      });
    }

    const revista = await viewApplication(app.context, aberta.value.application.id);
    assert.ok(revista.ok);
    assert.equal(revista.value.tally.foundersYetToEndorse, 2, 'sobraram duas ativas alem da padrinho');
    assert.equal(revista.value.tally.reachable, false, 'duas nao fecham tres endossos');
    await app.stop();
  });
});

describe('cobranca: adesao, mensalidade e a suspensao por 30 dias', () => {
  test('credenciar emite a adesao — e a fundadora paga metade', async () => {
    const { app } = await novaApp();
    const empresa = await credenciarNova(app);

    const extrato = unwrap(await memberStatement(app.context, empresa.id));
    const adesao = extrato.charges.find((c) => c.kind === ChargeKind.ADHESION);

    assert.equal(empresa.kind, MemberKind.FOUNDER, 'janela do piloto aberta');
    assert.equal(adesao?.amount.cents, 300_000, 'R$ 3.000: metade dos R$ 6.000');
    await app.stop();
  });

  test('credenciar duas vezes nao cobra adesao duas vezes', async () => {
    // O provisionamento pode ser repetido depois de uma falha, e cobrar de novo
    // por isso seria o pior jeito de comecar uma relacao comercial.
    const { app } = await novaApp();
    const empresa = await credenciarNova(app);

    await chargeAdhesion(app.context, empresa);
    await chargeAdhesion(app.context, empresa);

    const extrato = unwrap(await memberStatement(app.context, empresa.id));
    const adesoes = extrato.charges.filter((c) => c.kind === ChargeKind.ADHESION);
    assert.equal(adesoes.length, 1);
    await app.stop();
  });

  test('a mensalidade da Prime cobra os dois patios: 599 + 159', async () => {
    const { app } = await novaApp();
    const prime = app.seed!.stores[0]!.member;

    const resultado = await runBillingSweep(app.context, prime.clusterId);
    assert.ok(resultado.issued >= 10, 'todas as empresas do piloto faturadas');

    const extrato = unwrap(await memberStatement(app.context, prime.id));
    const mensal = extrato.charges.find((c) => c.kind === ChargeKind.MONTHLY);

    assert.equal(extrato.storeCount, 2, 'matriz + Boqueirao');
    assert.equal(mensal?.breakdown?.extraStores, 1);
    assert.equal(mensal?.amount.cents, 59_900 + 15_900);
    await app.stop();
  });

  test('empresa de uma loja paga so os 599', async () => {
    const { app } = await novaApp();
    const veloz = app.seed!.stores[1]!.member;

    await runBillingSweep(app.context, veloz.clusterId);
    const extrato = unwrap(await memberStatement(app.context, veloz.id));

    assert.equal(extrato.charges.find((c) => c.kind === ChargeKind.MONTHLY)?.amount.cents, 59_900);
    await app.stop();
  });

  test('rodar a varredura duas vezes no mesmo ciclo nao duplica a fatura', async () => {
    const { app } = await novaApp();
    const prime = app.seed!.stores[0]!.member;

    await runBillingSweep(app.context, prime.clusterId);
    const segunda = await runBillingSweep(app.context, prime.clusterId);

    assert.equal(segunda.issued, 0, 'o ciclo ja estava faturado');
    await app.stop();
  });

  test('patio aberto no meio do ciclo entra na proxima fatura, sem rateio', async () => {
    const { app, clock } = await novaApp();
    const veloz = app.seed!.stores[1]!;

    await runBillingSweep(app.context, veloz.member.clusterId);
    clock.advance(5 * DAY);

    const filial = await openStoreBranch(app.context, seededActor(veloz), {
      ...veloz.store.profile,
      tradeName: 'Veloz Seminovos Centro',
      cnpj: '04252011000209',
    });
    assert.ok(filial.ok, JSON.stringify(filial));

    // Ainda no mesmo ciclo: a fatura ja emitida nao muda.
    const meio = unwrap(await memberStatement(app.context, veloz.member.id));
    assert.equal(meio.charges.find((c) => c.kind === ChargeKind.MONTHLY)?.amount.cents, 59_900);
    assert.equal(meio.nextMonthly.cents, 59_900 + 15_900, 'a proxima ja conta a filial');

    clock.set(addMonths(veloz.member.joinedAt, 1));
    await runBillingSweep(app.context, veloz.member.clusterId);

    const depois = unwrap(await memberStatement(app.context, veloz.member.id));
    const mensais = depois.charges.filter((c) => c.kind === ChargeKind.MONTHLY);
    assert.equal(mensais.length, 2);
    assert.equal(mensais[1]?.amount.cents, 59_900 + 15_900);
    await app.stop();
  });

  test('30 dias de atraso suspendem a EMPRESA, e com ela todos os patios', async () => {
    const { app, clock } = await novaApp();
    const prime = app.seed!.stores[0]!;

    await runBillingSweep(app.context, prime.member.clusterId);
    const emitida = unwrap(await memberStatement(app.context, prime.member.id));
    const fatura = emitida.charges.find((c) => c.kind === ChargeKind.MONTHLY)!;

    clock.set(fatura.dueAt + 29 * DAY);
    await runBillingSweep(app.context, prime.member.clusterId);
    assert.equal(
      (await app.context.repos.members.byId(prime.member.id))?.status,
      MemberStatus.ACTIVE,
      '29 dias ainda nao suspendem',
    );

    clock.set(fatura.dueAt + 30 * DAY);
    await runBillingSweep(app.context, prime.member.clusterId);

    const suspensa = (await app.context.repos.members.byId(prime.member.id))!;
    assert.equal(suspensa.status, MemberStatus.SUSPENDED);

    // O patio segue ACTIVE: os dois eixos sao independentes. O que barra a
    // operacao e `canTransact`, que exige os dois.
    const patio = (await app.context.repos.stores.byId(prime.store.id))!;
    assert.equal(patio.status, StoreStatus.ACTIVE);
    assert.equal(canTransact(patio, suspensa), false);

    // E a filial, que nao fez nada, tambem para: o contrato e um so.
    const filial = (await app.context.repos.stores.byMember(prime.member.id)).find(
      (loja) => loja.id !== prime.store.id,
    )!;
    assert.equal(canTransact(filial, suspensa), false);
    await app.stop();
  });

  test('empresa suspensa nao trava veiculo', async () => {
    const { app, clock, lojaA } = await novaApp();
    const carro = unwrap(
      await registerVehicle(app.context, lojaA, cadastro('RGT4B71', '9BWZZZ377VT004251')),
    );

    await runBillingSweep(app.context, lojaA.member.clusterId);
    const extrato = unwrap(await memberStatement(app.context, lojaA.member.id));
    clock.set(extrato.charges[0]!.dueAt + 40 * DAY);
    await runBillingSweep(app.context, lojaA.member.clusterId);

    const devedora = (await app.context.repos.members.byId(lojaA.member.id))!;
    const trava = await openCommercialLock(
      app.context,
      { ...lojaA, member: devedora },
      { vehicleId: carro.id },
    );

    assert.equal(trava.ok, false);
    assert.equal(trava.ok === false && trava.error.code, 'STORE_NOT_ACTIVE');
    await app.stop();
  });

  test('a suspensao nao para a cobranca: ficar suspenso nao sai de graca', async () => {
    const { app, clock } = await novaApp();
    const prime = app.seed!.stores[0]!.member;

    await runBillingSweep(app.context, prime.clusterId);
    const primeira = unwrap(await memberStatement(app.context, prime.id));
    clock.set(primeira.charges[0]!.dueAt + 40 * DAY);
    await runBillingSweep(app.context, prime.clusterId);

    const depois = unwrap(await memberStatement(app.context, prime.id));
    assert.equal(depois.member.status, MemberStatus.SUSPENDED);
    assert.ok(
      depois.charges.filter((c) => c.kind === ChargeKind.MONTHLY).length > 1,
      'o ciclo seguinte foi emitido mesmo com a empresa suspensa',
    );
    await app.stop();
  });

  test('quitar o atraso reativa a empresa na mesma operacao', async () => {
    const { app, clock } = await novaApp();
    const prime = app.seed!.stores[0]!.member;

    await runBillingSweep(app.context, prime.clusterId);
    const primeira = unwrap(await memberStatement(app.context, prime.id));
    clock.set(primeira.charges[0]!.dueAt + 35 * DAY);
    await runBillingSweep(app.context, prime.clusterId);

    const suspensa = unwrap(await memberStatement(app.context, prime.id));
    assert.equal(suspensa.member.status, MemberStatus.SUSPENDED);

    // Quita da mais antiga para a mais nova. A reativacao dispara no pagamento
    // que derruba o atraso abaixo de 30 dias — que nao e necessariamente o
    // ultimo: separar pagamento de reativacao deixaria uma janela em que a
    // empresa ja esta em dia e continua suspensa.
    const abertas = [...suspensa.charges.filter((c) => c.status === 'OPEN')].sort(
      (a, b) => a.dueAt - b.dueAt,
    );
    const reativacoes = [];
    for (const cobranca of abertas) {
      const pago = unwrap(await registerChargePayment(app.context, cobranca.id));
      if (pago.reinstated !== null) reativacoes.push(pago.reinstated);
    }

    assert.equal(reativacoes.length, 1, 'reativa uma vez so, no pagamento que cura o atraso');
    assert.equal(reativacoes[0]?.status, MemberStatus.ACTIVE);
    assert.equal(
      (await app.context.repos.members.byId(prime.id))?.status,
      MemberStatus.ACTIVE,
    );
    await app.stop();
  });

  test('fatura de recuperacao vence 10 dias depois de EMITIDA, nao da competencia', async () => {
    // A plataforma ficou sem faturar e recupera o ciclo antigo. Ele nao nasce
    // vencido: ninguem pode estar inadimplente de um boleto que nunca recebeu.
    const { app, clock } = await novaApp();
    const prime = app.seed!.stores[0]!.member;

    clock.set(addMonths(prime.joinedAt, 3));
    await runBillingSweep(app.context, prime.clusterId);

    const extrato = unwrap(await memberStatement(app.context, prime.id));
    const mensais = extrato.charges.filter((c) => c.kind === ChargeKind.MONTHLY);

    assert.equal(mensais.length, 4, 'quatro competencias recuperadas de uma vez');
    assert.equal(extrato.overdueDays, 0, 'nenhuma delas nasce vencida');
    for (const fatura of mensais) {
      assert.equal(fatura.dueAt, clock.now() + 10 * DAY);
    }
    await app.stop();
  });

  test('quitar uma fatura nao reativa enquanto outra tambem passou dos 30 dias', async () => {
    // A inadimplencia olha a cobranca ABERTA mais antiga. Quitar a pior so cura
    // se o que sobrou estiver dentro do prazo — e aqui nao esta.
    const { app, clock } = await novaApp();
    const prime = app.seed!.stores[0]!.member;

    await runBillingSweep(app.context, prime.clusterId);
    clock.set(addMonths(prime.joinedAt, 1));
    await runBillingSweep(app.context, prime.clusterId);

    const duas = unwrap(await memberStatement(app.context, prime.id));
    const abertas = [...duas.charges.filter((c) => c.status === 'OPEN')].sort(
      (a, b) => a.dueAt - b.dueAt,
    );
    assert.ok(abertas.length >= 2, 'duas competencias, emitidas em datas diferentes');

    // Passado o prazo da MAIS NOVA: agora as duas estao vencidas ha mais de 30.
    clock.set(abertas[abertas.length - 1]!.dueAt + 31 * DAY);
    await runBillingSweep(app.context, prime.clusterId);
    assert.equal(
      (await app.context.repos.members.byId(prime.id))?.status,
      MemberStatus.SUSPENDED,
    );

    const parcial = unwrap(await registerChargePayment(app.context, abertas[0]!.id));
    assert.equal(parcial.reinstated, null, 'a outra sozinha ja passa dos 30 dias');
    assert.equal(
      (await app.context.repos.members.byId(prime.id))?.status,
      MemberStatus.SUSPENDED,
    );
    await app.stop();
  });

  test('o extrato so diz "congelada" quando a tabela dela difere da vigente', async () => {
    // Enquanto as duas coincidem, anunciar congelamento seria prometer um
    // desconto que ainda nao existe.
    const { app } = await novaApp();
    const extrato = unwrap(await memberStatement(app.context, app.seed!.stores[0]!.member.id));

    assert.equal(extrato.tariffVersion, PILOT_TARIFF.version);
    assert.equal(extrato.tariffFrozen, false);
    await app.stop();
  });
});

describe('conduta: as quebras de protocolo que o sistema mede sozinho', () => {
  /** Carro da loja A no patio da loja B, em estoque avancado. */
  async function carroNaLojaB() {
    const base = await novaApp();
    const carro = unwrap(
      await registerVehicle(base.app.context, base.lojaA, cadastro('RGT4B71', '9BWZZZ377VT004251')),
    );
    const saida = unwrap(
      await startCustodyTransfer(base.app.context, base.lojaA, {
        vehicleId: carro.id,
        toStoreId: base.lojaB.store.id,
        purpose: TransferPurpose.EXTENDED_STOCK,
        checkout: termoDeVistoria(base.lojaA, 38_400),
      }),
    );
    return { ...base, carro, transfer: saida.transfer };
  }

  const cluster = (app: Application) => app.seed!.cluster.id;

  test('o SLA de recall estourado vira quebra do custodiante', async () => {
    const { app, clock, lojaA, lojaB, carro, transfer } = await carroNaLojaB();
    unwrap(await completeCustodyTransfer(app.context, lojaB, transfer.id, termoDeVistoria(lojaB, 38_400)));

    unwrap(
      await requestVehicleRecall(app.context, lojaA, {
        vehicleId: carro.id,
        reason: RecallReason.OWN_SALE,
      }),
    );

    clock.advance(5 * 24 * HOUR);
    await runSweep(app.context);

    const conduta = await storeConduct(app.context, lojaB.store.id);
    assert.equal(conduta.record.withinWindow, 1);
    assert.equal(conduta.record.breaches[0]?.kind, BreachKind.RECALL_SLA);
    await app.stop();
  });

  test('rodar a varredura mil vezes nao multiplica a mesma quebra', async () => {
    // O varredor roda a cada minuto. Sem o id deterministico da quebra, um
    // unico atraso suspenderia a praca inteira antes do almoco.
    const { app, clock, lojaA, lojaB, carro, transfer } = await carroNaLojaB();
    unwrap(await completeCustodyTransfer(app.context, lojaB, transfer.id, termoDeVistoria(lojaB, 38_400)));
    unwrap(
      await requestVehicleRecall(app.context, lojaA, {
        vehicleId: carro.id,
        reason: RecallReason.OWN_SALE,
      }),
    );

    // Varredura completa, vinte vezes: e o que o sweeper faz de verdade, e a
    // quebra de conduta depende de `sweepRecallBreaches` ter marcado o SLA
    // antes — por isso a ordem dentro de `runSweep` importa.
    clock.advance(5 * 24 * HOUR);
    for (let i = 0; i < 20; i += 1) await runSweep(app.context);

    const conduta = await storeConduct(app.context, lojaB.store.id);
    assert.equal(conduta.record.withinWindow, 1, 'uma quebra, nao vinte');
    assert.equal(
      (await app.context.repos.stores.byId(lojaB.store.id))?.status,
      StoreStatus.ACTIVE,
      'e a loja segue aberta',
    );
    await app.stop();
  });

  test('entrega declarada no patio e nao aceita vira quebra de QUEM RECEBE', async () => {
    // So e atribuivel porque a coordenada foi conferida contra o patio de
    // destino. Sem a conferencia seria palavra contra palavra.
    const { app, clock, lojaA, lojaB, transfer } = await carroNaLojaB();
    unwrap(
      await declareVehicleDropOff(app.context, lojaA, transfer.id, lojaB.store.profile.yard),
    );

    clock.advance(3 * 24 * HOUR);
    await runConductSweep(app.context, cluster(app));

    const recebedora = await storeConduct(app.context, lojaB.store.id);
    assert.equal(recebedora.record.breaches[0]?.kind, BreachKind.DROPOFF_NOT_ACKNOWLEDGED);

    const entregadora = await storeConduct(app.context, lojaA.store.id);
    assert.equal(entregadora.record.withinWindow, 0, 'quem entregou cumpriu o protocolo');
    await app.stop();
  });

  test('termo esquecido em transito vira quebra da ORIGEM', async () => {
    // Quem tirou o carro do patio responde por ele ate o aceite.
    const { app, clock, lojaA, lojaB } = await carroNaLojaB();

    clock.advance(10 * 24 * HOUR);
    await runConductSweep(app.context, cluster(app));

    assert.equal(
      (await storeConduct(app.context, lojaA.store.id)).record.breaches[0]?.kind,
      BreachKind.TRANSFER_ABANDONED,
    );
    assert.equal((await storeConduct(app.context, lojaB.store.id)).record.withinWindow, 0);
    await app.stop();
  });

  test('tres quebras na janela suspendem o patio — e so o patio', async () => {
    const { app, clock, lojaA } = await carroNaLojaB();

    // Mais dois termos abandonados pela mesma loja: tres no total.
    for (const [placa, chassi] of [
      ['KLM8D42', '9BWZZZ377VT004252'],
      ['XYZ9K88', '9BWZZZ377VT004253'],
    ] as const) {
      const outro = unwrap(await registerVehicle(app.context, lojaA, cadastro(placa, chassi)));
      unwrap(
        await startCustodyTransfer(app.context, lojaA, {
          vehicleId: outro.id,
          toStoreId: app.seed!.stores[2]!.store.id,
          purpose: TransferPurpose.EXTENDED_STOCK,
          checkout: termoDeVistoria(lojaA, 38_400),
        }),
      );
    }

    clock.advance(10 * 24 * HOUR);
    await runConductSweep(app.context, cluster(app));

    const conduta = await storeConduct(app.context, lojaA.store.id);
    assert.equal(conduta.record.withinWindow, 3);
    assert.equal(conduta.record.reachedThreshold, true);

    const patio = (await app.context.repos.stores.byId(lojaA.store.id))!;
    assert.equal(patio.status, StoreStatus.SUSPENDED);

    // A empresa segue em dia: conduta e do patio, inadimplencia e da empresa.
    assert.equal(
      (await app.context.repos.members.byId(lojaA.member.id))?.status,
      MemberStatus.ACTIVE,
    );
    assert.equal(canTransact(patio, lojaA.member), false, 'mas o patio nao opera');
    await app.stop();
  });

  test('a janela movel reabre o patio sem ninguem precisar lembrar', async () => {
    const { app, clock, lojaA } = await carroNaLojaB();
    for (const [placa, chassi] of [
      ['KLM8D42', '9BWZZZ377VT004252'],
      ['XYZ9K88', '9BWZZZ377VT004253'],
    ] as const) {
      const outro = unwrap(await registerVehicle(app.context, lojaA, cadastro(placa, chassi)));
      unwrap(
        await startCustodyTransfer(app.context, lojaA, {
          vehicleId: outro.id,
          toStoreId: app.seed!.stores[2]!.store.id,
          purpose: TransferPurpose.EXTENDED_STOCK,
          checkout: termoDeVistoria(lojaA, 38_400),
        }),
      );
    }

    clock.advance(10 * 24 * HOUR);
    await runConductSweep(app.context, cluster(app));
    assert.equal(
      (await app.context.repos.stores.byId(lojaA.store.id))?.status,
      StoreStatus.SUSPENDED,
    );

    // Treze meses depois: as tres quebras sairam da janela.
    clock.set(addMonths(clock.now(), 13));
    const resultado = await runConductSweep(app.context, cluster(app));

    assert.equal(resultado.reopened, 1);
    assert.equal((await app.context.repos.stores.byId(lojaA.store.id))?.status, StoreStatus.ACTIVE);
    await app.stop();
  });
});

describe('saida voluntaria: as duas comportas', () => {
  test('o checklist existe antes de avisar — quem pensa em sair precisa ver o custo', async () => {
    const { app, lojaA } = await novaApp();
    const status = unwrap(await exitStatus(app.context, lojaA.member.id));

    assert.equal(status.member.status, MemberStatus.ACTIVE);
    assert.equal(status.readiness.clear, false);
    assert.deepEqual(status.readiness.blockers, ['AVISO_NAO_DADO']);
    await app.stop();
  });

  test('avisar impede exposicao nova mas deixa encerrar o que esta aberto', async () => {
    const { app, lojaA, lojaB } = await novaApp();
    const carro = unwrap(
      await registerVehicle(app.context, lojaB, cadastro('RGT4B71', '9BWZZZ377VT004251')),
    );

    const saindo = unwrap(await requestExit(app.context, lojaA)).member;
    assert.equal(saindo.status, MemberStatus.LEAVING);

    // Nao trava carro de terceiro: seria negociacao que sobrevive a saida.
    const trava = await openCommercialLock(
      app.context,
      { ...lojaA, member: saindo },
      { vehicleId: carro.id },
    );
    assert.equal(trava.ok === false && trava.error.code, 'STORE_NOT_ACTIVE');

    // Nem apresenta candidata: o endosso dela vale pelo tempo que ela ficar.
    const candidatura = await submitApplication(
      app.context,
      { ...lojaA, member: saindo },
      candidata,
    );
    assert.equal(candidatura.ok === false && candidatura.error.code, 'SPONSOR_NOT_ACTIVE');
    await app.stop();
  });

  test('loja de empresa em saida nao recebe carro novo — mas recebe o proprio de volta', async () => {
    const { app, lojaA, lojaB } = await novaApp();
    const carro = unwrap(
      await registerVehicle(app.context, lojaA, cadastro('RGT4B71', '9BWZZZ377VT004251')),
    );
    unwrap(await requestExit(app.context, lojaB));

    const recarregado = { ...lojaB, member: (await app.context.repos.members.byId(lojaB.member.id))! };
    const envio = await startCustodyTransfer(app.context, lojaA, {
      vehicleId: carro.id,
      toStoreId: recarregado.store.id,
      purpose: TransferPurpose.EXTENDED_STOCK,
      checkout: termoDeVistoria(lojaA, 38_400),
    });

    assert.equal(envio.ok, false);
    assert.equal(envio.ok === false && envio.error.code, 'DESTINATION_NOT_ACCEPTING_CUSTODY');
    await app.stop();
  });

  test('prazo vencido NAO basta: o carro de terceiro segura a saida', async () => {
    // A comporta de estado e a que importa. Depois de EXITED nao ha mais recall
    // a pedir nem prazo a cobrar: o carro ficaria sem contraparte.
    const { app, clock, lojaA, lojaB } = await novaApp();
    const carro = unwrap(
      await registerVehicle(app.context, lojaA, cadastro('RGT4B71', '9BWZZZ377VT004251')),
    );
    const saida = unwrap(
      await startCustodyTransfer(app.context, lojaA, {
        vehicleId: carro.id,
        toStoreId: lojaB.store.id,
        purpose: TransferPurpose.EXTENDED_STOCK,
        checkout: termoDeVistoria(lojaA, 38_400),
      }),
    );
    unwrap(
      await completeCustodyTransfer(app.context, lojaB, saida.transfer.id, termoDeVistoria(lojaB, 38_400)),
    );

    unwrap(await requestExit(app.context, lojaB));
    clock.advance(120 * DAY);

    const status = unwrap(await exitStatus(app.context, lojaB.member.id));
    assert.equal(status.readiness.noticeServed, true, 'o prazo ja venceu');
    assert.equal(status.readiness.holdingOthersVehicles, 1);
    assert.equal(status.readiness.clear, false);

    await sweepCompletedExits(app.context, app.seed!.cluster.id);
    assert.equal(
      (await app.context.repos.members.byId(lojaB.member.id))?.status,
      MemberStatus.LEAVING,
      'nao saiu com o carro dos outros no patio',
    );
    await app.stop();
  });

  test('devolvido o carro e quitada a fatura, a saida se conclui sozinha', async () => {
    const { app, clock, lojaA, lojaB } = await novaApp();
    const carro = unwrap(
      await registerVehicle(app.context, lojaA, cadastro('RGT4B71', '9BWZZZ377VT004251')),
    );
    const ida = unwrap(
      await startCustodyTransfer(app.context, lojaA, {
        vehicleId: carro.id,
        toStoreId: lojaB.store.id,
        purpose: TransferPurpose.EXTENDED_STOCK,
        checkout: termoDeVistoria(lojaA, 38_400),
      }),
    );
    unwrap(
      await completeCustodyTransfer(app.context, lojaB, ida.transfer.id, termoDeVistoria(lojaB, 38_400)),
    );

    unwrap(await requestExit(app.context, lojaB));
    clock.advance(40 * DAY);

    // Devolve o carro para a dona. Isso continua permitido em LEAVING — e
    // justamente o que ela precisa fazer para sair.
    const volta = unwrap(
      await startCustodyTransfer(app.context, lojaB, {
        vehicleId: carro.id,
        toStoreId: lojaA.store.id,
        purpose: TransferPurpose.RECALL_RETURN,
        checkout: termoDeVistoria(lojaB, 38_600),
      }),
    );
    unwrap(
      await completeCustodyTransfer(app.context, lojaA, volta.transfer.id, termoDeVistoria(lojaA, 38_600)),
    );

    // Quita o que deve.
    await runBillingSweep(app.context, app.seed!.cluster.id);
    const extrato = unwrap(await memberStatement(app.context, lojaB.member.id));
    for (const cobranca of extrato.charges.filter((c) => c.status === 'OPEN')) {
      unwrap(await registerChargePayment(app.context, cobranca.id));
    }

    const concluidas = await sweepCompletedExits(app.context, app.seed!.cluster.id);
    assert.equal(concluidas, 1);

    const saiu = (await app.context.repos.members.byId(lojaB.member.id))!;
    assert.equal(saiu.status, MemberStatus.EXITED);
    for (const patio of await app.context.repos.stores.byMember(saiu.id)) {
      assert.equal(patio.status, StoreStatus.EXITED);
    }
    await app.stop();
  });

  test('empresa que saiu nao e mais faturada', async () => {
    // Sem isto ela acumularia mensalidade para sempre, e o varredor tentaria
    // suspender quem ja saiu.
    const { app, clock, lojaB } = await novaApp();
    unwrap(await requestExit(app.context, lojaB));
    clock.advance(40 * DAY);

    await runBillingSweep(app.context, app.seed!.cluster.id);
    const extrato = unwrap(await memberStatement(app.context, lojaB.member.id));
    for (const cobranca of extrato.charges.filter((c) => c.status === 'OPEN')) {
      unwrap(await registerChargePayment(app.context, cobranca.id));
    }
    await sweepCompletedExits(app.context, app.seed!.cluster.id);
    assert.equal(
      (await app.context.repos.members.byId(lojaB.member.id))?.status,
      MemberStatus.EXITED,
    );

    clock.advance(60 * DAY);
    await runBillingSweep(app.context, app.seed!.cluster.id);

    const depois = unwrap(await memberStatement(app.context, lojaB.member.id));
    assert.equal(depois.outstanding.cents, 0, 'nao voltou a ser cobrada');
    await app.stop();
  });

  test('fundadora que sai encolhe o rol — porque ele e contado, nao declarado', async () => {
    const { app, clock, lojaB } = await novaApp();
    const antes = await app.context.repos.members.founders(lojaB.member.clusterId);
    assert.equal(antes.length, 10);

    unwrap(await requestExit(app.context, lojaB));
    clock.advance(40 * DAY);
    await runBillingSweep(app.context, app.seed!.cluster.id);
    const extrato = unwrap(await memberStatement(app.context, lojaB.member.id));
    for (const cobranca of extrato.charges.filter((c) => c.status === 'OPEN')) {
      unwrap(await registerChargePayment(app.context, cobranca.id));
    }
    await sweepCompletedExits(app.context, app.seed!.cluster.id);

    // O rol segue com dez linhas, mas a saida ja nao endossa nada: a apuracao
    // filtra por `memberInGoodStanding`, entao o denominador cai sozinho.
    const aberta = unwrap(
      await submitApplication(app.context, seededActor(app.seed!.stores[0]!), candidata),
    );
    assert.equal(
      aberta.tally.foundersYetToEndorse,
      8,
      'dez fundadoras, menos a padrinho, menos a que saiu',
    );
    await app.stop();
  });

  test('desistir da saida devolve a empresa a operacao', async () => {
    const { app, lojaB } = await novaApp();
    unwrap(await requestExit(app.context, lojaB));

    const voltou = unwrap(
      await cancelExit(app.context, {
        ...lojaB,
        member: (await app.context.repos.members.byId(lojaB.member.id))!,
      }),
    );

    assert.equal(voltou.member.status, MemberStatus.ACTIVE);
    assert.equal(voltou.readiness.noticeGivenAt, null);
    await app.stop();
  });
});
