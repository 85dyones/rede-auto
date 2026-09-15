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
import { conflictError, forbiddenError } from '../domain/shared/errors.ts';
import {
  asApplicationId,
  asMemberId,
  asStoreId,
  type ApplicationId,
  type ClusterId,
} from '../domain/shared/ids.ts';
import { domainEvent } from '../domain/shared/events.ts';
import { type Store, UserRole, parseStoreProfile } from '../domain/network/store.ts';
import { type Member, cnpjRootOf } from '../domain/network/member.ts';
import {
  MembershipStatus,
  type EndorsementTally,
  type MembershipApplication,
  admitApprovedMember,
  endorse,
  openBranch,
  endorsementTally,
  openApplication,
  withdrawApplication,
} from '../domain/network/membership.ts';
import { type Actor, type AppContext, publish } from './context.ts';
import { applicationNotFound } from './errors.ts';

/**
 * As empresas fundadoras que a praca tem de fato, no instante da consulta. Uma
 * linha, e nao uma constante, porque a janela de fundacao deixa esse numero
 * variavel por construcao: fecha com dez, ou com sete, conforme quem entrou a
 * tempo.
 */
const founderRoll = (context: AppContext, clusterId: ClusterId): Promise<Member[]> =>
  context.repos.members.founders(clusterId);

export type ApplicationView = {
  readonly application: MembershipApplication;
  readonly tally: EndorsementTally;
  readonly admittedMember: Member | null;
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

  // A raiz tambem barra: a empresa ja esta na rede, e o que ela quer e abrir
  // mais um patio. Sem esta checagem, uma filial entraria por candidatura como
  // se fosse empresa nova — ganhando um segundo endosso para o mesmo grupo e
  // uma segunda adesao para pagar. As duas coisas erradas.
  const sameCompany = await context.repos.members.byCnpjRoot(cnpjRootOf(profile.value.cnpj));
  if (sameCompany !== undefined) {
    return err(
      conflictError(
        'COMPANY_ALREADY_IN_NETWORK',
        'Esta empresa ja participa da rede. Um patio novo dela se abre em ' +
          'POST /api/v1/lojas, sem nova candidatura.',
        { cnpjRoot: sameCompany.cnpjRoot, memberId: sameCompany.id },
      ),
    );
  }

  const transition = openApplication({
    id: asApplicationId(context.ids.next('app')),
    candidate: profile.value,
    sponsorStore: actor.store,
    sponsor: actor.member,
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
    admittedMember: null,
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
    founder: actor.member,
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
    admittedMember: admitted?.member ?? null,
    admittedStore: admitted?.store ?? null,
  });
}

type Admission = { member: Member; store: Store; application: MembershipApplication };

async function admit(
  context: AppContext,
  application: MembershipApplication,
): Promise<Admission | null> {
  // A praca decide se a empresa nasce fundadora ou membro: e ela que sabe
  // quando a janela de fundacao fecha. Sem cluster nao ha como credenciar.
  const cluster = await context.repos.clusters.byId(application.clusterId);
  if (cluster === undefined) return null;

  const result = admitApprovedMember(
    application,
    asMemberId(context.ids.next('mbr')),
    asStoreId(context.ids.next('str')),
    cluster,
    context.clock.now(),
  );
  if (!result.ok) return null;

  // Empresa primeiro: a loja aponta para ela, e uma loja gravada antes do
  // membro seria, por um instante, uma loja orfa — que `resolveActor` recusa.
  await context.repos.members.save(result.value.member);
  await context.repos.stores.save(result.value.store);
  await context.repos.memberships.save(result.value.application);
  await publish(context, [
    domainEvent('network.member_admitted', result.value.member.id, context.clock.now(), {
      clusterId: result.value.member.clusterId,
      applicationId: application.id,
      legalName: result.value.member.legalName,
      firstStoreId: result.value.store.id,
      sponsorMemberId: result.value.member.sponsorMemberId,
      // `kind` sozinho: gravar tambem "entrou na janela" seria o mesmo fato
      // duas vezes, e a copia so serve para divergir do original.
      kind: result.value.member.kind,
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
    requestedByMemberId: actor.member.id,
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
    admittedMember: null,
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
  const admittedMember =
    admittedStore === null
      ? null
      : ((await context.repos.members.byId(admittedStore.memberId)) ?? null);

  return ok({
    application,
    tally: endorsementTally(
      application,
      await founderRoll(context, application.clusterId),
      context.policies.governance,
    ),
    admittedMember,
    admittedStore,
  });
}

/**
 * Abre mais um patio da empresa do ator. E a operacao que a linha de R$ 159
 * cobra, e o unico jeito de uma empresa ja credenciada crescer na rede.
 *
 * Nao passa por endosso: as fundadoras ja responderam pela EMPRESA. O que se
 * guarda aqui e a identidade — raiz de CNPJ igual — porque sem isso "patio
 * adicional" viraria a porta dos fundos para trazer uma empresa inteira sem
 * endosso nenhum, pelo preco de uma filial.
 */
export async function openStoreBranch(
  context: AppContext,
  actor: Actor,
  storeProfile: unknown,
): Promise<Result<{ store: Store; storeCount: number }, DomainError>> {
  // Autorizacao antes de validacao, de proposito: apontar a um vendedor quais
  // campos do formulario estao errados, num formulario que ele nao pode
  // enviar, e ruido — e conta mais do que ele precisava saber.
  if (actor.user.role !== UserRole.PRINCIPAL) {
    return err(
      forbiddenError(
        'NOT_A_PRINCIPAL',
        'Somente o titular da empresa abre um patio novo — ele muda a mensalidade.',
        { role: actor.user.role },
      ),
    );
  }

  const profile = parseStoreProfile(storeProfile);
  if (!profile.ok) return profile;

  const existing = await context.repos.stores.byCnpj(profile.value.cnpj);
  if (existing !== undefined) {
    return err(
      conflictError('STORE_ALREADY_IN_NETWORK', 'Este CNPJ ja e uma loja da rede.', {
        cnpj: profile.value.cnpj,
        storeId: existing.id,
      }),
    );
  }

  const branch = openBranch({
    member: actor.member,
    profile: profile.value,
    newStoreId: asStoreId(context.ids.next('str')),
    now: context.clock.now(),
  });
  if (!branch.ok) return branch;

  await context.repos.stores.save(branch.value);

  const stores = await context.repos.stores.byMember(actor.member.id);
  await publish(
    context,
    [
      domainEvent('network.branch_opened', branch.value.id, context.clock.now(), {
        clusterId: branch.value.clusterId,
        memberId: actor.member.id,
        tradeName: branch.value.profile.tradeName,
        city: branch.value.profile.city,
        // A contagem vai no evento porque e ela que a fatura usa. O leitor do
        // evento nao deveria precisar consultar o repositorio para saber quanto
        // esta linha custou.
        storesAfter: stores.length,
      }),
    ],
    actor,
  );

  return ok({ store: branch.value, storeCount: stores.length });
}
