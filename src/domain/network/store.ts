/**
 * Loja participante da rede e seus usuarios.
 *
 * A rede e fechada e qualificada: nao existe autocadastro. Uma loja so passa a
 * existir como membro depois de endossada por fundadoras da praca (ver
 * `membership.ts`).
 *
 * Quem e fundadora nao e uma lista fechada na constituicao: e quem foi
 * credenciado enquanto a janela de fundacao do cluster estava aberta. Por isso
 * nenhum lugar do sistema declara quantas fundadoras existem — pergunta-se ao
 * repositorio (`stores.founders(clusterId)`).
 */

import { type Result, ok, err, combine } from '../shared/result.ts';
import { type DomainError, validationError } from '../shared/errors.ts';
import type { Instant } from '../shared/clock.ts';
import type { ClusterId, StoreId, UserId } from '../shared/ids.ts';
import { parseCnpj, requireText, requireOneOf } from '../shared/validation.ts';
import { TradeInStance } from '../vehicle/vehicle.ts';

export const StoreKind = {
  /**
   * Entrou dentro da janela de fundacao da praca. Endossa candidaturas e paga
   * adesao reduzida. Quantas existem e um fato contado, nao um numero fixado.
   */
  FOUNDER: 'FOUNDER',
  /** Credenciada depois de fechada a janela. Opera igual; nao endossa. */
  MEMBER: 'MEMBER',
} as const;
export type StoreKind = (typeof StoreKind)[keyof typeof StoreKind];

export const StoreStatus = {
  ACTIVE: 'ACTIVE',
  /** Suspensa: nao anuncia nem trava veiculos, mas segue responsavel pela custodia que detem. */
  SUSPENDED: 'SUSPENDED',
  EXITED: 'EXITED',
} as const;
export type StoreStatus = (typeof StoreStatus)[keyof typeof StoreStatus];

export const UserRole = {
  /** Abre e estende travas, monta negociacao, baixa a ficha de divulgacao. */
  SALESPERSON: 'SALESPERSON',
  /** Tudo do vendedor + preco liquido, aceite de transbordo, recall, custodia. */
  MANAGER: 'MANAGER',
  /** Tudo do gerente + endosso de credenciamento (apenas em loja fundadora). */
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
   * A praca a que esta loja pertence. Imutavel: mudar de cluster nao e editar
   * um campo — e sair de uma rede e se credenciar em outra, com quorum novo.
   */
  readonly clusterId: ClusterId;
  readonly profile: StoreProfile;
  readonly kind: StoreKind;
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
  /** Quem apadrinhou a candidatura. `null` para as fundadoras. */
  readonly sponsorStoreId: StoreId | null;
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

export function isFounder(store: Store): boolean {
  return store.kind === StoreKind.FOUNDER;
}

/**
 * Fundadora **desta** praca. O sufixo existe porque `isFounder` sozinho vira
 * uma pergunta perigosa quando ha mais de um cluster: fundadora de Curitiba nao
 * endossa candidata de Londrina.
 */
export function isFounderOf(store: Store, clusterId: ClusterId): boolean {
  return isFounder(store) && store.clusterId === clusterId;
}

export function canTransact(store: Store): boolean {
  return store.status === StoreStatus.ACTIVE;
}

/**
 * Endossar credenciamento exige loja fundadora ativa e usuario titular.
 * Concentrar a regra aqui evita reimplementa-la em cada rota.
 *
 * O endosso decide: o terceiro credencia, sem passo da plataforma no meio. O
 * que a fundadora faz aqui e colocar a reputacao dela atras de uma candidata que
 * ela conhece de praca.
 */
export function canEndorseMembership(
  store: Store,
  user: NetworkUser,
  clusterId: ClusterId = store.clusterId,
): boolean {
  return (
    isFounderOf(store, clusterId) &&
    canTransact(store) &&
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
