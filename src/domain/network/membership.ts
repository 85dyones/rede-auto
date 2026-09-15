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
import type { ClusterId, ApplicationId, StoreId, UserId } from '../shared/ids.ts';
import { TradeInStance } from '../vehicle/vehicle.ts';
import {
  type NetworkUser,
  type Store,
  type StoreProfile,
  StoreKind,
  canEndorseMembership,
  canTransact,
  isFounderOf,
} from './store.ts';
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
  activeFounders: readonly Store[],
  policy: GovernancePolicy = DEFAULT_GOVERNANCE_POLICY,
): EndorsementTally {
  const endorsements = application.endorsements.length;
  const stillNeeded = Math.max(0, policy.requiredEndorsements - endorsements);
  const jaEndossaram = new Set(application.endorsements.map((e) => e.founderStoreId));

  // O filtro espelha `canEndorseMembership` de proposito, menos o papel do
  // usuario: se a apuracao usasse um criterio proprio, ela contaria como
  // disponivel uma fundadora que `endorse` vai recusar. Fundadora suspensa nao
  // endossa; de outra praca, tampouco; e a padrinho nao endossa a propria
  // indicacao.
  const podemAinda = activeFounders.filter(
    (founder) =>
      isFounderOf(founder, application.clusterId) &&
      canTransact(founder) &&
      founder.id !== application.sponsorStoreId &&
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

  // Contagem local, de proposito: decidir se credencia depende so de quantos
  // endossos existem contra quantos a politica exige. Quantas fundadoras a
  // praca tem nao entra nesta conta — e um fato do repositorio, e o dominio
  // puro nao o tem em maos nem precisa dele para decidir.
  const total = endorsements.length;
  const stillNeeded = Math.max(0, policy.requiredEndorsements - total);

  const events: DomainEvent[] = [
    domainEvent('membership.endorsed', application.id, command.now, {
      clusterId: application.clusterId,
      founderStoreId: founderStore.id,
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
      endorsedBy: endorsements.map((e) => e.founderStoreId),
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
      sponsorStoreId: application.sponsorStoreId,
      endorsements: application.endorsements.length,
      required: policy.requiredEndorsements,
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
 * Efetiva a loja aprovada. Separado do endosso de proposito: credenciar e um
 * ato de governanca, criar a loja e um ato de provisionamento (id, usuarios,
 * chaves de acesso), e os dois falham por motivos diferentes.
 *
 * O `cluster` e parametro obrigatorio, e nao um id: e ele quem decide se a
 * loja nasce FUNDADORA ou MEMBRO, porque so ele sabe quando a janela de
 * fundacao fecha. Exigi-lo aqui faz o compilador apontar toda chamada que
 * precisaria ser revista — o mesmo remedio ja usado em `dealDto(deal, viewer)`
 * e em `loadVehicle(actor)`.
 */
export function admitApprovedStore(
  application: MembershipApplication,
  newStoreId: StoreId,
  cluster: Cluster,
  now: Instant,
): Result<{ store: Store; application: MembershipApplication }, DomainError> {
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
  // loja e fundadora: `joinedAt` contra `foundingWindowEndsAt` ja responde, e um
  // segundo registro do mesmo fato so existiria para divergir do primeiro.
  const fundadora = withinFoundingWindow(cluster, now);

  const store: Store = {
    id: newStoreId,
    clusterId: application.clusterId,
    profile: application.candidate,
    kind: fundadora ? StoreKind.FOUNDER : StoreKind.MEMBER,
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
    case MembershipStatus.LAPSED:
      return 'caducada';
    case MembershipStatus.PENDING:
      return 'aberta';
  }
}
