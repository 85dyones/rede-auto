/**
 * Casos de uso de credenciamento.
 *
 * O credenciamento pelos endossos e a criacao efetiva da loja acontecem no
 * mesmo caso de uso, mas por funcoes separadas do dominio: credenciar e ato de
 * governanca, provisionar e ato de infraestrutura. Se a criacao da loja falhar
 * (CNPJ duplicado, por exemplo), os endossos permanecem registrados e o
 * provisionamento pode ser repetido sem novo aval.
 *
 * E aqui que o numero de fundadoras vira fato: toda apuracao passa por
 * `founderRoll`, que pergunta ao repositorio. O dominio nao tem — e nao deveria
 * ter — um `founderCount` para consultar.
 */

import { type Result, err, ok } from '../domain/shared/result.ts';
import type { DomainError } from '../domain/shared/errors.ts';
import { conflictError } from '../domain/shared/errors.ts';
import {
  asApplicationId,
  asStoreId,
  type ApplicationId,
  type ClusterId,
} from '../domain/shared/ids.ts';
import { domainEvent } from '../domain/shared/events.ts';
import { type Store, parseStoreProfile } from '../domain/network/store.ts';
import {
  MembershipStatus,
  type EndorsementTally,
  type MembershipApplication,
  admitApprovedStore,
  endorse,
  endorsementTally,
  openApplication,
  withdrawApplication,
} from '../domain/network/membership.ts';
import { type Actor, type AppContext, publish } from './context.ts';
import { applicationNotFound } from './errors.ts';

/**
 * As fundadoras que a praca tem de fato, no instante da consulta. Uma linha, e
 * nao uma constante, porque a janela de fundacao deixa esse numero variavel por
 * construcao: fecha com dez, ou com sete, conforme quem entrou a tempo.
 */
const founderRoll = (context: AppContext, clusterId: ClusterId): Promise<Store[]> =>
  context.repos.stores.founders(clusterId);

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

  const application = transition.value.state;
  return ok({
    application,
    tally: endorsementTally(
      application,
      await founderRoll(context, application.clusterId),
      context.policies.governance,
    ),
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

  const decided = transition.value.state;
  await context.repos.memberships.save(decided);
  await publish(context, transition.value.events, actor);

  // O endosso que fecha a conta ja credencia: nao ha passo manual entre a
  // decisao dos membros e a loja poder operar.
  const admitted =
    decided.status === MembershipStatus.APPROVED ? await admit(context, decided) : null;

  return ok({
    application: admitted?.application ?? decided,
    // Apurado DEPOIS de admitir: se a candidata entrou como fundadora, ela ja
    // conta no rol e o numero na tela e o da praca de agora, nao o de antes.
    tally: endorsementTally(
      decided,
      await founderRoll(context, decided.clusterId),
      context.policies.governance,
    ),
    admittedStore: admitted?.store ?? null,
  });
}

async function admit(
  context: AppContext,
  application: MembershipApplication,
): Promise<{ store: Store; application: MembershipApplication } | null> {
  // A praca decide se a loja nasce fundadora ou membro: e ela que sabe quando a
  // janela de fundacao fecha. Sem cluster nao ha como credenciar.
  const cluster = await context.repos.clusters.byId(application.clusterId);
  if (cluster === undefined) return null;

  const result = admitApprovedStore(
    application,
    asStoreId(context.ids.next('str')),
    cluster,
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
      // `kind` sozinho: gravar tambem "entrou na janela" seria o mesmo fato
      // duas vezes, e a copia so serve para divergir do original.
      kind: result.value.store.kind,
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

  const withdrawn = transition.value.state;
  return ok({
    application: withdrawn,
    tally: endorsementTally(
      withdrawn,
      await founderRoll(context, withdrawn.clusterId),
      context.policies.governance,
    ),
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
    tally: endorsementTally(
      application,
      await founderRoll(context, application.clusterId),
      context.policies.governance,
    ),
    admittedStore,
  });
}
