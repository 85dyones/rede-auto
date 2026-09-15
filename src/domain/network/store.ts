/**
 * Loja: o PATIO de uma empresa credenciada, e os usuarios que trabalham nele.
 *
 * O que e da empresa mora em `member.ts` — ser fundadora, endossar, pagar,
 * ser suspensa por inadimplencia. O que fica aqui e o que so pode ser de um
 * patio: custodia, estoque, trava, vistoria. Quem responde pelo carro e quem
 * esta com ele, e isso nao se reparte entre filiais.
 *
 * A rede e fechada: nao existe autocadastro. Uma loja so passa a existir
 * porque a empresa dela foi endossada (ver `membership.ts`) ou porque uma
 * empresa ja credenciada abriu mais um patio.
 */

import { type Result, ok, err, combine } from '../shared/result.ts';
import { type DomainError, validationError } from '../shared/errors.ts';
import type { Instant } from '../shared/clock.ts';
import type { ClusterId, MemberId, StoreId, UserId } from '../shared/ids.ts';
import { parseCnpj, requireText, requireOneOf } from '../shared/validation.ts';
import { TradeInStance } from '../vehicle/vehicle.ts';
import { type Member, isFoundingMemberOf, memberInGoodStanding } from './member.ts';

export const StoreStatus = {
  ACTIVE: 'ACTIVE',
  /**
   * Suspensa por QUEBRA DE PROTOCOLO de entrega ou retirada — sancao do patio,
   * medida pelo que este patio fez. Nao anuncia nem trava veiculos, mas segue
   * responsavel pela custodia que ja detem: o carro de terceiro nao vira refem
   * da sancao.
   *
   * Inadimplencia nao entra aqui: e da empresa, e suspende todas as lojas dela
   * de uma vez (`MemberStatus.SUSPENDED`).
   */
  SUSPENDED: 'SUSPENDED',
  EXITED: 'EXITED',
} as const;
export type StoreStatus = (typeof StoreStatus)[keyof typeof StoreStatus];

export const UserRole = {
  /** Abre e estende travas, monta negociacao, baixa a ficha de divulgacao. */
  SALESPERSON: 'SALESPERSON',
  /** Tudo do vendedor + preco liquido, aceite de transbordo, recall, custodia. */
  MANAGER: 'MANAGER',
  /** Tudo do gerente + endosso de credenciamento (apenas em empresa fundadora). */
  PRINCIPAL: 'PRINCIPAL',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

const UF = [
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT',
  'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
] as const;

export type StoreProfile = {
  readonly legalName: string;
  readonly tradeName: string;
  readonly cnpj: string;
  readonly city: string;
  readonly state: string;
  readonly phone: string;
  readonly email: string;
  readonly responsibleName: string;
};

export type Store = {
  readonly id: StoreId;
  /**
   * A empresa dona deste patio. Imutavel: um patio nao troca de empresa — ele
   * fecha e outro abre, com CNPJ proprio.
   *
   * Redundante com `clusterId`? Nao: o membro e que tem praca, e a loja herda.
   * Guardar os dois evita uma consulta em toda guarda de fronteira, ao custo de
   * um invariante — `store.clusterId === member.clusterId` — que so
   * `openBranch` e a admissao podem criar, e nenhum dos dois aceita divergir.
   */
  readonly memberId: MemberId;
  /**
   * A praca a que esta loja pertence. Imutavel: mudar de cluster nao e editar
   * um campo — e sair de uma rede e se credenciar em outra, com endossos novos.
   */
  readonly clusterId: ClusterId;
  readonly profile: StoreProfile;
  readonly status: StoreStatus;
  readonly joinedAt: Instant;
  /**
   * Postura padrao de troca desta loja. O veiculo que entra pelo feed nasce com
   * ela — sem isso, uma loja que so trabalha com dinheiro teria de marcar carro
   * por carro a cada sincronizacao, e o campo nao seria usado.
   *
   * `CONSIDERS` na constituicao porque e o comportamento que ja existia.
   */
  readonly tradeInDefault: TradeInStance;
};

export type NetworkUser = {
  readonly id: UserId;
  readonly storeId: StoreId;
  readonly name: string;
  readonly email: string;
  readonly role: UserRole;
  readonly active: boolean;
};

/**
 * Valida o cadastro de uma candidata. Roda no momento da candidatura, nao na
 * aprovacao: fundadora nao deve gastar endosso analisando ficha incompleta.
 */
export function parseStoreProfile(input: unknown): Result<StoreProfile, DomainError> {
  if (typeof input !== 'object' || input === null) {
    return err(validationError('PROFILE_REQUIRED', 'Dados cadastrais da loja sao obrigatorios.'));
  }
  const raw = input as Record<string, unknown>;
  const state = typeof raw['state'] === 'string' ? raw['state'].toUpperCase() : raw['state'];

  return combine({
    legalName: requireText(raw['legalName'], 'razao social', { min: 3, max: 200 }),
    tradeName: requireText(raw['tradeName'], 'nome fantasia', { min: 2, max: 120 }),
    cnpj: parseCnpj(raw['cnpj']),
    city: requireText(raw['city'], 'cidade', { min: 2, max: 120 }),
    state: requireOneOf(state, 'UF', UF),
    phone: parsePhone(raw['phone']),
    email: parseEmail(raw['email']),
    responsibleName: requireText(raw['responsibleName'], 'responsavel', { min: 3, max: 200 }),
  });
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function parseEmail(value: unknown, field = 'e-mail'): Result<string, DomainError> {
  const text = requireText(value, field, { min: 5, max: 254 });
  if (!text.ok) return text;
  const email = text.value.toLowerCase();
  return EMAIL_PATTERN.test(email)
    ? ok(email)
    : err(validationError('EMAIL_INVALID', `${field}: endereco invalido.`, { field }));
}

/** Telefone brasileiro com DDD, fixo (10) ou celular (11 digitos). */
export function parsePhone(value: unknown, field = 'telefone'): Result<string, DomainError> {
  const text = requireText(value, field, { min: 8, max: 20 });
  if (!text.ok) return text;
  const digits = text.value.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  if (digits.length < 10 || digits.length > 11) {
    return err(
      validationError('PHONE_INVALID', `${field}: informe DDD + numero.`, {
        field,
        received: text.value,
      }),
    );
  }
  return ok(digits);
}

export function formatPhone(digits: string): string {
  const ddd = digits.slice(0, 2);
  const rest = digits.slice(2);
  const middle = rest.length === 9 ? rest.slice(0, 5) : rest.slice(0, 4);
  const tail = rest.length === 9 ? rest.slice(5) : rest.slice(4);
  return `(${ddd}) ${middle}-${tail}`;
}

// ---------------------------------------------------------------------------
// Predicados de autorizacao
// ---------------------------------------------------------------------------

/**
 * A loja pode operar?
 *
 * Duas condicoes, e as duas sao obrigatorias no tipo. `member` nao tem valor
 * padrao de proposito: a pergunta "esta loja pode transacionar?" deixou de ter
 * resposta olhando so para a loja no dia em que a inadimplencia passou a ser da
 * empresa. Um parametro opcional aqui significaria que metade das chamadas
 * responderia a pergunta antiga sem ninguem perceber — e a metade errada seria
 * justamente a que deixa empresa inadimplente operando pela filial.
 *
 * O compilador apontou as chamadas. E o mesmo remedio de `loadVehicle(actor)`.
 */
export function canTransact(store: Store, member: Member): boolean {
  return (
    store.status === StoreStatus.ACTIVE &&
    memberInGoodStanding(member) &&
    store.memberId === member.id
  );
}

/**
 * Endossar credenciamento exige EMPRESA fundadora em dia, patio aberto e
 * usuario titular. Concentrar a regra aqui evita reimplementa-la em cada rota.
 *
 * O endosso e da empresa, exercido pelo titular de qualquer patio dela. Se
 * fosse do patio, um grupo com tres lojas credenciaria uma candidata sozinho —
 * e "tres endossos" deixaria de significar tres empresas respondendo por uma
 * quarta. `endorse` ainda barra o segundo endosso da mesma empresa, mas a regra
 * comeca aqui.
 *
 * O endosso decide: o terceiro credencia, sem passo da plataforma no meio.
 */
export function canEndorseMembership(
  store: Store,
  member: Member,
  user: NetworkUser,
  clusterId: ClusterId = member.clusterId,
): boolean {
  return (
    isFoundingMemberOf(member, clusterId) &&
    canTransact(store, member) &&
    user.active &&
    user.storeId === store.id &&
    user.role === UserRole.PRINCIPAL
  );
}

export function hasManagerPowers(user: NetworkUser): boolean {
  return user.active && (user.role === UserRole.MANAGER || user.role === UserRole.PRINCIPAL);
}

export function describeStore(store: Store): string {
  return `${store.profile.tradeName} (${store.profile.city}/${store.profile.state})`;
}
