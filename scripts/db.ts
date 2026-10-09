/**
 * Comandos do banco: `migrate` e `seed`.
 *
 *   DATABASE_URL=postgres://... npm run db:migrate
 *   DATABASE_URL=postgres://... npm run db:seed
 *
 * Separados da partida da aplicacao de proposito: numa funcao serverless toda
 * partida a frio pagaria a checagem, e partidas simultaneas disputariam a
 * migracao. O seed so roda numa praca vazia — rodar duas vezes nao duplica nada.
 */

import { loadConfig } from '../src/config.ts';
import { buildApplication } from '../src/bootstrap.ts';
import { Database } from '../src/infra/persistence/postgres/database.ts';
import { migrate } from '../src/infra/persistence/postgres/migrate.ts';
import { describeSeed } from '../src/infra/seed.ts';

const command = process.argv[2];
const config = loadConfig();

if (config.database === null) {
  console.error('Defina DATABASE_URL para usar os comandos de banco.');
  process.exit(1);
}

if (command === 'migrate') {
  const db = new Database(config.database);
  const ran = await migrate(db);
  await db.close();
  console.log(
    ran.length === 0
      ? `Schema "${config.database.schema}" ja estava em dia.`
      : `Aplicadas em "${config.database.schema}": ${ran.join(', ')}.`,
  );
} else if (command === 'seed') {
  // A rede de exemplo traz chaves fixas e publicadas. Num banco de piloto com
  // lojas de verdade, isso e uma porta aberta — por isso o comando existe, e a
  // aplicacao com banco nao semeia sozinha.
  const app = await buildApplication({ config: { ...config, seedDemoData: true } });
  console.log(
    app.seed === null ? 'A rede de exemplo ja estava no banco; nada foi gravado.' : describeSeed(app.seed),
  );
  await app.stop();
} else {
  console.error('Uso: node scripts/db.ts <migrate|seed>');
  process.exit(1);
}
