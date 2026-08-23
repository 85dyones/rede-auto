/**
 * Ponto de entrada do servidor.
 *
 * Sobe a aplicacao, imprime o que o desenvolvedor precisa para comecar a usar
 * a API na hora, e desliga com calma no SIGINT/SIGTERM — encerrar no meio de
 * uma liquidacao deixaria o lojista sem saber se o pagamento foi registrado.
 */

import { buildApplication } from './bootstrap.ts';
import { describeSeed } from './infra/seed.ts';

const application = await buildApplication();
const { port } = await application.start();

console.log(`rede-auto ouvindo em http://localhost:${port}`);
console.log(`  catalogo da rede   GET  /api/v1/veiculos`);
console.log(`  indice das rotas   GET  /api/v1`);
console.log(`  saude              GET  /health`);

if (application.seed !== null) {
  console.log('');
  console.log(describeSeed(application.seed));
}

let shuttingDown = false;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} recebido, encerrando...`);
    void application.stop().then(() => process.exit(0));
  });
}
