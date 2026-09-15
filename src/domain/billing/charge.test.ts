import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ChargeKind,
  ChargeStatus,
  DEFAULT_BILLING_POLICY,
  type Charge,
  isDelinquent,
  issueAdhesion,
  issueMonthly,
  memberOverdueDays,
  overdueDays,
  payCharge,
  pendingBillingPeriods,
  totalOutstanding,
  voidCharge,
} from './charge.ts';
import { PILOT_TARIFF, monthlyCharge } from './tariff.ts';
import { addMonths, DAY } from '../shared/clock.ts';
import { asChargeId, asClusterId, asMemberId } from '../shared/ids.ts';
import { fromReais } from '../shared/money.ts';
import { unwrap } from '../shared/result.ts';

const CLUSTER = asClusterId('clu_test');
const EMPRESA = asMemberId('mbr_test');
const ENTRADA = Date.parse('2026-03-09T12:00:00Z');
const VENCIMENTO = DEFAULT_BILLING_POLICY.dueInDays * DAY;

function mensalidade(periodStart = ENTRADA, stores = 1, now = periodStart): Charge {
  return unwrap(
    issueMonthly({
      id: asChargeId(`chg_${periodStart}_${now}`),
      memberId: EMPRESA,
      clusterId: CLUSTER,
      breakdown: monthlyCharge(PILOT_TARIFF, stores),
      periodStart,
      now,
    }),
  ).state;
}

describe('emissao', () => {
  test('a mensalidade congela o valor E a memoria de calculo', () => {
    // Recalcular na leitura faria um patio aberto hoje mudar uma fatura de tres
    // meses atras. Fatura emitida e fato, nao consulta.
    const charge = mensalidade(ENTRADA, 3);

    assert.equal(charge.amount.cents, 59_900 + 2 * 15_900);
    assert.equal(charge.breakdown?.extraStores, 2);
    assert.equal(charge.tariffVersion, PILOT_TARIFF.version);
    assert.equal(charge.status, ChargeStatus.OPEN);
  });

  test('a competencia cobre um mes de calendario', () => {
    const charge = mensalidade(Date.parse('2026-01-31T12:00:00Z'));
    assert.equal(
      charge.periodEnd,
      Date.parse('2026-02-28T12:00:00Z'),
      '31 de janeiro mais um mes gruda em 28 de fevereiro, nao transborda para marco',
    );
  });

  test('a adesao nao tem memoria de calculo: e uma linha so', () => {
    const charge = unwrap(
      issueAdhesion({
        id: asChargeId('chg_ad'),
        memberId: EMPRESA,
        clusterId: CLUSTER,
        amount: fromReais(3_000),
        tariffVersion: PILOT_TARIFF.version,
        now: ENTRADA,
      }),
    ).state;

    assert.equal(charge.kind, ChargeKind.ADHESION);
    assert.equal(charge.breakdown, null);
    assert.equal(charge.amount.cents, 300_000);
    assert.equal(charge.dueAt, ENTRADA + VENCIMENTO);
  });
});

describe('liquidacao', () => {
  test('pagar fecha a cobranca e registra quando', () => {
    const paga = unwrap(payCharge({ charge: mensalidade(), now: ENTRADA + DAY })).state;
    assert.equal(paga.status, ChargeStatus.PAID);
    assert.equal(paga.paidAt, ENTRADA + DAY);
  });

  test('pagar duas vezes e bloqueado', () => {
    const paga = unwrap(payCharge({ charge: mensalidade(), now: ENTRADA })).state;
    const denovo = payCharge({ charge: paga, now: ENTRADA + DAY });
    assert.equal(denovo.ok === false && denovo.error.code, 'CHARGE_ALREADY_PAID');
  });

  test('cobranca cancelada nao recebe pagamento', () => {
    const cancelada = unwrap(voidCharge(mensalidade(), 'erro de emissao', ENTRADA)).state;
    const tentativa = payCharge({ charge: cancelada, now: ENTRADA + DAY });
    assert.equal(tentativa.ok === false && tentativa.error.code, 'CHARGE_VOID');
  });

  test('cancelar some do que e devido, sem sumir do historico', () => {
    const charges = [mensalidade(), unwrap(voidCharge(mensalidade(), 'duplicada', ENTRADA)).state];
    assert.equal(totalOutstanding(charges).cents, 59_900, 'so a que segue aberta');
    assert.equal(charges.length, 2, 'as duas continuam no extrato');
  });
});

describe('atraso', () => {
  const charge = mensalidade();

  test('nao ha atraso antes do vencimento', () => {
    assert.equal(overdueDays(charge, charge.dueAt), 0);
    assert.equal(overdueDays(charge, charge.dueAt - DAY), 0);
  });

  test('conta dias corridos depois do vencimento', () => {
    assert.equal(overdueDays(charge, charge.dueAt + 5 * DAY), 5);
    assert.equal(overdueDays(charge, charge.dueAt + 5 * DAY - 1), 4, 'dia cheio, nao fracao');
  });

  test('pagar no dia 40 nao apaga os 40 dias', () => {
    // E o que distingue um boleto perdido de um padrao: a governanca precisa
    // enxergar o atraso COM QUE foi pago, nao so que foi pago.
    const paga = unwrap(payCharge({ charge, now: charge.dueAt + 40 * DAY })).state;
    assert.equal(overdueDays(paga, charge.dueAt + 200 * DAY), 40, 'congelou no pagamento');
  });

  test('o atraso da empresa e o da cobranca mais atrasada, nao a soma', () => {
    // Tres competencias recuperadas de uma vez: emitidas no mesmo instante,
    // entao vencem juntas. Somar os dias suspenderia em 10 dias quem tem tres
    // faturas abertas — e trinta dias e condicao sobre TEMPO, nao sobre volume.
    const tres = [ENTRADA, addMonths(ENTRADA, 1), addMonths(ENTRADA, 2)].map((periodo) =>
      mensalidade(periodo, 1, ENTRADA),
    );
    const agora = tres[0]!.dueAt + 12 * DAY;

    for (const fatura of tres) {
      assert.equal(overdueDays(fatura, agora), 12, 'as tres estao vencidas ha 12 dias');
    }
    assert.equal(memberOverdueDays(tres, agora), 12, 'e 12, nao 36');
    assert.equal(isDelinquent(tres, agora), false, 'tres faturas de 12 dias nao suspendem');
  });

  test('uma fatura de 30 dias suspende mesmo ao lado de outras em dia', () => {
    const antiga = mensalidade(ENTRADA, 1, ENTRADA);
    const nova = mensalidade(addMonths(ENTRADA, 1), 1, antiga.dueAt + 25 * DAY);
    const agora = antiga.dueAt + 30 * DAY;

    assert.equal(overdueDays(nova, agora), 0, 'a nova nem venceu');
    assert.equal(memberOverdueDays([antiga, nova], agora), 30);
    assert.equal(isDelinquent([antiga, nova], agora), true);
  });

  test('trinta dias na mesma fatura suspendem', () => {
    assert.equal(isDelinquent([charge], charge.dueAt + 29 * DAY), false);
    assert.equal(isDelinquent([charge], charge.dueAt + 30 * DAY), true);
  });

  test('cobranca paga nao alimenta inadimplencia', () => {
    const paga = unwrap(payCharge({ charge, now: charge.dueAt + 60 * DAY })).state;
    assert.equal(isDelinquent([paga], charge.dueAt + 90 * DAY), false);
  });
});

describe('ciclos a faturar', () => {
  test('a ancora e a data de credenciamento, nao o primeiro dia do mes', () => {
    // Sem rateio, mes-calendario faria quem entra dia 28 pagar um mes cheio por
    // tres dias. O aniversario da adesao trata todo mundo igual.
    const pendentes = pendingBillingPeriods(ENTRADA, [], addMonths(ENTRADA, 2) + DAY);

    assert.deepEqual(pendentes, [ENTRADA, addMonths(ENTRADA, 1), addMonths(ENTRADA, 2)]);
  });

  test('o dia do mes nao escorrega ao longo do ano', () => {
    // `+ 30 * DAY` faria "todo dia 9" virar dia 8, depois 7.
    const umAno = pendingBillingPeriods(ENTRADA, [], addMonths(ENTRADA, 12));
    for (const periodo of umAno) {
      assert.equal(new Date(periodo).getUTCDate(), 9, `${new Date(periodo).toISOString()}`);
    }
  });

  test('ciclo ja faturado nao volta', () => {
    const pendentes = pendingBillingPeriods(ENTRADA, [ENTRADA], addMonths(ENTRADA, 1) + DAY);
    assert.deepEqual(pendentes, [addMonths(ENTRADA, 1)]);
  });

  test('o ciclo em curso ja e faturavel no primeiro dia dele', () => {
    assert.deepEqual(pendingBillingPeriods(ENTRADA, [], ENTRADA), [ENTRADA]);
    assert.deepEqual(pendingBillingPeriods(ENTRADA, [], ENTRADA - 1), []);
  });

  test('uma lacuna no meio e recuperada, nao pulada', () => {
    // Plataforma fora do ar no ciclo 2 nao perde a receita do ciclo 2.
    const pendentes = pendingBillingPeriods(
      ENTRADA,
      [ENTRADA, addMonths(ENTRADA, 2)],
      addMonths(ENTRADA, 2) + DAY,
    );
    assert.deepEqual(pendentes, [addMonths(ENTRADA, 1)]);
  });
});
