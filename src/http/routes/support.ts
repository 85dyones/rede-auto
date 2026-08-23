/**
 * Utilitarios comuns aos handlers.
 */

import { type Result, err, ok } from '../../domain/shared/result.ts';
import { type DomainError, forbiddenError } from '../../domain/shared/errors.ts';
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

export function param(request: RequestContext, name: string): string {
  return request.params[name] ?? '';
}
