/**
 * Credenciamento de novas lojas — o "modelo dos 6 fundadores".
 *
 * Regra constitutiva da rede: qualquer loja nova precisa do aval de pelo menos
 * 3 dos 6 fundadores. E o mecanismo que mantem a rede fechada e qualificada —
 * um membro so entra se metade do conselho fundador colocar a reputacao nisso.
 *
 * Duas consequencias de desenho valem registro:
 *
 * 1. A candidatura e REPROVADA assim que 4 fundadores votam contra, porque com
 *    6 votos disponiveis torna-se aritmeticamente impossivel chegar a 3 avais.
 *    Nao faz sentido deixar o candidato esperando um desfecho ja decidido.
 *
 * 2. Um fundador pode TROCAR o proprio voto enquanto a decisao nao saiu. Isso
 *    e deliberado: as duvidas do credenciamento costumam se resolver em conversa
 *    depois do primeiro voto, e obrigar a abrir nova candidatura para corrigir
 *    um voto criaria atrito onde o produto existe para remove-lo.
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
import type { ApplicationId, StoreId, UserId } from '../shared/ids.ts';
import {
  type NetworkUser,
  type Store,
  type StoreProfile,
  canVoteOnMembership,
  canTransact,
} from './store.ts';

export const MembershipStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  /** Retirada pelo padrinho antes da decisao. */
  WITHDRAWN: 'WITHDRAWN',
} as const;
export type MembershipStatus = (typeof MembershipStatus)[keyof typeof MembershipStatus];

export const VoteDecision = {
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
} as const;
export type VoteDecision = (typeof VoteDecision)[keyof typeof VoteDecision];

export type MembershipVote = {
  readonly founderStoreId: StoreId;
  readonly castByUserId: UserId;
  readonly decision: VoteDecision;
  readonly castAt: Instant;
  readonly note: string | null;
};

export type MembershipApplication = {
  readonly id: ApplicationId;
  readonly candidate: StoreProfile;
  /** Loja da rede que apresentou a candidata. Responde pela indicacao. */
  readonly sponsorStoreId: StoreId;
  readonly openedAt: Instant;
  readonly status: MembershipStatus;
  /** No maximo um voto por fundador; o ultimo voto substitui o anterior. */
  readonly votes: readonly MembershipVote[];
  readonly decidedAt: Instant | null;
  /** Preenchido quando a aprovacao resulta na criacao efetiva da loja. */
  readonly resultingStoreId: StoreId | null;
};

export type GovernancePolicy = {
  /** Quantas lojas fundadoras existem. Fixo em 6 na constituicao da rede. */
  readonly founderCount: number;
  /** Avais necessarios para aprovar. Fixo em 3. */
  readonly requiredApprovals: number;
};

export const DEFAULT_GOVERNANCE_POLICY: GovernancePolicy = {
  founderCount: 6,
  requiredApprovals: 3,
};

/**
 * Votos contrarios que tornam a aprovacao impossivel.
 * Com 6 fundadores e 3 avais necessarios: 6 - 3 + 1 = 4.
 */
export function rejectionThreshold(policy: GovernancePolicy): number {
  return policy.founderCount - policy.requiredApprovals + 1;
}

export type Tally = {
  readonly approvals: number;
  readonly rejections: number;
  readonly pendingFounders: number;
  readonly approvalsStillNeeded: number;
  readonly outcome: MembershipStatus;
};

export function tally(
  application: MembershipApplication,
  policy: GovernancePolicy = DEFAULT_GOVERNANCE_POLICY,
): Tally {
  const approvals = application.votes.filter((v) => v.decision === VoteDecision.APPROVE).length;
  const rejections = application.votes.filter((v) => v.decision === VoteDecision.REJECT).length;
  const pendingFounders = Math.max(0, policy.founderCount - application.votes.length);

  const outcome: MembershipStatus =
    approvals >= policy.requiredApprovals
      ? MembershipStatus.APPROVED
      : rejections >= rejectionThreshold(policy)
        ? MembershipStatus.REJECTED
        : MembershipStatus.PENDING;

  return {
    approvals,
    rejections,
    pendingFounders,
    approvalsStillNeeded: Math.max(0, policy.requiredApprovals - approvals),
    outcome,
  };
}

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

export type OpenApplicationCommand = {
  readonly id: ApplicationId;
  readonly candidate: StoreProfile;
  readonly sponsor: Store;
  readonly now: Instant;
};

export function openApplication(
  command: OpenApplicationCommand,
): Transition<MembershipApplication> {
  if (!canTransact(command.sponsor)) {
    return err(
      forbiddenError(
        'SPONSOR_NOT_ACTIVE',
        'Apenas uma loja ativa da rede pode apresentar uma candidata.',
        { sponsorStoreId: command.sponsor.id, status: command.sponsor.status },
      ),
    );
  }

  const application: MembershipApplication = {
    id: command.id,
    candidate: command.candidate,
    sponsorStoreId: command.sponsor.id,
    openedAt: command.now,
    status: MembershipStatus.PENDING,
    votes: [],
    decidedAt: null,
    resultingStoreId: null,
  };

  return transitioned(application, [
    domainEvent('membership.application_opened', application.id, command.now, {
      candidateCnpj: application.candidate.cnpj,
      candidateTradeName: application.candidate.tradeName,
      sponsorStoreId: application.sponsorStoreId,
    }),
  ]);
}

export type CastVoteCommand = {
  readonly application: MembershipApplication;
  readonly founderStore: Store;
  readonly user: NetworkUser;
  readonly decision: VoteDecision;
  readonly note?: string | undefined;
  readonly now: Instant;
  readonly policy?: GovernancePolicy;
};

export function castVote(command: CastVoteCommand): Transition<MembershipApplication> {
  const policy = command.policy ?? DEFAULT_GOVERNANCE_POLICY;
  const { application, founderStore, user } = command;

  if (application.status !== MembershipStatus.PENDING) {
    return err(
      conflictError(
        'APPLICATION_ALREADY_DECIDED',
        `Esta candidatura ja foi ${translateStatus(application.status)} e nao aceita novos votos.`,
        { applicationId: application.id, status: application.status },
      ),
    );
  }

  if (!canVoteOnMembership(founderStore, user)) {
    return err(
      forbiddenError(
        'NOT_A_VOTING_FOUNDER',
        'Somente o titular de uma loja fundadora ativa pode avalizar credenciamento.',
        { storeId: founderStore.id, storeKind: founderStore.kind, role: user.role },
      ),
    );
  }

  // O padrinho nao vota na propria indicacao: o aval precisa ser de terceiros.
  if (founderStore.id === application.sponsorStoreId) {
    return err(
      ruleViolation(
        'SPONSOR_CANNOT_VOTE',
        'A loja que apresentou a candidatura nao vota nela — o aval precisa vir de outros fundadores.',
        { applicationId: application.id, sponsorStoreId: application.sponsorStoreId },
      ),
    );
  }

  // Uma loja fundadora ja credenciada nao pode se candidatar de novo.
  const note = command.note?.trim();
  if (note !== undefined && note.length > 500) {
    return err(validationError('NOTE_TOO_LONG', 'A justificativa do voto excede 500 caracteres.'));
  }

  const vote: MembershipVote = {
    founderStoreId: founderStore.id,
    castByUserId: user.id,
    decision: command.decision,
    castAt: command.now,
    note: note !== undefined && note.length > 0 ? note : null,
  };

  const previous = application.votes.find((v) => v.founderStoreId === founderStore.id);
  const votes = [
    ...application.votes.filter((v) => v.founderStoreId !== founderStore.id),
    vote,
  ];

  const withVote: MembershipApplication = { ...application, votes };
  const result = tally(withVote, policy);

  const events: DomainEvent[] = [
    domainEvent('membership.vote_cast', application.id, command.now, {
      founderStoreId: founderStore.id,
      decision: command.decision,
      replacedPreviousVote: previous !== undefined,
      approvals: result.approvals,
      rejections: result.rejections,
      approvalsStillNeeded: result.approvalsStillNeeded,
    }),
  ];

  if (result.outcome === MembershipStatus.PENDING) {
    return transitioned(withVote, events);
  }

  const decided: MembershipApplication = {
    ...withVote,
    status: result.outcome,
    decidedAt: command.now,
  };

  events.push(
    domainEvent(
      result.outcome === MembershipStatus.APPROVED
        ? 'membership.application_approved'
        : 'membership.application_rejected',
      application.id,
      command.now,
      {
        candidateCnpj: application.candidate.cnpj,
        candidateTradeName: application.candidate.tradeName,
        approvals: result.approvals,
        rejections: result.rejections,
        approvedBy: withVote.votes
          .filter((v) => v.decision === VoteDecision.APPROVE)
          .map((v) => v.founderStoreId),
      },
    ),
  );

  return transitioned(decided, events);
}

export type WithdrawApplicationCommand = {
  readonly application: MembershipApplication;
  readonly requestedByStoreId: StoreId;
  readonly now: Instant;
};

export function withdrawApplication(
  command: WithdrawApplicationCommand,
): Transition<MembershipApplication> {
  const { application } = command;

  if (application.status !== MembershipStatus.PENDING) {
    return err(
      conflictError(
        'APPLICATION_ALREADY_DECIDED',
        `Esta candidatura ja foi ${translateStatus(application.status)}.`,
        { applicationId: application.id, status: application.status },
      ),
    );
  }
  if (command.requestedByStoreId !== application.sponsorStoreId) {
    return err(
      forbiddenError(
        'NOT_THE_SPONSOR',
        'Somente a loja que apresentou a candidatura pode retira-la.',
        { applicationId: application.id },
      ),
    );
  }

  return transitioned(
    { ...application, status: MembershipStatus.WITHDRAWN, decidedAt: command.now },
    [domainEvent('membership.application_withdrawn', application.id, command.now, {})],
  );
}

/**
 * Efetiva a loja aprovada. Separado de `castVote` de proposito: aprovar e um
 * ato de governanca, criar a loja e um ato de provisionamento (id, usuarios,
 * chaves de acesso), e os dois falham por motivos diferentes.
 */
export function admitApprovedStore(
  application: MembershipApplication,
  newStoreId: StoreId,
  now: Instant,
): Result<{ store: Store; application: MembershipApplication }, DomainError> {
  if (application.status !== MembershipStatus.APPROVED) {
    return err(
      conflictError(
        'APPLICATION_NOT_APPROVED',
        'So e possivel credenciar uma candidatura aprovada pelos fundadores.',
        { applicationId: application.id, status: application.status },
      ),
    );
  }
  if (application.resultingStoreId !== null) {
    return err(
      conflictError('STORE_ALREADY_ADMITTED', 'Esta candidatura ja gerou uma loja na rede.', {
        applicationId: application.id,
        storeId: application.resultingStoreId,
      }),
    );
  }

  const store: Store = {
    id: newStoreId,
    profile: application.candidate,
    kind: 'MEMBER',
    status: 'ACTIVE',
    joinedAt: now,
    sponsorStoreId: application.sponsorStoreId,
  };

  return ok({ store, application: { ...application, resultingStoreId: newStoreId } });
}

function translateStatus(status: MembershipStatus): string {
  switch (status) {
    case MembershipStatus.APPROVED:
      return 'aprovada';
    case MembershipStatus.REJECTED:
      return 'reprovada';
    case MembershipStatus.WITHDRAWN:
      return 'retirada';
    case MembershipStatus.PENDING:
      return 'aberta';
  }
}
