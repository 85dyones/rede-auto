/**
 * Utilitarios comuns aos handlers.
 */

import { type Result, err, ok } from '../../domain/shared/result.ts';
import { type DomainError, forbiddenError } from '../../domain/shared/errors.ts';
import type { PlatformOperator } from '../../infra/auth/api-keys.ts';
import type { Actor } from '../../application/context.ts';
import type { RequestContext } from '../http-types.ts';

export function requireActor(request: RequestContext): Result<Actor, DomainError> {
  if (request.actor === null) {
    return err(
      forbiddenError('AUTHENTICATION_REQUIRED', 'Informe uma chave de API valida nesta rota.'),
    );
  }
  return ok(request.actor);
}

/**
 * So a operacao da plataforma admite ou recusa candidata. Chave de lojista nao
 * resolve para operador — sao registros separados, de proposito.
 */
export function requireOperator(request: RequestContext): Result<PlatformOperator, DomainError> {
  if (request.operator === null) {
    return err(
      forbiddenError(
        'PLATFORM_OPERATOR_REQUIRED',
        'Esta decisao e da plataforma. Informe uma chave de operacao.',
      ),
    );
  }
  return ok(request.operator);
}

export function param(request: RequestContext, name: string): string {
  return request.params[name] ?? '';
}
