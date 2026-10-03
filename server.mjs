/**
 * Entrada da Vercel.
 *
 * A Vercel procura um `server.{js,mjs,ts}` na raiz e captura o `listen()` que
 * ele faz: as requisicoes chegam ao servidor `node:http` da aplicacao do jeito
 * que chegam localmente, sem os auxiliares das funcoes `/api` (que leriam o
 * corpo antes da gente). O porto do `listen()` so vale localmente.
 *
 * Aponta para o JavaScript compilado (`npm run build`), e nao para o
 * TypeScript: assim o que roda na Vercel nao depende de como ela compila
 * imports com extensao `.ts`, nem de type-stripping na versao do Node dela.
 */
import './dist/main.js';
