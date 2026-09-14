/**
 * Formato canonico de um veiculo vindo de feed, e a validacao compartilhada.
 *
 * Os mapeadores por integrador (`mappers/`) fazem UMA coisa: extrair campos de
 * um XML com nomes proprios. Toda a validacao, normalizacao e o calculo do hash
 * de conteudo acontecem aqui, uma unica vez.
 *
 * A razao e pratica: adicionar um integrador novo passa a ser escrever um mapa
 * de nomes de tags, sem reimplementar (nem divergir em) a regra de que placa
 * precisa ser valida, de que o liquido nao pode superar o publico, ou de como
 * "Automático" vira `AUTOMATIC`.
 */

import { type Result, err, ok } from '../../domain/shared/result.ts';
import type { Instant } from '../../domain/shared/clock.ts';
import { DAY } from '../../domain/shared/clock.ts';
import { type Money, parseMoney, gt } from '../../domain/shared/money.ts';
import {
  parseChassis,
  parseHttpUrl,
  parseModelYear,
  parseOdometer,
  parsePlate,
  requireText,
} from '../../domain/shared/validation.ts';
import {
  type InspectionReport,
  type VehicleSpecs,
  FuelType,
  InspectionStatus,
  TransmissionType,
} from '../../domain/vehicle/vehicle.ts';
import { createHash } from 'node:crypto';

export type FeedVehicleRecord = {
  /** Id do veiculo no sistema do integrador. Chave de upsert junto com a loja. */
  readonly externalId: string;
  readonly plate: string;
  readonly chassis: string;
  readonly specs: VehicleSpecs;
  readonly publicPrice: Money;
  readonly netPrice: Money;
  readonly inspection: InspectionReport;
  /** Hash do conteudo: se nao mudou, a sincronizacao nao escreve nada. */
  readonly contentHash: string;
};

export type FeedIssue = {
  readonly externalId: string | null;
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
};

export type ParsedFeed = {
  readonly provider: string;
  readonly records: readonly FeedVehicleRecord[];
  /** Itens recusados, com o motivo. O feed segue; o item problematico nao entra. */
  readonly issues: readonly FeedIssue[];
};

/** Campos crus extraidos pelo mapeador, ainda como texto do XML. */
export type RawFeedFields = {
  readonly externalId?: string | undefined;
  readonly plate?: string | undefined;
  readonly chassis?: string | undefined;
  readonly brand?: string | undefined;
  readonly model?: string | undefined;
  readonly version?: string | undefined;
  readonly manufactureYear?: string | undefined;
  readonly modelYear?: string | undefined;
  readonly mileageKm?: string | undefined;
  readonly color?: string | undefined;
  readonly fuel?: string | undefined;
  readonly transmission?: string | undefined;
  readonly doors?: string | undefined;
  readonly publicPrice?: string | undefined;
  readonly netPrice?: string | undefined;
  readonly optionals: readonly string[];
  readonly photos: readonly string[];
  readonly inspectionStatus?: string | undefined;
  readonly inspectionProvider?: string | undefined;
  readonly inspectionNumber?: string | undefined;
  readonly inspectionIssuedAt?: string | undefined;
  readonly inspectionExpiresAt?: string | undefined;
  readonly inspectionFileUrl?: string | undefined;
};

export type BuildContext = {
  readonly now: Instant;
  /** Validade assumida quando o feed informa o laudo mas nao a data de vencimento. */
  readonly defaultInspectionValidityMs?: number;
};

/** Laudo cautelar tipicamente vale 90 dias no mercado brasileiro. */
export const DEFAULT_INSPECTION_VALIDITY_MS = 90 * DAY;

export function buildRecord(
  raw: RawFeedFields,
  context: BuildContext,
): Result<FeedVehicleRecord, FeedIssue> {
  const externalId = raw.externalId?.trim();
  const issue = (code: string, message: string, details?: Record<string, unknown>): FeedIssue =>
    details === undefined
      ? { externalId: externalId ?? null, code, message }
      : { externalId: externalId ?? null, code, message, details };

  if (externalId === undefined || externalId.length === 0) {
    return err(issue('MISSING_EXTERNAL_ID', 'Item do feed sem identificador; impossivel sincronizar.'));
  }

  const plate = parsePlate(raw.plate);
  if (!plate.ok) return err(issue(plate.error.code, plate.error.message, plate.error.details));

  const chassis = parseChassis(raw.chassis);
  if (!chassis.ok) return err(issue(chassis.error.code, chassis.error.message, chassis.error.details));

  const currentYear = new Date(context.now).getUTCFullYear();
  const brand = requireText(raw.brand, 'marca', { min: 2, max: 60 });
  if (!brand.ok) return err(issue(brand.error.code, brand.error.message));
  const model = requireText(raw.model, 'modelo', { min: 1, max: 80 });
  if (!model.ok) return err(issue(model.error.code, model.error.message));

  const manufactureYear = parseModelYear(raw.manufactureYear, 'ano de fabricacao', currentYear);
  if (!manufactureYear.ok) return err(issue(manufactureYear.error.code, manufactureYear.error.message));
  const modelYear = parseModelYear(raw.modelYear ?? raw.manufactureYear, 'ano do modelo', currentYear);
  if (!modelYear.ok) return err(issue(modelYear.error.code, modelYear.error.message));

  const mileageKm = parseOdometer(raw.mileageKm ?? '0', 'quilometragem');
  if (!mileageKm.ok) return err(issue(mileageKm.error.code, mileageKm.error.message));

  const publicPrice = parseMoney(raw.publicPrice, { field: 'preco publico' });
  if (!publicPrice.ok) return err(issue(publicPrice.error.code, publicPrice.error.message));

  // Sem preco de repasse o veiculo nao tem como circular na rede: e o unico
  // numero que a Loja B precisa para decidir se assume o cliente.
  const netPrice = parseMoney(raw.netPrice, { field: 'preco liquido de repasse' });
  if (!netPrice.ok) {
    return err(
      issue(
        'MISSING_NET_PRICE',
        'Sem preco liquido de repasse o veiculo nao circula na rede.',
        { received: raw.netPrice ?? null },
      ),
    );
  }
  if (gt(netPrice.value, publicPrice.value)) {
    return err(
      issue(
        'NET_PRICE_ABOVE_PUBLIC_PRICE',
        'O preco liquido de repasse esta acima do preco publico — provavel inversao de colunas no feed.',
        { netPriceCents: netPrice.value.cents, publicPriceCents: publicPrice.value.cents },
      ),
    );
  }

  const specs: VehicleSpecs = {
    brand: brand.value,
    model: model.value,
    version: raw.version?.trim() ?? '',
    manufactureYear: manufactureYear.value,
    modelYear: Math.max(modelYear.value, manufactureYear.value),
    mileageKm: mileageKm.value,
    color: raw.color?.trim() ?? 'Nao informada',
    fuel: normalizeFuel(raw.fuel),
    transmission: normalizeTransmission(raw.transmission),
    doors: parseDoors(raw.doors),
    optionals: normalizeOptionals(raw.optionals),
    photos: normalizePhotos(raw.photos),
  };

  const inspection = buildInspection(raw, context);

  const record: Omit<FeedVehicleRecord, 'contentHash'> = {
    externalId,
    plate: plate.value.plate,
    chassis: chassis.value,
    specs,
    publicPrice: publicPrice.value,
    netPrice: netPrice.value,
    inspection,
  };

  return ok({ ...record, contentHash: hashRecord(record) });
}

/**
 * Hash estavel do conteudo relevante. Datas absolutas do laudo entram; o
 * instante da sincronizacao, nao — senao todo feed pareceria alterado.
 */
function hashRecord(record: Omit<FeedVehicleRecord, 'contentHash'>): string {
  const canonical = JSON.stringify({
    externalId: record.externalId,
    plate: record.plate,
    chassis: record.chassis,
    specs: {
      ...record.specs,
      optionals: [...record.specs.optionals].sort(),
      photos: [...record.specs.photos],
    },
    publicPriceCents: record.publicPrice.cents,
    netPriceCents: record.netPrice.cents,
    inspection: record.inspection,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// Normalizacao de vocabulario
// ---------------------------------------------------------------------------

function fold(value: string | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

export function normalizeFuel(value: string | undefined): FuelType {
  const text = fold(value);
  if (text.includes('flex') || text.includes('bicomb')) return FuelType.FLEX;
  if (text.includes('diesel')) return FuelType.DIESEL;
  if (text.includes('elet') || text.includes('electric')) return FuelType.ELECTRIC;
  if (text.includes('hibr') || text.includes('hybrid')) return FuelType.HYBRID;
  if (text.includes('gnv') || text.includes('gas natural')) return FuelType.CNG;
  if (text.includes('alcool') || text.includes('etanol')) return FuelType.ETHANOL;
  if (text.includes('gasolina')) return FuelType.GASOLINE;
  // Flex e o caso esmagadoramente dominante no seminovo brasileiro.
  return FuelType.FLEX;
}

export function normalizeTransmission(value: string | undefined): TransmissionType {
  const text = fold(value);
  if (text.includes('cvt')) return TransmissionType.CVT;
  if (text.includes('automatizad') || text.includes('dualogic') || text.includes('i-motion')) {
    return TransmissionType.AUTOMATED;
  }
  if (text.includes('autom') || text.includes('at')) return TransmissionType.AUTOMATIC;
  return TransmissionType.MANUAL;
}

function parseDoors(value: string | undefined): number | null {
  if (value === undefined) return null;
  const digits = /\d+/.exec(value);
  if (digits === null) return null;
  const doors = Number(digits[0]);
  return doors >= 2 && doors <= 6 ? doors : null;
}

function normalizeOptionals(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const optionals: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > 80) continue;
    const key = fold(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    optionals.push(trimmed);
    if (optionals.length >= 60) break;
  }
  return optionals;
}

function normalizePhotos(values: readonly string[]): string[] {
  const photos: string[] = [];
  for (const value of values) {
    const url = parseHttpUrl(value, 'foto');
    if (url.ok && !photos.includes(url.value)) photos.push(url.value);
    if (photos.length >= 40) break;
  }
  return photos;
}

function buildInspection(raw: RawFeedFields, context: BuildContext): InspectionReport {
  const status = normalizeInspectionStatus(raw.inspectionStatus);
  if (status === InspectionStatus.MISSING) return {
    status,
    reportNumber: null,
    provider: null,
    issuedAt: null,
    expiresAt: null,
    fileUrl: null,
  };

  const issuedAt = parseFeedDate(raw.inspectionIssuedAt);
  const explicitExpiry = parseFeedDate(raw.inspectionExpiresAt);
  const validity = context.defaultInspectionValidityMs ?? DEFAULT_INSPECTION_VALIDITY_MS;

  return {
    status,
    reportNumber: raw.inspectionNumber?.trim() ?? null,
    provider: raw.inspectionProvider?.trim() ?? null,
    issuedAt,
    // Sem vencimento explicito, assume a validade de mercado a partir da emissao.
    expiresAt: explicitExpiry ?? (issuedAt === null ? null : issuedAt + validity),
    // Feed raramente traz o PDF; a loja anexa depois, pela plataforma.
    fileUrl: raw.inspectionFileUrl ?? null,
  };
}

export function normalizeInspectionStatus(value: string | undefined): InspectionStatus {
  if (value === undefined) return InspectionStatus.MISSING;
  const text = fold(value);
  if (text.length === 0) return InspectionStatus.MISSING;

  if (text.includes('reprovad') || text === 'false' || text === 'nao' || text === 'n') {
    return InspectionStatus.REJECTED;
  }
  if (text.includes('restric') || text.includes('apontament') || text.includes('ressalva')) {
    return InspectionStatus.APPROVED_WITH_NOTES;
  }
  if (
    text.includes('aprovad') ||
    text === 'true' ||
    text === '1' ||
    text === 'sim' ||
    text === 's' ||
    text === 'ok'
  ) {
    return InspectionStatus.APPROVED;
  }
  return InspectionStatus.MISSING;
}

/** Aceita ISO (`2026-01-15`) e o formato brasileiro (`15/01/2026`). */
export function parseFeedDate(value: string | undefined): Instant | null {
  if (value === undefined) return null;
  const text = value.trim();
  if (text.length === 0) return null;

  const brazilian = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (brazilian !== null) {
    const [, day, month, year] = brazilian as unknown as [string, string, string, string];
    return Date.UTC(Number(year), Number(month) - 1, Number(day));
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso !== null) {
    const parsed = Date.parse(text.length === 10 ? `${text}T00:00:00Z` : text);
    return Number.isNaN(parsed) ? null : parsed;
  }

  const fallback = Date.parse(text);
  return Number.isNaN(fallback) ? null : fallback;
}
