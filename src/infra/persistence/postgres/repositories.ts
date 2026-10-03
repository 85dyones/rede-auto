/**
 * Adaptador Postgres das portas de persistencia.
 *
 * Cada repositorio faz o que o adaptador em memoria faz, com a mesma ordem de
 * resultado — os testes de servico e de API rodam contra os dois. Onde a
 * memoria devolvia em ordem de insercao, aqui ordena por `seq`; onde ordenava
 * por um campo, ordena pelo campo e desempata por `seq`, como um sort estavel.
 */

import type {
  ApplicationId,
  BreachId,
  ChargeId,
  ClusterId,
  CustodyTransferId,
  DealId,
  LockId,
  MemberId,
  MotionId,
  RecallId,
  StoreId,
  UserId,
  VehicleId,
} from '../../../domain/shared/ids.ts';
import type { Instant } from '../../../domain/shared/clock.ts';
import type { Cluster } from '../../../domain/cluster/cluster.ts';
import type { NetworkUser, Store } from '../../../domain/network/store.ts';
import type { Member } from '../../../domain/network/member.ts';
import type { Charge } from '../../../domain/billing/charge.ts';
import type { Breach } from '../../../domain/conduct/breach.ts';
import type { ExpulsionMotion } from '../../../domain/network/expulsion.ts';
import type { MembershipApplication } from '../../../domain/network/membership.ts';
import { CommercialStatus, type Vehicle } from '../../../domain/vehicle/vehicle.ts';
import { LockStatus, type CommercialLock } from '../../../domain/lock/commercial-lock.ts';
import type { CustodyTransfer } from '../../../domain/custody/custody.ts';
import { RecallStatus, type Recall } from '../../../domain/recall/recall.ts';
import type { Deal } from '../../../domain/deal/deal.ts';
import type { Notification } from '../../../application/notifications.ts';
import type {
  ApiKeyRecord,
  CredentialRepository,
  PlatformOperator,
} from '../../auth/api-keys.ts';
import type {
  AuditEntry,
  AuditRepository,
  BreachRepository,
  ChargeRepository,
  ClusterRepository,
  CustodyTransferRepository,
  DealRepository,
  LockRepository,
  MemberRepository,
  MembershipRepository,
  MotionRepository,
  NotificationQuery,
  NotificationRepository,
  RecallRepository,
  Repositories,
  StoreRepository,
  UserRepository,
  VehicleQuery,
  VehicleRepository,
} from '../repositories.ts';
import { ConcurrencyConflict, type Database } from './database.ts';

type Columns = Readonly<Record<string, string | number | null>>;

/**
 * Uma tabela de agregado: `id`, as colunas derivadas, `version` e `data`.
 *
 * Toda leitura anota a versao na unidade de trabalho; toda gravacao de algo
 * lido na unidade confere essa versao. Gravacao do que nao foi lido (agregado
 * novo, ou gravado fora de uma unidade) e um upsert.
 */
class AggregateTable<T extends { readonly id: string }> {
  readonly #db: Database;
  readonly #name: string;
  readonly #columns: (value: T) => Columns;

  constructor(db: Database, name: string, columns: (value: T) => Columns) {
    this.#db = db;
    this.#name = name;
    this.#columns = columns;
  }

  get qualified(): string {
    return this.#db.table(this.#name);
  }

  async save(value: T): Promise<void> {
    const columns = this.#columns(value);
    const names = Object.keys(columns);
    const values = names.map((name) => columns[name]);
    const data = JSON.stringify(value);
    const versions = this.#db.versions();
    const key = `${this.#name}:${value.id}`;
    const known = versions?.get(key);

    if (known !== undefined) {
      const sets = names.map((name, index) => `${name} = $${index + 4}`);
      const result = await this.#db.query<{ version: number }>(
        `UPDATE ${this.qualified}
            SET ${[...sets, 'data = $2::jsonb', 'version = version + 1'].join(', ')}
          WHERE id = $1 AND version = $3
      RETURNING version`,
        [value.id, data, known, ...values],
      );
      const row = result.rows[0];
      if (row === undefined) throw new ConcurrencyConflict(this.#name, value.id);
      versions?.set(key, row.version);
      return;
    }

    const placeholders = names.map((_, index) => `$${index + 3}`);
    const result = await this.#db.query<{ version: number }>(
      `INSERT INTO ${this.qualified} (id, data, version${names.map((n) => `, ${n}`).join('')})
       VALUES ($1, $2::jsonb, 1${placeholders.map((p) => `, ${p}`).join('')})
       ON CONFLICT (id) DO UPDATE
          SET data = EXCLUDED.data, version = ${this.qualified}.version + 1${names
            .map((n) => `, ${n} = EXCLUDED.${n}`)
            .join('')}
    RETURNING version`,
      [value.id, data, ...values],
    );
    const row = result.rows[0];
    if (row !== undefined) versions?.set(key, row.version);
  }

  async byId(id: string): Promise<T | undefined> {
    return this.one('id = $1', [id]);
  }

  async one(where: string, params: readonly unknown[], orderBy = 'seq'): Promise<T | undefined> {
    const [first] = await this.many(where, params, orderBy, 1);
    return first;
  }

  async many(
    where: string,
    params: readonly unknown[],
    orderBy = 'seq',
    limit?: number,
    offset?: number,
  ): Promise<T[]> {
    const paging =
      (limit === undefined ? '' : ` LIMIT ${Math.trunc(limit)}`) +
      (offset === undefined ? '' : ` OFFSET ${Math.trunc(offset)}`);
    const result = await this.#db.query<{ data: T; version: number }>(
      `SELECT data, version FROM ${this.qualified} WHERE ${where} ORDER BY ${orderBy}${paging}`,
      params,
    );
    const versions = this.#db.versions();
    return result.rows.map((row) => {
      // A primeira leitura vale. Em READ COMMITTED, ler de novo a mesma linha
      // pode trazer o que outra transacao acabou de gravar; anotar essa versao
      // deixaria passar uma gravacao decidida sobre a leitura antiga. Depois de
      // gravar, `save` atualiza a versao.
      const key = `${this.#name}:${row.data.id}`;
      if (versions !== null && !versions.has(key)) versions.set(key, row.version);
      return row.data;
    });
  }

  async count(where: string, params: readonly unknown[]): Promise<number> {
    const result = await this.#db.query<{ total: string }>(
      `SELECT count(*) AS total FROM ${this.qualified} WHERE ${where}`,
      params,
    );
    return Number(result.rows[0]?.total ?? 0);
  }
}

/** Mesma dobra da busca em memoria: sem acento, minusculas. */
function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/** Texto do usuario dentro de um LIKE: `%` e `_` sao literais, nao curingas. */
function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

const OPEN_RECALL_STATUSES = [
  RecallStatus.WAITING_LOCK_RELEASE,
  RecallStatus.DUE,
  RecallStatus.READY_FOR_PICKUP,
];

export function createPostgresRepositories(db: Database): Repositories {
  const clusters = new AggregateTable<Cluster>(db, 'clusters', (c) => ({ slug: c.slug }));
  const members = new AggregateTable<Member>(db, 'members', (m) => ({
    cluster_id: m.clusterId,
    cnpj_root: m.cnpjRoot,
    kind: m.kind,
  }));
  const stores = new AggregateTable<Store>(db, 'stores', (s) => ({
    cluster_id: s.clusterId,
    member_id: s.memberId,
    cnpj: s.profile.cnpj,
  }));
  const users = new AggregateTable<NetworkUser>(db, 'users', (u) => ({ store_id: u.storeId }));
  const memberships = new AggregateTable<MembershipApplication>(db, 'membership_applications', (a) => ({
    cluster_id: a.clusterId,
    status: a.status,
  }));
  const vehicles = new AggregateTable<Vehicle>(db, 'vehicles', (v) => ({
    cluster_id: v.clusterId,
    owner_store_id: v.ownerStoreId,
    custodian_store_id: v.physical.custodianStoreId,
    chassis: v.chassis,
    commercial_status: v.commercialStatus,
    brand_folded: fold(v.specs.brand),
    model_folded: fold(v.specs.model),
    net_price_cents: v.pricing.netPrice.cents,
    model_year: v.specs.modelYear,
    mileage_km: v.specs.mileageKm,
    updated_at: v.updatedAt,
  }));
  const locks = new AggregateTable<CommercialLock>(db, 'commercial_locks', (l) => ({
    vehicle_id: l.vehicleId,
    status: l.status,
    opened_at: l.openedAt,
    expires_at: l.expiresAt,
  }));
  const transfers = new AggregateTable<CustodyTransfer>(db, 'custody_transfers', (t) => ({
    vehicle_id: t.vehicleId,
    status: t.status,
    opened_at: t.openedAt,
  }));
  const recalls = new AggregateTable<Recall>(db, 'recalls', (r) => ({
    vehicle_id: r.vehicleId,
    status: r.status,
    custodian_store_id: r.custodianStoreId,
    requested_by_store_id: r.requestedByStoreId,
    requested_at: r.requestedAt,
  }));
  const deals = new AggregateTable<Deal>(db, 'deals', (d) => ({
    vehicle_id: d.vehicleId,
    owner_store_id: d.ownerStoreId,
    selling_store_id: d.sellingStoreId,
    created_at: d.createdAt,
  }));
  const charges = new AggregateTable<Charge>(db, 'charges', (c) => ({
    cluster_id: c.clusterId,
    member_id: c.memberId,
    status: c.status,
    issued_at: c.issuedAt,
  }));
  const breaches = new AggregateTable<Breach>(db, 'breaches', (b) => ({
    cluster_id: b.clusterId,
    member_id: b.memberId,
    store_id: b.storeId,
    occurred_at: b.occurredAt,
  }));
  const motions = new AggregateTable<ExpulsionMotion>(db, 'expulsion_motions', (m) => ({
    cluster_id: m.clusterId,
    member_id: m.memberId,
    status: m.status,
    opened_at: m.openedAt,
  }));

  const clusterRepository: ClusterRepository = {
    save: (cluster) => clusters.save(cluster),
    byId: (id: ClusterId) => clusters.byId(id),
    bySlug: (slug) => clusters.one('slug = $1', [slug]),
    all: () => clusters.many('true', []),
  };

  const memberRepository: MemberRepository = {
    save: (member) => members.save(member),
    byId: (id: MemberId) => members.byId(id),
    byCnpjRoot: (root) => members.one('cnpj_root = $1', [root]),
    byCluster: (clusterId) => members.many('cluster_id = $1', [clusterId]),
    founders: (clusterId) => members.many(`cluster_id = $1 AND kind = 'FOUNDER'`, [clusterId]),
  };

  const chargeRepository: ChargeRepository = {
    save: (charge) => charges.save(charge),
    byId: (id: ChargeId) => charges.byId(id),
    byMember: (memberId) => charges.many('member_id = $1', [memberId], 'issued_at, seq'),
    outstandingInCluster: (clusterId) =>
      charges.many(`cluster_id = $1 AND status = 'OPEN'`, [clusterId]),
  };

  const storeRepository: StoreRepository = {
    save: (store) => stores.save(store),
    byId: (id: StoreId) => stores.byId(id),
    byCnpj: (cnpj) => stores.one('cnpj = $1', [cnpj]),
    byCluster: (clusterId) => stores.many('cluster_id = $1', [clusterId]),
    byMember: (memberId) => stores.many('member_id = $1', [memberId]),
  };

  const userRepository: UserRepository = {
    save: (user) => users.save(user),
    byId: (id: UserId) => users.byId(id),
    byStore: (storeId) => users.many('store_id = $1', [storeId]),
  };

  const membershipRepository: MembershipRepository = {
    save: (application) => memberships.save(application),
    byId: (id: ApplicationId) => memberships.byId(id),
    pending: (clusterId) =>
      memberships.many(`cluster_id = $1 AND status = 'PENDING'`, [clusterId]),
  };

  const vehicleRepository: VehicleRepository = {
    save: (vehicle) => vehicles.save(vehicle),
    async saveMany(list) {
      for (const vehicle of list) await vehicles.save(vehicle);
    },
    byId: (id: VehicleId) => vehicles.byId(id),
    byChassis: (chassis) => vehicles.one('chassis = $1', [chassis]),
    byOwner: (storeId) => vehicles.many('owner_store_id = $1', [storeId]),

    async search(query: VehicleQuery) {
      const conditions = ['cluster_id = $1'];
      const params: unknown[] = [query.clusterId];
      const add = (sql: (placeholder: string) => string, value: unknown): void => {
        params.push(value);
        conditions.push(sql(`$${params.length}`));
      };

      if (query.commercialStatus !== undefined) {
        add((p) => `commercial_status = ANY(${p}::text[])`, [...query.commercialStatus]);
      }
      if (query.ownerStoreId !== undefined) add((p) => `owner_store_id = ${p}`, query.ownerStoreId);
      if (query.custodianStoreId !== undefined) {
        add((p) => `custodian_store_id = ${p}`, query.custodianStoreId);
      }
      if (query.brand !== undefined) {
        add((p) => `brand_folded LIKE ${p} ESCAPE '\\'`, likeContains(fold(query.brand)));
      }
      if (query.model !== undefined) {
        add((p) => `model_folded LIKE ${p} ESCAPE '\\'`, likeContains(fold(query.model)));
      }
      if (query.maxNetPriceCents !== undefined) {
        add((p) => `net_price_cents <= ${p}`, query.maxNetPriceCents);
      }
      if (query.minModelYear !== undefined) add((p) => `model_year >= ${p}`, query.minModelYear);
      if (query.maxMileageKm !== undefined) add((p) => `mileage_km <= ${p}`, query.maxMileageKm);

      const where = conditions.join(' AND ');
      const items = await vehicles.many(
        where,
        params,
        'updated_at DESC, id COLLATE "C"',
        query.limit ?? 50,
        query.offset ?? 0,
      );
      return { items, total: await vehicles.count(where, params) };
    },

    async chassisOwners(clusterId: ClusterId) {
      const result = await db.query<{ chassis: string; owner_store_id: StoreId }>(
        `SELECT chassis, owner_store_id FROM ${vehicles.qualified}
          WHERE cluster_id = $1 AND commercial_status <> $2
          ORDER BY seq`,
        [clusterId, CommercialStatus.SOLD],
      );
      const index = new Map<string, StoreId>();
      for (const row of result.rows) index.set(row.chassis, row.owner_store_id);
      return index;
    },
  };

  const lockRepository: LockRepository = {
    save: (lock) => locks.save(lock),
    byId: (id: LockId) => locks.byId(id),
    activeByVehicle: (vehicleId) =>
      locks.one('vehicle_id = $1 AND status = $2', [vehicleId, LockStatus.ACTIVE]),
    dueForExpiry: (now: Instant) =>
      locks.many('status = $1 AND expires_at <= $2', [LockStatus.ACTIVE, now]),
    historyByVehicle: (vehicleId) => locks.many('vehicle_id = $1', [vehicleId], 'opened_at, seq'),
  };

  const transferRepository: CustodyTransferRepository = {
    save: (transfer) => transfers.save(transfer),
    byId: (id: CustodyTransferId) => transfers.byId(id),
    byVehicle: (vehicleId) => transfers.many('vehicle_id = $1', [vehicleId], 'opened_at, seq'),
    openByVehicle: (vehicleId) =>
      transfers.one(`vehicle_id = $1 AND status = 'OPEN'`, [vehicleId]),
    allPending: () =>
      transfers.many(`status IN ('OPEN', 'DROPPED_OFF')`, [], 'opened_at, seq'),
  };

  const motionRepository: MotionRepository = {
    save: (motion) => motions.save(motion),
    byId: (id: MotionId) => motions.byId(id),
    openInCluster: (clusterId) => motions.many(`cluster_id = $1 AND status = 'OPEN'`, [clusterId]),
    againstMember: (memberId) => motions.many('member_id = $1', [memberId], 'opened_at, seq'),
  };

  const breachRepository: BreachRepository = {
    save: (breach) => breaches.save(breach),
    byId: (id: BreachId) => breaches.byId(id),
    byStore: (storeId) => breaches.many('store_id = $1', [storeId], 'occurred_at, seq'),
    byMember: (memberId) => breaches.many('member_id = $1', [memberId], 'occurred_at, seq'),
    byCluster: (clusterId) => breaches.many('cluster_id = $1', [clusterId], 'occurred_at, seq'),
  };

  const recallRepository: RecallRepository = {
    save: (recall) => recalls.save(recall),
    byId: (id: RecallId) => recalls.byId(id),
    openByVehicle: (vehicleId) =>
      recalls.one('vehicle_id = $1 AND status = ANY($2::text[])', [vehicleId, OPEN_RECALL_STATUSES]),
    byVehicle: (vehicleId) => recalls.many('vehicle_id = $1', [vehicleId], 'requested_at, seq'),
    openForStore: (storeId) =>
      recalls.many(
        'status = ANY($2::text[]) AND (custodian_store_id = $1 OR requested_by_store_id = $1)',
        [storeId, OPEN_RECALL_STATUSES],
      ),
    allOpen: () => recalls.many('status = ANY($1::text[])', [OPEN_RECALL_STATUSES]),
  };

  const dealRepository: DealRepository = {
    save: (deal) => deals.save(deal),
    byId: (id: DealId) => deals.byId(id),
    byVehicle: (vehicleId) => deals.many('vehicle_id = $1', [vehicleId], 'created_at, seq'),
    byStore: (storeId) =>
      deals.many(
        'owner_store_id = $1 OR selling_store_id = $1',
        [storeId],
        'created_at DESC, seq',
      ),
  };

  const audit = db.table('audit_entries');
  const auditRepository: AuditRepository = {
    async append(entry: AuditEntry) {
      await db.query(
        `INSERT INTO ${audit} (id, aggregate_id, data) VALUES ($1, $2, $3::jsonb)`,
        [entry.id, entry.event.aggregateId, JSON.stringify(entry)],
      );
    },
    async byAggregate(aggregateId, limit = 200) {
      const result = await db.query<{ data: AuditEntry }>(
        `SELECT data FROM ${audit} WHERE aggregate_id = $1 ORDER BY seq DESC LIMIT $2`,
        [aggregateId, limit],
      );
      return result.rows.map((row) => row.data);
    },
    async recent(limit = 100) {
      const result = await db.query<{ data: AuditEntry }>(
        `SELECT data FROM ${audit} ORDER BY seq DESC LIMIT $1`,
        [limit],
      );
      return result.rows.map((row) => row.data);
    },
  };

  const notifications = db.table('notifications');
  const notificationRepository: NotificationRepository = {
    async append(notification: Notification) {
      await db.query(
        `INSERT INTO ${notifications} (id, store_id, read_at, data) VALUES ($1, $2, $3, $4::jsonb)`,
        [notification.id, notification.storeId, notification.readAt, JSON.stringify(notification)],
      );
    },
    async forStore(query: NotificationQuery) {
      const result = await db.query<{ data: Notification }>(
        `SELECT data FROM ${notifications}
          WHERE store_id = $1 AND ($2::boolean IS NOT TRUE OR read_at IS NULL)
          ORDER BY seq DESC LIMIT $3`,
        [query.storeId, query.unreadOnly === true, query.limit ?? 50],
      );
      return result.rows.map((row) => row.data);
    },
    async markRead(id, storeId, at) {
      // Idempotente: so a primeira leitura grava o instante.
      await db.query(
        `UPDATE ${notifications}
            SET read_at = $3, data = jsonb_set(data, '{readAt}', to_jsonb($3::bigint))
          WHERE id = $1 AND store_id = $2 AND read_at IS NULL`,
        [id, storeId, at],
      );
      const result = await db.query<{ data: Notification }>(
        `SELECT data FROM ${notifications} WHERE id = $1 AND store_id = $2`,
        [id, storeId],
      );
      return result.rows[0]?.data;
    },
    async unreadCount(storeId) {
      const result = await db.query<{ total: string }>(
        `SELECT count(*) AS total FROM ${notifications} WHERE store_id = $1 AND read_at IS NULL`,
        [storeId],
      );
      return Number(result.rows[0]?.total ?? 0);
    },
  };

  const storeKeys = db.table('store_api_keys');
  const platformKeys = db.table('platform_api_keys');
  const credentialRepository: CredentialRepository = {
    async saveStoreKey(keyHash: string, record: ApiKeyRecord) {
      await db.query(
        `INSERT INTO ${storeKeys} (key_hash, store_id, user_id, label) VALUES ($1, $2, $3, $4)
         ON CONFLICT (key_hash) DO UPDATE
            SET store_id = EXCLUDED.store_id, user_id = EXCLUDED.user_id, label = EXCLUDED.label`,
        [keyHash, record.storeId, record.userId, record.label],
      );
    },
    async storeKey(keyHash: string) {
      const result = await db.query<{ store_id: StoreId; user_id: UserId; label: string }>(
        `SELECT store_id, user_id, label FROM ${storeKeys} WHERE key_hash = $1`,
        [keyHash],
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : { storeId: row.store_id, userId: row.user_id, label: row.label };
    },
    async savePlatformKey(keyHash: string, operator: PlatformOperator) {
      await db.query(
        `INSERT INTO ${platformKeys} (key_hash, operator_id, name) VALUES ($1, $2, $3)
         ON CONFLICT (key_hash) DO UPDATE SET operator_id = EXCLUDED.operator_id, name = EXCLUDED.name`,
        [keyHash, operator.operatorId, operator.name],
      );
    },
    async platformKey(keyHash: string) {
      const result = await db.query<{ operator_id: string; name: string }>(
        `SELECT operator_id, name FROM ${platformKeys} WHERE key_hash = $1`,
        [keyHash],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : { operatorId: row.operator_id, name: row.name };
    },
  };

  return {
    clusters: clusterRepository,
    members: memberRepository,
    charges: chargeRepository,
    stores: storeRepository,
    users: userRepository,
    memberships: membershipRepository,
    vehicles: vehicleRepository,
    locks: lockRepository,
    transfers: transferRepository,
    breaches: breachRepository,
    motions: motionRepository,
    recalls: recallRepository,
    deals: dealRepository,
    audit: auditRepository,
    notifications: {
      ...notificationRepository,
      // Um aviso que falha ao gravar nao derruba a operacao de negocio: o
      // barramento ja isola o erro, e o savepoint mantem a transacao viva.
      append: (notification) => db.isolated(() => notificationRepository.append(notification)),
    },
    credentials: credentialRepository,
    unitOfWork: (work) => db.unitOfWork(work),
  };
}
