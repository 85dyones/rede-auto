/**
 * Aplica as migracoes que faltam, em ordem, todas numa transacao: ou o
 * esquema sobe inteiro, ou nada muda.
 *
 * Roda por comando (`npm run db:migrate`), e nao a cada partida da aplicacao:
 * numa funcao serverless, toda partida a frio pagaria a checagem, e varias
 * partidas simultaneas disputariam a mesma migracao. A trava consultiva cobre
 * quem rodar o comando duas vezes ao mesmo tempo.
 */

import type { Database } from './database.ts';
import { MIGRATIONS } from './migrations.ts';

/** Chave fixa da trava consultiva das migracoes. */
const MIGRATION_LOCK_KEY = 4_217_001;

export async function migrate(db: Database): Promise<string[]> {
  return db.unitOfWork(async () => {
    await db.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
    await db.query(`CREATE SCHEMA IF NOT EXISTS "${db.schema}"`);
    await db.query(`SET LOCAL search_path TO "${db.schema}"`);

    const tracked = await db.query<{ exists: string | null }>(
      'SELECT to_regclass($1) AS exists',
      [`"${db.schema}".schema_migrations`],
    );
    const applied = new Set<string>();
    if (tracked.rows[0]?.exists !== null) {
      const rows = await db.query<{ version: string }>('SELECT version FROM schema_migrations');
      for (const row of rows.rows) applied.add(row.version);
    }

    const ran: string[] = [];
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      await db.query(migration.sql);
      await db.query('INSERT INTO schema_migrations (version) VALUES ($1)', [migration.version]);
      ran.push(migration.version);
    }
    return ran;
  });
}
