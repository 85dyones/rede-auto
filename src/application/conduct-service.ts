/**
 * Deteccao de quebra de protocolo.
 *
 * Este e o arquivo que transforma "quebrar o protocolo tres vezes suspende" de
 * frase em regra. Ele nao inventa medicao nova: percorre os recalls e os termos
 * de custodia que ja existem e pergunta, de cada um, se um prazo do protocolo
 * venceu. As quatro respostas possiveis estao em `BreachKind`.
 *
 * Todo prazo aqui e em HORAS UTEIS, pelo mesmo motivo do SLA de recall: cobrar
 * aceite de entrega as 22h de sabado seria cobrar por tempo que a loja nao
 * tinha como usar.
 *
 * A idempotencia nao e detalhe. O varredor roda a cada minuto sobre os mesmos
 * termos vencidos; sem o id deterministico de `breachIdFor`, um unico atraso
 * viraria sessenta quebras por hora e suspenderia a praca inteira antes do
 * almoco. Por isso toda gravacao passa por `recordOnce`.
 */

import type { DomainEvent } from '../domain/shared/events.ts';
import { domainEvent } from '../domain/shared/events.ts';
import type { Instant } from '../domain/shared/clock.ts';
import type { ClusterId, MemberId, StoreId } from '../domain/shared/ids.ts';
import { addBusinessHours, businessMinutesBetween } from '../domain/shared/business-hours.ts';
import {
  type Breach,
  type ConductRecord,
  BreachKind,
  breachIdFor,
  conductRecord,
  reopenAfterWindow,
  suspendForConduct,
} from '../domain/conduct/breach.ts';
import { RecallStatus } from '../domain/recall/recall.ts';
import { TransferStatus } from '../domain/custody/custody.ts';
import type { Store } from '../domain/network/store.ts';
import { type AppContext, publish } from './context.ts';

/**
 * Grava a quebra se ela ainda nao existir.
 *
 * Devolve `null` quando ja existia — e nao a quebra que estava la — para o
 * chamador nao contar de novo o que ja contou. `occurredAt` fica congelado na
 * primeira deteccao: se fosse atualizado a cada passe, a quebra nunca sairia da
 * janela movel e a suspensao viraria perpetua.
 */
async function recordOnce(
  context: AppContext,
  breach: Breach,
): Promise<Breach | null> {
  const existing = await context.repos.breaches.byId(breach.id);
  if (existing !== undefined) return null;

  await context.repos.breaches.save(breach);
  return breach;
}

function buildBreach(input: {
  kind: BreachKind;
  store: Store;
  evidenceId: string;
  deadline: Instant;
  now: Instant;
  calendar: Parameters<typeof businessMinutesBetween>[2];
}): Breach {
  return {
    id: breachIdFor(input.kind, input.evidenceId),
    clusterId: input.store.clusterId,
    storeId: input.store.id,
    memberId: input.store.memberId,
    kind: input.kind,
    occurredAt: input.now,
    evidenceId: input.evidenceId,
    overdueMinutes: businessMinutesBetween(input.deadline, input.now, input.calendar),
  };
}

export type ConductSweepResult = {
  readonly recorded: number;
  readonly suspended: number;
  readonly reopened: number;
};

/**
 * Detecta quebras, aplica a suspensao de quem atingiu o numero, e reabre quem a
 * janela movel aliviou.
 *
 * Por praca, como todo o resto da operacao.
 */
export async function runConductSweep(
  context: AppContext,
  clusterId: ClusterId,
): Promise<ConductSweepResult> {
  const now = context.clock.now();
  const policy = context.policies.conduct;
  const calendar = context.policies.recall.calendar;
  const events: DomainEvent[] = [];
  const novas: Breach[] = [];

  const loja = async (storeId: StoreId): Promise<Store | undefined> => {
    const store = await context.repos.stores.byId(storeId);
    return store !== undefined && store.clusterId === clusterId ? store : undefined;
  };

  // --- Recalls ------------------------------------------------------------
  for (const recall of await context.repos.recalls.allOpen()) {
    if (recall.status === RecallStatus.DUE && recall.breachedAt !== null) {
      // O SLA ja foi marcado por `flagBreachIfOverdue`. Aqui so se traduz o
      // fato em registro de conduta — a deteccao continua morando no dominio
      // do recall, que e quem sabe o que e o prazo.
      const store = await loja(recall.custodianStoreId);
      if (store === undefined) continue;

      const gravada = await recordOnce(
        context,
        buildBreach({
          kind: BreachKind.RECALL_SLA,
          store,
          evidenceId: recall.id,
          deadline: recall.dueAt ?? recall.breachedAt,
          now: recall.breachedAt,
          calendar,
        }),
      );
      if (gravada !== null) novas.push(gravada);
      continue;
    }

    if (recall.status === RecallStatus.READY_FOR_PICKUP && recall.readyForPickupAt !== null) {
      // O escape operacional parou o relogio do custodiante. Quem pediu o
      // recall e escolheu buscar agora tem prazo proprio — sem isso, o escape
      // viraria jeito de deixar o carro parado no patio alheio de graca.
      const limite = addBusinessHours(
        recall.readyForPickupAt,
        policy.pickupGraceBusinessHours,
        calendar,
      );
      if (now <= limite) continue;

      const store = await loja(recall.requestedByStoreId);
      if (store === undefined) continue;

      const gravada = await recordOnce(
        context,
        buildBreach({
          kind: BreachKind.PICKUP_NOT_COLLECTED,
          store,
          evidenceId: recall.id,
          deadline: limite,
          now,
          calendar,
        }),
      );
      if (gravada !== null) novas.push(gravada);
    }
  }

  // --- Termos de custodia -------------------------------------------------
  for (const transfer of await context.repos.transfers.allPending()) {
    if (transfer.status === TransferStatus.DROPPED_OFF && transfer.dropOff !== null) {
      // A coordenada ja foi conferida contra o patio de destino na declaracao
      // (`DROP_OFF_AWAY_FROM_YARD`). E isso que torna esta quebra atribuivel:
      // sem a conferencia, "declarei que deixei" contra "nao chegou" seria
      // palavra contra palavra, e ninguem poderia ser responsabilizado.
      const limite = addBusinessHours(
        transfer.dropOff.at,
        policy.acceptanceGraceBusinessHours,
        calendar,
      );
      if (now <= limite) continue;

      const store = await loja(transfer.toStoreId);
      if (store === undefined) continue;

      const gravada = await recordOnce(
        context,
        buildBreach({
          kind: BreachKind.DROPOFF_NOT_ACKNOWLEDGED,
          store,
          evidenceId: transfer.id,
          deadline: limite,
          now,
          calendar,
        }),
      );
      if (gravada !== null) novas.push(gravada);
      continue;
    }

    if (transfer.status === TransferStatus.OPEN) {
      const limite = addBusinessHours(
        transfer.openedAt,
        policy.transitGraceBusinessHours,
        calendar,
      );
      if (now <= limite) continue;

      // Origem, e nao destino: quem tirou o carro do patio responde por ele ate
      // o aceite, e foi quem deixou o termo em aberto sem entregar nem cancelar.
      const store = await loja(transfer.fromStoreId);
      if (store === undefined) continue;

      const gravada = await recordOnce(
        context,
        buildBreach({
          kind: BreachKind.TRANSFER_ABANDONED,
          store,
          evidenceId: transfer.id,
          deadline: limite,
          now,
          calendar,
        }),
      );
      if (gravada !== null) novas.push(gravada);
    }
  }

  for (const breach of novas) {
    events.push(
      domainEvent('conduct.breach_recorded', breach.storeId, breach.occurredAt, {
        clusterId: breach.clusterId,
        memberId: breach.memberId,
        kind: breach.kind,
        evidenceId: breach.evidenceId,
        overdueMinutes: breach.overdueMinutes,
      }),
    );
  }

  // --- Sancao e alivio ----------------------------------------------------
  //
  // Reavalia TODOS os patios da praca, e nao so os que quebraram agora: a
  // janela movel alivia sozinha com a passagem do tempo, e quem tem de reabrir
  // e justamente quem nao apareceu nesta varredura.
  let suspended = 0;
  let reopened = 0;

  for (const store of await context.repos.stores.byCluster(clusterId)) {
    const record = conductRecord(
      store.id,
      await context.repos.breaches.byStore(store.id),
      now,
      policy,
    );

    const sancao = suspendForConduct(store, record, now);
    if (sancao.ok && sancao.value.events.length > 0) {
      await context.repos.stores.save(sancao.value.state);
      events.push(...sancao.value.events);
      suspended += 1;
      continue;
    }

    const alivio = reopenAfterWindow(store, record, now);
    if (alivio.ok && alivio.value.events.length > 0) {
      await context.repos.stores.save(alivio.value.state);
      events.push(...alivio.value.events);
      reopened += 1;
    }
  }

  if (events.length > 0) await publish(context, events);
  return { recorded: novas.length, suspended, reopened };
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

export type ConductView = {
  readonly record: ConductRecord;
  /**
   * Quantas vezes este patio ja foi suspenso por conduta — contado da trilha de
   * auditoria, nao de um contador no agregado.
   *
   * E o numero que autoriza mocao de desligamento, e ele precisa ser do
   * historico: um campo `suspensionCount` na loja seria zerado por qualquer
   * reescrita e nao teria como ser conferido por quem vota.
   */
  readonly conductSuspensions: number;
};

export async function storeConduct(
  context: AppContext,
  storeId: StoreId,
): Promise<ConductView> {
  const now = context.clock.now();
  const breaches = await context.repos.breaches.byStore(storeId);
  const trilha = await context.repos.audit.byAggregate(storeId, 500);

  return {
    record: conductRecord(storeId, breaches, now, context.policies.conduct),
    conductSuspensions: trilha.filter(
      (entry) => entry.event.type === 'conduct.store_suspended',
    ).length,
  };
}

/** O registro de conduta de uma empresa: o pior patio dela e o que conta. */
export async function memberConduct(
  context: AppContext,
  memberId: MemberId,
): Promise<readonly ConductView[]> {
  const stores = await context.repos.stores.byMember(memberId);
  const views: ConductView[] = [];
  for (const store of stores) views.push(await storeConduct(context, store.id));
  return views;
}
