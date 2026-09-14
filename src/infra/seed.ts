/**
 * Constituicao da rede para desenvolvimento e demonstracao.
 *
 * Cria as 6 lojas fundadoras com titular e vendedor, chaves de API previsiveis
 * e um estoque inicial de exemplo. Serve para poder exercitar a API por
 * completo em um `npm start` sem preparar nada antes.
 *
 * As chaves geradas aqui sao FIXAS e visiveis no log. Isso e proposital para
 * desenvolvimento — e o motivo pelo qual `SEED_DEMO_DATA=false` desliga tudo.
 */

import { StoreKind, StoreStatus, UserRole, type NetworkUser, type Store } from '../domain/network/store.ts';
import { asStoreId, asUserId, asVehicleId } from '../domain/shared/ids.ts';
import { fromReais } from '../domain/shared/money.ts';
import { DAY } from '../domain/shared/clock.ts';
import {
  type Vehicle,
  FuelType,
  InspectionStatus,
  TransmissionType,
  VehicleAngle,
  createVehicle,
} from '../domain/vehicle/vehicle.ts';
import type { AppContext } from '../application/context.ts';
import type { ApiKeyRegistry } from './auth/api-keys.ts';

export type SeededStore = {
  readonly store: Store;
  readonly principal: NetworkUser;
  readonly salesperson: NetworkUser;
  readonly principalApiKey: string;
  readonly salespersonApiKey: string;
};

export type SeedResult = {
  readonly stores: readonly SeededStore[];
  readonly vehicles: readonly Vehicle[];
};

const FOUNDERS = [
  { slug: 'prime', tradeName: 'Prime Motors', city: 'Campinas', state: 'SP', cnpj: '11222333000181' },
  { slug: 'veloz', tradeName: 'Veloz Seminovos', city: 'Sao Paulo', state: 'SP', cnpj: '04252011000110' },
  { slug: 'central', tradeName: 'Garagem Central', city: 'Ribeirao Preto', state: 'SP', cnpj: '34028316000103' },
  { slug: 'norte', tradeName: 'Norte Automoveis', city: 'Curitiba', state: 'PR', cnpj: '33000167000101' },
  { slug: 'sul', tradeName: 'Sul Car', city: 'Belo Horizonte', state: 'MG', cnpj: '60746948000112' },
  { slug: 'vialivre', tradeName: 'Via Livre Veiculos', city: 'Porto Alegre', state: 'RS', cnpj: '47960950000121' },
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
  const stores: SeededStore[] = [];

  for (const [index, founder] of FOUNDERS.entries()) {
    const storeId = asStoreId(`str_${founder.slug}`);
    const store: Store = {
      id: storeId,
      profile: {
        legalName: `${founder.tradeName} Comercio de Veiculos LTDA`,
        tradeName: founder.tradeName,
        cnpj: founder.cnpj,
        city: founder.city,
        state: founder.state,
        phone: `19${3200 + index}4455`,
        email: `contato@${founder.slug}.com.br`,
        responsibleName: `Titular ${founder.tradeName}`,
      },
      kind: StoreKind.FOUNDER,
      status: StoreStatus.ACTIVE,
      joinedAt: now,
      sponsorStoreId: null,
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

    stores.push({ store, principal, salesperson, principalApiKey, salespersonApiKey });
  }

  const vehicles: Vehicle[] = [];
  if (options.includeVehicles === false) return { stores, vehicles };

  for (const [index, spec] of DEMO_VEHICLES.entries()) {
    const owner = stores[spec.ownerIndex];
    if (owner === undefined) continue;

    const created = createVehicle({
      id: asVehicleId(`veh_demo_${index + 1}`),
      ownerStoreId: owner.store.id,
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

  return { stores, vehicles };
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
