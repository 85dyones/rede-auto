/**
 * Tabela de precos da rede — versionada, com data de vigencia.
 *
 * Duas receitas, e nenhuma delas por transacao:
 *
 *  - ADESAO, uma vez por empresa. Fundadora paga menos. Fica com a plataforma,
 *    nao e caucao, nao volta.
 *  - MENSALIDADE, por empresa, com o primeiro patio incluso, mais um valor por
 *    patio adicional.
 *
 * A ausencia de taxa por transacao e decisao de produto, e e o que mantem o
 * processo inteiro dentro da plataforma: cobrar por repasse fechado criaria
 * exatamente dois incentivos ruins — combinar por fora e subdeclarar o valor.
 * Cobrando so acesso, quem usa mais nao paga mais por usar, e a unica forma de
 * a receita crescer e a rede crescer.
 *
 * VERSIONADA porque o preco sobe: quem entra depois paga adesao maior, para
 * premiar quem entrou no comeco. E "sobe" por ato de governanca, nao por
 * formula — nao ha reajuste automatico aqui de proposito. Um escalonador
 * embutido aumentaria preco sem ninguem ter decidido aumentar, e a primeira
 * noticia seria a fatura do lojista.
 */

import { type Money, fromReais } from '../shared/money.ts';
import { type Instant, addMonths } from '../shared/clock.ts';
import { assertInvariant } from '../shared/errors.ts';
import { type Member, isFoundingMember } from '../network/member.ts';

export type TariffTable = {
  /** Identificador estavel e legivel. Vai na cobranca e no contrato. */
  readonly version: string;
  readonly effectiveFrom: Instant;
  /** Adesao de quem entra depois de fechada a janela de fundacao. */
  readonly adhesion: Money;
  /**
   * Adesao de fundadora. Numero proprio, e nao uma fracao da outra: guardar
   * "metade" faria as duas linhas ficarem presas uma na outra para sempre, e a
   * tabela precisa poder move-las em ritmos diferentes.
   */
  readonly founderAdhesion: Money;
  /** Mensalidade da empresa, com o PRIMEIRO patio incluso. */
  readonly monthlyPerCompany: Money;
  /**
   * Cada patio alem do primeiro.
   *
   * Cobrar por patio nao e cobrar duas vezes pelo mesmo servico: o volume da
   * rede beneficia cada expositor, e cada patio a mais e mais estoque a
   * sincronizar, mais custodia a rastrear e mais gente na plataforma.
   */
  readonly monthlyPerExtraStore: Money;
};

/**
 * Meses em que a fundadora fica na tabela que assinou.
 *
 * Congela a TABELA INTEIRA, e nao so a linha da empresa: patio aberto no mes 10
 * entra pelo preco congelado. A alternativa — congelar so os R$ 599 — faria a
 * fundadora descobrir o reajuste no momento em que decidisse crescer, que e
 * exatamente o momento em que a rede quer que ela cresca.
 */
export const FOUNDER_FREEZE_MONTHS = 24;

/** A tabela vigente na constituicao do piloto. */
export const PILOT_TARIFF: TariffTable = {
  version: '2026-03',
  effectiveFrom: Date.parse('2026-01-01T00:00:00Z'),
  adhesion: fromReais(6_000),
  founderAdhesion: fromReais(3_000),
  monthlyPerCompany: fromReais(599),
  monthlyPerExtraStore: fromReais(159),
};

export const DEFAULT_TARIFF_TABLES: readonly TariffTable[] = [PILOT_TARIFF];

// ---------------------------------------------------------------------------
// Resolucao
// ---------------------------------------------------------------------------

/** A tabela vigente num instante: a mais recente que ja entrou em vigor. */
export function tariffInEffect(
  tables: readonly TariffTable[],
  at: Instant,
): TariffTable | undefined {
  return tables
    .filter((table) => table.effectiveFrom <= at)
    .reduce<TariffTable | undefined>(
      (latest, table) =>
        latest === undefined || table.effectiveFrom > latest.effectiveFrom ? table : latest,
      undefined,
    );
}

export function tariffByVersion(
  tables: readonly TariffTable[],
  version: string,
): TariffTable | undefined {
  return tables.find((table) => table.version === version);
}

/**
 * Ate quando a tabela desta empresa esta congelada. `null` para quem nao e
 * fundadora.
 *
 * Derivado, nao guardado: `joinedAt` mais 24 meses ja responde, e um campo
 * `frozenUntil` seria um segundo registro do mesmo fato — o tipo de copia que
 * so serve para divergir do original quando alguem editar um dos dois.
 */
export function freezeEndsAt(member: Member): Instant | null {
  return isFoundingMember(member) ? addMonths(member.joinedAt, FOUNDER_FREEZE_MONTHS) : null;
}

export function isTariffFrozen(member: Member, at: Instant): boolean {
  const until = freezeEndsAt(member);
  return until !== null && at < until;
}

/**
 * A tabela que vale para esta empresa agora.
 *
 * Fundadora dentro dos 24 meses fica na tabela que assinou; todo mundo mais
 * segue a vigente. Se a versao assinada nao existir mais na lista — tabela
 * removida por engano, migracao mal feita — cai na vigente em vez de estourar:
 * cobrar pelo preco de hoje e um erro visivel e corrigivel, e nao emitir
 * fatura nenhuma e um erro silencioso que so aparece no caixa.
 */
export function tariffFor(
  member: Member,
  signedVersion: string,
  tables: readonly TariffTable[],
  at: Instant,
): TariffTable {
  const current = tariffInEffect(tables, at);
  assertInvariant(current !== undefined, `nenhuma tabela de precos vigente em ${at}`);

  if (!isTariffFrozen(member, at)) return current;
  return tariffByVersion(tables, signedVersion) ?? current;
}

// ---------------------------------------------------------------------------
// Calculo
// ---------------------------------------------------------------------------

export type MonthlyBreakdown = {
  readonly tariffVersion: string;
  /** A linha da empresa, com o primeiro patio incluso. */
  readonly company: Money;
  /** Quantos patios alem do primeiro. Contagem do repositorio, nunca campo. */
  readonly extraStores: number;
  readonly perExtraStore: Money;
  readonly total: Money;
};

/**
 * A mensalidade de uma empresa com `storeCount` patios.
 *
 * `storeCount` vem contado de `stores.byMember` — um numero guardado no membro
 * seria o mesmo erro do antigo `founderCount`, com o agravante de sair na
 * fatura. Empresa sem patio nenhum paga a linha da empresa mesmo assim: o
 * contrato e dela, nao do patio, e o estado "credenciada sem patio" so existe
 * se alguem fechou o ultimo — o que nao encerra o contrato.
 */
export function monthlyCharge(table: TariffTable, storeCount: number): MonthlyBreakdown {
  assertInvariant(
    Number.isInteger(storeCount) && storeCount >= 0,
    `contagem de patios invalida: ${storeCount}`,
  );

  const extraStores = Math.max(0, storeCount - 1);
  const extras = table.monthlyPerExtraStore.cents * extraStores;

  return {
    tariffVersion: table.version,
    company: table.monthlyPerCompany,
    extraStores,
    perExtraStore: table.monthlyPerExtraStore,
    total: { currency: 'BRL', cents: table.monthlyPerCompany.cents + extras },
  };
}

/** A adesao desta empresa: fundadora paga a linha de fundadora. */
export function adhesionCharge(table: TariffTable, member: Member): Money {
  return isFoundingMember(member) ? table.founderAdhesion : table.adhesion;
}

export function describeTariff(table: TariffTable): string {
  return (
    `tabela ${table.version}: adesao ${table.adhesion.cents / 100} ` +
    `(fundadora ${table.founderAdhesion.cents / 100}), mensal ` +
    `${table.monthlyPerCompany.cents / 100} + ${table.monthlyPerExtraStore.cents / 100}/patio`
  );
}
