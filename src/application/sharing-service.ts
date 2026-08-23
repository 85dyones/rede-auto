/**
 * Casos de uso de compartilhamento white-label.
 *
 * A rota publica (`/s/:token`) e a unica que responde sem autenticacao. Por
 * isso ela passa obrigatoriamente pela sanitizacao e pelo guarda de vazamento:
 * e a fronteira entre a rede B2B e o cliente final.
 */

import { type Result, err, ok } from '../domain/shared/result.ts';
import type { DomainError } from '../domain/shared/errors.ts';
import { conflictError, notFoundError } from '../domain/shared/errors.ts';
import { asShareLinkId, type ShareLinkId, type VehicleId } from '../domain/shared/ids.ts';
import type { Money } from '../domain/shared/money.ts';
import { InvariantViolationError } from '../domain/shared/errors.ts';
import {
  type ShareLink,
  createShareLink,
  registerView,
  revokeShareLink,
} from '../domain/sharing/share-link.ts';
import {
  type WhiteLabelSheet,
  buildWhiteLabelSheet,
  findLeaks,
} from '../domain/sharing/spec-sheet.ts';
import { CommercialStatus } from '../domain/vehicle/vehicle.ts';
import { type Actor, type AppContext, publish } from './context.ts';
import { shareLinkNotFound, vehicleNotFound } from './errors.ts';
import { loadVehicle } from './inventory-service.ts';

export type CreateShareInput = {
  readonly vehicleId: VehicleId;
  readonly displayPrice?: Money | undefined;
  readonly showPlate?: boolean | undefined;
  readonly ttlMs?: number | undefined;
  readonly maxViews?: number | undefined;
};

export async function shareVehicle(
  context: AppContext,
  actor: Actor,
  input: CreateShareInput,
): Promise<Result<ShareLink, DomainError>> {
  const loaded = await loadVehicle(context, input.vehicleId);
  if (!loaded.ok) return loaded;

  const transition = createShareLink({
    linkId: asShareLinkId(context.ids.next('shr')),
    vehicle: loaded.value.vehicle,
    sharedByStoreId: actor.store.id,
    createdByUserId: actor.user.id,
    displayPrice: input.displayPrice,
    showPlate: input.showPlate,
    ttlMs: input.ttlMs,
    maxViews: input.maxViews,
    now: context.clock.now(),
    policy: context.policies.sharing,
  });
  if (!transition.ok) return transition;

  await context.repos.shareLinks.save(transition.value.state);
  await publish(context, transition.value.events, actor);
  return ok(transition.value.state);
}

export async function revokeShare(
  context: AppContext,
  actor: Actor,
  linkId: ShareLinkId,
  reason: string,
): Promise<Result<ShareLink, DomainError>> {
  const link = await context.repos.shareLinks.byId(linkId);
  if (link === undefined) return err(shareLinkNotFound());

  const transition = revokeShareLink({
    link,
    actorStoreId: actor.store.id,
    reason,
    now: context.clock.now(),
  });
  if (!transition.ok) return transition;

  await context.repos.shareLinks.save(transition.value.state);
  await publish(context, transition.value.events, actor);
  return ok(transition.value.state);
}

export type PublicSheet = {
  readonly sheet: WhiteLabelSheet;
  readonly link: ShareLink;
  /** URLs originais das fotos, para o proxy servir — nunca vao na lamina. */
  readonly photoSources: readonly string[];
};

/**
 * Resolve o link publico e devolve a lamina ja sanitizada.
 *
 * Antes de responder, `findLeaks` varre o resultado atras de qualquer termo que
 * identifique a loja proprietaria. Se achar, a requisicao falha alto em vez de
 * vazar: entregar a origem ao cliente final quebraria o modelo da rede.
 */
export async function resolvePublicSheet(
  context: AppContext,
  token: string,
  publicBaseUrl: string,
): Promise<Result<PublicSheet, DomainError>> {
  const link = await context.repos.shareLinks.byToken(token);
  if (link === undefined) return err(shareLinkNotFound());

  const viewed = registerView(link, context.clock.now());
  if (!viewed.ok) return viewed;

  const vehicle = await context.repos.vehicles.byId(link.vehicleId);
  if (vehicle === undefined) return err(vehicleNotFound(link.vehicleId));

  // Um link continua valido, mas um carro vendido nao pode seguir anunciado.
  if (
    vehicle.commercialStatus === CommercialStatus.SOLD ||
    vehicle.commercialStatus === CommercialStatus.WITHDRAWN
  ) {
    return err(
      conflictError(
        'VEHICLE_NO_LONGER_AVAILABLE',
        'Este veiculo nao esta mais disponivel. Fale com o vendedor.',
        { status: vehicle.commercialStatus },
      ),
    );
  }

  const presenter = await context.repos.stores.byId(link.sharedByStoreId);
  const owner = await context.repos.stores.byId(vehicle.ownerStoreId);
  if (presenter === undefined || owner === undefined) {
    return err(notFoundError('STORE_NOT_FOUND', 'Loja nao encontrada.'));
  }

  const sheet = buildWhiteLabelSheet(vehicle, viewed.value, presenter, {
    photoProxyBase: `${publicBaseUrl}/s/${viewed.value.token}/fotos`,
    now: context.clock.now(),
  });

  const leaks = findLeaks(sheet, vehicle, owner, presenter);
  if (leaks.length > 0) {
    // Nao ha resposta segura aqui: melhor falhar do que entregar a origem.
    throw new InvariantViolationError(
      `a lamina white-label vazaria dados da loja proprietaria: ${leaks.join(', ')}`,
    );
  }

  await context.repos.shareLinks.save(viewed.value);
  return ok({ sheet, link: viewed.value, photoSources: vehicle.specs.photos });
}

/** Foto original por indice, para o proxy. Valida o link a cada acesso. */
export async function resolveSharedPhoto(
  context: AppContext,
  token: string,
  index: number,
): Promise<Result<string, DomainError>> {
  const link = await context.repos.shareLinks.byToken(token);
  if (link === undefined) return err(shareLinkNotFound());

  const vehicle = await context.repos.vehicles.byId(link.vehicleId);
  if (vehicle === undefined) return err(vehicleNotFound(link.vehicleId));

  const photo = vehicle.specs.photos[index];
  if (photo === undefined) return err(notFoundError('PHOTO_NOT_FOUND', 'Foto nao encontrada.'));
  return ok(photo);
}
