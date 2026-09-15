import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DealStatus,
  SettlementMethod,
  TradeInDestination,
  acceptTradeIn,
  cancelDeal,
  computeFinancials,
  confirmDeal,
  markDelivered,
  openDeal,
  registerAtpv,
  registerSettlement,
  rejectTradeIn,
  type Deal,
  type TradeIn,
} from './deal.ts';
import { type Money, fromReais, format } from '../shared/money.ts';
import { HOUR } from '../shared/clock.ts';
import { asDealId, asLockId, asSettlementId, asVehicleId } from '../shared/ids.ts';
import { TradeInStance } from '../vehicle/vehicle.ts';
import { unwrap } from '../shared/result.ts';
import { buildFoundingNetwork } from '../../testing/builders.ts';

const network = buildFoundingNetwork(6);
const lojaA = network.founderAt(0); // dona do veiculo
const lojaB = network.founderAt(1); // vende ao cliente final
const gerenteA = network.principalAt(0);
const vendedorB = network.principalAt(1);

const T0 = Date.parse('2026-08-24T13:00:00Z');

/** Os numeros da vendedora sao anulaveis: ela pode nao registrar o preco. */
const brl = (value: Money | null): string => (value === null ? 'nao informado' : format(value));

const NET = fromReais(85_000); // liquido exigido pela Loja A
const RETAIL = fromReais(94_900); // preco que a Loja B pratica

function trocaAbsorvida(overrides: Partial<TradeIn> = {}): TradeIn {
  return {
    vehicle: {
      plate: 'DEF4G56',
      brand: 'Fiat',
      model: 'Argo',
      version: '1.3 Drive',
      modelYear: 2019,
      mileageKm: 71_000,
      color: 'Branco',
      notes: null,
    },
    allowanceToConsumer: fromReais(42_000),
    appraisedValue: fromReais(46_000),
    destination: TradeInDestination.SELLER_STOCK,
    ownerAcceptance: null,
    ...overrides,
  };
}

/** Postura padrao dos testes: a dona avalia troca, como antes deste campo existir. */
const ACEITA_TROCA = {
  stance: TradeInStance.CONSIDERS,
  note: null,
  updatedAt: 0,
} as const;

const SO_DINHEIRO = {
  stance: TradeInStance.CASH_ONLY,
  note: 'Preciso do dinheiro para quitar o floor plan.',
  updatedAt: 0,
} as const;

function novaNegociacao(overrides: Partial<Parameters<typeof openDeal>[0]> = {}): Deal {
  return unwrap(
    openDeal({
      dealId: asDealId('dea_0001'),
      vehicleId: asVehicleId('veh_0001'),
      lockId: asLockId('lck_0001'),
      ownerStoreId: lojaA.id,
      sellingStoreId: lojaB.id,
      createdByUserId: vendedorB.id,
      netPriceSnapshot: NET,
      retailPriceToConsumer: RETAIL,
      tradeInPolicy: ACEITA_TROCA,
      now: T0,
      ...overrides,
    }),
  ).state;
}

describe('modelo financeiro do repasse', () => {
  test('a Loja A recebe o liquido exato e a Loja B fica com 100% do excedente', () => {
    const deal = novaNegociacao();
    const f = computeFinancials(deal);

    assert.equal(format(f.cashDueToOwner), 'R$ 85.000,00');
    assert.equal(brl(f.sellerPrivate.grossMargin), 'R$ 9.900,00');
    assert.equal(brl(f.sellerPrivate.cashFromConsumer), 'R$ 94.900,00');
    assert.equal(f.sellerPrivate.sellingBelowNetPrice, false);
  });

  test('a Loja B pode precificar como quiser — inclusive abaixo do liquido', () => {
    const deal = novaNegociacao({ retailPriceToConsumer: fromReais(82_000) });
    const f = computeFinancials(deal);

    assert.equal(f.sellerPrivate.grossMargin?.cents, fromReais(-3_000).cents, 'prejuizo no seminovo e permitido');
    assert.equal(f.cashDueToOwner.cents, NET.cents, 'a Loja A recebe o liquido de qualquer forma');
    assert.equal(f.sellerPrivate.sellingBelowNetPrice, true);
  });

  test('venda abaixo do liquido gera evento de sinalizacao', () => {
    const opened = unwrap(
      openDeal({
        dealId: asDealId('dea_x'),
        vehicleId: asVehicleId('veh_0001'),
        lockId: asLockId('lck_0001'),
        ownerStoreId: lojaA.id,
        sellingStoreId: lojaB.id,
        createdByUserId: vendedorB.id,
        netPriceSnapshot: NET,
        retailPriceToConsumer: fromReais(80_000),
        tradeInPolicy: ACEITA_TROCA,
        now: T0,
      }),
    );
    assert.ok(opened.events.some((e) => e.type === 'deal.selling_below_net_price'));
  });

  test('venda da propria loja nao e repasse de rede', () => {
    const result = openDeal({
      dealId: asDealId('dea_x'),
      vehicleId: asVehicleId('veh_0001'),
      lockId: asLockId('lck_0001'),
      ownerStoreId: lojaA.id,
      sellingStoreId: lojaA.id,
      createdByUserId: gerenteA.id,
      netPriceSnapshot: NET,
      retailPriceToConsumer: RETAIL,
      tradeInPolicy: ACEITA_TROCA,
        now: T0,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'OWNER_IS_SELLER');
  });
});

describe('cenario padrao: a Loja B absorve o carro de troca', () => {
  test('a Loja A recebe 100% em dinheiro; a Loja B ganha na venda e no giro', () => {
    const deal = novaNegociacao({ tradeIn: trocaAbsorvida() });
    const f = computeFinancials(deal);

    assert.equal(format(f.cashDueToOwner), 'R$ 85.000,00', 'a troca nao abate nada da Loja A');
    assert.equal(brl(f.sellerPrivate.cashFromConsumer), 'R$ 52.900,00', '94.900 - 42.000 de troca');
    assert.equal(brl(f.sellerPrivate.grossMargin), 'R$ 9.900,00');
    // Avaliou o Argo em 46.000 e deu 42.000 ao cliente: 4.000 no giro.
    assert.equal(brl(f.sellerPrivate.tradeInResult), 'R$ 4.000,00');
    assert.equal(brl(f.sellerPrivate.totalResult), 'R$ 13.900,00');
  });

  test('nao aguarda aceite: a negociacao ja nasce pronta para confirmar', () => {
    const deal = novaNegociacao({ tradeIn: trocaAbsorvida() });
    assert.equal(deal.status, DealStatus.DRAFT);
  });

  test('o valor dado na troca nao pode superar o preco de venda', () => {
    const result = openDeal({
      dealId: asDealId('dea_x'),
      vehicleId: asVehicleId('veh_0001'),
      lockId: asLockId('lck_0001'),
      ownerStoreId: lojaA.id,
      sellingStoreId: lojaB.id,
      createdByUserId: vendedorB.id,
      netPriceSnapshot: NET,
      retailPriceToConsumer: RETAIL,
      tradeIn: trocaAbsorvida({ allowanceToConsumer: fromReais(99_000) }),
      tradeInPolicy: ACEITA_TROCA,
        now: T0,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'TRADE_IN_ALLOWANCE_ABOVE_RETAIL');
  });
});

describe('postura de troca declarada pela dona', () => {
  const transbordo = trocaAbsorvida({ destination: TradeInDestination.OWNER_STORE });

  test('quem so trabalha com dinheiro recusa o transbordo na abertura, nao no aceite', () => {
    // O ponto inteiro do campo: a Loja B descobre ANTES de montar a proposta,
    // nao depois — com o cliente na mesa esperando resposta.
    const result = openDeal({
      dealId: asDealId('dea_recusa'),
      vehicleId: asVehicleId('veh_0001'),
      lockId: asLockId('lck_0001'),
      ownerStoreId: lojaA.id,
      sellingStoreId: lojaB.id,
      createdByUserId: vendedorB.id,
      netPriceSnapshot: NET,
      retailPriceToConsumer: RETAIL,
      tradeIn: transbordo,
      tradeInPolicy: SO_DINHEIRO,
      now: T0,
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'TRADE_IN_NOT_ACCEPTED');
  });

  test('a recusa nao alcanca a troca que fica com a vendedora', () => {
    // A dona so opina sobre metal que ELA receberia. Se o carro de troca fica no
    // patio da Loja B, a dona recebe o liquido em dinheiro de qualquer forma —
    // recusar ali seria a plataforma se metendo na venda dos outros.
    const result = openDeal({
      dealId: asDealId('dea_estoque'),
      vehicleId: asVehicleId('veh_0001'),
      lockId: asLockId('lck_0001'),
      ownerStoreId: lojaA.id,
      sellingStoreId: lojaB.id,
      createdByUserId: vendedorB.id,
      netPriceSnapshot: NET,
      retailPriceToConsumer: RETAIL,
      tradeIn: trocaAbsorvida({ destination: TradeInDestination.SELLER_STOCK }),
      tradeInPolicy: SO_DINHEIRO,
      now: T0,
    });

    assert.equal(result.ok, true, 'a troca que nao chega na dona nao depende da postura dela');
  });

  test('negociacao sem troca nenhuma passa por quem so trabalha com dinheiro', () => {
    const result = openDeal({
      dealId: asDealId('dea_limpa'),
      vehicleId: asVehicleId('veh_0001'),
      lockId: asLockId('lck_0001'),
      ownerStoreId: lojaA.id,
      sellingStoreId: lojaB.id,
      createdByUserId: vendedorB.id,
      netPriceSnapshot: NET,
      retailPriceToConsumer: RETAIL,
      tradeInPolicy: SO_DINHEIRO,
      now: T0,
    });

    assert.equal(result.ok, true);
  });

  test('quem aceita avaliar continua decidindo caso a caso', () => {
    // CONSIDERS nao e promessa de aceite: a negociacao ainda para esperando.
    const deal = novaNegociacao({ tradeIn: transbordo, tradeInPolicy: ACEITA_TROCA });
    assert.equal(deal.status, DealStatus.AWAITING_TRADE_IN_ACCEPTANCE);
  });
});

describe('cenario de transbordo: a troca vai para a Loja A', () => {
  const transbordo = trocaAbsorvida({ destination: TradeInDestination.OWNER_STORE });

  test('a negociacao trava aguardando o aceite da loja proprietaria', () => {
    // Sem isso, a Loja B daria um valor ao cliente sem saber se alguem o honra.
    const deal = novaNegociacao({ tradeIn: transbordo });
    assert.equal(deal.status, DealStatus.AWAITING_TRADE_IN_ACCEPTANCE);
  });

  test('confirmar antes do aceite e bloqueado', () => {
    const deal = novaNegociacao({ tradeIn: transbordo });
    const result = confirmDeal({ deal, actorStoreId: lojaB.id, now: T0 + HOUR });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'TRADE_IN_ACCEPTANCE_PENDING');
  });

  test('o aceite abate o valor do liquido a transferir', () => {
    const deal = novaNegociacao({ tradeIn: transbordo });
    const aceito = unwrap(
      acceptTradeIn({
        deal,
        actorStoreId: lojaA.id,
        actorUserId: gerenteA.id,
        acceptedValue: fromReais(40_000),
        now: T0 + HOUR,
      }),
    ).state;

    const f = computeFinancials(aceito);
    assert.equal(aceito.status, DealStatus.DRAFT);
    assert.equal(format(f.tradeInCreditToOwner), 'R$ 40.000,00');
    assert.equal(format(f.cashDueToOwner), 'R$ 45.000,00', '85.000 - 40.000 em veiculo');
    // A Loja B creditou 42.000 ao cliente e a Loja A aceitou por 40.000:
    // 2.000 de prejuizo no giro, compensados pela margem de 9.900.
    assert.equal(brl(f.sellerPrivate.tradeInResult), '-R$ 2.000,00');
    assert.equal(brl(f.sellerPrivate.totalResult), 'R$ 7.900,00');
  });

  test('a troca nao pode superar o liquido — a Loja A ficaria devendo', () => {
    const deal = novaNegociacao({ tradeIn: transbordo });
    const result = acceptTradeIn({
      deal,
      actorStoreId: lojaA.id,
      actorUserId: gerenteA.id,
      acceptedValue: fromReais(90_000),
      now: T0 + HOUR,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'TRADE_IN_EXCEEDS_NET_PRICE');
    assert.match(
      result.ok === false ? result.error.message : '',
      /separadamente/,
      'a mensagem sugere o caminho: duas operacoes',
    );
  });

  test('so a loja proprietaria aceita o transbordo', () => {
    const deal = novaNegociacao({ tradeIn: transbordo });
    const result = acceptTradeIn({
      deal,
      actorStoreId: lojaB.id,
      actorUserId: vendedorB.id,
      acceptedValue: fromReais(40_000),
      now: T0 + HOUR,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'NOT_VEHICLE_OWNER');
  });

  test('a recusa nao mata a negociacao: a Loja B absorve a troca e paga tudo', () => {
    const deal = novaNegociacao({ tradeIn: transbordo });
    const recusado = unwrap(
      rejectTradeIn({
        deal,
        actorStoreId: lojaA.id,
        reason: 'Nao trabalhamos com esse modelo',
        now: T0 + HOUR,
      }),
    ).state;

    assert.equal(recusado.status, DealStatus.DRAFT);
    assert.equal(recusado.tradeIn?.destination, TradeInDestination.SELLER_STOCK);
    assert.equal(computeFinancials(recusado).cashDueToOwner.cents, NET.cents);
  });

  test('troca que cobre exatamente o liquido nasce ja liquidada', () => {
    const deal = novaNegociacao({
      tradeIn: { ...transbordo, allowanceToConsumer: fromReais(85_000) },
      retailPriceToConsumer: fromReais(120_000),
    });
    const aceito = unwrap(
      acceptTradeIn({
        deal,
        actorStoreId: lojaA.id,
        actorUserId: gerenteA.id,
        acceptedValue: NET,
        now: T0 + HOUR,
      }),
    ).state;
    const confirmado = unwrap(confirmDeal({ deal: aceito, actorStoreId: lojaB.id, now: T0 + 2 * HOUR })).state;

    assert.equal(confirmado.status, DealStatus.SETTLED, 'nao ha dinheiro a transferir');
    assert.equal(confirmado.settledAt, T0 + 2 * HOUR);
  });
});

describe('liquidacao', () => {
  function confirmada(): Deal {
    return unwrap(confirmDeal({ deal: novaNegociacao(), actorStoreId: lojaB.id, now: T0 + HOUR })).state;
  }

  test('aceita pagamento parcial e fecha quando o total e atingido', () => {
    const deal = confirmada();
    const entrada = unwrap(
      registerSettlement({
        deal,
        settlementId: asSettlementId('stl_1'),
        actorStoreId: lojaB.id,
        actorUserId: vendedorB.id,
        amount: fromReais(20_000),
        method: SettlementMethod.PIX,
        reference: 'E2E-9911',
        paidAt: T0 + 2 * HOUR,
        now: T0 + 2 * HOUR,
      }),
    ).state;

    assert.equal(entrada.status, DealStatus.CONFIRMED, 'ainda falta saldo');
    assert.equal(format(computeFinancials(entrada).outstandingAmount), 'R$ 65.000,00');

    const banco = unwrap(
      registerSettlement({
        deal: entrada,
        settlementId: asSettlementId('stl_2'),
        actorStoreId: lojaB.id,
        actorUserId: vendedorB.id,
        amount: fromReais(65_000),
        method: SettlementMethod.BANK_FINANCING,
        reference: 'CONTRATO-77123',
        paidAt: T0 + 3 * HOUR,
        now: T0 + 3 * HOUR,
      }),
    );

    assert.equal(banco.state.status, DealStatus.SETTLED);
    assert.equal(computeFinancials(banco.state).outstandingAmount.cents, 0);
    assert.ok(banco.events.some((e) => e.type === 'deal.settled'));
  });

  test('nao aceita pagar mais do que o devido', () => {
    const result = registerSettlement({
      deal: confirmada(),
      settlementId: asSettlementId('stl_1'),
      actorStoreId: lojaB.id,
      actorUserId: vendedorB.id,
      amount: fromReais(90_000),
      method: SettlementMethod.TED,
      reference: 'TED-1',
      paidAt: T0 + 2 * HOUR,
      now: T0 + 2 * HOUR,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'SETTLEMENT_EXCEEDS_BALANCE');
  });

  test('exige comprovante', () => {
    const result = registerSettlement({
      deal: confirmada(),
      settlementId: asSettlementId('stl_1'),
      actorStoreId: lojaB.id,
      actorUserId: vendedorB.id,
      amount: fromReais(85_000),
      method: SettlementMethod.PIX,
      reference: '',
      paidAt: T0 + 2 * HOUR,
      now: T0 + 2 * HOUR,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.kind, 'VALIDATION');
  });

  test('liquidar antes de confirmar a venda nao faz sentido', () => {
    const result = registerSettlement({
      deal: novaNegociacao(),
      settlementId: asSettlementId('stl_1'),
      actorStoreId: lojaB.id,
      actorUserId: vendedorB.id,
      amount: fromReais(85_000),
      method: SettlementMethod.PIX,
      reference: 'E2E-1',
      paidAt: T0,
      now: T0,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'DEAL_NOT_CONFIRMED');
  });
});

describe('documentacao e encerramento', () => {
  function liquidada(): Deal {
    const confirmada = unwrap(
      confirmDeal({ deal: novaNegociacao(), actorStoreId: lojaB.id, now: T0 + HOUR }),
    ).state;
    return unwrap(
      registerSettlement({
        deal: confirmada,
        settlementId: asSettlementId('stl_1'),
        actorStoreId: lojaB.id,
        actorUserId: vendedorB.id,
        amount: NET,
        method: SettlementMethod.PIX,
        reference: 'E2E-9911',
        paidAt: T0 + 2 * HOUR,
        now: T0 + 2 * HOUR,
      }),
    ).state;
  }

  test('o ATPV-e e emitido pela loja proprietaria, dona do registro', () => {
    const comAtpv = unwrap(
      registerAtpv({
        deal: liquidada(),
        actorStoreId: lojaA.id,
        atpvNumber: 'ATPV-2026-889231',
        buyerName: 'Ana Paula Ribeiro',
        buyerDocument: '529.982.247-25',
        now: T0 + 3 * HOUR,
      }),
    ).state;

    assert.equal(comAtpv.atpv?.buyerDocument, '52998224725');
    assert.equal(comAtpv.atpv?.buyerDocumentType, 'CPF');
  });

  test('a loja vendedora nao emite o ATPV-e — o carro nao esta no nome dela', () => {
    const result = registerAtpv({
      deal: liquidada(),
      actorStoreId: lojaB.id,
      atpvNumber: 'ATPV-1',
      buyerName: 'Ana Paula Ribeiro',
      buyerDocument: '529.982.247-25',
      now: T0 + 3 * HOUR,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'NOT_VEHICLE_OWNER');
  });

  test('ATPV-e so depois de a Loja A receber o dinheiro', () => {
    const confirmada = unwrap(
      confirmDeal({ deal: novaNegociacao(), actorStoreId: lojaB.id, now: T0 + HOUR }),
    ).state;
    const result = registerAtpv({
      deal: confirmada,
      actorStoreId: lojaA.id,
      atpvNumber: 'ATPV-1',
      buyerName: 'Ana Paula Ribeiro',
      buyerDocument: '529.982.247-25',
      now: T0 + 2 * HOUR,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'DEAL_NOT_SETTLED');
  });

  test('rejeita CPF invalido do comprador', () => {
    const result = registerAtpv({
      deal: liquidada(),
      actorStoreId: lojaA.id,
      atpvNumber: 'ATPV-1',
      buyerName: 'Ana Paula Ribeiro',
      buyerDocument: '111.111.111-11',
      now: T0 + 3 * HOUR,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'CPF_INVALID');
  });

  test('a negociacao so completa quando dinheiro, documento e carro chegam ao destino', () => {
    const comAtpv = unwrap(
      registerAtpv({
        deal: liquidada(),
        actorStoreId: lojaA.id,
        atpvNumber: 'ATPV-2026-889231',
        buyerName: 'Ana Paula Ribeiro',
        buyerDocument: '529.982.247-25',
        now: T0 + 3 * HOUR,
      }),
    ).state;
    assert.equal(comAtpv.status, DealStatus.SETTLED, 'documentado, mas ainda nao entregue');

    const entregue = unwrap(
      markDelivered({ deal: comAtpv, actorStoreId: lojaB.id, now: T0 + 5 * HOUR }),
    );
    assert.equal(entregue.state.status, DealStatus.COMPLETED);
    assert.ok(entregue.events.some((e) => e.type === 'deal.completed'));
  });

  test('a ordem entre ATPV-e e entrega nao importa', () => {
    const entregue = unwrap(
      markDelivered({ deal: liquidada(), actorStoreId: lojaB.id, now: T0 + 3 * HOUR }),
    ).state;
    assert.equal(entregue.status, DealStatus.SETTLED);

    const completo = unwrap(
      registerAtpv({
        deal: entregue,
        actorStoreId: lojaA.id,
        atpvNumber: 'ATPV-2026-889231',
        buyerName: 'Ana Paula Ribeiro',
        buyerDocument: '529.982.247-25',
        now: T0 + 4 * HOUR,
      }),
    ).state;
    assert.equal(completo.status, DealStatus.COMPLETED);
  });
});

describe('cancelamento', () => {
  test('qualquer uma das duas lojas cancela antes da liquidacao', () => {
    const deal = novaNegociacao();
    const cancelado = unwrap(
      cancelDeal({ deal, actorStoreId: lojaA.id, reason: 'Cliente desistiu', now: T0 + HOUR }),
    ).state;
    assert.equal(cancelado.status, DealStatus.CANCELLED);
    assert.equal(cancelado.cancelReason, 'Cliente desistiu');
  });

  test('terceiros nao cancelam', () => {
    const result = cancelDeal({
      deal: novaNegociacao(),
      actorStoreId: network.founderAt(2).id,
      reason: 'palpite',
      now: T0 + HOUR,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'NOT_A_DEAL_PARTY');
  });

  test('depois de haver dinheiro em jogo, o desfazimento sai do software', () => {
    const confirmada = unwrap(
      confirmDeal({ deal: novaNegociacao(), actorStoreId: lojaB.id, now: T0 + HOUR }),
    ).state;
    const comPagamento = unwrap(
      registerSettlement({
        deal: confirmada,
        settlementId: asSettlementId('stl_1'),
        actorStoreId: lojaB.id,
        actorUserId: vendedorB.id,
        amount: fromReais(20_000),
        method: SettlementMethod.PIX,
        reference: 'E2E-1',
        paidAt: T0 + 2 * HOUR,
        now: T0 + 2 * HOUR,
      }),
    ).state;

    const result = cancelDeal({
      deal: comPagamento,
      actorStoreId: lojaB.id,
      reason: 'Cliente desistiu',
      now: T0 + 3 * HOUR,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'DEAL_ALREADY_SETTLED');
  });
});

describe('o preco ao consumidor e da vendedora, nao da rede', () => {
  test('a negociacao fecha sem preco ao consumidor registrado', () => {
    // A venda ao consumidor acontece fora da plataforma: aqui o negocio e o
    // repasse entre as duas lojas.
    const deal = unwrap(
      openDeal({
        dealId: asDealId('dea_sem_varejo'),
        vehicleId: asVehicleId('veh_0001'),
        lockId: asLockId('lck_0001'),
        ownerStoreId: lojaA.id,
        sellingStoreId: lojaB.id,
        createdByUserId: vendedorB.id,
        netPriceSnapshot: NET,
        tradeInPolicy: ACEITA_TROCA,
        now: T0,
      }),
    ).state;

    const f = computeFinancials(deal);
    assert.equal(f.cashDueToOwner.cents, NET.cents, 'a Loja A recebe o liquido igual');
    assert.equal(f.sellerPrivate.retailPriceToConsumer, null);
    assert.equal(f.sellerPrivate.grossMargin, null, 'sem preco nao ha margem a calcular');
    assert.equal(f.sellerPrivate.sellingBelowNetPrice, false);

    const confirmado = unwrap(confirmDeal({ deal, actorStoreId: lojaB.id, now: T0 + HOUR }));
    assert.equal(confirmado.state.status, DealStatus.CONFIRMED);
  });

  test('o preco ao consumidor nunca entra no evento de confirmacao', () => {
    // O evento alimenta notificacao e auditoria, e a dona le as duas.
    const confirmado = unwrap(
      confirmDeal({ deal: novaNegociacao(), actorStoreId: lojaB.id, now: T0 + HOUR }),
    );
    const evento = confirmado.events.find((e) => e.type === 'deal.confirmed');
    assert.ok(evento);
    assert.equal('retailPriceCents' in evento.payload, false);
    assert.equal('sellerTotalResultCents' in evento.payload, false);
    assert.equal(evento.payload['netPriceCents'], NET.cents);
  });

  test('venda abaixo do liquido e sinalizada sem expor o preco praticado', () => {
    const opened = unwrap(
      openDeal({
        dealId: asDealId('dea_abaixo'),
        vehicleId: asVehicleId('veh_0001'),
        lockId: asLockId('lck_0001'),
        ownerStoreId: lojaA.id,
        sellingStoreId: lojaB.id,
        createdByUserId: vendedorB.id,
        netPriceSnapshot: NET,
        retailPriceToConsumer: fromReais(80_000),
        tradeInPolicy: ACEITA_TROCA,
        now: T0,
      }),
    );
    const evento = opened.events.find((e) => e.type === 'deal.selling_below_net_price');
    assert.ok(evento);
    assert.equal('retailPriceCents' in evento.payload, false);
  });

  test('o transbordo pendente e marcado como provisorio', () => {
    // Enquanto a Loja A nao aceita, o credito da troca vale zero porque nada
    // foi aceito — nao porque a operacao va dar isso.
    const deal = novaNegociacao({
      tradeIn: trocaAbsorvida({ destination: TradeInDestination.OWNER_STORE }),
    });
    const f = computeFinancials(deal);
    assert.equal(f.tradeInAcceptancePending, true);
    assert.equal(f.tradeInCreditToOwner.cents, 0);

    const aceito = unwrap(
      acceptTradeIn({
        deal,
        actorStoreId: lojaA.id,
        actorUserId: gerenteA.id,
        acceptedValue: fromReais(40_000),
        now: T0 + HOUR,
      }),
    ).state;
    assert.equal(computeFinancials(aceito).tradeInAcceptancePending, false);
  });
});
