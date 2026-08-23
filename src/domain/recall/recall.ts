/**
 * Recall — a chamada de retorno do veiculo pela loja proprietaria.
 *
 * Esta e a regra que faz o estoque avancado funcionar sem virar sequestro de
 * estoque alheio. Ela tem exatamente duas configuracoes, e a diferenca entre
 * elas e o status COMERCIAL, nunca o fisico:
 *
 *   Carro no patio da Loja B, comercialmente DISPONIVEL
 *     -> a Loja A tem prioridade total. Pediu, a Loja B libera dentro do SLA
 *        (4 horas UTEIS). O carro e da Loja A; a Loja B so o estava expondo.
 *
 *   Carro no patio da Loja B, com TRAVA ATIVA
 *     -> a Loja B tem prioridade exclusiva ate o timer zerar. O recall e
 *        aceito, mas fica AGUARDANDO: o SLA so comeca a correr quando a trava
 *        cair. Sem isso, a Loja A poderia derrubar por telefone uma negociacao
 *        que a Loja B ja prometeu ao cliente — e a trava nao valeria nada.
 *
 * E se a negociacao travada FECHAR? O recall e cancelado: nao ha o que devolver,
 * o carro foi vendido — que era o objetivo de todo mundo desde o inicio.
 */

import { err } from '../shared/result.ts';
import { conflictError, forbiddenError, ruleViolation } from '../shared/errors.ts';
import { type DomainEvent, domainEvent } from '../shared/events.ts';
import { type Transition, transitioned, unchanged } from '../shared/transition.ts';
import type { Instant } from '../shared/clock.ts';
import type { CustodyTransferId, DealId, RecallId, StoreId, UserId } from '../shared/ids.ts';
import {
  type BusinessCalendar,
  addBusinessHours,
  businessMinutesBetween,
} from '../shared/business-hours.ts';
import { type Vehicle, CommercialStatus, PhysicalState } from '../vehicle/vehicle.ts';

export const RecallStatus = {
  /** Aceito, mas represado por trava comercial ativa de outra loja. */
  WAITING_LOCK_RELEASE: 'WAITING_LOCK_RELEASE',
  /** SLA correndo: a loja custodiante deve disponibilizar o retorno. */
  DUE: 'DUE',
  /** Veiculo devolvido (termo de custodia de retorno concluido). */
  FULFILLED: 'FULFILLED',
  /** Cancelado pela propria loja proprietaria, ou porque o carro foi vendido. */
  CANCELLED: 'CANCELLED',
} as const;
export type RecallStatus = (typeof RecallStatus)[keyof typeof RecallStatus];

export const RecallReason = {
  /** A loja proprietaria tem cliente proprio para o carro. */
  OWN_SALE: 'OWN_SALE',
  /** Rotacao de patio / reposicao de vitrine. */
  YARD_RETURN: 'YARD_RETURN',
  MAINTENANCE: 'MAINTENANCE',
  OTHER: 'OTHER',
} as const;
export type RecallReason = (typeof RecallReason)[keyof typeof RecallReason];

export const RecallCancelReason = {
  WITHDRAWN_BY_OWNER: 'WITHDRAWN_BY_OWNER',
  /** A negociacao travada fechou: o carro foi vendido, nao ha o que devolver. */
  SUPERSEDED_BY_SALE: 'SUPERSEDED_BY_SALE',
} as const;
export type RecallCancelReason = (typeof RecallCancelReason)[keyof typeof RecallCancelReason];

export type RecallPolicy = {
  /** Horas UTEIS para disponibilizar o retorno. 4, por contrato de rede. */
  readonly slaBusinessHours: number;
  readonly calendar: BusinessCalendar;
};

export type Recall = {
  readonly id: RecallId;
  readonly vehicleId: string;
  readonly requestedByStoreId: StoreId;
  readonly requestedByUserId: UserId;
  /** Loja que estava com o carro no momento do pedido. */
  readonly custodianStoreId: StoreId;
  readonly reason: RecallReason;
  readonly note: string | null;
  readonly requestedAt: Instant;
  readonly status: RecallStatus;
  /** Trava que segurou o inicio do SLA, se houve. */
  readonly blockedByLockId: string | null;
  /** Quando o SLA comecou a correr. `null` enquanto aguarda a trava. */
  readonly slaStartedAt: Instant | null;
  /** Prazo final em horas uteis. `null` enquanto aguarda a trava. */
  readonly dueAt: Instant | null;
  readonly fulfilledAt: Instant | null;
  readonly fulfilledByTransferId: CustodyTransferId | null;
  readonly cancelledAt: Instant | null;
  readonly cancelReason: RecallCancelReason | null;
  /** Marcado pelo varredor no primeiro instante em que o SLA venceu. */
  readonly breachedAt: Instant | null;
};

// ---------------------------------------------------------------------------
// Prioridade
// ---------------------------------------------------------------------------

export const PriorityHolder = {
  OWNER: 'OWNER',
  LOCK_HOLDER: 'LOCK_HOLDER',
} as const;
export type PriorityHolder = (typeof PriorityHolder)[keyof typeof PriorityHolder];

export type PriorityRuling = {
  readonly holder: PriorityHolder;
  readonly holderStoreId: StoreId;
  /** Ate quando a prioridade do detentor da trava vale. */
  readonly until: Instant | null;
  readonly rationale: string;
};

export type ActiveLockView = {
  readonly lockId: string;
  readonly holderStoreId: StoreId;
  readonly expiresAt: Instant;
};

/**
 * Quem manda no veiculo agora. Funcao pura — e o coracao da regra de conflito,
 * e por isso ela vive isolada, sem depender de repositorio nem de relogio real.
 */
export function resolvePriority(
  vehicle: Vehicle,
  activeLock: ActiveLockView | null,
  now: Instant,
): PriorityRuling {
  const lockIsLive = activeLock !== null && now < activeLock.expiresAt;

  if (lockIsLive && activeLock.holderStoreId !== vehicle.ownerStoreId) {
    return {
      holder: PriorityHolder.LOCK_HOLDER,
      holderStoreId: activeLock.holderStoreId,
      until: activeLock.expiresAt,
      rationale:
        'Ha trava comercial ativa: a loja que abriu a negociacao tem exclusividade ate o fim do prazo.',
    };
  }

  return {
    holder: PriorityHolder.OWNER,
    holderStoreId: vehicle.ownerStoreId,
    until: null,
    rationale: lockIsLive
      ? 'A propria loja proprietaria detem a trava.'
      : 'Sem trava ativa: a loja proprietaria tem prioridade sobre o veiculo.',
  };
}

// ---------------------------------------------------------------------------
// Abertura
// ---------------------------------------------------------------------------

export type RequestRecallCommand = {
  readonly recallId: RecallId;
  readonly vehicle: Vehicle;
  readonly requestedByStoreId: StoreId;
  readonly requestedByUserId: UserId;
  readonly reason: RecallReason;
  readonly note?: string | undefined;
  readonly activeLock: ActiveLockView | null;
  readonly openRecall: Recall | null;
  readonly now: Instant;
  readonly policy: RecallPolicy;
};

export function requestRecall(command: RequestRecallCommand): Transition<Recall> {
  const { vehicle, activeLock, now, policy } = command;

  if (command.requestedByStoreId !== vehicle.ownerStoreId) {
    return err(
      forbiddenError(
        'NOT_VEHICLE_OWNER',
        'Somente a loja proprietaria pode chamar o veiculo de volta.',
        { vehicleId: vehicle.id, ownerStoreId: vehicle.ownerStoreId },
      ),
    );
  }
  if (vehicle.physical.custodianStoreId === vehicle.ownerStoreId) {
    return err(
      ruleViolation(
        'VEHICLE_ALREADY_AT_OWNER',
        'O veiculo ja esta no patio da loja proprietaria.',
        { vehicleId: vehicle.id },
      ),
    );
  }
  if (vehicle.physical.state === PhysicalState.DELIVERED_TO_CONSUMER) {
    return err(
      conflictError('VEHICLE_DELIVERED', 'Veiculo ja entregue ao comprador final.', {
        vehicleId: vehicle.id,
      }),
    );
  }
  if (vehicle.commercialStatus === CommercialStatus.SOLD) {
    return err(
      conflictError('VEHICLE_SOLD', 'Veiculo vendido: o proximo passo e a entrega ao comprador.', {
        vehicleId: vehicle.id,
      }),
    );
  }
  if (command.openRecall !== null && isOpen(command.openRecall)) {
    return err(
      conflictError('RECALL_ALREADY_OPEN', 'Ja existe um recall em aberto para este veiculo.', {
        vehicleId: vehicle.id,
        recallId: command.openRecall.id,
      }),
    );
  }

  const ruling = resolvePriority(vehicle, activeLock, now);
  const blockedByLock = ruling.holder === PriorityHolder.LOCK_HOLDER;

  const base = {
    id: command.recallId,
    vehicleId: vehicle.id,
    requestedByStoreId: command.requestedByStoreId,
    requestedByUserId: command.requestedByUserId,
    custodianStoreId: vehicle.physical.custodianStoreId,
    reason: command.reason,
    note: command.note?.trim() ?? null,
    requestedAt: now,
    fulfilledAt: null,
    fulfilledByTransferId: null,
    cancelledAt: null,
    cancelReason: null,
    breachedAt: null,
  } as const;

  if (blockedByLock) {
    const recall: Recall = {
      ...base,
      status: RecallStatus.WAITING_LOCK_RELEASE,
      blockedByLockId: activeLock?.lockId ?? null,
      slaStartedAt: null,
      dueAt: null,
    };
    return transitioned(recall, [
      domainEvent('recall.requested', vehicle.id, now, {
        recallId: recall.id,
        status: recall.status,
        custodianStoreId: recall.custodianStoreId,
        reason: command.reason,
        blockedByLockId: recall.blockedByLockId,
        lockExpiresAt: activeLock?.expiresAt ?? null,
      }),
    ]);
  }

  const dueAt = addBusinessHours(now, policy.slaBusinessHours, policy.calendar);
  const recall: Recall = {
    ...base,
    status: RecallStatus.DUE,
    blockedByLockId: null,
    slaStartedAt: now,
    dueAt,
  };

  return transitioned(recall, [
    domainEvent('recall.requested', vehicle.id, now, {
      recallId: recall.id,
      status: recall.status,
      custodianStoreId: recall.custodianStoreId,
      reason: command.reason,
      dueAt,
      slaBusinessHours: policy.slaBusinessHours,
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Transicoes
// ---------------------------------------------------------------------------

/**
 * A trava caiu: o SLA comeca a correr agora.
 *
 * O prazo NAO retroage ao pedido. A loja custodiante estava legitimamente
 * segurando o carro durante a trava; cobrar dela um prazo que correu enquanto
 * ela nao podia agir seria punir o comportamento correto.
 */
export function startSlaAfterLockRelease(
  recall: Recall,
  now: Instant,
  policy: RecallPolicy,
): Transition<Recall> {
  if (recall.status !== RecallStatus.WAITING_LOCK_RELEASE) return unchanged(recall);

  const dueAt = addBusinessHours(now, policy.slaBusinessHours, policy.calendar);
  const started: Recall = { ...recall, status: RecallStatus.DUE, slaStartedAt: now, dueAt };

  return transitioned(started, [
    domainEvent('recall.sla_started', recall.vehicleId, now, {
      recallId: recall.id,
      custodianStoreId: recall.custodianStoreId,
      dueAt,
      slaBusinessHours: policy.slaBusinessHours,
      releasedLockId: recall.blockedByLockId,
    }),
  ]);
}

export type FulfillRecallCommand = {
  readonly recall: Recall;
  readonly transferId: CustodyTransferId;
  readonly now: Instant;
  readonly policy: RecallPolicy;
};

/** O carro voltou: a entrada assinada no patio da dona encerra o recall. */
export function fulfillRecall(command: FulfillRecallCommand): Transition<Recall> {
  const { recall, now, policy } = command;

  if (!isOpen(recall)) {
    return err(
      conflictError('RECALL_NOT_OPEN', 'Este recall ja foi encerrado.', {
        recallId: recall.id,
        status: recall.status,
      }),
    );
  }

  const elapsedBusinessMinutes =
    recall.slaStartedAt === null
      ? 0
      : businessMinutesBetween(recall.slaStartedAt, now, policy.calendar);
  const late = recall.dueAt !== null && now > recall.dueAt;

  const fulfilled: Recall = {
    ...recall,
    status: RecallStatus.FULFILLED,
    fulfilledAt: now,
    fulfilledByTransferId: command.transferId,
  };

  const events: DomainEvent[] = [
    domainEvent('recall.fulfilled', recall.vehicleId, now, {
      recallId: recall.id,
      custodianStoreId: recall.custodianStoreId,
      transferId: command.transferId,
      elapsedBusinessMinutes,
      slaBusinessMinutes: policy.slaBusinessHours * 60,
      late,
    }),
  ];

  if (late) {
    events.push(
      domainEvent('recall.sla_breached_on_fulfillment', recall.vehicleId, now, {
        recallId: recall.id,
        custodianStoreId: recall.custodianStoreId,
        dueAt: recall.dueAt,
        overdueBusinessMinutes: elapsedBusinessMinutes - policy.slaBusinessHours * 60,
      }),
    );
  }

  return transitioned(fulfilled, events);
}

export type CancelRecallCommand = {
  readonly recall: Recall;
  readonly actorStoreId: StoreId;
  readonly now: Instant;
};

export function cancelRecall(command: CancelRecallCommand): Transition<Recall> {
  const { recall, now } = command;

  if (!isOpen(recall)) return unchanged(recall);
  if (command.actorStoreId !== recall.requestedByStoreId) {
    return err(
      forbiddenError('NOT_RECALL_REQUESTER', 'Somente a loja que chamou o veiculo pode desistir.', {
        recallId: recall.id,
      }),
    );
  }

  return transitioned(
    {
      ...recall,
      status: RecallStatus.CANCELLED,
      cancelledAt: now,
      cancelReason: RecallCancelReason.WITHDRAWN_BY_OWNER,
    },
    [
      domainEvent('recall.cancelled', recall.vehicleId, now, {
        recallId: recall.id,
        reason: RecallCancelReason.WITHDRAWN_BY_OWNER,
      }),
    ],
  );
}

/**
 * A negociacao travada fechou. Nao ha o que devolver: o carro foi vendido.
 *
 * O recall e cancelado, nao "cumprido" — a loja proprietaria nao recebeu o
 * veiculo de volta, ela recebeu o dinheiro. Se a venda cair depois, o recall
 * NAO ressuscita sozinho: a dona decide se ainda quer o carro de volta, e a
 * decisao envolve logistica que so gente resolve. O evento abaixo e o gancho
 * para avisa-la.
 */
export function supersedeByRecallSale(recall: Recall, dealId: DealId, now: Instant): Transition<Recall> {
  if (!isOpen(recall)) return unchanged(recall);

  return transitioned(
    {
      ...recall,
      status: RecallStatus.CANCELLED,
      cancelledAt: now,
      cancelReason: RecallCancelReason.SUPERSEDED_BY_SALE,
    },
    [
      domainEvent('recall.superseded_by_sale', recall.vehicleId, now, {
        recallId: recall.id,
        dealId,
        requestedByStoreId: recall.requestedByStoreId,
      }),
    ],
  );
}

/**
 * Marca o descumprimento do SLA na primeira vez que ele e detectado.
 * Idempotente: o varredor roda a cada minuto e so o primeiro passa.
 */
export function flagBreachIfOverdue(recall: Recall, now: Instant): Transition<Recall> {
  if (recall.status !== RecallStatus.DUE) return unchanged(recall);
  if (recall.dueAt === null || now <= recall.dueAt) return unchanged(recall);
  if (recall.breachedAt !== null) return unchanged(recall);

  return transitioned({ ...recall, breachedAt: now }, [
    domainEvent('recall.sla_breached', recall.vehicleId, now, {
      recallId: recall.id,
      custodianStoreId: recall.custodianStoreId,
      requestedByStoreId: recall.requestedByStoreId,
      dueAt: recall.dueAt,
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

export function isOpen(recall: Recall): boolean {
  return (
    recall.status === RecallStatus.WAITING_LOCK_RELEASE || recall.status === RecallStatus.DUE
  );
}

export function isOverdue(recall: Recall, now: Instant): boolean {
  return recall.status === RecallStatus.DUE && recall.dueAt !== null && now > recall.dueAt;
}

export function remainingBusinessMinutes(
  recall: Recall,
  now: Instant,
  policy: RecallPolicy,
): number | null {
  if (recall.status !== RecallStatus.DUE || recall.dueAt === null) return null;
  if (now >= recall.dueAt) return 0;
  return businessMinutesBetween(now, recall.dueAt, policy.calendar);
}
