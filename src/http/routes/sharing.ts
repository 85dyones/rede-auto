/**
 * Rotas de compartilhamento white-label.
 *
 * As rotas `/s/*` sao PUBLICAS: e nelas que o cliente final abre a lamina. Elas
 * nunca recebem `Actor` e nunca tocam agregado sem passar pela sanitizacao.
 */

import { asShareLinkId, asVehicleId } from '../../domain/shared/ids.ts';
import type { AppContext } from '../../application/context.ts';
import {
  resolvePublicSheet,
  resolveSharedPhoto,
  revokeShare,
  shareVehicle,
} from '../../application/sharing-service.ts';
import { renderLaminaHtml, renderLaminaPdf } from '../../infra/render/lamina.ts';
import type { Router } from '../router.ts';
import { errorResponse, html, json, pdf, redirect } from '../http-types.ts';
import { shareLinkDto, whiteLabelSheetDto } from '../serialize.ts';
import { optionalBoolean, optionalInteger, optionalMoney, optionalText } from '../parse.ts';
import { requireActor } from './support.ts';

export function registerSharingRoutes(router: Router, context: AppContext, publicBaseUrl: string): void {
  router.post('/api/v1/veiculos/:id/compartilhamentos', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const body = typeof request.body === 'object' && request.body !== null
      ? (request.body as Record<string, unknown>)
      : {};

    const displayPrice = optionalMoney(body, 'precoExibido');
    if (!displayPrice.ok) return errorResponse(displayPrice.error, request.requestId);

    const horas = optionalInteger(body, 'validadeHoras');

    const result = await shareVehicle(context, actor.value, {
      vehicleId: asVehicleId(request.params['id'] as string),
      displayPrice: displayPrice.value,
      showPlate: optionalBoolean(body, 'exibePlaca'),
      ttlMs: horas === undefined ? undefined : horas * 3_600_000,
      maxViews: optionalInteger(body, 'limiteAberturas'),
    });
    if (!result.ok) return errorResponse(result.error, request.requestId);

    return json(201, shareLinkDto(result.value, publicBaseUrl));
  });

  router.get('/api/v1/veiculos/:id/compartilhamentos', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const links = await context.repos.shareLinks.byVehicle(asVehicleId(request.params['id'] as string));
    const meus = links.filter((link) => link.sharedByStoreId === actor.value.store.id);
    return json(200, {
      total: meus.length,
      compartilhamentos: meus.map((link) => shareLinkDto(link, publicBaseUrl)),
    });
  });

  router.delete('/api/v1/compartilhamentos/:id', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const body = typeof request.body === 'object' && request.body !== null
      ? (request.body as Record<string, unknown>)
      : {};

    const result = await revokeShare(
      context,
      actor.value,
      asShareLinkId(request.params['id'] as string),
      optionalText(body, 'motivo') ?? 'Desativado pelo vendedor',
    );
    if (!result.ok) return errorResponse(result.error, request.requestId);
    return json(200, shareLinkDto(result.value, publicBaseUrl));
  });

  // -------------------------------------------------------------------------
  // Publico — sem autenticacao
  // -------------------------------------------------------------------------

  /** Ficha em JSON, para quem quiser embutir a lamina em outro lugar. */
  router.get(
    '/s/:token',
    async (request) => {
      const result = await resolvePublicSheet(context, request.params['token'] as string, publicBaseUrl);
      if (!result.ok) return errorResponse(result.error, request.requestId);
      return json(200, whiteLabelSheetDto(result.value.sheet));
    },
    { public: true },
  );

  router.get(
    '/s/:token/lamina.html',
    async (request) => {
      const result = await resolvePublicSheet(context, request.params['token'] as string, publicBaseUrl);
      if (!result.ok) return errorResponse(result.error, request.requestId);
      return html(200, renderLaminaHtml(result.value.sheet));
    },
    { public: true },
  );

  router.get(
    '/s/:token/lamina.pdf',
    async (request) => {
      const result = await resolvePublicSheet(context, request.params['token'] as string, publicBaseUrl);
      if (!result.ok) return errorResponse(result.error, request.requestId);
      return pdf(`ficha-${result.value.sheet.reference}.pdf`, renderLaminaPdf(result.value.sheet));
    },
    { public: true },
  );

  /**
   * Proxy das fotos.
   *
   * Redireciona em vez de servir os bytes: sem cache nem banda propria, mas o
   * ponto e outro — a URL original nunca aparece no HTML nem no JSON da lamina,
   * e o dominio do CDN da loja proprietaria (`cdn.primemotors.com.br/...`) nao
   * chega ao cliente antes de ele decidir abrir a imagem.
   *
   * Para esconder o dominio tambem do trafego, a evolucao natural e servir os
   * bytes por aqui com cache — o contrato desta rota nao muda.
   */
  router.get(
    '/s/:token/fotos/:indice',
    async (request) => {
      const index = Number.parseInt(request.params['indice'] ?? '', 10);
      if (!Number.isFinite(index) || index < 0) {
        return json(400, { erro: { codigo: 'PHOTO_INDEX_INVALID', mensagem: 'Indice de foto invalido.' } });
      }

      const result = await resolveSharedPhoto(context, request.params['token'] as string, index);
      if (!result.ok) return errorResponse(result.error, request.requestId);
      return redirect(result.value);
    },
    { public: true },
  );
}
