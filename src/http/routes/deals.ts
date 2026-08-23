/**
 * Rotas da negociacao de repasse.
 */

import { asDealId, asVehicleId } from '../../domain/shared/ids.ts';
import { SettlementMethod, TradeInDestination, type TradeIn } from '../../domain/deal/deal.ts';
import { ZERO } from '../../domain/shared/money.ts';
import { type Result, err, ok } from '../../domain/shared/result.ts';
import { type DomainError, validationError } from '../../domain/shared/errors.ts';
import { parsePlate, requireInteger, requireText } from '../../domain/shared/validation.ts';
import type { AppContext } from '../../application/context.ts';
import {
  abandonDeal,
  acceptDealTradeIn,
  confirmDealSale,
  registerDealAtpv,
  rejectDealTradeIn,
  settleDeal,
  startDeal,
} from '../../application/deal-service.ts';
import type { Router } from '../router.ts';
import { errorResponse, json } from '../http-types.ts';
import { dealDto } from '../serialize.ts';
import { asObject, money, oneOf, optionalMoney, optionalText, text } from '../parse.ts';
import { requireActor } from './support.ts';

export function registerDealRoutes(router: Router, context: AppContext): void {
  /**
   * Monta a negociacao sobre a trava ativa. O liquido vem do snapshot da trava:
   * a Loja B fecha pelo numero que travou, nao pelo preco atual do cadastro.
   */
  router.post('/api/v1/veiculos/:id/negociacao', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const body = asObject(request.body);
    if (!body.ok) return errorResponse(body.error, request.requestId);

    const retail = money(body.value, 'precoAoConsumidor');
    if (!retail.ok) return errorResponse(retail.error, request.requestId);

    const tradeIn = parseTradeIn(body.value['troca']);
    if (!tradeIn.ok) return errorResponse(tradeIn.error, request.requestId);

    const result = await startDeal(context, actor.value, {
      vehicleId: asVehicleId(request.params['id'] as string),
      retailPriceToConsumer: retail.value,
      tradeIn: tradeIn.value,
    });
    if (!result.ok) return errorResponse(result.error, request.requestId);

    return json(201, dealDto(result.value.deal));
  });

  router.get('/api/v1/negociacoes', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const deals = await context.repos.deals.byStore(actor.value.store.id);
    return json(200, { total: deals.length, negociacoes: deals.map(dealDto) });
  });

  router.get('/api/v1/negociacoes/:id', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const deal = await context.repos.deals.byId(asDealId(request.params['id'] as string));
    if (deal === undefined) {
      return json(404, {
        erro: { codigo: 'DEAL_NOT_FOUND', mensagem: 'Negociacao nao encontrada.' },
        requestId: request.requestId,
      });
    }
    return json(200, dealDto(deal));
  });

  /** Aceite do transbordo pela loja proprietaria — abate o liquido a receber. */
  router.post('/api/v1/negociacoes/:id/troca/aceite', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const body = asObject(request.body);
    if (!body.ok) return errorResponse(body.error, request.requestId);

    const value = money(body.value, 'valorAceito');
    if (!value.ok) return errorResponse(value.error, request.requestId);

    const result = await acceptDealTradeIn(
      context,
      actor.value,
      asDealId(request.params['id'] as string),
      value.value,
    );
    if (!result.ok) return errorResponse(result.error, request.requestId);
    return json(200, dealDto(result.value.deal));
  });

  router.post('/api/v1/negociacoes/:id/troca/recusa', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const body = typeof request.body === 'object' && request.body !== null ? (request.body as Record<string, unknown>) : {};
    const result = await rejectDealTradeIn(
      context,
      actor.value,
      asDealId(request.params['id'] as string),
      optionalText(body, 'motivo') ?? 'Modelo fora do perfil da loja',
    );
    if (!result.ok) return errorResponse(result.error, request.requestId);
    return json(200, dealDto(result.value.deal));
  });

  /** Fecha a venda: a trava vira venda e o veiculo sai do estoque da rede. */
  router.post('/api/v1/negociacoes/:id/confirmacao', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const result = await confirmDealSale(context, actor.value, asDealId(request.params['id'] as string));
    if (!result.ok) return errorResponse(result.error, request.requestId);
    return json(200, dealDto(result.value.deal));
  });

  /** Liquidacao da Loja B para a Loja A. Aceita pagamento parcial. */
  router.post('/api/v1/negociacoes/:id/liquidacoes', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const body = asObject(request.body);
    if (!body.ok) return errorResponse(body.error, request.requestId);

    const amount = money(body.value, 'valor');
    if (!amount.ok) return errorResponse(amount.error, request.requestId);

    const method = oneOf(body.value, 'meio', Object.values(SettlementMethod));
    if (!method.ok) return errorResponse(method.error, request.requestId);

    const reference = text(body.value, 'comprovante', { min: 3, max: 200 });
    if (!reference.ok) return errorResponse(reference.error, request.requestId);

    const result = await settleDeal(context, actor.value, {
      dealId: asDealId(request.params['id'] as string),
      amount: amount.value,
      method: method.value,
      reference: reference.value,
    });
    if (!result.ok) return errorResponse(result.error, request.requestId);
    return json(201, dealDto(result.value.deal));
  });

  /** ATPV-e emitido pela loja proprietaria, em cujo nome o veiculo esta. */
  router.post('/api/v1/negociacoes/:id/atpv', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const body = asObject(request.body);
    if (!body.ok) return errorResponse(body.error, request.requestId);

    const atpvNumber = text(body.value, 'numero', { min: 4, max: 60 });
    if (!atpvNumber.ok) return errorResponse(atpvNumber.error, request.requestId);
    const buyerName = text(body.value, 'compradorNome', { min: 3, max: 200 });
    if (!buyerName.ok) return errorResponse(buyerName.error, request.requestId);
    const buyerDocument = text(body.value, 'compradorDocumento', { min: 11, max: 20 });
    if (!buyerDocument.ok) return errorResponse(buyerDocument.error, request.requestId);

    const result = await registerDealAtpv(context, actor.value, {
      dealId: asDealId(request.params['id'] as string),
      atpvNumber: atpvNumber.value,
      buyerName: buyerName.value,
      buyerDocument: buyerDocument.value,
    });
    if (!result.ok) return errorResponse(result.error, request.requestId);
    return json(200, dealDto(result.value));
  });

  router.delete('/api/v1/negociacoes/:id', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const body = typeof request.body === 'object' && request.body !== null ? (request.body as Record<string, unknown>) : {};
    const result = await abandonDeal(
      context,
      actor.value,
      asDealId(request.params['id'] as string),
      optionalText(body, 'motivo') ?? 'Cliente desistiu',
    );
    if (!result.ok) return errorResponse(result.error, request.requestId);
    return json(200, dealDto(result.value));
  });
}

function parseTradeIn(input: unknown): Result<TradeIn | null, DomainError> {
  if (input === undefined || input === null) return ok(null);
  if (typeof input !== 'object') {
    return err(validationError('TRADE_IN_INVALID', 'Dados do veiculo de troca invalidos.'));
  }

  const raw = input as Record<string, unknown>;
  const vehicle = typeof raw['veiculo'] === 'object' && raw['veiculo'] !== null
    ? (raw['veiculo'] as Record<string, unknown>)
    : {};

  const plate = parsePlate(vehicle['placa'], 'placa do veiculo de troca');
  if (!plate.ok) return plate;
  const brand = requireText(vehicle['marca'], 'marca do veiculo de troca', { min: 2, max: 60 });
  if (!brand.ok) return brand;
  const model = requireText(vehicle['modelo'], 'modelo do veiculo de troca', { min: 1, max: 80 });
  if (!model.ok) return model;
  const modelYear = requireInteger(vehicle['anoModelo'], 'ano do veiculo de troca', {
    min: 1900,
    max: new Date().getUTCFullYear() + 2,
  });
  if (!modelYear.ok) return modelYear;
  const mileageKm = requireInteger(vehicle['km'], 'km do veiculo de troca', { min: 0, max: 2_000_000 });
  if (!mileageKm.ok) return mileageKm;

  const allowance = optionalMoney(raw, 'valorDadoAoCliente');
  if (!allowance.ok) return allowance;
  const appraised = optionalMoney(raw, 'avaliacao');
  if (!appraised.ok) return appraised;

  const destination = typeof raw['destino'] === 'string' &&
    (Object.values(TradeInDestination) as string[]).includes(raw['destino'])
      ? (raw['destino'] as TradeInDestination)
      : TradeInDestination.SELLER_STOCK;

  return ok({
    vehicle: {
      plate: plate.value.plate,
      brand: brand.value,
      model: model.value,
      version: typeof vehicle['versao'] === 'string' ? vehicle['versao'] : '',
      modelYear: modelYear.value,
      mileageKm: mileageKm.value,
      color: typeof vehicle['cor'] === 'string' ? vehicle['cor'] : 'Nao informada',
      notes: typeof raw['observacoes'] === 'string' ? raw['observacoes'] : null,
    },
    allowanceToConsumer: allowance.value ?? ZERO,
    appraisedValue: appraised.value ?? allowance.value ?? ZERO,
    destination,
    ownerAcceptance: null,
  });
}
