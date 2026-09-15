/**
 * Casos de uso da saida voluntaria.
 *
 * O valor deste arquivo esta em `exitPendencies`: e ele que transforma "nada em
 * aberto" de intencao em contagem. Cada numero sai de um repositorio, no
 * instante da consulta — nenhum deles e campo guardado no membro, pela mesma
 * razao de sempre: numero que descreve o mundo se conta, nunca se declara.
 *
 * A saida se conclui sozinha no varredor. Nao ha botao final de "sair agora"
 * que alguem precise lembrar de apertar: no passe em que a ultima pendencia
 * fecha, a empresa sai. Exigir um gesto humano deixaria a empresa pronta e
 * presa, esperando alguem reparar — e o unico jeito de descobrir seria a
 * proxima fatura.
 */

import { type Result, err, ok } from '../domain/shared/result.ts';
import type { DomainError } from '../domain/shared/errors.ts';
import { notFoundError } from '../domain/shared/errors.ts';
import type { ClusterId, MemberId } from '../domain/shared/ids.ts';
import { type Member, MemberStatus } from '../domain/network/member.ts';
import {
  type ExitPendencies,
  type ExitReadiness,
  completeExit,
  exitReadiness,
  giveExitNotice,
  withdrawExitNotice,
} from '../domain/network/exit.ts';
import { domainEvent } from '../domain/shared/events.ts';
import { isActive as isLockActive } from '../domain/lock/commercial-lock.ts';
import { isTerminal } from '../domain/deal/deal.ts';
import type { Vehicle } from '../domain/vehicle/vehicle.ts';
import { totalOutstanding } from '../domain/billing/charge.ts';
import { withdrawApplication } from '../domain/network/membership.ts';
import { type Actor, type AppContext, publish } from './context.ts';

/**
 * Levanta tudo o que ainda prende a empresa na rede.
 *
 * As duas primeiras contagens sao as que importam, e sao simetricas de
 * proposito: carro de terceiro no patio dela E carro dela em patio alheio. As
 * duas deixam um veiculo sem contraparte depois da saida — nao ha mais recall a
 * pedir nem prazo a cobrar — e por isso nenhuma das duas pode ficar para tras.
 */
export async function exitPendencies(
  context: AppContext,
  member: Member,
): Promise<ExitPendencies> {
  const now = context.clock.now();
  const stores = await context.repos.stores.byMember(member.id);
  const storeIds = new Set(stores.map((store) => store.id));

  const proprios: Vehicle[] = [];
  const emPoderDela: Vehicle[] = [];

  for (const store of stores) {
    proprios.push(...(await context.repos.vehicles.byOwner(store.id)));
    const custodiados = await context.repos.vehicles.search({
      clusterId: member.clusterId,
      custodianStoreId: store.id,
      limit: 500,
    });
    emPoderDela.push(...custodiados.items);
  }

  const holdingOthersVehicles = emPoderDela.filter(
    (vehicle) => !storeIds.has(vehicle.ownerStoreId),
  ).length;
  const vehiclesHeldByOthers = proprios.filter(
    (vehicle) =>
      vehicle.physical.custodianStoreId !== null &&
      !storeIds.has(vehicle.physical.custodianStoreId),
  ).length;

  // Trava viva em qualquer direcao: dela sobre carro alheio, ou de terceiro
  // sobre carro dela. As duas viram promessa sem dono depois da saida.
  const envolvidos = new Map<string, Vehicle>();
  for (const vehicle of [...proprios, ...emPoderDela]) envolvidos.set(vehicle.id, vehicle);

  let openLocks = 0;
  let openDeals = 0;

  for (const vehicle of envolvidos.values()) {
    if (vehicle.activeLockId !== null) {
      const lock = await context.repos.locks.byId(vehicle.activeLockId);
      if (lock !== undefined && isLockActive(lock, now)) openLocks += 1;
    }
    for (const deal of await context.repos.deals.byVehicle(vehicle.id)) {
      if (isTerminal(deal)) continue;
      if (storeIds.has(deal.ownerStoreId) || storeIds.has(deal.sellingStoreId)) openDeals += 1;
    }
  }

  const charges = await context.repos.charges.byMember(member.id);

  return {
    holdingOthersVehicles,
    vehiclesHeldByOthers,
    openLocks,
    openDeals,
    outstandingChargeCents: totalOutstanding(charges).cents,
  };
}

export type ExitView = {
  readonly member: Member;
  readonly readiness: ExitReadiness;
};

async function exitView(context: AppContext, member: Member): Promise<ExitView> {
  return {
    member,
    readiness: exitReadiness(
      member,
      await exitPendencies(context, member),
      context.clock.now(),
      context.policies.exit,
    ),
  };
}

/** O checklist de saida da propria empresa, tenha ela avisado ou nao. */
export async function exitStatus(
  context: AppContext,
  memberId: MemberId,
): Promise<Result<ExitView, DomainError>> {
  const member = await context.repos.members.byId(memberId);
  if (member === undefined) {
    return err(notFoundError('MEMBER_NOT_FOUND', 'Empresa nao encontrada.', { memberId }));
  }
  return ok(await exitView(context, member));
}

/**
 * A empresa avisa que vai sair.
 *
 * So o titular: sair e decisao de contrato, nao operacao de patio.
 */
export async function requestExit(
  context: AppContext,
  actor: Actor,
): Promise<Result<ExitView, DomainError>> {
  const transition = giveExitNotice(actor.member, context.clock.now());
  if (!transition.ok) return transition;

  await context.repos.members.save(transition.value.state);
  await publish(context, transition.value.events, actor);
  return ok(await exitView(context, transition.value.state));
}

export async function cancelExit(
  context: AppContext,
  actor: Actor,
): Promise<Result<ExitView, DomainError>> {
  const transition = withdrawExitNotice(actor.member, context.clock.now());
  if (!transition.ok) return transition;

  await context.repos.members.save(transition.value.state);
  await publish(context, transition.value.events, actor);
  return ok(await exitView(context, transition.value.state));
}

/**
 * Conclui as saidas cujas duas comportas ja abriram.
 *
 * Roda no varredor porque a ultima pendencia costuma fechar por um ato de
 * outra loja — o aceite de uma devolucao, a liquidacao de uma negociacao. Quem
 * esta saindo nao tem como saber a hora exata, e nao deveria precisar ficar
 * tentando.
 */
export async function sweepCompletedExits(
  context: AppContext,
  clusterId: ClusterId,
): Promise<number> {
  const now = context.clock.now();
  let concluidas = 0;

  for (const member of await context.repos.members.byCluster(clusterId)) {
    if (member.status !== MemberStatus.LEAVING) continue;

    const stores = await context.repos.stores.byMember(member.id);
    const readiness = exitReadiness(
      member,
      await exitPendencies(context, member),
      now,
      context.policies.exit,
    );

    const result = completeExit(member, stores, readiness);
    if (!result.ok) continue;

    await context.repos.members.save(result.value.member);
    for (const store of result.value.stores) await context.repos.stores.save(store);

    // As candidaturas que ela apadrinhou saem junto. A candidata perdeu quem
    // respondia por ela, e deixa-la pendurada ate caducar seria silencio de 30
    // dias sobre um fato que ja se sabe.
    const orfas: string[] = [];
    for (const application of await context.repos.memberships.pending(clusterId)) {
      if (application.sponsorMemberId !== member.id) continue;
      const retirada = withdrawApplication({
        application,
        requestedByMemberId: member.id,
        now,
      });
      if (!retirada.ok) continue;
      await context.repos.memberships.save(retirada.value.state);
      orfas.push(application.id);
    }

    await publish(context, [
      domainEvent('network.member_exited', member.id, now, {
        clusterId: member.clusterId,
        legalName: member.legalName,
        storeIds: result.value.stores.map((store) => store.id),
        noticeGivenAt: member.exitNoticeAt,
        // As candidaturas retiradas vao no evento porque quem precisa saber e a
        // praca: alguem pode querer reapresentar a candidata.
        withdrawnApplicationIds: orfas,
      }),
    ]);

    concluidas += 1;
  }

  return concluidas;
}
