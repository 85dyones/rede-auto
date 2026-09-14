/**
 * Kit de material — o que a loja parceira baixa para anunciar o carro.
 *
 * A plataforma nao tem superficie para o consumidor. Ela nao hospeda anuncio,
 * nao manda link para cliente e nao aparece em lugar nenhum da venda final. O
 * que ela faz e entregar a loja parceira, ja logada, o material pronto para ela
 * usar no canal DELA — site proprio, WhatsApp, vitrine.
 *
 * Por isso o anonimato muda de lugar em relacao a um marketplace. Dentro da
 * plataforma nao ha segredo entre parceiras: elas se conhecem, precisam ver de
 * quem e o carro, qual o liquido e o que diz o laudo. O que precisa ser neutro e
 * o material que SAI daqui — porque ele vai ser republicado por outra loja, e
 * qualquer marca da dona no material entregaria a origem no primeiro anuncio.
 *
 * Fora do kit de proposito:
 *   - o CRLV, que esta no nome da loja dona e a identificaria;
 *   - o preco liquido de repasse, que e acordo entre as duas lojas;
 *   - as fotos do feed, que foram tiradas para o anuncio da propria dona e
 *     quase sempre trazem adesivo, fachada ou placa legivel.
 */

import type { Instant } from '../shared/clock.ts';
import { toIso } from '../shared/clock.ts';
import { type Money, toJSON as moneyToJSON } from '../shared/money.ts';
import type { Store } from '../network/store.ts';
import { formatPhone } from '../network/store.ts';
import {
  type Vehicle,
  type VehicleAngle,
  FuelType,
  InspectionStatus,
  MATERIAL_REQUIRED_ANGLES,
  TransmissionType,
  describeVehicle,
  isInspectionValid,
} from '../vehicle/vehicle.ts';

export type MaterialReadiness = {
  readonly photoCount: number;
  /** Angulos obrigatorios que ainda faltam. Vazio significa material completo. */
  readonly missingAngles: readonly VehicleAngle[];
  readonly hasInspectionFile: boolean;
  readonly ready: boolean;
};

export function assessMaterial(vehicle: Vehicle): MaterialReadiness {
  const present = new Set(vehicle.neutralPhotos.map((photo) => photo.angle));
  const missingAngles = MATERIAL_REQUIRED_ANGLES.filter((angle) => !present.has(angle));
  return {
    photoCount: vehicle.neutralPhotos.length,
    missingAngles,
    hasInspectionFile: vehicle.inspection.fileUrl !== null,
    ready: missingAngles.length === 0,
  };
}

/**
 * Ficha tecnica neutra. Montada como LISTA DE INCLUSAO, campo a campo, e nunca
 * por spread do agregado: com spread, todo campo novo do veiculo passaria a
 * vazar por padrao no material que sai da rede.
 */
export type NeutralSpecSheet = {
  /** Codigo curto para a parceira citar internamente. Nao identifica ninguem. */
  readonly reference: string;
  readonly title: string;
  readonly brand: string;
  readonly model: string;
  readonly version: string;
  readonly manufactureYear: number;
  readonly modelYear: number;
  readonly yearLabel: string;
  readonly mileageKm: number;
  readonly mileageLabel: string;
  readonly color: string;
  readonly fuelLabel: string;
  readonly transmissionLabel: string;
  readonly doors: number | null;
  readonly optionals: readonly string[];
  /** URLs servidas pela plataforma, nunca o CDN da loja dona. */
  readonly photos: readonly { readonly url: string; readonly angleLabel: string }[];
  readonly inspection: {
    readonly approved: boolean;
    readonly label: string;
    readonly provider: string | null;
    readonly issuedAt: string | null;
    /** O laudo em PDF, servido pela plataforma. */
    readonly fileUrl: string | null;
  };
  readonly generatedAt: string;
};

/**
 * Marca opcional da loja que BAIXOU o material, com o preco que ELA pratica.
 *
 * Nunca a da dona. Quem define o liquido e a dona; quem define o preco ao
 * consumidor e quem vai atender o consumidor — e essa venda acontece fora da
 * plataforma, no canal da parceira.
 */
export type PartnerBranding = {
  readonly tradeName: string;
  readonly city: string;
  readonly state: string;
  readonly phone: string;
  readonly price: { readonly cents: number; readonly currency: 'BRL'; readonly formatted: string } | null;
};

export type MaterialKit = {
  readonly vehicleId: string;
  readonly sheet: NeutralSpecSheet;
  readonly readiness: MaterialReadiness;
  readonly branding: PartnerBranding | null;
};

export type KitOptions = {
  /**
   * Base pela qual as fotos e o laudo serao servidos.
   * Sem ela o kit sai sem midia — melhor material incompleto do que material
   * que aponta para o CDN da loja dona.
   */
  readonly mediaBase?: string | undefined;
  /** Loja que esta baixando, quando ela quer o material ja com a marca dela. */
  readonly partner?: Store | undefined;
  readonly partnerPrice?: Money | undefined;
  readonly now: Instant;
};

export function buildMaterialKit(vehicle: Vehicle, options: KitOptions): MaterialKit {
  const base = options.mediaBase?.replace(/\/+$/, '');

  return {
    vehicleId: vehicle.id,
    readiness: assessMaterial(vehicle),
    sheet: {
      reference: referenceFor(vehicle),
      title: describeVehicle(vehicle),
      brand: vehicle.specs.brand,
      model: vehicle.specs.model,
      version: vehicle.specs.version,
      manufactureYear: vehicle.specs.manufactureYear,
      modelYear: vehicle.specs.modelYear,
      yearLabel: `${vehicle.specs.manufactureYear}/${vehicle.specs.modelYear}`,
      mileageKm: vehicle.specs.mileageKm,
      mileageLabel: `${vehicle.specs.mileageKm.toLocaleString('pt-BR')} km`,
      color: vehicle.specs.color,
      fuelLabel: FUEL_LABELS[vehicle.specs.fuel],
      transmissionLabel: TRANSMISSION_LABELS[vehicle.specs.transmission],
      doors: vehicle.specs.doors,
      optionals: [...vehicle.specs.optionals],
      photos:
        base === undefined
          ? []
          : vehicle.neutralPhotos.map((photo, index) => ({
              url: `${base}/fotos/${index}`,
              angleLabel: ANGLE_LABELS[photo.angle],
            })),
      inspection: {
        approved: isInspectionValid(vehicle.inspection, options.now),
        label: INSPECTION_LABELS[vehicle.inspection.status],
        provider: vehicle.inspection.provider,
        issuedAt:
          vehicle.inspection.issuedAt === null ? null : toIso(vehicle.inspection.issuedAt),
        fileUrl:
          base === undefined || vehicle.inspection.fileUrl === null ? null : `${base}/laudo.pdf`,
      },
      generatedAt: toIso(options.now),
    },
    branding:
      options.partner === undefined
        ? null
        : {
            tradeName: options.partner.profile.tradeName,
            city: options.partner.profile.city,
            state: options.partner.profile.state,
            phone: formatPhone(options.partner.profile.phone),
            price: options.partnerPrice === undefined ? null : moneyToJSON(options.partnerPrice),
          },
  };
}

/** Codigo estavel e curto derivado do id, para a parceira citar o veiculo. */
function referenceFor(vehicle: Vehicle): string {
  const digits = vehicle.id.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return digits.slice(-8).padStart(8, '0');
}

const ANGLE_LABELS: Record<VehicleAngle, string> = {
  FRONT: 'Frente',
  REAR: 'Traseira',
  LEFT: 'Lateral esquerda',
  RIGHT: 'Lateral direita',
  INTERIOR: 'Interior',
  DASHBOARD: 'Painel',
  ENGINE: 'Motor',
  TRUNK: 'Porta-malas',
  OTHER: 'Outros',
};

const FUEL_LABELS: Record<FuelType, string> = {
  [FuelType.FLEX]: 'Flex',
  [FuelType.GASOLINE]: 'Gasolina',
  [FuelType.ETHANOL]: 'Etanol',
  [FuelType.DIESEL]: 'Diesel',
  [FuelType.ELECTRIC]: 'Eletrico',
  [FuelType.HYBRID]: 'Hibrido',
  [FuelType.CNG]: 'GNV',
};

const TRANSMISSION_LABELS: Record<TransmissionType, string> = {
  [TransmissionType.MANUAL]: 'Manual',
  [TransmissionType.AUTOMATIC]: 'Automatico',
  [TransmissionType.AUTOMATED]: 'Automatizado',
  [TransmissionType.CVT]: 'CVT',
};

const INSPECTION_LABELS: Record<InspectionStatus, string> = {
  [InspectionStatus.APPROVED]: 'Laudo cautelar aprovado',
  [InspectionStatus.APPROVED_WITH_NOTES]: 'Laudo cautelar aprovado com apontamentos',
  [InspectionStatus.REJECTED]: 'Laudo cautelar reprovado',
  [InspectionStatus.MISSING]: 'Sem laudo cautelar',
};

/**
 * Termos que nao podem aparecer no material que sai da rede, montados a partir
 * dos dados reais da loja dona e do veiculo.
 */
export function forbiddenTermsFor(vehicle: Vehicle, owner: Store): string[] {
  return [
    owner.profile.tradeName,
    owner.profile.legalName,
    owner.profile.cnpj,
    owner.profile.email,
    owner.profile.phone,
    owner.profile.responsibleName,
    owner.id,
    vehicle.chassis,
    vehicle.plate,
    String(vehicle.pricing.netPrice.cents),
    // As fotos do feed: o dominio do CDN costuma ser o da propria loja.
    ...vehicle.specs.photos,
  ].filter((term) => typeof term === 'string' && term.length >= 4);
}

/**
 * Rede de seguranca em runtime: varre o kit serializado antes de ele sair.
 *
 * Duplica o que os testes ja cobrem, de proposito. Um campo novo no agregado,
 * meses depois, nao passa a vazar so porque ninguem lembrou de atualizar
 * `buildMaterialKit` — o download falha alto em vez de entregar a origem.
 */
export function findLeaks(kit: MaterialKit, vehicle: Vehicle, owner: Store): string[] {
  const serialized = JSON.stringify(kit).toLowerCase();
  return forbiddenTermsFor(vehicle, owner).filter((term) =>
    serialized.includes(term.toLowerCase()),
  );
}
