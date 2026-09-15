/**
 * Membro: a EMPRESA credenciada na praca. A loja e o patio dela.
 *
 * Ate aqui `Store` acumulava dois papeis que a tabela de precos separou. A
 * mensalidade e "R$ 599 por empresa, com a primeira loja inclusa, mais R$ 159
 * por loja adicional" — um preco que so existe se empresa e loja forem coisas
 * diferentes. E, uma vez separadas, varias regras ja escritas passam a apontar
 * para o lugar errado:
 *
 *  - a adesao e cobrada uma vez da empresa, nao uma vez por patio;
 *  - inadimplencia de 30 dias suspende a empresa, e com ela todas as lojas.
 *    Suspender uma de tres seria fingir que o contrato e do patio;
 *  - fundadora e a EMPRESA. Se fosse a loja, o grupo que abrisse um segundo
 *    patio ganharia um segundo endosso — e tres endossos deixariam de ser tres
 *    empresas respondendo por uma quarta para virar uma empresa respondendo por
 *    si mesma tres vezes. E o mesmo buraco que `SPONSOR_CANNOT_ENDORSE` e
 *    "endossar de novo atualiza a nota" ja fecham em outra porta.
 *
 * Fica na loja o que e operacional e so pode ser de um patio: custodia,
 * estoque, trava, vistoria. Quem responde pelo carro e quem esta com ele.
 *
 * Por isso ha DOIS status, e nao um:
 *
 *  - `Member.status` e contratual — inadimplencia, saida, expulsao;
 *  - `Store.status` e operacional — quebra de protocolo de entrega/retirada.
 *
 * Uma loja so transaciona se as duas coisas estiverem de pe (`canTransact`).
 * Unificar seria escolher entre punir patio que nao fez nada ou deixar a
 * empresa inadimplente operando pela filial.
 */

import { type Result, ok, err, combine } from '../shared/result.ts';
import { type DomainError, validationError } from '../shared/errors.ts';
import type { Instant } from '../shared/clock.ts';
import type { ClusterId, MemberId } from '../shared/ids.ts';
import { parseCnpj, requireText } from '../shared/validation.ts';
import { domainEvent } from '../shared/events.ts';
import { type Transition, transitioned, unchanged } from '../shared/transition.ts';
import { parseEmail, parsePhone, type StoreProfile } from './store.ts';

export const MemberKind = {
  /**
   * Entrou dentro da janela de fundacao da praca. Endossa candidaturas e paga
   * adesao reduzida. Quantas existem e um fato contado, nao um numero fixado.
   */
  FOUNDER: 'FOUNDER',
  /** Credenciada depois de fechada a janela. Opera igual; nao endossa. */
  MEMBER: 'MEMBER',
} as const;
export type MemberKind = (typeof MemberKind)[keyof typeof MemberKind];

export const MemberStatus = {
  ACTIVE: 'ACTIVE',
  /**
   * Suspensa por inadimplencia. Nenhuma loja dela anuncia ou trava veiculo,
   * mas todas seguem responsaveis pela custodia que ja detem: o carro de
   * terceiro no patio nao vira refem de uma fatura.
   */
  SUSPENDED: 'SUSPENDED',
  /**
   * Avisou que vai sair e esta encerrando.
   *
   * Nao adquire exposicao NOVA — nao trava carro alheio, nao recebe custodia,
   * nao apresenta nem endossa candidata — mas termina tudo que ja estava
   * aberto. Bloquear o encerramento prenderia o carro de terceiro no patio de
   * quem esta de saida, que e o oposto do que se quer. Ver `exit.ts`.
   */
  LEAVING: 'LEAVING',
  /** Saiu ou foi desligada. Historico preservado. */
  EXITED: 'EXITED',
} as const;
export type MemberStatus = (typeof MemberStatus)[keyof typeof MemberStatus];

export type Member = {
  readonly id: MemberId;
  /** A praca. Imutavel, como em `Store`: mudar de praca e se credenciar de novo. */
  readonly clusterId: ClusterId;
  readonly legalName: string;
  /**
   * Raiz do CNPJ: os 8 primeiros digitos.
   *
   * No Brasil a filial carrega a mesma raiz da matriz e difere na ordem
   * (`/0001`, `/0002`). Entao a raiz **e** a identidade da empresa, e nao um
   * campo que alguem preenche: ela e derivada do CNPJ da primeira loja. E o que
   * faz "essa loja nova e da mesma empresa?" ser uma pergunta verificavel em vez
   * de uma declaracao em que se acredita.
   */
  readonly cnpjRoot: string;
  readonly responsibleName: string;
  readonly email: string;
  readonly phone: string;
  readonly kind: MemberKind;
  readonly status: MemberStatus;
  readonly joinedAt: Instant;
  /** Empresa que apresentou a candidatura. `null` para as fundadoras. */
  readonly sponsorMemberId: MemberId | null;
  /**
   * A versao da tabela de precos que esta empresa assinou.
   *
   * Fundadora fica nela por 24 meses (ver `tariff.ts`); depois migra para a
   * vigente. Nao ha `frozenUntil` guardado ao lado: `joinedAt` mais 24 meses ja
   * responde, e a copia so serviria para divergir do original.
   */
  readonly tariffVersion: string;
  /**
   * Quando a empresa avisou que vai sair. `null` enquanto nao avisou.
   *
   * O aviso e um instante guardado, e nao um estado derivado, porque dele sai o
   * prazo — e porque desistir precisa poder apagar o aviso sem apagar o
   * historico do que aconteceu no meio.
   */
  readonly exitNoticeAt: Instant | null;
};

/** Os 8 primeiros digitos de um CNPJ ja validado. */
export function cnpjRootOf(cnpj: string): string {
  return cnpj.slice(0, 8);
}

export function sameCompany(a: string, b: string): boolean {
  return cnpjRootOf(a) === cnpjRootOf(b);
}

export function formatCnpjRoot(root: string): string {
  return `${root.slice(0, 2)}.${root.slice(2, 5)}.${root.slice(5, 8)}`;
}

// ---------------------------------------------------------------------------
// Constituicao
// ---------------------------------------------------------------------------

/**
 * Deriva a empresa da ficha da primeira loja.
 *
 * A candidata preenche UMA ficha, nao duas. Uma empresa entra na rede com
 * exatamente um patio — patio adicional e operacao posterior (`openBranch`), e e
 * la que os R$ 159 aparecem. Pedir "dados da empresa" e "dados da loja"
 * separadamente na entrada seria pedir a mesma coisa duas vezes e abrir a porta
 * para as duas divergirem.
 */
export function memberFromFirstStore(
  id: MemberId,
  clusterId: ClusterId,
  profile: StoreProfile,
  kind: MemberKind,
  sponsorMemberId: MemberId | null,
  joinedAt: Instant,
  tariffVersion: string,
): Member {
  return {
    id,
    clusterId,
    legalName: profile.legalName,
    cnpjRoot: cnpjRootOf(profile.cnpj),
    responsibleName: profile.responsibleName,
    email: profile.email,
    phone: profile.phone,
    kind,
    status: MemberStatus.ACTIVE,
    joinedAt,
    sponsorMemberId,
    tariffVersion,
    exitNoticeAt: null,
  };
}

export type MemberProfileDraft = {
  readonly legalName: string;
  readonly cnpjRoot: string;
  readonly responsibleName: string;
  readonly email: string;
  readonly phone: string;
};

/** Para o cadastro direto de empresa, fora do fluxo de candidatura. */
export function parseMemberProfile(input: unknown): Result<MemberProfileDraft, DomainError> {
  if (typeof input !== 'object' || input === null) {
    return err(validationError('MEMBER_REQUIRED', 'Dados cadastrais da empresa sao obrigatorios.'));
  }
  const raw = input as Record<string, unknown>;

  return combine({
    legalName: requireText(raw['legalName'], 'razao social', { min: 3, max: 200 }),
    cnpjRoot: parseRoot(raw['cnpj']),
    responsibleName: requireText(raw['responsibleName'], 'responsavel', { min: 3, max: 200 }),
    email: parseEmail(raw['email']),
    phone: parsePhone(raw['phone']),
  });
}

function parseRoot(value: unknown): Result<string, DomainError> {
  const cnpj = parseCnpj(value);
  return cnpj.ok ? ok(cnpjRootOf(cnpj.value)) : cnpj;
}

// ---------------------------------------------------------------------------
// Predicados
// ---------------------------------------------------------------------------

export function isFoundingMember(member: Member): boolean {
  return member.kind === MemberKind.FOUNDER;
}

/**
 * Fundadora **desta** praca. O sufixo existe pelo mesmo motivo de
 * `isFounderOf`: `isFoundingMember` sozinho vira pergunta perigosa quando ha
 * mais de um cluster.
 */
export function isFoundingMemberOf(member: Member, clusterId: ClusterId): boolean {
  return isFoundingMember(member) && member.clusterId === clusterId;
}

/**
 * A empresa esta em dia com o contrato? Nada a ver com o patio estar aberto.
 *
 * `LEAVING` responde falso, e e o mecanismo que impede a empresa de saida de
 * adquirir exposicao nova: `canTransact` passa por aqui, entao trava comercial,
 * apadrinhamento e endosso param sozinhos, sem regra nova em cada lugar. O que
 * nao passa por `canTransact` — check-in, devolucao, recall, liquidacao — segue
 * funcionando, que e exatamente o encerramento que ela precisa fazer.
 */
export function memberInGoodStanding(member: Member): boolean {
  return member.status === MemberStatus.ACTIVE;
}

/** A empresa avisou saida e esta encerrando? */
export function isLeaving(member: Member): boolean {
  return member.status === MemberStatus.LEAVING;
}

export function describeMember(member: Member): string {
  return `${member.legalName} (${formatCnpjRoot(member.cnpjRoot)})`;
}

// ---------------------------------------------------------------------------
// Transicoes de contrato
// ---------------------------------------------------------------------------

/**
 * Suspende por inadimplencia. Atinge a EMPRESA, e portanto todos os patios
 * dela: o contrato e um so, e suspender uma filial de tres seria fingir que
 * cada patio tem o proprio.
 *
 * O que a suspensao NAO faz, e de proposito:
 *
 *  - nao interrompe a custodia em curso. Carro de terceiro no patio da empresa
 *    suspensa continua sendo responsabilidade dela, e continua podendo voltar
 *    para a dona. Transformar o carro em refem de uma fatura puniria quem nao
 *    deve nada;
 *  - nao para a cobranca. O ciclo seguinte e emitido igual. Se parasse,
 *    suspensao sairia mais barato que pagar, e a inadimplencia viraria uma
 *    forma de ficar de graca.
 */
export function suspendForArrears(
  member: Member,
  overdueDays: number,
  now: Instant,
): Transition<Member> {
  if (member.status === MemberStatus.EXITED) return unchanged(member);
  if (member.status === MemberStatus.SUSPENDED) return unchanged(member);

  return transitioned({ ...member, status: MemberStatus.SUSPENDED }, [
    domainEvent('network.member_suspended', member.id, now, {
      clusterId: member.clusterId,
      legalName: member.legalName,
      reason: 'ARREARS',
      overdueDays,
    }),
  ]);
}

/**
 * Reativa depois de quitado o atraso.
 *
 * Nao reativa quem saiu: `EXITED` e desligamento, e voltar exige credenciamento
 * novo, com endossos. Uma quitacao nao desfaz uma saida.
 */
export function reinstate(member: Member, now: Instant): Transition<Member> {
  if (member.status !== MemberStatus.SUSPENDED) return unchanged(member);

  return transitioned({ ...member, status: MemberStatus.ACTIVE }, [
    domainEvent('network.member_reinstated', member.id, now, {
      clusterId: member.clusterId,
      legalName: member.legalName,
    }),
  ]);
}
