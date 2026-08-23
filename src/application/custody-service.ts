/**
 * Casos de uso de custodia fisica e de recall.
 *
 * Os dois vivem no mesmo servico porque se encontram num ponto: a entrada
 * assinada do veiculo no patio da loja proprietaria e o que CUMPRE um recall.
 * Separar os dois obrigaria o cliente da API a lembrar de "fechar o recall"
 * depois de dar entrada no carro — e o recall ficaria eternamente aberto na
 * primeira vez que alguem esquecesse.
 */

import { type Result, err, ok } from '../domain/shared/result.ts';
import type { DomainError } from '../domain/shared/errors.ts';
import { forbiddenError } from '../domain/shared/errors.ts';
import type { DomainEvent } from '../domain/shared/events.ts';
import type { Instant } from '../domain/shared/clock.ts';
import {
  asCustodyTransferId,
  asRecallId,
  asVehicleId,
  type CustodyTransferId,
  type RecallId,
  type StoreId,
  type VehicleId,
} from '../domain/shared/ids.ts';
import { hasManagerPowers } from '../domain/network/store.ts';
import {
  type CustodyTransfer,
  type InspectionTerm,
  type TransferPurpose,
  TransferPurpose as Purpose,
  cancelTransfer,
  checkIn,
  deliverToConsumer,
  openTransfer,
} from '../domain/custody/custody.ts';
import { type CustodyPeriod, attributeInfraction, buildCustodyLedger } from '../domain/custody/ledger.ts';
import {
  type ActiveLockView,
  type Recall,
  type RecallReason,
  cancelRecall,
  flagBreachIfOverdue,
  fulfillRecall,
  isOpen as isRecallOpen,
  requestRecall,
  resolvePriority,
} from '../domain/recall/recall.ts';
import { type Actor, type AppContext, publish } from './context.ts';
import { recallNotFound, transferNotFound, vehicleNotFound } from './errors.ts';
import { loadVehicle } from './inventory-service.ts';

// ---------------------------------------------------------------------------
// Movimentacao de patio
// ---------------------------------------------------------------------------

export type OpenTransferInput = {
  readonly vehicleId: VehicleId;
  readonly toStoreId: StoreId;
  readonly purpose: TransferPurpose;
  readonly checkout: InspectionTerm;
};

export async function startCustodyTransfer(
  context: AppContext,
  actor: Actor,
  input: OpenTransferInput,
): Promise<Result<{ vehicle: unknown; transfer: CustodyTransfer }, DomainError>> {
  if (!hasManagerPowers(actor.user)) {
    return err(forbiddenError('MANAGER_ROLE_REQUIRED', 'Somente gerente ou titular assina a saida do veiculo.'));
  }

  const loaded = await loadVehicle(context, input.vehicleId);
  if (!loaded.ok) return loaded;

  const destination = await context.repos.stores.byId(input.toStoreId);
  if (destination === undefined) {
    return err(forbiddenError('DESTINATION_NOT_IN_NETWORK', 'A loja de destino nao pertence a rede.'));
  }

  // Se o retorno atende um recall aberto, o termo ja nasce vinculado a ele.
  const openRecall = await context.repos.recalls.openByVehicle(input.vehicleId);
  const fulfillsRecall =
    openRecall !== undefined && input.toStoreId === loaded.value.vehicle.ownerStoreId;

  const transition = openTransfer({
    transferId: asCustodyTransferId(context.ids.next('cst')),
    vehicle: loaded.value.vehicle,
    toStoreId: input.toStoreId,
    purpose: fulfillsRecall ? Purpose.RECALL_RETURN : input.purpose,
    checkout: input.checkout,
    recallId: fulfillsRecall ? openRecall.id : null,
    activeLockHolderStoreId: loaded.value.lock?.holderStoreId ?? null,
    now: context.clock.now(),
  });
  if (!transition.ok) return transition;

  const { state, events } = transition.value;
  await context.repos.vehicles.save(state.vehicle);
  await context.repos.transfers.save(state.transfer);
  await publish(context, events, actor);
  return ok({ vehicle: state.vehicle, transfer: state.transfer });
}

export async function completeCustodyTransfer(
  context: AppContext,
  actor: Actor,
  transferId: CustodyTransferId,
  term: InspectionTerm,
): Promise<Result<{ transfer: CustodyTransfer; recall: Recall | null }, DomainError>> {
  if (!hasManagerPowers(actor.user)) {
    return err(forbiddenError('MANAGER_ROLE_REQUIRED', 'Somente gerente ou titular assina a entrada do veiculo.'));
  }

  const transfer = await context.repos.transfers.byId(transferId);
  if (transfer === undefined) return err(transferNotFound(transferId));

  const loaded = await loadVehicle(context, asVehicleId(transfer.vehicleId));
  if (!loaded.ok) return loaded;

  const transition = checkIn({
    vehicle: loaded.value.vehicle,
    transfer,
    checkin: term,
    now: context.clock.now(),
    policy: context.policies.custody,
  });
  if (!transition.ok) return transition;

  const { state, events } = transition.value;
  await context.repos.vehicles.save(state.vehicle);
  await context.repos.transfers.save(state.transfer);
  await publish(context, events, actor);

  // O carro chegou ao patio da dona: e isso que cumpre o recall.
  const recall = await settleRecallOnArrival(context, state.vehicle.ownerStoreId, state.transfer);
  return ok({ transfer: state.transfer, recall });
}

async function settleRecallOnArrival(
  context: AppContext,
  ownerStoreId: StoreId,
  transfer: CustodyTransfer,
): Promise<Recall | null> {
  if (transfer.toStoreId !== ownerStoreId) return null;

  const recall = await context.repos.recalls.openByVehicle(asVehicleId(transfer.vehicleId));
  if (recall === undefined) return null;

  const transition = fulfillRecall({
    recall,
    transferId: transfer.id,
    now: context.clock.now(),
    policy: context.policies.recall,
  });
  if (!transition.ok) return recall;

  await context.repos.recalls.save(transition.value.state);
  await publish(context, transition.value.events);
  return transition.value.state;
}

export async function abortCustodyTransfer(
  context: AppContext,
  actor: Actor,
  transferId: CustodyTransferId,
  reason: string,
): Promise<Result<CustodyTransfer, DomainError>> {
  const transfer = await context.repos.transfers.byId(transferId);
  if (transfer === undefined) return err(transferNotFound(transferId));

  const loaded = await loadVehicle(context, asVehicleId(transfer.vehicleId));
  if (!loaded.ok) return loaded;

  const transition = cancelTransfer({
    vehicle: loaded.value.vehicle,
    transfer,
    actorStoreId: actor.store.id,
    reason,
    now: context.clock.now(),
  });
  if (!transition.ok) return transition;

  const { state, events } = transition.value;
  await context.repos.vehicles.save(state.vehicle);
  await context.repos.transfers.save(state.transfer);
  await publish(context, events, actor);
  return ok(state.transfer);
}

export async function deliverVehicleToConsumer(
  context: AppContext,
  actor: Actor,
  vehicleId: VehicleId,
  finalTerm: InspectionTerm,
): Promise<Result<unknown, DomainError>> {
  const loaded = await loadVehicle(context, vehicleId);
  if (!loaded.ok) return loaded;

  const transition = deliverToConsumer({
    vehicle: loaded.value.vehicle,
    actorStoreId: actor.store.id,
    finalTerm,
    now: context.clock.now(),
  });
  if (!transition.ok) return transition;

  await context.repos.vehicles.save(transition.value.state);
  await publish(context, transition.value.events, actor);
  return ok(transition.value.state);
}

// ---------------------------------------------------------------------------
// Consultas de custodia
// ---------------------------------------------------------------------------

export async function custodyHistory(
  context: AppContext,
  vehicleId: VehicleId,
): Promise<Result<{ periods: CustodyPeriod[]; transfers: CustodyTransfer[] }, DomainError>> {
  const vehicle = await context.repos.vehicles.byId(vehicleId);
  if (vehicle === undefined) return err(vehicleNotFound(vehicleId));

  const transfers = await context.repos.transfers.byVehicle(vehicleId);
  return ok({ periods: buildCustodyLedger(vehicle, transfers), transfers });
}

/** Responde "quem respondia pelo veiculo em tal data?" — a pergunta da multa. */
export async function custodianAt(
  context: AppContext,
  vehicleId: VehicleId,
  instant: Instant,
): Promise<Result<ReturnType<typeof attributeInfraction>, DomainError>> {
  const history = await custodyHistory(context, vehicleId);
  if (!history.ok) return history;
  return ok(attributeInfraction(history.value.periods, instant));
}

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

export type RequestRecallInput = {
  readonly vehicleId: VehicleId;
  readonly reason: RecallReason;
  readonly note?: string | undefined;
};

export async function requestVehicleRecall(
  context: AppContext,
  actor: Actor,
  input: RequestRecallInput,
): Promise<Result<Recall, DomainError>> {
  if (!hasManagerPowers(actor.user)) {
    return err(forbiddenError('MANAGER_ROLE_REQUIRED', 'Somente gerente ou titular chama o veiculo de volta.'));
  }

  const loaded = await loadVehicle(context, input.vehicleId);
  if (!loaded.ok) return loaded;

  const lock = loaded.value.lock;
  const activeLock: ActiveLockView | null =
    lock === null
      ? null
      : { lockId: lock.id, holderStoreId: lock.holderStoreId, expiresAt: lock.expiresAt };

  const existing = await context.repos.recalls.openByVehicle(input.vehicleId);

  const transition = requestRecall({
    recallId: asRecallId(context.ids.next('rcl')),
    vehicle: loaded.value.vehicle,
    requestedByStoreId: actor.store.id,
    requestedByUserId: actor.user.id,
    reason: input.reason,
    note: input.note,
    activeLock,
    openRecall: existing ?? null,
    now: context.clock.now(),
    policy: context.policies.recall,
  });
  if (!transition.ok) return transition;

  await context.repos.recalls.save(transition.value.state);
  await publish(context, transition.value.events, actor);
  return ok(transition.value.state);
}

export async function withdrawRecall(
  context: AppContext,
  actor: Actor,
  recallId: RecallId,
): Promise<Result<Recall, DomainError>> {
  const recall = await context.repos.recalls.byId(recallId);
  if (recall === undefined) return err(recallNotFound(recallId));

  const transition = cancelRecall({
    recall,
    actorStoreId: actor.store.id,
    now: context.clock.now(),
  });
  if (!transition.ok) return transition;

  await context.repos.recalls.save(transition.value.state);
  await publish(context, transition.value.events, actor);
  return ok(transition.value.state);
}

/** Varredor de SLA: marca o descumprimento assim que ele acontece. */
export async function sweepRecallBreaches(context: AppContext): Promise<number> {
  const at = context.clock.now();
  const open = await context.repos.recalls.allOpen();
  let breached = 0;
  const events: DomainEvent[] = [];

  for (const recall of open) {
    const transition = flagBreachIfOverdue(recall, at);
    if (!transition.ok || transition.value.events.length === 0) continue;
    await context.repos.recalls.save(transition.value.state);
    events.push(...transition.value.events);
    breached += 1;
  }

  if (events.length > 0) await publish(context, events);
  return breached;
}

export type RecallBoard = {
  readonly incoming: readonly Recall[];
  readonly outgoing: readonly Recall[];
};

/** Painel do lojista: o que ele deve devolver e o que ele esta esperando. */
export async function recallBoard(context: AppContext, storeId: StoreId): Promise<RecallBoard> {
  const open = await context.repos.recalls.openForStore(storeId);
  return {
    incoming: open.filter((recall) => recall.custodianStoreId === storeId && isRecallOpen(recall)),
    outgoing: open.filter((recall) => recall.requestedByStoreId === storeId && isRecallOpen(recall)),
  };
}

export { resolvePriority };
