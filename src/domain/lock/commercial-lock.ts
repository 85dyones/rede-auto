/**
 * Trava comercial — o congelamento temporario de um veiculo para uma negociacao.
 *
 * O ciclo completo, e por que ele e assim:
 *
 *   ABERTA (4h)  o vendedor da Loja B iniciou atendimento quente. Durante o
 *                prazo, ninguem mais na rede reserva ou vende o carro — nem a
 *                propria loja dona. Sem essa exclusividade a Loja B nao teria
 *                como prometer o carro ao cliente que esta na frente dela.
 *
 *   ESTENDIDA    houve avanco no funil comprovado por evidencia (ver
 *                `evidence.ts`). Prazo somado, com teto absoluto.
 *
 *   EXPIRADA     o prazo venceu sem fechamento. O veiculo volta a ficar
 *                DISPONIVEL para TODA a rede — inclusive, e principalmente,
 *                para a propria Loja B, que segue com o carro no patio e agora
 *                tem uma oportunidade de balcao. Nao ha carencia nem prioridade
 *                residual: expirou, e primeiro a travar leva.
 *
 *   LIBERADA     a Loja B desistiu antes do prazo e devolveu o carro a rede.
 *
 *   CONVERTIDA   virou negociacao fechada (deal confirmado).
 *
 * A regra que sustenta as outras: **o fim da trava nao move o carro**. A
 * custodia fisica permanece exatamente onde estava. Esse desacoplamento e o que
 * elimina o frete de devolucao a cada cliente que desiste.
 */

import { err } from '../shared/result.ts';
import {
  conflictError,
  forbiddenError,
  ruleViolation,
  assertInvariant,
} from '../shared/errors.ts';
import { type DomainEvent, domainEvent } from '../shared/events.ts';
import { type Transition, transitioned, unchanged } from '../shared/transition.ts';
import type { Instant } from '../shared/clock.ts';
import { formatDuration } from '../shared/clock.ts';
import type { DealId, LockId, StoreId, UserId } from '../shared/ids.ts';
import type { Money } from '../shared/money.ts';
import { type NetworkUser, type Store, canTransact } from '../network/store.ts';
import type { Member } from '../network/member.ts';
import {
  type Vehicle,
  CommercialStatus,
  applyPendingNetPrice,
  isInspectionValid,
} from '../vehicle/vehicle.ts';
import type { ActiveLockView } from '../recall/recall.ts';
import {
  type Evidence,
  type LockPolicy,
  DEFAULT_LOCK_POLICY,
  grantFor,
} from './evidence.ts';

export const LockStatus = {
  ACTIVE: 'ACTIVE',
  EXPIRED: 'EXPIRED',
  RELEASED: 'RELEASED',
  CONVERTED: 'CONVERTED',
} as const;
export type LockStatus = (typeof LockStatus)[keyof typeof LockStatus];

export const LockEndReason = {
  TTL_EXPIRED: 'TTL_EXPIRED',
  RELEASED_BY_HOLDER: 'RELEASED_BY_HOLDER',
  CONVERTED_TO_DEAL: 'CONVERTED_TO_DEAL',
} as const;
export type LockEndReason = (typeof LockEndReason)[keyof typeof LockEndReason];

export type LockExtension = {
  readonly evidence: Evidence;
  readonly grantedMs: number;
  readonly extendedAt: Instant;
  readonly extendedByUserId: UserId;
  readonly previousExpiresAt: Instant;
  readonly newExpiresAt: Instant;
  /** Prazo cortado pelo teto absoluto da politica. */
  readonly cappedByPolicy: boolean;
};

export type CommercialLock = {
  readonly id: LockId;
  readonly vehicleId: string;
  /** Loja que detem a exclusividade. Pode ser a propria dona do veiculo. */
  readonly holderStoreId: StoreId;
  readonly holderUserId: UserId;
  readonly openedAt: Instant;
  readonly expiresAt: Instant;
  readonly status: LockStatus;
  /**
   * Preco liquido congelado na abertura da trava. Se a loja dona reprecificar
   * durante a negociacao, a Loja B continua fechando pelo numero que travou.
   */
  readonly netPriceSnapshot: Money;
  readonly extensions: readonly LockExtension[];
  /** Referencia interna do atendimento na Loja B. Sem dado pessoal do cliente. */
  readonly customerReference: string | null;
  /**
   * Instante em que o relogio parou porque o carro entrou em transito para quem
   * travou. `null` quando o relogio esta correndo.
   *
   * A trava e exclusividade para atender um cliente, e nao se atende cliente com
   * o carro no guincho. Queimar as 4 horas esperando o transporte e pagar por um
   * tempo que nao da para usar — e empurra a parceira a so travar depois que o
   * carro chega, que e quando a corrida pelo carro ja aconteceu.
   */
  readonly suspendedAt: Instant | null;
  /** Quanto tempo ja foi devolvido por transito. Existe para o teto poder cortar. */
  readonly suspendedMs: number;
  readonly endedAt: Instant | null;
  readonly endReason: LockEndReason | null;
  readonly dealId: DealId | null;
};

export type VehicleWithLock = {
  readonly vehicle: Vehicle;
  readonly lock: CommercialLock;
};

/**
 * Veiculo e sua trava formam UMA fronteira de consistencia: nao existe estado
 * valido em que o veiculo esteja LOCKED e a trava, expirada. Por isso as
 * transicoes devolvem os dois juntos e devem ser persistidas na mesma operacao.
 */

export function isActive(lock: CommercialLock, now: Instant, policy: LockPolicy): boolean {
  if (lock.status !== LockStatus.ACTIVE) return false;
  return now < effectiveExpiresAt(lock, now, policy);
}

/** Com o relogio parado, o restante nao anda: e o que sobrava quando o carro saiu. */
export function remainingMs(lock: CommercialLock, now: Instant, policy: LockPolicy): number {
  return isActive(lock, now, policy) ? effectiveExpiresAt(lock, now, policy) - now : 0;
}

export function hasEnded(lock: CommercialLock, now: Instant, policy: LockPolicy): boolean {
  return !isActive(lock, now, policy);
}

export function usesOfEvidence(lock: CommercialLock, type: string): number {
  return lock.extensions.filter((extension) => extension.evidence.type === type).length;
}

/** Prazo maximo absoluto desta trava, contado da abertura. */
export function hardDeadline(lock: CommercialLock, policy: LockPolicy): Instant {
  return lock.openedAt + policy.maxTotalMs;
}

/** O relogio esta parado porque o carro esta a caminho de quem travou. */
export function isSuspended(lock: CommercialLock): boolean {
  return lock.suspendedAt !== null;
}

/**
 * Ate quando a trava vale, olhando de agora. Com o relogio correndo e o
 * `expiresAt`; com o relogio parado, e o prazo que ela teria se o carro chegasse
 * neste instante.
 *
 * E a unica resposta para "ate quando esta trava vale", e tudo que decide
 * expiracao, prioridade ou tempo restante passa por aqui. Antes so `isActive`
 * sabia do relogio parado, e respondia "ativa" sem prazo nenhum: o varredor e a
 * regra de prioridade comparavam com o `expiresAt` nominal e expiravam a trava
 * no meio da viagem, e os dois tetos so eram aplicados na chegada — carro que
 * nunca chegava segurava a trava para sempre, acima ate dos 5 dias.
 *
 * Os tetos sao os de `resumeAfterTransit`, pela mesma conta: o tempo parado
 * devolvido nunca passa de `maxTransitSuspensionMs`, e o prazo nunca passa do
 * teto absoluto contado da abertura.
 */
export function effectiveExpiresAt(
  lock: CommercialLock,
  now: Instant,
  policy: LockPolicy,
): Instant {
  if (lock.suspendedAt === null) return lock.expiresAt;
  return Math.min(
    lock.expiresAt + transitTimeReturned(lock.suspendedAt, now, policy),
    hardDeadline(lock, policy),
  );
}

function transitTimeReturned(suspendedAt: Instant, now: Instant, policy: LockPolicy): number {
  return Math.min(Math.max(0, now - suspendedAt), policy.maxTransitSuspensionMs);
}

/**
 * A trava como a regra de prioridade a enxerga: com o prazo efetivo, nao o
 * nominal. `null` quando ela ja nao vale.
 *
 * Existe para que quem monta a pergunta de prioridade nao copie o `expiresAt`
 * cru — foi assim que o recall pedido com o carro a caminho de quem travou
 * passava por cima de uma exclusividade ainda valendo.
 */
export function lockForPriority(
  lock: CommercialLock | null,
  now: Instant,
  policy: LockPolicy,
): ActiveLockView | null {
  if (lock === null || !isActive(lock, now, policy)) return null;
  return {
    lockId: lock.id,
    holderStoreId: lock.holderStoreId,
    expiresAt: effectiveExpiresAt(lock, now, policy),
  };
}

/**
 * Para o relogio: o carro entrou em transito rumo a quem detem a trava.
 *
 * So faz sentido quando o destino e o proprio detentor — carro indo para
 * qualquer outro lugar nao atrapalha o atendimento dele.
 */
export function suspendForTransit(
  lock: CommercialLock,
  toStoreId: StoreId,
  now: Instant,
  policy: LockPolicy,
): Transition<CommercialLock> {
  if (!isActive(lock, now, policy)) return unchanged(lock);
  if (isSuspended(lock)) return unchanged(lock);
  if (toStoreId !== lock.holderStoreId) return unchanged(lock);

  return transitioned({ ...lock, suspendedAt: now }, [
    domainEvent('lock.suspended_for_transit', lock.vehicleId, now, {
      lockId: lock.id,
      holderStoreId: lock.holderStoreId,
      expiresAt: lock.expiresAt,
    }),
  ]);
}

/**
 * O carro chegou (ou a viagem morreu): o relogio volta a correr, e o prazo anda
 * para frente pelo tempo que ficou parado.
 *
 * Dois tetos cortam, e os dois precisam existir. `maxTransitSuspensionMs`
 * impede que um carro perdido no caminho segure a trava por dias; o teto
 * absoluto (`maxTotalMs`, contado da ABERTURA) continua valendo por cima, entao
 * suspender nunca vira um jeito de ultrapassar os 5 dias.
 */
export function resumeAfterTransit(
  lock: CommercialLock,
  now: Instant,
  policy: LockPolicy = DEFAULT_LOCK_POLICY,
): Transition<CommercialLock> {
  const suspendedAt = lock.suspendedAt;
  if (suspendedAt === null) return unchanged(lock);

  const parado = Math.max(0, now - suspendedAt);
  const devolvido = transitTimeReturned(suspendedAt, now, policy);
  const teto = hardDeadline(lock, policy);
  const retomada = settleSuspension(lock, now, policy);
  const novoPrazo = retomada.expiresAt;

  return transitioned(
    retomada,
    [
      domainEvent('lock.resumed_after_transit', lock.vehicleId, now, {
        lockId: lock.id,
        holderStoreId: lock.holderStoreId,
        suspendedMs: parado,
        grantedMs: devolvido,
        cappedByTransitLimit: parado > policy.maxTransitSuspensionMs,
        cappedByHardDeadline: lock.expiresAt + devolvido > teto,
        newExpiresAt: novoPrazo,
      }),
    ],
  );
}

/**
 * Fecha a conta do relogio parado: o prazo efetivo vira o `expiresAt`, e o
 * relogio volta a correr. Serve a chegada do carro e a expiracao em transito —
 * nos dois casos o registro precisa dizer o prazo que de fato valeu.
 */
function settleSuspension(lock: CommercialLock, now: Instant, policy: LockPolicy): CommercialLock {
  if (lock.suspendedAt === null) return lock;
  return {
    ...lock,
    expiresAt: effectiveExpiresAt(lock, now, policy),
    suspendedAt: null,
    suspendedMs: lock.suspendedMs + transitTimeReturned(lock.suspendedAt, now, policy),
  };
}

// ---------------------------------------------------------------------------
// Abertura
// ---------------------------------------------------------------------------

export type OpenLockCommand = {
  readonly lockId: LockId;
  readonly vehicle: Vehicle;
  readonly holderStore: Store;
  readonly holderUser: NetworkUser;
  /** A empresa do patio: inadimplencia dela tambem impede travar. */
  readonly holderMember: Member;
  readonly customerReference?: string | undefined;
  readonly now: Instant;
  readonly policy?: LockPolicy;
};

export function openLock(command: OpenLockCommand): Transition<VehicleWithLock> {
  const policy = command.policy ?? DEFAULT_LOCK_POLICY;
  const { vehicle, holderStore, holderMember, holderUser, now } = command;

  if (!canTransact(holderStore, holderMember)) {
    return err(
      forbiddenError(
        'STORE_NOT_ACTIVE',
        'Loja suspensa, empresa inadimplente ou fora da rede nao abre trava comercial.',
        {
          storeId: holderStore.id,
          storeStatus: holderStore.status,
          memberId: holderMember.id,
          memberStatus: holderMember.status,
        },
      ),
    );
  }
  if (holderUser.storeId !== holderStore.id || !holderUser.active) {
    return err(
      forbiddenError('USER_NOT_IN_STORE', 'Usuario nao pertence a loja informada ou esta inativo.', {
        userId: holderUser.id,
        storeId: holderStore.id,
      }),
    );
  }

  switch (vehicle.commercialStatus) {
    case CommercialStatus.AVAILABLE:
      break;
    case CommercialStatus.LOCKED:
      return err(
        conflictError(
          'VEHICLE_ALREADY_LOCKED',
          'Ja existe uma trava comercial ativa para este veiculo.',
          { vehicleId: vehicle.id, lockId: vehicle.activeLockId },
        ),
      );
    case CommercialStatus.SOLD:
      return err(
        conflictError('VEHICLE_SOLD', 'Veiculo ja vendido.', { vehicleId: vehicle.id }),
      );
    case CommercialStatus.DRAFT:
      return err(
        ruleViolation(
          'VEHICLE_NOT_PUBLISHED',
          'Veiculo sem laudo cautelar aprovado nao circula na rede.',
          { vehicleId: vehicle.id, inspectionStatus: vehicle.inspection.status },
        ),
      );
    case CommercialStatus.WITHDRAWN:
      return err(
        conflictError(
          'VEHICLE_WITHDRAWN',
          'Veiculo retirado da rede pela loja proprietaria.',
          { vehicleId: vehicle.id },
        ),
      );
  }

  if (!isInspectionValid(vehicle.inspection, now)) {
    return err(
      ruleViolation(
        'INSPECTION_NOT_VALID',
        'O laudo cautelar deste veiculo esta ausente, reprovado ou vencido.',
        { vehicleId: vehicle.id, inspectionStatus: vehicle.inspection.status },
      ),
    );
  }

  const reference = command.customerReference?.trim();
  const lock: CommercialLock = {
    id: command.lockId,
    vehicleId: vehicle.id,
    holderStoreId: holderStore.id,
    holderUserId: holderUser.id,
    openedAt: now,
    expiresAt: now + policy.baseTtlMs,
    status: LockStatus.ACTIVE,
    netPriceSnapshot: vehicle.pricing.netPrice,
    extensions: [],
    customerReference: reference !== undefined && reference.length > 0 ? reference : null,
    suspendedAt: null,
    suspendedMs: 0,
    endedAt: null,
    endReason: null,
    dealId: null,
  };

  const updatedVehicle: Vehicle = {
    ...vehicle,
    commercialStatus: CommercialStatus.LOCKED,
    activeLockId: lock.id,
    updatedAt: now,
  };

  return transitioned({ vehicle: updatedVehicle, lock }, [
    domainEvent('lock.opened', vehicle.id, now, {
      lockId: lock.id,
      holderStoreId: holderStore.id,
      holderUserId: holderUser.id,
      expiresAt: lock.expiresAt,
      ttlMs: policy.baseTtlMs,
      netPriceSnapshotCents: lock.netPriceSnapshot.cents,
      /** A loja dona travando o proprio carro tambem congela a rede. */
      holderIsOwner: holderStore.id === vehicle.ownerStoreId,
      /** Sinaliza estoque avancado: o carro esta no patio de outra loja. */
      custodianStoreId: vehicle.physical.custodianStoreId,
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Extensao
// ---------------------------------------------------------------------------

export type ExtendLockCommand = {
  readonly vehicle: Vehicle;
  readonly lock: CommercialLock;
  readonly actorStoreId: StoreId;
  readonly actorUserId: UserId;
  readonly evidence: Evidence;
  readonly now: Instant;
  readonly policy?: LockPolicy;
};

export function extendLock(command: ExtendLockCommand): Transition<VehicleWithLock> {
  const policy = command.policy ?? DEFAULT_LOCK_POLICY;
  const { vehicle, lock, evidence, now } = command;

  if (lock.holderStoreId !== command.actorStoreId) {
    return err(
      forbiddenError('NOT_LOCK_HOLDER', 'Somente a loja que abriu a trava pode estende-la.', {
        lockId: lock.id,
        holderStoreId: lock.holderStoreId,
      }),
    );
  }

  // Uma trava vencida nao ressuscita: enquanto ela estava vencida o carro estava
  // livre e outra loja pode ter fechado. Reabrir e disputar de novo, na fila.
  if (!isActive(lock, now, policy)) {
    return err(
      conflictError(
        'LOCK_NOT_ACTIVE',
        lock.status === LockStatus.ACTIVE
          ? 'A trava expirou. O veiculo voltou a ficar disponivel para a rede — abra uma nova trava.'
          : `A trava ja foi encerrada (${lock.status}).`,
        { lockId: lock.id, status: lock.status, expiresAt: lock.expiresAt },
      ),
    );
  }

  const grant = grantFor(policy, evidence.type);
  const used = usesOfEvidence(lock, evidence.type);
  if (used >= grant.maxUses) {
    return err(
      ruleViolation(
        'EVIDENCE_QUOTA_EXCEEDED',
        `"${grant.label}" ja foi usada ${used}x nesta trava (limite ${grant.maxUses}). Registre um avanco real do funil.`,
        { lockId: lock.id, evidenceType: evidence.type, used, maxUses: grant.maxUses },
      ),
    );
  }
  if (grant.requiresAttachment && (evidence.attachmentUrl ?? '').trim().length === 0) {
    return err(
      ruleViolation(
        'EVIDENCE_ATTACHMENT_REQUIRED',
        `"${grant.label}" exige anexo do comprovante.`,
        { lockId: lock.id, evidenceType: evidence.type },
      ),
    );
  }

  const deadline = hardDeadline(lock, policy);
  if (lock.expiresAt >= deadline) {
    return err(
      ruleViolation(
        'LOCK_MAX_DURATION_REACHED',
        `Esta trava atingiu o teto de ${formatDuration(policy.maxTotalMs)} desde a abertura. Feche a negociacao ou libere o veiculo.`,
        { lockId: lock.id, openedAt: lock.openedAt, maxTotalMs: policy.maxTotalMs },
      ),
    );
  }

  const desired = lock.expiresAt + grant.extensionMs;
  const newExpiresAt = Math.min(desired, deadline);
  const cappedByPolicy = newExpiresAt < desired;

  const extension: LockExtension = {
    evidence,
    grantedMs: newExpiresAt - lock.expiresAt,
    extendedAt: now,
    extendedByUserId: command.actorUserId,
    previousExpiresAt: lock.expiresAt,
    newExpiresAt,
    cappedByPolicy,
  };

  const extended: CommercialLock = {
    ...lock,
    expiresAt: newExpiresAt,
    extensions: [...lock.extensions, extension],
  };

  return transitioned({ vehicle, lock: extended }, [
    domainEvent('lock.extended', vehicle.id, now, {
      lockId: lock.id,
      evidenceType: evidence.type,
      grantedMs: extension.grantedMs,
      previousExpiresAt: extension.previousExpiresAt,
      newExpiresAt,
      cappedByPolicy,
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Encerramento
// ---------------------------------------------------------------------------

export type ReleaseLockCommand = {
  readonly vehicle: Vehicle;
  readonly lock: CommercialLock;
  readonly actorStoreId: StoreId;
  readonly reason?: string | undefined;
  readonly now: Instant;
};

/**
 * Liberacao antecipada pela propria Loja B (cliente desistiu).
 *
 * So o detentor libera. A loja dona NAO pode cancelar a trava de terceiro: a
 * exclusividade dentro do prazo e o que a Loja B compra ao assumir o cliente.
 * Para reaver o carro, a dona usa recall — que respeita o prazo (ver `recall`).
 */
export function releaseLock(command: ReleaseLockCommand): Transition<VehicleWithLock> {
  const { vehicle, lock, now } = command;

  if (lock.holderStoreId !== command.actorStoreId) {
    return err(
      forbiddenError(
        'NOT_LOCK_HOLDER',
        'Somente a loja que abriu a trava pode libera-la antes do prazo.',
        { lockId: lock.id, holderStoreId: lock.holderStoreId },
      ),
    );
  }
  if (lock.status !== LockStatus.ACTIVE) {
    return unchanged({ vehicle, lock });
  }

  return endLock(vehicle, lock, LockEndReason.RELEASED_BY_HOLDER, now, {
    reason: command.reason ?? null,
  });
}

/**
 * Materializa a expiracao por decurso de prazo. Idempotente: pode ser chamada a
 * cada leitura do veiculo e pelo varredor periodico sem efeito duplicado.
 */
export function expireLockIfDue(
  vehicle: Vehicle,
  lock: CommercialLock,
  now: Instant,
  policy: LockPolicy,
): Transition<VehicleWithLock> {
  if (lock.status !== LockStatus.ACTIVE || isActive(lock, now, policy)) {
    return unchanged({ vehicle, lock });
  }
  // Vencida com o carro ainda a caminho, o prazo que valeu e o efetivo, nao o
  // nominal: o registro diz quando ela venceu de fato.
  const venceu = settleSuspension(lock, now, policy);
  return endLock(vehicle, venceu, LockEndReason.TTL_EXPIRED, now, {
    heldForMs: venceu.expiresAt - venceu.openedAt,
    extensionsUsed: venceu.extensions.length,
    expiredInTransit: lock.suspendedAt !== null,
  });
}

export type ConvertLockCommand = {
  readonly vehicle: Vehicle;
  readonly lock: CommercialLock;
  readonly dealId: DealId;
  readonly now: Instant;
  readonly policy: LockPolicy;
};

/** Converte a trava em venda fechada. Chamado pela confirmacao do deal. */
export function convertLockToDeal(command: ConvertLockCommand): Transition<VehicleWithLock> {
  const { vehicle, lock, now, policy } = command;

  if (!isActive(lock, now, policy)) {
    return err(
      conflictError(
        'LOCK_NOT_ACTIVE',
        'A trava nao esta mais ativa; nao e possivel converte-la em venda.',
        { lockId: lock.id, status: lock.status, expiresAt: lock.expiresAt },
      ),
    );
  }

  const converted: CommercialLock = {
    ...lock,
    status: LockStatus.CONVERTED,
    endedAt: now,
    endReason: LockEndReason.CONVERTED_TO_DEAL,
    dealId: command.dealId,
  };
  const soldVehicle: Vehicle = {
    ...vehicle,
    commercialStatus: CommercialStatus.SOLD,
    activeLockId: null,
    updatedAt: now,
  };

  return transitioned({ vehicle: soldVehicle, lock: converted }, [
    domainEvent('lock.converted', vehicle.id, now, {
      lockId: lock.id,
      dealId: command.dealId,
      holderStoreId: lock.holderStoreId,
    }),
  ]);
}

/**
 * Encerramento comum a expiracao e liberacao.
 *
 * Duas coisas acontecem aqui, e a segunda e a alma do produto:
 *  1. a trava fecha e o preco liquido represado (se houver) passa a valer;
 *  2. o veiculo volta a ficar DISPONIVEL **sem mudar de lugar**. Ele segue no
 *     patio de quem estava com ele, agora como oportunidade de balcao para essa
 *     loja e como estoque ofertado para toda a rede, ao mesmo tempo.
 */
function endLock(
  vehicle: Vehicle,
  lock: CommercialLock,
  reason: LockEndReason,
  now: Instant,
  extraPayload: Record<string, unknown>,
): Transition<VehicleWithLock> {
  assertInvariant(
    reason !== LockEndReason.CONVERTED_TO_DEAL,
    'conversao em venda tem caminho proprio (convertLockToDeal)',
  );

  const endedLock: CommercialLock = {
    ...lock,
    status: reason === LockEndReason.TTL_EXPIRED ? LockStatus.EXPIRED : LockStatus.RELEASED,
    endedAt: now,
    endReason: reason,
  };

  const events: DomainEvent[] = [
    domainEvent(reason === LockEndReason.TTL_EXPIRED ? 'lock.expired' : 'lock.released', vehicle.id, now, {
      lockId: lock.id,
      holderStoreId: lock.holderStoreId,
      ...extraPayload,
    }),
  ];

  // Preco represado durante a trava passa a valer agora.
  let released: Vehicle = { ...vehicle, activeLockId: null, updatedAt: now };
  const priceTransition = applyPendingNetPrice(released, now);
  if (priceTransition.ok) {
    released = priceTransition.value.state;
    events.push(...priceTransition.value.events);
  }

  const { status, listingEvent } = settleCommercialStatusAfterLock(released, now);
  released = { ...released, commercialStatus: status };
  if (listingEvent !== null) events.push(listingEvent);

  return transitioned({ vehicle: released, lock: endedLock }, events);
}

/**
 * Para onde vai o status comercial quando a trava cai.
 *
 * O caso normal e voltar a DISPONIVEL. Ha duas excecoes, e as duas evitam
 * ofertar a rede um carro que nao pode ser entregue:
 *  - laudo venceu ou foi reprovado durante a trava -> volta a DRAFT;
 *  - o dono removeu o carro do proprio feed E o carro esta no patio dele ->
 *    RETIRADO. Se estiver no patio de outra loja, permanece disponivel e
 *    sinalizado, porque a decisao envolve logistica e precisa de gente.
 */
function settleCommercialStatusAfterLock(
  vehicle: Vehicle,
  now: Instant,
): { status: CommercialStatus; listingEvent: DomainEvent | null } {
  if (!isInspectionValid(vehicle.inspection, now)) {
    return {
      status: CommercialStatus.DRAFT,
      listingEvent: domainEvent('vehicle.unlisted', vehicle.id, now, {
        reason: 'INSPECTION_NOT_VALID',
      }),
    };
  }
  if (vehicle.missingFromFeed && vehicle.physical.custodianStoreId === vehicle.ownerStoreId) {
    return {
      status: CommercialStatus.WITHDRAWN,
      listingEvent: domainEvent('vehicle.withdrawn', vehicle.id, now, {
        reason: 'REMOVED_FROM_OWNER_FEED',
      }),
    };
  }
  return {
    status: CommercialStatus.AVAILABLE,
    listingEvent: domainEvent('vehicle.available_again', vehicle.id, now, {
      // O broadcast precisa saber a praca: "voltou para a rede" e uma rede so.
      clusterId: vehicle.clusterId,
      custodianStoreId: vehicle.physical.custodianStoreId,
      ownerStoreId: vehicle.ownerStoreId,
      /** Verdadeiro no cenario de estoque avancado: livre para a rede, parado na Loja B. */
      onExtendedCustody: vehicle.physical.custodianStoreId !== vehicle.ownerStoreId,
    }),
  };
}

export function describeLock(lock: CommercialLock, now: Instant, policy: LockPolicy): string {
  if (!isActive(lock, now, policy)) return `trava ${lock.status.toLowerCase()}`;
  return `trava ativa, restam ${formatDuration(remainingMs(lock, now, policy))}`;
}
