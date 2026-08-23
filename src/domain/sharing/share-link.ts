/**
 * Link temporario white-label.
 *
 * O vendedor da Loja B precisa mandar a ficha do carro para o cliente pelo
 * WhatsApp agora. O que ele NAO pode mandar e qualquer pista de que o carro e
 * da Loja A: se o cliente descobre a origem, ele atravessa a Loja B e vai
 * direto na dona — e o modelo de rede desmorona no primeiro repasse.
 *
 * O link e temporario e contado por dois motivos praticos: o preco que a Loja B
 * pratica muda, e um link eterno circulando em grupo de WhatsApp vira anuncio
 * fantasma de um carro que ja foi vendido.
 */

import { type Result, err, ok } from '../shared/result.ts';
import { type DomainError, conflictError, forbiddenError, ruleViolation } from '../shared/errors.ts';
import { domainEvent } from '../shared/events.ts';
import { type Transition, transitioned } from '../shared/transition.ts';
import type { Instant } from '../shared/clock.ts';
import { DAY } from '../shared/clock.ts';
import type { ShareLinkId, StoreId, UserId, VehicleId } from '../shared/ids.ts';
import { type Money, isPositive } from '../shared/money.ts';
import { type Vehicle, CommercialStatus } from '../vehicle/vehicle.ts';
import { randomBytes } from 'node:crypto';

export type SharingPolicy = {
  readonly defaultTtlMs: number;
  readonly maxTtlMs: number;
  readonly defaultMaxViews: number;
};

export const DEFAULT_SHARING_POLICY: SharingPolicy = {
  defaultTtlMs: 2 * DAY,
  maxTtlMs: 7 * DAY,
  defaultMaxViews: 300,
};

export type ShareLink = {
  readonly id: ShareLinkId;
  /** Token opaco de 32 bytes: nao ha id sequencial para enumerar. */
  readonly token: string;
  readonly vehicleId: VehicleId;
  /** Loja que compartilhou — a unica que aparece na lamina. */
  readonly sharedByStoreId: StoreId;
  readonly createdByUserId: UserId;
  /** Preco escolhido pela loja vendedora. Nunca o liquido de repasse. */
  readonly displayPrice: Money;
  /**
   * Placa completa permite consulta publica que revela o proprietario.
   * Por isso o padrao e ocultar, e mesmo habilitada ela sai mascarada.
   */
  readonly showPlate: boolean;
  readonly createdAt: Instant;
  readonly expiresAt: Instant;
  readonly maxViews: number;
  readonly viewCount: number;
  readonly revokedAt: Instant | null;
  readonly revokeReason: string | null;
};

export type CreateShareLinkCommand = {
  readonly linkId: ShareLinkId;
  readonly vehicle: Vehicle;
  readonly sharedByStoreId: StoreId;
  readonly createdByUserId: UserId;
  readonly displayPrice?: Money | undefined;
  readonly showPlate?: boolean | undefined;
  readonly ttlMs?: number | undefined;
  readonly maxViews?: number | undefined;
  readonly now: Instant;
  readonly policy?: SharingPolicy;
};

export function createShareLink(command: CreateShareLinkCommand): Transition<ShareLink> {
  const policy = command.policy ?? DEFAULT_SHARING_POLICY;
  const { vehicle, now } = command;

  if (
    vehicle.commercialStatus !== CommercialStatus.AVAILABLE &&
    vehicle.commercialStatus !== CommercialStatus.LOCKED
  ) {
    return err(
      conflictError(
        'VEHICLE_NOT_SHAREABLE',
        'So e possivel compartilhar veiculos que estao circulando na rede.',
        { vehicleId: vehicle.id, status: vehicle.commercialStatus },
      ),
    );
  }

  const displayPrice = command.displayPrice ?? vehicle.pricing.publicPrice;
  if (!isPositive(displayPrice)) {
    return err(ruleViolation('DISPLAY_PRICE_INVALID', 'O preco exibido ao cliente deve ser positivo.'));
  }

  const ttl = Math.min(command.ttlMs ?? policy.defaultTtlMs, policy.maxTtlMs);
  const maxViews = Math.max(1, Math.min(command.maxViews ?? policy.defaultMaxViews, 10_000));

  const link: ShareLink = {
    id: command.linkId,
    token: randomBytes(24).toString('base64url'),
    vehicleId: vehicle.id,
    sharedByStoreId: command.sharedByStoreId,
    createdByUserId: command.createdByUserId,
    displayPrice,
    showPlate: command.showPlate ?? false,
    createdAt: now,
    expiresAt: now + ttl,
    maxViews,
    viewCount: 0,
    revokedAt: null,
    revokeReason: null,
  };

  return transitioned(link, [
    domainEvent('sharing.link_created', vehicle.id, now, {
      linkId: link.id,
      sharedByStoreId: link.sharedByStoreId,
      displayPriceCents: link.displayPrice.cents,
      expiresAt: link.expiresAt,
      showPlate: link.showPlate,
    }),
  ]);
}

export const LinkUnavailableReason = {
  EXPIRED: 'EXPIRED',
  REVOKED: 'REVOKED',
  VIEW_LIMIT_REACHED: 'VIEW_LIMIT_REACHED',
} as const;
export type LinkUnavailableReason =
  (typeof LinkUnavailableReason)[keyof typeof LinkUnavailableReason];

export function linkUnavailableReason(
  link: ShareLink,
  now: Instant,
): LinkUnavailableReason | null {
  if (link.revokedAt !== null) return LinkUnavailableReason.REVOKED;
  if (now >= link.expiresAt) return LinkUnavailableReason.EXPIRED;
  if (link.viewCount >= link.maxViews) return LinkUnavailableReason.VIEW_LIMIT_REACHED;
  return null;
}

export function isUsable(link: ShareLink, now: Instant): boolean {
  return linkUnavailableReason(link, now) === null;
}

/** Contabiliza uma abertura. Devolve erro se o link ja nao vale mais. */
export function registerView(link: ShareLink, now: Instant): Result<ShareLink, DomainError> {
  const reason = linkUnavailableReason(link, now);
  if (reason !== null) {
    return err(
      conflictError('SHARE_LINK_UNAVAILABLE', unavailableMessage(reason), {
        linkId: link.id,
        reason,
      }),
    );
  }
  return ok({ ...link, viewCount: link.viewCount + 1 });
}

function unavailableMessage(reason: LinkUnavailableReason): string {
  switch (reason) {
    case LinkUnavailableReason.EXPIRED:
      return 'Este link expirou. Peca um novo ao vendedor.';
    case LinkUnavailableReason.REVOKED:
      return 'Este link foi desativado pelo vendedor.';
    case LinkUnavailableReason.VIEW_LIMIT_REACHED:
      return 'Este link atingiu o limite de aberturas.';
  }
}

export type RevokeShareLinkCommand = {
  readonly link: ShareLink;
  readonly actorStoreId: StoreId;
  readonly reason: string;
  readonly now: Instant;
};

export function revokeShareLink(command: RevokeShareLinkCommand): Transition<ShareLink> {
  const { link, now } = command;

  if (command.actorStoreId !== link.sharedByStoreId) {
    return err(
      forbiddenError('NOT_LINK_OWNER', 'Somente a loja que gerou o link pode desativa-lo.', {
        linkId: link.id,
      }),
    );
  }
  if (link.revokedAt !== null) return transitioned(link, []);

  return transitioned({ ...link, revokedAt: now, revokeReason: command.reason }, [
    domainEvent('sharing.link_revoked', link.vehicleId, now, {
      linkId: link.id,
      reason: command.reason,
      viewCount: link.viewCount,
    }),
  ]);
}
