/**
 * Constituicao da rede para desenvolvimento e demonstracao.
 *
 * Cria o cluster do piloto — Curitiba e Regiao Metropolitana — com as lojas
 * fundadoras, titular e vendedor de cada uma, chaves de API previsiveis
 * e um estoque inicial de exemplo. Serve para poder exercitar a API por
 * completo em um `npm start` sem preparar nada antes.
 *
 * As chaves geradas aqui sao FIXAS e visiveis no log. Isso e proposital para
 * desenvolvimento — e o motivo pelo qual `SEED_DEMO_DATA=false` desliga tudo.
 */

import { StoreStatus, UserRole, type NetworkUser, type Store } from '../domain/network/store.ts';
import { MemberKind, memberFromFirstStore, type Member } from '../domain/network/member.ts';
import { PILOT_TARIFF } from '../domain/billing/tariff.ts';
import { asClusterId, asMemberId, asStoreId, asUserId, asVehicleId } from '../domain/shared/ids.ts';
import {
  type Cluster,
  ClusterStatus,
  DEFAULT_FOUNDING_WINDOW_DAYS,
} from '../domain/cluster/cluster.ts';
import { fromReais } from '../domain/shared/money.ts';
import { DAY } from '../domain/shared/clock.ts';
import {
  type Vehicle,
  FuelType,
  InspectionStatus,
  TradeInStance,
  TransmissionType,
  VehicleAngle,
  createVehicle,
} from '../domain/vehicle/vehicle.ts';
import type { Actor, AppContext } from '../application/context.ts';
import { chargeAdhesion, registerChargePayment } from '../application/billing-service.ts';
import type { ApiKeyRegistry } from './auth/api-keys.ts';

export type SeededStore = {
  readonly member: Member;
  readonly store: Store;
  readonly principal: NetworkUser;
  readonly salesperson: NetworkUser;
  readonly principalApiKey: string;
  readonly salespersonApiKey: string;
};

/**
 * O ator de um patio semeado. Existe porque montar `{ member, store, user }` na
 * mao em cada teste e no roteiro convida ao erro que o tipo passou a impedir:
 * juntar a loja de uma empresa com o membro de outra.
 */
export function seededActor(
  seeded: SeededStore,
  role: 'principal' | 'salesperson' = 'principal',
): Actor {
  return { member: seeded.member, store: seeded.store, user: seeded[role] };
}

export type SeedResult = {
  readonly cluster: Cluster;
  readonly stores: readonly SeededStore[];
  readonly vehicles: readonly Vehicle[];
};

/**
 * O piloto. Todas as fundadoras cabem num raio em que o carro sai de um patio e
 * chega no outro dentro da manha — que e o que faz o SLA de 4 horas uteis ser
 * uma promessa, e nao uma ficcao.
 *
 * Sao dez lojas aqui porque dez e o alvo do piloto, nao porque dez seja
 * exigido: a praca abre com quem entrou na janela de fundacao. Tirar linhas
 * desta lista nao quebra nada — nenhum lugar do sistema declara a contagem.
 * O caminho da praca pequena e exercitado em `membership.test.ts`, com
 * `buildFoundingNetwork(3)`.
 *
 * Sao Jose dos Pinhais fica a ~15 km de Curitiba, Colombo a ~18, Pinhais a ~12,
 * Araucaria a ~27. O raio declarado de 60 km cobre a regiao com folga e ainda
 * fica bem abaixo do teto de 300 km em que a custodia fisica deixa de fechar.
 */
const PILOT_CLUSTER_SLUG = 'curitiba-rmc';

// A Sul Car entra como CASH_ONLY de proposito: sem uma loja assim, o piloto
// nunca exercita o caminho que este campo existe para cobrir.
//
// As coordenadas sao dos centros dos municipios, e nao de enderecos reais: o
// que o piloto precisa e que as dez fiquem a distancias plausiveis umas das
// outras, para a conferencia da entrega (raio de 500 m) ter o que rejeitar.
const FOUNDERS = [
  { slug: 'prime', tradeName: 'Prime Motors', city: 'Curitiba', state: 'PR', cnpj: '11222333000181', tradeInDefault: TradeInStance.CONSIDERS, yard: { lat: -25.4284, lng: -49.2733 } },
  { slug: 'veloz', tradeName: 'Veloz Seminovos', city: 'Sao Jose dos Pinhais', state: 'PR', cnpj: '04252011000110', tradeInDefault: TradeInStance.CONSIDERS, yard: { lat: -25.5307, lng: -49.2064 } },
  { slug: 'central', tradeName: 'Garagem Central', city: 'Curitiba', state: 'PR', cnpj: '34028316000103', tradeInDefault: TradeInStance.CONSIDERS, yard: { lat: -25.4372, lng: -49.2695 } },
  { slug: 'norte', tradeName: 'Norte Automoveis', city: 'Colombo', state: 'PR', cnpj: '33000167000101', tradeInDefault: TradeInStance.CONSIDERS, yard: { lat: -25.2917, lng: -49.2242 } },
  { slug: 'sul', tradeName: 'Sul Car', city: 'Araucaria', state: 'PR', cnpj: '60746948000112', tradeInDefault: TradeInStance.CASH_ONLY, yard: { lat: -25.5925, lng: -49.4103 } },
  { slug: 'vialivre', tradeName: 'Via Livre Veiculos', city: 'Pinhais', state: 'PR', cnpj: '47960950000121', tradeInDefault: TradeInStance.CONSIDERS, yard: { lat: -25.4447, lng: -49.1925 } },
  { slug: 'planalto', tradeName: 'Planalto Veiculos', city: 'Campo Largo', state: 'PR', cnpj: '19283746000188', tradeInDefault: TradeInStance.CONSIDERS, yard: { lat: -25.4592, lng: -49.5278 } },
  { slug: 'atlas', tradeName: 'Atlas Automoveis', city: 'Curitiba', state: 'PR', cnpj: '28574639000108', tradeInDefault: TradeInStance.CONSIDERS, yard: { lat: -25.4809, lng: -49.3003 } },
  { slug: 'iguacu', tradeName: 'Iguacu Motors', city: 'Piraquara', state: 'PR', cnpj: '37615284000130', tradeInDefault: TradeInStance.CASH_ONLY, yard: { lat: -25.4419, lng: -49.0628 } },
  { slug: 'bandeirante', tradeName: 'Bandeirante Seminovos', city: 'Fazenda Rio Grande', state: 'PR', cnpj: '41962853000191', tradeInDefault: TradeInStance.CONSIDERS, yard: { lat: -25.6625, lng: -49.3078 } },
] as const;

const DEMO_VEHICLES = [
  {
    ownerIndex: 0,
    plate: 'RGT4B71',
    chassis: '9BWZZZ377VT004251',
    brand: 'Chevrolet',
    model: 'Onix',
    version: '1.0 Turbo LTZ',
    manufactureYear: 2022,
    modelYear: 2023,
    mileageKm: 38_400,
    color: 'Prata',
    fuel: FuelType.FLEX,
    transmission: TransmissionType.AUTOMATIC,
    publicPrice: 92_900,
    netPrice: 85_000,
  },
  {
    ownerIndex: 1,
    plate: 'KLM8D42',
    chassis: '9BGRD08X04G117974',
    brand: 'Fiat',
    model: 'Argo',
    version: '1.3 Drive',
    manufactureYear: 2021,
    modelYear: 2022,
    mileageKm: 54_210,
    color: 'Branco',
    fuel: FuelType.FLEX,
    transmission: TransmissionType.MANUAL,
    publicPrice: 68_900,
    netPrice: 62_500,
  },
  {
    ownerIndex: 2,
    plate: 'PQR2C58',
    chassis: '93YBB05654J019381',
    brand: 'Toyota',
    model: 'Corolla',
    version: '2.0 XEi',
    manufactureYear: 2021,
    modelYear: 2022,
    mileageKm: 61_800,
    color: 'Preto',
    fuel: FuelType.FLEX,
    transmission: TransmissionType.CVT,
    publicPrice: 139_900,
    netPrice: 128_000,
  },
  {
    ownerIndex: 0,
    plate: 'HJK5F19',
    chassis: '9BD15822TC1234567',
    brand: 'Jeep',
    model: 'Renegade',
    version: '1.3 T270 Longitude',
    manufactureYear: 2022,
    modelYear: 2023,
    mileageKm: 29_450,
    color: 'Cinza',
    fuel: FuelType.FLEX,
    transmission: TransmissionType.AUTOMATIC,
    publicPrice: 128_900,
    netPrice: 118_500,
  },
  {
    ownerIndex: 3,
    plate: 'TUV7H33',
    chassis: '9BFZH55L5F8123456',
    brand: 'Volkswagen',
    model: 'T-Cross',
    version: '1.0 TSI Comfortline',
    manufactureYear: 2022,
    modelYear: 2022,
    mileageKm: 44_900,
    color: 'Azul',
    fuel: FuelType.FLEX,
    transmission: TransmissionType.AUTOMATIC,
    publicPrice: 118_500,
    netPrice: 108_900,
  },
] as const;

export type SeedOptions = {
  /** Semear o estoque de exemplo. O roteiro de demonstracao desliga para que
   *  os veiculos entrem pelo feed XML, como acontece na operacao real. */
  readonly includeVehicles?: boolean;
};

export async function seedFoundingNetwork(
  context: AppContext,
  apiKeys: ApiKeyRegistry,
  options: SeedOptions = {},
): Promise<SeedResult> {
  const now = context.clock.now();

  const cluster: Cluster = {
    id: asClusterId(`clu_${PILOT_CLUSTER_SLUG.replaceAll('-', '_')}`),
    name: 'Curitiba e Regiao',
    slug: PILOT_CLUSTER_SLUG,
    state: 'PR',
    cities: [
      'Curitiba',
      'Sao Jose dos Pinhais',
      'Colombo',
      'Araucaria',
      'Pinhais',
      'Campo Largo',
      'Almirante Tamandare',
      'Piraquara',
      'Fazenda Rio Grande',
      'Quatro Barras',
    ],
    operatingRadiusKm: 60,
    status: ClusterStatus.ACTIVE,
    foundedAt: now,
    // A janela do piloto fica ABERTA no seed de proposito: e o unico jeito de a
    // demonstracao exercitar o caminho da fundadora que entra depois. Fechar a
    // janela e uma linha aqui, e e o que vai acontecer na praca de verdade.
    foundingWindowEndsAt: now + DEFAULT_FOUNDING_WINDOW_DAYS * DAY,
  };
  await context.repos.clusters.save(cluster);

  const stores: SeededStore[] = [];

  for (const [index, founder] of FOUNDERS.entries()) {
    const storeId = asStoreId(`str_${founder.slug}`);
    const memberId = asMemberId(`mbr_${founder.slug}`);
    const profile = {
      legalName: `${founder.tradeName} Comercio de Veiculos LTDA`,
      tradeName: founder.tradeName,
      cnpj: founder.cnpj,
      city: founder.city,
      state: founder.state,
      phone: `4132${String(index).padStart(2, '0')}4455`,
      email: `contato@${founder.slug}.com.br`,
      responsibleName: `Titular ${founder.tradeName}`,
      yard: founder.yard,
    };

    // Uma empresa por fundadora, com um patio. A Prime ganha um segundo patio
    // depois do laco — e o unico jeito de o piloto exercitar a linha de R$ 159.
    const member = memberFromFirstStore(
      memberId,
      cluster.id,
      profile,
      MemberKind.FOUNDER,
      null,
      now,
      PILOT_TARIFF.version,
    );

    const store: Store = {
      id: storeId,
      memberId,
      clusterId: cluster.id,
      profile,
      status: StoreStatus.ACTIVE,
      joinedAt: now,
      tradeInDefault: founder.tradeInDefault,
    };

    const principal: NetworkUser = {
      id: asUserId(`usr_${founder.slug}_titular`),
      storeId,
      name: `Titular ${founder.tradeName}`,
      email: `titular@${founder.slug}.com.br`,
      role: UserRole.PRINCIPAL,
      active: true,
    };
    const salesperson: NetworkUser = {
      id: asUserId(`usr_${founder.slug}_vendedor`),
      storeId,
      name: `Vendedor ${founder.tradeName}`,
      email: `vendas@${founder.slug}.com.br`,
      role: UserRole.SALESPERSON,
      active: true,
    };

    await context.repos.members.save(member);
    await context.repos.stores.save(store);
    await context.repos.users.save(principal);
    await context.repos.users.save(salesperson);

    const principalApiKey = `demo_${founder.slug}_titular`;
    const salespersonApiKey = `demo_${founder.slug}_vendedor`;
    apiKeys.register(principalApiKey, { storeId, userId: principal.id, label: `${founder.tradeName} / titular` });
    apiKeys.register(salespersonApiKey, {
      storeId,
      userId: salesperson.id,
      label: `${founder.tradeName} / vendedor`,
    });

    // A adesao das fundadoras: emitida e ja quitada. Elas pagaram na
    // constituicao — comecar o piloto com dez empresas a dez dias do
    // vencimento faria a primeira varredura parecer uma crise de inadimplencia.
    const adesao = await chargeAdhesion(context, member);
    if (adesao.ok) await registerChargePayment(context, adesao.value.id);

    stores.push({ member, store, principal, salesperson, principalApiKey, salespersonApiKey });
  }

  // O segundo patio da Prime. Existe para o piloto exercitar o caso que a
  // tabela de precos criou: R$ 599 pela empresa com a primeira loja inclusa,
  // R$ 159 por esta. Sem uma empresa de duas lojas no seed, o unico caminho
  // testado seria o de uma loja por empresa — que e justamente o modelo antigo.
  const matriz = stores[0]!;
  const segundoPatio: Store = {
    id: asStoreId('str_prime_boqueirao'),
    memberId: matriz.member.id,
    clusterId: cluster.id,
    profile: {
      ...matriz.store.profile,
      tradeName: 'Prime Motors Boqueirao',
      // Mesma raiz, ordem diferente: e assim que filial se identifica no Brasil.
      cnpj: '11222333000262',
      city: 'Curitiba',
      // Boqueirao, ~6 km da matriz no centro. Longe o bastante para uma entrega
      // declarada num patio nao passar na conferencia do outro.
      yard: { lat: -25.4890, lng: -49.2450 },
    },
    status: StoreStatus.ACTIVE,
    joinedAt: now,
    tradeInDefault: matriz.store.tradeInDefault,
  };
  await context.repos.stores.save(segundoPatio);

  const gerenteBoqueirao: NetworkUser = {
    id: asUserId('usr_prime_boqueirao_gerente'),
    storeId: segundoPatio.id,
    name: 'Gerente Prime Boqueirao',
    email: 'boqueirao@prime.com.br',
    role: UserRole.MANAGER,
    active: true,
  };
  await context.repos.users.save(gerenteBoqueirao);
  apiKeys.register('demo_prime_boqueirao', {
    storeId: segundoPatio.id,
    userId: gerenteBoqueirao.id,
    label: 'Prime Motors Boqueirao / gerente',
  });

  const vehicles: Vehicle[] = [];
  if (options.includeVehicles === false) return { cluster, stores, vehicles };

  for (const [index, spec] of DEMO_VEHICLES.entries()) {
    const owner = stores[spec.ownerIndex];
    if (owner === undefined) continue;

    const created = createVehicle({
      id: asVehicleId(`veh_demo_${index + 1}`),
      clusterId: cluster.id,
      ownerStoreId: owner.store.id,
      tradeInStance: owner.store.tradeInDefault,
      plate: spec.plate,
      chassis: spec.chassis,
      specs: {
        brand: spec.brand,
        model: spec.model,
        version: spec.version,
        manufactureYear: spec.manufactureYear,
        modelYear: spec.modelYear,
        mileageKm: spec.mileageKm,
        color: spec.color,
        fuel: spec.fuel,
        transmission: spec.transmission,
        doors: 4,
        optionals: ['Ar-condicionado', 'Direcao eletrica', 'Multimidia', 'Camera de re'],
        photos: [
          `https://cdn.${FOUNDERS[spec.ownerIndex]?.slug ?? 'loja'}.com.br/estoque/${spec.plate}-1.jpg`,
          `https://cdn.${FOUNDERS[spec.ownerIndex]?.slug ?? 'loja'}.com.br/estoque/${spec.plate}-2.jpg`,
        ],
      },
      inspection: {
        status: InspectionStatus.APPROVED,
        reportNumber: `LC-2026-${String(4500 + index)}`,
        provider: 'Cautelar Brasil',
        issuedAt: now - 10 * DAY,
        expiresAt: now + 80 * DAY,
        fileUrl: `https://laudos.exemplo.com.br/LC-2026-${String(4500 + index)}.pdf`,
      },
      publicPrice: fromReais(spec.publicPrice),
      netPrice: fromReais(spec.netPrice),
      now,
    });

    if (created.ok) {
      // Material neutro ja publicado: e o que a parceira baixa para anunciar.
      // As URLs sao da plataforma, nunca do CDN da loja dona.
      const withMaterial: Vehicle = {
        ...created.value,
        neutralPhotos: [
          VehicleAngle.FRONT,
          VehicleAngle.REAR,
          VehicleAngle.INTERIOR,
          VehicleAngle.DASHBOARD,
        ].map((angle) => ({
          url: `https://midia.rede-auto.com.br/neutras/${created.value.id}/${angle.toLowerCase()}.jpg`,
          angle,
          publishedAt: now,
        })),
      };
      await context.repos.vehicles.save(withMaterial);
      vehicles.push(withMaterial);
    }
  }

  return { cluster, stores, vehicles };
}

/** Resumo legivel das chaves criadas, impresso no start em desenvolvimento. */
export function describeSeed(seed: SeedResult): string {
  const lines = [
    `Rede constituida com ${seed.stores.length} lojas fundadoras e ${seed.vehicles.length} veiculos de exemplo.`,
    '',
    'Chaves de API de desenvolvimento (Authorization: Bearer <chave>):',
  ];
  for (const seeded of seed.stores) {
    lines.push(
      `  ${seeded.store.profile.tradeName.padEnd(20)} titular=${seeded.principalApiKey.padEnd(24)} vendedor=${seeded.salespersonApiKey}`,
    );
  }
  return lines.join('\n');
}
