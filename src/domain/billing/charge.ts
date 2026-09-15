/**
 * Cobranca: uma linha do que a empresa deve a plataforma.
 *
 * Duas especies, e so duas — nao ha taxa por transacao (ver `tariff.ts`):
 *
 *  - ADESAO, emitida uma vez, no credenciamento;
 *  - MENSALIDADE, emitida a cada ciclo, com a competencia que cobre.
 *
 * O valor e CONGELADO na emissao, junto com a memoria de calculo. Recalcular na
 * leitura pareceria mais simples e seria errado: um patio aberto hoje mudaria
 * retroativamente uma fatura de tres meses atras, e a empresa veria um numero
 * diferente do que pagou. Fatura emitida e fato, nao consulta.
 *
 * Aqui nao ha integracao de pagamento, e isso e escopo, nao esquecimento: o
 * que o dominio precisa saber e se foi pago e ha quanto tempo esta vencido. Um
 * adaptador de cobranca real registra o pagamento pela mesma porta que a
 * plataforma registra hoje.
 */

import { err } from '../shared/result.ts';
import { conflictError, ruleViolation } from '../shared/errors.ts';
import { type Instant, DAY, addMonths } from '../shared/clock.ts';
import { domainEvent } from '../shared/events.ts';
import { type Transition, transitioned, unchanged } from '../shared/transition.ts';
import type { Money } from '../shared/money.ts';
import type { ChargeId, ClusterId, MemberId } from '../shared/ids.ts';
import type { MonthlyBreakdown } from './tariff.ts';

export const ChargeKind = {
  /** Uma vez por empresa, no credenciamento. Nao e caucao: nao volta. */
  ADHESION: 'ADHESION',
  MONTHLY: 'MONTHLY',
} as const;
export type ChargeKind = (typeof ChargeKind)[keyof typeof ChargeKind];

export const ChargeStatus = {
  OPEN: 'OPEN',
  PAID: 'PAID',
  /** Cancelada pela plataforma. Fica no historico; some do que e devido. */
  VOID: 'VOID',
} as const;
export type ChargeStatus = (typeof ChargeStatus)[keyof typeof ChargeStatus];

export type Charge = {
  readonly id: ChargeId;
  readonly memberId: MemberId;
  readonly clusterId: ClusterId;
  readonly kind: ChargeKind;
  readonly status: ChargeStatus;
  readonly issuedAt: Instant;
  readonly dueAt: Instant;
  readonly amount: Money;
  /** A tabela que gerou este valor. Na fatura, para a empresa poder conferir. */
  readonly tariffVersion: string;
  /**
   * Memoria de calculo da mensalidade, congelada. `null` na adesao, que nao tem
   * composicao: e uma linha so.
   */
  readonly breakdown: MonthlyBreakdown | null;
  /** Competencia coberta. Na adesao, os dois sao o instante da emissao. */
  readonly periodStart: Instant;
  readonly periodEnd: Instant;
  readonly paidAt: Instant | null;
};

export type BillingPolicy = {
  /** Dias entre a emissao e o vencimento. */
  readonly dueInDays: number;
  /**
   * Dias de atraso que suspendem a empresa.
   *
   * Trinta: curto o bastante para a inadimplencia nao virar credito gratuito,
   * longo o bastante para caber um boleto perdido e a conversa que resolve.
   */
  readonly suspendAfterOverdueDays: number;
};

export const DEFAULT_BILLING_POLICY: BillingPolicy = {
  dueInDays: 10,
  suspendAfterOverdueDays: 30,
};

// ---------------------------------------------------------------------------
// Emissao
// ---------------------------------------------------------------------------

export type IssueAdhesionCommand = {
  readonly id: ChargeId;
  readonly memberId: MemberId;
  readonly clusterId: ClusterId;
  readonly amount: Money;
  readonly tariffVersion: string;
  readonly now: Instant;
  readonly policy?: BillingPolicy;
};

export function issueAdhesion(command: IssueAdhesionCommand): Transition<Charge> {
  const policy = command.policy ?? DEFAULT_BILLING_POLICY;

  const charge: Charge = {
    id: command.id,
    memberId: command.memberId,
    clusterId: command.clusterId,
    kind: ChargeKind.ADHESION,
    status: ChargeStatus.OPEN,
    issuedAt: command.now,
    dueAt: command.now + policy.dueInDays * DAY,
    amount: command.amount,
    tariffVersion: command.tariffVersion,
    breakdown: null,
    periodStart: command.now,
    periodEnd: command.now,
    paidAt: null,
  };

  return transitioned(charge, [
    domainEvent('billing.adhesion_issued', charge.id, command.now, {
      clusterId: charge.clusterId,
      memberId: charge.memberId,
      cents: charge.amount.cents,
      tariffVersion: charge.tariffVersion,
      dueAt: charge.dueAt,
    }),
  ]);
}

export type IssueMonthlyCommand = {
  readonly id: ChargeId;
  readonly memberId: MemberId;
  readonly clusterId: ClusterId;
  readonly breakdown: MonthlyBreakdown;
  /** Inicio da competencia. O fim sai daqui, somando um mes de calendario. */
  readonly periodStart: Instant;
  readonly now: Instant;
  readonly policy?: BillingPolicy;
};

/**
 * Emite a mensalidade de um ciclo.
 *
 * A contagem de patios entra pela memoria de calculo, ja apurada no instante da
 * emissao. Patio aberto no meio do ciclo NAO e cobrado proporcionalmente: ele
 * aparece na proxima fatura. Sem rateio o calculo cabe numa linha, o lojista
 * consegue conferir de cabeca, e o erro que sobra — alguns dias de patio novo
 * sem cobranca — cai a favor de quem esta crescendo, que e o lado certo para
 * uma rede que quer crescer.
 *
 * O vencimento conta da EMISSAO, nao da competencia. Consequencia que importa:
 * se a plataforma ficar sem faturar e recuperar quatro ciclos de uma vez,
 * nenhum deles nasce vencido. Ninguem fica inadimplente de um boleto que nunca
 * recebeu — e a falha de quem emite nao vira suspensao de quem paga.
 */
export function issueMonthly(command: IssueMonthlyCommand): Transition<Charge> {
  const policy = command.policy ?? DEFAULT_BILLING_POLICY;

  const charge: Charge = {
    id: command.id,
    memberId: command.memberId,
    clusterId: command.clusterId,
    kind: ChargeKind.MONTHLY,
    status: ChargeStatus.OPEN,
    issuedAt: command.now,
    dueAt: command.now + policy.dueInDays * DAY,
    amount: command.breakdown.total,
    tariffVersion: command.breakdown.tariffVersion,
    breakdown: command.breakdown,
    periodStart: command.periodStart,
    periodEnd: addMonths(command.periodStart, 1),
    paidAt: null,
  };

  return transitioned(charge, [
    domainEvent('billing.monthly_issued', charge.id, command.now, {
      clusterId: charge.clusterId,
      memberId: charge.memberId,
      cents: charge.amount.cents,
      tariffVersion: charge.tariffVersion,
      extraStores: command.breakdown.extraStores,
      periodStart: charge.periodStart,
      dueAt: charge.dueAt,
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Liquidacao
// ---------------------------------------------------------------------------

export type PayChargeCommand = {
  readonly charge: Charge;
  readonly now: Instant;
};

export function payCharge(command: PayChargeCommand): Transition<Charge> {
  const { charge, now } = command;

  if (charge.status === ChargeStatus.PAID) {
    return err(
      conflictError('CHARGE_ALREADY_PAID', 'Esta cobranca ja foi liquidada.', {
        chargeId: charge.id,
        paidAt: charge.paidAt,
      }),
    );
  }
  if (charge.status === ChargeStatus.VOID) {
    return err(
      ruleViolation('CHARGE_VOID', 'Cobranca cancelada nao recebe pagamento.', {
        chargeId: charge.id,
      }),
    );
  }

  const paid: Charge = { ...charge, status: ChargeStatus.PAID, paidAt: now };

  return transitioned(paid, [
    domainEvent('billing.charge_paid', charge.id, now, {
      clusterId: charge.clusterId,
      memberId: charge.memberId,
      kind: charge.kind,
      cents: charge.amount.cents,
      // Quantos dias de atraso: e o que alimenta a regra de suspensao, e o que
      // a governanca olha quando o atraso vira padrao em vez de acidente.
      overdueDays: overdueDays(charge, now),
    }),
  ]);
}

export function voidCharge(charge: Charge, reason: string, now: Instant): Transition<Charge> {
  if (charge.status !== ChargeStatus.OPEN) return unchanged(charge);

  return transitioned({ ...charge, status: ChargeStatus.VOID }, [
    domainEvent('billing.charge_voided', charge.id, now, {
      clusterId: charge.clusterId,
      memberId: charge.memberId,
      cents: charge.amount.cents,
      reason,
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Atraso
// ---------------------------------------------------------------------------

export function isOutstanding(charge: Charge): boolean {
  return charge.status === ChargeStatus.OPEN;
}

/**
 * Dias corridos de atraso. Zero se ainda nao venceu.
 *
 * Em cobranca ja paga, mede o atraso COM QUE foi paga — pagar no dia 40 nao
 * apaga os 40 dias, e e isso que distingue um boleto perdido de um padrao.
 */
export function overdueDays(charge: Charge, now: Instant): number {
  const reference = charge.paidAt ?? now;
  return Math.max(0, Math.floor((reference - charge.dueAt) / DAY));
}

/**
 * Quantos dias a empresa esta em atraso, olhando a cobranca aberta mais antiga.
 *
 * A MAIS ANTIGA, e nao a soma: trinta dias de atraso e uma condicao sobre
 * tempo, nao sobre volume. Somar dias de tres faturas suspenderia em dez dias
 * quem tem tres cobrancas abertas do mesmo ciclo.
 */
export function memberOverdueDays(charges: readonly Charge[], now: Instant): number {
  return charges
    .filter(isOutstanding)
    .reduce((worst, charge) => Math.max(worst, overdueDays(charge, now)), 0);
}

export function totalOutstanding(charges: readonly Charge[]): Money {
  return {
    currency: 'BRL',
    cents: charges.filter(isOutstanding).reduce((sum, charge) => sum + charge.amount.cents, 0),
  };
}

/**
 * Passou do prazo que suspende?
 *
 * Note o que esta funcao NAO faz: suspender. Ela responde uma pergunta sobre
 * datas, e quem muda o estado da empresa e a governanca (`suspendForArrears`),
 * porque suspender tem consequencia operacional em todos os patios e precisa
 * emitir o evento que avisa a rede.
 */
export function isDelinquent(
  charges: readonly Charge[],
  now: Instant,
  policy: BillingPolicy = DEFAULT_BILLING_POLICY,
): boolean {
  return memberOverdueDays(charges, now) >= policy.suspendAfterOverdueDays;
}

/**
 * O proximo ciclo a faturar, ou `null` se o ultimo ainda esta em curso.
 *
 * A ancora e a data de credenciamento, e nao o primeiro dia do mes: sem rateio,
 * mes-calendario faria quem entra dia 28 pagar um mes cheio por tres dias. O
 * aniversario da adesao trata todo mundo igual e dispensa a aritmetica de
 * proporcional inteira.
 */
export function nextBillingPeriod(
  joinedAt: Instant,
  issuedPeriods: readonly Instant[],
  now: Instant,
): Instant | null {
  const emitidos = new Set(issuedPeriods);
  let period = joinedAt;

  // Avanca ate achar um ciclo ja comecado e ainda nao faturado. O laco anda em
  // meses de calendario, entao "todo dia 9" continua sendo dia 9.
  while (period <= now) {
    if (!emitidos.has(period)) return period;
    period = addMonths(period, 1);
  }
  return null;
}

/** Ciclos vencidos e nao faturados, do mais antigo para o mais novo. */
export function pendingBillingPeriods(
  joinedAt: Instant,
  issuedPeriods: readonly Instant[],
  now: Instant,
): Instant[] {
  const emitidos = new Set(issuedPeriods);
  const pendentes: Instant[] = [];
  let period = joinedAt;

  while (period <= now) {
    if (!emitidos.has(period)) pendentes.push(period);
    period = addMonths(period, 1);
  }
  return pendentes;
}

export function describeCharge(charge: Charge): string {
  const especie = charge.kind === ChargeKind.ADHESION ? 'adesao' : 'mensalidade';
  return `${especie} de R$ ${(charge.amount.cents / 100).toFixed(2)} (${charge.status})`;
}

