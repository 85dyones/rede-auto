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

import { createHash, timingSafeEqual } from 'node:crypto';
import type { StoreId, UserId } from '../../domain/shared/ids.ts';

export type ApiKeyRecord = {
  readonly storeId: StoreId;
  readonly userId: UserId;
  readonly label: string;
};

export class ApiKeyRegistry {
  /** hash da chave -> identidade. A chave em claro nunca fica em memoria. */
  readonly #byHash = new Map<string, ApiKeyRecord>();

  register(plainKey: string, record: ApiKeyRecord): void {
    this.#byHash.set(hashKey(plainKey), record);
  }

  resolve(plainKey: string | undefined): ApiKeyRecord | undefined {
    if (plainKey === undefined || plainKey.length === 0) return undefined;
    const candidate = hashKey(plainKey);

    // Comparacao em tempo constante para nao vazar o prefixo correto da chave
    // pelo tempo de resposta.
    for (const [hash, record] of this.#byHash) {
      if (constantTimeEquals(hash, candidate)) return record;
    }
    return undefined;
  }

  size(): number {
    return this.#byHash.size;
  }
}

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
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
