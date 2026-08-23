/**
 * Servidor HTTP.
 *
 * Responsabilidades, nesta ordem: identificar a requisicao, ler o corpo com
 * limite, resolver a identidade pela chave de API, rotear, e converter qualquer
 * falha em resposta. Nenhuma regra de negocio mora aqui.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isDomainError, InvariantViolationError } from '../domain/shared/errors.ts';
import type { AppContext } from '../application/context.ts';
import { ApiKeyRegistry, extractApiKey } from '../infra/auth/api-keys.ts';
import { Router } from './router.ts';
import {
  type HttpMethod,
  type HttpResponse,
  type RequestContext,
  errorResponse,
  json,
  sendResponse,
} from './http-types.ts';

export type ServerDependencies = {
  readonly context: AppContext;
  readonly router: Router;
  readonly apiKeys: ApiKeyRegistry;
  readonly maxBodyBytes: number;
};

export function createHttpServer(dependencies: ServerDependencies): Server {
  return createServer((request, response) => {
    void handle(dependencies, request, response);
  });
}

async function handle(
  dependencies: ServerDependencies,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestId = randomUUID();

  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const method = (request.method ?? 'GET').toUpperCase() as HttpMethod;
    const path = url.pathname;

    const match = dependencies.router.match(method, path);
    if (match === null) {
      const allowed = dependencies.router.allowedMethods(path);
      if (allowed.length > 0) {
        sendResponse(
          response,
          {
            status: 405,
            body: {
              erro: { codigo: 'METHOD_NOT_ALLOWED', mensagem: `Metodo ${method} nao aceito neste caminho.` },
              requestId,
            },
            headers: { allow: allowed.join(', ') },
          },
          requestId,
        );
        return;
      }
      sendResponse(
        response,
        json(404, {
          erro: { codigo: 'ROUTE_NOT_FOUND', mensagem: `Rota nao encontrada: ${method} ${path}` },
          requestId,
        }),
        requestId,
      );
      return;
    }

    const rawBody = await readBody(request, dependencies.maxBodyBytes);
    if (rawBody === null) {
      sendResponse(
        response,
        json(413, {
          erro: {
            codigo: 'BODY_TOO_LARGE',
            mensagem: `O corpo excede o limite de ${dependencies.maxBodyBytes} bytes.`,
          },
          requestId,
        }),
        requestId,
      );
      return;
    }

    const contentType = String(request.headers['content-type'] ?? '');
    const parsedBody = parseBody(rawBody, contentType);
    if (parsedBody.error !== null) {
      sendResponse(
        response,
        json(400, {
          erro: { codigo: 'BODY_MALFORMED', mensagem: parsedBody.error },
          requestId,
        }),
        requestId,
      );
      return;
    }

    const actor = match.isPublic
      ? null
      : await resolveActor(dependencies, extractApiKey(request.headers));

    if (!match.isPublic && actor === null) {
      sendResponse(
        response,
        json(401, {
          erro: {
            codigo: 'AUTHENTICATION_REQUIRED',
            mensagem: 'Informe uma chave de API valida em Authorization: Bearer <chave>.',
          },
          requestId,
        }),
        requestId,
      );
      return;
    }

    const requestContext: RequestContext = {
      method,
      path,
      params: match.params,
      query: url.searchParams,
      headers: request.headers,
      body: parsedBody.value,
      rawBody,
      actor,
      requestId,
    };

    const result = await match.handler(requestContext);
    sendResponse(response, result, requestId);
  } catch (error) {
    sendResponse(response, toErrorResponse(error, requestId), requestId);
  }
}

function toErrorResponse(error: unknown, requestId: string): HttpResponse {
  if (isDomainError(error)) return errorResponse(error, requestId);

  if (error instanceof InvariantViolationError) {
    // Estado impossivel: nao ha resposta util a dar, e insistir seria pior.
    console.error(`[${requestId}] invariante violada:`, error);
    return json(500, {
      erro: {
        codigo: 'INVARIANT_VIOLATION',
        mensagem: 'A operacao foi interrompida por inconsistencia interna. A equipe foi notificada.',
      },
      requestId,
    });
  }

  console.error(`[${requestId}] erro nao tratado:`, error);
  return json(500, {
    erro: { codigo: 'INTERNAL_ERROR', mensagem: 'Erro interno.' },
    requestId,
  });
}

async function resolveActor(
  dependencies: ServerDependencies,
  apiKey: string | undefined,
): Promise<RequestContext['actor']> {
  const record = dependencies.apiKeys.resolve(apiKey);
  if (record === undefined) return null;

  const store = await dependencies.context.repos.stores.byId(record.storeId);
  const user = await dependencies.context.repos.users.byId(record.userId);
  if (store === undefined || user === undefined) return null;

  return { store, user };
}

/** Le o corpo com teto de tamanho; devolve `null` se o limite for excedido. */
function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    request.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        request.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function parseBody(raw: Buffer, contentType: string): { value: unknown; error: string | null } {
  if (raw.length === 0) return { value: undefined, error: null };

  if (contentType.includes('application/json')) {
    try {
      return { value: JSON.parse(raw.toString('utf8')), error: null };
    } catch {
      return { value: undefined, error: 'O corpo nao e um JSON valido.' };
    }
  }

  // XML e texto puro chegam como string: e assim que o feed do integrador vem.
  return { value: raw.toString('utf8'), error: null };
}
