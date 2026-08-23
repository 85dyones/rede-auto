/**
 * Rotas de sincronizacao de estoque e de auditoria.
 */

import type { AppContext } from '../../application/context.ts';
import { syncStoreFeed } from '../../application/feed-service.ts';
import { runSweep } from '../../application/scheduler.ts';
import { FEED_MAPPERS } from '../../infra/feeds/mappers/index.ts';
import type { Router } from '../router.ts';
import { errorResponse, json } from '../http-types.ts';
import { ingestionReportDto, instant } from '../serialize.ts';
import { queryInteger, queryText } from '../parse.ts';
import { requireActor } from './support.ts';

export function registerFeedRoutes(router: Router, context: AppContext): void {
  router.get('/api/v1/feeds/integradores', async () =>
    json(200, {
      integradores: FEED_MAPPERS.map((mapper) => ({ id: mapper.provider, nome: mapper.label })),
      observacao:
        'Os esquemas sao modelados a partir dos padroes publicos dos integradores; ajuste o mapeador ao XML real do seu fornecedor.',
    }),
  );

  /**
   * Recebe o XML do integrador. Aceita `text/xml` no corpo; o integrador vem do
   * parametro `integrador` ou e detectado pelo conteudo.
   */
  router.post('/api/v1/feeds/sincronizacao', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const xml = typeof request.body === 'string' ? request.body : request.rawBody.toString('utf8');
    if (xml.trim().length === 0) {
      return json(400, {
        erro: { codigo: 'XML_EMPTY', mensagem: 'Envie o XML do feed no corpo da requisicao.' },
        requestId: request.requestId,
      });
    }

    const result = await syncStoreFeed(context, actor.value, {
      xml,
      provider: queryText(request.query, 'integrador'),
    });
    if (!result.ok) return errorResponse(result.error, request.requestId);

    return json(200, ingestionReportDto(result.value));
  });

  /**
   * Mural de avisos da loja.
   *
   * E o que fecha o laco do produto: sem isto, a trava que expira as 22h so
   * seria descoberta por quem abrisse a tela no dia seguinte, e o gerente
   * continuaria sabendo das coisas por telefone.
   */
  router.get('/api/v1/notificacoes', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const notifications = await context.repos.notifications.forStore({
      storeId: actor.value.store.id,
      unreadOnly: request.query.get('naoLidas') === 'true',
      limit: Math.min(queryInteger(request.query, 'limite') ?? 50, 200),
    });

    return json(200, {
      naoLidas: await context.repos.notifications.unreadCount(actor.value.store.id),
      total: notifications.length,
      avisos: notifications.map((notification) => ({
        id: notification.id,
        tipo: notification.eventType,
        urgencia: notification.severity,
        titulo: notification.title,
        texto: notification.body,
        agregadoId: notification.aggregateId,
        ocorridoEm: instant(notification.occurredAt),
        lidoEm: instant(notification.readAt),
      })),
    });
  });

  router.post('/api/v1/notificacoes/:id/lida', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const updated = await context.repos.notifications.markRead(
      request.params['id'] as string,
      actor.value.store.id,
      context.clock.now(),
    );
    if (updated === undefined) {
      return json(404, {
        erro: { codigo: 'NOTIFICATION_NOT_FOUND', mensagem: 'Aviso nao encontrado.' },
        requestId: request.requestId,
      });
    }

    return json(200, { id: updated.id, lidoEm: instant(updated.readAt) });
  });

  /** Trilha de auditoria derivada dos eventos de dominio. */
  router.get('/api/v1/auditoria', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const aggregateId = queryText(request.query, 'agregadoId');
    const limit = Math.min(queryInteger(request.query, 'limite') ?? 100, 500);

    const entries = aggregateId === undefined
      ? await context.repos.audit.recent(limit)
      : await context.repos.audit.byAggregate(aggregateId, limit);

    return json(200, {
      total: entries.length,
      eventos: entries.map((entry) => ({
        id: entry.id,
        tipo: entry.event.type,
        agregadoId: entry.event.aggregateId,
        ocorridoEm: instant(entry.event.occurredAt),
        lojaAtorId: entry.actorStoreId,
        usuarioAtorId: entry.actorUserId,
        dados: entry.event.payload,
      })),
    });
  });

  /**
   * Dispara a varredura sob demanda.
   *
   * Existe para teste e para operacao; o varredor periodico faz o mesmo
   * sozinho, e a leitura de qualquer veiculo ja reconcilia a trava — por isso
   * chamar esta rota nunca e obrigatorio para a correcao do estado.
   */
  router.post('/api/v1/manutencao/varredura', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const result = await runSweep(context);
    return json(200, {
      travasExpiradas: result.expiredLocks,
      recallsDescumpridos: result.breachedRecalls,
    });
  });
}
