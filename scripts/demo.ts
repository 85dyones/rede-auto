/**
 * Roteiro de demonstracao: a operacao inteira, narrada, em milissegundos.
 *
 * Rode com `npm run demo`.
 *
 * Usa relogio controlado, entao a trava de 4 horas expira de verdade, o SLA de
 * recall corre em horas UTEIS de verdade e a multa cai numa data em que o carro
 * estava mesmo no patio da outra loja. Nada aqui e simulado por atalho: sao os
 * mesmos casos de uso que a API expoe.
 */

import { buildApplication } from '../src/bootstrap.ts';
import { loadConfig } from '../src/config.ts';
import { FakeClock, DAY, HOUR, toIso } from '../src/domain/shared/clock.ts';
import { sequentialIdGenerator } from '../src/domain/shared/ids.ts';
import { format as brl, fromReais } from '../src/domain/shared/money.ts';
import { unwrap } from '../src/domain/shared/result.ts';
import type { Actor, AppContext } from '../src/application/context.ts';
import {
  buildVehicleView,
  loadVehicle,
  openCommercialLock,
  updateVehiclePricing,
} from '../src/application/inventory-service.ts';
import { extendCommercialLock } from '../src/application/inventory-service.ts';
import { runSweep } from '../src/application/scheduler.ts';
import {
  completeCustodyTransfer,
  custodianAt,
  custodyHistory,
  deliverVehicleToConsumer,
  requestVehicleRecall,
  startCustodyTransfer,
} from '../src/application/custody-service.ts';
import {
  acceptDealTradeIn,
  confirmDealSale,
  registerDealAtpv,
  settleDeal,
  startDeal,
} from '../src/application/deal-service.ts';
import { submitApplication, voteOnApplication } from '../src/application/governance-service.ts';
import { syncStoreFeed } from '../src/application/feed-service.ts';
import { shareVehicle, resolvePublicSheet } from '../src/application/sharing-service.ts';
import { sealTerm, TransferPurpose, PhotoAngle } from '../src/domain/custody/custody.ts';
import { EvidenceType } from '../src/domain/lock/evidence.ts';
import { RecallReason } from '../src/domain/recall/recall.ts';
import { SettlementMethod, TradeInDestination } from '../src/domain/deal/deal.ts';
import { VoteDecision } from '../src/domain/network/membership.ts';
import { toZonedParts } from '../src/domain/shared/business-hours.ts';
import type { VehicleId } from '../src/domain/shared/ids.ts';

// ---------------------------------------------------------------------------
// Narracao
// ---------------------------------------------------------------------------

const clock = new FakeClock(Date.parse('2026-03-09T12:00:00Z')); // segunda, 09:00 em SP

let act = 0;

function ato(titulo: string): void {
  act += 1;
  console.log(`\n${'-'.repeat(72)}`);
  console.log(`ATO ${act}  ${titulo}`);
  console.log(`${'-'.repeat(72)}`);
}

function diz(linha: string): void {
  console.log(`  ${linha}`);
}

function destaque(linha: string): void {
  console.log(`  >> ${linha}`);
}

function relogio(): string {
  const parts = toZonedParts(clock.now(), 'America/Sao_Paulo');
  const dias = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${dias[parts.weekday]} ${p2(parts.day)}/${p2(parts.month)} ${p2(parts.hour)}:${p2(parts.minute)}`;
}

function avanca(ms: number, motivo: string): void {
  clock.advance(ms);
  diz(`... ${motivo} (agora: ${relogio()})`);
}

/** Vistoria com as cinco fotos obrigatorias. */
const vistoria = (odometro: number, combustivel: number, avarias: unknown[] = []) => ({
  odometerKm: odometro,
  fuelEighths: combustivel,
  photos: [PhotoAngle.FRONT, PhotoAngle.REAR, PhotoAngle.LEFT, PhotoAngle.RIGHT, PhotoAngle.ODOMETER].map(
    (angle) => ({ angle, url: `https://cdn.exemplo.com/${angle.toLowerCase()}.jpg` }),
  ),
  damages: avarias,
});

function termo(context: AppContext, actor: Actor, odometro: number, combustivel: number, avarias: unknown[] = []) {
  return unwrap(
    sealTerm(
      vistoria(odometro, combustivel, avarias),
      {
        name: actor.user.name,
        document: '529.982.247-25',
        role: 'Gerente de patio',
        userId: actor.user.id,
        storeId: actor.store.id,
      },
      context.clock.now(),
    ),
  );
}

const FEED_PRIME = `<?xml version="1.0" encoding="UTF-8"?>
<estoque>
  <veiculo>
    <id>PM-2201</id><placa>RGT4B71</placa><chassi>9BWZZZ377VT004251</chassi>
    <marca>Chevrolet</marca><modelo>Onix</modelo><versao>1.0 Turbo LTZ</versao>
    <anofabricacao>2022</anofabricacao><anomodelo>2023</anomodelo>
    <km>38400</km><cor>Prata</cor><combustivel>Flex</combustivel><cambio>Automatico</cambio>
    <preco>92.900,00</preco><preco_repasse>85.000,00</preco_repasse>
    <opcionais><opcional>Ar-condicionado</opcional><opcional><![CDATA[Multimidia 8" & camera de re]]></opcional></opcionais>
    <fotos><foto>https://cdn.prime.com.br/onix-1.jpg</foto><foto>https://cdn.prime.com.br/onix-2.jpg</foto></fotos>
    <laudo_cautelar><situacao>APROVADO</situacao><numero>LC-2026-4471</numero><empresa>Cautelar Brasil</empresa><data>02/03/2026</data></laudo_cautelar>
  </veiculo>
  <veiculo>
    <id>PM-2202</id><placa>HJK5F19</placa><chassi>9BD15822TC1234567</chassi>
    <marca>Jeep</marca><modelo>Renegade</modelo><versao>1.3 T270 Longitude</versao>
    <anofabricacao>2022</anofabricacao><anomodelo>2023</anomodelo>
    <km>29450</km><cor>Cinza</cor><combustivel>Flex</combustivel><cambio>Automatico</cambio>
    <preco>128.900,00</preco><preco_repasse>118.500,00</preco_repasse>
    <fotos><foto>https://cdn.prime.com.br/renegade-1.jpg</foto></fotos>
    <laudo_cautelar><situacao>APROVADO</situacao><numero>LC-2026-4472</numero><empresa>Cautelar Brasil</empresa><data>04/03/2026</data></laudo_cautelar>
  </veiculo>
</estoque>`;

// ---------------------------------------------------------------------------
// Roteiro
// ---------------------------------------------------------------------------

const app = await buildApplication({
  config: { ...loadConfig({}), seedDemoData: true, publicBaseUrl: 'https://rede.exemplo.com.br' },
  clock,
  ids: sequentialIdGenerator(),
  // O estoque entra pelo feed XML, como na operacao real.
  seedVehicles: false,
});

const context = app.context;
const seed = app.seed;
if (seed === null) throw new Error('a demonstracao precisa da rede semeada');

const lojaA: Actor = { store: seed.stores[0]!.store, user: seed.stores[0]!.principal };
const lojaAVendedor: Actor = { store: seed.stores[0]!.store, user: seed.stores[0]!.salesperson };
const lojaB: Actor = { store: seed.stores[1]!.store, user: seed.stores[1]!.principal };
const lojaBVendedor: Actor = { store: seed.stores[1]!.store, user: seed.stores[1]!.salesperson };
const lojaC: Actor = { store: seed.stores[2]!.store, user: seed.stores[2]!.principal };
const lojaD: Actor = { store: seed.stores[3]!.store, user: seed.stores[3]!.principal };

console.log('\n=============================================================');
console.log('  REDE-AUTO — demonstracao da operacao ponta a ponta');
console.log(`  Relogio simulado. Inicio: ${relogio()}`);
console.log('=============================================================');

// ---------------------------------------------------------------------------
ato('A rede e as 6 lojas fundadoras');

for (const seeded of seed.stores) {
  diz(`${seeded.store.profile.tradeName.padEnd(22)} ${seeded.store.profile.city}/${seeded.store.profile.state}`);
}
destaque(
  `Credenciar loja nova exige ${context.policies.governance.requiredApprovals} avais entre ${context.policies.governance.founderCount} fundadoras.`,
);

// ---------------------------------------------------------------------------
ato(`${lojaA.store.profile.tradeName} publica o estoque pelo feed do integrador`);

const sync = unwrap(await syncStoreFeed(context, lojaA, { xml: FEED_PRIME }));
diz(`Integrador detectado pelo conteudo: ${sync.provider}`);
diz(
  `${sync.counts.received} recebidos | ${sync.counts.created} criados | ` +
    `${sync.counts.updated} atualizados | ${sync.counts.rejected} recusados`,
);
for (const issue of sync.issues) diz(`  recusado ${issue.externalId}: ${issue.message}`);

const onixId = sync.changes.find((change) => change.vehicle.plate === 'RGT4B71')?.vehicle.id as VehicleId;

const resync = unwrap(await syncStoreFeed(context, lojaA, { xml: FEED_PRIME }));
destaque(
  `Rodando o MESMO feed de novo: ${resync.counts.created + resync.counts.updated} escritas, ` +
    `${resync.counts.unchanged} sem mudanca. A sincronizacao e idempotente.`,
);

// ---------------------------------------------------------------------------
ato(`${lojaB.store.profile.tradeName} encontra o carro no catalogo da rede`);

const encontrado = unwrap(await loadVehicle(context, onixId));
const visao = buildVehicleView(encontrado, lojaB.store.id, clock.now());
diz(`${visao.vehicle.specs.brand} ${visao.vehicle.specs.model} ${visao.vehicle.specs.version} ${visao.vehicle.specs.modelYear}`);
diz(`Preco publico da dona:  ${brl(visao.vehicle.pricing.publicPrice)}`);
destaque(`Preco LIQUIDO de repasse: ${brl(visao.vehicle.pricing.netPrice)} — e o que a Loja A exige receber.`);
diz(`A Loja B pode vender por quanto quiser acima disso e fica com 100% do excedente.`);

// ---------------------------------------------------------------------------
ato('O carro vai para o showroom da Loja B (estoque avancado)');

const saida = unwrap(
  await startCustodyTransfer(context, lojaA, {
    vehicleId: onixId,
    toStoreId: lojaB.store.id,
    purpose: TransferPurpose.EXTENDED_STOCK,
    checkout: termo(context, lojaA, 38_400, 6),
  }),
);
diz(`Termo de saida assinado por ${lojaA.store.profile.tradeName}: odometro 38.400 km, combustivel 6/8.`);

const emTransito = unwrap(await loadVehicle(context, onixId));
diz(`Situacao fisica: ${emTransito.vehicle.physical.state}`);
destaque(
  `Responsabilidade civil ainda e da ${lojaA.store.profile.tradeName}: quem nao conferiu o carro nao herda o risco dele.`,
);

avanca(3 * HOUR, 'o carro chega ao patio da Loja B');

unwrap(
  await completeCustodyTransfer(context, lojaB, saida.transfer.id, termo(context, lojaB, 38_437, 6)),
);
const noPatioDaB = unwrap(await loadVehicle(context, onixId));
destaque(`Entrada assinada. A responsabilidade passa AGORA para ${lojaB.store.profile.tradeName}.`);
diz(`Situacao comercial: ${noPatioDaB.vehicle.commercialStatus} — o carro segue ofertado a toda a rede.`);

// ---------------------------------------------------------------------------
ato('Atendimento quente: a Loja B trava o veiculo por 4 horas');

const travado = unwrap(
  await openCommercialLock(context, lojaBVendedor, { vehicleId: onixId, customerReference: 'ATD-4471' }),
);
diz(`Trava aberta as ${relogio()}, expira as ${toIso(travado.lock!.expiresAt)}`);
destaque(`Preco liquido congelado em ${brl(travado.lock!.netPriceSnapshot)}.`);

const tentativaDaC = await openCommercialLock(context, lojaC, { vehicleId: onixId });
diz(`${lojaC.store.profile.tradeName} tenta travar: ${tentativaDaC.ok ? 'conseguiu' : tentativaDaC.error.message}`);

const tentativaDaDona = await openCommercialLock(context, lojaAVendedor, { vehicleId: onixId });
destaque(
  `A propria dona tambem e bloqueada: ${tentativaDaDona.ok ? 'conseguiu' : tentativaDaDona.error.code}. A exclusividade vale contra todos.`,
);

// ---------------------------------------------------------------------------
ato('A Loja A reprecifica no meio da negociacao');

const reprecificado = unwrap(
  await updateVehiclePricing(context, lojaA, { vehicleId: onixId, netPrice: fromReais(89_000) }),
);
diz(`Liquido vigente:  ${brl(reprecificado.pricing.netPrice)}`);
diz(`Liquido represado: ${brl(reprecificado.pendingNetPrice!)}`);
destaque('A Loja B fecha pelo numero que travou. O preco novo so vale quando a trava cair.');

// ---------------------------------------------------------------------------
ato('Proposta bancaria em analise: a trava e estendida');

avanca(3 * HOUR, 'o vendedor roda a ficha no banco');
const estendida = unwrap(
  await extendCommercialLock(context, lojaBVendedor, travado.lock!.id, {
    type: EvidenceType.BANK_PROPOSAL_SUBMITTED,
    reference: 'PROP-8812',
    attachmentUrl: null,
    note: null,
  }),
);
diz(`Nova expiracao: ${toIso(estendida.lock!.expiresAt)} (+4h por evidencia de avanco no funil)`);

const semAnexo = await extendCommercialLock(context, lojaBVendedor, travado.lock!.id, {
  type: EvidenceType.DEPOSIT_RECEIPT,
  reference: null,
  attachmentUrl: null,
  note: null,
});
destaque(`Extensao por sinal SEM comprovante: ${semAnexo.ok ? 'aceita' : semAnexo.error.message}`);

// ---------------------------------------------------------------------------
ato('O cliente desiste. A trava expira.');

avanca(6 * HOUR, 'o prazo da trava se esgota sem fechamento');
const varredura = await runSweep(context);
diz(`Varredor: ${varredura.expiredLocks} trava(s) expirada(s).`);

const liberado = unwrap(await loadVehicle(context, onixId));
diz(`Situacao comercial: ${liberado.vehicle.commercialStatus}`);
diz(`Situacao fisica:    ${liberado.vehicle.physical.state} no patio de ${lojaB.store.profile.tradeName}`);
destaque('O carro voltou a ser ofertado a toda a rede — e nao saiu do lugar. Nao houve frete de devolucao.');
diz(`Liquido agora vigente: ${brl(liberado.vehicle.pricing.netPrice)} (o represado passou a valer)`);

// ---------------------------------------------------------------------------
ato('Oportunidade de balcao: novo cliente na propria Loja B');

avanca(20 * HOUR, 'no dia seguinte, um cliente ve o carro no showroom da Loja B');
const novaTrava = unwrap(
  await openCommercialLock(context, lojaBVendedor, { vehicleId: onixId, customerReference: 'ATD-4488' }),
);
destaque(
  'A mesma loja que perdeu o prazo trava de novo, sem carencia: o carro esta no patio dela e virou oportunidade de balcao.',
);
diz(`Preco liquido travado agora: ${brl(novaTrava.lock!.netPriceSnapshot)}`);

// ---------------------------------------------------------------------------
ato('A Loja A quer o carro de volta — e esbarra na trava');

const recall = unwrap(
  await requestVehicleRecall(context, lojaA, { vehicleId: onixId, reason: RecallReason.OWN_SALE }),
);
diz(`Recall registrado. Situacao: ${recall.status}`);
diz(`Prazo final: ${recall.dueAt === null ? 'ainda nao correndo' : toIso(recall.dueAt)}`);
destaque(
  'O recall e aceito, mas fica AGUARDANDO: a Loja B tem exclusividade ate o timer zerar. O SLA so comeca depois.',
);

// ---------------------------------------------------------------------------
ato('A lamina white-label vai para o cliente da Loja B');

const link = unwrap(
  await shareVehicle(context, lojaBVendedor, { vehicleId: onixId, displayPrice: fromReais(96_900) }),
);
diz(`Link: https://rede.exemplo.com.br/s/${link.token.slice(0, 12)}...`);

const publica = unwrap(await resolvePublicSheet(context, link.token, 'https://rede.exemplo.com.br'));
diz(`Titulo:        ${publica.sheet.title}`);
diz(`Preco exibido: ${publica.sheet.price.formatted} (escolhido pela Loja B)`);
diz(`Apresentado por: ${publica.sheet.presentedBy.tradeName}`);
destaque(
  `Nao aparece: nome da ${lojaA.store.profile.tradeName}, CNPJ, preco liquido, chassi, placa nem o dominio das fotos originais.`,
);
diz(`Fotos servidas por: ${publica.sheet.photos[0]}`);

// ---------------------------------------------------------------------------
ato('A venda fecha — com transbordo do carro de troca');

const negociacao = unwrap(
  await startDeal(context, lojaBVendedor, {
    vehicleId: onixId,
    retailPriceToConsumer: fromReais(96_900),
    tradeIn: {
      vehicle: {
        plate: 'DEF4G56',
        brand: 'Fiat',
        model: 'Argo',
        version: '1.3 Drive',
        modelYear: 2019,
        mileageKm: 71_000,
        color: 'Branco',
        notes: 'Cliente pediu avaliacao do usado',
      },
      allowanceToConsumer: fromReais(42_000),
      appraisedValue: fromReais(44_000),
      // A Loja B nao trabalha com esse modelo: oferta o usado a Loja A.
      destination: TradeInDestination.OWNER_STORE,
      ownerAcceptance: null,
    },
  }),
);
diz(`Situacao da negociacao: ${negociacao.deal.status}`);
destaque('Transbordo proposto: a negociacao para e espera o aceite da Loja A.');

const aceito = unwrap(
  await acceptDealTradeIn(context, lojaA, negociacao.deal.id, fromReais(41_000)),
);
diz(`A Loja A aceita o Argo por ${brl(fromReais(41_000))}.`);

const confirmado = unwrap(await confirmDealSale(context, lojaBVendedor, aceito.deal.id));
const f = confirmado.financials;
console.log('');
diz('CONTA DA OPERACAO');
diz(`  Preco ao consumidor ............... ${brl(f.retailPriceToConsumer)}`);
diz(`  (-) valor dado na troca ........... ${brl(f.tradeInAllowance)}`);
diz(`  = dinheiro do cliente/banco ....... ${brl(f.cashFromConsumer)}`);
console.log('');
diz(`  Liquido devido a Loja A ........... ${brl(f.netPriceToOwner)}`);
diz(`  (-) credito do Argo transbordado .. ${brl(f.tradeInCreditToOwner)}`);
diz(`  = dinheiro a transferir ........... ${brl(f.cashDueToOwner)}`);
console.log('');
diz(`  Margem da Loja B no seminovo ...... ${brl(f.sellerGrossMargin)}`);
diz(`  Resultado da Loja B na troca ...... ${brl(f.sellerTradeInResult)}`);
destaque(`Resultado total da Loja B: ${brl(f.sellerTotalResult)}`);

const recallDepois = await context.repos.recalls.byId(recall.id);
destaque(
  `O recall da Loja A foi ${recallDepois?.status} (${recallDepois?.cancelReason}): nao ha o que devolver, o carro virou dinheiro.`,
);

// ---------------------------------------------------------------------------
ato('Liquidacao, documentacao e entrega');

avanca(4 * HOUR, 'o banco libera o financiamento');
const entrada = unwrap(
  await settleDeal(context, lojaBVendedor, {
    dealId: confirmado.deal.id,
    amount: fromReais(14_000),
    method: SettlementMethod.PIX,
    reference: 'E2E-2026-0311-991',
  }),
);
diz(`Entrada por PIX: ${brl(fromReais(14_000))} | saldo aberto ${brl(entrada.financials.outstandingAmount)}`);

const quitado = unwrap(
  await settleDeal(context, lojaBVendedor, {
    dealId: confirmado.deal.id,
    amount: entrada.financials.outstandingAmount,
    method: SettlementMethod.BANK_FINANCING,
    reference: 'CONTRATO-77123',
  }),
);
diz(`Liberacao do banco: saldo ${brl(quitado.financials.outstandingAmount)} | situacao ${quitado.deal.status}`);

const documentado = unwrap(
  await registerDealAtpv(context, lojaA, {
    dealId: confirmado.deal.id,
    atpvNumber: 'ATPV-2026-889231',
    buyerName: 'Ana Paula Ribeiro',
    buyerDocument: '529.982.247-25',
  }),
);
diz(`ATPV-e ${documentado.atpv?.atpvNumber} emitido pela ${lojaA.store.profile.tradeName} ao comprador final.`);
destaque('Quem emite e a dona: a rede compartilha estoque, nao transfere titularidade entre lojistas.');

// O Onix esta no patio da Loja B desde o ato 4, entao ela ja pode entregar.
const entrega = unwrap(
  await deliverVehicleToConsumer(context, lojaB, onixId, termo(context, lojaB, 38_470, 4)),
);
diz(`Veiculo entregue ao comprador. Situacao fisica: ${entrega.vehicle.physical.state}`);
destaque(
  `A entrega fisica e a entrega da negociacao sao o mesmo fato: ${entrega.deal?.status}.`,
);

// ---------------------------------------------------------------------------
ato('Chega uma multa. Quem paga?');

const dataDaInfracao = Date.parse('2026-03-10T14:32:00Z');
diz(`Infracao registrada em ${toIso(dataDaInfracao)}`);

const atribuicao = unwrap(await custodianAt(context, onixId, dataDaInfracao));
if (atribuicao.resolved) {
  const responsavel = await context.repos.stores.byId(atribuicao.storeId);
  destaque(`Responsavel: ${responsavel?.profile.tradeName}`);
  diz(`Periodo: ${toIso(atribuicao.period.from)} ate ${atribuicao.period.to === null ? 'em curso' : toIso(atribuicao.period.to)}`);
} else {
  diz(`Nao atribuido: ${atribuicao.reason}`);
}

const historico = unwrap(await custodyHistory(context, onixId));
diz('Linha do tempo da custodia:');
for (const periodo of historico.periods) {
  const loja = await context.repos.stores.byId(periodo.storeId);
  diz(
    `  ${toIso(periodo.from)} -> ${periodo.to === null ? 'em curso'.padEnd(24) : toIso(periodo.to)}  ${loja?.profile.tradeName}`,
  );
}

// ---------------------------------------------------------------------------
ato('Credenciamento de uma loja nova');

const candidatura = unwrap(
  await submitApplication(context, lojaA, {
    legalName: 'Nova Garagem Veiculos LTDA',
    tradeName: 'Nova Garagem',
    cnpj: '07.526.557/0001-00',
    city: 'Sorocaba',
    state: 'SP',
    phone: '(15) 99876-5432',
    email: 'contato@novagaragem.com.br',
    responsibleName: 'Joao Pereira',
  }),
);
diz(`${lojaA.store.profile.tradeName} apresenta a Nova Garagem. Faltam ${candidatura.tally.approvalsStillNeeded} avais.`);

const autoVoto = await voteOnApplication(context, lojaA, candidatura.application.id, VoteDecision.APPROVE);
diz(`A padrinho tenta avalizar a propria indicacao: ${autoVoto.ok ? 'aceito' : autoVoto.error.message}`);

let apuracao = candidatura.tally;
for (const votante of [lojaB, lojaC, lojaD]) {
  const voto = unwrap(await voteOnApplication(context, votante, candidatura.application.id, VoteDecision.APPROVE));
  apuracao = voto.tally;
  diz(
    `Aval de ${votante.store.profile.tradeName.padEnd(20)} -> ${voto.application.status} (${apuracao.approvals}/${context.policies.governance.requiredApprovals})`,
  );
  if (voto.admittedStore !== null) {
    destaque(
      `${voto.admittedStore.profile.tradeName} credenciada como ${voto.admittedStore.kind} — entra operando, sem direito a voto.`,
    );
  }
}

// ---------------------------------------------------------------------------
ato('Trilha de auditoria do veiculo');

const trilha = await context.repos.audit.byAggregate(onixId, 100);
diz(`${trilha.length} eventos registrados. Os ultimos, do mais recente:`);
for (const entrada of trilha.slice(0, 12)) {
  diz(`  ${toIso(entrada.event.occurredAt)}  ${entrada.event.type}`);
}
destaque('Nenhuma transicao de estado acontece sem deixar rastro de quem, quando e o que.');

console.log(`\n${'='.repeat(72)}`);
console.log(`  Fim da demonstracao. Tempo simulado decorrido: ${((clock.now() - Date.parse('2026-03-09T12:00:00Z')) / DAY).toFixed(1)} dias.`);
console.log(`${'='.repeat(72)}\n`);

await app.stop();
