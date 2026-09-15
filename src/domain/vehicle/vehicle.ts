/**
 * Veiculo — o agregado central da rede.
 *
 * A nuance que define este produto: **localizacao fisica e status comercial sao
 * eixos independentes**. Um carro pode estar no showroom da Loja B (custodia
 * fisica) e, ao mesmo tempo, estar comercialmente DISPONIVEL para toda a rede,
 * inclusive para a Loja A que e a dona. Amarrar os dois eixos — como faz um ERP
 * de estoque tradicional — obrigaria a pagar frete de devolucao toda vez que um
 * cliente desistisse, que e exatamente o atrito que a plataforma remove.
 *
 * Por isso o agregado tem dois blocos separados e sem acoplamento:
 *
 *   commercial: quem pode vender, e ate quando          (muda em minutos)
 *   physical:   quem esta com o carro, e desde quando   (muda em dias)
 *
 * Nenhuma transicao de um eixo altera o outro. A unica excecao e a entrega ao
 * consumidor final, que encerra os dois ao mesmo tempo.
 */

import { type Result, err, ok, combine } from '../shared/result.ts';
import {
  type DomainError,
  conflictError,
  forbiddenError,
  ruleViolation,
  validationError,
} from '../shared/errors.ts';
import { type DomainEvent, domainEvent } from '../shared/events.ts';
import { type Transition, transitioned, unchanged } from '../shared/transition.ts';
import type { Instant } from '../shared/clock.ts';
import type { ClusterId, CustodyTransferId, LockId, StoreId, VehicleId } from '../shared/ids.ts';
import { type Money, equals as moneyEquals, format as formatMoney, gt, isPositive } from '../shared/money.ts';
import {
  parseChassis,
  parseHttpUrl,
  parseModelYear,
  parseOdometer,
  parsePlate,
  requireOneOf,
  requireText,
} from '../shared/validation.ts';

// ---------------------------------------------------------------------------
// Eixo comercial
// ---------------------------------------------------------------------------

export const CommercialStatus = {
  /** Ingerido, mas sem laudo cautelar aprovado: nao circula na rede. */
  DRAFT: 'DRAFT',
  /** Disponivel para qualquer membro da rede travar e vender. */
  AVAILABLE: 'AVAILABLE',
  /** Trava comercial ativa: congelado para todos, menos para quem travou. */
  LOCKED: 'LOCKED',
  /** Vendido ao consumidor final. Sai do estoque da rede. */
  SOLD: 'SOLD',
  /** Retirado da rede pelo proprio dono (venda no balcao, uso interno, etc). */
  WITHDRAWN: 'WITHDRAWN',
} as const;
export type CommercialStatus = (typeof CommercialStatus)[keyof typeof CommercialStatus];

/** Status em que o veiculo aparece no catalogo da rede. */
export function isListedInNetwork(status: CommercialStatus): boolean {
  return status === CommercialStatus.AVAILABLE || status === CommercialStatus.LOCKED;
}

// ---------------------------------------------------------------------------
// Eixo fisico
// ---------------------------------------------------------------------------

export const PhysicalState = {
  /** No patio de alguma loja da rede — nao necessariamente a dona. */
  AT_YARD: 'AT_YARD',
  /** Termo de custodia aberto: saiu da origem, ainda nao deu entrada no destino. */
  IN_TRANSIT: 'IN_TRANSIT',
  /** Entregue ao comprador final. Estado terminal. */
  DELIVERED_TO_CONSUMER: 'DELIVERED_TO_CONSUMER',
} as const;
export type PhysicalState = (typeof PhysicalState)[keyof typeof PhysicalState];

export type PhysicalCustody = {
  readonly state: PhysicalState;
  /**
   * Loja que responde civilmente pelo veiculo agora (multas, avarias, sinistro).
   * Em transito, continua sendo a loja de ORIGEM ate a assinatura da entrada:
   * quem ainda nao conferiu o carro nao pode herdar o risco dele.
   */
  readonly custodianStoreId: StoreId;
  /** Destino do termo aberto, enquanto em transito. */
  readonly inboundStoreId: StoreId | null;
  readonly since: Instant;
  readonly openTransferId: CustodyTransferId | null;
};

// ---------------------------------------------------------------------------
// Ficha tecnica e laudo
// ---------------------------------------------------------------------------

export const FuelType = {
  FLEX: 'FLEX',
  GASOLINE: 'GASOLINE',
  ETHANOL: 'ETHANOL',
  DIESEL: 'DIESEL',
  ELECTRIC: 'ELECTRIC',
  HYBRID: 'HYBRID',
  CNG: 'CNG',
} as const;
export type FuelType = (typeof FuelType)[keyof typeof FuelType];

export const TransmissionType = {
  MANUAL: 'MANUAL',
  AUTOMATIC: 'AUTOMATIC',
  AUTOMATED: 'AUTOMATED',
  CVT: 'CVT',
} as const;
export type TransmissionType = (typeof TransmissionType)[keyof typeof TransmissionType];

export type VehicleSpecs = {
  readonly brand: string;
  readonly model: string;
  readonly version: string;
  readonly manufactureYear: number;
  readonly modelYear: number;
  readonly mileageKm: number;
  readonly color: string;
  readonly fuel: FuelType;
  readonly transmission: TransmissionType;
  readonly doors: number | null;
  readonly optionals: readonly string[];
  readonly photos: readonly string[];
};

export const InspectionStatus = {
  APPROVED: 'APPROVED',
  /** Aprovado com apontamento (ex.: reparo estrutural leve declarado). */
  APPROVED_WITH_NOTES: 'APPROVED_WITH_NOTES',
  REJECTED: 'REJECTED',
  /** Sem laudo informado no feed. */
  MISSING: 'MISSING',
} as const;
export type InspectionStatus = (typeof InspectionStatus)[keyof typeof InspectionStatus];

/**
 * Laudo cautelar. E o filtro de qualificacao da rede: sem laudo aprovado e
 * valido, o veiculo nao e ofertado aos demais membros. A rede vende confianca
 * entre lojistas que nao veem o carro antes de assumir o cliente.
 */
export type InspectionReport = {
  readonly status: InspectionStatus;
  readonly reportNumber: string | null;
  readonly provider: string | null;
  readonly issuedAt: Instant | null;
  /** Laudo vence: um cautelar de 8 meses atras nao diz nada sobre hoje. */
  readonly expiresAt: Instant | null;
  /**
   * O laudo em si, em PDF. E o unico documento do carro que circula na rede:
   * o CRLV fica de fora de proposito, porque ele esta no nome da loja dona e
   * entregaria a origem justamente no material que a parceira redistribui.
   */
  readonly fileUrl: string | null;
};

export const MISSING_INSPECTION: InspectionReport = {
  status: InspectionStatus.MISSING,
  reportNumber: null,
  provider: null,
  issuedAt: null,
  expiresAt: null,
  fileUrl: null,
};

export function isInspectionValid(report: InspectionReport, now: Instant): boolean {
  const approved =
    report.status === InspectionStatus.APPROVED ||
    report.status === InspectionStatus.APPROVED_WITH_NOTES;
  if (!approved) return false;
  return report.expiresAt === null || report.expiresAt > now;
}

// ---------------------------------------------------------------------------
// Precificacao
// ---------------------------------------------------------------------------

export type Pricing = {
  /** Preco de vitrine do dono. Referencia publica, nao vincula a Loja B. */
  readonly publicPrice: Money;
  /**
   * Preco LIQUIDO de repasse: o que a loja dona exige receber.
   * Dado estritamente B2B — nunca sai no material que a parceira republica.
   */
  readonly netPrice: Money;
  readonly updatedAt: Instant;
};

// ---------------------------------------------------------------------------
// Troca na operacao: o que a dona aceita receber em vez de dinheiro
// ---------------------------------------------------------------------------

export const TradeInStance = {
  /**
   * A dona avalia um carro na troca. NAO e promessa de aceite — o transbordo
   * segue passando pelo julgamento dela, carro a carro.
   */
  CONSIDERS: 'CONSIDERS',
  /** So dinheiro. A parceira nem monta a proposta com troca. */
  CASH_ONLY: 'CASH_ONLY',
} as const;
export type TradeInStance = (typeof TradeInStance)[keyof typeof TradeInStance];

/**
 * Postura da loja dona quanto a receber um carro na troca (transbordo).
 *
 * Existe porque o custo de descobrir tarde e alto e assimetrico: hoje a
 * parceira monta a negociacao inteira, propoe o transbordo e so entao descobre
 * que a dona so trabalha com dinheiro — e descobre no pior instante possivel,
 * com o cliente na mesa. A postura declarada move essa informacao para antes
 * do trabalho, que e a razao de a plataforma existir.
 *
 * O padrao e `CONSIDERS` porque e o comportamento que ja existia: propor e
 * esperar avaliacao. O sinal que economiza tempo e o `CASH_ONLY`.
 */
export type TradeInPolicy = {
  readonly stance: TradeInStance;
  /**
   * Restricao que o enum nao captura: "nada acima de 100 mil km", "so hatch".
   * Curta e consultiva — nao e validada e nao bloqueia nada. Existe para a
   * conversa nao voltar para o WhatsApp por causa de um detalhe.
   */
  readonly note: string | null;
  readonly updatedAt: Instant;
};

export function acceptsTradeIn(vehicle: Vehicle): boolean {
  return vehicle.tradeInPolicy.stance === TradeInStance.CONSIDERS;
}

// ---------------------------------------------------------------------------
// Material de divulgacao
// ---------------------------------------------------------------------------

export const VehicleAngle = {
  FRONT: 'FRONT',
  REAR: 'REAR',
  LEFT: 'LEFT',
  RIGHT: 'RIGHT',
  INTERIOR: 'INTERIOR',
  DASHBOARD: 'DASHBOARD',
  ENGINE: 'ENGINE',
  TRUNK: 'TRUNK',
  OTHER: 'OTHER',
} as const;
export type VehicleAngle = (typeof VehicleAngle)[keyof typeof VehicleAngle];

/**
 * Foto curada para circular na rede: sem placa legivel, sem adesivo, sem
 * fachada nem banner que identifique a loja.
 *
 * E uma colecao separada das fotos do feed de proposito. As do feed foram
 * tiradas para o anuncio da propria loja e quase sempre carregam alguma marca
 * dela; usa-las como material da rede entregaria a origem no primeiro anuncio
 * que a parceira publicasse.
 */
export type NeutralPhoto = {
  readonly url: string;
  readonly angle: VehicleAngle;
  readonly publishedAt: Instant;
};

/**
 * Angulos sem os quais o material nao serve para anunciar. Nao e a mesma lista
 * da vistoria de patio: la o objetivo e provar avaria, aqui e vender o carro.
 */
export const MATERIAL_REQUIRED_ANGLES: readonly VehicleAngle[] = [
  VehicleAngle.FRONT,
  VehicleAngle.REAR,
  VehicleAngle.INTERIOR,
];

export type FeedSource = {
  readonly provider: string | null;
  readonly externalId: string | null;
  /** Hash do conteudo do ultimo feed, para tornar a sincronizacao idempotente. */
  readonly contentHash: string | null;
  readonly lastSyncedAt: Instant | null;
};

export const NO_FEED_SOURCE: FeedSource = {
  provider: null,
  externalId: null,
  contentHash: null,
  lastSyncedAt: null,
};

export type Vehicle = {
  readonly id: VehicleId;
  /**
   * A praca em que este carro circula — sempre a da loja dona. Denormalizado de
   * proposito: e o que permite a busca filtrar sem juncao, e o que um indice em
   * `(cluster_id, commercial_status)` vai cobrir quando isso sair da memoria.
   * Imutavel, como `ownerStoreId`.
   */
  readonly clusterId: ClusterId;
  /** Dona do veiculo. Nao muda: a rede compartilha estoque, nao transfere titularidade. */
  readonly ownerStoreId: StoreId;
  readonly plate: string;
  readonly chassis: string;
  readonly specs: VehicleSpecs;
  readonly inspection: InspectionReport;
  /**
   * Conjunto neutro, publicado pela loja dona, que qualquer parceira pode usar
   * como se fosse material proprio. Vazio ate a dona curar as fotos.
   */
  readonly neutralPhotos: readonly NeutralPhoto[];
  readonly pricing: Pricing;
  /** Declarada pela dona: ela avalia carro na troca neste veiculo, ou so dinheiro. */
  readonly tradeInPolicy: TradeInPolicy;
  readonly commercialStatus: CommercialStatus;
  readonly activeLockId: LockId | null;
  readonly physical: PhysicalCustody;
  readonly source: FeedSource;
  /**
   * Alteracao de preco liquido represada porque havia trava ativa.
   * A Loja B negocia sobre o preco que travou; mover a trave no meio da
   * negociacao quebraria a confianca que sustenta a rede.
   */
  readonly pendingNetPrice: Money | null;
  /** Sumiu do feed do dono mas esta no patio de outra loja: exige decisao humana. */
  readonly missingFromFeed: boolean;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
};

// ---------------------------------------------------------------------------
// Criacao
// ---------------------------------------------------------------------------

export type CreateVehicleInput = {
  readonly id: VehicleId;
  readonly clusterId: ClusterId;
  readonly ownerStoreId: StoreId;
  readonly plate: string;
  readonly chassis: string;
  readonly specs: VehicleSpecs;
  readonly inspection?: InspectionReport;
  readonly publicPrice: Money;
  readonly netPrice: Money;
  /**
   * Obrigatoria: quem cadastra decide na hora. Deixar implicito devolveria o
   * problema que este campo existe para resolver.
   */
  readonly tradeInStance: TradeInStance;
  readonly tradeInNote?: string | null;
  readonly source?: FeedSource;
  readonly now: Instant;
};

export function createVehicle(input: CreateVehicleInput): Result<Vehicle, DomainError> {
  const identity = combine({
    plate: parsePlate(input.plate),
    chassis: parseChassis(input.chassis),
  });
  if (!identity.ok) return identity;

  const priceCheck = validatePrices(input.publicPrice, input.netPrice);
  if (!priceCheck.ok) return priceCheck;

  const inspection = input.inspection ?? MISSING_INSPECTION;
  const vehicle: Vehicle = {
    id: input.id,
    clusterId: input.clusterId,
    ownerStoreId: input.ownerStoreId,
    plate: identity.value.plate.plate,
    chassis: identity.value.chassis,
    specs: input.specs,
    inspection,
    tradeInPolicy: {
      stance: input.tradeInStance,
      note: input.tradeInNote ?? null,
      updatedAt: input.now,
    },
    neutralPhotos: [],
    pricing: { publicPrice: input.publicPrice, netPrice: input.netPrice, updatedAt: input.now },
    // Nasce em DRAFT; so vai a rede quando o laudo aprovado for confirmado.
    commercialStatus: isInspectionValid(inspection, input.now)
      ? CommercialStatus.AVAILABLE
      : CommercialStatus.DRAFT,
    activeLockId: null,
    physical: {
      state: PhysicalState.AT_YARD,
      custodianStoreId: input.ownerStoreId,
      inboundStoreId: null,
      since: input.now,
      openTransferId: null,
    },
    source: input.source ?? NO_FEED_SOURCE,
    pendingNetPrice: null,
    missingFromFeed: false,
    createdAt: input.now,
    updatedAt: input.now,
  };

  return ok(vehicle);
}

function validatePrices(publicPrice: Money, netPrice: Money): Result<true, DomainError> {
  if (!isPositive(netPrice)) {
    return err(
      validationError('NET_PRICE_REQUIRED', 'O preco liquido de repasse deve ser maior que zero.'),
    );
  }
  if (!isPositive(publicPrice)) {
    return err(validationError('PUBLIC_PRICE_REQUIRED', 'O preco publico deve ser maior que zero.'));
  }
  if (gt(netPrice, publicPrice)) {
    // Nao e erro de digitacao necessariamente, mas indica feed invertido: o
    // liquido de repasse acima da vitrine deixaria a Loja B sem margem alguma.
    return err(
      ruleViolation(
        'NET_PRICE_ABOVE_PUBLIC_PRICE',
        `O preco liquido (${formatMoney(netPrice)}) nao pode superar o preco publico (${formatMoney(publicPrice)}).`,
        { netPriceCents: netPrice.cents, publicPriceCents: publicPrice.cents },
      ),
    );
  }
  return ok(true);
}

export function parseVehicleSpecs(input: unknown, currentYear: number): Result<VehicleSpecs, DomainError> {
  if (typeof input !== 'object' || input === null) {
    return err(validationError('SPECS_REQUIRED', 'Ficha tecnica do veiculo e obrigatoria.'));
  }
  const raw = input as Record<string, unknown>;

  const base = combine({
    brand: requireText(raw['brand'], 'marca', { min: 2, max: 60 }),
    model: requireText(raw['model'], 'modelo', { min: 1, max: 80 }),
    version: requireText(raw['version'], 'versao', { min: 1, max: 120 }),
    manufactureYear: parseModelYear(raw['manufactureYear'], 'ano de fabricacao', currentYear),
    modelYear: parseModelYear(raw['modelYear'], 'ano do modelo', currentYear),
    mileageKm: parseOdometer(raw['mileageKm'], 'quilometragem'),
    color: requireText(raw['color'], 'cor', { min: 2, max: 40 }),
    fuel: requireOneOf(raw['fuel'], 'combustivel', Object.values(FuelType)),
    transmission: requireOneOf(raw['transmission'], 'cambio', Object.values(TransmissionType)),
  });
  if (!base.ok) return base;

  if (base.value.modelYear < base.value.manufactureYear) {
    return err(
      validationError(
        'MODEL_YEAR_BEFORE_MANUFACTURE',
        'O ano do modelo nao pode ser anterior ao ano de fabricacao.',
        { manufactureYear: base.value.manufactureYear, modelYear: base.value.modelYear },
      ),
    );
  }

  const photos: string[] = [];
  for (const candidate of toArray(raw['photos'])) {
    const url = parseHttpUrl(candidate, 'foto');
    if (url.ok) photos.push(url.value);
  }

  const optionals = toArray(raw['optionals'])
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= 80)
    .slice(0, 60);

  const doors = typeof raw['doors'] === 'number' && raw['doors'] >= 2 && raw['doors'] <= 6
    ? Math.round(raw['doors'])
    : null;

  return ok({ ...base.value, doors, optionals, photos });
}

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

// ---------------------------------------------------------------------------
// Comandos do eixo comercial
// ---------------------------------------------------------------------------

export type UpdatePricingCommand = {
  readonly vehicle: Vehicle;
  readonly actorStoreId: StoreId;
  readonly publicPrice?: Money | undefined;
  readonly netPrice?: Money | undefined;
  readonly now: Instant;
};

/**
 * So a loja dona precifica. Se houver trava ativa, a mudanca do preco LIQUIDO
 * fica represada em `pendingNetPrice` e so vale quando a trava terminar:
 * a Loja B negocia sobre o numero que travou.
 */
export function updatePricing(command: UpdatePricingCommand): Transition<Vehicle> {
  const { vehicle, actorStoreId, now } = command;

  if (actorStoreId !== vehicle.ownerStoreId) {
    return err(
      forbiddenError(
        'NOT_VEHICLE_OWNER',
        'Somente a loja proprietaria define o preco liquido de repasse.',
        { vehicleId: vehicle.id, ownerStoreId: vehicle.ownerStoreId },
      ),
    );
  }
  if (vehicle.commercialStatus === CommercialStatus.SOLD) {
    return err(
      conflictError('VEHICLE_SOLD', 'Veiculo ja vendido: o preco nao pode mais ser alterado.', {
        vehicleId: vehicle.id,
      }),
    );
  }

  const publicPrice = command.publicPrice ?? vehicle.pricing.publicPrice;
  const netPrice = command.netPrice ?? vehicle.pricing.netPrice;
  const priceCheck = validatePrices(publicPrice, netPrice);
  if (!priceCheck.ok) return priceCheck;

  const locked = vehicle.commercialStatus === CommercialStatus.LOCKED;
  const netPriceChanged = !moneyEquals(netPrice, vehicle.pricing.netPrice);

  if (locked && netPriceChanged) {
    const updated: Vehicle = {
      ...vehicle,
      pricing: { ...vehicle.pricing, publicPrice, updatedAt: now },
      pendingNetPrice: netPrice,
      updatedAt: now,
    };
    return transitioned(updated, [
      domainEvent('vehicle.net_price_deferred', vehicle.id, now, {
        reason: 'ACTIVE_COMMERCIAL_LOCK',
        currentNetPriceCents: vehicle.pricing.netPrice.cents,
        pendingNetPriceCents: netPrice.cents,
        lockId: vehicle.activeLockId,
      }),
    ]);
  }

  const updated: Vehicle = {
    ...vehicle,
    pricing: { publicPrice, netPrice, updatedAt: now },
    pendingNetPrice: null,
    updatedAt: now,
  };

  const events: DomainEvent[] = [];
  if (netPriceChanged) {
    events.push(
      domainEvent('vehicle.net_price_changed', vehicle.id, now, {
        fromCents: vehicle.pricing.netPrice.cents,
        toCents: netPrice.cents,
      }),
    );
  }
  return transitioned(updated, events);
}

/** Aplica o preco represado quando a trava termina. Idempotente. */
export type UpdateTradeInPolicyCommand = {
  readonly vehicle: Vehicle;
  readonly actorStoreId: StoreId;
  readonly stance: TradeInStance;
  readonly note?: string | null;
  readonly now: Instant;
};

/**
 * Muda a postura de troca. Vale **na hora**, mesmo com trava ativa — e o
 * oposto do preco liquido, que fica represado.
 *
 * A diferenca nao e arbitraria. O preco represa porque a Loja B fechou um
 * numero com o cliente e mover a trave quebraria a negociacao em curso. A
 * postura de troca nao move numero nenhum: ela so diz se vale a pena montar
 * uma proposta com carro na troca. Segurar essa informacao ate a trava cair
 * produziria exatamente o trabalho perdido que o campo existe para evitar.
 *
 * Uma negociacao ja aberta com transbordo nao e afetada: quem ja propos segue
 * esperando o aceite, porque a proposta foi feita sob a regra anterior.
 */
export function updateTradeInPolicy(command: UpdateTradeInPolicyCommand): Transition<Vehicle> {
  const { vehicle, actorStoreId, stance, now } = command;

  if (actorStoreId !== vehicle.ownerStoreId) {
    return err(
      forbiddenError(
        'NOT_VEHICLE_OWNER',
        'Somente a loja proprietaria decide se aceita carro na troca.',
        { vehicleId: vehicle.id, ownerStoreId: vehicle.ownerStoreId },
      ),
    );
  }
  if (vehicle.commercialStatus === CommercialStatus.SOLD) {
    return err(
      conflictError('VEHICLE_SOLD', 'Veiculo ja vendido: a postura de troca nao muda mais.', {
        vehicleId: vehicle.id,
      }),
    );
  }

  const note = command.note === undefined ? vehicle.tradeInPolicy.note : command.note;
  const unchanged =
    stance === vehicle.tradeInPolicy.stance && note === vehicle.tradeInPolicy.note;
  if (unchanged) return transitioned(vehicle, []);

  const updated: Vehicle = {
    ...vehicle,
    tradeInPolicy: { stance, note, updatedAt: now },
    updatedAt: now,
  };

  return transitioned(updated, [
    domainEvent('vehicle.trade_in_policy_changed', vehicle.id, now, {
      clusterId: vehicle.clusterId,
      ownerStoreId: vehicle.ownerStoreId,
      from: vehicle.tradeInPolicy.stance,
      to: stance,
    }),
  ]);
}

export function applyPendingNetPrice(vehicle: Vehicle, now: Instant): Transition<Vehicle> {
  if (vehicle.pendingNetPrice === null) return unchanged(vehicle);

  const netPrice = vehicle.pendingNetPrice;
  const priceCheck = validatePrices(vehicle.pricing.publicPrice, netPrice);
  if (!priceCheck.ok) {
    // O preco publico pode ter mudado no intervalo, invalidando o represado.
    return transitioned({ ...vehicle, pendingNetPrice: null, updatedAt: now }, [
      domainEvent('vehicle.pending_net_price_discarded', vehicle.id, now, {
        pendingNetPriceCents: netPrice.cents,
        reason: priceCheck.error.code,
      }),
    ]);
  }

  return transitioned(
    {
      ...vehicle,
      pricing: { ...vehicle.pricing, netPrice, updatedAt: now },
      pendingNetPrice: null,
      updatedAt: now,
    },
    [
      domainEvent('vehicle.net_price_changed', vehicle.id, now, {
        fromCents: vehicle.pricing.netPrice.cents,
        toCents: netPrice.cents,
        deferred: true,
      }),
    ],
  );
}

export type RegisterInspectionCommand = {
  readonly vehicle: Vehicle;
  readonly actorStoreId: StoreId;
  readonly report: InspectionReport;
  readonly now: Instant;
};

/**
 * Registra ou renova o laudo cautelar. E o que promove um veiculo de DRAFT para
 * a vitrine da rede — e o que o retira dela se o laudo for reprovado.
 */
export function registerInspection(command: RegisterInspectionCommand): Transition<Vehicle> {
  const { vehicle, report, now } = command;

  if (command.actorStoreId !== vehicle.ownerStoreId) {
    return err(
      forbiddenError('NOT_VEHICLE_OWNER', 'Somente a loja proprietaria registra o laudo cautelar.', {
        vehicleId: vehicle.id,
      }),
    );
  }
  if (vehicle.commercialStatus === CommercialStatus.SOLD) {
    return err(conflictError('VEHICLE_SOLD', 'Veiculo ja vendido.', { vehicleId: vehicle.id }));
  }

  const valid = isInspectionValid(report, now);
  const events: DomainEvent[] = [
    domainEvent('vehicle.inspection_registered', vehicle.id, now, {
      status: report.status,
      reportNumber: report.reportNumber,
      valid,
    }),
  ];

  let commercialStatus = vehicle.commercialStatus;

  if (valid && vehicle.commercialStatus === CommercialStatus.DRAFT) {
    commercialStatus = CommercialStatus.AVAILABLE;
    events.push(domainEvent('vehicle.listed', vehicle.id, now, { reason: 'INSPECTION_APPROVED' }));
  } else if (!valid && vehicle.commercialStatus === CommercialStatus.AVAILABLE) {
    commercialStatus = CommercialStatus.DRAFT;
    events.push(
      domainEvent('vehicle.unlisted', vehicle.id, now, { reason: 'INSPECTION_NOT_VALID' }),
    );
  } else if (!valid && vehicle.commercialStatus === CommercialStatus.LOCKED) {
    // Nao derruba uma negociacao em andamento por laudo vencido; sinaliza para
    // que a rede resolva ao fim da trava.
    events.push(
      domainEvent('vehicle.inspection_invalid_during_lock', vehicle.id, now, {
        lockId: vehicle.activeLockId,
      }),
    );
  }

  return transitioned({ ...vehicle, inspection: report, commercialStatus, updatedAt: now }, events);
}

export type PublishNeutralPhotosCommand = {
  readonly vehicle: Vehicle;
  readonly actorStoreId: StoreId;
  readonly photos: readonly { readonly url: string; readonly angle: VehicleAngle }[];
  readonly now: Instant;
};

/**
 * Publica o conjunto neutro de fotos — o material que qualquer loja parceira
 * pode usar como se fosse dela.
 *
 * So a loja dona publica, porque so ela tem o carro para fotografar. E a
 * curadoria e humana de proposito: decidir se um adesivo no vidro ou a fachada
 * refletida no para-brisa entregam a origem e julgamento, nao regra que
 * software aplique sozinho. O que o sistema garante e que o conjunto exista e
 * cubra os angulos sem os quais nao da para anunciar.
 */
export function publishNeutralPhotos(
  command: PublishNeutralPhotosCommand,
): Transition<Vehicle> {
  const { vehicle, now } = command;

  if (command.actorStoreId !== vehicle.ownerStoreId) {
    return err(
      forbiddenError(
        'NOT_VEHICLE_OWNER',
        'Somente a loja proprietaria publica o material neutro — e ela quem tem o carro.',
        { vehicleId: vehicle.id },
      ),
    );
  }
  if (vehicle.commercialStatus === CommercialStatus.SOLD) {
    return err(conflictError('VEHICLE_SOLD', 'Veiculo ja vendido.', { vehicleId: vehicle.id }));
  }

  const photos: NeutralPhoto[] = [];
  for (const candidate of command.photos.slice(0, 40)) {
    const url = parseHttpUrl(candidate.url, 'foto neutra');
    if (!url.ok) return url;
    const angle = requireOneOf(candidate.angle, 'angulo da foto', Object.values(VehicleAngle));
    if (!angle.ok) return angle;
    photos.push({ url: url.value, angle: angle.value, publishedAt: now });
  }

  const present = new Set(photos.map((photo) => photo.angle));
  const missing = MATERIAL_REQUIRED_ANGLES.filter((angle) => !present.has(angle));
  if (missing.length > 0) {
    return err(
      ruleViolation(
        'MATERIAL_ANGLES_MISSING',
        `O material precisa de pelo menos estes angulos: ${missing.join(', ')}.`,
        { missing, required: MATERIAL_REQUIRED_ANGLES },
      ),
    );
  }

  return transitioned({ ...vehicle, neutralPhotos: photos, updatedAt: now }, [
    domainEvent('vehicle.neutral_photos_published', vehicle.id, now, {
      ownerStoreId: vehicle.ownerStoreId,
      photoCount: photos.length,
      angles: [...present],
    }),
  ]);
}

/** O material esta completo o bastante para a parceira anunciar? */
export function hasUsableMaterial(vehicle: Vehicle): boolean {
  const present = new Set(vehicle.neutralPhotos.map((photo) => photo.angle));
  return MATERIAL_REQUIRED_ANGLES.every((angle) => present.has(angle));
}

export type WithdrawVehicleCommand = {
  readonly vehicle: Vehicle;
  readonly actorStoreId: StoreId;
  readonly reason: string;
  readonly now: Instant;
};

/** Retira o veiculo da rede (venda no balcao, uso interno, envio a leilao). */
export function withdrawVehicle(command: WithdrawVehicleCommand): Transition<Vehicle> {
  const { vehicle, now } = command;

  if (command.actorStoreId !== vehicle.ownerStoreId) {
    return err(
      forbiddenError('NOT_VEHICLE_OWNER', 'Somente a loja proprietaria retira o veiculo da rede.', {
        vehicleId: vehicle.id,
      }),
    );
  }
  if (vehicle.commercialStatus === CommercialStatus.LOCKED) {
    // A exclusividade da trava vale ate contra o dono: e o que faz a Loja B
    // conseguir prometer o carro ao cliente dela sem medo.
    return err(
      conflictError(
        'VEHICLE_UNDER_ACTIVE_LOCK',
        'Ha uma trava comercial ativa. Aguarde o fim do prazo para retirar o veiculo da rede.',
        { vehicleId: vehicle.id, lockId: vehicle.activeLockId },
      ),
    );
  }
  if (vehicle.commercialStatus === CommercialStatus.SOLD) {
    return err(conflictError('VEHICLE_SOLD', 'Veiculo ja vendido.', { vehicleId: vehicle.id }));
  }
  if (vehicle.commercialStatus === CommercialStatus.WITHDRAWN) {
    return unchanged(vehicle);
  }

  return transitioned(
    { ...vehicle, commercialStatus: CommercialStatus.WITHDRAWN, updatedAt: now },
    [domainEvent('vehicle.withdrawn', vehicle.id, now, { reason: command.reason })],
  );
}

export type RelistVehicleCommand = {
  readonly vehicle: Vehicle;
  readonly actorStoreId: StoreId;
  readonly now: Instant;
};

export function relistVehicle(command: RelistVehicleCommand): Transition<Vehicle> {
  const { vehicle, now } = command;

  if (command.actorStoreId !== vehicle.ownerStoreId) {
    return err(
      forbiddenError('NOT_VEHICLE_OWNER', 'Somente a loja proprietaria reativa o anuncio.', {
        vehicleId: vehicle.id,
      }),
    );
  }
  if (vehicle.commercialStatus !== CommercialStatus.WITHDRAWN) {
    return err(
      conflictError('VEHICLE_NOT_WITHDRAWN', 'O veiculo nao esta retirado da rede.', {
        vehicleId: vehicle.id,
        status: vehicle.commercialStatus,
      }),
    );
  }
  if (!isInspectionValid(vehicle.inspection, now)) {
    return err(
      ruleViolation(
        'INSPECTION_NOT_VALID',
        'Sem laudo cautelar aprovado e vigente o veiculo nao volta ao catalogo da rede.',
        { vehicleId: vehicle.id, inspectionStatus: vehicle.inspection.status },
      ),
    );
  }

  return transitioned(
    { ...vehicle, commercialStatus: CommercialStatus.AVAILABLE, updatedAt: now },
    [domainEvent('vehicle.listed', vehicle.id, now, { reason: 'RELISTED_BY_OWNER' })],
  );
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

/** O carro esta no patio de uma loja diferente da dona? (estoque avancado) */
export function isOnExtendedCustody(vehicle: Vehicle): boolean {
  return vehicle.physical.custodianStoreId !== vehicle.ownerStoreId;
}

export function describeVehicle(vehicle: Vehicle): string {
  const { brand, model, version, modelYear } = vehicle.specs;
  return `${brand} ${model} ${version} ${modelYear}`.replace(/\s+/g, ' ').trim();
}
