/**
 * Loja participante da rede e seus usuarios.
 *
 * A rede e fechada e qualificada: nao existe autocadastro. Uma loja so passa a
 * existir como membro depois de aprovada pelo quorum de fundadores
 * (ver `membership.ts`). As 6 lojas fundadoras sao criadas na constituicao da
 * rede e sao as unicas com direito a voto.
 */

import { type Result, ok, err, combine } from '../shared/result.ts';
import { type DomainError, validationError } from '../shared/errors.ts';
import type { Instant } from '../shared/clock.ts';
import type { StoreId, UserId } from '../shared/ids.ts';
import { parseCnpj, requireText, requireOneOf } from '../shared/validation.ts';

export const StoreKind = {
  /** Uma das 6 lojas constituintes. Tem direito a voto no credenciamento. */
  FOUNDER: 'FOUNDER',
  /** Loja credenciada depois, por aval dos fundadores. Sem direito a voto. */
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
  /** Abre e estende travas, monta negociacao, gera lamina white-label. */
  SALESPERSON: 'SALESPERSON',
  /** Tudo do vendedor + preco liquido, aceite de transbordo, recall, custodia. */
  MANAGER: 'MANAGER',
  /** Tudo do gerente + voto de credenciamento (apenas em loja fundadora). */
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
  readonly profile: StoreProfile;
  readonly kind: StoreKind;
  readonly status: StoreStatus;
  readonly joinedAt: Instant;
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
 * aprovacao: fundador nao deve gastar voto analisando ficha incompleta.
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

export function canTransact(store: Store): boolean {
  return store.status === StoreStatus.ACTIVE;
}

/**
 * Voto de credenciamento exige loja fundadora ativa e usuario titular.
 * Concentrar a regra aqui evita reimplementa-la em cada rota.
 */
export function canVoteOnMembership(store: Store, user: NetworkUser): boolean {
  return (
    isFounder(store) &&
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
