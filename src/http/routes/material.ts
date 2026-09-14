/**
 * Rotas do material de divulgacao. Todas exigem loja logada — a plataforma nao
 * tem superficie publica.
 */

import { asVehicleId } from '../../domain/shared/ids.ts';
import { VehicleAngle } from '../../domain/vehicle/vehicle.ts';
import type { AppContext } from '../../application/context.ts';
import {
  downloadMaterial,
  publishMaterial,
  resolveInspectionFile,
  resolveNeutralPhoto,
} from '../../application/material-service.ts';
import { renderFichaPdf } from '../../infra/render/ficha.ts';
import type { Router } from '../router.ts';
import { errorResponse, json, pdf, redirect } from '../http-types.ts';
import { materialKitDto } from '../serialize.ts';
import { asObject, optionalBoolean, optionalMoney } from '../parse.ts';
import { requireActor } from './support.ts';

export function registerMaterialRoutes(router: Router, context: AppContext): void {
  /** Manifesto do kit: ficha neutra, fotos e laudo disponiveis. */
  router.get('/api/v1/veiculos/:id/material', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const price = optionalMoney(
      { preco: request.query.get('preco') ?? undefined },
      'preco',
    );

    const result = await downloadMaterial(context, actor.value, {
      vehicleId: asVehicleId(request.params['id'] as string),
      withOwnBranding: request.query.get('comMinhaLoja') === 'true',
      ...(price.ok && price.value !== undefined ? { price: price.value } : {}),
    });
    if (!result.ok) return errorResponse(result.error, request.requestId);

    return json(200, materialKitDto(result.value));
  });

  /** Ficha tecnica em PDF. Neutra por padrao; com a marca da parceira se ela pedir. */
  router.get('/api/v1/veiculos/:id/material/ficha.pdf', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const price = optionalMoney({ preco: request.query.get('preco') ?? undefined }, 'preco');

    const result = await downloadMaterial(context, actor.value, {
      vehicleId: asVehicleId(request.params['id'] as string),
      withOwnBranding: request.query.get('comMinhaLoja') === 'true',
      ...(price.ok && price.value !== undefined ? { price: price.value } : {}),
    });
    if (!result.ok) return errorResponse(result.error, request.requestId);

    return pdf(`ficha-${result.value.sheet.reference}.pdf`, renderFichaPdf(result.value));
  });

  /**
   * Proxy das fotos neutras.
   *
   * Redireciona para o arquivo hospedado. Serve para manter um unico caminho com
   * controle de acesso: material de veiculo vendido ou de loja suspensa para de
   * responder sem precisar mexer em onde os bytes estao.
   */
  router.get('/api/v1/veiculos/:id/material/fotos/:indice', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const index = Number.parseInt(request.params['indice'] ?? '', 10);
    if (!Number.isFinite(index) || index < 0) {
      return json(400, {
        erro: { codigo: 'PHOTO_INDEX_INVALID', mensagem: 'Indice de foto invalido.' },
        requestId: request.requestId,
      });
    }

    const result = await resolveNeutralPhoto(
      context,
      asVehicleId(request.params['id'] as string),
      index,
    );
    if (!result.ok) return errorResponse(result.error, request.requestId);
    return redirect(result.value);
  });

  /** Laudo cautelar em PDF. */
  router.get('/api/v1/veiculos/:id/material/laudo.pdf', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const result = await resolveInspectionFile(
      context,
      asVehicleId(request.params['id'] as string),
    );
    if (!result.ok) return errorResponse(result.error, request.requestId);
    return redirect(result.value);
  });

  /** A loja dona publica o conjunto neutro de fotos. */
  router.post('/api/v1/veiculos/:id/material/fotos', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const body = asObject(request.body);
    if (!body.ok) return errorResponse(body.error, request.requestId);

    const raw = Array.isArray(body.value['fotos']) ? body.value['fotos'] : [];
    const photos = raw
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({
        url: typeof item['url'] === 'string' ? item['url'] : '',
        angle: item['angulo'] as VehicleAngle,
      }));

    const result = await publishMaterial(context, actor.value, {
      vehicleId: asVehicleId(request.params['id'] as string),
      photos,
    });
    if (!result.ok) return errorResponse(result.error, request.requestId);

    return json(201, materialKitDto(result.value));
  });
}

export { optionalBoolean };
