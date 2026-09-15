/**
 * Credenciamento de novas lojas — endosso das fundadoras, decisao da plataforma.
 *
 * A rede e fechada e qualificada, e a qualificacao vem do ENDOSSO: uma fundadora
 * coloca a reputacao dela atras de uma candidata que ela conhece de praca. Mas o
 * endosso nao e voto — quem admite e a plataforma.
 *
 * A diferenca nao e burocratica, e de incentivo. Enquanto o credenciamento era
 * decidido por quorum, as fundadoras tinham nas maos o poder de barrar
 * concorrencia direta e chamar isso de criterio. Tirar a decisao delas remove o
 * conflito sem jogar fora o que elas sabem: continua sendo a palavra de quem
 * conhece a candidata que sustenta a qualidade da operacao.
 *
 * Duas consequencias de desenho:
 *
 * 1. NAO existe voto contrario. Uma fundadora que tem restricao simplesmente nao
 *    endossa — e a ausencia de endosso ja e o sinal. Modelar rejeicao devolveria
 *    o poder de veto pela porta dos fundos.
 *
 * 2. A plataforma PODE admitir abaixo do endosso recomendado, mas nao em
 *    silencio: precisa registrar a justificativa, e ela fica na candidatura.
 *    E o que impede o endosso de virar enfeite sem transformar em veto.
 */

import { type Result, err, ok } from '../shared/result.ts';
import {
  type DomainError,
  conflictError,
  forbiddenError,
  ruleViolation,
  validationError,
} from '../shared/errors.ts';
import { domainEvent } from '../shared/events.ts';
import { type Transition, transitioned } from '../shared/transition.ts';
import type { Instant } from '../shared/clock.ts';
import type { ClusterId, ApplicationId, StoreId, UserId } from '../shared/ids.ts';
import { TradeInStance } from '../vehicle/vehicle.ts';
import {
  type NetworkUser,
  type Store,
  type StoreProfile,
  canEndorseMembership,
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

/**
 * Uma fundadora coloca a reputacao atras da candidata. Nao ha contraparte
 * negativa: quem tem restricao nao endossa, e o silencio ja diz.
 */
export type Endorsement = {
  readonly founderStoreId: StoreId;
  readonly givenByUserId: UserId;
  readonly givenAt: Instant;
  /** Por que essa fundadora responde por essa candidata. */
  readonly note: string | null;
};

export type MembershipApplication = {
  readonly id: ApplicationId;
  /**
   * A praca em que a candidata quer entrar — herdada da padrinho. Governanca e
   * por cluster: fundadora de Curitiba nao vota em candidata de Londrina, e o
   * quorum de 3 e contado dentro de uma praca so.
   */
  readonly clusterId: ClusterId;
  readonly candidate: StoreProfile;
  /** Loja da rede que apresentou a candidata. Responde pela indicacao. */
  readonly sponsorStoreId: StoreId;
  readonly openedAt: Instant;
  readonly status: MembershipStatus;
  /** No maximo um endosso por fundadora; endossar de novo atualiza a nota. */
  readonly endorsements: readonly Endorsement[];
  readonly decidedAt: Instant | null;
  /** Quem decidiu, do lado da plataforma, e por que. */
  readonly decidedBy: string | null;
  readonly decisionNote: string | null;
  /**
   * Preenchida quando a plataforma admite com menos endossos que o recomendado.
   * Ficar registrada e o que mantem o endosso significando alguma coisa.
   */
  readonly endorsementOverride: string | null;
  /** Preenchido quando a aprovacao resulta na criacao efetiva da loja. */
  readonly resultingStoreId: StoreId | null;
};

export type GovernancePolicy = {
  /** Quantas lojas fundadoras existem. Fixo em 6 na constituicao da praca. */
  readonly founderCount: number;
  /**
   * Endossos que a plataforma espera ver antes de admitir. NAO e quorum: nao
   * aprova sozinho nem bloqueia. E a linha abaixo da qual admitir exige
   * justificativa escrita.
   */
  readonly recommendedEndorsements: number;
};

export const DEFAULT_GOVERNANCE_POLICY: GovernancePolicy = {
  founderCount: 6,
  recommendedEndorsements: 2,
};

export type EndorsementTally = {
  readonly endorsements: number;
  readonly recommended: number;
  readonly stillRecommended: number;
  readonly meetsRecommendation: boolean;
  /** Fundadoras que ainda podem endossar (a padrinho nao entra na conta). */
  readonly foundersYetToEndorse: number;
};

export function endorsementTally(
  application: MembershipApplication,
  policy: GovernancePolicy = DEFAULT_GOVERNANCE_POLICY,
): EndorsementTally {
  const endorsements = application.endorsements.length;
  // A padrinho nao endossa a propria indicacao, entao ela sai do denominador.
  const elegiveis = Math.max(0, policy.founderCount - 1);

  return {
    endorsements,
    recommended: policy.recommendedEndorsements,
    stillRecommended: Math.max(0, policy.recommendedEndorsements - endorsements),
    meetsRecommendation: endorsements >= policy.recommendedEndorsements,
    foundersYetToEndorse: Math.max(0, elegiveis - endorsements),
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
    clusterId: command.sponsor.clusterId,
    candidate: command.candidate,
    sponsorStoreId: command.sponsor.id,
    openedAt: command.now,
    status: MembershipStatus.PENDING,
    endorsements: [],
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    endorsementOverride: null,
    resultingStoreId: null,
  };

  return transitioned(application, [
    domainEvent('membership.application_opened', application.id, command.now, {
      clusterId: application.clusterId,
      candidateCnpj: application.candidate.cnpj,
      candidateTradeName: application.candidate.tradeName,
      sponsorStoreId: application.sponsorStoreId,
    }),
  ]);
}

export type EndorseCommand = {
  readonly application: MembershipApplication;
  readonly founderStore: Store;
  readonly user: NetworkUser;
  readonly note?: string | undefined;
  readonly now: Instant;
  readonly policy?: GovernancePolicy;
};

/**
 * Uma fundadora endossa a candidata. Endossar de novo atualiza a nota — a duvida
 * do credenciamento costuma se resolver em conversa, e obrigar a abrir nova
 * candidatura para corrigir uma nota criaria atrito onde o produto existe para
 * remove-lo.
 *
 * Endossar NAO decide nada: a candidatura continua PENDING ate a plataforma se
 * manifestar.
 */
export function endorse(command: EndorseCommand): Transition<MembershipApplication> {
  const policy = command.policy ?? DEFAULT_GOVERNANCE_POLICY;
  const { application, founderStore, user } = command;

  if (application.status !== MembershipStatus.PENDING) {
    return err(
      conflictError(
        'APPLICATION_ALREADY_DECIDED',
        `Esta candidatura ja foi ${translateStatus(application.status)} e nao aceita novos endossos.`,
        { applicationId: application.id, status: application.status },
      ),
    );
  }

  if (!canEndorseMembership(founderStore, user)) {
    return err(
      forbiddenError(
        'NOT_AN_ENDORSING_FOUNDER',
        'Somente o titular de uma loja fundadora ativa endossa credenciamento.',
        { storeId: founderStore.id, storeKind: founderStore.kind, role: user.role },
      ),
    );
  }

  // A padrinho nao endossa a propria indicacao: endosso de quem apresentou nao
  // acrescenta informacao nenhuma sobre a candidata.
  if (founderStore.id === application.sponsorStoreId) {
    return err(
      ruleViolation(
        'SPONSOR_CANNOT_ENDORSE',
        'A loja que apresentou a candidatura nao endossa — o endosso precisa vir de outra fundadora.',
        { applicationId: application.id, sponsorStoreId: application.sponsorStoreId },
      ),
    );
  }

  const note = command.note?.trim();
  if (note !== undefined && note.length > 500) {
    return err(validationError('NOTE_TOO_LONG', 'A nota do endosso excede 500 caracteres.'));
  }

  const endorsement: Endorsement = {
    founderStoreId: founderStore.id,
    givenByUserId: user.id,
    givenAt: command.now,
    note: note !== undefined && note.length > 0 ? note : null,
  };

  const previous = application.endorsements.find((e) => e.founderStoreId === founderStore.id);
  const endorsements = [
    ...application.endorsements.filter((e) => e.founderStoreId !== founderStore.id),
    endorsement,
  ];

  const updated: MembershipApplication = { ...application, endorsements };
  const contagem = endorsementTally(updated, policy);

  return transitioned(updated, [
    domainEvent('membership.endorsed', application.id, command.now, {
      clusterId: application.clusterId,
      founderStoreId: founderStore.id,
      updatedPreviousEndorsement: previous !== undefined,
      endorsements: contagem.endorsements,
      stillRecommended: contagem.stillRecommended,
    }),
  ]);
}

export type PlatformDecisionCommand = {
  readonly application: MembershipApplication;
  /** Quem decidiu, do lado da plataforma. Vai para a trilha de auditoria. */
  readonly operator: string;
  readonly note?: string | undefined;
  /** Obrigatoria quando os endossos estao abaixo do recomendado. */
  readonly endorsementOverride?: string | undefined;
  readonly now: Instant;
  readonly policy?: GovernancePolicy;
};

/** A plataforma admite a candidata. E a decisao — o endosso e insumo dela. */
export function admitCandidate(
  command: PlatformDecisionCommand,
): Transition<MembershipApplication> {
  const policy = command.policy ?? DEFAULT_GOVERNANCE_POLICY;
  const { application, now } = command;

  if (application.status !== MembershipStatus.PENDING) {
    return err(
      conflictError(
        'APPLICATION_ALREADY_DECIDED',
        `Esta candidatura ja foi ${translateStatus(application.status)}.`,
        { applicationId: application.id, status: application.status },
      ),
    );
  }

  const contagem = endorsementTally(application, policy);
  const override = command.endorsementOverride?.trim();

  // Admitir abaixo do recomendado e possivel, mas nao em silencio: sem
  // justificativa registrada, o endosso viraria enfeite.
  if (!contagem.meetsRecommendation && (override === undefined || override.length < 10)) {
    return err(
      ruleViolation(
        'ENDORSEMENT_BELOW_RECOMMENDED',
        `A candidatura tem ${contagem.endorsements} endosso(s) e o recomendado e ` +
          `${contagem.recommended}. Admitir assim exige justificativa registrada.`,
        {
          applicationId: application.id,
          endorsements: contagem.endorsements,
          recommended: contagem.recommended,
        },
      ),
    );
  }

  const admitted: MembershipApplication = {
    ...application,
    status: MembershipStatus.APPROVED,
    decidedAt: now,
    decidedBy: command.operator,
    decisionNote: command.note?.trim() ?? null,
    endorsementOverride: contagem.meetsRecommendation ? null : (override ?? null),
  };

  return transitioned(admitted, [
    domainEvent('membership.application_approved', application.id, now, {
      clusterId: application.clusterId,
      candidateCnpj: application.candidate.cnpj,
      candidateTradeName: application.candidate.tradeName,
      endorsements: contagem.endorsements,
      endorsedBy: application.endorsements.map((e) => e.founderStoreId),
      decidedBy: command.operator,
      belowRecommendation: !contagem.meetsRecommendation,
    }),
  ]);
}

/** A plataforma recusa. Nao ha recurso ao quorum: a decisao e dela. */
export function rejectCandidate(
  command: PlatformDecisionCommand,
): Transition<MembershipApplication> {
  const { application, now } = command;

  if (application.status !== MembershipStatus.PENDING) {
    return err(
      conflictError(
        'APPLICATION_ALREADY_DECIDED',
        `Esta candidatura ja foi ${translateStatus(application.status)}.`,
        { applicationId: application.id, status: application.status },
      ),
    );
  }

  const note = command.note?.trim();
  if (note === undefined || note.length < 10) {
    return err(
      validationError(
        'REJECTION_NOTE_REQUIRED',
        'Recusar exige motivo registrado: quem apresentou a candidata precisa saber o que dizer a ela.',
        { applicationId: application.id },
      ),
    );
  }

  const rejected: MembershipApplication = {
    ...application,
    status: MembershipStatus.REJECTED,
    decidedAt: now,
    decidedBy: command.operator,
    decisionNote: note,
    endorsementOverride: null,
  };

  return transitioned(rejected, [
    domainEvent('membership.application_rejected', application.id, now, {
      clusterId: application.clusterId,
      candidateCnpj: application.candidate.cnpj,
      candidateTradeName: application.candidate.tradeName,
      endorsements: application.endorsements.length,
      decidedBy: command.operator,
    }),
  ]);
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
        'So e possivel credenciar uma candidatura admitida pela plataforma.',
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
    clusterId: application.clusterId,
    profile: application.candidate,
    kind: 'MEMBER',
    status: 'ACTIVE',
    joinedAt: now,
    tradeInDefault: TradeInStance.CONSIDERS,
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
