/**
 * Ficha tecnica white-label — a saida que vai para o cliente final.
 *
 * Esta e a fronteira de vazamento do produto. Tudo que entra aqui e publico;
 * tudo que fica de fora e o que sustenta o modelo de rede. A funcao e escrita
 * como uma LISTA DE INCLUSAO (monta o objeto campo a campo) e nunca como
 * `{...vehicle, delete X}`: com spread, todo campo novo do agregado passaria a
 * vazar por padrao, e o vazamento so apareceria em producao.
 *
 * O que fica de fora, e por que:
 *   - identidade da loja proprietaria (nome, CNPJ, contato) — o cliente
 *     atravessaria a Loja B e iria direto na dona;
 *   - preco liquido de repasse — revela a margem da Loja B;
 *   - placa completa e chassi — permitem consulta publica que devolve o nome do
 *     proprietario, ou seja, vazam a origem por via indireta;
 *   - numero do laudo cautelar — consultavel e rastreavel ate o contratante;
 *   - URLs originais das fotos — o dominio do CDN costuma ser o da propria loja
 *     ("cdn.primemotors.com.br/..."), o vazamento mais facil de esquecer;
 *   - qualquer dado de custodia — dizer onde o carro esta e dizer de quem ele e.
 */

import type { Instant } from '../shared/clock.ts';
import { toIso } from '../shared/clock.ts';
import { type Money, toJSON as moneyToJSON } from '../shared/money.ts';
import { maskPlate } from '../shared/validation.ts';
import type { Store } from '../network/store.ts';
import { formatPhone } from '../network/store.ts';
import {
  type Vehicle,
  FuelType,
  InspectionStatus,
  TransmissionType,
  describeVehicle,
  isInspectionValid,
} from '../vehicle/vehicle.ts';
import type { ShareLink } from './share-link.ts';

export type WhiteLabelSheet = {
  /** Codigo curto para o cliente citar ao vendedor. Nao e o token. */
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
  /** URLs servidas pela plataforma, nunca as originais do CDN da loja dona. */
  readonly photos: readonly string[];
  readonly price: { readonly cents: number; readonly currency: 'BRL'; readonly formatted: string };
  readonly inspection: {
    readonly approved: boolean;
    readonly label: string;
    readonly provider: string | null;
    readonly issuedAt: string | null;
  };
  /** Mascarada quando habilitada; `null` por padrao. */
  readonly plate: string | null;
  /** A loja que compartilhou — a unica identidade da lamina. */
  readonly presentedBy: {
    readonly tradeName: string;
    readonly city: string;
    readonly state: string;
    readonly phone: string;
  };
  readonly generatedAt: string;
  readonly validUntil: string;
  readonly disclaimer: string;
};

export type SheetOptions = {
  /**
   * Base pela qual as fotos serao servidas, ex.: "/s/{token}/fotos".
   * Sem ela as fotos sao omitidas — melhor lamina sem foto do que lamina que
   * entrega o dominio da loja proprietaria.
   */
  readonly photoProxyBase?: string | undefined;
  readonly now: Instant;
};

export function buildWhiteLabelSheet(
  vehicle: Vehicle,
  link: ShareLink,
  presenter: Store,
  options: SheetOptions,
): WhiteLabelSheet {
  const displayPrice: Money = link.displayPrice;

  return {
    reference: link.token.slice(0, 8).toUpperCase(),
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
    photos: proxiedPhotos(vehicle, options.photoProxyBase),
    price: moneyToJSON(displayPrice),
    inspection: {
      approved: isInspectionValid(vehicle.inspection, options.now),
      label: INSPECTION_LABELS[vehicle.inspection.status],
      provider: vehicle.inspection.provider,
      issuedAt: vehicle.inspection.issuedAt === null ? null : toIso(vehicle.inspection.issuedAt),
    },
    plate: link.showPlate ? maskPlate(vehicle.plate) : null,
    presentedBy: {
      tradeName: presenter.profile.tradeName,
      city: presenter.profile.city,
      state: presenter.profile.state,
      phone: formatPhone(presenter.profile.phone),
    },
    generatedAt: toIso(options.now),
    validUntil: toIso(link.expiresAt),
    disclaimer:
      'Valores e disponibilidade sujeitos a confirmacao. Consulte o vendedor antes de fechar negocio.',
  };
}

function proxiedPhotos(vehicle: Vehicle, proxyBase: string | undefined): string[] {
  if (proxyBase === undefined) return [];
  const base = proxyBase.endsWith('/') ? proxyBase.slice(0, -1) : proxyBase;
  return vehicle.specs.photos.map((_, index) => `${base}/${index}`);
}

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
 * Termos que jamais podem aparecer numa lamina, montados a partir dos dados
 * reais da loja proprietaria e do veiculo. Usado pelos testes de vazamento e
 * pelo guarda de runtime abaixo.
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
    ...vehicle.specs.photos,
  ].filter((term) => typeof term === 'string' && term.length >= 4);
}

/**
 * Rede de seguranca em runtime: varre a lamina serializada atras de qualquer
 * termo proibido antes de ela sair pela API.
 *
 * Duplica o que os testes ja cobrem, de proposito. Um campo novo adicionado ao
 * agregado meses depois nao passa a vazar silenciosamente so porque ninguem
 * lembrou de atualizar `buildWhiteLabelSheet` — o pedido falha alto.
 */
export function findLeaks(
  sheet: WhiteLabelSheet,
  vehicle: Vehicle,
  owner: Store,
  presenter: Store,
): string[] {
  // A loja dona compartilhando o proprio carro nao esta fazendo white-label:
  // o nome dela na lamina e a assinatura dela, nao um vazamento.
  if (presenter.id === owner.id) return [];

  const serialized = JSON.stringify(sheet).toLowerCase();
  return forbiddenTermsFor(vehicle, owner).filter((term) =>
    serialized.includes(term.toLowerCase()),
  );
}
