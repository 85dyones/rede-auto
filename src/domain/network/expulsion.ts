/**
 * Desligamento: a outra metade de "quem decide quem entra ou sai sao os membros".
 *
 * Entrar e sair sao assimetricos, e a assimetria e o desenho inteiro.
 *
 * ENTRAR e DISCRICIONARIO. A fundadora endossa porque conhece a candidata, e
 * nao precisa provar nada — por isso nao existe endosso contrario: dar a cada
 * fundadora um veto individual sobre concorrencia direta seria o abuso obvio.
 *
 * SAIR e PROBATORIO. Uma mocao de desligamento so pode ser aberta contra quem
 * JA TEM o registro medido: reincidencia em quebra de protocolo. Sem essa
 * exigencia, o desligamento viraria o veto que a admissao recusou — com a
 * agravante de servir para remover quem esta vendendo bem. A opiniao decide
 * quem entra; o registro decide quem pode ser posto para fora.
 *
 * Duas coisas seguem o formato da admissao, e pelos mesmos motivos:
 *
 *  - nao ha voto CONTRA. O silencio ja e contra, entao registrar "sou contra"
 *    nao acrescentaria informacao — e tornaria visivel quem defendeu quem, que
 *    e como se constroi retaliacao entre concorrentes;
 *  - ha PRAZO. Mocao que nao junta apoio caduca, e o desfecho por inercia e
 *    "fica". Tem de ser: se "sai" fosse o default do silencio, bastaria abrir
 *    mocoes e esperar.
 *
 * O quorum, ao contrario dos tres endossos, e PROPORCIONAL — dois tercos das
 * fundadoras ativas. Nao e incoerencia com a admissao: la o que se mede e
 * confianca, e tres lojas respondendo por uma quarta e uma unidade que nao
 * encolhe porque a praca e pequena. Aqui o que se mede e consenso da rede sobre
 * expulsar alguem, e consenso e proporcao por definicao.
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
import type { ClusterId, MemberId, MotionId, StoreId, UserId } from '../shared/ids.ts';
import {
  type Member,
  MemberStatus,
  isFoundingMemberOf,
  memberInGoodStanding,
} from './member.ts';
import { type NetworkUser, type Store, StoreStatus, UserRole } from './store.ts';
import type { BreachKind } from '../conduct/breach.ts';

export const MotionStatus = {
  OPEN: 'OPEN',
  /** Apoio suficiente: a empresa foi desligada. */
  CARRIED: 'CARRIED',
  /** Venceu o prazo sem juntar o quorum. Fica. */
  DISMISSED: 'DISMISSED',
  /** Retirada por quem abriu, antes da decisao. */
  WITHDRAWN: 'WITHDRAWN',
} as const;
export type MotionStatus = (typeof MotionStatus)[keyof typeof MotionStatus];

/**
 * O apoio de uma fundadora. Sem contraparte negativa, como o endosso: o
 * silencio ja e o "contra", e ele nao precisa de assinatura.
 */
export type MotionSupport = {
  readonly founderMemberId: MemberId;
  readonly givenByStoreId: StoreId;
  readonly givenByUserId: UserId;
  readonly givenAt: Instant;
  readonly note: string | null;
};

/**
 * O fato que autoriza a mocao. Copiado do registro de conduta no momento da
 * abertura, e nao consultado depois: a janela movel vai aliviar com o tempo, e
 * a mocao nao pode perder o fundamento no meio da votacao porque o calendario
 * andou. O que se julga e o que estava provado quando se abriu.
 */
export type ExpulsionGrounds = {
  readonly storeId: StoreId;
  /** Suspensoes por conduta que este patio ja sofreu. Reincidencia comeca em 2. */
  readonly conductSuspensions: number;
  readonly breachesInWindow: number;
  readonly kinds: readonly BreachKind[];
  readonly observedAt: Instant;
};

export type ExpulsionMotion = {
  readonly id: MotionId;
  readonly clusterId: ClusterId;
  /** A empresa acusada. O desligamento e do contrato, e o contrato e dela. */
  readonly memberId: MemberId;
  readonly openedByMemberId: MemberId;
  readonly openedAt: Instant;
  readonly status: MotionStatus;
  readonly grounds: ExpulsionGrounds;
  readonly supports: readonly MotionSupport[];
  readonly decidedAt: Instant | null;
};

export type ExpulsionPolicy = {
  /**
   * Fracao das fundadoras ativas (sem a acusada) que carrega a mocao.
   *
   * Dois tercos: maioria simples decidiria desligamento com um voto de
   * diferenca, e unanimidade daria a qualquer fundadora o veto que a admissao
   * recusou — bastaria uma se calar.
   */
  readonly supportFraction: number;
  /** Dias que a mocao fica de pe. Vencido o prazo, cai. */
  readonly windowDays: number;
  /**
   * Suspensoes por conduta a partir das quais cabe mocao.
   *
   * Duas. A primeira suspensao ja e a sancao das tres quebras; abrir mocao nela
   * seria punir duas vezes o mesmo fato. Reincidir depois de ter sido suspenso
   * e o que deixa de ser acidente.
   */
  readonly suspensionsForRecidivism: number;
};

export const DEFAULT_EXPULSION_POLICY: ExpulsionPolicy = {
  supportFraction: 2 / 3,
  windowDays: 21,
  suspensionsForRecidivism: 2,
};

/** Fundadoras que podem apoiar: ativas, desta praca, e nao a acusada. */
export function eligibleSupporters(
  founders: readonly Member[],
  motion: Pick<ExpulsionMotion, 'clusterId' | 'memberId'>,
): Member[] {
  return founders.filter(
    (founder) =>
      isFoundingMemberOf(founder, motion.clusterId) &&
      memberInGoodStanding(founder) &&
      founder.id !== motion.memberId,
  );
}

export function requiredSupport(
  eligible: number,
  policy: ExpulsionPolicy = DEFAULT_EXPULSION_POLICY,
): number {
  // Pelo menos duas, sempre: numa praca de tres fundadoras, dois tercos de duas
  // elegiveis arredondaria para 2 de qualquer forma — mas numa de duas daria 1,
  // e desligamento por decisao de uma unica loja e o veto individual disfarcado.
  return Math.max(2, Math.ceil(eligible * policy.supportFraction));
}

export type SupportTally = {
  readonly supports: number;
  readonly required: number;
  readonly stillNeeded: number;
  readonly carried: boolean;
  readonly foundersYetToSupport: number;
  /** Ainda ha fundadoras suficientes para a mocao passar? */
  readonly reachable: boolean;
};

export function supportTally(
  motion: ExpulsionMotion,
  founders: readonly Member[],
  policy: ExpulsionPolicy = DEFAULT_EXPULSION_POLICY,
): SupportTally {
  const elegiveis = eligibleSupporters(founders, motion);
  const required = requiredSupport(elegiveis.length, policy);
  const supports = motion.supports.length;
  const jaApoiaram = new Set(motion.supports.map((s) => s.founderMemberId));
  const faltamApoiar = elegiveis.filter((founder) => !jaApoiaram.has(founder.id)).length;
  const stillNeeded = Math.max(0, required - supports);

  return {
    supports,
    required,
    stillNeeded,
    carried: stillNeeded === 0,
    foundersYetToSupport: faltamApoiar,
    reachable: stillNeeded <= faltamApoiar,
  };
}

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

export type OpenMotionCommand = {
  readonly id: MotionId;
  readonly accused: Member;
  readonly grounds: ExpulsionGrounds;
  readonly openedBy: Member;
  readonly openedByStore: Store;
  readonly user: NetworkUser;
  readonly now: Instant;
  readonly policy?: ExpulsionPolicy;
};

/**
 * Abre a mocao de desligamento.
 *
 * As guardas aqui sao a diferenca entre governanca e briga de concorrentes. A
 * mais importante e a do fundamento: sem reincidencia medida, nao ha mocao — e
 * o erro que ela impede nao e alguem abrir uma mocao infundada, e alguem abrir
 * uma mocao **fundada em opiniao** contra quem esta vendendo bem.
 */
export function openExpulsionMotion(
  command: OpenMotionCommand,
): Transition<ExpulsionMotion> {
  const policy = command.policy ?? DEFAULT_EXPULSION_POLICY;
  const { accused, grounds, openedBy, openedByStore, user } = command;

  if (!isFoundingMemberOf(openedBy, accused.clusterId) || !memberInGoodStanding(openedBy)) {
    return err(
      forbiddenError(
        'NOT_AN_ELIGIBLE_PROPONENT',
        'Somente uma empresa fundadora em dia da praca abre mocao de desligamento.',
        { memberId: openedBy.id, status: openedBy.status },
      ),
    );
  }
  if (user.role !== UserRole.PRINCIPAL || user.storeId !== openedByStore.id || !user.active) {
    return err(
      forbiddenError('NOT_A_PRINCIPAL', 'A mocao e assinada pelo titular.', { userId: user.id }),
    );
  }
  if (openedBy.id === accused.id) {
    return err(
      ruleViolation('CANNOT_EXPEL_SELF', 'Uma empresa nao abre mocao contra si mesma.', {
        memberId: accused.id,
      }),
    );
  }
  if (accused.status === MemberStatus.EXITED) {
    return err(
      conflictError('MEMBER_ALREADY_EXITED', 'Esta empresa ja saiu da rede.', {
        memberId: accused.id,
      }),
    );
  }
  if (grounds.conductSuspensions < policy.suspensionsForRecidivism) {
    return err(
      ruleViolation(
        'NO_RECIDIVISM_ON_RECORD',
        'Desligamento exige reincidencia registrada em quebra de protocolo. ' +
          'Sem o registro, a mocao seria opiniao sobre um concorrente.',
        {
          memberId: accused.id,
          conductSuspensions: grounds.conductSuspensions,
          required: policy.suspensionsForRecidivism,
        },
      ),
    );
  }

  const motion: ExpulsionMotion = {
    id: command.id,
    clusterId: accused.clusterId,
    memberId: accused.id,
    openedByMemberId: openedBy.id,
    openedAt: command.now,
    status: MotionStatus.OPEN,
    grounds,
    supports: [],
    decidedAt: null,
  };

  return transitioned(motion, [
    domainEvent('governance.expulsion_opened', motion.id, command.now, {
      clusterId: motion.clusterId,
      memberId: motion.memberId,
      openedByMemberId: motion.openedByMemberId,
      conductSuspensions: grounds.conductSuspensions,
      breachesInWindow: grounds.breachesInWindow,
    }),
  ]);
}

export type SupportMotionCommand = {
  readonly motion: ExpulsionMotion;
  readonly founder: Member;
  readonly founderStore: Store;
  readonly user: NetworkUser;
  readonly note?: string | undefined;
  readonly now: Instant;
  readonly founders: readonly Member[];
  readonly policy?: ExpulsionPolicy;
};

/**
 * Uma fundadora apoia a mocao. Apoiar de novo atualiza a nota, como no endosso,
 * e pela mesma razao: e a mesma empresa falando, nao um segundo apoio.
 */
export function supportExpulsion(command: SupportMotionCommand): Transition<ExpulsionMotion> {
  const policy = command.policy ?? DEFAULT_EXPULSION_POLICY;
  const { motion, founder, founderStore, user, founders } = command;

  if (motion.status !== MotionStatus.OPEN) {
    return err(
      conflictError('MOTION_ALREADY_DECIDED', 'Esta mocao ja foi decidida.', {
        motionId: motion.id,
        status: motion.status,
      }),
    );
  }
  if (!isFoundingMemberOf(founder, motion.clusterId) || !memberInGoodStanding(founder)) {
    return err(
      forbiddenError(
        'NOT_AN_ELIGIBLE_SUPPORTER',
        'Somente uma empresa fundadora em dia da praca apoia a mocao.',
        { memberId: founder.id },
      ),
    );
  }
  if (
    user.role !== UserRole.PRINCIPAL ||
    user.storeId !== founderStore.id ||
    founderStore.memberId !== founder.id ||
    !user.active
  ) {
    return err(
      forbiddenError('NOT_A_PRINCIPAL', 'O apoio e assinado pelo titular.', { userId: user.id }),
    );
  }
  if (founder.id === motion.memberId) {
    return err(
      ruleViolation('ACCUSED_CANNOT_SUPPORT', 'A empresa acusada nao vota no proprio caso.', {
        memberId: founder.id,
      }),
    );
  }

  const note = command.note?.trim();
  if (note !== undefined && note.length > 500) {
    return err(validationError('NOTE_TOO_LONG', 'A nota do apoio excede 500 caracteres.'));
  }

  const support: MotionSupport = {
    founderMemberId: founder.id,
    givenByStoreId: founderStore.id,
    givenByUserId: user.id,
    givenAt: command.now,
    note: note !== undefined && note.length > 0 ? note : null,
  };

  const supports = [
    ...motion.supports.filter((s) => s.founderMemberId !== founder.id),
    support,
  ];
  const updated: ExpulsionMotion = { ...motion, supports };
  const tally = supportTally(updated, founders, policy);

  const events: DomainEvent[] = [
    domainEvent('governance.expulsion_supported', motion.id, command.now, {
      clusterId: motion.clusterId,
      memberId: motion.memberId,
      founderMemberId: founder.id,
      supports: tally.supports,
      required: tally.required,
    }),
  ];

  if (!tally.carried) return transitioned(updated, events);

  const carried: ExpulsionMotion = {
    ...updated,
    status: MotionStatus.CARRIED,
    decidedAt: command.now,
  };
  events.push(
    domainEvent('governance.expulsion_carried', motion.id, command.now, {
      clusterId: motion.clusterId,
      memberId: motion.memberId,
      supports: tally.supports,
      required: tally.required,
      supportedBy: supports.map((s) => s.founderMemberId),
    }),
  );

  return transitioned(carried, events);
}

export type LapseMotionCommand = {
  readonly motion: ExpulsionMotion;
  readonly now: Instant;
  readonly policy?: ExpulsionPolicy;
};

/** Mocao que nao junta o quorum no prazo cai. O desfecho por inercia e "fica". */
export function lapseMotion(command: LapseMotionCommand): Transition<ExpulsionMotion> {
  const policy = command.policy ?? DEFAULT_EXPULSION_POLICY;
  const { motion, now } = command;

  if (motion.status !== MotionStatus.OPEN) return unchanged(motion);
  if (now < motion.openedAt + policy.windowDays * DAY) return unchanged(motion);

  return transitioned({ ...motion, status: MotionStatus.DISMISSED, decidedAt: now }, [
    domainEvent('governance.expulsion_dismissed', motion.id, now, {
      clusterId: motion.clusterId,
      memberId: motion.memberId,
      supports: motion.supports.length,
    }),
  ]);
}

export function withdrawMotion(
  motion: ExpulsionMotion,
  requestedByMemberId: MemberId,
  now: Instant,
): Transition<ExpulsionMotion> {
  if (motion.status !== MotionStatus.OPEN) {
    return err(
      conflictError('MOTION_ALREADY_DECIDED', 'Esta mocao ja foi decidida.', {
        motionId: motion.id,
      }),
    );
  }
  if (requestedByMemberId !== motion.openedByMemberId) {
    return err(
      forbiddenError('NOT_THE_PROPONENT', 'Somente quem abriu a mocao pode retira-la.', {
        motionId: motion.id,
      }),
    );
  }

  return transitioned({ ...motion, status: MotionStatus.WITHDRAWN, decidedAt: now }, [
    domainEvent('governance.expulsion_withdrawn', motion.id, now, {
      clusterId: motion.clusterId,
      memberId: motion.memberId,
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Efeito
// ---------------------------------------------------------------------------

export type Expulsion = {
  readonly member: Member;
  readonly stores: readonly Store[];
};

/**
 * Executa o desligamento decidido: a empresa e todos os patios dela saem.
 *
 * O que o desligamento NAO faz — e a decisao mais consequente daqui: ele NAO
 * espera a custodia se resolver, e NAO e bloqueado por ela. Se estar com o
 * carro de um parceiro adiasse o desligamento, bastaria segurar um carro para
 * nunca ser desligado — o refem viraria escudo.
 *
 * As obrigacoes sobrevivem a saida: o livro de custodia continua registrando
 * quem esta com o que, e `openCustodyVehicleIds` vai no evento justamente para
 * a rede saber, no mesmo instante da decisao, quais carros precisam voltar e de
 * onde. Desligar sem dizer isso seria criar um carro orfao por decisao de
 * governanca.
 */
export function executeExpulsion(
  motion: ExpulsionMotion,
  member: Member,
  stores: readonly Store[],
): Result<Expulsion, DomainError> {
  if (motion.status !== MotionStatus.CARRIED) {
    return err(
      conflictError(
        'MOTION_NOT_CARRIED',
        'So uma mocao aprovada pelas fundadoras desliga uma empresa.',
        { motionId: motion.id, status: motion.status },
      ),
    );
  }
  if (member.id !== motion.memberId) {
    return err(
      ruleViolation('MOTION_MEMBER_MISMATCH', 'A mocao nao e contra esta empresa.', {
        motionId: motion.id,
        memberId: member.id,
      }),
    );
  }

  return ok({
    member: { ...member, status: MemberStatus.EXITED },
    stores: stores.map((store) => ({ ...store, status: StoreStatus.EXITED })),
  });
}

export function expulsionEvents(
  motion: ExpulsionMotion,
  member: Member,
  stores: readonly Store[],
  openCustodyVehicleIds: readonly string[],
  now: Instant,
) {
  return [
    domainEvent('network.member_expelled', member.id, now, {
      clusterId: member.clusterId,
      motionId: motion.id,
      legalName: member.legalName,
      storeIds: stores.map((store) => store.id),
      // Vai no evento porque quem precisa agir e a dona de cada carro, e ela
      // nao deveria ter de descobrir sozinha que o custodiante saiu da rede.
      openCustodyVehicleIds,
    }),
  ];
}
