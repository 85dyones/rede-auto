/**
 * Casos de uso do material de divulgacao.
 *
 * Tudo aqui exige loja logada e credenciada — a plataforma nao tem rota publica.
 * Quem consome este material e a loja parceira, que vai republica-lo no canal
 * dela; o consumidor final nunca toca a plataforma.
 */

import { type Result, err, ok } from '../domain/shared/result.ts';
import type { DomainError } from '../domain/shared/errors.ts';
import { conflictError, notFoundError, InvariantViolationError } from '../domain/shared/errors.ts';
import type { VehicleId } from '../domain/shared/ids.ts';
import type { Money } from '../domain/shared/money.ts';
import { hasManagerPowers, type Store } from '../domain/network/store.ts';
import { forbiddenError } from '../domain/shared/errors.ts';
import {
  type VehicleAngle,
  CommercialStatus,
  publishNeutralPhotos,
} from '../domain/vehicle/vehicle.ts';
import { type MaterialKit, buildMaterialKit, findLeaks } from '../domain/material/kit.ts';
import { type Actor, type AppContext, publish } from './context.ts';
import { vehicleNotFound } from './errors.ts';
import { loadVehicle } from './inventory-service.ts';

export type PublishMaterialInput = {
  readonly vehicleId: VehicleId;
  readonly photos: readonly { readonly url: string; readonly angle: VehicleAngle }[];
};

/** A loja dona publica o conjunto neutro. So ela tem o carro para fotografar. */
export async function publishMaterial(
  context: AppContext,
  actor: Actor,
  input: PublishMaterialInput,
): Promise<Result<MaterialKit, DomainError>> {
  if (!hasManagerPowers(actor.user)) {
    return err(
      forbiddenError('MANAGER_ROLE_REQUIRED', 'Somente gerente ou titular publica o material.'),
    );
  }

  const loaded = await loadVehicle(context, input.vehicleId);
  if (!loaded.ok) return loaded;

  const transition = publishNeutralPhotos({
    vehicle: loaded.value.vehicle,
    actorStoreId: actor.store.id,
    photos: input.photos,
    now: context.clock.now(),
  });
  if (!transition.ok) return transition;

  await context.repos.vehicles.save(transition.value.state);
  await publish(context, transition.value.events, actor);

  return ok(
    buildMaterialKit(transition.value.state, {
      mediaBase: mediaBaseFor(input.vehicleId),
      now: context.clock.now(),
    }),
  );
}

export type DownloadMaterialInput = {
  readonly vehicleId: VehicleId;
  /** Gera o material ja com a marca de quem esta baixando. Nunca a da dona. */
  readonly withOwnBranding?: boolean | undefined;
  /** Preco que a parceira pratica. Ela decide; a dona define so o liquido. */
  readonly price?: Money | undefined;
};

/**
 * Monta o kit para a loja que esta baixando.
 *
 * Antes de devolver, `findLeaks` varre o resultado atras de qualquer termo que
 * identifique a loja dona. Se achar, falha alto em vez de entregar — porque
 * este material vai ser republicado por terceiro, e um vazamento aqui aparece
 * no anuncio da parceira.
 */
export async function downloadMaterial(
  context: AppContext,
  actor: Actor,
  input: DownloadMaterialInput,
): Promise<Result<MaterialKit, DomainError>> {
  const loaded = await loadVehicle(context, input.vehicleId);
  if (!loaded.ok) return loaded;

  const vehicle = loaded.value.vehicle;
  if (vehicle.commercialStatus === CommercialStatus.SOLD) {
    return err(
      conflictError('VEHICLE_NO_LONGER_AVAILABLE', 'Este veiculo ja foi vendido.', {
        vehicleId: vehicle.id,
      }),
    );
  }

  const owner = await context.repos.stores.byId(vehicle.ownerStoreId);
  if (owner === undefined) {
    return err(notFoundError('STORE_NOT_FOUND', 'Loja proprietaria nao encontrada.'));
  }

  const kit = buildMaterialKit(vehicle, {
    mediaBase: mediaBaseFor(input.vehicleId),
    ...(input.withOwnBranding === true ? { partner: actor.store } : {}),
    ...(input.price === undefined ? {} : { partnerPrice: input.price }),
    now: context.clock.now(),
  });

  // A dona baixando o proprio material nao e white-label: o nome dela ali e
  // assinatura, nao vazamento.
  if (actor.store.id !== owner.id) {
    const leaks = findLeaks(kit, vehicle, owner);
    if (leaks.length > 0) {
      throw new InvariantViolationError(
        `o material de divulgacao vazaria dados da loja proprietaria: ${leaks.join(', ')}`,
      );
    }
  }

  return ok(kit);
}

/** Foto neutra por indice, servida pela plataforma. */
export async function resolveNeutralPhoto(
  context: AppContext,
  vehicleId: VehicleId,
  index: number,
): Promise<Result<string, DomainError>> {
  const vehicle = await context.repos.vehicles.byId(vehicleId);
  if (vehicle === undefined) return err(vehicleNotFound(vehicleId));

  const photo = vehicle.neutralPhotos[index];
  if (photo === undefined) {
    return err(notFoundError('PHOTO_NOT_FOUND', 'Foto nao encontrada no material deste veiculo.'));
  }
  return ok(photo.url);
}

/** O laudo cautelar em PDF — o unico documento do carro que circula na rede. */
export async function resolveInspectionFile(
  context: AppContext,
  vehicleId: VehicleId,
): Promise<Result<string, DomainError>> {
  const vehicle = await context.repos.vehicles.byId(vehicleId);
  if (vehicle === undefined) return err(vehicleNotFound(vehicleId));

  if (vehicle.inspection.fileUrl === null) {
    return err(
      notFoundError('INSPECTION_FILE_NOT_FOUND', 'Este veiculo nao tem o laudo cautelar anexado.', {
        inspectionStatus: vehicle.inspection.status,
      }),
    );
  }
  return ok(vehicle.inspection.fileUrl);
}

function mediaBaseFor(vehicleId: VehicleId): string {
  return `/api/v1/veiculos/${vehicleId}/material`;
}

export type { Store };
