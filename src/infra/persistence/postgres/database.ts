/**
 * Conexao com o Postgres e a unidade de trabalho.
 *
 * A unidade de trabalho e o que o adaptador em memoria tinha de graca: o
 * processo era single-threaded, entao "carregar -> decidir -> salvar" nunca se
 * cruzava com outra requisicao (decisao 23). Aqui ela vira uma transacao, e a
 * transacao viaja pelo `AsyncLocalStorage` — os repositorios a encontram sem
 * que nenhum servico de aplicacao precise recebe-la como parametro.
 *
 * Concorrencia e otimista. Cada leitura dentro da unidade anota a versao da
 * linha; cada gravacao confere essa versao. Se outra requisicao gravou no
 * meio, a gravacao nao acha a linha, a transacao e desfeita e a unidade inteira
 * e refeita do zero. Na segunda tentativa o dominio le o estado novo e decide
 * de novo — e e ele quem responde. Duas lojas travando o mesmo carro: a
 * segunda recebe o mesmo `VEHICLE_ALREADY_LOCKED` de sempre, com a mensagem do
 * dominio, e nao um erro de banco.
 *
 * O pessimismo (`SELECT ... FOR UPDATE` em toda leitura) foi descartado: ele
 * serializaria tambem as leituras do catalogo, e duas requisicoes que leem
 * veiculo e trava em ordens diferentes fariam deadlock.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { conflictError } from '../../../domain/shared/errors.ts';

export type DatabaseConfig = {
  readonly url: string;
  /** Schema das tabelas. Fora do `public`, que o Supabase expoe na API REST. */
  readonly schema: string;
  /** Conexoes por instancia. Numa funcao serverless, poucas: cada instancia abre as suas. */
  readonly poolMax: number;
  readonly ssl: SslSetting;
};

/**
 * `verify` confere o certificado do servidor (com `caCert`, se a cadeia nao for
 * publica, como a do Supabase). `no-verify` cifra sem conferir — aceita so
 * quando pedido explicitamente. `off` e para o banco local.
 */
export type SslSetting =
  | { readonly mode: 'off' }
  | { readonly mode: 'verify'; readonly caCert: string | null }
  | { readonly mode: 'no-verify' };

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export function databaseConfigFrom(env: NodeJS.ProcessEnv): DatabaseConfig | null {
  const raw = env['DATABASE_URL'];
  if (raw === undefined || raw.trim() === '') return null;

  const url = new URL(raw);
  // O `sslmode` da URL sobrescreveria a configuracao abaixo dentro do driver, e
  // cada versao dele interpreta `require` de um jeito. Quem decide e
  // `DATABASE_SSL`, num lugar so.
  url.searchParams.delete('sslmode');

  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const sslMode = env['DATABASE_SSL'] ?? (local ? 'off' : 'verify');
  const ssl: SslSetting =
    sslMode === 'off'
      ? { mode: 'off' }
      : sslMode === 'no-verify'
        ? { mode: 'no-verify' }
        : { mode: 'verify', caCert: env['DATABASE_CA_CERT']?.replaceAll('\\n', '\n') ?? null };

  const schema = env['DATABASE_SCHEMA'] ?? 'rede';
  if (!SCHEMA_PATTERN.test(schema)) {
    throw new Error(`DATABASE_SCHEMA invalido: ${schema}`);
  }

  const poolMax = Number.parseInt(env['DATABASE_POOL_MAX'] ?? '', 10);
  return {
    url: url.toString(),
    schema,
    poolMax: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : 3,
    ssl,
  };
}

/** Outra requisicao gravou a mesma linha depois que esta a leu. */
export class ConcurrencyConflict extends Error {
  override readonly name = 'ConcurrencyConflict';
  constructor(table: string, id: string) {
    super(`Conflito de concorrencia em ${table}/${id}`);
  }
}

type UnitState = {
  readonly client: pg.PoolClient;
  /** `tabela:id` -> versao lida ou gravada nesta unidade. */
  readonly versions: Map<string, number>;
  savepoints: number;
};

/** Tentativas antes de desistir de uma unidade em conflito. */
const MAX_ATTEMPTS = 5;

/** Codigos do Postgres que significam "outra transacao chegou antes". */
const SERIALIZATION_FAILURE = '40001';
const DEADLOCK_DETECTED = '40P01';
const UNIQUE_VIOLATION = '23505';

const ONE_ACTIVE_LOCK_CONSTRAINT = 'commercial_locks_one_active_per_vehicle';

export class Database {
  readonly schema: string;
  readonly #pool: pg.Pool;
  readonly #unit = new AsyncLocalStorage<UnitState>();

  constructor(config: DatabaseConfig) {
    this.schema = config.schema;
    this.#pool = new pg.Pool({
      connectionString: config.url,
      max: config.poolMax,
      ssl:
        config.ssl.mode === 'off'
          ? false
          : config.ssl.mode === 'no-verify'
            ? { rejectUnauthorized: false }
            : config.ssl.caCert === null
              ? { rejectUnauthorized: true }
              : { rejectUnauthorized: true, ca: config.ssl.caCert },
    });
    // Conexao ociosa que cai (o pooler do Supabase derruba as paradas) nao pode
    // derrubar o processo: o pool descarta e abre outra na proxima consulta.
    this.#pool.on('error', (error) => {
      console.error('[postgres] conexao ociosa perdida:', error.message);
    });
  }

  /** Nome qualificado de uma tabela do schema da instalacao. */
  table(name: string): string {
    return `"${this.schema}"."${name}"`;
  }

  async query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<pg.QueryResult<R>> {
    const unit = this.#unit.getStore();
    return (unit?.client ?? this.#pool).query<R>(text, params as unknown[]);
  }

  /** Versoes conhecidas na unidade atual, ou `null` fora de uma unidade. */
  versions(): Map<string, number> | null {
    return this.#unit.getStore()?.versions ?? null;
  }

  /**
   * Roda `fn` num savepoint quando dentro de uma unidade. Uma falha la dentro
   * volta so ao savepoint, e a transacao segue viva — sem isso, um erro numa
   * reacao isolada (gravar um aviso) deixaria a transacao inteira abortada, e
   * a operacao de negocio cairia por causa do mural.
   */
  async isolated<T>(fn: () => Promise<T>): Promise<T> {
    const unit = this.#unit.getStore();
    if (unit === undefined) return fn();

    unit.savepoints += 1;
    const name = `iso_${unit.savepoints}`;
    await unit.client.query(`SAVEPOINT ${name}`);
    try {
      const result = await fn();
      await unit.client.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      await unit.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      throw error;
    }
  }

  async unitOfWork<T>(work: () => Promise<T>): Promise<T> {
    // Unidade dentro de unidade (o varredor chamado por uma requisicao) entra
    // na transacao que ja existe: uma operacao, uma transacao.
    if (this.#unit.getStore() !== undefined) return work();

    for (let attempt = 1; ; attempt += 1) {
      const client = await this.#pool.connect();
      let broken = false;
      try {
        await client.query('BEGIN');
        const result = await this.#unit.run({ client, versions: new Map(), savepoints: 0 }, work);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = true;
        }
        if (isRetryable(error) && attempt < MAX_ATTEMPTS) {
          await pause(attempt);
          continue;
        }
        throw translate(error);
      } finally {
        client.release(broken);
      }
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

function pgCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof ConcurrencyConflict) return true;
  const code = pgCode(error);
  // Violacao de unicidade tambem e corrida: as duas requisicoes leram "nao
  // existe" e as duas inseriram. Na nova tentativa o dominio ve o que a outra
  // gravou e responde com a regra dele.
  return code === SERIALIZATION_FAILURE || code === DEADLOCK_DETECTED || code === UNIQUE_VIOLATION;
}

/** O que sobra depois das tentativas, em erro de dominio — vira 409, nao 500. */
function translate(error: unknown): unknown {
  if (pgCode(error) === UNIQUE_VIOLATION) {
    const constraint = (error as { constraint?: unknown }).constraint;
    if (constraint === ONE_ACTIVE_LOCK_CONSTRAINT) {
      return conflictError(
        'VEHICLE_ALREADY_LOCKED',
        'Ja existe uma trava comercial ativa para este veiculo.',
      );
    }
  }
  if (isRetryable(error)) {
    return conflictError(
      'CONCURRENT_UPDATE',
      'Outra operacao alterou estes dados ao mesmo tempo. Tente de novo.',
    );
  }
  return error;
}

/** Espera curta e com jitter, para duas requisicoes em conflito nao colidirem de novo. */
function pause(attempt: number): Promise<void> {
  const ms = Math.floor(Math.random() * 10 * attempt) + 2;
  return new Promise((resolve) => setTimeout(resolve, ms));
}
