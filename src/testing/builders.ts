/**
 * Construtores de dados para testes e para o roteiro de demonstracao.
 *
 * Cada builder devolve um agregado valido com defaults sensatos, permitindo que
 * o teste sobrescreva apenas o campo que esta sob analise. Isso mantem os testes
 * legiveis: o que aparece no `overrides` e exatamente o que importa para a regra
 * sendo verificada.
 */

import {
  type NetworkUser,
  type Store,
  type StoreProfile,
  StoreStatus,
  UserRole,
} from '../domain/network/store.ts';
import {
  type Member,
  MemberKind,
  MemberStatus,
  cnpjRootOf,
  memberFromFirstStore,
} from '../domain/network/member.ts';
import {
  type Cluster,
  ClusterStatus,
  DEFAULT_FOUNDING_WINDOW_DAYS,
} from '../domain/cluster/cluster.ts';
import {
  asClusterId,
  asMemberId,
  asStoreId,
  asUserId,
  type ClusterId,
  type StoreId,
  type UserId,
} from '../domain/shared/ids.ts';

/**
 * A praca padrao dos testes. Existir uma so por default e proposital: o teste
 * que quer provar a fronteira precisa **dizer** que ha duas pracas, e isso fica
 * visivel na leitura.
 */
export const TEST_CLUSTER_ID: ClusterId = asClusterId('clu_test');

/**
 * A praca dos testes, com a janela de fundacao ABERTA por padrao.
 *
 * O default e o aberto porque e o estado em que uma praca nasce, e porque o
 * teste que precisa do outro lado — a loja que chega tarde e entra como membro
 * — tem de dizer isso em voz alta: `buildCluster({ foundingWindowEndsAt: X })`.
 * O contrario esconderia a regra mais nova do credenciamento atras de um
 * default silencioso.
 */
export function buildCluster(overrides: Partial<Cluster> = {}): Cluster {
  const foundedAt = overrides.foundedAt ?? 0;
  return {
    id: overrides.id ?? TEST_CLUSTER_ID,
    name: overrides.name ?? 'Praca de Teste',
    slug: overrides.slug ?? 'praca-teste',
    state: overrides.state ?? 'SP',
    cities: overrides.cities ?? ['Campinas'],
    operatingRadiusKm: overrides.operatingRadiusKm ?? 60,
    status: overrides.status ?? ClusterStatus.ACTIVE,
    foundedAt,
    foundingWindowEndsAt:
      overrides.foundingWindowEndsAt ?? foundedAt + DEFAULT_FOUNDING_WINDOW_DAYS * DAY,
  };
}

/** CNPJs com digito verificador valido, para nao esbarrar na validacao real. */
const VALID_CNPJS = [
  '11222333000181',
  '04252011000110',
  '34028316000103',
  '33000167000101',
  '60746948000112',
  '47960950000121',
  '07526557000100',
  '02558157000162',
  '19283746000188',
  '28574639000108',
  '37615284000130',
  '41962853000191',
];

let cnpjCursor = 0;

export function nextValidCnpj(): string {
  const cnpj = VALID_CNPJS[cnpjCursor % VALID_CNPJS.length] as string;
  cnpjCursor += 1;
  return cnpj;
}

export function resetCnpjCursor(): void {
  cnpjCursor = 0;
}

export function buildStoreProfile(overrides: Partial<StoreProfile> = {}): StoreProfile {
  return {
    legalName: 'Auto Center Modelo Comercio de Veiculos LTDA',
    tradeName: 'Auto Center Modelo',
    cnpj: nextValidCnpj(),
    city: 'Campinas',
    state: 'SP',
    phone: '1932334455',
    email: 'contato@automodelo.com.br',
    responsibleName: 'Maria Souza',
    ...overrides,
  };
}

export function buildStore(overrides: Partial<Store> = {}): Store {
  return {
    id: overrides.id ?? asStoreId(`str_${Math.random().toString(36).slice(2, 10)}`),
    memberId: overrides.memberId ?? asMemberId(`mbr_${Math.random().toString(36).slice(2, 10)}`),
    clusterId: overrides.clusterId ?? TEST_CLUSTER_ID,
    profile: overrides.profile ?? buildStoreProfile(),
    status: overrides.status ?? StoreStatus.ACTIVE,
    tradeInDefault: overrides.tradeInDefault ?? TradeInStance.CONSIDERS,
    joinedAt: overrides.joinedAt ?? 0,
  };
}

export function buildMember(overrides: Partial<Member> = {}): Member {
  const profile = buildStoreProfile();
  return {
    id: overrides.id ?? asMemberId(`mbr_${Math.random().toString(36).slice(2, 10)}`),
    clusterId: overrides.clusterId ?? TEST_CLUSTER_ID,
    legalName: overrides.legalName ?? profile.legalName,
    cnpjRoot: overrides.cnpjRoot ?? cnpjRootOf(profile.cnpj),
    responsibleName: overrides.responsibleName ?? profile.responsibleName,
    email: overrides.email ?? profile.email,
    phone: overrides.phone ?? profile.phone,
    kind: overrides.kind ?? MemberKind.FOUNDER,
    status: overrides.status ?? MemberStatus.ACTIVE,
    joinedAt: overrides.joinedAt ?? 0,
    sponsorMemberId: overrides.sponsorMemberId ?? null,
    tariffVersion: overrides.tariffVersion ?? PILOT_TARIFF.version,
  };
}

/**
 * Empresa e patio casados, que e como eles existem de verdade. Um `buildStore`
 * solto tem `memberId` aleatorio e por isso reprova em `canTransact` — o que e
 * o comportamento certo, e este par existe para o teste que nao quer prova-lo.
 */
export function buildMemberWithStore(
  overrides: { member?: Partial<Member>; store?: Partial<Store> } = {},
): { member: Member; store: Store } {
  const member = buildMember(overrides.member);
  const store = buildStore({
    ...overrides.store,
    memberId: member.id,
    clusterId: member.clusterId,
  });
  return { member, store };
}

export function buildUser(storeId: StoreId, overrides: Partial<NetworkUser> = {}): NetworkUser {
  return {
    id: overrides.id ?? asUserId(`usr_${Math.random().toString(36).slice(2, 10)}`),
    storeId,
    name: overrides.name ?? 'Carlos Vendedor',
    email: overrides.email ?? 'carlos@loja.com.br',
    role: overrides.role ?? UserRole.PRINCIPAL,
    active: overrides.active ?? true,
  };
}

export type FoundingNetwork = {
  /** As EMPRESAS fundadoras: a unidade que endossa e que paga. */
  readonly members: readonly Member[];
  /** Um patio de cada, na mesma ordem. */
  readonly founders: readonly Store[];
  readonly principals: readonly NetworkUser[];
  memberAt(index: number): Member;
  /** A empresa de um patio. Poupa o teste de casar indices na mao. */
  memberOf(store: Store): Member;
  founderAt(index: number): Store;
  principalAt(index: number): NetworkUser;
};

/**
 * As lojas fundadoras da praca mais o titular de cada uma.
 *
 * `count` e parametro, e nao constante, porque o numero de fundadoras e
 * flexivel por desenho: a praca abre com quem entrou na janela. Os testes de
 * alcance do endosso dependem justamente de poder pedir uma praca pequena.
 */
export function buildFoundingNetwork(count = 6): FoundingNetwork {
  resetCnpjCursor();
  const names = [
    'Prime Motors',
    'Veloz Seminovos',
    'Garagem Central',
    'Norte Automoveis',
    'Sul Car',
    'Via Livre Veiculos',
    'Alfa Multimarcas',
    'Beta Automoveis',
  ];
  const cities: ReadonlyArray<readonly [string, string]> = [
    ['Campinas', 'SP'],
    ['Sao Paulo', 'SP'],
    ['Ribeirao Preto', 'SP'],
    ['Curitiba', 'PR'],
    ['Belo Horizonte', 'MG'],
    ['Porto Alegre', 'RS'],
    ['Goiania', 'GO'],
    ['Salvador', 'BA'],
  ];

  const members: Member[] = [];
  const founders: Store[] = [];
  const principals: NetworkUser[] = [];

  for (let index = 0; index < count; index += 1) {
    const tradeName = names[index] ?? `Loja Fundadora ${index + 1}`;
    const [city, state] = cities[index] ?? (['Campinas', 'SP'] as const);
    const storeId = asStoreId(`str_f${index + 1}`);
    const memberId = asMemberId(`mbr_f${index + 1}`);
    const profile = buildStoreProfile({
      tradeName,
      legalName: `${tradeName} Comercio de Veiculos LTDA`,
      city,
      state,
      email: `contato@${slug(tradeName)}.com.br`,
      responsibleName: `Titular ${index + 1}`,
    });

    members.push(
      memberFromFirstStore(
        memberId,
        TEST_CLUSTER_ID,
        profile,
        MemberKind.FOUNDER,
        null,
        0,
        PILOT_TARIFF.version,
      ),
    );
    founders.push({
      id: storeId,
      memberId,
      clusterId: TEST_CLUSTER_ID,
      tradeInDefault: TradeInStance.CONSIDERS,
      profile,
      status: StoreStatus.ACTIVE,
      joinedAt: 0,
    });
    principals.push({
      id: asUserId(`usr_f${index + 1}`),
      storeId,
      name: `Titular ${index + 1}`,
      email: `titular${index + 1}@${slug(tradeName)}.com.br`,
      role: UserRole.PRINCIPAL,
      active: true,
    });
  }

  return {
    members,
    founders,
    principals,
    memberAt: (index) => members[index] as Member,
    memberOf: (store) => {
      const found = members.find((m) => m.id === store.memberId);
      if (found === undefined) throw new Error(`patio sem empresa na rede de teste: ${store.id}`);
      return found;
    },
    founderAt: (index) => founders[index] as Store,
    principalAt: (index) => principals[index] as NetworkUser,
  };
}

function slug(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export const ids = {
  store: (value: string): StoreId => asStoreId(value),
  user: (value: string): UserId => asUserId(value),
};

// ---------------------------------------------------------------------------
// Veiculos
// ---------------------------------------------------------------------------

import {
  type InspectionReport,
  type Vehicle,
  type VehicleSpecs,
  CommercialStatus,
  FuelType,
  InspectionStatus,
  NO_FEED_SOURCE,
  PhysicalState,
  TradeInStance,
  TransmissionType,
  VehicleAngle,
  type NeutralPhoto,
} from '../domain/vehicle/vehicle.ts';
import { asVehicleId, type VehicleId } from '../domain/shared/ids.ts';
import { fromReais } from '../domain/shared/money.ts';
import { DAY } from '../domain/shared/clock.ts';
import { PILOT_TARIFF } from '../domain/billing/tariff.ts';

export function buildSpecs(overrides: Partial<VehicleSpecs> = {}): VehicleSpecs {
  return {
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
    optionals: ['Ar-condicionado', 'Direcao eletrica', 'Multimidia'],
    photos: ['https://cdn.exemplo.com/onix-1.jpg', 'https://cdn.exemplo.com/onix-2.jpg'],
    ...overrides,
  };
}

/** Conjunto neutro minimo: frente, traseira e interior, como exige o material. */
export function buildNeutralPhotos(now: number): NeutralPhoto[] {
  return [VehicleAngle.FRONT, VehicleAngle.REAR, VehicleAngle.INTERIOR, VehicleAngle.DASHBOARD].map(
    (angle) => ({
      url: `https://midia.rede-auto.com.br/neutras/${angle.toLowerCase()}.jpg`,
      angle,
      publishedAt: now,
    }),
  );
}

export function buildApprovedInspection(now: number, overrides: Partial<InspectionReport> = {}): InspectionReport {
  return {
    status: InspectionStatus.APPROVED,
    reportNumber: 'LC-2026-004512',
    provider: 'Cautelar Brasil',
    issuedAt: now - 7 * DAY,
    expiresAt: now + 83 * DAY,
    fileUrl: 'https://laudos.exemplo.com.br/LC-2026-004512.pdf',
    ...overrides,
  };
}

let vehicleCounter = 0;

/**
 * Veiculo pronto para circular: laudo aprovado, DISPONIVEL, no patio da dona.
 * O teste sobrescreve so o que estiver sob analise.
 */
export function buildVehicle(overrides: Partial<Vehicle> = {}): Vehicle {
  vehicleCounter += 1;
  const now = overrides.createdAt ?? 0;
  const ownerStoreId = overrides.ownerStoreId ?? asStoreId('str_f1');
  const id: VehicleId = overrides.id ?? asVehicleId(`veh_${String(vehicleCounter).padStart(4, '0')}`);

  return {
    id,
    clusterId: overrides.clusterId ?? TEST_CLUSTER_ID,
    ownerStoreId,
    plate: overrides.plate ?? `ABC${String(1000 + (vehicleCounter % 9000))}`,
    chassis: overrides.chassis ?? `9BWZZZ377VT${String(100000 + vehicleCounter).slice(0, 6)}`,
    specs: overrides.specs ?? buildSpecs(),
    inspection: overrides.inspection ?? buildApprovedInspection(now),
    tradeInPolicy: overrides.tradeInPolicy ?? {
      stance: TradeInStance.CONSIDERS,
      note: null,
      updatedAt: now,
    },
    neutralPhotos: overrides.neutralPhotos ?? buildNeutralPhotos(now),
    pricing: overrides.pricing ?? {
      publicPrice: fromReais(92_900),
      netPrice: fromReais(85_000),
      updatedAt: now,
    },
    commercialStatus: overrides.commercialStatus ?? CommercialStatus.AVAILABLE,
    activeLockId: overrides.activeLockId ?? null,
    physical: overrides.physical ?? {
      state: PhysicalState.AT_YARD,
      custodianStoreId: ownerStoreId,
      inboundStoreId: null,
      since: now,
      openTransferId: null,
    },
    source: overrides.source ?? NO_FEED_SOURCE,
    pendingNetPrice: overrides.pendingNetPrice ?? null,
    missingFromFeed: overrides.missingFromFeed ?? false,
    createdAt: now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

/** Mesmo veiculo, mas fisicamente no patio de outra loja (estoque avancado). */
export function atYardOf(vehicle: Vehicle, custodianStoreId: StoreId, since = 0): Vehicle {
  return {
    ...vehicle,
    physical: {
      state: PhysicalState.AT_YARD,
      custodianStoreId,
      inboundStoreId: null,
      since,
      openTransferId: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Termos de vistoria
// ---------------------------------------------------------------------------

import {
  type InspectionTerm,
  type InspectionTermContent,
  type Signer,
  PhotoAngle,
  REQUIRED_PHOTO_ANGLES,
  sealTerm,
} from '../domain/custody/custody.ts';
import { unwrap as unwrapResult } from '../domain/shared/result.ts';

/** Conjunto minimo de fotos que satisfaz `REQUIRED_PHOTO_ANGLES`. */
export function buildTermPhotos(extra: readonly PhotoAngle[] = []): Array<{ angle: PhotoAngle; url: string }> {
  return [...REQUIRED_PHOTO_ANGLES, ...extra].map((angle) => ({
    angle,
    url: `https://cdn.exemplo.com/vistoria/${angle.toLowerCase()}.jpg`,
  }));
}

export function buildTermContent(
  overrides: Partial<InspectionTermContent> = {},
): Record<string, unknown> {
  return {
    odometerKm: 38_400,
    fuelEighths: 4,
    photos: buildTermPhotos(),
    damages: [],
    observations: null,
    geolocation: null,
    ...overrides,
  };
}

/** CPFs com digito verificador valido, para atravessar a validacao real. */
const VALID_CPFS = ['52998224725', '11144477735', '39053344705'];

export function buildSigner(storeId: StoreId, overrides: Partial<Signer> = {}): Signer {
  return {
    name: 'Roberto Conferente',
    document: overrides.document ?? (VALID_CPFS[0] as string),
    role: 'Gerente de patio',
    userId: overrides.userId ?? asUserId('usr_conf'),
    ...overrides,
    storeId,
  };
}

/** Termo pronto e assinado. Falha alto se os dados forem invalidos. */
export function buildSignedTerm(
  storeId: StoreId,
  signedAt: number,
  contentOverrides: Partial<InspectionTermContent> = {},
  signerOverrides: Partial<Signer> = {},
): InspectionTerm {
  return unwrapResult(
    sealTerm(buildTermContent(contentOverrides), buildSigner(storeId, signerOverrides), signedAt),
  );
}
