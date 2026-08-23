/**
 * Linha do tempo da custodia — responde "quem estava com o carro naquele dia?".
 *
 * A pergunta real que isto resolve: chega uma multa datada de 12/03 as 14h32.
 * O carro passou por tres patios naquele mes. Quem paga?
 *
 * O livro e derivado, nao armazenado: reconstruimos os periodos a partir dos
 * termos de custodia concluidos. Como so um check-in assinado move a custodia,
 * a reconstrucao e exata — e, se um termo for adulterado, `verifyTerm` acusa
 * antes de o periodo entrar na conta.
 *
 * O tempo EM TRANSITO pertence a loja de origem, porque a responsabilidade so
 * passa quando o destino confere e assina a entrada.
 */

import type { Instant } from '../shared/clock.ts';
import type { CustodyTransferId, StoreId } from '../shared/ids.ts';
import { type Vehicle, PhysicalState } from '../vehicle/vehicle.ts';
import { type CustodyTransfer, TransferStatus } from './custody.ts';

export const CustodyBasis = {
  /** Periodo inicial: o veiculo nasce no patio da loja proprietaria. */
  INITIAL: 'INITIAL',
  /** Periodo iniciado por um termo de custodia concluido. */
  TRANSFER: 'TRANSFER',
  /** Periodo encerrado pela entrega ao comprador final. */
  DELIVERED: 'DELIVERED',
} as const;
export type CustodyBasis = (typeof CustodyBasis)[keyof typeof CustodyBasis];

export type CustodyPeriod = {
  readonly storeId: StoreId;
  readonly from: Instant;
  /** `null` significa periodo ainda em curso. */
  readonly to: Instant | null;
  readonly basis: CustodyBasis;
  readonly transferId: CustodyTransferId | null;
};

/**
 * Monta a linha do tempo. Ignora termos cancelados e termos ainda abertos:
 * nenhum dos dois moveu a responsabilidade.
 */
export function buildCustodyLedger(
  vehicle: Vehicle,
  transfers: readonly CustodyTransfer[],
): CustodyPeriod[] {
  const completed = transfers
    .filter((transfer) => transfer.status === TransferStatus.COMPLETED && transfer.closedAt !== null)
    .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));

  const periods: CustodyPeriod[] = [
    {
      storeId: vehicle.ownerStoreId,
      from: vehicle.createdAt,
      to: null,
      basis: CustodyBasis.INITIAL,
      transferId: null,
    },
  ];

  for (const transfer of completed) {
    const closedAt = transfer.closedAt as Instant;
    const open = periods[periods.length - 1] as CustodyPeriod;
    periods[periods.length - 1] = { ...open, to: closedAt };
    periods.push({
      storeId: transfer.toStoreId,
      from: closedAt,
      to: null,
      basis: CustodyBasis.TRANSFER,
      transferId: transfer.id,
    });
  }

  if (vehicle.physical.state === PhysicalState.DELIVERED_TO_CONSUMER) {
    const open = periods[periods.length - 1] as CustodyPeriod;
    periods[periods.length - 1] = { ...open, to: vehicle.physical.since };
  }

  return periods;
}

/**
 * Quem respondia pelo veiculo naquele instante.
 * Intervalo semiaberto [from, to): o instante exato do check-in ja pertence ao
 * destino, para nao existir microssegundo com dois responsaveis.
 */
export function resolveCustodianAt(
  ledger: readonly CustodyPeriod[],
  instant: Instant,
): CustodyPeriod | null {
  for (const period of ledger) {
    const startedBefore = instant >= period.from;
    const stillOpen = period.to === null || instant < period.to;
    if (startedBefore && stillOpen) return period;
  }
  return null;
}

export type InfractionAttribution =
  | {
      readonly resolved: true;
      readonly storeId: StoreId;
      readonly period: CustodyPeriod;
    }
  | {
      readonly resolved: false;
      readonly reason: 'BEFORE_FIRST_CUSTODY' | 'AFTER_DELIVERY';
      readonly ledger: readonly CustodyPeriod[];
    };

/**
 * Atribui uma multa/avaria a uma loja pela data da infracao.
 *
 * Nao "adivinha" fora do intervalo conhecido: infracao anterior a entrada do
 * veiculo na rede, ou posterior a entrega ao consumidor, volta como nao
 * resolvida — e assunto de quem estava com o carro fora da rede.
 */
export function attributeInfraction(
  ledger: readonly CustodyPeriod[],
  infractionAt: Instant,
): InfractionAttribution {
  const period = resolveCustodianAt(ledger, infractionAt);
  if (period !== null) {
    return { resolved: true, storeId: period.storeId, period };
  }

  const first = ledger[0];
  const reason =
    first !== undefined && infractionAt < first.from ? 'BEFORE_FIRST_CUSTODY' : 'AFTER_DELIVERY';
  return { resolved: false, reason, ledger };
}

/** Quanto tempo cada loja segurou o veiculo. Base para relatorio de giro. */
export function custodyDurationByStore(
  ledger: readonly CustodyPeriod[],
  now: Instant,
): Map<StoreId, number> {
  const totals = new Map<StoreId, number>();
  for (const period of ledger) {
    const end = period.to ?? now;
    const duration = Math.max(0, end - period.from);
    totals.set(period.storeId, (totals.get(period.storeId) ?? 0) + duration);
  }
  return totals;
}
