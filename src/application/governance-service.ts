/**
 * Casos de uso de credenciamento.
 *
 * A aprovacao pelo quorum e a criacao efetiva da loja acontecem no mesmo caso
 * de uso, mas por funcoes separadas do dominio: aprovar e ato de governanca,
 * credenciar e ato de provisionamento. Se a criacao da loja falhar (CNPJ
 * duplicado, por exemplo), a decisao dos fundadores permanece registrada e o
 * provisionamento pode ser repetido sem nova votacao.
 */

import { type Result, err, ok } from '../domain/shared/result.ts';
import type { DomainError } from '../domain/shared/errors.ts';
import { conflictError } from '../domain/shared/errors.ts';
import { asApplicationId, asStoreId, type ApplicationId } from '../domain/shared/ids.ts';
import { domainEvent } from '../domain/shared/events.ts';
import { type Store, parseStoreProfile } from '../domain/network/store.ts';
import {
  type MembershipApplication,
  type Tally,
  type VoteDecision,
  MembershipStatus,
  admitApprovedStore,
  castVote,
  openApplication,
  tally,
  withdrawApplication,
} from '../domain/network/membership.ts';
import { type Actor, type AppContext, publish } from './context.ts';
import { applicationNotFound } from './errors.ts';

export type ApplicationView = {
  readonly application: MembershipApplication;
  readonly tally: Tally;
  readonly admittedStore: Store | null;
};

export async function submitApplication(
  context: AppContext,
  actor: Actor,
  candidateProfile: unknown,
): Promise<Result<ApplicationView, DomainError>> {
  const profile = parseStoreProfile(candidateProfile);
  if (!profile.ok) return profile;

  const existing = await context.repos.stores.byCnpj(profile.value.cnpj);
  if (existing !== undefined) {
    return err(
      conflictError('STORE_ALREADY_IN_NETWORK', 'Esta loja ja participa da rede.', {
        cnpj: profile.value.cnpj,
        storeId: existing.id,
      }),
    );
  }

  const transition = openApplication({
    id: asApplicationId(context.ids.next('app')),
    candidate: profile.value,
    sponsor: actor.store,
    now: context.clock.now(),
  });
  if (!transition.ok) return transition;

  await context.repos.memberships.save(transition.value.state);
  await publish(context, transition.value.events, actor);
  return ok({
    application: transition.value.state,
    tally: tally(transition.value.state, context.policies.governance),
    admittedStore: null,
  });
}

export async function voteOnApplication(
  context: AppContext,
  actor: Actor,
  applicationId: ApplicationId,
  decision: VoteDecision,
  note?: string,
): Promise<Result<ApplicationView, DomainError>> {
  const application = await context.repos.memberships.byId(applicationId);
  if (application === undefined) return err(applicationNotFound(applicationId));

  const transition = castVote({
    application,
    founderStore: actor.store,
    user: actor.user,
    decision,
    note,
    now: context.clock.now(),
    policy: context.policies.governance,
  });
  if (!transition.ok) return transition;

  const decided = transition.value.state;
  await context.repos.memberships.save(decided);
  await publish(context, transition.value.events, actor);

  // O terceiro aval ja credencia: nao ha razao para um passo manual entre a
  // decisao dos fundadores e a loja poder operar.
  const admitted =
    decided.status === MembershipStatus.APPROVED ? await admit(context, decided) : null;

  return ok({
    application: admitted?.application ?? decided,
    tally: tally(decided, context.policies.governance),
    admittedStore: admitted?.store ?? null,
  });
}

async function admit(
  context: AppContext,
  application: MembershipApplication,
): Promise<{ store: Store; application: MembershipApplication } | null> {
  const result = admitApprovedStore(
    application,
    asStoreId(context.ids.next('str')),
    context.clock.now(),
  );
  if (!result.ok) return null;

  await context.repos.stores.save(result.value.store);
  await context.repos.memberships.save(result.value.application);
  await publish(context, [
    domainEvent('network.store_admitted', result.value.store.id, context.clock.now(), {
      clusterId: result.value.store.clusterId,
      applicationId: application.id,
      tradeName: result.value.store.profile.tradeName,
      sponsorStoreId: result.value.store.sponsorStoreId,
    }),
  ]);

  return result.value;
}

export async function retireApplication(
  context: AppContext,
  actor: Actor,
  applicationId: ApplicationId,
): Promise<Result<ApplicationView, DomainError>> {
  const application = await context.repos.memberships.byId(applicationId);
  if (application === undefined) return err(applicationNotFound(applicationId));

  const transition = withdrawApplication({
    application,
    requestedByStoreId: actor.store.id,
    now: context.clock.now(),
  });
  if (!transition.ok) return transition;

  await context.repos.memberships.save(transition.value.state);
  await publish(context, transition.value.events, actor);
  return ok({
    application: transition.value.state,
    tally: tally(transition.value.state, context.policies.governance),
    admittedStore: null,
  });
}

export async function viewApplication(
  context: AppContext,
  applicationId: ApplicationId,
): Promise<Result<ApplicationView, DomainError>> {
  const application = await context.repos.memberships.byId(applicationId);
  if (application === undefined) return err(applicationNotFound(applicationId));

  const admittedStore =
    application.resultingStoreId === null
      ? null
      : ((await context.repos.stores.byId(application.resultingStoreId)) ?? null);

  return ok({
    application,
    tally: tally(application, context.policies.governance),
    admittedStore,
  });
}
