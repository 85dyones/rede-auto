/**
 * Contexto de aplicacao: as dependencias que todo caso de uso recebe.
 *
 * Nada aqui e global. Relogio, gerador de ids, barramento e repositorios sao
 * injetados, e e por isso que o roteiro de demonstracao consegue simular tres
 * dias de operacao em milissegundos e que os testes de integracao rodam sem
 * infraestrutura nenhuma.
 */

import type { Clock, Instant } from '../domain/shared/clock.ts';
import type { IdGenerator } from '../domain/shared/ids.ts';
import { type EventBus, type DomainEvent } from '../domain/shared/events.ts';
import type { StoreId, UserId } from '../domain/shared/ids.ts';
import type { NetworkUser, Store } from '../domain/network/store.ts';
import type { Member } from '../domain/network/member.ts';
import type { NetworkPolicies } from '../config.ts';
import type { Repositories } from '../infra/persistence/repositories.ts';

/**
 * Quem esta executando a acao: a empresa, o patio dela e a pessoa dentro dele.
 *
 * O membro entra no ator, e nao e buscado onde precisa, porque quase toda
 * autorizacao passou a depender das duas camadas — `canTransact(store, member)`.
 * Deixar o membro de fora obrigaria cada servico a busca-lo, e a primeira
 * chamada que esquecesse deixaria uma empresa inadimplente operando.
 */
export type Actor = {
  readonly member: Member;
  readonly store: Store;
  readonly user: NetworkUser;
};

export type AppContext = {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly events: EventBus;
  readonly policies: NetworkPolicies;
  readonly repos: Repositories;
};

/**
 * Publica os eventos de uma transacao e registra a trilha de auditoria.
 *
 * A auditoria e derivada dos eventos de dominio, nao escrita a mao em cada
 * servico: assim nao existe transicao de estado que aconteca sem deixar
 * rastro. Numa rede em que lojas concorrentes dividem estoque, "quem fez o
 * que e quando" e requisito, nao conveniencia.
 */
export async function publish(
  context: AppContext,
  events: readonly DomainEvent[],
  actor: Actor | null = null,
): Promise<void> {
  const recordedAt = context.clock.now();
  for (const event of events) {
    await context.repos.audit.append({
      id: context.ids.next('aud'),
      event,
      actorStoreId: actor?.store.id ?? null,
      actorUserId: actor?.user.id ?? null,
      recordedAt,
    });
  }
  context.events.publishAll(events);
}

export function now(context: AppContext): Instant {
  return context.clock.now();
}

export type ActorRef = { readonly storeId: StoreId; readonly userId: UserId };
