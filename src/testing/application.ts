/**
 * A aplicacao dos testes de servico e de API, em memoria ou no Postgres.
 *
 * Sem `TEST_DATABASE_URL`, e `buildApplication` puro. Com ela, cada aplicacao
 * ganha um schema proprio e novo no banco, migrado na hora e apagado no
 * `stop()`. E o que deixa a mesma suite rodar contra os dois adaptadores: o
 * teste nao sabe onde os dados estao, e e exatamente essa a promessa das portas.
 *
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/rede_auto_test npm run test:pg
 */

import { randomUUID } from 'node:crypto';
import { buildApplication, type Application, type BuildOptions } from '../bootstrap.ts';
import { Database, databaseConfigFrom } from '../infra/persistence/postgres/database.ts';
import { migrate } from '../infra/persistence/postgres/migrate.ts';
import { createPostgresRepositories } from '../infra/persistence/postgres/repositories.ts';

export async function buildTestApplication(options: BuildOptions = {}): Promise<Application> {
  const url = process.env['TEST_DATABASE_URL'];
  if (url === undefined || url === '') return buildApplication(options);

  const schema = `rede_t_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const config = databaseConfigFrom({ DATABASE_URL: url, DATABASE_SCHEMA: schema });
  if (config === null) throw new Error('TEST_DATABASE_URL invalida');

  const db = new Database(config);
  await migrate(db);

  const app = await buildApplication({ ...options, repositories: createPostgresRepositories(db) });
  return {
    ...app,
    async stop() {
      await app.stop();
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    },
  };
}
