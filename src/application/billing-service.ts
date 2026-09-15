/**
 * Casos de uso de cobranca.
 *
 * Tres coisas acontecem aqui, e nenhuma delas e uma transacao entre lojas — a
 * plataforma nao cobra por repasse (ver `tariff.ts`):
 *
 *  1. a adesao, emitida no credenciamento;
 *  2. a mensalidade de cada ciclo, emitida pelo varredor;
 *  3. a suspensao de quem passou dos 30 dias de atraso, e a reativacao de quem
 *     quitou.
 *
 * A contagem de patios entra no calculo vinda do repositorio, apurada no
 * instante da emissao. E o mesmo principio do rol de fundadoras: numero que
 * descreve o mundo se conta, nunca se declara — com o agravante, aqui, de que
 * um numero declarado sairia na fatura do lojista.
 */

import { type Result, ok, err } from '../domain/shared/result.ts';
import type { DomainError } from '../domain/shared/errors.ts';
import { notFoundError } from '../domain/shared/errors.ts';
import { asChargeId, type ChargeId, type ClusterId, type MemberId } from '../domain/shared/ids.ts';
import type { Instant } from '../domain/shared/clock.ts';
import type { Money } from '../domain/shared/money.ts';
import { type Member, MemberStatus, reinstate, suspendForArrears } from '../domain/network/member.ts';
import {
  type Charge,
  ChargeKind,
  isDelinquent,
  issueAdhesion,
  issueMonthly,
  memberOverdueDays,
  payCharge,
  pendingBillingPeriods,
  totalOutstanding,
} from '../domain/billing/charge.ts';
import { adhesionCharge, monthlyCharge, tariffFor, tariffInEffect } from '../domain/billing/tariff.ts';
import { type AppContext, publish } from './context.ts';

/** O extrato de uma empresa: o que deve, o que ja pagou, quanto esta atrasada. */
export type BillingStatement = {
  readonly member: Member;
  readonly storeCount: number;
  readonly charges: readonly Charge[];
  readonly outstanding: Money;
  readonly overdueDays: number;
  /** O que a proxima mensalidade vai custar, pela tabela que vale hoje. */
  readonly nextMonthly: Money;
  readonly tariffVersion: string;
  readonly tariffFrozen: boolean;
};

export async function memberStatement(
  context: AppContext,
  memberId: MemberId,
): Promise<Result<BillingStatement, DomainError>> {
  const member = await context.repos.members.byId(memberId);
  if (member === undefined) {
    return err(notFoundError('MEMBER_NOT_FOUND', 'Empresa nao encontrada.', { memberId }));
  }

  const now = context.clock.now();
  const charges = await context.repos.charges.byMember(memberId);
  const stores = await context.repos.stores.byMember(memberId);
  const table = tariffFor(member, member.tariffVersion, context.policies.tariffs, now);
  const vigente = tariffInEffect(context.policies.tariffs, now);

  return ok({
    member,
    storeCount: stores.length,
    charges,
    outstanding: totalOutstanding(charges),
    overdueDays: memberOverdueDays(charges, now),
    nextMonthly: monthlyCharge(table, stores.length).total,
    tariffVersion: table.version,
    // Congelada de verdade e quando a tabela que ela usa NAO e a vigente. Dizer
    // "congelada" enquanto as duas coincidem seria prometer um desconto que
    // ainda nao existe — e a fundadora so descobriria na primeira alta.
    tariffFrozen: vigente !== undefined && vigente.version !== table.version,
  });
}

/**
 * Emite a adesao de uma empresa recem-credenciada.
 *
 * Idempotente por construcao: se ja existe adesao para esta empresa, devolve a
 * que existe. O credenciamento pode ser repetido depois de uma falha de
 * provisionamento, e cobrar duas vezes por isso seria o pior jeito possivel de
 * comecar uma relacao comercial.
 */
export async function chargeAdhesion(
  context: AppContext,
  member: Member,
): Promise<Result<Charge, DomainError>> {
  const existing = (await context.repos.charges.byMember(member.id)).find(
    (charge) => charge.kind === ChargeKind.ADHESION,
  );
  if (existing !== undefined) return ok(existing);

  const now = context.clock.now();
  const table = tariffFor(member, member.tariffVersion, context.policies.tariffs, now);

  const transition = issueAdhesion({
    id: asChargeId(context.ids.next('chg')),
    memberId: member.id,
    clusterId: member.clusterId,
    amount: adhesionCharge(table, member),
    tariffVersion: table.version,
    now,
    policy: context.policies.billing,
  });
  if (!transition.ok) return transition;

  await context.repos.charges.save(transition.value.state);
  await publish(context, transition.value.events);
  return ok(transition.value.state);
}

export type PaymentResult = {
  readonly charge: Charge;
  /** Preenchido quando a quitacao reativou uma empresa suspensa. */
  readonly reinstated: Member | null;
};

/**
 * Registra o pagamento de uma cobranca e, se isso zerou o atraso, reativa a
 * empresa na mesma operacao.
 *
 * Juntas de proposito: separar deixaria uma janela em que a empresa pagou e
 * continua suspensa, e essa janela sempre acaba durando o tempo de alguem
 * lembrar de rodar o segundo passo.
 */
export async function registerChargePayment(
  context: AppContext,
  chargeId: ChargeId,
): Promise<Result<PaymentResult, DomainError>> {
  const charge = await context.repos.charges.byId(chargeId);
  if (charge === undefined) {
    return err(notFoundError('CHARGE_NOT_FOUND', 'Cobranca nao encontrada.', { chargeId }));
  }

  const now = context.clock.now();
  const transition = payCharge({ charge, now });
  if (!transition.ok) return transition;

  await context.repos.charges.save(transition.value.state);
  await publish(context, transition.value.events);

  const member = await context.repos.members.byId(charge.memberId);
  if (member === undefined) return ok({ charge: transition.value.state, reinstated: null });

  const restantes = await context.repos.charges.byMember(member.id);
  if (isDelinquent(restantes, now, context.policies.billing)) {
    return ok({ charge: transition.value.state, reinstated: null });
  }

  const volta = reinstate(member, now);
  if (!volta.ok || volta.value.events.length === 0) {
    return ok({ charge: transition.value.state, reinstated: null });
  }

  await context.repos.members.save(volta.value.state);
  await publish(context, volta.value.events);
  return ok({ charge: transition.value.state, reinstated: volta.value.state });
}

// ---------------------------------------------------------------------------
// Varredura
// ---------------------------------------------------------------------------

export type BillingSweepResult = {
  readonly issued: number;
  readonly suspended: number;
  readonly cents: number;
};

/**
 * Emite as mensalidades vencidas e suspende quem passou do prazo.
 *
 * Roda por praca, como todo o resto: nao existe operacao que atravesse a
 * fronteira, inclusive faturamento.
 *
 * A ordem importa. Emitir ANTES de avaliar a inadimplencia significa que uma
 * competencia que venceu hoje ja conta neste mesmo passe — e nao no proximo,
 * dias depois, com a empresa operando de graca no intervalo.
 */
export async function runBillingSweep(
  context: AppContext,
  clusterId: ClusterId,
): Promise<BillingSweepResult> {
  const now = context.clock.now();
  const members = await context.repos.members.byCluster(clusterId);

  let issued = 0;
  let cents = 0;
  let suspended = 0;

  for (const member of members) {
    // Quem saiu nao e faturado. Sem isto a empresa desligada acumularia
    // mensalidade para sempre, e o varredor tentaria suspender quem ja saiu.
    // Quem esta SAINDO continua sendo: ainda usa a rede para encerrar, e a
    // cobranca em aberto e justamente uma das comportas da saida.
    if (member.status === MemberStatus.EXITED) continue;

    const charges = await context.repos.charges.byMember(member.id);
    const emitidas = charges
      .filter((charge) => charge.kind === ChargeKind.MONTHLY)
      .map((charge) => charge.periodStart);

    for (const periodStart of pendingBillingPeriods(member.joinedAt, emitidas, now)) {
      const emitida = await issueMonthlyFor(context, member, periodStart, now);
      if (emitida === null) continue;
      issued += 1;
      cents += emitida.amount.cents;
    }

    const atualizadas = await context.repos.charges.byMember(member.id);
    if (!isDelinquent(atualizadas, now, context.policies.billing)) continue;

    const transition = suspendForArrears(
      member,
      memberOverdueDays(atualizadas, now),
      now,
    );
    if (!transition.ok || transition.value.events.length === 0) continue;

    await context.repos.members.save(transition.value.state);
    await publish(context, transition.value.events);
    suspended += 1;
  }

  return { issued, suspended, cents };
}

async function issueMonthlyFor(
  context: AppContext,
  member: Member,
  periodStart: Instant,
  now: Instant,
): Promise<Charge | null> {
  // A tabela e resolvida na COMPETENCIA, nao em `now`: uma fatura atrasada de
  // marco tem de sair pelo preco de marco. Cobrar pela tabela de hoje seria
  // reajustar retroativamente quem a plataforma deixou de faturar em dia.
  const table = tariffFor(member, member.tariffVersion, context.policies.tariffs, periodStart);
  const stores = await context.repos.stores.byMember(member.id);

  const transition = issueMonthly({
    id: asChargeId(context.ids.next('chg')),
    memberId: member.id,
    clusterId: member.clusterId,
    breakdown: monthlyCharge(table, stores.length),
    periodStart,
    now,
    policy: context.policies.billing,
  });
  if (!transition.ok) return null;

  await context.repos.charges.save(transition.value.state);
  await publish(context, transition.value.events);
  return transition.value.state;
}
