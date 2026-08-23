/**
 * Rotas de estoque e de trava comercial — o catalogo compartilhado da rede.
 */

import { asLockId, asVehicleId } from '../../domain/shared/ids.ts';
import { CommercialStatus, parseVehicleSpecs, InspectionStatus } from '../../domain/vehicle/vehicle.ts';
import { EvidenceType, type Evidence } from '../../domain/lock/evidence.ts';
import { toInstant } from '../../domain/shared/clock.ts';
import type { AppContext } from '../../application/context.ts';
import {
  buildVehicleView,
  extendCommercialLock,
  loadVehicle,
  openCommercialLock,
  recordInspection,
  registerVehicle,
  relistInNetwork,
  releaseCommercialLock,
  searchCatalog,
  updateVehiclePricing,
  withdrawFromNetwork,
} from '../../application/inventory-service.ts';
import type { Router } from '../router.ts';
import { errorResponse, json } from '../http-types.ts';
import { lockDto, vehicleViewDto } from '../serialize.ts';
import {
  asObject,
  money,
  oneOf,
  optionalMoney,
  optionalText,
  queryInteger,
  queryText,
  text,
} from '../parse.ts';
import { requireActor } from './support.ts';

export function registerInventoryRoutes(router: Router, context: AppContext): void {
  /** Catalogo da rede. O preco liquido e visivel a todo membro — e o dado que faz a rede existir. */
  router.get('/api/v1/veiculos', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const somenteDisponiveis = request.query.get('somenteDisponiveis') !== 'false';
    const page = await searchCatalog(context, {
      commercialStatus: somenteDisponiveis
        ? [CommercialStatus.AVAILABLE]
        : [CommercialStatus.AVAILABLE, CommercialStatus.LOCKED],
      ...(queryText(request.query, 'marca') === undefined ? {} : { brand: queryText(request.query, 'marca') as string }),
      ...(queryText(request.query, 'modelo') === undefined ? {} : { model: queryText(request.query, 'modelo') as string }),
      ...(queryInteger(request.query, 'anoModeloMinimo') === undefined
        ? {}
        : { minModelYear: queryInteger(request.query, 'anoModeloMinimo') as number }),
      ...(queryInteger(request.query, 'kmMaximo') === undefined
        ? {}
        : { maxMileageKm: queryInteger(request.query, 'kmMaximo') as number }),
      ...(queryInteger(request.query, 'liquidoMaximoCentavos') === undefined
        ? {}
        : { maxNetPriceCents: queryInteger(request.query, 'liquidoMaximoCentavos') as number }),
      limit: Math.min(queryInteger(request.query, 'limite') ?? 50, 200),
      offset: queryInteger(request.query, 'deslocamento') ?? 0,
    });

    const at = context.clock.now();
    return json(200, {
      total: page.total,
      veiculos: page.items.map((loaded) => vehicleViewDto(buildVehicleView(loaded, actor.value.store.id, at), at)),
    });
  });

  router.get('/api/v1/veiculos/meus', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const page = await searchCatalog(context, { ownerStoreId: actor.value.store.id, limit: 200 });
    const at = context.clock.now();
    return json(200, {
      total: page.total,
      veiculos: page.items.map((loaded) => vehicleViewDto(buildVehicleView(loaded, actor.value.store.id, at), at)),
    });
  });

  /** Veiculos de outras lojas parados no meu patio: o estoque avancado. */
  router.get('/api/v1/veiculos/no-meu-patio', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const page = await searchCatalog(context, {
      custodianStoreId: actor.value.store.id,
      limit: 200,
    });
    const at = context.clock.now();
    const alheios = page.items.filter((loaded) => loaded.vehicle.ownerStoreId !== actor.value.store.id);
    return json(200, {
      total: alheios.length,
      veiculos: alheios.map((loaded) => vehicleViewDto(buildVehicleView(loaded, actor.value.store.id, at), at)),
    });
  });

  router.get('/api/v1/veiculos/:id', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const loaded = await loadVehicle(context, asVehicleId(request.params['id'] as string));
    if (!loaded.ok) return errorResponse(loaded.error, request.requestId);

    const at = context.clock.now();
    return json(200, vehicleViewDto(buildVehicleView(loaded.value, actor.value.store.id, at), at));
  });

  router.post('/api/v1/veiculos', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const body = asObject(request.body);
    if (!body.ok) return errorResponse(body.error, request.requestId);

    const plate = text(body.value, 'placa');
    if (!plate.ok) return errorResponse(plate.error, request.requestId);
    const chassis = text(body.value, 'chassi');
    if (!chassis.ok) return errorResponse(chassis.error, request.requestId);

    const specs = parseVehicleSpecs(body.value['ficha'], new Date(context.clock.now()).getUTCFullYear());
    if (!specs.ok) return errorResponse(specs.error, request.requestId);

    const publicPrice = money(body.value, 'precoPublico');
    if (!publicPrice.ok) return errorResponse(publicPrice.error, request.requestId);
    const netPrice = money(body.value, 'precoLiquidoRepasse');
    if (!netPrice.ok) return errorResponse(netPrice.error, request.requestId);

    const inspection = parseInspectionBody(body.value['laudoCautelar']);

    const result = await registerVehicle(context, actor.value, {
      plate: plate.value,
      chassis: chassis.value,
      specs: specs.value,
      ...(inspection === undefined ? {} : { inspection }),
      publicPrice: publicPrice.value,
      netPrice: netPrice.value,
    });
    if (!result.ok) return errorResponse(result.error, request.requestId);

    const loaded = await loadVehicle(context, result.value.id);
    if (!loaded.ok) return errorResponse(loaded.error, request.requestId);
    const at = context.clock.now();
    return json(201, vehicleViewDto(buildVehicleView(loaded.value, actor.value.store.id, at), at));
  });

  /**
   * Alteracao de preco. Com trava ativa, o liquido novo fica represado ate ela
   * cair — a resposta mostra isso em `precos.liquidoRepresado`.
   */
  router.patch('/api/v1/veiculos/:id/precos', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const body = asObject(request.body);
    if (!body.ok) return errorResponse(body.error, request.requestId);

    const publicPrice = optionalMoney(body.value, 'precoPublico');
    if (!publicPrice.ok) return errorResponse(publicPrice.error, request.requestId);
    const netPrice = optionalMoney(body.value, 'precoLiquidoRepasse');
    if (!netPrice.ok) return errorResponse(netPrice.error, request.requestId);

    const result = await updateVehiclePricing(context, actor.value, {
      vehicleId: asVehicleId(request.params['id'] as string),
      publicPrice: publicPrice.value,
      netPrice: netPrice.value,
    });
    if (!result.ok) return errorResponse(result.error, request.requestId);

    const loaded = await loadVehicle(context, result.value.id);
    if (!loaded.ok) return errorResponse(loaded.error, request.requestId);
    const at = context.clock.now();
    return json(200, vehicleViewDto(buildVehicleView(loaded.value, actor.value.store.id, at), at));
  });

  router.post('/api/v1/veiculos/:id/laudo', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const inspection = parseInspectionBody(request.body);
    if (inspection === undefined) {
      return json(400, {
        erro: { codigo: 'INSPECTION_REQUIRED', mensagem: 'Informe a situacao do laudo cautelar.' },
        requestId: request.requestId,
      });
    }

    const result = await recordInspection(
      context,
      actor.value,
      asVehicleId(request.params['id'] as string),
      inspection,
    );
    if (!result.ok) return errorResponse(result.error, request.requestId);

    const loaded = await loadVehicle(context, result.value.id);
    if (!loaded.ok) return errorResponse(loaded.error, request.requestId);
    const at = context.clock.now();
    return json(200, vehicleViewDto(buildVehicleView(loaded.value, actor.value.store.id, at), at));
  });

  router.delete('/api/v1/veiculos/:id', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const body = typeof request.body === 'object' && request.body !== null ? (request.body as Record<string, unknown>) : {};
    const result = await withdrawFromNetwork(
      context,
      actor.value,
      asVehicleId(request.params['id'] as string),
      optionalText(body, 'motivo') ?? 'Retirado pela loja proprietaria',
    );
    if (!result.ok) return errorResponse(result.error, request.requestId);
    return json(200, { veiculoId: result.value.id, situacao: result.value.commercialStatus });
  });

  router.post('/api/v1/veiculos/:id/reativar', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const result = await relistInNetwork(context, actor.value, asVehicleId(request.params['id'] as string));
    if (!result.ok) return errorResponse(result.error, request.requestId);
    return json(200, { veiculoId: result.value.id, situacao: result.value.commercialStatus });
  });

  // -------------------------------------------------------------------------
  // Trava comercial
  // -------------------------------------------------------------------------

  /** Abre a trava de 4h. O veiculo fica congelado para toda a rede. */
  router.post('/api/v1/veiculos/:id/trava', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const body = typeof request.body === 'object' && request.body !== null ? (request.body as Record<string, unknown>) : {};
    const result = await openCommercialLock(context, actor.value, {
      vehicleId: asVehicleId(request.params['id'] as string),
      customerReference: optionalText(body, 'referenciaAtendimento'),
    });
    if (!result.ok) return errorResponse(result.error, request.requestId);

    const at = context.clock.now();
    return json(201, {
      trava: result.value.lock === null ? null : lockDto(result.value.lock, at),
      veiculo: vehicleViewDto(buildVehicleView(result.value, actor.value.store.id, at), at),
    });
  });

  /** Estende a trava mediante evidencia de avanco no funil. */
  router.post('/api/v1/travas/:id/extensoes', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const body = asObject(request.body);
    if (!body.ok) return errorResponse(body.error, request.requestId);

    const type = oneOf(body.value, 'evidencia', Object.values(EvidenceType));
    if (!type.ok) return errorResponse(type.error, request.requestId);

    const evidence: Evidence = {
      type: type.value,
      reference: optionalText(body.value, 'referencia') ?? null,
      attachmentUrl: optionalText(body.value, 'anexoUrl') ?? null,
      note: optionalText(body.value, 'observacao') ?? null,
    };

    const result = await extendCommercialLock(
      context,
      actor.value,
      asLockId(request.params['id'] as string),
      evidence,
    );
    if (!result.ok) return errorResponse(result.error, request.requestId);

    const at = context.clock.now();
    return json(200, { trava: result.value.lock === null ? null : lockDto(result.value.lock, at) });
  });

  /** Libera a trava antes do prazo. O carro volta a rede sem sair do lugar. */
  router.delete('/api/v1/travas/:id', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const body = typeof request.body === 'object' && request.body !== null ? (request.body as Record<string, unknown>) : {};
    const result = await releaseCommercialLock(
      context,
      actor.value,
      asLockId(request.params['id'] as string),
      optionalText(body, 'motivo'),
    );
    if (!result.ok) return errorResponse(result.error, request.requestId);

    const at = context.clock.now();
    return json(200, {
      veiculo: vehicleViewDto(buildVehicleView(result.value, actor.value.store.id, at), at),
    });
  });

  router.get('/api/v1/veiculos/:id/travas', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const history = await context.repos.locks.historyByVehicle(asVehicleId(request.params['id'] as string));
    const at = context.clock.now();
    return json(200, { total: history.length, travas: history.map((lock) => lockDto(lock, at)) });
  });
}

function parseInspectionBody(input: unknown) {
  if (typeof input !== 'object' || input === null) return undefined;
  const raw = input as Record<string, unknown>;
  const status = raw['situacao'];
  if (typeof status !== 'string' || !(status in InspectionStatus)) return undefined;

  const toInstantOrNull = (value: unknown): number | null => {
    if (typeof value !== 'string' || value.trim().length === 0) return null;
    try {
      return toInstant(value);
    } catch {
      return null;
    }
  };

  return {
    status: status as InspectionStatus,
    reportNumber: typeof raw['numero'] === 'string' ? raw['numero'] : null,
    provider: typeof raw['empresa'] === 'string' ? raw['empresa'] : null,
    issuedAt: toInstantOrNull(raw['emitidoEm']),
    expiresAt: toInstantOrNull(raw['validoAte']),
  };
}
