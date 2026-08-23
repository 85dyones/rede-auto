/**
 * Serializacao dos agregados para JSON da API.
 *
 * Escrita a mao, campo a campo, pelo mesmo motivo da lamina white-label: com
 * spread do agregado, todo campo interno novo passaria a sair na API por
 * padrao, e a unica forma de descobrir seria em producao.
 *
 * Convencoes: dinheiro sai como `{ centavos, formatado }` (nunca float),
 * instantes saem como ISO-8601 em UTC, e prazos ganham um `restante` legivel
 * para a interface nao precisar recalcular.
 */

import { formatDuration, toIso, type Instant } from '../domain/shared/clock.ts';
import { type Money, format as formatMoney } from '../domain/shared/money.ts';
import type { Store } from '../domain/network/store.ts';
import { formatCnpj, formatPlate, maskPlate } from '../domain/shared/validation.ts';
import type { MembershipApplication, Tally } from '../domain/network/membership.ts';
import type { Vehicle } from '../domain/vehicle/vehicle.ts';
import type { CommercialLock } from '../domain/lock/commercial-lock.ts';
import type { CustodyTransfer, InspectionTerm } from '../domain/custody/custody.ts';
import type { CustodyPeriod } from '../domain/custody/ledger.ts';
import type { Recall } from '../domain/recall/recall.ts';
import { type Deal, type DealFinancials, computeFinancials } from '../domain/deal/deal.ts';
import type { ShareLink } from '../domain/sharing/share-link.ts';
import type { VehicleView } from '../application/inventory-service.ts';
import type { IngestionReport } from '../infra/feeds/ingestion.ts';
import type { WhiteLabelSheet } from '../domain/sharing/spec-sheet.ts';

export const money = (value: Money): { centavos: number; formatado: string } => ({
  centavos: value.cents,
  formatado: formatMoney(value),
});

export const instant = (value: Instant | null): string | null =>
  value === null ? null : toIso(value);

export function storeDto(store: Store) {
  return {
    id: store.id,
    nomeFantasia: store.profile.tradeName,
    razaoSocial: store.profile.legalName,
    cnpj: formatCnpj(store.profile.cnpj),
    cidade: store.profile.city,
    uf: store.profile.state,
    tipo: store.kind,
    situacao: store.status,
    fundadora: store.kind === 'FOUNDER',
    entrouEm: instant(store.joinedAt),
    apadrinhadaPor: store.sponsorStoreId,
  };
}

export function vehicleDto(vehicle: Vehicle) {
  return {
    id: vehicle.id,
    lojaProprietariaId: vehicle.ownerStoreId,
    placa: formatPlate(vehicle.plate),
    chassi: vehicle.chassis,
    ficha: {
      marca: vehicle.specs.brand,
      modelo: vehicle.specs.model,
      versao: vehicle.specs.version,
      anoFabricacao: vehicle.specs.manufactureYear,
      anoModelo: vehicle.specs.modelYear,
      km: vehicle.specs.mileageKm,
      cor: vehicle.specs.color,
      combustivel: vehicle.specs.fuel,
      cambio: vehicle.specs.transmission,
      portas: vehicle.specs.doors,
      opcionais: vehicle.specs.optionals,
      fotos: vehicle.specs.photos,
    },
    laudoCautelar: {
      situacao: vehicle.inspection.status,
      numero: vehicle.inspection.reportNumber,
      empresa: vehicle.inspection.provider,
      emitidoEm: instant(vehicle.inspection.issuedAt),
      validoAte: instant(vehicle.inspection.expiresAt),
    },
    precos: {
      publico: money(vehicle.pricing.publicPrice),
      liquidoRepasse: money(vehicle.pricing.netPrice),
      liquidoRepresado: vehicle.pendingNetPrice === null ? null : money(vehicle.pendingNetPrice),
      atualizadoEm: instant(vehicle.pricing.updatedAt),
    },
    comercial: {
      situacao: vehicle.commercialStatus,
      travaAtivaId: vehicle.activeLockId,
    },
    fisico: {
      situacao: vehicle.physical.state,
      lojaCustodianteId: vehicle.physical.custodianStoreId,
      lojaDestinoId: vehicle.physical.inboundStoreId,
      desde: instant(vehicle.physical.since),
      termoAbertoId: vehicle.physical.openTransferId,
    },
    origem: {
      integrador: vehicle.source.provider,
      idExterno: vehicle.source.externalId,
      sincronizadoEm: instant(vehicle.source.lastSyncedAt),
      ausenteNoFeed: vehicle.missingFromFeed,
    },
    criadoEm: instant(vehicle.createdAt),
    atualizadoEm: instant(vehicle.updatedAt),
  };
}

export function lockDto(lock: CommercialLock, at: Instant) {
  const remaining = Math.max(0, lock.expiresAt - at);
  return {
    id: lock.id,
    veiculoId: lock.vehicleId,
    lojaDetentoraId: lock.holderStoreId,
    situacao: lock.status,
    abertaEm: instant(lock.openedAt),
    expiraEm: instant(lock.expiresAt),
    restanteMs: lock.status === 'ACTIVE' ? remaining : 0,
    restante: lock.status === 'ACTIVE' ? formatDuration(remaining) : 'encerrada',
    precoLiquidoTravado: money(lock.netPriceSnapshot),
    referenciaAtendimento: lock.customerReference,
    extensoes: lock.extensions.map((extension) => ({
      evidencia: extension.evidence.type,
      concedidoMs: extension.grantedMs,
      concedido: formatDuration(extension.grantedMs),
      em: instant(extension.extendedAt),
      limitadoPelaPolitica: extension.cappedByPolicy,
    })),
    encerradaEm: instant(lock.endedAt),
    motivoEncerramento: lock.endReason,
  };
}

export function vehicleViewDto(view: VehicleView, at: Instant) {
  return {
    ...vehicleDto(view.vehicle),
    trava: view.lock === null
      ? null
      : {
          id: view.lock.id,
          lojaDetentoraId: view.lock.holderStoreId,
          expiraEm: instant(view.lock.expiresAt),
          restante: formatDuration(view.lock.remainingMs),
          extensoes: view.lock.extensions,
        },
    estoqueAvancado: view.onExtendedCustody,
    prioridade: {
      de: view.priority.holder,
      lojaId: view.priority.holderStoreId,
      ate: instant(view.priority.until),
      justificativa: view.priority.rationale,
    },
    vocePode: {
      travar: view.viewerCan.lock,
      chamarDeVolta: view.viewerCan.requestRecall,
      precificar: view.viewerCan.setPrice,
    },
    _at: instant(at),
  };
}

export function termDto(term: InspectionTerm) {
  return {
    odometroKm: term.odometerKm,
    combustivelOitavos: term.fuelEighths,
    fotos: term.photos.map((photo) => ({ angulo: photo.angle, url: photo.url })),
    avarias: term.damages.map((damage) => ({
      area: damage.area,
      gravidade: damage.severity,
      descricao: damage.description,
      fotos: damage.photoUrls,
    })),
    observacoes: term.observations,
    assinatura: {
      nome: term.signature.signerName,
      funcao: term.signature.signerRole,
      lojaId: term.signature.storeId,
      // O CPF do conferente e dado pessoal: sai mascarado.
      documento: `***.${term.signature.signerDocument.slice(3, 6)}.***-**`,
      assinadoEm: instant(term.signature.signedAt),
      hashDoTermo: term.signature.termHash,
    },
  };
}

export function transferDto(transfer: CustodyTransfer) {
  return {
    id: transfer.id,
    veiculoId: transfer.vehicleId,
    lojaOrigemId: transfer.fromStoreId,
    lojaDestinoId: transfer.toStoreId,
    finalidade: transfer.purpose,
    situacao: transfer.status,
    abertoEm: instant(transfer.openedAt),
    fechadoEm: instant(transfer.closedAt),
    recallId: transfer.recallId,
    saida: termDto(transfer.checkout),
    entrada: transfer.checkin === null ? null : termDto(transfer.checkin),
    divergencias: transfer.discrepancies.map((discrepancy) => ({
      tipo: discrepancy.kind,
      descricao: discrepancy.description,
      detalhes: discrepancy.details,
    })),
  };
}

export function custodyPeriodDto(period: CustodyPeriod) {
  return {
    lojaId: period.storeId,
    de: instant(period.from),
    ate: instant(period.to),
    origem: period.basis,
    termoId: period.transferId,
  };
}

export function recallDto(recall: Recall) {
  return {
    id: recall.id,
    veiculoId: recall.vehicleId,
    solicitadoPorLojaId: recall.requestedByStoreId,
    lojaCustodianteId: recall.custodianStoreId,
    motivo: recall.reason,
    observacao: recall.note,
    situacao: recall.status,
    solicitadoEm: instant(recall.requestedAt),
    travaBloqueadoraId: recall.blockedByLockId,
    prazoIniciadoEm: instant(recall.slaStartedAt),
    prazoFinal: instant(recall.dueAt),
    cumpridoEm: instant(recall.fulfilledAt),
    cumpridoPeloTermoId: recall.fulfilledByTransferId,
    canceladoEm: instant(recall.cancelledAt),
    motivoCancelamento: recall.cancelReason,
    descumpridoEm: instant(recall.breachedAt),
  };
}

export function financialsDto(financials: DealFinancials) {
  return {
    liquidoDaLojaProprietaria: money(financials.netPriceToOwner),
    precoAoConsumidor: money(financials.retailPriceToConsumer),
    valorDadoNaTroca: money(financials.tradeInAllowance),
    dinheiroDoConsumidor: money(financials.cashFromConsumer),
    creditoDaTrocaParaProprietaria: money(financials.tradeInCreditToOwner),
    dinheiroDevidoAProprietaria: money(financials.cashDueToOwner),
    margemDaVendedora: money(financials.sellerGrossMargin),
    resultadoDaVendedoraNaTroca: money(financials.sellerTradeInResult),
    resultadoTotalDaVendedora: money(financials.sellerTotalResult),
    jaLiquidado: money(financials.settledAmount),
    saldoAberto: money(financials.outstandingAmount),
    liquidado: financials.fullySettled,
    vendaAbaixoDoLiquido: financials.sellingBelowNetPrice,
  };
}

export function dealDto(deal: Deal) {
  return {
    id: deal.id,
    veiculoId: deal.vehicleId,
    travaId: deal.lockId,
    lojaProprietariaId: deal.ownerStoreId,
    lojaVendedoraId: deal.sellingStoreId,
    situacao: deal.status,
    financeiro: financialsDto(computeFinancials(deal)),
    troca: deal.tradeIn === null
      ? null
      : {
          veiculo: {
            placa: maskPlate(deal.tradeIn.vehicle.plate),
            marca: deal.tradeIn.vehicle.brand,
            modelo: deal.tradeIn.vehicle.model,
            versao: deal.tradeIn.vehicle.version,
            anoModelo: deal.tradeIn.vehicle.modelYear,
            km: deal.tradeIn.vehicle.mileageKm,
            cor: deal.tradeIn.vehicle.color,
          },
          valorDadoAoCliente: money(deal.tradeIn.allowanceToConsumer),
          avaliacao: money(deal.tradeIn.appraisedValue),
          destino: deal.tradeIn.destination,
          aceiteDaProprietaria: deal.tradeIn.ownerAcceptance === null
            ? null
            : {
                valorAceito: money(deal.tradeIn.ownerAcceptance.acceptedValue),
                aceitoEm: instant(deal.tradeIn.ownerAcceptance.acceptedAt),
              },
        },
    liquidacoes: deal.settlements.map((settlement) => ({
      id: settlement.id,
      valor: money(settlement.amount),
      meio: settlement.method,
      comprovante: settlement.reference,
      pagoEm: instant(settlement.paidAt),
    })),
    atpv: deal.atpv === null
      ? null
      : {
          numero: deal.atpv.atpvNumber,
          compradorNome: deal.atpv.buyerName,
          compradorTipoDocumento: deal.atpv.buyerDocumentType,
          emitidoEm: instant(deal.atpv.emittedAt),
        },
    criadoEm: instant(deal.createdAt),
    confirmadoEm: instant(deal.confirmedAt),
    liquidadoEm: instant(deal.settledAt),
    entregueEm: instant(deal.deliveredAt),
    concluidoEm: instant(deal.completedAt),
    canceladoEm: instant(deal.cancelledAt),
    motivoCancelamento: deal.cancelReason,
  };
}

export function shareLinkDto(link: ShareLink, publicBaseUrl: string) {
  return {
    id: link.id,
    veiculoId: link.vehicleId,
    url: `${publicBaseUrl}/s/${link.token}`,
    urlLamina: `${publicBaseUrl}/s/${link.token}/lamina.html`,
    urlPdf: `${publicBaseUrl}/s/${link.token}/lamina.pdf`,
    precoExibido: money(link.displayPrice),
    exibePlaca: link.showPlate,
    criadoEm: instant(link.createdAt),
    expiraEm: instant(link.expiresAt),
    aberturas: link.viewCount,
    limiteAberturas: link.maxViews,
    revogadoEm: instant(link.revokedAt),
  };
}

export function applicationDto(application: MembershipApplication, tally: Tally, admitted: Store | null) {
  return {
    id: application.id,
    candidata: {
      nomeFantasia: application.candidate.tradeName,
      razaoSocial: application.candidate.legalName,
      cnpj: formatCnpj(application.candidate.cnpj),
      cidade: application.candidate.city,
      uf: application.candidate.state,
      responsavel: application.candidate.responsibleName,
    },
    apadrinhadaPorLojaId: application.sponsorStoreId,
    situacao: application.status,
    abertaEm: instant(application.openedAt),
    decididaEm: instant(application.decidedAt),
    apuracao: {
      avais: tally.approvals,
      contrarios: tally.rejections,
      faltamAvais: tally.approvalsStillNeeded,
      fundadoresPendentes: tally.pendingFounders,
    },
    votos: application.votes.map((vote) => ({
      fundadoraId: vote.founderStoreId,
      decisao: vote.decision,
      em: instant(vote.castAt),
      justificativa: vote.note,
    })),
    lojaCredenciada: admitted === null ? null : storeDto(admitted),
  };
}

export function ingestionReportDto(report: IngestionReport) {
  return {
    execucaoId: report.runId,
    integrador: report.provider,
    iniciadaEm: instant(report.startedAt),
    resumo: {
      recebidos: report.counts.received,
      criados: report.counts.created,
      atualizados: report.counts.updated,
      semMudanca: report.counts.unchanged,
      ausentes: report.counts.missing,
      recusados: report.counts.rejected,
    },
    ausentes: report.changes
      .filter((change) => change.kind === 'MISSING')
      .map((change) => ({
        veiculoId: change.vehicle.id,
        placa: formatPlate(change.vehicle.plate),
        acao: change.kind === 'MISSING' ? change.action : null,
      })),
    recusados: report.issues.map((issue) => ({
      idExterno: issue.externalId,
      codigo: issue.code,
      mensagem: issue.message,
      detalhes: issue.details ?? null,
    })),
  };
}

/**
 * Ficha white-label para a rota publica.
 *
 * O tipo de dominio `WhiteLabelSheet` ja e o resultado da sanitizacao — aqui so
 * traduzimos os nomes dos campos para o vocabulario do resto da API. Nenhum
 * campo novo entra: se um dia entrar, a lista abaixo tem que mudar junto, que e
 * exatamente o ponto de nao usar spread.
 */
export function whiteLabelSheetDto(sheet: WhiteLabelSheet) {
  return {
    referencia: sheet.reference,
    titulo: sheet.title,
    marca: sheet.brand,
    modelo: sheet.model,
    versao: sheet.version,
    anoFabricacao: sheet.manufactureYear,
    anoModelo: sheet.modelYear,
    ano: sheet.yearLabel,
    km: sheet.mileageKm,
    quilometragem: sheet.mileageLabel,
    cor: sheet.color,
    combustivel: sheet.fuelLabel,
    cambio: sheet.transmissionLabel,
    portas: sheet.doors,
    opcionais: sheet.optionals,
    fotos: sheet.photos,
    preco: { centavos: sheet.price.cents, formatado: sheet.price.formatted },
    laudoCautelar: {
      aprovado: sheet.inspection.approved,
      situacao: sheet.inspection.label,
      empresa: sheet.inspection.provider,
      emitidoEm: sheet.inspection.issuedAt,
    },
    placa: sheet.plate,
    apresentadoPor: {
      nomeFantasia: sheet.presentedBy.tradeName,
      cidade: sheet.presentedBy.city,
      uf: sheet.presentedBy.state,
      telefone: sheet.presentedBy.phone,
    },
    geradoEm: sheet.generatedAt,
    validoAte: sheet.validUntil,
    aviso: sheet.disclaimer,
  };
}
