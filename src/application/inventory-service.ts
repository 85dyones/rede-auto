/**
 * Casos de uso de estoque e de trava comercial.
 *
 * Veiculo e trava sao persistidos juntos porque formam uma fronteira de
 * consistencia: nao pode existir veiculo LOCKED com a trava ja expirada.
 *
 * A expiracao da trava e materializada de duas formas, e as duas sao
 * necessarias:
 *   - preguicosa, em toda leitura do veiculo (`reconcile`), para que ninguem
 *     jamais veja um estado vencido, mesmo que o varredor esteja parado;
 *   - ativa, pelo varredor periodico, para que o evento "voltou a ficar
 *     disponivel" chegue a rede sem depender de alguem abrir a tela.
 * Ambas passam pela mesma funcao idempotente do dominio.
 */

import { type Result, err, ok } from '../domain/shared/result.ts';
import type { DomainError } from '../domain/shared/errors.ts';
import { conflictError, forbiddenError } from '../domain/shared/errors.ts';
import type { Instant } from '../domain/shared/clock.ts';
import {
  asLockId,
  asVehicleId,
  type LockId,
  type StoreId,
  type VehicleId,
} from '../domain/shared/ids.ts';
import type { Money } from '../domain/shared/money.ts';
import { hasManagerPowers } from '../domain/network/store.ts';
import {
  type InspectionReport,
  type TradeInStance,
  type Vehicle,
  type VehicleSpecs,
  CommercialStatus,
  createVehicle,
  registerInspection,
  relistVehicle,
  updatePricing,
  updateTradeInPolicy,
  withdrawVehicle,
} from '../domain/vehicle/vehicle.ts';
import {
  type CommercialLock,
  expireLockIfDue,
  extendLock,
  isActive,
  openLock,
  releaseLock,
  remainingMs,
} from '../domain/lock/commercial-lock.ts';
import type { Evidence } from '../domain/lock/evidence.ts';
import { type ActiveLockView, resolvePriority, startSlaAfterLockRelease } from '../domain/recall/recall.ts';
import type { VehicleQuery } from '../infra/persistence/repositories.ts';
import { type Actor, type AppContext, publish } from './context.ts';
import { noActiveLock, vehicleNotFound } from './errors.ts';

export type LoadedVehicle = {
  readonly vehicle: Vehicle;
  /** Trava ainda vigente, ja considerada a expiracao por decurso de prazo. */
  readonly lock: CommercialLock | null;
};

/**
 * Carrega o veiculo com a trava ja reconciliada.
 *
 * Toda leitura passa por aqui. Se a trava venceu desde a ultima escrita, a
 * expiracao e persistida e anunciada agora — antes de qualquer decisao ser
 * tomada sobre um estado que ja nao vale.
 */
/**
 * Carrega um veiculo **da praca do ator**. E o unico caminho para chegar a um
 * veiculo a partir de um id, e e por isso que a fronteira de cluster vive aqui:
 * uma guarda em vinte servicos se esquece; uma guarda no carregador, nao.
 *
 * Veiculo de outra praca responde 404, nao 403 — mesmo raciocinio da
 * negociacao de terceiro. Para quem esta fora da praca esse carro nao existe, e
 * distinguir "nao existe" de "existe mas nao e seu" ja entrega que existe.
 */
export async function loadVehicle(
  context: AppContext,
  actor: Actor,
  vehicleId: VehicleId,
): Promise<Result<LoadedVehicle, DomainError>> {
  const vehicle = await context.repos.vehicles.byId(vehicleId);
  if (vehicle === undefined) return err(vehicleNotFound(vehicleId));
  if (vehicle.clusterId !== actor.store.clusterId) return err(vehicleNotFound(vehicleId));
  return ok(await reconcile(context, vehicle));
}

export async function reconcile(context: AppContext, vehicle: Vehicle): Promise<LoadedVehicle> {
  const lock = await context.repos.locks.activeByVehicle(vehicle.id);
  if (lock === undefined) return { vehicle, lock: null };

  const at = context.clock.now();
  const transition = expireLockIfDue(vehicle, lock, at);
  if (!transition.ok) return { vehicle, lock };

  const { state, events } = transition.value;
  if (events.length === 0) return { vehicle: state.vehicle, lock: state.lock };

  await context.repos.vehicles.save(state.vehicle);
  await context.repos.locks.save(state.lock);
  await publish(context, events);
  await onLockEnded(context, state.vehicle);

  return { vehicle: state.vehicle, lock: null };
}

/**
 * Reacoes ao fim de uma trava, em qualquer das formas (expirou, foi liberada).
 *
 * Hoje ha uma: um recall represado passa a ter prazo. O SLA comeca AGORA e nao
 * retroage ao pedido — a loja custodiante estava legitimamente segurando o
 * carro enquanto a trava valia.
 */
async function onLockEnded(context: AppContext, vehicle: Vehicle): Promise<void> {
  const recall = await context.repos.recalls.openByVehicle(vehicle.id);
  if (recall === undefined) return;

  const transition = startSlaAfterLockRelease(recall, context.clock.now(), context.policies.recall);
  if (!transition.ok || transition.value.events.length === 0) return;

  await context.repos.recalls.save(transition.value.state);
  await publish(context, transition.value.events);
}

// ---------------------------------------------------------------------------
// Cadastro e precificacao
// ---------------------------------------------------------------------------

export type RegisterVehicleInput = {
  readonly plate: string;
  readonly chassis: string;
  readonly specs: VehicleSpecs;
  readonly inspection?: InspectionReport | undefined;
  readonly publicPrice: Money;
  readonly netPrice: Money;
  /** Obrigatoria no cadastro manual; o padrao da loja so preenche o formulario. */
  readonly tradeInStance: TradeInStance;
  readonly tradeInNote?: string | null;
};

export async function registerVehicle(
  context: AppContext,
  actor: Actor,
  input: RegisterVehicleInput,
): Promise<Result<Vehicle, DomainError>> {
  if (!hasManagerPowers(actor.user)) return err(managerRequired('cadastrar veiculo'));

  const created = createVehicle({
    id: asVehicleId(context.ids.next('veh')),
    clusterId: actor.store.clusterId,
    ownerStoreId: actor.store.id,
    plate: input.plate,
    chassis: input.chassis,
    specs: input.specs,
    ...(input.inspection === undefined ? {} : { inspection: input.inspection }),
    publicPrice: input.publicPrice,
    netPrice: input.netPrice,
    tradeInStance: input.tradeInStance,
    ...(input.tradeInNote === undefined ? {} : { tradeInNote: input.tradeInNote }),
    now: context.clock.now(),
  });
  if (!created.ok) return created;

  // O chassi e a chave de deduplicacao da rede: e o que impede duas lojas de
  // ofertarem o mesmo carro.
  const duplicate = await context.repos.vehicles.byChassis(created.value.chassis);
  if (duplicate !== undefined && duplicate.commercialStatus !== CommercialStatus.SOLD) {
    return err(
      conflictError(
        'DUPLICATE_VIN_IN_NETWORK',
        duplicate.ownerStoreId === actor.store.id
          ? 'Este chassi ja esta cadastrado no seu estoque.'
          : 'Este chassi ja esta anunciado por outra loja da rede.',
        { chassis: created.value.chassis, vehicleId: duplicate.id },
      ),
    );
  }

  await context.repos.vehicles.save(created.value);
  return ok(created.value);
}

export type UpdatePricingInput = {
  readonly vehicleId: VehicleId;
  readonly publicPrice?: Money | undefined;
  readonly netPrice?: Money | undefined;
};

export async function updateVehiclePricing(
  context: AppContext,
  actor: Actor,
  input: UpdatePricingInput,
): Promise<Result<Vehicle, DomainError>> {
  if (!hasManagerPowers(actor.user)) return err(managerRequired('alterar preco'));

  const loaded = await loadVehicle(context, actor, input.vehicleId);
  if (!loaded.ok) return loaded;

  const transition = updatePricing({
    vehicle: loaded.value.vehicle,
    actorStoreId: actor.store.id,
    publicPrice: input.publicPrice,
    netPrice: input.netPrice,
    now: context.clock.now(),
  });
  if (!transition.ok) return transition;

  await context.repos.vehicles.save(transition.value.state);
  await publish(context, transition.value.events, actor);
  return ok(transition.value.state);
}

export async function recordInspection(
  context: AppContext,
  actor: Actor,
  vehicleId: VehicleId,
  report: InspectionReport,
): Promise<Result<Vehicle, DomainError>> {
  if (!hasManagerPowers(actor.user)) return err(managerRequired('registrar laudo'));

  const loaded = await loadVehicle(context, actor, vehicleId);
  if (!loaded.ok) return loaded;

  const transition = registerInspection({
    vehicle: loaded.value.vehicle,
    actorStoreId: actor.store.id,
    report,
    now: context.clock.now(),
  });
  if (!transition.ok) return transition;

  await context.repos.vehicles.save(transition.value.state);
  await publish(context, transition.value.events, actor);
  return ok(transition.value.state);
}

export async function withdrawFromNetwork(
  context: AppContext,
  actor: Actor,
  vehicleId: VehicleId,
  reason: string,
): Promise<Result<Vehicle, DomainError>> {
  if (!hasManagerPowers(actor.user)) return err(managerRequired('retirar veiculo da rede'));

  const loaded = await loadVehicle(context, actor, vehicleId);
  if (!loaded.ok) return loaded;

  const transition = withdrawVehicle({
    vehicle: loaded.value.vehicle,
    actorStoreId: actor.store.id,
    reason,
    now: context.clock.now(),
  });
  if (!transition.ok) return transition;

  await context.repos.vehicles.save(transition.value.state);
  await publish(context, transition.value.events, actor);
  return ok(transition.value.state);
}

export async function relistInNetwork(
  context: AppContext,
  actor: Actor,
  vehicleId: VehicleId,
): Promise<Result<Vehicle, DomainError>> {
  if (!hasManagerPowers(actor.user)) return err(managerRequired('reativar anuncio'));

  const loaded = await loadVehicle(context, actor, vehicleId);
  if (!loaded.ok) return loaded;

  const transition = relistVehicle({
    vehicle: loaded.value.vehicle,
    actorStoreId: actor.store.id,
    now: context.clock.now(),
  });
  if (!transition.ok) return transition;

  await context.repos.vehicles.save(transition.value.state);
  await publish(context, transition.value.events, actor);
  return ok(transition.value.state);
}

// ---------------------------------------------------------------------------
// Trava comercial
// ---------------------------------------------------------------------------

export type OpenLockInput = {
  readonly vehicleId: VehicleId;
  readonly customerReference?: string | undefined;
};

export async function openCommercialLock(
  context: AppContext,
  actor: Actor,
  input: OpenLockInput,
): Promise<Result<LoadedVehicle, DomainError>> {
  const loaded = await loadVehicle(context, actor, input.vehicleId);
  if (!loaded.ok) return loaded;

  const transition = openLock({
    lockId: asLockId(context.ids.next('lck')),
    vehicle: loaded.value.vehicle,
    holderStore: actor.store,
    holderUser: actor.user,
    customerReference: input.customerReference,
    now: context.clock.now(),
    policy: context.policies.lock,
  });
  if (!transition.ok) return transition;

  const { state, events } = transition.value;
  await context.repos.vehicles.save(state.vehicle);
  await context.repos.locks.save(state.lock);
  await publish(context, events, actor);
  return ok({ vehicle: state.vehicle, lock: state.lock });
}

export async function extendCommercialLock(
  context: AppContext,
  actor: Actor,
  lockId: LockId,
  evidence: Evidence,
): Promise<Result<LoadedVehicle, DomainError>> {
  const lock = await context.repos.locks.byId(lockId);
  if (lock === undefined) return err(noActiveLock(lockId));

  const loaded = await loadVehicle(context, actor, asVehicleId(lock.vehicleId));
  if (!loaded.ok) return loaded;

  // Depois da reconciliacao a trava pode ter acabado de expirar.
  const current = loaded.value.lock ?? (await context.repos.locks.byId(lockId));
  if (current === undefined) return err(noActiveLock(lock.vehicleId));

  const transition = extendLock({
    vehicle: loaded.value.vehicle,
    lock: current,
    actorStoreId: actor.store.id,
    actorUserId: actor.user.id,
    evidence,
    now: context.clock.now(),
    policy: context.policies.lock,
  });
  if (!transition.ok) return transition;

  const { state, events } = transition.value;
  await context.repos.locks.save(state.lock);
  await publish(context, events, actor);
  return ok({ vehicle: state.vehicle, lock: state.lock });
}

export async function releaseCommercialLock(
  context: AppContext,
  actor: Actor,
  lockId: LockId,
  reason?: string,
): Promise<Result<LoadedVehicle, DomainError>> {
  const lock = await context.repos.locks.byId(lockId);
  if (lock === undefined) return err(noActiveLock(lockId));

  const loaded = await loadVehicle(context, actor, asVehicleId(lock.vehicleId));
  if (!loaded.ok) return loaded;

  const current = loaded.value.lock ?? (await context.repos.locks.byId(lockId));
  if (current === undefined) return err(noActiveLock(lock.vehicleId));

  const transition = releaseLock({
    vehicle: loaded.value.vehicle,
    lock: current,
    actorStoreId: actor.store.id,
    reason,
    now: context.clock.now(),
  });
  if (!transition.ok) return transition;

  const { state, events } = transition.value;
  await context.repos.vehicles.save(state.vehicle);
  await context.repos.locks.save(state.lock);
  await publish(context, events, actor);
  await onLockEnded(context, state.vehicle);

  return ok({ vehicle: state.vehicle, lock: null });
}

/**
 * Varredor: materializa as travas vencidas e anuncia a liberacao a rede.
 *
 * Sem ele a expiracao so aconteceria quando alguem abrisse a tela do veiculo —
 * e o valor da regra esta justamente em avisar a rede de que o carro voltou a
 * estar disponivel, sem ninguem precisar ficar olhando.
 */
export async function sweepExpiredLocks(context: AppContext): Promise<number> {
  const at = context.clock.now();
  const due = await context.repos.locks.dueForExpiry(at);
  let expired = 0;

  for (const lock of due) {
    const vehicle = await context.repos.vehicles.byId(asVehicleId(lock.vehicleId));
    if (vehicle === undefined) continue;

    const transition = expireLockIfDue(vehicle, lock, at);
    if (!transition.ok || transition.value.events.length === 0) continue;

    const { state, events } = transition.value;
    await context.repos.vehicles.save(state.vehicle);
    await context.repos.locks.save(state.lock);
    await publish(context, events);
    await onLockEnded(context, state.vehicle);
    expired += 1;
  }

  return expired;
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

export type VehicleView = {
  readonly vehicle: Vehicle;
  readonly lock: {
    readonly id: LockId;
    readonly holderStoreId: StoreId;
    readonly expiresAt: Instant;
    readonly remainingMs: number;
    readonly extensions: number;
  } | null;
  /** Estoque avancado: o carro esta no patio de uma loja que nao e a dona. */
  readonly onExtendedCustody: boolean;
  readonly priority: ReturnType<typeof resolvePriority>;
  /** O que ESTA loja pode fazer com este veiculo agora. */
  readonly viewerCan: {
    readonly lock: boolean;
    readonly requestRecall: boolean;
    readonly setPrice: boolean;
  };
};

export function buildVehicleView(
  loaded: LoadedVehicle,
  viewerStoreId: StoreId,
  at: Instant,
): VehicleView {
  const { vehicle, lock } = loaded;
  const activeLockView: ActiveLockView | null =
    lock !== null && isActive(lock, at)
      ? { lockId: lock.id, holderStoreId: lock.holderStoreId, expiresAt: lock.expiresAt }
      : null;

  const priority = resolvePriority(vehicle, activeLockView, at);
  const isOwner = vehicle.ownerStoreId === viewerStoreId;
  const custodianIsOwner = vehicle.physical.custodianStoreId === vehicle.ownerStoreId;

  return {
    vehicle,
    lock:
      activeLockView === null || lock === null
        ? null
        : {
            id: lock.id,
            holderStoreId: lock.holderStoreId,
            expiresAt: lock.expiresAt,
            remainingMs: remainingMs(lock, at),
            extensions: lock.extensions.length,
          },
    onExtendedCustody: !custodianIsOwner,
    priority,
    viewerCan: {
      lock: activeLockView === null && vehicle.commercialStatus === CommercialStatus.AVAILABLE,
      requestRecall: isOwner && !custodianIsOwner && vehicle.commercialStatus !== CommercialStatus.SOLD,
      setPrice: isOwner && vehicle.commercialStatus !== CommercialStatus.SOLD,
    },
  };
}

/**
 * Busca sem a praca: quem chama diz o que quer ver, nunca *de onde*.
 *
 * O cluster nao e parametro de entrada em lugar nenhum da API — vem do ator, e
 * so dele. Se fosse aceito no query string, bastaria trocar um id para ler o
 * preco liquido de um concorrente de outra cidade. Omitir do tipo e o que torna
 * isso impossivel de escrever, nao apenas proibido.
 */
export type CatalogQuery = Omit<VehicleQuery, 'clusterId'>;

/**
 * A dona muda a postura de troca. Vale na hora, inclusive com trava ativa —
 * ver `updateTradeInPolicy` para por que isso difere do preco liquido.
 */
export async function setTradeInPolicy(
  context: AppContext,
  actor: Actor,
  vehicleId: VehicleId,
  stance: TradeInStance,
  note?: string | null,
): Promise<Result<Vehicle, DomainError>> {
  if (!hasManagerPowers(actor.user)) return err(managerRequired('definir a postura de troca'));

  const loaded = await loadVehicle(context, actor, vehicleId);
  if (!loaded.ok) return loaded;

  const transition = updateTradeInPolicy({
    vehicle: loaded.value.vehicle,
    actorStoreId: actor.store.id,
    stance,
    ...(note === undefined ? {} : { note }),
    now: context.clock.now(),
  });
  if (!transition.ok) return transition;

  await context.repos.vehicles.save(transition.value.state);
  await publish(context, transition.value.events, actor);
  return ok(transition.value.state);
}

export async function searchCatalog(
  context: AppContext,
  actor: Actor,
  query: CatalogQuery,
): Promise<{ items: LoadedVehicle[]; total: number }> {
  const page = await context.repos.vehicles.search({
    ...query,
    clusterId: actor.store.clusterId,
  });
  const items: LoadedVehicle[] = [];
  for (const vehicle of page.items) items.push(await reconcile(context, vehicle));
  return { items, total: page.total };
}

function managerRequired(action: string): DomainError {
  return forbiddenError(
    'MANAGER_ROLE_REQUIRED',
    `Somente gerente ou titular pode ${action}.`,
    { requiredRole: 'MANAGER' },
  );
}
