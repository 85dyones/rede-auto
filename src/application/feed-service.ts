/**
 * Sincronizacao de estoque: liga o ingestor de feed aos repositorios.
 *
 * O ingestor e uma funcao pura que recebe um retrato do estado e devolve as
 * mudancas a aplicar. Este servico so faz a ida e a volta ao banco — e e o que
 * torna possivel testar toda a regra de sincronizacao sem persistencia.
 */

import { type Result, err, ok } from '../domain/shared/result.ts';
import type { DomainError } from '../domain/shared/errors.ts';
import { forbiddenError } from '../domain/shared/errors.ts';
import { asIngestionRunId, asVehicleId } from '../domain/shared/ids.ts';
import { hasManagerPowers } from '../domain/network/store.ts';
import type { Vehicle } from '../domain/vehicle/vehicle.ts';
import {
  type IngestionReport,
  ChangeKind,
  ingestFeed,
} from '../infra/feeds/ingestion.ts';
import { type Actor, type AppContext, publish } from './context.ts';

export type SyncFeedInput = {
  readonly xml: string;
  /** Integrador declarado; se ausente, o formato e detectado pelo conteudo. */
  readonly provider?: string | undefined;
};

export async function syncStoreFeed(
  context: AppContext,
  actor: Actor,
  input: SyncFeedInput,
): Promise<Result<IngestionReport, DomainError>> {
  if (!hasManagerPowers(actor.user)) {
    return err(
      forbiddenError('MANAGER_ROLE_REQUIRED', 'Somente gerente ou titular sincroniza o estoque da loja.'),
    );
  }

  const existing = await context.repos.vehicles.byOwner(actor.store.id);
  const chassisOwners = await context.repos.vehicles.chassisOwners(actor.store.clusterId);

  const report = ingestFeed(input.xml, {
    runId: asIngestionRunId(context.ids.next('ing')),
    clusterId: actor.store.clusterId,
    storeId: actor.store.id,
    now: context.clock.now(),
    provider: input.provider,
    existing,
    chassisOwners,
    nextVehicleId: () => asVehicleId(context.ids.next('veh')),
  });
  if (!report.ok) return report;

  const toPersist: Vehicle[] = [];
  for (const change of report.value.changes) {
    switch (change.kind) {
      case ChangeKind.CREATED:
      case ChangeKind.UNCHANGED:
      case ChangeKind.UPDATED:
      case ChangeKind.MISSING:
        toPersist.push(change.vehicle);
        break;
    }
  }

  await context.repos.vehicles.saveMany(toPersist);
  await publish(context, report.value.events, actor);
  return ok(report.value);
}
