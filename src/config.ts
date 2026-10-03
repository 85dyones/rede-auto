/**
 * Configuracao da instalacao: politicas de negocio e parametros de execucao.
 *
 * As politicas vivem aqui, e nao dentro do dominio, porque sao decisao do
 * contrato da rede — o prazo da trava, o SLA do recall e o quorum de
 * credenciamento sao clausulas, nao regras universais. O dominio recebe a
 * politica como parametro e nunca importa este arquivo; a dependencia aponta
 * so num sentido.
 */

import { type GovernancePolicy, DEFAULT_GOVERNANCE_POLICY } from './domain/network/membership.ts';
import { type LockPolicy, DEFAULT_LOCK_POLICY } from './domain/lock/evidence.ts';
import { type CustodyPolicy, DEFAULT_CUSTODY_POLICY } from './domain/custody/custody.ts';
import type { RecallPolicy } from './domain/recall/recall.ts';
import {
  type BusinessCalendar,
  brazilianNationalHolidays,
  curitibaRegionalHolidays,
  mergeHolidays,
  timeWindow,
} from './domain/shared/business-hours.ts';
import { MINUTE } from './domain/shared/clock.ts';
import { DEFAULT_BILLING_POLICY, type BillingPolicy } from './domain/billing/charge.ts';
import { DEFAULT_TARIFF_TABLES, type TariffTable } from './domain/billing/tariff.ts';
import { DEFAULT_CONDUCT_POLICY, type ConductPolicy } from './domain/conduct/breach.ts';
import { DEFAULT_EXIT_POLICY, type ExitPolicy } from './domain/network/exit.ts';
import {
  DEFAULT_EXPULSION_POLICY,
  type ExpulsionPolicy,
} from './domain/network/expulsion.ts';
import { type DatabaseConfig, databaseConfigFrom } from './infra/persistence/postgres/database.ts';

export type NetworkPolicies = {
  readonly governance: GovernancePolicy;
  readonly lock: LockPolicy;
  readonly recall: RecallPolicy;
  readonly custody: CustodyPolicy;
  readonly billing: BillingPolicy;
  readonly conduct: ConductPolicy;
  readonly exit: ExitPolicy;
  readonly expulsion: ExpulsionPolicy;
  /**
   * Tabelas de preco, todas as versoes. Uma lista, e nao a vigente, porque a
   * fundadora fica na que assinou por 24 meses — a versao antiga precisa
   * continuar existindo para poder ser cobrada.
   */
  readonly tariffs: readonly TariffTable[];
};

/**
 * Expediente da rede: segunda a sexta 08:00-18:00 e sabado 09:00-13:00.
 * Loja de seminovos abre sabado, e ignorar isso inflaria todo prazo pedido na
 * sexta a tarde.
 *
 * O fuso e `America/Sao_Paulo`, que e o identificador IANA do horario de
 * Brasilia — cobre o Parana igualmente, apesar do nome.
 *
 * Os feriados sao os nacionais **mais** os da praca do piloto. Enquanto houver
 * um cluster so, o calendario da instalacao e o calendario da praca; quando a
 * segunda existir, ele se muda para o cluster (ver `decisoes.md`).
 */
export function defaultCalendar(referenceYear = new Date().getUTCFullYear()): BusinessCalendar {
  const years = [referenceYear - 1, referenceYear, referenceYear + 1, referenceYear + 2];
  return {
    timeZone: 'America/Sao_Paulo',
    workdays: [1, 2, 3, 4, 5, 6],
    windows: [timeWindow('08:00', '18:00')],
    windowsByWeekday: { 6: [timeWindow('09:00', '13:00')] },
    holidays: mergeHolidays(
      brazilianNationalHolidays(years),
      curitibaRegionalHolidays(years),
    ),
  };
}

export function defaultPolicies(referenceYear?: number): NetworkPolicies {
  return {
    governance: DEFAULT_GOVERNANCE_POLICY,
    billing: DEFAULT_BILLING_POLICY,
    conduct: DEFAULT_CONDUCT_POLICY,
    exit: DEFAULT_EXIT_POLICY,
    expulsion: DEFAULT_EXPULSION_POLICY,
    tariffs: DEFAULT_TARIFF_TABLES,
    lock: DEFAULT_LOCK_POLICY,
    recall: {
      slaBusinessHours: 4,
      // Disponibilizar um carro no patio nao e organizar transporte.
      pickupReadinessBusinessHours: 1,
      calendar: defaultCalendar(referenceYear),
    },
    custody: DEFAULT_CUSTODY_POLICY,
  };
}

export type AppConfig = {
  readonly port: number;
  readonly host: string;
  /** Base publica usada para montar os links white-label. */
  readonly publicBaseUrl: string;
  /**
   * Intervalo do varredor de travas vencidas e SLAs estourados, ou `null` para
   * nao rodar no processo. Na Vercel o processo nao e continuo, e cada
   * instancia varreria por conta propria: la quem dispara e o cron.
   */
  readonly sweepIntervalMs: number | null;
  /**
   * Segredo que o cron apresenta em `Authorization: Bearer`. Sem ele, a rota de
   * varredura por GET nao existe.
   */
  readonly cronSecret: string | null;
  readonly maxRequestBodyBytes: number;
  readonly policies: NetworkPolicies;
  /** Popula a rede com as fundadoras de exemplo, as chaves fixas e o estoque. */
  readonly seedDemoData: boolean;
  /** Postgres, quando `DATABASE_URL` existe. Sem ela, tudo fica em memoria. */
  readonly database: DatabaseConfig | null;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const database = databaseConfigFrom(env);
  return {
    port: readInt(env['PORT'], 3000),
    host: env['HOST'] ?? '0.0.0.0',
    publicBaseUrl: (env['PUBLIC_BASE_URL'] ?? `http://localhost:${readInt(env['PORT'], 3000)}`).replace(
      /\/+$/,
      '',
    ),
    // A trava tem granularidade de horas; varrer a cada minuto e mais que
    // suficiente e mantem os eventos de expiracao pontuais.
    sweepIntervalMs: sweepIntervalFrom(env),
    cronSecret: env['CRON_SECRET']?.trim() || null,
    maxRequestBodyBytes: readInt(env['MAX_BODY_BYTES'], 40 * 1024 * 1024),
    policies: defaultPolicies(),
    seedDemoData: seedDemoDataFrom(env, database),
    database,
  };
}

/**
 * Em memoria, a rede de exemplo e o padrao: sem ela nao ha com o que testar.
 * Com banco, e o contrario — so semeia quem pedir. Semear por padrao poria dez
 * lojas ficticias e chaves publicadas no log dentro do banco de um piloto.
 */
function seedDemoDataFrom(env: NodeJS.ProcessEnv, database: DatabaseConfig | null): boolean {
  const flag = env['SEED_DEMO_DATA'];
  return database === null ? flag !== 'false' : flag === 'true';
}

/** `SWEEP_INTERVAL_MS=0` desliga; na Vercel (`VERCEL` definida) o padrao e desligado. */
function sweepIntervalFrom(env: NodeJS.ProcessEnv): number | null {
  const raw = env['SWEEP_INTERVAL_MS'];
  if (raw === '0') return null;
  if (raw === undefined && env['VERCEL'] !== undefined) return null;
  return readInt(raw, MINUTE);
}

function readInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
