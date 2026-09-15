/**
 * Credenciamento — quem decide quem entra sao os membros.
 *
 * A rede e fechada e qualificada, e a qualificacao vem do ENDOSSO: uma
 * fundadora coloca a reputacao dela atras de uma candidata que conhece de
 * praca. Tres endossos credenciam. A plataforma so opera — ela nao vota, nao
 * veta e nao admite.
 *
 * Tres consequencias de desenho:
 *
 * 1. NAO existe endosso contrario. Quem tem restricao simplesmente nao endossa.
 *    Modelar rejeicao daria a cada fundadora um veto individual sobre
 *    concorrencia direta, que e exatamente o que nao se quer.
 *
 * 2. Como nao ha recusa, existe PRAZO: a candidatura caduca se nao juntar os
 *    endossos na janela. Sem isso, "pendente para sempre" viraria uma recusa
 *    que ninguem precisa assinar — e a candidata nunca saberia o que aconteceu.
 *
 * 3. O terceiro endosso ja credencia. Nao ha passo intermediario entre a
 *    decisao e a loja poder operar: seriam dois estados para o mesmo fato, e o
 *    segundo so existiria para alguem esquecer dele.
 *
 * 4. QUANTAS fundadoras existem nao e politica, e fato: elas sao contadas no
 *    repositorio. O numero e flexivel por decisao de produto — quem entrar na
 *    janela de fundacao, leva — e um `founderCount: 10` declarado em constante
 *    mentiria sobre a praca no dia em que a janela fechasse com oito.
 *
 * O limite conhecido deste desenho: endossos numa praca de 60 km nao sao
 * independentes — as fundadoras se conhecem, compram nos mesmos leiloes. Tres
 * endossos medem reputacao no mercado, nao saude financeira. O contrapeso nao
 * esta aqui, esta na exposicao graduada de quem acaba de entrar e no registro
 * de conduta entre lojas.
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
import { type Transition, transitioned, unchanged } from '../shared/transition.ts';
import { type Instant, DAY } from '../shared/clock.ts';
import type { ClusterId, ApplicationId, MemberId, StoreId, UserId } from '../shared/ids.ts';
import { TradeInStance } from '../vehicle/vehicle.ts';
import {
  type NetworkUser,
  type Store,
  type StoreProfile,
  canEndorseMembership,
  canTransact,
} from './store.ts';
import {
  type Member,
  MemberKind,
  cnpjRootOf,
  isFoundingMemberOf,
  memberFromFirstStore,
  memberInGoodStanding,
} from './member.ts';
import { type Cluster, requireSameCluster, withinFoundingWindow } from '../cluster/cluster.ts';

export const MembershipStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  /** Retirada pelo padrinho antes da decisao. */
  WITHDRAWN: 'WITHDRAWN',
  /** Venceu o prazo sem juntar os endossos. Nao e recusa: e silencio com data. */
  LAPSED: 'LAPSED',
} as const;
export type MembershipStatus = (typeof MembershipStatus)[keyof typeof MembershipStatus];

/**
 * Uma fundadora coloca a reputacao atras da candidata. Nao ha contraparte
 * negativa: quem tem restricao nao endossa, e o silencio ja diz.
 */
export type Endorsement = {
  /**
   * A EMPRESA que endossou — e a unidade de contagem. Se fosse o patio, um
   * grupo com tres lojas credenciaria sozinho, e "tres endossos" pararia de
   * significar tres empresas respondendo por uma quarta.
   */
  readonly founderMemberId: MemberId;
  /** De qual patio o titular assinou. Nao conta; serve para a auditoria. */
  readonly givenByStoreId: StoreId;
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
  /**
   * A ficha da candidata: uma so, da empresa **e** do primeiro patio. Uma
   * empresa entra na rede com exatamente um patio; os seguintes sao operacao
   * posterior. Pedir duas fichas na entrada seria pedir a mesma coisa duas
   * vezes e abrir a porta para elas divergirem.
   */
  readonly candidate: StoreProfile;
  /** Empresa da rede que apresentou a candidata. Responde pela indicacao. */
  readonly sponsorMemberId: MemberId;
  readonly openedAt: Instant;
  readonly status: MembershipStatus;
  /** No maximo um endosso por fundadora; endossar de novo atualiza a nota. */
  readonly endorsements: readonly Endorsement[];
  readonly decidedAt: Instant | null;
  /** Preenchido quando a aprovacao resulta na criacao efetiva da loja. */
  readonly resultingStoreId: StoreId | null;
};

/**
 * O que a praca decidiu sobre credenciamento. Note o que NAO esta aqui: o
 * numero de fundadoras. Ele foi tirado de proposito — uma praca pode abrir com
 * dez fundadoras ou com seis, conforme quem entrou na janela de fundacao, e um
 * numero declarado em politica acabaria mentindo sobre o mundo na primeira vez
 * que a realidade divergisse. Fundadora se conta no repositorio.
 */
export type GovernancePolicy = {
  /**
   * Endossos que credenciam. E decisorio: o terceiro endosso ja admite, sem
   * passo intermediario. Quem decide quem entra sao os membros — a plataforma
   * so opera.
   *
   * Fixo, e nao proporcional ao tamanho da praca. Proporcional pareceria mais
   * justo e seria pior: numa praca de seis fundadoras, "metade" seriam tres, e
   * numa de dez, cinco — o mesmo aval valeria coisas diferentes conforme quantas
   * lojas fecharam a janela de fundacao, que e um acidente de calendario. Tres
   * lojas respondendo por uma quarta e a unidade de confianca da rede; ela nao
   * encolhe porque a praca e pequena.
   */
  readonly requiredEndorsements: number;
  /**
   * Dias que a candidatura fica de pe sem atingir o numero. Vencido o prazo,
   * ela caduca.
   *
   * Existe porque nao ha endosso contrario: sem prazo, uma candidatura que
   * ninguem quer endossar ficaria pendente para sempre, e "pendente para
   * sempre" e uma recusa que ninguem precisa assinar.
   */
  readonly applicationWindowDays: number;
};

export const DEFAULT_GOVERNANCE_POLICY: GovernancePolicy = {
  requiredEndorsements: 3,
  applicationWindowDays: 30,
};

export type EndorsementTally = {
  readonly endorsements: number;
  readonly required: number;
  readonly stillNeeded: number;
  readonly credentialed: boolean;
  /** Fundadoras que ainda podem endossar: existem, estao ativas e nao endossaram. */
  readonly foundersYetToEndorse: number;
  /**
   * Ainda da para chegar aos endossos necessarios?
   *
   * So existe porque o numero de fundadoras e flexivel. Numa praca que fechou a
   * janela com quatro fundadoras e uma delas apadrinhou a candidata, sobram
   * tres para dar tres endossos: possivel, mas por unanimidade. Com uma
   * fundadora a menos, a candidatura ja nasce aritmeticamente morta — e sem este
   * campo o unico sinal disso seria a caducidade, trinta dias depois, sem que
   * ninguem soubesse que nunca houve chance. Melhor dizer na hora.
   */
  readonly reachable: boolean;
};

/**
 * Apura uma candidatura contra as fundadoras que a praca tem de fato.
 *
 * `activeFounders` e obrigatorio e vem do repositorio — nao ha valor padrao de
 * proposito. Um default aqui seria um numero inventado exibido como se fosse
 * apurado, e e exatamente esse o erro que a janela de fundacao torna possivel.
 */
export function endorsementTally(
  application: MembershipApplication,
  activeFounders: readonly Member[],
  policy: GovernancePolicy = DEFAULT_GOVERNANCE_POLICY,
): EndorsementTally {
  const endorsements = application.endorsements.length;
  const stillNeeded = Math.max(0, policy.requiredEndorsements - endorsements);
  const jaEndossaram = new Set(application.endorsements.map((e) => e.founderMemberId));

  // O filtro espelha `canEndorseMembership` de proposito, menos o patio e o
  // papel do usuario: se a apuracao usasse criterio proprio, contaria como
  // disponivel uma fundadora que `endorse` vai recusar. Empresa inadimplente
  // nao endossa; de outra praca, tampouco; e a padrinho nao endossa a propria
  // indicacao.
  const podemAinda = activeFounders.filter(
    (founder) =>
      isFoundingMemberOf(founder, application.clusterId) &&
      memberInGoodStanding(founder) &&
      founder.id !== application.sponsorMemberId &&
      !jaEndossaram.has(founder.id),
  ).length;

  return {
    endorsements,
    required: policy.requiredEndorsements,
    stillNeeded,
    credentialed: stillNeeded === 0,
    foundersYetToEndorse: podemAinda,
    reachable: stillNeeded <= podemAinda,
  };
}

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

export type OpenApplicationCommand = {
  readonly id: ApplicationId;
  readonly candidate: StoreProfile;
  /** O patio de onde a indicacao partiu. Quem responde por ela e a empresa. */
  readonly sponsorStore: Store;
  readonly sponsor: Member;
  readonly now: Instant;
};

export function openApplication(
  command: OpenApplicationCommand,
): Transition<MembershipApplication> {
  if (!canTransact(command.sponsorStore, command.sponsor)) {
    return err(
      forbiddenError(
        'SPONSOR_NOT_ACTIVE',
        'Apenas uma empresa em dia, por um patio aberto, pode apresentar uma candidata.',
        {
          sponsorMemberId: command.sponsor.id,
          memberStatus: command.sponsor.status,
          sponsorStoreId: command.sponsorStore.id,
          storeStatus: command.sponsorStore.status,
        },
      ),
    );
  }

  const application: MembershipApplication = {
    id: command.id,
    clusterId: command.sponsor.clusterId,
    candidate: command.candidate,
    sponsorMemberId: command.sponsor.id,
    openedAt: command.now,
    status: MembershipStatus.PENDING,
    endorsements: [],
    decidedAt: null,
    resultingStoreId: null,
  };

  return transitioned(application, [
    domainEvent('membership.application_opened', application.id, command.now, {
      clusterId: application.clusterId,
      candidateCnpj: application.candidate.cnpj,
      candidateTradeName: application.candidate.tradeName,
      sponsorMemberId: application.sponsorMemberId,
    }),
  ]);
}

export type EndorseCommand = {
  readonly application: MembershipApplication;
  /** A empresa fundadora que endossa. E ela que conta. */
  readonly founder: Member;
  /** O patio de onde o titular assinou. Registrado, nao contado. */
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
 * "De novo" e por EMPRESA, nao por patio: o titular da filial que endossa
 * depois do titular da matriz esta atualizando a nota da mesma empresa, nao
 * somando um segundo aval.
 */
export function endorse(command: EndorseCommand): Transition<MembershipApplication> {
  const policy = command.policy ?? DEFAULT_GOVERNANCE_POLICY;
  const { application, founder, founderStore, user } = command;

  if (application.status !== MembershipStatus.PENDING) {
    return err(
      conflictError(
        'APPLICATION_ALREADY_DECIDED',
        `Esta candidatura ja foi ${translateStatus(application.status)} e nao aceita novos endossos.`,
        { applicationId: application.id, status: application.status },
      ),
    );
  }

  if (!canEndorseMembership(founderStore, founder, user, application.clusterId)) {
    return err(
      forbiddenError(
        'NOT_AN_ENDORSING_FOUNDER',
        'Somente o titular de uma empresa fundadora em dia, por um patio aberto, ' +
          'endossa credenciamento.',
        { memberId: founder.id, memberKind: founder.kind, storeId: founderStore.id, role: user.role },
      ),
    );
  }

  // A padrinho nao endossa a propria indicacao: endosso de quem apresentou nao
  // acrescenta informacao nenhuma sobre a candidata. Comparado por EMPRESA — a
  // filial da padrinho tambem nao endossa.
  if (founder.id === application.sponsorMemberId) {
    return err(
      ruleViolation(
        'SPONSOR_CANNOT_ENDORSE',
        'A empresa que apresentou a candidatura nao endossa — o endosso precisa vir de outra fundadora.',
        { applicationId: application.id, sponsorMemberId: application.sponsorMemberId },
      ),
    );
  }

  const note = command.note?.trim();
  if (note !== undefined && note.length > 500) {
    return err(validationError('NOTE_TOO_LONG', 'A nota do endosso excede 500 caracteres.'));
  }

  const endorsement: Endorsement = {
    founderMemberId: founder.id,
    givenByStoreId: founderStore.id,
    givenByUserId: user.id,
    givenAt: command.now,
    note: note !== undefined && note.length > 0 ? note : null,
  };

  // Substitui por EMPRESA, nao por patio: sem isso um grupo com tres lojas
  // credenciaria uma candidata sozinho, assinando de cada patio.
  const previous = application.endorsements.find((e) => e.founderMemberId === founder.id);
  const endorsements = [
    ...application.endorsements.filter((e) => e.founderMemberId !== founder.id),
    endorsement,
  ];

  const updated: MembershipApplication = { ...application, endorsements };

  // Contagem local, de proposito: decidir se credencia depende so de quantos
  // endossos existem contra quantos a politica exige. Quantas fundadoras a
  // praca tem nao entra nesta conta — e um fato do repositorio, e o dominio
  // puro nao o tem em maos nem precisa dele para decidir.
  const total = endorsements.length;
  const stillNeeded = Math.max(0, policy.requiredEndorsements - total);

  const events: DomainEvent[] = [
    domainEvent('membership.endorsed', application.id, command.now, {
      clusterId: application.clusterId,
      founderMemberId: founder.id,
      givenByStoreId: founderStore.id,
      updatedPreviousEndorsement: previous !== undefined,
      endorsements: total,
      stillNeeded,
    }),
  ];

  if (stillNeeded > 0) return transitioned(updated, events);

  // O endosso que fecha a conta ja credencia. Um passo intermediario entre a
  // decisao e a loja operar seriam dois estados para o mesmo fato.
  const decided: MembershipApplication = {
    ...updated,
    status: MembershipStatus.APPROVED,
    decidedAt: command.now,
  };

  events.push(
    domainEvent('membership.application_approved', application.id, command.now, {
      clusterId: application.clusterId,
      candidateCnpj: application.candidate.cnpj,
      candidateTradeName: application.candidate.tradeName,
      endorsements: total,
      endorsedBy: endorsements.map((e) => e.founderMemberId),
    }),
  );

  return transitioned(decided, events);
}

export type LapseApplicationCommand = {
  readonly application: MembershipApplication;
  readonly now: Instant;
  readonly policy?: GovernancePolicy;
};

/**
 * A candidatura caduca por prazo.
 *
 * E o unico desfecho negativo que existe, e e de proposito: sem endosso
 * contrario, ninguem recusa candidata nenhuma. O que acontece e o silencio — e
 * o prazo transforma o silencio em resposta, que e o minimo que se deve a quem
 * se candidatou.
 */
export function lapseApplication(
  command: LapseApplicationCommand,
): Transition<MembershipApplication> {
  const policy = command.policy ?? DEFAULT_GOVERNANCE_POLICY;
  const { application, now } = command;

  if (application.status !== MembershipStatus.PENDING) return unchanged(application);

  const prazo = application.openedAt + policy.applicationWindowDays * DAY;
  if (now < prazo) return unchanged(application);

  const lapsed: MembershipApplication = {
    ...application,
    status: MembershipStatus.LAPSED,
    decidedAt: now,
  };

  return transitioned(lapsed, [
    domainEvent('membership.application_lapsed', application.id, now, {
      clusterId: application.clusterId,
      candidateTradeName: application.candidate.tradeName,
      sponsorMemberId: application.sponsorMemberId,
      endorsements: application.endorsements.length,
      required: policy.requiredEndorsements,
    }),
  ]);
}

export type WithdrawApplicationCommand = {
  readonly application: MembershipApplication;
  readonly requestedByMemberId: MemberId;
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
  if (command.requestedByMemberId !== application.sponsorMemberId) {
    return err(
      forbiddenError(
        'NOT_THE_SPONSOR',
        'Somente a empresa que apresentou a candidatura pode retira-la.',
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
 * Efetiva a candidata: cria a EMPRESA e o primeiro patio dela, juntos.
 *
 * Separado do endosso de proposito: credenciar e ato de governanca, provisionar
 * e ato de infraestrutura (ids, usuarios, chaves), e os dois falham por motivos
 * diferentes. Se este passo falhar, os endossos continuam valendo.
 *
 * Empresa e loja nascem na mesma funcao porque nao existe uma sem a outra: uma
 * empresa credenciada sem patio nao opera e nao paga a linha de R$ 159 de
 * ninguem, e um patio sem empresa nao tem contrato. Devolver as duas de uma vez
 * e o que impede o estado intermediario de existir.
 *
 * O `cluster` e parametro obrigatorio, e nao um id: e ele quem decide se a
 * empresa nasce FUNDADORA ou MEMBRO, porque so ele sabe quando a janela de
 * fundacao fecha. Exigi-lo aqui faz o compilador apontar toda chamada que
 * precisaria ser revista — o mesmo remedio ja usado em `dealDto(deal, viewer)`
 * e em `loadVehicle(actor)`.
 */
export function admitApprovedMember(
  application: MembershipApplication,
  newMemberId: MemberId,
  newStoreId: StoreId,
  cluster: Cluster,
  now: Instant,
): Result<
  { member: Member; store: Store; application: MembershipApplication },
  DomainError
> {
  if (application.status !== MembershipStatus.APPROVED) {
    return err(
      conflictError(
        'APPLICATION_NOT_APPROVED',
        'So e possivel credenciar uma candidatura que juntou os endossos.',
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

  const mesmaPraca = requireSameCluster(application, { clusterId: cluster.id }, 'A candidatura');
  if (!mesmaPraca.ok) return mesmaPraca;

  // Quem entrar na janela de fundacao, leva. Nao ha campo dizendo por que esta
  // empresa e fundadora: `joinedAt` contra `foundingWindowEndsAt` ja responde, e
  // um segundo registro do mesmo fato so existiria para divergir do primeiro.
  const kind = withinFoundingWindow(cluster, now) ? MemberKind.FOUNDER : MemberKind.MEMBER;

  const member = memberFromFirstStore(
    newMemberId,
    application.clusterId,
    application.candidate,
    kind,
    application.sponsorMemberId,
    now,
  );

  const store: Store = {
    id: newStoreId,
    memberId: member.id,
    clusterId: application.clusterId,
    profile: application.candidate,
    status: 'ACTIVE',
    joinedAt: now,
    tradeInDefault: TradeInStance.CONSIDERS,
  };

  return ok({ member, store, application: { ...application, resultingStoreId: newStoreId } });
}

// ---------------------------------------------------------------------------
// Patio adicional
// ---------------------------------------------------------------------------

export type OpenBranchCommand = {
  readonly member: Member;
  readonly profile: StoreProfile;
  readonly newStoreId: StoreId;
  readonly now: Instant;
};

/**
 * Abre mais um patio de uma empresa ja credenciada. E a operacao que a linha de
 * R$ 159 cobra.
 *
 * Nao passa por endosso, e isso e deliberado: as fundadoras ja responderam pela
 * EMPRESA. Exigir tres endossos para a filial de quem ja esta dentro seria
 * pedir que avalizassem de novo o que ja avalizaram, e na pratica so
 * emperraria o crescimento de quem a rede quer que cresca.
 *
 * O que a funcao guarda e a identidade: a raiz do CNPJ tem de bater. Sem isso,
 * "patio adicional" viraria a porta dos fundos para credenciar uma empresa
 * inteira sem passar por endosso nenhum — pelo preco de uma filial.
 */
export function openBranch(
  command: OpenBranchCommand,
): Result<Store, DomainError> {
  const { member, profile } = command;

  if (!memberInGoodStanding(member)) {
    return err(
      forbiddenError(
        'MEMBER_NOT_IN_GOOD_STANDING',
        'Empresa suspensa ou desligada nao abre patio novo.',
        { memberId: member.id, status: member.status },
      ),
    );
  }

  if (cnpjRootOf(profile.cnpj) !== member.cnpjRoot) {
    return err(
      ruleViolation(
        'BRANCH_CNPJ_MISMATCH',
        'O CNPJ deste patio nao pertence a esta empresa: a raiz precisa ser a mesma. ' +
          'Empresa diferente entra por candidatura, com endossos.',
        {
          memberId: member.id,
          expectedRoot: member.cnpjRoot,
          receivedRoot: cnpjRootOf(profile.cnpj),
        },
      ),
    );
  }

  return ok({
    id: command.newStoreId,
    memberId: member.id,
    clusterId: member.clusterId,
    profile,
    status: 'ACTIVE',
    joinedAt: command.now,
    tradeInDefault: TradeInStance.CONSIDERS,
  });
}

function translateStatus(status: MembershipStatus): string {
  switch (status) {
    case MembershipStatus.APPROVED:
      return 'aprovada';
    case MembershipStatus.REJECTED:
      return 'reprovada';
    case MembershipStatus.WITHDRAWN:
      return 'retirada';
    case MembershipStatus.LAPSED:
      return 'caducada';
    case MembershipStatus.PENDING:
      return 'aberta';
  }
}
