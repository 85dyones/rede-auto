/**
 * Rotas de custodia fisica e de recall.
 */

import { asCustodyTransferId, asRecallId, asStoreId, asVehicleId } from '../../domain/shared/ids.ts';
import { TransferPurpose, sealTerm } from '../../domain/custody/custody.ts';
import { RecallReason } from '../../domain/recall/recall.ts';
import type { AppContext } from '../../application/context.ts';
import {
  abortCustodyTransfer,
  completeCustodyTransfer,
  custodianAt,
  custodyHistory,
  deliverVehicleToConsumer,
  recallBoard,
  requestVehicleRecall,
  startCustodyTransfer,
  withdrawRecall,
} from '../../application/custody-service.ts';
import type { Router } from '../router.ts';
import { errorResponse, json } from '../http-types.ts';
import { custodyPeriodDto, dealDto, recallDto, transferDto } from '../serialize.ts';
import { asObject, oneOf, optionalText, queryInstant, text } from '../parse.ts';
import { requireActor } from './support.ts';

export function registerCustodyRoutes(router: Router, context: AppContext): void {
  /**
   * Abre o termo de saida. Quem assina e a loja que esta com o carro — o corpo
   * traz a vistoria (odometro, combustivel, fotos, avarias) e o responsavel.
   */
  router.post('/api/v1/veiculos/:id/custodia/saidas', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const body = asObject(request.body);
    if (!body.ok) return errorResponse(body.error, request.requestId);

    const destino = text(body.value, 'lojaDestinoId');
    if (!destino.ok) return errorResponse(destino.error, request.requestId);

    const purpose = oneOf(body.value, 'finalidade', Object.values(TransferPurpose));
    if (!purpose.ok) return errorResponse(purpose.error, request.requestId);

    const term = sealTermFromBody(context, actor.value, body.value['vistoria'], body.value['responsavel']);
    if (!term.ok) return errorResponse(term.error, request.requestId);

    const result = await startCustodyTransfer(context, actor.value, {
      vehicleId: asVehicleId(request.params['id'] as string),
      toStoreId: asStoreId(destino.value),
      purpose: purpose.value,
      checkout: term.value,
    });
    if (!result.ok) return errorResponse(result.error, request.requestId);

    return json(201, { termo: transferDto(result.value.transfer) });
  });

  /**
   * Fecha o termo com a entrada no destino. E este instante — e nao a saida —
   * que transfere a responsabilidade civil.
   */
  router.post('/api/v1/custodia/termos/:id/entrada', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const body = asObject(request.body);
    if (!body.ok) return errorResponse(body.error, request.requestId);

    const term = sealTermFromBody(context, actor.value, body.value['vistoria'], body.value['responsavel']);
    if (!term.ok) return errorResponse(term.error, request.requestId);

    const result = await completeCustodyTransfer(
      context,
      actor.value,
      asCustodyTransferId(request.params['id'] as string),
      term.value,
    );
    if (!result.ok) return errorResponse(result.error, request.requestId);

    return json(200, {
      termo: transferDto(result.value.transfer),
      recallCumprido: result.value.recall === null ? null : recallDto(result.value.recall),
    });
  });

  router.delete('/api/v1/custodia/termos/:id', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const body = typeof request.body === 'object' && request.body !== null ? (request.body as Record<string, unknown>) : {};
    const result = await abortCustodyTransfer(
      context,
      actor.value,
      asCustodyTransferId(request.params['id'] as string),
      optionalText(body, 'motivo') ?? 'Movimentacao cancelada',
    );
    if (!result.ok) return errorResponse(result.error, request.requestId);
    return json(200, { termo: transferDto(result.value) });
  });

  router.post('/api/v1/veiculos/:id/entrega', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const body = asObject(request.body);
    if (!body.ok) return errorResponse(body.error, request.requestId);

    const term = sealTermFromBody(context, actor.value, body.value['vistoria'], body.value['responsavel']);
    if (!term.ok) return errorResponse(term.error, request.requestId);

    const result = await deliverVehicleToConsumer(
      context,
      actor.value,
      asVehicleId(request.params['id'] as string),
      term.value,
    );
    if (!result.ok) return errorResponse(result.error, request.requestId);

    return json(200, {
      entregue: true,
      veiculoId: result.value.vehicle.id,
      // A entrega fisica ja marca a entrega na negociacao: sao o mesmo fato.
      negociacao:
        result.value.deal === null ? null : dealDto(result.value.deal, actor.value.store.id),
    });
  });

  router.get('/api/v1/veiculos/:id/custodia', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const result = await custodyHistory(context, asVehicleId(request.params['id'] as string));
    if (!result.ok) return errorResponse(result.error, request.requestId);

    return json(200, {
      periodos: result.value.periods.map(custodyPeriodDto),
      termos: result.value.transfers.map(transferDto),
    });
  });

  /**
   * "Quem respondia pelo veiculo em tal instante?" — a pergunta que uma multa
   * faz. Responde pelo livro de custodia, nao por quem esta com o carro hoje.
   */
  router.get('/api/v1/veiculos/:id/custodia/responsavel', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const at = queryInstant(request.query, 'em');
    if (!at.ok) return errorResponse(at.error, request.requestId);

    const result = await custodianAt(context, asVehicleId(request.params['id'] as string), at.value);
    if (!result.ok) return errorResponse(result.error, request.requestId);

    const attribution = result.value;
    return json(200, {
      resolvido: attribution.resolved,
      lojaResponsavelId: attribution.resolved ? attribution.storeId : null,
      periodo: attribution.resolved ? custodyPeriodDto(attribution.period) : null,
      motivo: attribution.resolved ? null : attribution.reason,
    });
  });

  // -------------------------------------------------------------------------
  // Recall
  // -------------------------------------------------------------------------

  /**
   * Chamada de retorno pela loja proprietaria. Com trava ativa de terceiro, o
   * recall e aceito mas fica aguardando: o prazo so comeca quando a trava cair.
   */
  router.post('/api/v1/veiculos/:id/recall', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const body = typeof request.body === 'object' && request.body !== null ? (request.body as Record<string, unknown>) : {};
    const reason = oneOf(body, 'motivo', Object.values(RecallReason));
    if (!reason.ok) return errorResponse(reason.error, request.requestId);

    const result = await requestVehicleRecall(context, actor.value, {
      vehicleId: asVehicleId(request.params['id'] as string),
      reason: reason.value,
      note: optionalText(body, 'observacao'),
    });
    if (!result.ok) return errorResponse(result.error, request.requestId);

    return json(201, {
      recall: recallDto(result.value),
      slaHorasUteis: context.policies.recall.slaBusinessHours,
    });
  });

  router.delete('/api/v1/recalls/:id', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const result = await withdrawRecall(context, actor.value, asRecallId(request.params['id'] as string));
    if (!result.ok) return errorResponse(result.error, request.requestId);
    return json(200, { recall: recallDto(result.value) });
  });

  /** Painel: o que devo devolver e o que estou esperando de volta. */
  router.get('/api/v1/recalls', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const board = await recallBoard(context, actor.value.store.id);
    return json(200, {
      devoDevolver: board.incoming.map(recallDto),
      estouEsperando: board.outgoing.map(recallDto),
    });
  });
}

/**
 * Monta e sela o termo de vistoria a partir do corpo da requisicao.
 * A assinatura fica sempre em nome da loja de quem chamou: nao ha como assinar
 * um termo em nome de outra loja.
 */
function sealTermFromBody(
  context: AppContext,
  actor: { store: { id: string }; user: { id: string; name: string } },
  vistoria: unknown,
  responsavel: unknown,
) {
  const signer = typeof responsavel === 'object' && responsavel !== null
    ? (responsavel as Record<string, unknown>)
    : {};

  return sealTerm(
    vistoria,
    {
      name: typeof signer['nome'] === 'string' ? signer['nome'] : actor.user.name,
      document: typeof signer['cpf'] === 'string' ? signer['cpf'] : '',
      role: typeof signer['funcao'] === 'string' ? signer['funcao'] : 'Responsavel de patio',
      userId: actor.user.id as never,
      storeId: actor.store.id as never,
    },
    context.clock.now(),
  );
}
