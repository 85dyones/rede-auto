/**
 * Identificadores com prefixo e tipagem nominal.
 *
 * O prefixo ("veh_", "lck_") torna log e suporte legiveis: da para saber o tipo
 * do agregado so de olhar o id. A tipagem nominal impede trocar um StoreId por
 * um VehicleId em uma chamada de funcao — erro facil de cometer e caro de achar.
 */

declare const brand: unique symbol;

export type Branded<T, B extends string> = T & { readonly [brand]: B };

export type ClusterId = Branded<string, 'ClusterId'>;
export type StoreId = Branded<string, 'StoreId'>;
export type UserId = Branded<string, 'UserId'>;
export type VehicleId = Branded<string, 'VehicleId'>;
export type LockId = Branded<string, 'LockId'>;
export type CustodyTransferId = Branded<string, 'CustodyTransferId'>;
export type RecallId = Branded<string, 'RecallId'>;
export type DealId = Branded<string, 'DealId'>;
export type SettlementId = Branded<string, 'SettlementId'>;
export type ShareLinkId = Branded<string, 'ShareLinkId'>;
export type ApplicationId = Branded<string, 'ApplicationId'>;
export type IngestionRunId = Branded<string, 'IngestionRunId'>;
export type AuditEntryId = Branded<string, 'AuditEntryId'>;

export const IdPrefix = {
  cluster: 'clu',
  store: 'str',
  user: 'usr',
  vehicle: 'veh',
  lock: 'lck',
  custodyTransfer: 'cst',
  recall: 'rcl',
  deal: 'dea',
  settlement: 'stl',
  shareLink: 'shr',
  application: 'app',
  ingestionRun: 'ing',
  auditEntry: 'aud',
} as const;

export type IdPrefix = (typeof IdPrefix)[keyof typeof IdPrefix];

export type IdGenerator = {
  next(prefix: IdPrefix): string;
};

/** Gerador de producao: prefixo + UUID v4 sem hifens. */
export const randomIdGenerator: IdGenerator = {
  next: (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`,
};

/**
 * Gerador deterministico para testes e para o roteiro de demonstracao:
 * "veh_0001", "veh_0002"... Ids estaveis tornam snapshots e logs comparaveis.
 */
export function sequentialIdGenerator(): IdGenerator {
  const counters = new Map<string, number>();
  return {
    next: (prefix) => {
      const next = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, next);
      return `${prefix}_${String(next).padStart(4, '0')}`;
    },
  };
}

// Construtores nominais. Sao apenas casts, mas centralizam o ponto onde uma
// string "crua" (vinda de HTTP, de um feed, do banco) vira um id tipado.
export const asClusterId = (value: string): ClusterId => value as ClusterId;
export const asStoreId = (value: string): StoreId => value as StoreId;
export const asUserId = (value: string): UserId => value as UserId;
export const asVehicleId = (value: string): VehicleId => value as VehicleId;
export const asLockId = (value: string): LockId => value as LockId;
export const asCustodyTransferId = (value: string): CustodyTransferId =>
  value as CustodyTransferId;
export const asRecallId = (value: string): RecallId => value as RecallId;
export const asDealId = (value: string): DealId => value as DealId;
export const asSettlementId = (value: string): SettlementId => value as SettlementId;
export const asShareLinkId = (value: string): ShareLinkId => value as ShareLinkId;
export const asApplicationId = (value: string): ApplicationId => value as ApplicationId;
export const asIngestionRunId = (value: string): IngestionRunId => value as IngestionRunId;
export const asAuditEntryId = (value: string): AuditEntryId => value as AuditEntryId;
