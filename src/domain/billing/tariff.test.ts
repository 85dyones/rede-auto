import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  FOUNDER_FREEZE_MONTHS,
  PILOT_TARIFF,
  type TariffTable,
  adhesionCharge,
  freezeEndsAt,
  isTariffFrozen,
  monthlyCharge,
  tariffFor,
  tariffInEffect,
} from './tariff.ts';
import { MemberKind } from '../network/member.ts';
import { buildMember } from '../../testing/builders.ts';
import { addMonths, DAY } from '../shared/clock.ts';
import { fromReais } from '../shared/money.ts';

const ENTRADA = Date.parse('2026-03-09T12:00:00Z');

/** Tabela seguinte, mais cara: e o "quem entra depois paga mais". */
const TABELA_2027: TariffTable = {
  version: '2027-01',
  effectiveFrom: Date.parse('2027-01-01T00:00:00Z'),
  adhesion: fromReais(9_000),
  founderAdhesion: fromReais(4_500),
  monthlyPerCompany: fromReais(699),
  monthlyPerExtraStore: fromReais(189),
};
const TABELAS = [PILOT_TARIFF, TABELA_2027];

describe('a conta da mensalidade', () => {
  test('empresa com uma loja paga so a linha da empresa', () => {
    // R$ 599 com a primeira loja inclusa — a regra que o produto definiu.
    const conta = monthlyCharge(PILOT_TARIFF, 1);
    assert.equal(conta.extraStores, 0);
    assert.equal(conta.total.cents, 59_900);
  });

  test('cada patio alem do primeiro soma R$ 159', () => {
    assert.equal(monthlyCharge(PILOT_TARIFF, 2).total.cents, 59_900 + 15_900);
    assert.equal(monthlyCharge(PILOT_TARIFF, 4).total.cents, 59_900 + 3 * 15_900);
  });

  test('empresa sem patio nenhum ainda paga a linha da empresa', () => {
    // O contrato e da empresa, nao do patio. "Credenciada sem patio" so existe
    // se alguem fechou o ultimo, e fechar patio nao encerra contrato.
    const conta = monthlyCharge(PILOT_TARIFF, 0);
    assert.equal(conta.extraStores, 0);
    assert.equal(conta.total.cents, 59_900);
  });

  test('a memoria de calculo diz de onde veio o numero', () => {
    const conta = monthlyCharge(PILOT_TARIFF, 3);
    assert.equal(conta.tariffVersion, PILOT_TARIFF.version);
    assert.equal(conta.company.cents, 59_900);
    assert.equal(conta.extraStores, 2);
    assert.equal(conta.perExtraStore.cents, 15_900);
    assert.equal(conta.total.cents, conta.company.cents + 2 * conta.perExtraStore.cents);
  });
});

describe('adesao', () => {
  test('fundadora paga a linha de fundadora; quem entra depois, a cheia', () => {
    const fundadora = buildMember({ kind: MemberKind.FOUNDER });
    const membro = buildMember({ kind: MemberKind.MEMBER });

    assert.equal(adhesionCharge(PILOT_TARIFF, fundadora).cents, 300_000);
    assert.equal(adhesionCharge(PILOT_TARIFF, membro).cents, 600_000);
  });

  test('a tabela seguinte cobra mais de quem entra depois', () => {
    // E o incentivo de entrar cedo: nao ha formula de reajuste, ha uma tabela
    // nova que alguem decidiu publicar.
    const membro = buildMember({ kind: MemberKind.MEMBER });
    assert.ok(adhesionCharge(TABELA_2027, membro).cents > adhesionCharge(PILOT_TARIFF, membro).cents);
  });
});

describe('vigencia da tabela', () => {
  test('vale a mais recente que ja entrou em vigor', () => {
    assert.equal(tariffInEffect(TABELAS, ENTRADA)?.version, '2026-03');
    assert.equal(tariffInEffect(TABELAS, TABELA_2027.effectiveFrom)?.version, '2027-01');
    assert.equal(
      tariffInEffect(TABELAS, TABELA_2027.effectiveFrom - 1)?.version,
      '2026-03',
      'um milissegundo antes ainda e a anterior',
    );
  });

  test('antes da primeira vigencia nao ha tabela', () => {
    assert.equal(tariffInEffect(TABELAS, PILOT_TARIFF.effectiveFrom - 1), undefined);
  });
});

describe('congelamento de 24 meses da fundadora', () => {
  const fundadora = buildMember({ kind: MemberKind.FOUNDER, joinedAt: ENTRADA });
  const membro = buildMember({ kind: MemberKind.MEMBER, joinedAt: ENTRADA });

  test('o prazo e derivado de joinedAt, nao guardado', () => {
    assert.equal(freezeEndsAt(fundadora), addMonths(ENTRADA, FOUNDER_FREEZE_MONTHS));
    assert.equal(freezeEndsAt(membro), null, 'so fundadora congela');
  });

  test('dentro dos 24 meses a fundadora segue na tabela que assinou', () => {
    const depoisDaAlta = TABELA_2027.effectiveFrom + 30 * DAY;
    assert.equal(isTariffFrozen(fundadora, depoisDaAlta), true);

    const dela = tariffFor(fundadora, PILOT_TARIFF.version, TABELAS, depoisDaAlta);
    assert.equal(dela.version, '2026-03');
    assert.equal(monthlyCharge(dela, 2).total.cents, 59_900 + 15_900);
  });

  test('o congelamento cobre a TABELA INTEIRA, inclusive o patio adicional', () => {
    // A decisao de produto: patio aberto no mes 10 entra pelo preco congelado.
    // Congelar so a linha da empresa faria a fundadora descobrir o reajuste no
    // momento em que decidisse crescer.
    const noMes10 = addMonths(ENTRADA, 10);
    const dela = tariffFor(fundadora, PILOT_TARIFF.version, TABELAS, noMes10);

    assert.equal(dela.monthlyPerExtraStore.cents, 15_900, 'e nao os 18.900 da tabela nova');
  });

  test('vencidos os 24 meses, migra para a vigente', () => {
    const depois = addMonths(ENTRADA, FOUNDER_FREEZE_MONTHS) + 1;
    assert.equal(isTariffFrozen(fundadora, depois), false);
    assert.equal(tariffFor(fundadora, PILOT_TARIFF.version, TABELAS, depois).version, '2027-01');
  });

  test('no instante exato do fim ja migrou — o limite cai de um lado so', () => {
    const noLimite = addMonths(ENTRADA, FOUNDER_FREEZE_MONTHS);
    assert.equal(isTariffFrozen(fundadora, noLimite), false);
  });

  test('membro comum nunca congela: segue a vigente desde o primeiro dia', () => {
    const depoisDaAlta = TABELA_2027.effectiveFrom + DAY;
    assert.equal(tariffFor(membro, PILOT_TARIFF.version, TABELAS, depoisDaAlta).version, '2027-01');
  });

  test('versao assinada que sumiu da lista cai na vigente, em vez de estourar', () => {
    // Nao emitir fatura nenhuma seria um erro silencioso que so aparece no
    // caixa; cobrar pelo preco de hoje e visivel e corrigivel.
    const dela = tariffFor(fundadora, 'versao-que-nao-existe', TABELAS, ENTRADA + DAY);
    assert.equal(dela.version, '2026-03');
  });
});
