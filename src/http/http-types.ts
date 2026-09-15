/**
 * Tipos e utilitarios da camada HTTP.
 *
 * Escrito sobre `node:http` direto. Um framework traria roteamento, parsing de
 * corpo e middleware — as tres coisas que este arquivo faz em ~100 linhas — em
 * troca de uma dependencia no caminho critico de uma aplicacao que lida com
 * dado financeiro de terceiros. A troca nao compensa neste tamanho.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ErrorKind, type DomainError } from '../domain/shared/errors.ts';
import type { PlatformOperator } from '../infra/auth/api-keys.ts';
import type { Actor } from '../application/context.ts';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type RequestContext = {
  readonly method: HttpMethod;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly headers: IncomingMessage['headers'];
  /** Corpo ja interpretado: objeto para JSON, string para XML e texto. */
  readonly body: unknown;
  readonly rawBody: Buffer;
  /** Preenchido nas rotas autenticadas. */
  readonly actor: Actor | null;
  /** Operador da plataforma, quando a chave e de operacao e nao de lojista. */
  readonly operator: PlatformOperator | null;
  readonly requestId: string;
};

export type HttpResponse = {
  readonly status: number;
  readonly body?: unknown;
  readonly raw?: Buffer | string;
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, string>>;
};

export type Handler = (request: RequestContext) => Promise<HttpResponse> | HttpResponse;

export const json = (status: number, body: unknown): HttpResponse => ({ status, body });
export const noContent = (): HttpResponse => ({ status: 204 });

export function html(status: number, markup: string): HttpResponse {
  return { status, raw: markup, contentType: 'text/html; charset=utf-8' };
}

export function pdf(fileName: string, bytes: Buffer): HttpResponse {
  return {
    status: 200,
    raw: bytes,
    contentType: 'application/pdf',
    headers: { 'content-disposition': `inline; filename="${fileName}"` },
  };
}

export function redirect(location: string): HttpResponse {
  return { status: 302, headers: { location } };
}

/**
 * Familia do erro de dominio -> status HTTP.
 *
 * O mapeamento vive aqui, e nao no dominio: o dominio nao deve saber que existe
 * HTTP. Um consumidor de fila usaria o mesmo `DomainError` sem passar por aqui.
 */
export function statusFor(error: DomainError): number {
  switch (error.kind) {
    case ErrorKind.VALIDATION:
      return 400;
    case ErrorKind.FORBIDDEN:
      return 403;
    case ErrorKind.NOT_FOUND:
      return 404;
    case ErrorKind.CONFLICT:
      return 409;
    case ErrorKind.RULE_VIOLATION:
      return 422;
  }
}

export function errorResponse(error: DomainError, requestId: string): HttpResponse {
  return {
    status: statusFor(error),
    body: {
      erro: {
        codigo: error.code,
        mensagem: error.message,
        ...(error.details === undefined ? {} : { detalhes: error.details }),
      },
      requestId,
    },
  };
}

export function sendResponse(
  response: ServerResponse,
  result: HttpResponse,
  requestId: string,
): void {
  const headers: Record<string, string> = {
    'x-request-id': requestId,
    // A API e B2B e servida por cliente proprio; nada aqui deve ser embutido
    // em pagina de terceiro nem farejado como outro tipo.
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(result.headers ?? {}),
  };

  if (result.raw !== undefined) {
    const payload = Buffer.isBuffer(result.raw) ? result.raw : Buffer.from(result.raw, 'utf8');
    headers['content-type'] = result.contentType ?? 'application/octet-stream';
    headers['content-length'] = String(payload.length);
    response.writeHead(result.status, headers);
    response.end(payload);
    return;
  }

  if (result.body === undefined) {
    response.writeHead(result.status, headers);
    response.end();
    return;
  }

  const payload = Buffer.from(JSON.stringify(result.body, null, 2), 'utf8');
  headers['content-type'] = 'application/json; charset=utf-8';
  headers['content-length'] = String(payload.length);
  response.writeHead(result.status, headers);
  response.end(payload);
}
