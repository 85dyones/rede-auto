/**
 * Sincronizacao de estoque a partir do feed XML da loja.
 *
 * O feed e a fonte da verdade sobre CATALOGO (ficha, fotos, precos, laudo).
 * Ele nao e — e nao pode ser — a fonte da verdade sobre nada mais. As tres
 * regras que decorrem disso sao a razao de existir deste modulo:
 *
 * 1. O feed NUNCA move custodia fisica. Onde o carro esta e resultado de termos
 *    de vistoria assinados, nao de um XML publicado a cada 15 minutos.
 *
 * 2. O feed NUNCA derruba uma negociacao em andamento. Com trava ativa, a
 *    ficha e as fotos ate se atualizam, mas o preco liquido fica represado ate
 *    a trava cair: a Loja B negocia sobre o numero que travou.
 *
 * 3. Veiculo que SUMIU do feed nem sempre pode ser retirado da rede. Se ele
 *    esta no patio de outra loja, sumir do feed e um sinal de inconsistencia
 *    que precisa de gente — nao um comando de exclusao.
 *
 * A operacao e idempotente: rodar o mesmo feed duas vezes nao produz escrita na
 * segunda, porque cada item carrega um hash do proprio conteudo.
 */

import { type Result, err, ok } from '../../domain/shared/result.ts';
import { type DomainError, validationError } from '../../domain/shared/errors.ts';
import { type DomainEvent, domainEvent } from '../../domain/shared/events.ts';
import type { Instant } from '../../domain/shared/clock.ts';
import type { ClusterId, IngestionRunId, StoreId, VehicleId } from '../../domain/shared/ids.ts';
import { equals as moneyEquals } from '../../domain/shared/money.ts';
import {
  type Vehicle,
  CommercialStatus,
  createVehicle,
  isInspectionValid,
} from '../../domain/vehicle/vehicle.ts';
import { type FeedIssue, type FeedVehicleRecord } from './canonical.ts';
import { detectMapper, mapperFor } from './mappers/index.ts';
import { parseXml, type XmlLimits } from './xml.ts';

export const ChangeKind = {
  CREATED: 'CREATED',
  UPDATED: 'UPDATED',
  /** Conteudo identico ao da ultima sincronizacao: nada a escrever. */
  UNCHANGED: 'UNCHANGED',
  /** Estava no estoque e nao veio no feed desta vez. */
  MISSING: 'MISSING',
} as const;
export type ChangeKind = (typeof ChangeKind)[keyof typeof ChangeKind];

export const MissingAction = {
  /** Retirado da rede: e da loja, esta no patio dela, ninguem negociando. */
  WITHDRAWN: 'WITHDRAWN',
  /** Esta no patio de outra loja: sinalizado para decisao humana. */
  FLAGGED_ON_EXTENDED_CUSTODY: 'FLAGGED_ON_EXTENDED_CUSTODY',
  /** Ha trava ativa: a decisao fica para quando ela cair. */
  DEFERRED_UNTIL_LOCK_ENDS: 'DEFERRED_UNTIL_LOCK_ENDS',
} as const;
export type MissingAction = (typeof MissingAction)[keyof typeof MissingAction];

export type VehicleChange =
  | { readonly kind: 'CREATED'; readonly vehicle: Vehicle }
  | { readonly kind: 'UPDATED'; readonly before: Vehicle; readonly vehicle: Vehicle }
  | { readonly kind: 'UNCHANGED'; readonly vehicle: Vehicle }
  | {
      readonly kind: 'MISSING';
      readonly before: Vehicle;
      readonly vehicle: Vehicle;
      readonly action: MissingAction;
    };

export type IngestionReport = {
  readonly runId: IngestionRunId;
  readonly storeId: StoreId;
  readonly provider: string;
  readonly startedAt: Instant;
  readonly changes: readonly VehicleChange[];
  readonly issues: readonly FeedIssue[];
  readonly events: readonly DomainEvent[];
  readonly counts: {
    readonly received: number;
    readonly created: number;
    readonly updated: number;
    readonly unchanged: number;
    readonly missing: number;
    readonly rejected: number;
  };
};

export type IngestionContext = {
  readonly runId: IngestionRunId;
  readonly clusterId: ClusterId;
  readonly storeId: StoreId;
  readonly now: Instant;
  /** Integrador declarado. Se ausente, o formato e detectado pelo conteudo. */
  readonly provider?: string | undefined;
  /** Veiculos que esta loja ja tem na plataforma. */
  readonly existing: readonly Vehicle[];
  /**
   * Chassi -> loja dona, **dentro da praca**. E a defesa contra o mesmo carro
   * anunciado por duas lojas, que e a duplicidade de venda que a plataforma
   * existe para impedir. Nao cruza cluster de proposito: o mesmo carro em duas
   * pracas e improvavel, e se acontecer nao gera conflito de venda — as lojas
   * nunca se encontram.
   */
  readonly chassisOwners: ReadonlyMap<string, StoreId>;
  readonly nextVehicleId: () => VehicleId;
  readonly xmlLimits?: XmlLimits | undefined;
};

export function ingestFeed(xml: string, context: IngestionContext): Result<IngestionReport, DomainError> {
  const parsed = context.xmlLimits === undefined ? parseXml(xml) : parseXml(xml, context.xmlLimits);
  if (!parsed.ok) return parsed;

  const mapper =
    context.provider === undefined ? detectMapper(parsed.value) : mapperFor(context.provider);
  if (mapper === undefined) {
    return err(
      validationError(
        'FEED_FORMAT_UNKNOWN',
        context.provider === undefined
          ? 'Nao foi possivel reconhecer o formato do feed. Informe o integrador.'
          : `Integrador desconhecido: ${context.provider}.`,
        { provider: context.provider ?? null },
      ),
    );
  }

  const feed = mapper.parse(parsed.value, { now: context.now });
  const changes: VehicleChange[] = [];
  const issues: FeedIssue[] = [...feed.issues];
  const events: DomainEvent[] = [];

  const byExternalId = new Map<string, Vehicle>();
  const byChassis = new Map<string, Vehicle>();
  for (const vehicle of context.existing) {
    if (vehicle.source.externalId !== null) byExternalId.set(vehicle.source.externalId, vehicle);
    byChassis.set(vehicle.chassis, vehicle);
  }

  const seenExternalIds = new Set<string>();

  for (const record of feed.records) {
    seenExternalIds.add(record.externalId);

    // O feed pode trocar o id externo de um carro (troca de sistema, reimport).
    // O chassi e a identidade real do veiculo, entao ele e o segundo criterio.
    const existing = byExternalId.get(record.externalId) ?? byChassis.get(record.chassis);

    if (existing === undefined) {
      const conflictingOwner = context.chassisOwners.get(record.chassis);
      if (conflictingOwner !== undefined && conflictingOwner !== context.storeId) {
        issues.push({
          externalId: record.externalId,
          code: 'DUPLICATE_VIN_IN_NETWORK',
          message:
            'Este chassi ja esta anunciado por outra loja da rede. Duas lojas nao podem ofertar o mesmo veiculo.',
          details: { chassis: record.chassis, ownerStoreId: conflictingOwner },
        });
        events.push(
          domainEvent('feed.duplicate_vin_detected', record.chassis, context.now, {
            storeId: context.storeId,
            otherStoreId: conflictingOwner,
            externalId: record.externalId,
          }),
        );
        continue;
      }

      const created = createFromRecord(record, context, mapper.provider);
      if (!created.ok) {
        issues.push({
          externalId: record.externalId,
          code: created.error.code,
          message: created.error.message,
        });
        continue;
      }
      changes.push({ kind: ChangeKind.CREATED, vehicle: created.value });
      events.push(
        domainEvent('feed.vehicle_created', created.value.id, context.now, {
          storeId: context.storeId,
          externalId: record.externalId,
          plate: created.value.plate,
          commercialStatus: created.value.commercialStatus,
        }),
      );
      continue;
    }

    const applied = applyRecord(existing, record, context, mapper.provider);
    changes.push(applied.change);
    events.push(...applied.events);
    if (applied.issue !== null) issues.push(applied.issue);
  }

  // Segundo passo: o que estava no estoque e nao veio no feed.
  for (const vehicle of context.existing) {
    if (vehicle.source.provider !== mapper.provider) continue;
    if (vehicle.source.externalId === null) continue;
    if (seenExternalIds.has(vehicle.source.externalId)) continue;
    if (byChassis.get(vehicle.chassis) !== vehicle) continue;

    const missing = handleMissing(vehicle, context);
    if (missing === null) continue;
    changes.push(missing.change);
    events.push(...missing.events);
  }

  return ok({
    runId: context.runId,
    storeId: context.storeId,
    provider: mapper.provider,
    startedAt: context.now,
    changes,
    issues,
    events,
    counts: {
      received: feed.records.length,
      created: changes.filter((change) => change.kind === ChangeKind.CREATED).length,
      updated: changes.filter((change) => change.kind === ChangeKind.UPDATED).length,
      unchanged: changes.filter((change) => change.kind === ChangeKind.UNCHANGED).length,
      missing: changes.filter((change) => change.kind === ChangeKind.MISSING).length,
      rejected: issues.length,
    },
  });
}

function createFromRecord(
  record: FeedVehicleRecord,
  context: IngestionContext,
  provider: string,
): Result<Vehicle, DomainError> {
  return createVehicle({
    id: context.nextVehicleId(),
    clusterId: context.clusterId,
    ownerStoreId: context.storeId,
    plate: record.plate,
    chassis: record.chassis,
    specs: record.specs,
    inspection: record.inspection,
    publicPrice: record.publicPrice,
    netPrice: record.netPrice,
    source: {
      provider,
      externalId: record.externalId,
      contentHash: record.contentHash,
      lastSyncedAt: context.now,
    },
    now: context.now,
  });
}

type AppliedRecord = {
  readonly change: VehicleChange;
  readonly events: readonly DomainEvent[];
  readonly issue: FeedIssue | null;
};

function applyRecord(
  existing: Vehicle,
  record: FeedVehicleRecord,
  context: IngestionContext,
  provider: string,
): AppliedRecord {
  const { now } = context;

  // Carro vendido saiu do estoque da rede; o feed do lojista costuma demorar a
  // refletir isso, e nao e o feed quem decide.
  if (existing.commercialStatus === CommercialStatus.SOLD) {
    return {
      change: { kind: ChangeKind.UNCHANGED, vehicle: existing },
      events: [],
      issue: {
        externalId: record.externalId,
        code: 'VEHICLE_ALREADY_SOLD',
        message: 'Veiculo ja vendido pela rede; o item do feed foi ignorado.',
        details: { vehicleId: existing.id },
      },
    };
  }

  const unchanged =
    existing.source.contentHash === record.contentHash && !existing.missingFromFeed;
  if (unchanged) {
    return {
      change: {
        kind: ChangeKind.UNCHANGED,
        vehicle: { ...existing, source: { ...existing.source, lastSyncedAt: now } },
      },
      events: [],
      issue: null,
    };
  }

  const locked = existing.commercialStatus === CommercialStatus.LOCKED;
  const netPriceChanged = !moneyEquals(existing.pricing.netPrice, record.netPrice);
  const events: DomainEvent[] = [];

  // Com trava ativa, o liquido novo fica represado: quem esta negociando fechou
  // sobre o numero que travou.
  const netPrice = locked ? existing.pricing.netPrice : record.netPrice;
  const pendingNetPrice = locked && netPriceChanged ? record.netPrice : existing.pendingNetPrice;

  if (locked && netPriceChanged) {
    events.push(
      domainEvent('vehicle.net_price_deferred', existing.id, now, {
        reason: 'ACTIVE_COMMERCIAL_LOCK',
        source: 'FEED_SYNC',
        currentNetPriceCents: existing.pricing.netPrice.cents,
        pendingNetPriceCents: record.netPrice.cents,
        lockId: existing.activeLockId,
      }),
    );
  }

  const updated: Vehicle = {
    ...existing,
    plate: record.plate,
    chassis: record.chassis,
    specs: record.specs,
    inspection: record.inspection,
    pricing: { publicPrice: record.publicPrice, netPrice, updatedAt: now },
    pendingNetPrice,
    commercialStatus: resolveStatusAfterSync(existing, record, now),
    missingFromFeed: false,
    // A custodia fisica nao e tocada, em nenhuma circunstancia.
    physical: existing.physical,
    source: {
      provider,
      externalId: record.externalId,
      contentHash: record.contentHash,
      lastSyncedAt: now,
    },
    updatedAt: now,
  };

  if (updated.commercialStatus !== existing.commercialStatus) {
    events.push(
      domainEvent(
        updated.commercialStatus === CommercialStatus.AVAILABLE
          ? 'vehicle.listed'
          : 'vehicle.unlisted',
        existing.id,
        now,
        {
          from: existing.commercialStatus,
          to: updated.commercialStatus,
          reason: 'FEED_SYNC_INSPECTION',
        },
      ),
    );
  }

  events.push(
    domainEvent('feed.vehicle_updated', existing.id, now, {
      storeId: context.storeId,
      externalId: record.externalId,
      netPriceChanged,
      netPriceDeferred: locked && netPriceChanged,
    }),
  );

  return { change: { kind: ChangeKind.UPDATED, before: existing, vehicle: updated }, events, issue: null };
}

/**
 * O status comercial depois da sincronizacao.
 * Uma trava ativa sobrevive a qualquer coisa que o feed diga.
 */
function resolveStatusAfterSync(
  existing: Vehicle,
  record: FeedVehicleRecord,
  now: Instant,
): CommercialStatus {
  if (existing.commercialStatus === CommercialStatus.LOCKED) return CommercialStatus.LOCKED;
  if (existing.commercialStatus === CommercialStatus.WITHDRAWN) return CommercialStatus.WITHDRAWN;
  return isInspectionValid(record.inspection, now)
    ? CommercialStatus.AVAILABLE
    : CommercialStatus.DRAFT;
}

function handleMissing(
  vehicle: Vehicle,
  context: IngestionContext,
): { change: VehicleChange; events: DomainEvent[] } | null {
  const { now } = context;

  if (
    vehicle.commercialStatus === CommercialStatus.SOLD ||
    vehicle.commercialStatus === CommercialStatus.WITHDRAWN
  ) {
    return null;
  }

  const flagged: Vehicle = { ...vehicle, missingFromFeed: true, updatedAt: now };

  if (vehicle.commercialStatus === CommercialStatus.LOCKED) {
    // Derrubar agora mataria uma negociacao em andamento. A decisao fica
    // registrada e e aplicada quando a trava cair.
    return {
      change: {
        kind: ChangeKind.MISSING,
        before: vehicle,
        vehicle: flagged,
        action: MissingAction.DEFERRED_UNTIL_LOCK_ENDS,
      },
      events: [
        domainEvent('feed.vehicle_missing', vehicle.id, now, {
          storeId: context.storeId,
          action: MissingAction.DEFERRED_UNTIL_LOCK_ENDS,
          lockId: vehicle.activeLockId,
        }),
      ],
    };
  }

  if (vehicle.physical.custodianStoreId !== vehicle.ownerStoreId) {
    // O carro sumiu do feed da dona mas esta no patio de outra loja. Isso
    // costuma significar venda no balcao sem baixa — alguem precisa combinar o
    // retorno. Retirar da rede sozinho seria decidir logistica por conta.
    return {
      change: {
        kind: ChangeKind.MISSING,
        before: vehicle,
        vehicle: flagged,
        action: MissingAction.FLAGGED_ON_EXTENDED_CUSTODY,
      },
      events: [
        domainEvent('feed.vehicle_missing', vehicle.id, now, {
          storeId: context.storeId,
          action: MissingAction.FLAGGED_ON_EXTENDED_CUSTODY,
          custodianStoreId: vehicle.physical.custodianStoreId,
        }),
      ],
    };
  }

  const withdrawn: Vehicle = {
    ...flagged,
    commercialStatus: CommercialStatus.WITHDRAWN,
  };
  return {
    change: {
      kind: ChangeKind.MISSING,
      before: vehicle,
      vehicle: withdrawn,
      action: MissingAction.WITHDRAWN,
    },
    events: [
      domainEvent('vehicle.withdrawn', vehicle.id, now, { reason: 'REMOVED_FROM_OWNER_FEED' }),
      domainEvent('feed.vehicle_missing', vehicle.id, now, {
        storeId: context.storeId,
        action: MissingAction.WITHDRAWN,
      }),
    ],
  };
}

/** Resumo em uma linha, para log de operacao. */
export function describeReport(report: IngestionReport): string {
  const { counts } = report;
  return (
    `feed ${report.provider}: ${counts.received} recebidos, ${counts.created} criados, ` +
    `${counts.updated} atualizados, ${counts.unchanged} sem mudanca, ` +
    `${counts.missing} ausentes, ${counts.rejected} recusados`
  );
}
