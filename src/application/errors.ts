/**
 * Erros de aplicacao — os que nascem de "o registro nao existe", nao de uma
 * regra de negocio violada.
 */

import { type DomainError, notFoundError } from '../domain/shared/errors.ts';

export const vehicleNotFound = (id: string): DomainError =>
  notFoundError('VEHICLE_NOT_FOUND', 'Veiculo nao encontrado.', { vehicleId: id });

export const lockNotFound = (id: string): DomainError =>
  notFoundError('LOCK_NOT_FOUND', 'Trava comercial nao encontrada.', { lockId: id });

export const storeNotFound = (id: string): DomainError =>
  notFoundError('STORE_NOT_FOUND', 'Loja nao encontrada.', { storeId: id });

export const userNotFound = (id: string): DomainError =>
  notFoundError('USER_NOT_FOUND', 'Usuario nao encontrado.', { userId: id });

export const applicationNotFound = (id: string): DomainError =>
  notFoundError('APPLICATION_NOT_FOUND', 'Candidatura nao encontrada.', { applicationId: id });

export const transferNotFound = (id: string): DomainError =>
  notFoundError('TRANSFER_NOT_FOUND', 'Termo de custodia nao encontrado.', { transferId: id });

export const recallNotFound = (id: string): DomainError =>
  notFoundError('RECALL_NOT_FOUND', 'Recall nao encontrado.', { recallId: id });

export const dealNotFound = (id: string): DomainError =>
  notFoundError('DEAL_NOT_FOUND', 'Negociacao nao encontrada.', { dealId: id });

export const shareLinkNotFound = (): DomainError =>
  notFoundError('SHARE_LINK_NOT_FOUND', 'Link nao encontrado ou ja removido.');

export const noActiveLock = (vehicleId: string): DomainError =>
  notFoundError('NO_ACTIVE_LOCK', 'Este veiculo nao tem trava comercial ativa.', { vehicleId });
