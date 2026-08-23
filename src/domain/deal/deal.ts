/**
 * Negociacao de repasse — a operacao de compra B2B casada com a venda B2C.
 *
 * Quem faz o que:
 *   Loja B (vendedora) atende o cliente final, roda a ficha de financiamento,
 *   absorve o carro de troca e assume a garantia legal perante o consumidor
 *   (CDC). Ela precifica o carro ao cliente pelo valor que quiser.
 *   Loja A (proprietaria) recebe o preco LIQUIDO que ela mesma fixou, e emite
 *   a documentacao / ATPV-e diretamente ao comprador final.
 *
 * O numero que sustenta o modelo: a Loja A recebe exatamente o liquido, nem
 * mais nem menos, e 100% do excedente fica com a Loja B. Nao ha rateio, nao ha
 * comissao sobre margem — o que remove a negociacao de margem por telefone que
 * este produto existe para eliminar.
 *
 * O veiculo de troca tem dois destinos possiveis:
 *
 *   PADRAO      a Loja B fica com o carro de troca no proprio patio (lucra na
 *               venda do seminovo e no giro da troca) e paga a Loja A 100% em
 *               dinheiro.
 *
 *   TRANSBORDO  a Loja B nao quer o modelo da troca e oferta o carro a Loja A,
 *               que abate o valor aceito do liquido a receber. Exige aceite
 *               EXPLICITO da Loja A antes do fechamento: sem isso, a Loja B
 *               daria um valor ao cliente sem saber se alguem o honra.
 */

import { type Result, err, ok } from '../shared/result.ts';
import {
  type DomainError,
  conflictError,
  forbiddenError,
  ruleViolation,
  validationError,
} from '../shared/errors.ts';
import { type DomainEvent, domainEvent } from '../shared/events.ts';
import { type Transition, transitioned } from '../shared/transition.ts';
import type { Instant } from '../shared/clock.ts';
import type { DealId, LockId, SettlementId, StoreId, UserId, VehicleId } from '../shared/ids.ts';
import {
  type Money,
  ZERO,
  add,
  equals as moneyEquals,
  format as formatMoney,
  gt,
  gte,
  isNegative,
  isPositive,
  isZero,
  subtract,
  sum,
} from '../shared/money.ts';
import { requireText } from '../shared/validation.ts';
import { parseBuyerDocument } from '../shared/validation.ts';

export const DealStatus = {
  /** Montada, aguardando confirmacao. */
  DRAFT: 'DRAFT',
  /** Transbordo proposto: espera o aceite da loja proprietaria. */
  AWAITING_TRADE_IN_ACCEPTANCE: 'AWAITING_TRADE_IN_ACCEPTANCE',
  /** Venda fechada com o cliente. O veiculo sai do estoque da rede. */
  CONFIRMED: 'CONFIRMED',
  /** A Loja A recebeu o liquido integral. */
  SETTLED: 'SETTLED',
  /** Liquidada, documentada (ATPV-e) e entregue ao comprador. */
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;
export type DealStatus = (typeof DealStatus)[keyof typeof DealStatus];

export const TradeInDestination = {
  /** Padrao: o carro de troca fica no patio da loja vendedora. */
  SELLER_STOCK: 'SELLER_STOCK',
  /** Transbordo: o carro de troca vai para a loja proprietaria, abatendo o liquido. */
  OWNER_STORE: 'OWNER_STORE',
} as const;
export type TradeInDestination = (typeof TradeInDestination)[keyof typeof TradeInDestination];

export type TradeInVehicle = {
  readonly plate: string;
  readonly brand: string;
  readonly model: string;
  readonly version: string;
  readonly modelYear: number;
  readonly mileageKm: number;
  readonly color: string;
  readonly notes: string | null;
};

export type TradeInAcceptance = {
  readonly acceptedValue: Money;
  readonly acceptedAt: Instant;
  readonly acceptedByUserId: UserId;
};

export type TradeIn = {
  readonly vehicle: TradeInVehicle;
  /** Quanto foi creditado ao cliente na troca — abate o preco de venda. */
  readonly allowanceToConsumer: Money;
  /** Quanto a loja vendedora avalia o carro de troca de fato. */
  readonly appraisedValue: Money;
  readonly destination: TradeInDestination;
  /** Preenchido apenas no transbordo, e obrigatorio para fechar. */
  readonly ownerAcceptance: TradeInAcceptance | null;
};

export const SettlementMethod = {
  PIX: 'PIX',
  TED: 'TED',
  /** Liberacao do banco na operacao de financiamento do cliente. */
  BANK_FINANCING: 'BANK_FINANCING',
  CASH: 'CASH',
} as const;
export type SettlementMethod = (typeof SettlementMethod)[keyof typeof SettlementMethod];

export type Settlement = {
  readonly id: SettlementId;
  readonly amount: Money;
  readonly method: SettlementMethod;
  /** Comprovante: end-to-end do PIX, numero do TED, contrato do banco. */
  readonly reference: string;
  readonly paidAt: Instant;
  readonly registeredByUserId: UserId;
};

export type AtpvEmission = {
  readonly atpvNumber: string;
  readonly buyerName: string;
  readonly buyerDocument: string;
  readonly buyerDocumentType: 'CPF' | 'CNPJ';
  readonly emittedAt: Instant;
};

export type Deal = {
  readonly id: DealId;
  readonly vehicleId: VehicleId;
  readonly lockId: LockId;
  /** Loja A: dona do veiculo, recebe o liquido, emite o ATPV-e. */
  readonly ownerStoreId: StoreId;
  /** Loja B: atende o cliente, precifica, assume a garantia do CDC. */
  readonly sellingStoreId: StoreId;
  /** Liquido congelado na trava. Nao muda depois de aberta a negociacao. */
  readonly netPriceToOwner: Money;
  /** Preco ao consumidor. Autonomia total da loja vendedora. */
  readonly retailPriceToConsumer: Money;
  readonly tradeIn: TradeIn | null;
  readonly status: DealStatus;
  readonly createdAt: Instant;
  readonly createdByUserId: UserId;
  readonly confirmedAt: Instant | null;
  readonly settlements: readonly Settlement[];
  readonly settledAt: Instant | null;
  readonly atpv: AtpvEmission | null;
  readonly deliveredAt: Instant | null;
  readonly completedAt: Instant | null;
  readonly cancelledAt: Instant | null;
  readonly cancelReason: string | null;
};

// ---------------------------------------------------------------------------
// Calculo financeiro
// ---------------------------------------------------------------------------

export type DealFinancials = {
  readonly netPriceToOwner: Money;
  readonly retailPriceToConsumer: Money;
  readonly tradeInAllowance: Money;
  /** O que o cliente paga em dinheiro/banco, ja abatida a troca. */
  readonly cashFromConsumer: Money;
  /** Credito da troca no transbordo; zero no cenario padrao. */
  readonly tradeInCreditToOwner: Money;
  /** O que a Loja B efetivamente transfere a Loja A. */
  readonly cashDueToOwner: Money;
  /** Excedente sobre o liquido: 100% da Loja B. */
  readonly sellerGrossMargin: Money;
  /** Resultado do giro da troca para a Loja B. */
  readonly sellerTradeInResult: Money;
  readonly sellerTotalResult: Money;
  readonly settledAmount: Money;
  readonly outstandingAmount: Money;
  readonly fullySettled: boolean;
  /** A Loja B optou por vender abaixo do liquido. Permitido, mas sinalizado. */
  readonly sellingBelowNetPrice: boolean;
};

export function computeFinancials(deal: Deal): DealFinancials {
  const tradeIn = deal.tradeIn;
  const allowance = tradeIn?.allowanceToConsumer ?? ZERO;

  const isTransbordo = tradeIn !== null && tradeIn.destination === TradeInDestination.OWNER_STORE;
  const tradeInCreditToOwner = isTransbordo
    ? (tradeIn.ownerAcceptance?.acceptedValue ?? ZERO)
    : ZERO;

  const cashDueToOwner = subtract(deal.netPriceToOwner, tradeInCreditToOwner);
  const cashFromConsumer = subtract(deal.retailPriceToConsumer, allowance);
  const sellerGrossMargin = subtract(deal.retailPriceToConsumer, deal.netPriceToOwner);

  // No cenario padrao a Loja B fica com o carro: ganha a diferenca entre o que
  // ele vale e o que ela creditou. No transbordo, ganha a diferenca entre o que
  // a Loja A aceitou e o que ela creditou.
  const tradeInValueToSeller = tradeIn === null
    ? ZERO
    : isTransbordo
      ? tradeInCreditToOwner
      : tradeIn.appraisedValue;
  const sellerTradeInResult = tradeIn === null ? ZERO : subtract(tradeInValueToSeller, allowance);

  const settledAmount = sum(deal.settlements.map((settlement) => settlement.amount));
  const outstandingAmount = subtract(cashDueToOwner, settledAmount);

  return {
    netPriceToOwner: deal.netPriceToOwner,
    retailPriceToConsumer: deal.retailPriceToConsumer,
    tradeInAllowance: allowance,
    cashFromConsumer,
    tradeInCreditToOwner,
    cashDueToOwner,
    sellerGrossMargin,
    sellerTradeInResult,
    sellerTotalResult: add(sellerGrossMargin, sellerTradeInResult),
    settledAmount,
    outstandingAmount: isNegative(outstandingAmount) ? ZERO : outstandingAmount,
    fullySettled: gte(settledAmount, cashDueToOwner),
    sellingBelowNetPrice: gt(deal.netPriceToOwner, deal.retailPriceToConsumer),
  };
}

// ---------------------------------------------------------------------------
// Abertura
// ---------------------------------------------------------------------------

export type OpenDealCommand = {
  readonly dealId: DealId;
  readonly vehicleId: VehicleId;
  readonly lockId: LockId;
  readonly ownerStoreId: StoreId;
  readonly sellingStoreId: StoreId;
  readonly createdByUserId: UserId;
  /** Preco liquido congelado na trava — a fonte da verdade do valor. */
  readonly netPriceSnapshot: Money;
  readonly retailPriceToConsumer: Money;
  readonly tradeIn?: TradeIn | null;
  readonly now: Instant;
};

export function openDeal(command: OpenDealCommand): Transition<Deal> {
  if (command.ownerStoreId === command.sellingStoreId) {
    return err(
      ruleViolation(
        'OWNER_IS_SELLER',
        'Venda da propria loja nao e repasse de rede; registre no seu ERP.',
        { storeId: command.ownerStoreId },
      ),
    );
  }
  if (!isPositive(command.retailPriceToConsumer)) {
    return err(
      validationError('RETAIL_PRICE_REQUIRED', 'Informe o preco de venda ao consumidor final.'),
    );
  }
  if (!isPositive(command.netPriceSnapshot)) {
    return err(validationError('NET_PRICE_REQUIRED', 'Preco liquido de repasse invalido.'));
  }

  const tradeIn = command.tradeIn ?? null;
  if (tradeIn !== null) {
    const check = validateTradeIn(tradeIn, command.retailPriceToConsumer, command.netPriceSnapshot);
    if (!check.ok) return check;
  }

  const needsAcceptance =
    tradeIn !== null &&
    tradeIn.destination === TradeInDestination.OWNER_STORE &&
    tradeIn.ownerAcceptance === null;

  const deal: Deal = {
    id: command.dealId,
    vehicleId: command.vehicleId,
    lockId: command.lockId,
    ownerStoreId: command.ownerStoreId,
    sellingStoreId: command.sellingStoreId,
    netPriceToOwner: command.netPriceSnapshot,
    retailPriceToConsumer: command.retailPriceToConsumer,
    tradeIn,
    status: needsAcceptance ? DealStatus.AWAITING_TRADE_IN_ACCEPTANCE : DealStatus.DRAFT,
    createdAt: command.now,
    createdByUserId: command.createdByUserId,
    confirmedAt: null,
    settlements: [],
    settledAt: null,
    atpv: null,
    deliveredAt: null,
    completedAt: null,
    cancelledAt: null,
    cancelReason: null,
  };

  const financials = computeFinancials(deal);
  const events: DomainEvent[] = [
    domainEvent('deal.opened', deal.id, command.now, {
      vehicleId: deal.vehicleId,
      ownerStoreId: deal.ownerStoreId,
      sellingStoreId: deal.sellingStoreId,
      netPriceCents: deal.netPriceToOwner.cents,
      retailPriceCents: deal.retailPriceToConsumer.cents,
      tradeInDestination: tradeIn?.destination ?? null,
      status: deal.status,
    }),
  ];

  if (financials.sellingBelowNetPrice) {
    // Nao e erro: a Loja B tem autonomia e pode aceitar prejuizo no seminovo
    // para ganhar no giro da troca. Mas fica registrado.
    events.push(
      domainEvent('deal.selling_below_net_price', deal.id, command.now, {
        netPriceCents: deal.netPriceToOwner.cents,
        retailPriceCents: deal.retailPriceToConsumer.cents,
        marginCents: financials.sellerGrossMargin.cents,
      }),
    );
  }
  if (needsAcceptance) {
    events.push(
      domainEvent('deal.trade_in_acceptance_requested', deal.id, command.now, {
        ownerStoreId: deal.ownerStoreId,
        tradeInPlate: tradeIn?.vehicle.plate ?? null,
        allowanceCents: tradeIn?.allowanceToConsumer.cents ?? 0,
      }),
    );
  }

  return transitioned(deal, events);
}

function validateTradeIn(
  tradeIn: TradeIn,
  retailPrice: Money,
  netPrice: Money,
): Result<true, DomainError> {
  if (isNegative(tradeIn.allowanceToConsumer) || isNegative(tradeIn.appraisedValue)) {
    return err(validationError('TRADE_IN_NEGATIVE_VALUE', 'Valores da troca nao podem ser negativos.'));
  }
  if (gt(tradeIn.allowanceToConsumer, retailPrice)) {
    return err(
      ruleViolation(
        'TRADE_IN_ALLOWANCE_ABOVE_RETAIL',
        `O valor dado na troca (${formatMoney(tradeIn.allowanceToConsumer)}) supera o preco de venda (${formatMoney(retailPrice)}).`,
        {
          allowanceCents: tradeIn.allowanceToConsumer.cents,
          retailPriceCents: retailPrice.cents,
        },
      ),
    );
  }

  const acceptance = tradeIn.ownerAcceptance;
  if (tradeIn.destination === TradeInDestination.OWNER_STORE && acceptance !== null) {
    if (gt(acceptance.acceptedValue, netPrice)) {
      // A Loja A ficaria devendo dinheiro a Loja B — a operacao deixaria de ser
      // um repasse e viraria uma compra em sentido contrario.
      return err(
        ruleViolation(
          'TRADE_IN_EXCEEDS_NET_PRICE',
          `A troca aceita (${formatMoney(acceptance.acceptedValue)}) supera o liquido do veiculo (${formatMoney(netPrice)}). Registre as duas operacoes separadamente.`,
          { acceptedValueCents: acceptance.acceptedValue.cents, netPriceCents: netPrice.cents },
        ),
      );
    }
  }
  return ok(true);
}

// ---------------------------------------------------------------------------
// Aceite do transbordo
// ---------------------------------------------------------------------------

export type AcceptTradeInCommand = {
  readonly deal: Deal;
  readonly actorStoreId: StoreId;
  readonly actorUserId: UserId;
  readonly acceptedValue: Money;
  readonly now: Instant;
};

/** A loja proprietaria aceita receber o carro de troca abatendo o liquido. */
export function acceptTradeIn(command: AcceptTradeInCommand): Transition<Deal> {
  const { deal, now } = command;

  if (deal.status !== DealStatus.AWAITING_TRADE_IN_ACCEPTANCE) {
    return err(
      conflictError(
        'DEAL_NOT_AWAITING_TRADE_IN',
        'Esta negociacao nao esta aguardando aceite de transbordo.',
        { dealId: deal.id, status: deal.status },
      ),
    );
  }
  if (command.actorStoreId !== deal.ownerStoreId) {
    return err(
      forbiddenError(
        'NOT_VEHICLE_OWNER',
        'Somente a loja proprietaria aceita receber o veiculo de troca.',
        { dealId: deal.id, ownerStoreId: deal.ownerStoreId },
      ),
    );
  }
  if (deal.tradeIn === null) {
    return err(conflictError('NO_TRADE_IN', 'Esta negociacao nao tem veiculo de troca.', { dealId: deal.id }));
  }
  if (gt(command.acceptedValue, deal.netPriceToOwner)) {
    return err(
      ruleViolation(
        'TRADE_IN_EXCEEDS_NET_PRICE',
        `A troca aceita (${formatMoney(command.acceptedValue)}) supera o liquido do veiculo (${formatMoney(deal.netPriceToOwner)}). Registre as duas operacoes separadamente.`,
        { acceptedValueCents: command.acceptedValue.cents, netPriceCents: deal.netPriceToOwner.cents },
      ),
    );
  }
  if (isNegative(command.acceptedValue)) {
    return err(validationError('TRADE_IN_NEGATIVE_VALUE', 'Valor de aceite invalido.'));
  }

  const accepted: Deal = {
    ...deal,
    status: DealStatus.DRAFT,
    tradeIn: {
      ...deal.tradeIn,
      ownerAcceptance: {
        acceptedValue: command.acceptedValue,
        acceptedAt: now,
        acceptedByUserId: command.actorUserId,
      },
    },
  };

  return transitioned(accepted, [
    domainEvent('deal.trade_in_accepted', deal.id, now, {
      ownerStoreId: deal.ownerStoreId,
      acceptedValueCents: command.acceptedValue.cents,
      cashDueToOwnerCents: computeFinancials(accepted).cashDueToOwner.cents,
    }),
  ]);
}

export type RejectTradeInCommand = {
  readonly deal: Deal;
  readonly actorStoreId: StoreId;
  readonly reason: string;
  readonly now: Instant;
};

/**
 * A loja proprietaria recusa o transbordo. A negociacao nao morre: a Loja B
 * pode seguir absorvendo a troca no proprio patio e pagando 100% em dinheiro.
 */
export function rejectTradeIn(command: RejectTradeInCommand): Transition<Deal> {
  const { deal, now } = command;

  if (deal.status !== DealStatus.AWAITING_TRADE_IN_ACCEPTANCE) {
    return err(
      conflictError(
        'DEAL_NOT_AWAITING_TRADE_IN',
        'Esta negociacao nao esta aguardando aceite de transbordo.',
        { dealId: deal.id, status: deal.status },
      ),
    );
  }
  if (command.actorStoreId !== deal.ownerStoreId) {
    return err(
      forbiddenError('NOT_VEHICLE_OWNER', 'Somente a loja proprietaria recusa o transbordo.', {
        dealId: deal.id,
      }),
    );
  }
  if (deal.tradeIn === null) {
    return err(conflictError('NO_TRADE_IN', 'Esta negociacao nao tem veiculo de troca.', { dealId: deal.id }));
  }

  const reverted: Deal = {
    ...deal,
    status: DealStatus.DRAFT,
    tradeIn: {
      ...deal.tradeIn,
      destination: TradeInDestination.SELLER_STOCK,
      ownerAcceptance: null,
    },
  };

  return transitioned(reverted, [
    domainEvent('deal.trade_in_rejected', deal.id, now, {
      ownerStoreId: deal.ownerStoreId,
      reason: command.reason,
      fallback: 'A troca fica no patio da loja vendedora e o liquido e pago integralmente em dinheiro.',
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Confirmacao
// ---------------------------------------------------------------------------

export type ConfirmDealCommand = {
  readonly deal: Deal;
  readonly actorStoreId: StoreId;
  readonly now: Instant;
};

/**
 * Fecha a venda com o cliente. E aqui que o veiculo sai do estoque da rede e a
 * trava vira venda — as duas coisas acontecem na mesma transacao (ver o servico
 * de aplicacao).
 */
export function confirmDeal(command: ConfirmDealCommand): Transition<Deal> {
  const { deal, now } = command;

  if (command.actorStoreId !== deal.sellingStoreId) {
    return err(
      forbiddenError('NOT_SELLING_STORE', 'Somente a loja vendedora confirma a venda ao cliente.', {
        dealId: deal.id,
        sellingStoreId: deal.sellingStoreId,
      }),
    );
  }
  if (deal.status === DealStatus.AWAITING_TRADE_IN_ACCEPTANCE) {
    return err(
      conflictError(
        'TRADE_IN_ACCEPTANCE_PENDING',
        'O transbordo ainda depende do aceite da loja proprietaria.',
        { dealId: deal.id },
      ),
    );
  }
  if (deal.status !== DealStatus.DRAFT) {
    return err(
      conflictError('DEAL_NOT_DRAFT', `Esta negociacao ja esta ${deal.status}.`, {
        dealId: deal.id,
        status: deal.status,
      }),
    );
  }

  const financials = computeFinancials(deal);
  if (isNegative(financials.cashDueToOwner)) {
    return err(
      ruleViolation(
        'TRADE_IN_EXCEEDS_NET_PRICE',
        'O credito da troca supera o liquido devido a loja proprietaria.',
        { cashDueToOwnerCents: financials.cashDueToOwner.cents },
      ),
    );
  }

  // Transbordo em que a troca cobre exatamente o liquido ja nasce liquidado.
  const nothingToPay = isZero(financials.cashDueToOwner);
  const confirmed: Deal = {
    ...deal,
    status: nothingToPay ? DealStatus.SETTLED : DealStatus.CONFIRMED,
    confirmedAt: now,
    settledAt: nothingToPay ? now : null,
  };

  const events: DomainEvent[] = [
    domainEvent('deal.confirmed', deal.id, now, {
      vehicleId: deal.vehicleId,
      lockId: deal.lockId,
      ownerStoreId: deal.ownerStoreId,
      sellingStoreId: deal.sellingStoreId,
      netPriceCents: deal.netPriceToOwner.cents,
      retailPriceCents: deal.retailPriceToConsumer.cents,
      cashDueToOwnerCents: financials.cashDueToOwner.cents,
      tradeInCreditCents: financials.tradeInCreditToOwner.cents,
      sellerTotalResultCents: financials.sellerTotalResult.cents,
    }),
  ];
  if (nothingToPay) {
    events.push(
      domainEvent('deal.settled', deal.id, now, {
        ownerStoreId: deal.ownerStoreId,
        cashDueToOwnerCents: 0,
        note: 'O credito da troca cobriu integralmente o liquido.',
      }),
    );
  }

  return transitioned(confirmed, events);
}

// ---------------------------------------------------------------------------
// Liquidacao
// ---------------------------------------------------------------------------

export type RegisterSettlementCommand = {
  readonly deal: Deal;
  readonly settlementId: SettlementId;
  readonly actorStoreId: StoreId;
  readonly actorUserId: UserId;
  readonly amount: Money;
  readonly method: SettlementMethod;
  readonly reference: string;
  readonly paidAt: Instant;
  readonly now: Instant;
};

/**
 * Registra um pagamento da Loja B para a Loja A. Aceita parcial (entrada agora,
 * liberacao do banco depois), que e como a operacao real acontece.
 */
export function registerSettlement(command: RegisterSettlementCommand): Transition<Deal> {
  const { deal, now } = command;

  if (command.actorStoreId !== deal.sellingStoreId) {
    return err(
      forbiddenError(
        'NOT_SELLING_STORE',
        'Somente a loja vendedora registra a liquidacao para a loja proprietaria.',
        { dealId: deal.id },
      ),
    );
  }
  if (deal.status !== DealStatus.CONFIRMED) {
    return err(
      conflictError(
        'DEAL_NOT_CONFIRMED',
        deal.status === DealStatus.SETTLED
          ? 'Esta negociacao ja esta liquidada.'
          : 'A liquidacao so e registrada depois da venda confirmada.',
        { dealId: deal.id, status: deal.status },
      ),
    );
  }
  if (!isPositive(command.amount)) {
    return err(validationError('SETTLEMENT_AMOUNT_INVALID', 'O valor liquidado deve ser positivo.'));
  }

  const reference = requireText(command.reference, 'comprovante da liquidacao', { min: 3, max: 200 });
  if (!reference.ok) return reference;

  const before = computeFinancials(deal);
  if (gt(command.amount, before.outstandingAmount)) {
    return err(
      ruleViolation(
        'SETTLEMENT_EXCEEDS_BALANCE',
        `O valor informado (${formatMoney(command.amount)}) supera o saldo devido (${formatMoney(before.outstandingAmount)}).`,
        {
          amountCents: command.amount.cents,
          outstandingCents: before.outstandingAmount.cents,
        },
      ),
    );
  }

  const settlement: Settlement = {
    id: command.settlementId,
    amount: command.amount,
    method: command.method,
    reference: reference.value,
    paidAt: command.paidAt,
    registeredByUserId: command.actorUserId,
  };

  const withSettlement: Deal = { ...deal, settlements: [...deal.settlements, settlement] };
  const after = computeFinancials(withSettlement);

  const events: DomainEvent[] = [
    domainEvent('deal.settlement_registered', deal.id, now, {
      settlementId: settlement.id,
      amountCents: settlement.amount.cents,
      method: settlement.method,
      outstandingCents: after.outstandingAmount.cents,
      ownerStoreId: deal.ownerStoreId,
    }),
  ];

  if (!after.fullySettled) return transitioned(withSettlement, events);

  events.push(
    domainEvent('deal.settled', deal.id, now, {
      ownerStoreId: deal.ownerStoreId,
      sellingStoreId: deal.sellingStoreId,
      cashDueToOwnerCents: after.cashDueToOwner.cents,
      settlementCount: withSettlement.settlements.length,
    }),
  );

  return transitioned({ ...withSettlement, status: DealStatus.SETTLED, settledAt: now }, events);
}

// ---------------------------------------------------------------------------
// Documentacao e entrega
// ---------------------------------------------------------------------------

export type RegisterAtpvCommand = {
  readonly deal: Deal;
  readonly actorStoreId: StoreId;
  readonly atpvNumber: string;
  readonly buyerName: string;
  readonly buyerDocument: string;
  readonly now: Instant;
};

/**
 * A loja proprietaria emite o ATPV-e ao comprador final.
 *
 * E ela quem emite porque o veiculo esta no nome dela: a rede compartilha
 * estoque, nao transfere titularidade entre lojistas.
 */
export function registerAtpv(command: RegisterAtpvCommand): Transition<Deal> {
  const { deal, now } = command;

  if (command.actorStoreId !== deal.ownerStoreId) {
    return err(
      forbiddenError(
        'NOT_VEHICLE_OWNER',
        'O ATPV-e e emitido pela loja proprietaria, em cujo nome o veiculo esta registrado.',
        { dealId: deal.id, ownerStoreId: deal.ownerStoreId },
      ),
    );
  }
  if (deal.status !== DealStatus.SETTLED && deal.status !== DealStatus.COMPLETED) {
    return err(
      conflictError(
        'DEAL_NOT_SETTLED',
        'O ATPV-e so e emitido depois que a loja proprietaria recebe o liquido.',
        { dealId: deal.id, status: deal.status },
      ),
    );
  }
  if (deal.atpv !== null) {
    return err(
      conflictError('ATPV_ALREADY_REGISTERED', 'O ATPV-e desta venda ja foi registrado.', {
        dealId: deal.id,
        atpvNumber: deal.atpv.atpvNumber,
      }),
    );
  }

  const atpvNumber = requireText(command.atpvNumber, 'numero do ATPV-e', { min: 4, max: 60 });
  if (!atpvNumber.ok) return atpvNumber;
  const buyerName = requireText(command.buyerName, 'nome do comprador', { min: 3, max: 200 });
  if (!buyerName.ok) return buyerName;
  const buyerDocument = parseBuyerDocument(command.buyerDocument);
  if (!buyerDocument.ok) return buyerDocument;

  const atpv: AtpvEmission = {
    atpvNumber: atpvNumber.value,
    buyerName: buyerName.value,
    buyerDocument: buyerDocument.value.document,
    buyerDocumentType: buyerDocument.value.type,
    emittedAt: now,
  };

  return completeIfDone({ ...deal, atpv }, now, [
    domainEvent('deal.atpv_registered', deal.id, now, {
      atpvNumber: atpv.atpvNumber,
      buyerDocumentType: atpv.buyerDocumentType,
      ownerStoreId: deal.ownerStoreId,
    }),
  ]);
}

export type MarkDeliveredCommand = {
  readonly deal: Deal;
  readonly actorStoreId: StoreId;
  readonly now: Instant;
};

export function markDelivered(command: MarkDeliveredCommand): Transition<Deal> {
  const { deal, now } = command;

  if (command.actorStoreId !== deal.sellingStoreId) {
    return err(
      forbiddenError(
        'NOT_SELLING_STORE',
        'A entrega ao comprador e da loja vendedora, que atendeu o cliente.',
        { dealId: deal.id },
      ),
    );
  }
  if (deal.status !== DealStatus.SETTLED && deal.status !== DealStatus.COMPLETED) {
    return err(
      conflictError('DEAL_NOT_SETTLED', 'Registre a liquidacao antes da entrega.', {
        dealId: deal.id,
        status: deal.status,
      }),
    );
  }
  if (deal.deliveredAt !== null) {
    return err(conflictError('DEAL_ALREADY_DELIVERED', 'Entrega ja registrada.', { dealId: deal.id }));
  }

  return completeIfDone({ ...deal, deliveredAt: now }, now, [
    domainEvent('deal.delivered', deal.id, now, { sellingStoreId: deal.sellingStoreId }),
  ]);
}

/** A negociacao se encerra quando dinheiro, documento e carro chegaram ao destino. */
function completeIfDone(deal: Deal, now: Instant, events: DomainEvent[]): Transition<Deal> {
  if (deal.atpv === null || deal.deliveredAt === null || deal.status === DealStatus.COMPLETED) {
    return transitioned(deal, events);
  }
  return transitioned({ ...deal, status: DealStatus.COMPLETED, completedAt: now }, [
    ...events,
    domainEvent('deal.completed', deal.id, now, {
      vehicleId: deal.vehicleId,
      ownerStoreId: deal.ownerStoreId,
      sellingStoreId: deal.sellingStoreId,
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Cancelamento
// ---------------------------------------------------------------------------

export type CancelDealCommand = {
  readonly deal: Deal;
  readonly actorStoreId: StoreId;
  readonly reason: string;
  readonly now: Instant;
};

/**
 * Cancela a negociacao. So antes da liquidacao: depois que a Loja A recebeu o
 * dinheiro, desfazer envolve estorno e e assunto de gente, nao de software.
 */
export function cancelDeal(command: CancelDealCommand): Transition<Deal> {
  const { deal, now } = command;

  if (command.actorStoreId !== deal.sellingStoreId && command.actorStoreId !== deal.ownerStoreId) {
    return err(
      forbiddenError('NOT_A_DEAL_PARTY', 'Somente as lojas envolvidas cancelam a negociacao.', {
        dealId: deal.id,
      }),
    );
  }
  if (deal.status === DealStatus.CANCELLED) {
    return transitioned(deal, []);
  }
  if (
    deal.status === DealStatus.SETTLED ||
    deal.status === DealStatus.COMPLETED ||
    deal.settlements.length > 0
  ) {
    return err(
      conflictError(
        'DEAL_ALREADY_SETTLED',
        'Ja houve liquidacao nesta negociacao. O desfazimento envolve estorno e precisa ser tratado entre as lojas.',
        { dealId: deal.id, status: deal.status, settlements: deal.settlements.length },
      ),
    );
  }

  const reason = requireText(command.reason, 'motivo do cancelamento', { min: 3, max: 500 });
  if (!reason.ok) return reason;

  return transitioned(
    { ...deal, status: DealStatus.CANCELLED, cancelledAt: now, cancelReason: reason.value },
    [
      domainEvent('deal.cancelled', deal.id, now, {
        vehicleId: deal.vehicleId,
        reason: reason.value,
        cancelledByStoreId: command.actorStoreId,
        wasConfirmed: deal.confirmedAt !== null,
      }),
    ],
  );
}

export function isTerminal(deal: Deal): boolean {
  return deal.status === DealStatus.COMPLETED || deal.status === DealStatus.CANCELLED;
}

/** Resumo textual da operacao, para log e para a tela de acompanhamento. */
export function describeDeal(deal: Deal): string {
  const financials = computeFinancials(deal);
  const parts = [
    `liquido a Loja A ${formatMoney(deal.netPriceToOwner)}`,
    `venda ao cliente ${formatMoney(deal.retailPriceToConsumer)}`,
    `margem da Loja B ${formatMoney(financials.sellerGrossMargin)}`,
  ];
  if (deal.tradeIn !== null) {
    parts.push(
      deal.tradeIn.destination === TradeInDestination.OWNER_STORE
        ? `transbordo da troca ${formatMoney(financials.tradeInCreditToOwner)}`
        : `troca absorvida pela Loja B ${formatMoney(deal.tradeIn.allowanceToConsumer)}`,
    );
  }
  if (!moneyEquals(financials.cashDueToOwner, deal.netPriceToOwner)) {
    parts.push(`dinheiro a transferir ${formatMoney(financials.cashDueToOwner)}`);
  }
  return parts.join(' | ');
}
