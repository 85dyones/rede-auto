/**
 * Saida voluntaria: a empresa que decide sair por vontade propria.
 *
 * E um fluxo diferente do desligamento, e usar o mesmo seria errado nos dois
 * sentidos. Desligamento e sancao: precisa de fato provado, quorum e prazo de
 * votacao, e quem decide sao os outros. Saida e decisao de quem sai — ninguem
 * vota, ninguem precisa concordar, e nao ha nada a provar.
 *
 * Mas saida tambem nao pode ser instantanea, e a razao nao e burocratica: no
 * instante do desligamento a empresa deixa de estar sob o protocolo da rede, e
 * todo carro que ela ainda detiver — ou que ainda estiver detido por outros —
 * fica sem contraparte. Nao ha mais recall a pedir, prazo a cobrar nem registro
 * de conduta a lancar. O livro de custodia continuaria dizendo quem esta com o
 * que, e nao haveria mais rede para fazer alguma coisa a respeito.
 *
 * Daí o desenho em DUAS COMPORTAS, e as duas precisam abrir:
 *
 *  1. TEMPO — aviso previo, para os parceiros se reorganizarem. Uma loja que
 *     conta com o estoque da outra precisa de aviso, nao de surpresa.
 *  2. ESTADO — nada em aberto: nenhum carro de terceiro no patio dela, nenhum
 *     carro dela em patio alheio, nenhuma trava, negociacao ou cobranca viva.
 *
 * A comporta de estado e a que importa, e ela NAO e uma data: por mais que o
 * prazo tenha vencido, a empresa nao sai enquanto estiver com o carro de
 * alguem. O aviso previo e um minimo, nao o gatilho.
 *
 * Entre o aviso e a saida a empresa fica em LEAVING, e o estado tem um sentido
 * preciso: ela nao adquire exposicao NOVA (nao trava carro alheio, nao recebe
 * custodia, nao apresenta nem endossa candidata), mas termina tudo o que ja
 * estava aberto. Bloquear o encerramento seria prender o carro de terceiro no
 * patio de quem esta de saida, que e o oposto do que se quer.
 */

import { type Result, err, ok } from '../shared/result.ts';
import { type DomainError, conflictError, ruleViolation } from '../shared/errors.ts';
import { domainEvent } from '../shared/events.ts';
import { type Transition, transitioned } from '../shared/transition.ts';
import { type Instant, DAY } from '../shared/clock.ts';
import { type Member, MemberStatus } from './member.ts';
import { type Store, StoreStatus } from './store.ts';

export type ExitPolicy = {
  /**
   * Dias de aviso previo antes de a saida poder ser concluida.
   *
   * Trinta: o mesmo horizonte da inadimplencia, e o prazo comercial que o
   * lojista ja reconhece. O bastante para a parceira que conta com aquele
   * estoque achar outro, e curto o bastante para nao prender quem quer sair.
   */
  readonly noticeDays: number;
};

export const DEFAULT_EXIT_POLICY: ExitPolicy = { noticeDays: 30 };

/**
 * O que ainda falta para a empresa poder sair.
 *
 * Uma lista de pendencias, e nao um booleano, porque o valor disto e dizer O
 * QUE falta: "voce nao pode sair" sem o motivo transformaria a saida num muro.
 * E a mesma lista que a tela mostra como checklist.
 */
export type ExitReadiness = {
  readonly noticeGivenAt: Instant | null;
  readonly noticePeriodEndsAt: Instant | null;
  readonly noticeServed: boolean;
  /** Carros de terceiros nos patios dela. Precisam voltar para as donas. */
  readonly holdingOthersVehicles: number;
  /** Carros dela em patios alheios. Precisam ser chamados de volta. */
  readonly vehiclesHeldByOthers: number;
  /** Travas comerciais vivas — dela sobre terceiros, ou de terceiros sobre ela. */
  readonly openLocks: number;
  /** Negociacoes em andamento: ha dinheiro e ATPV-e pendentes. */
  readonly openDeals: number;
  readonly outstandingChargeCents: number;
  readonly clear: boolean;
  readonly blockers: readonly string[];
};

export type ExitPendencies = {
  readonly holdingOthersVehicles: number;
  readonly vehiclesHeldByOthers: number;
  readonly openLocks: number;
  readonly openDeals: number;
  readonly outstandingChargeCents: number;
};

export function exitReadiness(
  member: Member,
  pendencies: ExitPendencies,
  now: Instant,
  policy: ExitPolicy = DEFAULT_EXIT_POLICY,
): ExitReadiness {
  const noticeGivenAt = member.exitNoticeAt;
  const noticePeriodEndsAt =
    noticeGivenAt === null ? null : noticeGivenAt + policy.noticeDays * DAY;
  const noticeServed = noticePeriodEndsAt !== null && now >= noticePeriodEndsAt;

  const blockers: string[] = [];
  if (noticeGivenAt === null) blockers.push('AVISO_NAO_DADO');
  else if (!noticeServed) blockers.push('AVISO_EM_CURSO');
  if (pendencies.holdingOthersVehicles > 0) blockers.push('CUSTODIA_DE_TERCEIROS');
  if (pendencies.vehiclesHeldByOthers > 0) blockers.push('VEICULOS_EM_PATIO_ALHEIO');
  if (pendencies.openLocks > 0) blockers.push('TRAVAS_ABERTAS');
  if (pendencies.openDeals > 0) blockers.push('NEGOCIACOES_ABERTAS');
  if (pendencies.outstandingChargeCents > 0) blockers.push('COBRANCAS_EM_ABERTO');

  return {
    noticeGivenAt,
    noticePeriodEndsAt,
    noticeServed,
    ...pendencies,
    clear: blockers.length === 0,
    blockers,
  };
}

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

/**
 * A empresa avisa que vai sair.
 *
 * Uma empresa SUSPENSA pode avisar, e isso e deliberado: impedir que quem esta
 * inadimplente peca para sair faria da suspensao uma armadilha — a loja ficaria
 * presa a uma rede em que nao opera, acumulando mensalidade. Ela ainda vai ter
 * de quitar para sair (a comporta de estado nao se abre com cobranca aberta),
 * mas o caminho existe.
 */
export function giveExitNotice(member: Member, now: Instant): Transition<Member> {
  if (member.status === MemberStatus.EXITED) {
    return err(
      conflictError('MEMBER_ALREADY_EXITED', 'Esta empresa ja saiu da rede.', {
        memberId: member.id,
      }),
    );
  }
  if (member.exitNoticeAt !== null) {
    return err(
      conflictError('EXIT_NOTICE_ALREADY_GIVEN', 'O aviso de saida ja foi dado.', {
        memberId: member.id,
        noticeAt: member.exitNoticeAt,
      }),
    );
  }

  return transitioned({ ...member, status: MemberStatus.LEAVING, exitNoticeAt: now }, [
    domainEvent('network.exit_notice_given', member.id, now, {
      clusterId: member.clusterId,
      legalName: member.legalName,
      // Vai no evento porque e o que as parceiras precisam saber para se
      // reorganizar: quem conta com aquele estoque tem de comecar a procurar.
      previousStatus: member.status,
    }),
  ]);
}

/**
 * Desiste de sair. Nada foi destruido no caminho, entao a volta e limpa.
 *
 * Volta para ACTIVE mesmo que a empresa estivesse SUSPENDED quando avisou: a
 * suspensao por inadimplencia e recolocada pelo proprio varredor de cobranca no
 * passe seguinte, se o atraso continuar. Reconstruir aqui o motivo da suspensao
 * anterior seria duplicar uma decisao que ja tem dono.
 */
export function withdrawExitNotice(member: Member, now: Instant): Transition<Member> {
  if (member.status !== MemberStatus.LEAVING) {
    return err(
      conflictError('NO_EXIT_NOTICE', 'Esta empresa nao avisou saida.', { memberId: member.id }),
    );
  }

  return transitioned({ ...member, status: MemberStatus.ACTIVE, exitNoticeAt: null }, [
    domainEvent('network.exit_notice_withdrawn', member.id, now, {
      clusterId: member.clusterId,
      legalName: member.legalName,
    }),
  ]);
}

export type CompletedExit = {
  readonly member: Member;
  readonly stores: readonly Store[];
};

/**
 * Conclui a saida. So passa com as duas comportas abertas.
 *
 * Note que o prazo vencido NAO basta, e e o ponto todo: a empresa nao sai da
 * rede enquanto estiver com o carro de alguem, nem enquanto alguem estiver com
 * o dela. Depois de EXITED nao ha mais recall a pedir, prazo a cobrar nem
 * conduta a registrar — o carro ficaria sem contraparte, e o livro de custodia
 * viraria um registro de um fato que a rede nao pode mais resolver.
 */
export function completeExit(
  member: Member,
  stores: readonly Store[],
  readiness: ExitReadiness,
): Result<CompletedExit, DomainError> {
  if (member.status !== MemberStatus.LEAVING) {
    return err(
      conflictError('NO_EXIT_NOTICE', 'Esta empresa nao avisou saida.', { memberId: member.id }),
    );
  }
  if (!readiness.clear) {
    return err(
      ruleViolation(
        'EXIT_NOT_CLEAR',
        'A saida ainda tem pendencias: ' + readiness.blockers.join(', ') + '.',
        { memberId: member.id, blockers: readiness.blockers },
      ),
    );
  }

  return ok({
    member: { ...member, status: MemberStatus.EXITED },
    stores: stores.map((store) => ({ ...store, status: StoreStatus.EXITED })),
  });
}

export function describeExitBlocker(blocker: string): string {
  switch (blocker) {
    case 'AVISO_NAO_DADO':
      return 'o aviso de saida ainda nao foi dado';
    case 'AVISO_EM_CURSO':
      return 'o aviso previo ainda esta correndo';
    case 'CUSTODIA_DE_TERCEIROS':
      return 'ha carro de outra loja no seu patio';
    case 'VEICULOS_EM_PATIO_ALHEIO':
      return 'ha carro seu em patio de outra loja';
    case 'TRAVAS_ABERTAS':
      return 'ha trava comercial em aberto';
    case 'NEGOCIACOES_ABERTAS':
      return 'ha negociacao em andamento';
    case 'COBRANCAS_EM_ABERTO':
      return 'ha cobranca em aberto';
    default:
      return blocker;
  }
}
