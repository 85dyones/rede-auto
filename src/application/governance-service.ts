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
  type EndorsementTally,
  type MembershipApplication,
  admitApprovedStore,
  admitCandidate,
  endorse,
  endorsementTally,
  openApplication,
  rejectCandidate,
  withdrawApplication,
} from '../domain/network/membership.ts';
import { type Actor, type AppContext, publish } from './context.ts';
import { applicationNotFound } from './errors.ts';

export type ApplicationView = {
  readonly application: MembershipApplication;
  readonly tally: EndorsementTally;
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
    tally: endorsementTally(transition.value.state, context.policies.governance),
    admittedStore: null,
  });
}

export async function endorseApplication(
  context: AppContext,
  actor: Actor,
  applicationId: ApplicationId,
  note?: string,
): Promise<Result<ApplicationView, DomainError>> {
  const application = await context.repos.memberships.byId(applicationId);
  if (application === undefined) return err(applicationNotFound(applicationId));

  const transition = endorse({
    application,
    founderStore: actor.store,
    user: actor.user,
    ...(note === undefined ? {} : { note }),
    now: context.clock.now(),
    policy: context.policies.governance,
  });
  if (!transition.ok) return transition;

  const updated = transition.value.state;
  await context.repos.memberships.save(updated);
  await publish(context, transition.value.events, actor);

  // Endossar nao credencia ninguem: a candidatura segue PENDING ate a
  // plataforma decidir. E a diferenca entre endosso e voto.
  return ok({
    application: updated,
    tally: endorsementTally(updated, context.policies.governance),
    admittedStore: null,
  });
}

/**
 * A plataforma admite a candidata — e a admissao ja cria a loja.
 *
 * Nao ha passo manual entre decidir e a loja poder operar: seriam dois estados
 * para o mesmo fato, e o segundo so existiria para alguem esquecer dele.
 */
export async function admitApplication(
  context: AppContext,
  operator: string,
  applicationId: ApplicationId,
  options: { note?: string; endorsementOverride?: string } = {},
): Promise<Result<ApplicationView, DomainError>> {
  const application = await context.repos.memberships.byId(applicationId);
  if (application === undefined) return err(applicationNotFound(applicationId));

  const transition = admitCandidate({
    application,
    operator,
    ...(options.note === undefined ? {} : { note: options.note }),
    ...(options.endorsementOverride === undefined
      ? {}
      : { endorsementOverride: options.endorsementOverride }),
    now: context.clock.now(),
    policy: context.policies.governance,
  });
  if (!transition.ok) return transition;

  const decided = transition.value.state;
  await context.repos.memberships.save(decided);
  await publish(context, transition.value.events);

  const admitted = await admit(context, decided);

  return ok({
    application: admitted?.application ?? decided,
    tally: endorsementTally(decided, context.policies.governance),
    admittedStore: admitted?.store ?? null,
  });
}

/** A plataforma recusa. Exige motivo: quem indicou precisa saber o que dizer. */
export async function rejectApplication(
  context: AppContext,
  operator: string,
  applicationId: ApplicationId,
  note: string,
): Promise<Result<ApplicationView, DomainError>> {
  const application = await context.repos.memberships.byId(applicationId);
  if (application === undefined) return err(applicationNotFound(applicationId));

  const transition = rejectCandidate({
    application,
    operator,
    note,
    now: context.clock.now(),
    policy: context.policies.governance,
  });
  if (!transition.ok) return transition;

  const decided = transition.value.state;
  await context.repos.memberships.save(decided);
  await publish(context, transition.value.events);

  return ok({
    application: decided,
    tally: endorsementTally(decided, context.policies.governance),
    admittedStore: null,
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
    tally: endorsementTally(transition.value.state, context.policies.governance),
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
    tally: endorsementTally(application, context.policies.governance),
    admittedStore,
  });
}
