/**
 * Portas de persistencia e o adaptador em memoria.
 *
 * As interfaces sao assincronas de proposito, apesar do adaptador atual ser
 * sincrono: trocar por Postgres nao deve exigir mexer em nenhum servico de
 * aplicacao. O que ficaria diferente num adaptador real esta anotado onde
 * importa — principalmente a transacao que envolve veiculo + trava, que aqui e
 * garantida pelo fato de o processo ser single-threaded.
 */

import type {
  ApplicationId,
  CustodyTransferId,
  DealId,
  LockId,
  RecallId,
  ShareLinkId,
  StoreId,
  UserId,
  VehicleId,
} from '../../domain/shared/ids.ts';
import type { Instant } from '../../domain/shared/clock.ts';
import type { DomainEvent } from '../../domain/shared/events.ts';
import type { NetworkUser, Store } from '../../domain/network/store.ts';
import type { MembershipApplication } from '../../domain/network/membership.ts';
import type { Vehicle } from '../../domain/vehicle/vehicle.ts';
import { CommercialStatus } from '../../domain/vehicle/vehicle.ts';
import type { CommercialLock } from '../../domain/lock/commercial-lock.ts';
import { LockStatus } from '../../domain/lock/commercial-lock.ts';
import type { CustodyTransfer } from '../../domain/custody/custody.ts';
import type { Recall } from '../../domain/recall/recall.ts';
import { isOpen as isRecallOpen } from '../../domain/recall/recall.ts';
import type { Deal } from '../../domain/deal/deal.ts';
import type { ShareLink } from '../../domain/sharing/share-link.ts';
import type { Notification } from '../../application/notifications.ts';

export type StoreRepository = {
  save(store: Store): Promise<void>;
  byId(id: StoreId): Promise<Store | undefined>;
  byCnpj(cnpj: string): Promise<Store | undefined>;
  all(): Promise<Store[]>;
  founders(): Promise<Store[]>;
};

export type UserRepository = {
  save(user: NetworkUser): Promise<void>;
  byId(id: UserId): Promise<NetworkUser | undefined>;
  byStore(storeId: StoreId): Promise<NetworkUser[]>;
};

export type MembershipRepository = {
  save(application: MembershipApplication): Promise<void>;
  byId(id: ApplicationId): Promise<MembershipApplication | undefined>;
  pending(): Promise<MembershipApplication[]>;
};

export type VehicleQuery = {
  readonly commercialStatus?: readonly CommercialStatus[];
  readonly ownerStoreId?: StoreId;
  readonly custodianStoreId?: StoreId;
  readonly brand?: string;
  readonly model?: string;
  readonly maxNetPriceCents?: number;
  readonly minModelYear?: number;
  readonly maxMileageKm?: number;
  readonly limit?: number;
  readonly offset?: number;
};

export type VehicleRepository = {
  save(vehicle: Vehicle): Promise<void>;
  saveMany(vehicles: readonly Vehicle[]): Promise<void>;
  byId(id: VehicleId): Promise<Vehicle | undefined>;
  byChassis(chassis: string): Promise<Vehicle | undefined>;
  byOwner(storeId: StoreId): Promise<Vehicle[]>;
  search(query: VehicleQuery): Promise<{ items: Vehicle[]; total: number }>;
  /** Chassi -> loja dona, para detectar duplicidade entre lojas na ingestao. */
  chassisOwners(): Promise<Map<string, StoreId>>;
};

export type LockRepository = {
  save(lock: CommercialLock): Promise<void>;
  byId(id: LockId): Promise<CommercialLock | undefined>;
  activeByVehicle(vehicleId: VehicleId): Promise<CommercialLock | undefined>;
  /** Travas ainda marcadas ACTIVE cujo prazo ja passou. Alimenta o varredor. */
  dueForExpiry(now: Instant): Promise<CommercialLock[]>;
  historyByVehicle(vehicleId: VehicleId): Promise<CommercialLock[]>;
};

export type CustodyTransferRepository = {
  save(transfer: CustodyTransfer): Promise<void>;
  byId(id: CustodyTransferId): Promise<CustodyTransfer | undefined>;
  byVehicle(vehicleId: VehicleId): Promise<CustodyTransfer[]>;
  openByVehicle(vehicleId: VehicleId): Promise<CustodyTransfer | undefined>;
};

export type RecallRepository = {
  save(recall: Recall): Promise<void>;
  byId(id: RecallId): Promise<Recall | undefined>;
  openByVehicle(vehicleId: VehicleId): Promise<Recall | undefined>;
  byVehicle(vehicleId: VehicleId): Promise<Recall[]>;
  openForStore(storeId: StoreId): Promise<Recall[]>;
  allOpen(): Promise<Recall[]>;
};

export type DealRepository = {
  save(deal: Deal): Promise<void>;
  byId(id: DealId): Promise<Deal | undefined>;
  byVehicle(vehicleId: VehicleId): Promise<Deal[]>;
  byStore(storeId: StoreId): Promise<Deal[]>;
};

export type ShareLinkRepository = {
  save(link: ShareLink): Promise<void>;
  byId(id: ShareLinkId): Promise<ShareLink | undefined>;
  byToken(token: string): Promise<ShareLink | undefined>;
  byVehicle(vehicleId: VehicleId): Promise<ShareLink[]>;
};

export type AuditEntry = {
  readonly id: string;
  readonly event: DomainEvent;
  readonly actorStoreId: StoreId | null;
  readonly actorUserId: UserId | null;
  readonly recordedAt: Instant;
};

export type AuditRepository = {
  append(entry: AuditEntry): Promise<void>;
  byAggregate(aggregateId: string, limit?: number): Promise<AuditEntry[]>;
  recent(limit?: number): Promise<AuditEntry[]>;
};

export type NotificationQuery = {
  readonly storeId: StoreId;
  readonly unreadOnly?: boolean;
  readonly limit?: number;
};

export type NotificationRepository = {
  append(notification: Notification): Promise<void>;
  forStore(query: NotificationQuery): Promise<Notification[]>;
  markRead(id: string, storeId: StoreId, at: Instant): Promise<Notification | undefined>;
  unreadCount(storeId: StoreId): Promise<number>;
};

export type Repositories = {
  readonly stores: StoreRepository;
  readonly users: UserRepository;
  readonly memberships: MembershipRepository;
  readonly vehicles: VehicleRepository;
  readonly locks: LockRepository;
  readonly transfers: CustodyTransferRepository;
  readonly recalls: RecallRepository;
  readonly deals: DealRepository;
  readonly shareLinks: ShareLinkRepository;
  readonly audit: AuditRepository;
  readonly notifications: NotificationRepository;
};

// ---------------------------------------------------------------------------
// Adaptador em memoria
// ---------------------------------------------------------------------------

function clone<T>(value: T): T {
  return structuredClone(value);
}

class InMemoryStoreRepository implements StoreRepository {
  readonly #byId = new Map<string, Store>();

  async save(store: Store): Promise<void> {
    this.#byId.set(store.id, clone(store));
  }
  async byId(id: StoreId): Promise<Store | undefined> {
    const found = this.#byId.get(id);
    return found === undefined ? undefined : clone(found);
  }
  async byCnpj(cnpj: string): Promise<Store | undefined> {
    for (const store of this.#byId.values()) {
      if (store.profile.cnpj === cnpj) return clone(store);
    }
    return undefined;
  }
  async all(): Promise<Store[]> {
    return [...this.#byId.values()].map(clone);
  }
  async founders(): Promise<Store[]> {
    return [...this.#byId.values()].filter((store) => store.kind === 'FOUNDER').map(clone);
  }
}

class InMemoryUserRepository implements UserRepository {
  readonly #byId = new Map<string, NetworkUser>();

  async save(user: NetworkUser): Promise<void> {
    this.#byId.set(user.id, clone(user));
  }
  async byId(id: UserId): Promise<NetworkUser | undefined> {
    const found = this.#byId.get(id);
    return found === undefined ? undefined : clone(found);
  }
  async byStore(storeId: StoreId): Promise<NetworkUser[]> {
    return [...this.#byId.values()].filter((user) => user.storeId === storeId).map(clone);
  }
}

class InMemoryMembershipRepository implements MembershipRepository {
  readonly #byId = new Map<string, MembershipApplication>();

  async save(application: MembershipApplication): Promise<void> {
    this.#byId.set(application.id, clone(application));
  }
  async byId(id: ApplicationId): Promise<MembershipApplication | undefined> {
    const found = this.#byId.get(id);
    return found === undefined ? undefined : clone(found);
  }
  async pending(): Promise<MembershipApplication[]> {
    return [...this.#byId.values()].filter((app) => app.status === 'PENDING').map(clone);
  }
}

class InMemoryVehicleRepository implements VehicleRepository {
  readonly #byId = new Map<string, Vehicle>();

  async save(vehicle: Vehicle): Promise<void> {
    this.#byId.set(vehicle.id, clone(vehicle));
  }
  async saveMany(vehicles: readonly Vehicle[]): Promise<void> {
    for (const vehicle of vehicles) this.#byId.set(vehicle.id, clone(vehicle));
  }
  async byId(id: VehicleId): Promise<Vehicle | undefined> {
    const found = this.#byId.get(id);
    return found === undefined ? undefined : clone(found);
  }
  async byChassis(chassis: string): Promise<Vehicle | undefined> {
    for (const vehicle of this.#byId.values()) {
      if (vehicle.chassis === chassis) return clone(vehicle);
    }
    return undefined;
  }
  async byOwner(storeId: StoreId): Promise<Vehicle[]> {
    return [...this.#byId.values()].filter((vehicle) => vehicle.ownerStoreId === storeId).map(clone);
  }

  async search(query: VehicleQuery): Promise<{ items: Vehicle[]; total: number }> {
    const fold = (value: string): string =>
      value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

    const matches = [...this.#byId.values()].filter((vehicle) => {
      if (query.commercialStatus !== undefined && !query.commercialStatus.includes(vehicle.commercialStatus)) {
        return false;
      }
      if (query.ownerStoreId !== undefined && vehicle.ownerStoreId !== query.ownerStoreId) return false;
      if (
        query.custodianStoreId !== undefined &&
        vehicle.physical.custodianStoreId !== query.custodianStoreId
      ) {
        return false;
      }
      if (query.brand !== undefined && !fold(vehicle.specs.brand).includes(fold(query.brand))) return false;
      if (query.model !== undefined && !fold(vehicle.specs.model).includes(fold(query.model))) return false;
      if (query.maxNetPriceCents !== undefined && vehicle.pricing.netPrice.cents > query.maxNetPriceCents) {
        return false;
      }
      if (query.minModelYear !== undefined && vehicle.specs.modelYear < query.minModelYear) return false;
      if (query.maxMileageKm !== undefined && vehicle.specs.mileageKm > query.maxMileageKm) return false;
      return true;
    });

    matches.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    return { items: matches.slice(offset, offset + limit).map(clone), total: matches.length };
  }

  async chassisOwners(): Promise<Map<string, StoreId>> {
    const index = new Map<string, StoreId>();
    for (const vehicle of this.#byId.values()) {
      if (vehicle.commercialStatus === CommercialStatus.SOLD) continue;
      index.set(vehicle.chassis, vehicle.ownerStoreId);
    }
    return index;
  }
}

class InMemoryLockRepository implements LockRepository {
  readonly #byId = new Map<string, CommercialLock>();

  async save(lock: CommercialLock): Promise<void> {
    this.#byId.set(lock.id, clone(lock));
  }
  async byId(id: LockId): Promise<CommercialLock | undefined> {
    const found = this.#byId.get(id);
    return found === undefined ? undefined : clone(found);
  }
  async activeByVehicle(vehicleId: VehicleId): Promise<CommercialLock | undefined> {
    for (const lock of this.#byId.values()) {
      if (lock.vehicleId === vehicleId && lock.status === LockStatus.ACTIVE) return clone(lock);
    }
    return undefined;
  }
  async dueForExpiry(now: Instant): Promise<CommercialLock[]> {
    return [...this.#byId.values()]
      .filter((lock) => lock.status === LockStatus.ACTIVE && lock.expiresAt <= now)
      .map(clone);
  }
  async historyByVehicle(vehicleId: VehicleId): Promise<CommercialLock[]> {
    return [...this.#byId.values()]
      .filter((lock) => lock.vehicleId === vehicleId)
      .sort((a, b) => a.openedAt - b.openedAt)
      .map(clone);
  }
}

class InMemoryCustodyTransferRepository implements CustodyTransferRepository {
  readonly #byId = new Map<string, CustodyTransfer>();

  async save(transfer: CustodyTransfer): Promise<void> {
    this.#byId.set(transfer.id, clone(transfer));
  }
  async byId(id: CustodyTransferId): Promise<CustodyTransfer | undefined> {
    const found = this.#byId.get(id);
    return found === undefined ? undefined : clone(found);
  }
  async byVehicle(vehicleId: VehicleId): Promise<CustodyTransfer[]> {
    return [...this.#byId.values()]
      .filter((transfer) => transfer.vehicleId === vehicleId)
      .sort((a, b) => a.openedAt - b.openedAt)
      .map(clone);
  }
  async openByVehicle(vehicleId: VehicleId): Promise<CustodyTransfer | undefined> {
    for (const transfer of this.#byId.values()) {
      if (transfer.vehicleId === vehicleId && transfer.status === 'OPEN') return clone(transfer);
    }
    return undefined;
  }
}

class InMemoryRecallRepository implements RecallRepository {
  readonly #byId = new Map<string, Recall>();

  async save(recall: Recall): Promise<void> {
    this.#byId.set(recall.id, clone(recall));
  }
  async byId(id: RecallId): Promise<Recall | undefined> {
    const found = this.#byId.get(id);
    return found === undefined ? undefined : clone(found);
  }
  async openByVehicle(vehicleId: VehicleId): Promise<Recall | undefined> {
    for (const recall of this.#byId.values()) {
      if (recall.vehicleId === vehicleId && isRecallOpen(recall)) return clone(recall);
    }
    return undefined;
  }
  async byVehicle(vehicleId: VehicleId): Promise<Recall[]> {
    return [...this.#byId.values()]
      .filter((recall) => recall.vehicleId === vehicleId)
      .sort((a, b) => a.requestedAt - b.requestedAt)
      .map(clone);
  }
  async openForStore(storeId: StoreId): Promise<Recall[]> {
    return [...this.#byId.values()]
      .filter(
        (recall) =>
          isRecallOpen(recall) &&
          (recall.custodianStoreId === storeId || recall.requestedByStoreId === storeId),
      )
      .map(clone);
  }
  async allOpen(): Promise<Recall[]> {
    return [...this.#byId.values()].filter(isRecallOpen).map(clone);
  }
}

class InMemoryDealRepository implements DealRepository {
  readonly #byId = new Map<string, Deal>();

  async save(deal: Deal): Promise<void> {
    this.#byId.set(deal.id, clone(deal));
  }
  async byId(id: DealId): Promise<Deal | undefined> {
    const found = this.#byId.get(id);
    return found === undefined ? undefined : clone(found);
  }
  async byVehicle(vehicleId: VehicleId): Promise<Deal[]> {
    return [...this.#byId.values()]
      .filter((deal) => deal.vehicleId === vehicleId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(clone);
  }
  async byStore(storeId: StoreId): Promise<Deal[]> {
    return [...this.#byId.values()]
      .filter((deal) => deal.ownerStoreId === storeId || deal.sellingStoreId === storeId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(clone);
  }
}

class InMemoryShareLinkRepository implements ShareLinkRepository {
  readonly #byId = new Map<string, ShareLink>();
  readonly #byToken = new Map<string, string>();

  async save(link: ShareLink): Promise<void> {
    this.#byId.set(link.id, clone(link));
    this.#byToken.set(link.token, link.id);
  }
  async byId(id: ShareLinkId): Promise<ShareLink | undefined> {
    const found = this.#byId.get(id);
    return found === undefined ? undefined : clone(found);
  }
  async byToken(token: string): Promise<ShareLink | undefined> {
    const id = this.#byToken.get(token);
    return id === undefined ? undefined : this.byId(id as ShareLinkId);
  }
  async byVehicle(vehicleId: VehicleId): Promise<ShareLink[]> {
    return [...this.#byId.values()]
      .filter((link) => link.vehicleId === vehicleId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(clone);
  }
}

class InMemoryAuditRepository implements AuditRepository {
  readonly #entries: AuditEntry[] = [];
  /** Teto de retencao em memoria; um adaptador real escreveria em disco. */
  readonly #maxEntries = 100_000;

  async append(entry: AuditEntry): Promise<void> {
    this.#entries.push(clone(entry));
    if (this.#entries.length > this.#maxEntries) this.#entries.shift();
  }
  async byAggregate(aggregateId: string, limit = 200): Promise<AuditEntry[]> {
    return this.#entries
      .filter((entry) => entry.event.aggregateId === aggregateId)
      .slice(-limit)
      .reverse()
      .map(clone);
  }
  async recent(limit = 100): Promise<AuditEntry[]> {
    return this.#entries.slice(-limit).reverse().map(clone);
  }
}

class InMemoryNotificationRepository implements NotificationRepository {
  readonly #byStore = new Map<string, Notification[]>();
  /** Teto por loja: a caixa e um mural de operacao, nao um arquivo historico. */
  readonly #maxPerStore = 2_000;

  async append(notification: Notification): Promise<void> {
    const list = this.#byStore.get(notification.storeId) ?? [];
    list.push(clone(notification));
    if (list.length > this.#maxPerStore) list.shift();
    this.#byStore.set(notification.storeId, list);
  }

  async forStore(query: NotificationQuery): Promise<Notification[]> {
    const list = this.#byStore.get(query.storeId) ?? [];
    return list
      .filter((notification) => query.unreadOnly !== true || notification.readAt === null)
      .slice(-(query.limit ?? 50))
      .reverse()
      .map(clone);
  }

  async markRead(id: string, storeId: StoreId, at: Instant): Promise<Notification | undefined> {
    const list = this.#byStore.get(storeId);
    if (list === undefined) return undefined;

    const index = list.findIndex((notification) => notification.id === id);
    if (index === -1) return undefined;

    const current = list[index] as Notification;
    // Idempotente: reler algo ja lido nao muda o instante da primeira leitura.
    const updated: Notification = current.readAt === null ? { ...current, readAt: at } : current;
    list[index] = updated;
    return clone(updated);
  }

  async unreadCount(storeId: StoreId): Promise<number> {
    return (this.#byStore.get(storeId) ?? []).filter((n) => n.readAt === null).length;
  }
}

export function createInMemoryRepositories(): Repositories {
  return {
    stores: new InMemoryStoreRepository(),
    users: new InMemoryUserRepository(),
    memberships: new InMemoryMembershipRepository(),
    vehicles: new InMemoryVehicleRepository(),
    locks: new InMemoryLockRepository(),
    transfers: new InMemoryCustodyTransferRepository(),
    recalls: new InMemoryRecallRepository(),
    deals: new InMemoryDealRepository(),
    shareLinks: new InMemoryShareLinkRepository(),
    audit: new InMemoryAuditRepository(),
    notifications: new InMemoryNotificationRepository(),
  };
}
