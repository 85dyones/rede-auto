/**
 * Roteador minimo: casamento por segmentos com parametros `:nome`.
 *
 * Varredura linear das rotas. Com poucas dezenas de rotas isso e mais rapido do
 * que construir uma arvore, e muito mais facil de ler.
 */

import type { Handler, HttpMethod, RequestContext } from './http-types.ts';

type Route = {
  readonly method: HttpMethod;
  readonly segments: readonly string[];
  readonly handler: Handler;
  /** Rotas publicas nao exigem chave de API (lamina white-label, health). */
  readonly public: boolean;
  readonly pattern: string;
};

export type RouteMatch = {
  readonly handler: Handler;
  readonly params: Record<string, string>;
  readonly isPublic: boolean;
};

export class Router {
  readonly #routes: Route[] = [];

  add(method: HttpMethod, pattern: string, handler: Handler, options: { public?: boolean } = {}): this {
    this.#routes.push({
      method,
      pattern,
      segments: splitPath(pattern),
      handler,
      public: options.public ?? false,
    });
    return this;
  }

  get(pattern: string, handler: Handler, options?: { public?: boolean }): this {
    return this.add('GET', pattern, handler, options);
  }
  post(pattern: string, handler: Handler, options?: { public?: boolean }): this {
    return this.add('POST', pattern, handler, options);
  }
  patch(pattern: string, handler: Handler, options?: { public?: boolean }): this {
    return this.add('PATCH', pattern, handler, options);
  }
  delete(pattern: string, handler: Handler, options?: { public?: boolean }): this {
    return this.add('DELETE', pattern, handler, options);
  }

  match(method: string, path: string): RouteMatch | null {
    const segments = splitPath(path);

    for (const route of this.#routes) {
      if (route.method !== method) continue;
      const params = matchSegments(route.segments, segments);
      if (params === null) continue;
      return { handler: route.handler, params, isPublic: route.public };
    }
    return null;
  }

  /** Metodos aceitos neste caminho — alimenta o 405 e o cabecalho Allow. */
  allowedMethods(path: string): HttpMethod[] {
    const segments = splitPath(path);
    const allowed = new Set<HttpMethod>();
    for (const route of this.#routes) {
      if (matchSegments(route.segments, segments) !== null) allowed.add(route.method);
    }
    return [...allowed];
  }

  list(): Array<{ method: HttpMethod; pattern: string; public: boolean }> {
    return this.#routes.map((route) => ({
      method: route.method,
      pattern: route.pattern,
      public: route.public,
    }));
  }
}

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function matchSegments(
  pattern: readonly string[],
  actual: readonly string[],
): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;

  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index] as string;
    const received = actual[index] as string;
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(received);
      continue;
    }
    if (expected !== received) return null;
  }
  return params;
}

export type { RequestContext };
