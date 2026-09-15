import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ChangeKind, MissingAction, ingestFeed, type IngestionContext, type IngestionReport } from './ingestion.ts';
import { detectMapper, mapperFor } from './mappers/index.ts';
import { parseXml } from './xml.ts';
import {
  CommercialStatus,
  FuelType,
  TradeInStance,
  TransmissionType,
  type Vehicle,
} from '../../domain/vehicle/vehicle.ts';
import { asIngestionRunId, asLockId, asVehicleId, type StoreId } from '../../domain/shared/ids.ts';
import { fromReais } from '../../domain/shared/money.ts';
import { DAY } from '../../domain/shared/clock.ts';
import { unwrap } from '../../domain/shared/result.ts';
import {
  atYardOf,
  buildFoundingNetwork,
  buildVehicle,
  TEST_CLUSTER_ID,
} from '../../testing/builders.ts';
import { motorsFeed, revendaMaisFeed } from '../../testing/fixtures/feeds.ts';

const network = buildFoundingNetwork(6);
const lojaA = network.founderAt(0);
const lojaB = network.founderAt(1);

const T0 = Date.parse('2026-08-24T13:00:00Z');

let idCounter = 0;
function context(overrides: Partial<IngestionContext> = {}): IngestionContext {
  return {
    runId: asIngestionRunId('ing_0001'),
    clusterId: TEST_CLUSTER_ID,
    storeId: lojaA.id,
    tradeInStance: TradeInStance.CONSIDERS,
    now: T0,
    existing: [],
    chassisOwners: new Map<string, StoreId>(),
    nextVehicleId: () => asVehicleId(`veh_gen_${(idCounter += 1)}`),
    ...overrides,
  };
}

const run = (xml: string, overrides: Partial<IngestionContext> = {}): IngestionReport =>
  unwrap(ingestFeed(xml, context(overrides)));

const created = (report: IngestionReport): Vehicle[] =>
  report.changes.filter((c) => c.kind === ChangeKind.CREATED).map((c) => c.vehicle);

describe('deteccao de formato', () => {
  test('reconhece Revenda Mais e Motors pelo conteudo', () => {
    assert.equal(detectMapper(unwrap(parseXml(revendaMaisFeed([{}]))))?.provider, 'revendamais');
    assert.equal(detectMapper(unwrap(parseXml(motorsFeed([{}]))))?.provider, 'motors');
  });

  test('cai no mapeador generico para formatos desconhecidos', () => {
    const desconhecido = `<catalogo><vehicle><id>1</id><make>VW</make></vehicle></catalogo>`;
    assert.equal(detectMapper(unwrap(parseXml(desconhecido)))?.provider, 'generic');
  });

  test('integrador declarado explicitamente e respeitado', () => {
    assert.equal(mapperFor('MOTORS')?.provider, 'motors');
    assert.equal(mapperFor('inexistente'), undefined);
  });

  test('integrador desconhecido devolve erro acionavel', () => {
    const result = ingestFeed(revendaMaisFeed([{}]), context({ provider: 'inexistente' }));
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'FEED_FORMAT_UNKNOWN');
  });
});

describe('leitura dos dois formatos', () => {
  test('Revenda Mais: precos pt-BR, CDATA e laudo em elementos filhos', () => {
    const [vehicle] = created(run(revendaMaisFeed([{}])));
    assert.ok(vehicle);
    assert.equal(vehicle.plate, 'ABC1D23');
    assert.equal(vehicle.chassis, '9BWZZZ377VT004251');
    assert.equal(vehicle.pricing.publicPrice.cents, fromReais(92_900).cents);
    assert.equal(vehicle.pricing.netPrice.cents, fromReais(85_000).cents);
    assert.equal(vehicle.specs.transmission, TransmissionType.AUTOMATIC);
    assert.ok(vehicle.specs.optionals.includes('Multimidia 8" & camera de re'));
    assert.equal(vehicle.specs.photos.length, 2);
    assert.equal(vehicle.inspection.status, 'APPROVED');
    assert.equal(vehicle.commercialStatus, CommercialStatus.AVAILABLE);
  });

  test('Motors: precos com ponto decimal, dados em atributos, laudo em atributo', () => {
    const [vehicle] = created(run(motorsFeed([{}])));
    assert.ok(vehicle);
    assert.equal(vehicle.plate, 'XYZ9K88');
    assert.equal(vehicle.pricing.publicPrice.cents, fromReais(68_900).cents);
    assert.equal(vehicle.pricing.netPrice.cents, fromReais(62_500).cents);
    assert.equal(vehicle.specs.fuel, FuelType.FLEX);
    assert.equal(vehicle.specs.transmission, TransmissionType.MANUAL);
    assert.equal(vehicle.inspection.provider, 'Motors Check');
    assert.equal(vehicle.specs.photos[0], 'https://cdn.motors.com.br/MT-77/1.jpg');
  });

  test('o laudo sem data de validade ganha os 90 dias de mercado', () => {
    const [vehicle] = created(run(revendaMaisFeed([{ laudoData: '10/08/2026' }])));
    const issued = Date.UTC(2026, 7, 10);
    assert.equal(vehicle?.inspection.issuedAt, issued);
    assert.equal(vehicle?.inspection.expiresAt, issued + 90 * DAY);
  });
});

describe('qualificacao do estoque', () => {
  test('veiculo sem laudo aprovado entra, mas nao circula na rede', () => {
    const [vehicle] = created(run(revendaMaisFeed([{ laudo: 'REPROVADO' }])));
    assert.equal(vehicle?.inspection.status, 'REJECTED');
    assert.equal(vehicle?.commercialStatus, CommercialStatus.DRAFT);
  });

  test('laudo ja vencido tambem barra a circulacao', () => {
    const [vehicle] = created(run(revendaMaisFeed([{ laudoData: '01/01/2020' }])));
    assert.equal(vehicle?.commercialStatus, CommercialStatus.DRAFT);
  });

  test('item sem preco de repasse e recusado com motivo', () => {
    const xml = revendaMaisFeed([{}]).replace(/<preco_repasse>.*<\/preco_repasse>/, '');
    const report = run(xml);
    assert.equal(report.counts.created, 0);
    assert.equal(report.issues[0]?.code, 'MISSING_NET_PRICE');
    assert.equal(report.issues[0]?.externalId, 'RM-1001');
  });

  test('liquido acima do publico e tratado como inversao de colunas', () => {
    const report = run(revendaMaisFeed([{ preco: '80.000,00', precoRepasse: '95.000,00' }]));
    assert.equal(report.issues[0]?.code, 'NET_PRICE_ABOVE_PUBLIC_PRICE');
  });

  test('placa ou chassi invalido derruba so aquele item, nao o feed', () => {
    const report = run(
      revendaMaisFeed([{ id: 'A', placa: 'INVALIDA' }, { id: 'B', chassi: '9BWZZZ377VT004252' }]),
    );
    assert.equal(report.counts.created, 1);
    assert.equal(report.counts.rejected, 1);
    assert.equal(report.issues[0]?.externalId, 'A');
  });
});

describe('idempotencia e atualizacao', () => {
  test('rodar o mesmo feed duas vezes nao escreve nada na segunda', () => {
    const xml = revendaMaisFeed([{}]);
    const primeiro = run(xml);
    const vehicle = created(primeiro)[0] as Vehicle;

    const segundo = run(xml, { existing: [vehicle] });
    assert.equal(segundo.counts.created, 0);
    assert.equal(segundo.counts.updated, 0);
    assert.equal(segundo.counts.unchanged, 1);
    assert.equal(segundo.events.length, 0);
  });

  test('mudanca de preco no feed atualiza o veiculo', () => {
    const vehicle = created(run(revendaMaisFeed([{}])))[0] as Vehicle;
    const report = run(revendaMaisFeed([{ precoRepasse: '82.000,00' }]), { existing: [vehicle] });

    assert.equal(report.counts.updated, 1);
    const change = report.changes[0];
    assert.equal(change?.kind, ChangeKind.UPDATED);
    assert.equal(change.kind === 'UPDATED' && change.vehicle.pricing.netPrice.cents, fromReais(82_000).cents);
  });

  test('o id externo pode mudar: o chassi e a identidade real do veiculo', () => {
    const vehicle = created(run(revendaMaisFeed([{ id: 'RM-1001' }])))[0] as Vehicle;
    const report = run(revendaMaisFeed([{ id: 'NOVO-999' }]), { existing: [vehicle] });

    assert.equal(report.counts.created, 0, 'nao pode duplicar o mesmo carro');
    assert.equal(report.counts.updated, 1);
  });
});

describe('o feed nao decide sozinho', () => {
  test('a custodia fisica nunca e tocada pela sincronizacao', () => {
    const noPatioDaB = atYardOf(
      created(run(revendaMaisFeed([{}])))[0] as Vehicle,
      lojaB.id,
      T0 - 5 * DAY,
    );
    const report = run(revendaMaisFeed([{ km: '41000' }]), { existing: [noPatioDaB] });
    const change = report.changes[0];

    assert.equal(change?.kind, ChangeKind.UPDATED);
    if (change.kind !== 'UPDATED') return;
    assert.equal(change.vehicle.physical.custodianStoreId, lojaB.id);
    assert.equal(change.vehicle.physical.since, T0 - 5 * DAY);
  });

  test('com trava ativa, o novo liquido fica represado', () => {
    // A Loja B fechou sobre o numero que travou; mover a trave no meio da
    // negociacao quebraria a confianca que sustenta a rede.
    const travado: Vehicle = {
      ...(created(run(revendaMaisFeed([{}])))[0] as Vehicle),
      commercialStatus: CommercialStatus.LOCKED,
      activeLockId: asLockId('lck_1'),
    };
    const report = run(revendaMaisFeed([{ precoRepasse: '89.000,00' }]), { existing: [travado] });
    const change = report.changes[0];

    assert.equal(change?.kind, ChangeKind.UPDATED);
    if (change.kind !== 'UPDATED') return;
    assert.equal(change.vehicle.pricing.netPrice.cents, fromReais(85_000).cents, 'vigente inalterado');
    assert.equal(change.vehicle.pendingNetPrice?.cents, fromReais(89_000).cents, 'represado');
    assert.equal(change.vehicle.commercialStatus, CommercialStatus.LOCKED, 'a trava sobrevive ao feed');
    assert.ok(report.events.some((e) => e.type === 'vehicle.net_price_deferred'));
  });

  test('veiculo ja vendido pela rede ignora o feed atrasado do lojista', () => {
    const vendido: Vehicle = {
      ...(created(run(revendaMaisFeed([{}])))[0] as Vehicle),
      commercialStatus: CommercialStatus.SOLD,
    };
    const report = run(revendaMaisFeed([{ precoRepasse: '70.000,00' }]), { existing: [vendido] });

    assert.equal(report.counts.updated, 0);
    assert.equal(report.issues[0]?.code, 'VEHICLE_ALREADY_SOLD');
  });
});

describe('veiculo que sumiu do feed', () => {
  const missingChange = (report: IngestionReport) =>
    report.changes.find((change) => change.kind === ChangeKind.MISSING);

  test('parado no patio da dona: retirado da rede', () => {
    const vehicle = created(run(revendaMaisFeed([{}])))[0] as Vehicle;
    const report = run(revendaMaisFeed([{ id: 'OUTRO', chassi: '9BGRD08X04G117974', placa: 'XYZ9K88' }]), {
      existing: [vehicle],
    });

    const change = missingChange(report);
    assert.equal(change?.kind === 'MISSING' && change.action, MissingAction.WITHDRAWN);
    assert.equal(change?.kind === 'MISSING' && change.vehicle.commercialStatus, CommercialStatus.WITHDRAWN);
  });

  test('no patio de outra loja: sinalizado, nao retirado', () => {
    // Sumir do feed normalmente significa venda no balcao sem baixa. Alguem
    // precisa combinar o retorno; nao e o sincronizador quem decide.
    const noPatioDaB = atYardOf(created(run(revendaMaisFeed([{}])))[0] as Vehicle, lojaB.id);
    const report = run(revendaMaisFeed([{ id: 'OUTRO', chassi: '9BGRD08X04G117974', placa: 'XYZ9K88' }]), {
      existing: [noPatioDaB],
    });

    const change = missingChange(report);
    assert.equal(change?.kind === 'MISSING' && change.action, MissingAction.FLAGGED_ON_EXTENDED_CUSTODY);
    assert.equal(change?.kind === 'MISSING' && change.vehicle.commercialStatus, CommercialStatus.AVAILABLE);
    assert.equal(change?.kind === 'MISSING' && change.vehicle.missingFromFeed, true);
  });

  test('com trava ativa: a decisao fica para quando a trava cair', () => {
    const travado: Vehicle = {
      ...(created(run(revendaMaisFeed([{}])))[0] as Vehicle),
      commercialStatus: CommercialStatus.LOCKED,
      activeLockId: asLockId('lck_1'),
    };
    const report = run(revendaMaisFeed([{ id: 'OUTRO', chassi: '9BGRD08X04G117974', placa: 'XYZ9K88' }]), {
      existing: [travado],
    });

    const change = missingChange(report);
    assert.equal(change?.kind === 'MISSING' && change.action, MissingAction.DEFERRED_UNTIL_LOCK_ENDS);
    assert.equal(change?.kind === 'MISSING' && change.vehicle.commercialStatus, CommercialStatus.LOCKED);
  });

  test('veiculo de outro integrador nao e afetado pela sincronizacao deste', () => {
    const doOutroFeed: Vehicle = {
      ...buildVehicle({ ownerStoreId: lojaA.id, createdAt: T0 }),
      source: { provider: 'motors', externalId: 'MT-1', contentHash: 'x', lastSyncedAt: T0 },
    };
    const report = run(revendaMaisFeed([{}]), { existing: [doOutroFeed] });
    assert.equal(report.counts.missing, 0);
  });
});

describe('duplicidade de chassi na rede', () => {
  test('duas lojas nao podem anunciar o mesmo veiculo', () => {
    // E exatamente o risco de venda duplicada que a plataforma existe para impedir.
    const report = run(revendaMaisFeed([{}]), {
      chassisOwners: new Map([['9BWZZZ377VT004251', lojaB.id]]),
    });

    assert.equal(report.counts.created, 0);
    assert.equal(report.issues[0]?.code, 'DUPLICATE_VIN_IN_NETWORK');
    assert.equal(report.issues[0]?.details?.['ownerStoreId'], lojaB.id);
    assert.ok(report.events.some((e) => e.type === 'feed.duplicate_vin_detected'));
  });

  test('a propria loja reanunciando o proprio chassi nao e duplicidade', () => {
    const report = run(revendaMaisFeed([{}]), {
      chassisOwners: new Map([['9BWZZZ377VT004251', lojaA.id]]),
    });
    assert.equal(report.counts.created, 1);
  });
});
