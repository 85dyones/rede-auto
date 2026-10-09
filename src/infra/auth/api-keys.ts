/**
 * Autenticacao por chave de API.
 *
 * ADAPTADOR DE DESENVOLVIMENTO. A chave identifica um par (loja, usuario) e e
 * comparada em tempo constante contra um hash. Isso e o suficiente para uma
 * integracao servidor-a-servidor entre lojistas, e NAO e o suficiente para a
 * producao desta rede, que precisa de:
 *   - rotacao e revogacao de chave por usuario;
 *   - escopo por chave (uma chave de integracao de feed nao deveria poder
 *     fechar venda);
 *   - registro de origem e limite de requisicoes por chave.
 * Trocar por OIDC/JWT nao exige mexer nos servicos: eles so recebem `Actor`.
 */

import { createHash } from 'node:crypto';
import type { StoreId, UserId } from '../../domain/shared/ids.ts';

export type ApiKeyRecord = {
  readonly storeId: StoreId;
  readonly userId: UserId;
  readonly label: string;
};

/**
 * A plataforma tambem e um ator, e nao e loja nenhuma.
 *
 * Desde que o credenciamento deixou de ser decidido por quorum, quem admite e
 * recusa candidata e a operacao da plataforma — e ela precisa de identidade
 * propria na trilha de auditoria. Uma chave de lojista nunca resolve para
 * operador, e vice-versa: sao registros separados de proposito.
 */
export type PlatformOperator = {
  readonly operatorId: string;
  readonly name: string;
};

/**
 * Onde as chaves vivem. So o hash e gravado — a chave em claro nunca chega ao
 * repositorio, nem em memoria nem no banco.
 */
export type CredentialRepository = {
  saveStoreKey(keyHash: string, record: ApiKeyRecord): Promise<void>;
  storeKey(keyHash: string): Promise<ApiKeyRecord | undefined>;
  savePlatformKey(keyHash: string, operator: PlatformOperator): Promise<void>;
  platformKey(keyHash: string): Promise<PlatformOperator | undefined>;
};

/*
 * A busca e pelo hash SHA-256 da chave, e nao por comparacao com cada chave.
 * Antes era um laco em tempo constante sobre todas elas, para o tempo de
 * resposta nao vazar o prefixo certo; com as chaves no banco, isso seria ler a
 * tabela inteira a cada requisicao. Buscar pelo hash nao tem esse vazamento: o
 * que o tempo poderia revelar e algo sobre o hash procurado, e um hash nao
 * serve para nada sem a chave que o gerou.
 */

export class PlatformKeyRegistry {
  readonly #credentials: CredentialRepository;

  constructor(credentials: CredentialRepository) {
    this.#credentials = credentials;
  }

  async register(plainKey: string, operator: PlatformOperator): Promise<void> {
    await this.#credentials.savePlatformKey(hashKey(plainKey), operator);
  }

  async resolve(plainKey: string | undefined): Promise<PlatformOperator | undefined> {
    if (plainKey === undefined || plainKey.length === 0) return undefined;
    return this.#credentials.platformKey(hashKey(plainKey));
  }
}

export class ApiKeyRegistry {
  readonly #credentials: CredentialRepository;

  constructor(credentials: CredentialRepository) {
    this.#credentials = credentials;
  }

  async register(plainKey: string, record: ApiKeyRecord): Promise<void> {
    await this.#credentials.saveStoreKey(hashKey(plainKey), record);
  }

  async resolve(plainKey: string | undefined): Promise<ApiKeyRecord | undefined> {
    if (plainKey === undefined || plainKey.length === 0) return undefined;
    return this.#credentials.storeKey(hashKey(plainKey));
  }
}

export function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Le a chave de `Authorization: Bearer <chave>` ou de `X-Api-Key`. */
export function extractApiKey(headers: Record<string, string | string[] | undefined>): string | undefined {
  const authorization = headerValue(headers['authorization']);
  if (authorization !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match !== null) return match[1];
  }
  return headerValue(headers['x-api-key']);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
