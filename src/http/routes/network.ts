/**
 * Rotas de rede e governanca: lojas, credenciamento e votacao dos fundadores.
 */

import { notFoundError } from '../../domain/shared/errors.ts';
import { asApplicationId } from '../../domain/shared/ids.ts';
import type { AppContext } from '../../application/context.ts';
import {
  retireApplication,
  submitApplication,
  viewApplication,
  endorseApplication,
} from '../../application/governance-service.ts';
import type { Router } from '../router.ts';
import { errorResponse, json } from '../http-types.ts';
import { applicationDto, clusterDto, storeDto } from '../serialize.ts';
import { asObject, optionalText } from '../parse.ts';
import { requireActor } from './support.ts';

export function registerNetworkRoutes(router: Router, context: AppContext): void {
  /** As lojas da **sua** praca. Nao existe "todas as lojas da instalacao". */
  router.get('/api/v1/lojas', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const stores = await context.repos.stores.byCluster(actor.value.store.clusterId);
    return json(200, {
      total: stores.length,
      lojas: stores.map(storeDto),
    });
  });

  /** A praca em que esta loja opera: alcance declarado e municipios atendidos. */
  router.get('/api/v1/cluster', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const cluster = await context.repos.clusters.byId(actor.value.store.clusterId);
    if (cluster === undefined) {
      return errorResponse(
        notFoundError('CLUSTER_NOT_FOUND', 'A praca desta loja nao foi encontrada.'),
        request.requestId,
      );
    }
    return json(200, { cluster: clusterDto(cluster) });
  });

  router.get('/api/v1/lojas/fundadoras', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const founders = await context.repos.stores.founders(actor.value.store.clusterId);
    return json(200, {
      total: founders.length,
      endossosParaCredenciar: context.policies.governance.requiredEndorsements,
      lojas: founders.map(storeDto),
    });
  });

  router.post('/api/v1/credenciamentos', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const body = asObject(request.body);
    if (!body.ok) return errorResponse(body.error, request.requestId);

    const result = await submitApplication(context, actor.value, body.value['candidata'] ?? body.value);
    if (!result.ok) return errorResponse(result.error, request.requestId);

    return json(201, applicationDto(result.value.application, result.value.tally, null));
  });

  router.get('/api/v1/credenciamentos/:id', async (request) => {
    const result = await viewApplication(context, asApplicationId(request.params['id'] as string));
    if (!result.ok) return errorResponse(result.error, request.requestId);
    return json(200, applicationDto(result.value.application, result.value.tally, result.value.admittedStore));
  });

  router.get('/api/v1/credenciamentos', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const pending = await context.repos.memberships.pending(actor.value.store.clusterId);
    const views = [];
    for (const application of pending) {
      const view = await viewApplication(context, application.id);
      if (view.ok) views.push(applicationDto(view.value.application, view.value.tally, null));
    }
    return json(200, { total: views.length, candidaturas: views });
  });

  /**
   * Endosso de fundadora. O terceiro endosso ja credencia — quem decide quem
   * entra sao os membros, e a plataforma so opera.
   */
  router.post('/api/v1/credenciamentos/:id/endossos', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const body = asObject(request.body);
    if (!body.ok) return errorResponse(body.error, request.requestId);

    const result = await endorseApplication(
      context,
      actor.value,
      asApplicationId(request.params['id'] as string),
      optionalText(body.value, 'justificativa'),
    );
    if (!result.ok) return errorResponse(result.error, request.requestId);

    return json(200, applicationDto(result.value.application, result.value.tally, result.value.admittedStore));
  });

  router.get('/api/v1/credenciamentos', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const pending = await context.repos.memberships.pending(actor.value.store.clusterId);
    const views = [];
    for (const application of pending) {
      const view = await viewApplication(context, application.id);
      if (view.ok) views.push(applicationDto(view.value.application, view.value.tally, null));
    }
    return json(200, { total: views.length, candidaturas: views });
  });

  /**
   * Endosso de fundadora. NAO credencia — a candidatura segue pendente ate a
   * plataforma decidir. Endosso e a palavra de quem conhece a candidata; a
   * admissao e decisao de quem opera a rede.
   */
  router.post('/api/v1/credenciamentos/:id/endossos', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const body = asObject(request.body);
    if (!body.ok) return errorResponse(body.error, request.requestId);

    const result = await endorseApplication(
      context,
      actor.value,
      asApplicationId(request.params['id'] as string),
      optionalText(body.value, 'justificativa'),
    );
    if (!result.ok) return errorResponse(result.error, request.requestId);

    return json(200, applicationDto(result.value.application, result.value.tally, null));
  });

  router.delete('/api/v1/credenciamentos/:id', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const result = await retireApplication(
      context,
      actor.value,
      asApplicationId(request.params['id'] as string),
    );
    if (!result.ok) return errorResponse(result.error, request.requestId);
    return json(200, applicationDto(result.value.application, result.value.tally, null));
  });
}
