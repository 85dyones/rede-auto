/**
 * Casos de uso da negociacao de repasse.
 *
 * A confirmacao da venda e o ponto em que tres agregados mudam juntos e nao
 * podem divergir: a negociacao fecha, a trava vira venda (e o veiculo sai do
 * estoque da rede) e um eventual recall aberto e cancelado, porque nao ha mais
 * o que devolver. Manter isso num unico caso de uso e o que garante que nao
 * exista um estado intermediario em que o carro esta vendido e ainda travado.
 */

import { type Result, err, ok } from '../domain/shared/result.ts';
import type { DomainError } from '../domain/shared/errors.ts';
import { conflictError, forbiddenError } from '../domain/shared/errors.ts';
import {
  asDealId,
  asSettlementId,
  asVehicleId,
  type DealId,
  type VehicleId,
} from '../domain/shared/ids.ts';
import type { Instant } from '../domain/shared/clock.ts';
import type { Money } from '../domain/shared/money.ts';
import { hasManagerPowers } from '../domain/network/store.ts';
import { convertLockToDeal, isActive } from '../domain/lock/commercial-lock.ts';
import { domainEvent } from '../domain/shared/events.ts';
import { CommercialStatus, isInspectionValid } from '../domain/vehicle/vehicle.ts';
import {
  type Deal,
  type DealFinancials,
  type SettlementMethod,
  type TradeIn,
  acceptTradeIn,
  cancelDeal,
  computeFinancials,
  confirmDeal,
  markDelivered,
  openDeal,
  registerAtpv,
  registerSettlement,
  rejectTradeIn,
} from '../domain/deal/deal.ts';
import { supersedeByRecallSale } from '../domain/recall/recall.ts';
import { type Actor, type AppContext, publish } from './context.ts';
import { dealNotFound, noActiveLock } from './errors.ts';
import { loadVehicle } from './inventory-service.ts';

export type OpenDealInput = {
  readonly vehicleId: VehicleId;
  readonly retailPriceToConsumer: Money;
  readonly tradeIn?: TradeIn | null;
};

/**
 * Monta a negociacao a partir da trava ativa.
 *
 * O preco liquido vem do SNAPSHOT da trava, nao do cadastro atual do veiculo:
 * a Loja B fecha pelo numero que travou, mesmo que a Loja A tenha reprecificado
 * no meio do atendimento.
 */
export async function startDeal(
  context: AppContext,
  actor: Actor,
  input: OpenDealInput,
): Promise<Result<{ deal: Deal; financials: DealFinancials }, DomainError>> {
  const loaded = await loadVehicle(context, input.vehicleId);
  if (!loaded.ok) return loaded;

  const lock = loaded.value.lock;
  if (lock === null) return err(noActiveLock(input.vehicleId));
  if (lock.holderStoreId !== actor.store.id) {
    return err(
      forbiddenError(
        'NOT_LOCK_HOLDER',
        'Somente a loja que detem a trava pode montar a negociacao deste veiculo.',
        { vehicleId: input.vehicleId, holderStoreId: lock.holderStoreId },
      ),
    );
  }

  const transition = openDeal({
    dealId: asDealId(context.ids.next('dea')),
    vehicleId: loaded.value.vehicle.id,
    lockId: lock.id,
    ownerStoreId: loaded.value.vehicle.ownerStoreId,
    sellingStoreId: actor.store.id,
    createdByUserId: actor.user.id,
    netPriceSnapshot: lock.netPriceSnapshot,
    retailPriceToConsumer: input.retailPriceToConsumer,
    tradeIn: input.tradeIn ?? null,
    now: context.clock.now(),
  });
  if (!transition.ok) return transition;

  await context.repos.deals.save(transition.value.state);
  await publish(context, transition.value.events, actor);
  return ok({ deal: transition.value.state, financials: computeFinancials(transition.value.state) });
}

export async function acceptDealTradeIn(
  context: AppContext,
  actor: Actor,
  dealId: DealId,
  acceptedValue: Money,
): Promise<Result<{ deal: Deal; financials: DealFinancials }, DomainError>> {
  if (!hasManagerPowers(actor.user)) {
    return err(
      forbiddenError('MANAGER_ROLE_REQUIRED', 'Somente gerente ou titular aceita receber o veiculo de troca.'),
    );
  }

  const deal = await context.repos.deals.byId(dealId);
  if (deal === undefined) return err(dealNotFound(dealId));

  const transition = acceptTradeIn({
    deal,
    actorStoreId: actor.store.id,
    actorUserId: actor.user.id,
    acceptedValue,
    now: context.clock.now(),
  });
  if (!transition.ok) return transition;

  await context.repos.deals.save(transition.value.state);
  await publish(context, transition.value.events, actor);
  return ok({ deal: transition.value.state, financials: computeFinancials(transition.value.state) });
}

export async function rejectDealTradeIn(
  context: AppContext,
  actor: Actor,
  dealId: DealId,
  reason: string,
): Promise<Result<{ deal: Deal; financials: DealFinancials }, DomainError>> {
  const deal = await context.repos.deals.byId(dealId);
  if (deal === undefined) return err(dealNotFound(dealId));

  const transition = rejectTradeIn({
    deal,
    actorStoreId: actor.store.id,
    reason,
    now: context.clock.now(),
  });
  if (!transition.ok) return transition;

  await context.repos.deals.save(transition.value.state);
  await publish(context, transition.value.events, actor);
  return ok({ deal: transition.value.state, financials: computeFinancials(transition.value.state) });
}

/**
 * Fecha a venda. Aqui a trava vira venda, o veiculo sai do estoque da rede e um
 * recall aberto e cancelado — tudo na mesma operacao.
 */
export async function confirmDealSale(
  context: AppContext,
  actor: Actor,
  dealId: DealId,
): Promise<Result<{ deal: Deal; financials: DealFinancials }, DomainError>> {
  const deal = await context.repos.deals.byId(dealId);
  if (deal === undefined) return err(dealNotFound(dealId));

  const loaded = await loadVehicle(context, deal.vehicleId);
  if (!loaded.ok) return loaded;

  const at = context.clock.now();
  const lock = loaded.value.lock;
  if (lock === null || lock.id !== deal.lockId || !isActive(lock, at)) {
    // A trava caiu enquanto a negociacao era montada: o carro voltou a rede e
    // pode ter sido travado por outra loja. Fechar assim mesmo criaria a venda
    // duplicada que a plataforma existe para impedir.
    return err(
      conflictError(
        'LOCK_NO_LONGER_ACTIVE',
        'A trava desta negociacao nao esta mais ativa. Abra uma nova trava antes de fechar a venda.',
        { dealId: deal.id, lockId: deal.lockId },
      ),
    );
  }

  const dealTransition = confirmDeal({ deal, actorStoreId: actor.store.id, now: at });
  if (!dealTransition.ok) return dealTransition;

  const lockTransition = convertLockToDeal({
    vehicle: loaded.value.vehicle,
    lock,
    dealId: deal.id,
    now: at,
  });
  if (!lockTransition.ok) return lockTransition;

  await context.repos.deals.save(dealTransition.value.state);
  await context.repos.vehicles.save(lockTransition.value.state.vehicle);
  await context.repos.locks.save(lockTransition.value.state.lock);
  await publish(context, [...dealTransition.value.events, ...lockTransition.value.events], actor);

  await supersedeOpenRecall(context, deal);

  return ok({
    deal: dealTransition.value.state,
    financials: computeFinancials(dealTransition.value.state),
  });
}

/**
 * A dona pediu o carro de volta e ele acabou vendido. O recall e cancelado,
 * nao "cumprido": ela nao recebeu o veiculo, recebeu o dinheiro. O evento
 * emitido e o gancho para avisa-la.
 */
async function supersedeOpenRecall(context: AppContext, deal: Deal): Promise<void> {
  const recall = await context.repos.recalls.openByVehicle(asVehicleId(deal.vehicleId));
  if (recall === undefined) return;

  const transition = supersedeByRecallSale(recall, deal.id, context.clock.now());
  if (!transition.ok || transition.value.events.length === 0) return;

  await context.repos.recalls.save(transition.value.state);
  await publish(context, transition.value.events);
}

export type SettlementInput = {
  readonly dealId: DealId;
  readonly amount: Money;
  readonly method: SettlementMethod;
  readonly reference: string;
  readonly paidAt?: Instant | undefined;
};

export async function settleDeal(
  context: AppContext,
  actor: Actor,
  input: SettlementInput,
): Promise<Result<{ deal: Deal; financials: DealFinancials }, DomainError>> {
  const deal = await context.repos.deals.byId(input.dealId);
  if (deal === undefined) return err(dealNotFound(input.dealId));

  const at = context.clock.now();
  const transition = registerSettlement({
    deal,
    settlementId: asSettlementId(context.ids.next('stl')),
    actorStoreId: actor.store.id,
    actorUserId: actor.user.id,
    amount: input.amount,
    method: input.method,
    reference: input.reference,
    paidAt: input.paidAt ?? at,
    now: at,
  });
  if (!transition.ok) return transition;

  await context.repos.deals.save(transition.value.state);
  await publish(context, transition.value.events, actor);
  return ok({ deal: transition.value.state, financials: computeFinancials(transition.value.state) });
}

export type AtpvInput = {
  readonly dealId: DealId;
  readonly atpvNumber: string;
  readonly buyerName: string;
  readonly buyerDocument: string;
};

export async function registerDealAtpv(
  context: AppContext,
  actor: Actor,
  input: AtpvInput,
): Promise<Result<Deal, DomainError>> {
  if (!hasManagerPowers(actor.user)) {
    return err(forbiddenError('MANAGER_ROLE_REQUIRED', 'Somente gerente ou titular registra o ATPV-e.'));
  }

  const deal = await context.repos.deals.byId(input.dealId);
  if (deal === undefined) return err(dealNotFound(input.dealId));

  const transition = registerAtpv({
    deal,
    actorStoreId: actor.store.id,
    atpvNumber: input.atpvNumber,
    buyerName: input.buyerName,
    buyerDocument: input.buyerDocument,
    now: context.clock.now(),
  });
  if (!transition.ok) return transition;

  await context.repos.deals.save(transition.value.state);
  await publish(context, transition.value.events, actor);
  return ok(transition.value.state);
}

export async function markDealDelivered(
  context: AppContext,
  actor: Actor,
  dealId: DealId,
): Promise<Result<Deal, DomainError>> {
  const deal = await context.repos.deals.byId(dealId);
  if (deal === undefined) return err(dealNotFound(dealId));

  const transition = markDelivered({ deal, actorStoreId: actor.store.id, now: context.clock.now() });
  if (!transition.ok) return transition;

  await context.repos.deals.save(transition.value.state);
  await publish(context, transition.value.events, actor);
  return ok(transition.value.state);
}

export async function abandonDeal(
  context: AppContext,
  actor: Actor,
  dealId: DealId,
  reason: string,
): Promise<Result<Deal, DomainError>> {
  const deal = await context.repos.deals.byId(dealId);
  if (deal === undefined) return err(dealNotFound(dealId));

  const transition = cancelDeal({
    deal,
    actorStoreId: actor.store.id,
    reason,
    now: context.clock.now(),
  });
  if (!transition.ok) return transition;

  await context.repos.deals.save(transition.value.state);
  await publish(context, transition.value.events, actor);

  // A venda caiu depois de confirmada: o carro volta ao estoque da rede, e a
  // custodia fisica segue exatamente onde estava.
  if (deal.confirmedAt !== null) await returnVehicleToNetwork(context, deal);

  return ok(transition.value.state);
}

async function returnVehicleToNetwork(context: AppContext, deal: Deal): Promise<void> {
  const vehicle = await context.repos.vehicles.byId(deal.vehicleId);
  if (vehicle === undefined || vehicle.commercialStatus !== CommercialStatus.SOLD) return;

  const at = context.clock.now();

  // Se o laudo venceu enquanto a venda estava em curso, o carro nao volta ao
  // catalogo — a mesma regra que vale quando uma trava cai.
  const backToNetwork = isInspectionValid(vehicle.inspection, at);
  await context.repos.vehicles.save({
    ...vehicle,
    commercialStatus: backToNetwork ? CommercialStatus.AVAILABLE : CommercialStatus.DRAFT,
    activeLockId: null,
    updatedAt: at,
  });

  await publish(context, [
    domainEvent(
      backToNetwork ? 'vehicle.available_again' : 'vehicle.unlisted',
      vehicle.id,
      at,
      {
        reason: 'DEAL_CANCELLED',
        dealId: deal.id,
        custodianStoreId: vehicle.physical.custodianStoreId,
        onExtendedCustody: vehicle.physical.custodianStoreId !== vehicle.ownerStoreId,
      },
    ),
  ]);
}

export { computeFinancials };
