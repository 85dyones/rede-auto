/**
 * Composicao da aplicacao: e aqui que as pecas se conhecem.
 *
 * Este e o unico arquivo que sabe, ao mesmo tempo, que existe um dominio, uma
 * persistencia e um servidor HTTP. Todo o resto depende so de portas, e e por
 * isso que trocar o adaptador de banco ou o de autenticacao nao encosta em
 * regra de negocio.
 */

import { SystemClock, type Clock } from './domain/shared/clock.ts';
import { randomIdGenerator, type IdGenerator } from './domain/shared/ids.ts';
import { EventBus } from './domain/shared/events.ts';
import { type AppConfig, loadConfig } from './config.ts';
import type { AppContext } from './application/context.ts';
import { startSweeper, type Sweeper } from './application/scheduler.ts';
import { createInMemoryRepositories, type Repositories } from './infra/persistence/repositories.ts';
import { ApiKeyRegistry } from './infra/auth/api-keys.ts';
import { Router } from './http/router.ts';
import { json } from './http/http-types.ts';
import { registerNetworkRoutes } from './http/routes/network.ts';
import { registerInventoryRoutes } from './http/routes/inventory.ts';
import { registerCustodyRoutes } from './http/routes/custody.ts';
import { registerDealRoutes } from './http/routes/deals.ts';
import { registerSharingRoutes } from './http/routes/sharing.ts';
import { registerFeedRoutes } from './http/routes/feeds.ts';
import { createHttpServer } from './http/server.ts';
import { seedFoundingNetwork, type SeedResult } from './infra/seed.ts';
import type { Server } from 'node:http';

export type Application = {
  readonly config: AppConfig;
  readonly context: AppContext;
  readonly router: Router;
  readonly apiKeys: ApiKeyRegistry;
  readonly server: Server;
  readonly seed: SeedResult | null;
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
};

export type BuildOptions = {
  readonly config?: AppConfig;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly repositories?: Repositories;
  /** Semear o estoque de exemplo junto com as lojas. Padrao: sim. */
  readonly seedVehicles?: boolean;
};

export async function buildApplication(options: BuildOptions = {}): Promise<Application> {
  const config = options.config ?? loadConfig();
  const context: AppContext = {
    clock: options.clock ?? SystemClock,
    ids: options.ids ?? randomIdGenerator,
    events: new EventBus(),
    policies: config.policies,
    repos: options.repositories ?? createInMemoryRepositories(),
  };

  const apiKeys = new ApiKeyRegistry();
  const router = buildRouter(context, config);

  const seed = config.seedDemoData
    ? await seedFoundingNetwork(context, apiKeys, {
        includeVehicles: options.seedVehicles ?? true,
      })
    : null;

  const server = createHttpServer({
    context,
    router,
    apiKeys,
    maxBodyBytes: config.maxRequestBodyBytes,
  });

  let sweeper: Sweeper | null = null;

  return {
    config,
    context,
    router,
    apiKeys,
    server,
    seed,

    async start() {
      const port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          const address = server.address();
          resolve(typeof address === 'object' && address !== null ? address.port : config.port);
        });
      });
      sweeper = startSweeper(context, config.sweepIntervalMs);
      return { port };
    },

    async stop() {
      sweeper?.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function buildRouter(context: AppContext, config: AppConfig): Router {
  const router = new Router();

  router.get(
    '/health',
    async () =>
      json(200, {
        status: 'ok',
        agora: new Date(context.clock.now()).toISOString(),
        politicas: {
          travaHoras: config.policies.lock.baseTtlMs / 3_600_000,
          travaTetoHoras: config.policies.lock.maxTotalMs / 3_600_000,
          recallHorasUteis: config.policies.recall.slaBusinessHours,
          avaisNecessarios: config.policies.governance.requiredApprovals,
          fundadoras: config.policies.governance.founderCount,
        },
      }),
    { public: true },
  );

  router.get(
    '/api/v1',
    async () =>
      json(200, {
        nome: 'rede-auto',
        descricao:
          'Rede B2B fechada para compartilhamento de estoque e custodia fisica de veiculos seminovos.',
        rotas: router.list().map((route) => ({
          metodo: route.method,
          caminho: route.pattern,
          publica: route.public,
        })),
      }),
    { public: true },
  );

  registerNetworkRoutes(router, context);
  registerInventoryRoutes(router, context);
  registerCustodyRoutes(router, context);
  registerDealRoutes(router, context);
  registerSharingRoutes(router, context, config.publicBaseUrl);
  registerFeedRoutes(router, context);

  return router;
}
