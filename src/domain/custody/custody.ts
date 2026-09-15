/**
 * Protocolo de custodia fisica: termo digital de vistoria a cada movimentacao.
 *
 * O que esta em jogo aqui nao e logistica, e responsabilidade civil. Enquanto o
 * carro esta no patio da Loja B, e a Loja B que responde por multa, avaria e
 * sinistro — mas so a partir do instante em que ela CONFERIU e ASSINOU a
 * entrada. Por isso o termo tem dois lados, e nao um:
 *
 *   SAIDA (checkout)  a loja que esta com o carro registra em que estado ele
 *                     saiu: odometro, combustivel, fotos dos quatro angulos,
 *                     avarias ja existentes. Assina.
 *
 *   ENTRADA (checkin) a loja de destino confere e registra o que recebeu.
 *                     Assina. Neste instante — e nao antes — a responsabilidade
 *                     muda de mao.
 *
 * Entre um e outro o veiculo esta EM TRANSITO e a responsabilidade continua com
 * a ORIGEM. Quem ainda nao viu o carro nao pode herdar o risco dele.
 *
 * Divergencias entre saida e entrada (odometro que andou demais, combustivel
 * que sumiu, avaria nova) sao calculadas automaticamente e ficam registradas no
 * termo. Sao a base objetiva de qualquer conversa sobre quem paga o que.
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
import { type Transition, transitioned } from '../shared/transition.ts';
import type { Instant } from '../shared/clock.ts';
import type { CustodyTransferId, RecallId, StoreId, UserId } from '../shared/ids.ts';
import { YARD_RADIUS_METERS, distanceMeters } from '../shared/geo.ts';
import type { Store } from '../network/store.ts';
import {
  parseCpf,
  parseFuelEighths,
  parseHttpUrl,
  parseOdometer,
  requireOneOf,
  requireText,
} from '../shared/validation.ts';
import {
  type Vehicle,
  CommercialStatus,
  PhysicalState,
} from '../vehicle/vehicle.ts';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Fotos e avarias
// ---------------------------------------------------------------------------

export const PhotoAngle = {
  FRONT: 'FRONT',
  REAR: 'REAR',
  LEFT: 'LEFT',
  RIGHT: 'RIGHT',
  INTERIOR: 'INTERIOR',
  ODOMETER: 'ODOMETER',
  ENGINE_BAY: 'ENGINE_BAY',
  DAMAGE: 'DAMAGE',
  OTHER: 'OTHER',
} as const;
export type PhotoAngle = (typeof PhotoAngle)[keyof typeof PhotoAngle];

/**
 * Angulos sem os quais o termo nao fecha. Sao os que sustentam uma discussao
 * sobre avaria: os quatro lados do carro mais a foto do painel com o odometro.
 */
export const REQUIRED_PHOTO_ANGLES: readonly PhotoAngle[] = [
  PhotoAngle.FRONT,
  PhotoAngle.REAR,
  PhotoAngle.LEFT,
  PhotoAngle.RIGHT,
  PhotoAngle.ODOMETER,
];

export type TermPhoto = {
  readonly angle: PhotoAngle;
  readonly url: string;
};

export const DamageSeverity = {
  LIGHT: 'LIGHT',
  MODERATE: 'MODERATE',
  SEVERE: 'SEVERE',
} as const;
export type DamageSeverity = (typeof DamageSeverity)[keyof typeof DamageSeverity];

export type DamageNote = {
  /** Onde: "para-choque dianteiro", "porta traseira esquerda". */
  readonly area: string;
  readonly severity: DamageSeverity;
  readonly description: string;
  readonly photoUrls: readonly string[];
};

// ---------------------------------------------------------------------------
// Termo de vistoria
// ---------------------------------------------------------------------------

export type Signature = {
  readonly signerName: string;
  readonly signerDocument: string;
  /** "Gerente", "Motorista do guincho", "Conferente de patio". */
  readonly signerRole: string;
  readonly userId: UserId;
  readonly storeId: StoreId;
  /**
   * SHA-256 do conteudo do termo no momento da assinatura, sem a propria
   * assinatura. Se alguem editar odometro ou fotos depois, `verifyTerm` acusa.
   */
  readonly termHash: string;
  readonly signedAt: Instant;
};

export type InspectionTermContent = {
  readonly odometerKm: number;
  /** Combustivel em oitavos (0 a 8), como se le o ponteiro do painel. */
  readonly fuelEighths: number;
  readonly photos: readonly TermPhoto[];
  readonly damages: readonly DamageNote[];
  readonly observations: string | null;
  readonly geolocation: { readonly lat: number; readonly lng: number } | null;
};

export type InspectionTerm = InspectionTermContent & {
  readonly signature: Signature;
};

export function computeTermHash(content: InspectionTermContent): string {
  // Serializacao canonica: chaves em ordem fixa para o hash ser estavel.
  const canonical = JSON.stringify({
    odometerKm: content.odometerKm,
    fuelEighths: content.fuelEighths,
    photos: [...content.photos]
      .map((photo) => `${photo.angle}|${photo.url}`)
      .sort(),
    damages: [...content.damages]
      .map((damage) => `${damage.area}|${damage.severity}|${damage.description}`)
      .sort(),
    observations: content.observations,
    geolocation: content.geolocation,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export type Signer = {
  readonly name: string;
  readonly document: string;
  readonly role: string;
  readonly userId: UserId;
  readonly storeId: StoreId;
};

/** Sela o termo: valida o conteudo, calcula o hash e anexa a assinatura. */
export function sealTerm(
  rawContent: unknown,
  signer: Signer,
  signedAt: Instant,
): Result<InspectionTerm, DomainError> {
  const content = parseTermContent(rawContent);
  if (!content.ok) return content;

  const signerDocument = parseCpf(signer.document, 'CPF do responsavel');
  if (!signerDocument.ok) return signerDocument;

  const signerName = requireText(signer.name, 'nome do responsavel', { min: 3, max: 120 });
  if (!signerName.ok) return signerName;

  const signerRole = requireText(signer.role, 'funcao do responsavel', { min: 2, max: 60 });
  if (!signerRole.ok) return signerRole;

  return ok({
    ...content.value,
    signature: {
      signerName: signerName.value,
      signerDocument: signerDocument.value,
      signerRole: signerRole.value,
      userId: signer.userId,
      storeId: signer.storeId,
      termHash: computeTermHash(content.value),
      signedAt,
    },
  });
}

/** O termo continua batendo com a assinatura? Detecta edicao posterior. */
export function verifyTerm(term: InspectionTerm): boolean {
  return computeTermHash(term) === term.signature.termHash;
}

export function parseTermContent(input: unknown): Result<InspectionTermContent, DomainError> {
  if (typeof input !== 'object' || input === null) {
    return err(validationError('TERM_REQUIRED', 'O termo de vistoria e obrigatorio.'));
  }
  const raw = input as Record<string, unknown>;

  const base = combine({
    odometerKm: parseOdometer(raw['odometerKm']),
    fuelEighths: parseFuelEighths(raw['fuelEighths']),
  });
  if (!base.ok) return base;

  const photos = parsePhotos(raw['photos']);
  if (!photos.ok) return photos;

  const damages = parseDamages(raw['damages']);
  if (!damages.ok) return damages;

  const observations =
    typeof raw['observations'] === 'string' && raw['observations'].trim().length > 0
      ? raw['observations'].trim().slice(0, 2000)
      : null;

  const geolocation = parseGeolocation(raw['geolocation']);

  return ok({ ...base.value, photos: photos.value, damages: damages.value, observations, geolocation });
}

function parsePhotos(input: unknown): Result<TermPhoto[], DomainError> {
  if (!Array.isArray(input)) {
    return err(validationError('PHOTOS_REQUIRED', 'Fotos da vistoria sao obrigatorias.'));
  }

  const photos: TermPhoto[] = [];
  for (const entry of input.slice(0, 40)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const angle = requireOneOf(record['angle'], 'angulo da foto', Object.values(PhotoAngle));
    const url = parseHttpUrl(record['url'], 'foto da vistoria');
    if (!angle.ok) return angle;
    if (!url.ok) return url;
    photos.push({ angle: angle.value, url: url.value });
  }

  const present = new Set(photos.map((photo) => photo.angle));
  const missing = REQUIRED_PHOTO_ANGLES.filter((angle) => !present.has(angle));
  if (missing.length > 0) {
    return err(
      ruleViolation(
        'REQUIRED_PHOTOS_MISSING',
        `Faltam fotos obrigatorias da vistoria: ${missing.join(', ')}.`,
        { missing, required: REQUIRED_PHOTO_ANGLES },
      ),
    );
  }

  return ok(photos);
}

function parseDamages(input: unknown): Result<DamageNote[], DomainError> {
  if (input === undefined || input === null) return ok([]);
  if (!Array.isArray(input)) {
    return err(validationError('DAMAGES_INVALID', 'Lista de avarias invalida.'));
  }

  const damages: DamageNote[] = [];
  for (const entry of input.slice(0, 50)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const parsed = combine({
      area: requireText(record['area'], 'area da avaria', { min: 2, max: 80 }),
      severity: requireOneOf(record['severity'], 'gravidade', Object.values(DamageSeverity)),
      description: requireText(record['description'], 'descricao da avaria', { min: 3, max: 500 }),
    });
    if (!parsed.ok) return parsed;

    const photoUrls: string[] = [];
    for (const candidate of Array.isArray(record['photoUrls']) ? record['photoUrls'] : []) {
      const url = parseHttpUrl(candidate, 'foto da avaria');
      if (url.ok) photoUrls.push(url.value);
    }
    damages.push({ ...parsed.value, photoUrls });
  }
  return ok(damages);
}

function parseGeolocation(input: unknown): { lat: number; lng: number } | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  const lat = record['lat'];
  const lng = record['lng'];
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  // Number.isFinite alem do typeof: NaN e Infinity SAO number, e toda comparacao
  // de faixa com NaN e falsa — entao a checagem de limites sozinha os deixaria
  // passar, e a coordenada viraria `null` silenciosamente no JSON.
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

// ---------------------------------------------------------------------------
// Divergencias entre saida e entrada
// ---------------------------------------------------------------------------

export const DiscrepancyKind = {
  ODOMETER: 'ODOMETER',
  FUEL: 'FUEL',
  NEW_DAMAGE: 'NEW_DAMAGE',
} as const;
export type DiscrepancyKind = (typeof DiscrepancyKind)[keyof typeof DiscrepancyKind];

export type Discrepancy = {
  readonly kind: DiscrepancyKind;
  readonly description: string;
  readonly details: Readonly<Record<string, unknown>>;
};

export type CustodyPolicy = {
  /** Km de folga entre saida e entrada antes de virar divergencia. */
  readonly odometerToleranceKm: number;
  /** Oitavos de combustivel de folga. */
  readonly fuelToleranceEighths: number;
};

export const DEFAULT_CUSTODY_POLICY: CustodyPolicy = {
  // Cobre o deslocamento normal entre patios da mesma regiao.
  odometerToleranceKm: 80,
  fuelToleranceEighths: 1,
};

/**
 * Compara os dois lados do termo. Diferenca de odometro alem da tolerancia,
 * combustivel a menos e avaria que nao existia na saida viram registro objetivo.
 */
export function detectDiscrepancies(
  checkout: InspectionTerm,
  checkin: InspectionTerm,
  policy: CustodyPolicy = DEFAULT_CUSTODY_POLICY,
): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];

  const drivenKm = checkin.odometerKm - checkout.odometerKm;
  if (drivenKm < 0) {
    discrepancies.push({
      kind: DiscrepancyKind.ODOMETER,
      description: `Odometro na entrada (${checkin.odometerKm} km) e menor que na saida (${checkout.odometerKm} km).`,
      details: { checkoutKm: checkout.odometerKm, checkinKm: checkin.odometerKm, drivenKm },
    });
  } else if (drivenKm > policy.odometerToleranceKm) {
    discrepancies.push({
      kind: DiscrepancyKind.ODOMETER,
      description: `O veiculo rodou ${drivenKm} km entre a saida e a entrada (tolerancia de ${policy.odometerToleranceKm} km).`,
      details: { checkoutKm: checkout.odometerKm, checkinKm: checkin.odometerKm, drivenKm },
    });
  }

  const fuelDelta = checkin.fuelEighths - checkout.fuelEighths;
  if (fuelDelta < -policy.fuelToleranceEighths) {
    discrepancies.push({
      kind: DiscrepancyKind.FUEL,
      description: `Combustivel caiu de ${checkout.fuelEighths}/8 para ${checkin.fuelEighths}/8.`,
      details: { checkoutEighths: checkout.fuelEighths, checkinEighths: checkin.fuelEighths, fuelDelta },
    });
  }

  const knownAreas = new Set(checkout.damages.map((damage) => normalizeArea(damage.area)));
  for (const damage of checkin.damages) {
    if (!knownAreas.has(normalizeArea(damage.area))) {
      discrepancies.push({
        kind: DiscrepancyKind.NEW_DAMAGE,
        description: `Avaria nao registrada na saida: ${damage.area} (${damage.severity}).`,
        details: { area: damage.area, severity: damage.severity, description: damage.description },
      });
    }
  }

  return discrepancies;
}

function normalizeArea(area: string): string {
  return area
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Transferencia de custodia
// ---------------------------------------------------------------------------

export const TransferPurpose = {
  /** Apresentacao ao cliente / test-drive na loja de destino. */
  TEST_DRIVE: 'TEST_DRIVE',
  /** Exposicao continuada no showroom da outra loja. */
  EXTENDED_STOCK: 'EXTENDED_STOCK',
  /** Retorno a loja proprietaria em atendimento a um recall. */
  RECALL_RETURN: 'RECALL_RETURN',
  /**
   * Movimentacao depois da venda fechada, para que a loja vendedora entregue o
   * carro ao comprador. E a unica finalidade aceita para um veiculo VENDIDO:
   * o carro pode estar no patio da dona e quem entrega e quem atendeu o cliente.
   */
  SALE_HANDOVER: 'SALE_HANDOVER',
  OTHER: 'OTHER',
} as const;
export type TransferPurpose = (typeof TransferPurpose)[keyof typeof TransferPurpose];

export const TransferStatus = {
  /** Saida assinada, entrada pendente. Veiculo em transito. */
  OPEN: 'OPEN',
  /**
   * Quem levou declarou a entrega no patio de destino, com geolocalizacao.
   * Falta o aceite de quem recebe — e e o aceite que move a custodia.
   */
  DROPPED_OFF: 'DROPPED_OFF',
  COMPLETED: 'COMPLETED',
  /** Saida assinada mas o carro voltou para a origem sem chegar ao destino. */
  CANCELLED: 'CANCELLED',
} as const;
export type TransferStatus = (typeof TransferStatus)[keyof typeof TransferStatus];

/**
 * Declaracao de entrega: "deixei o carro no patio de voces".
 *
 * A geolocalizacao e **obrigatoria** aqui, ao contrario da vistoria, onde e
 * opcional. E a razao de existir da declaracao: sem coordenada, "deixei no
 * patio" e a palavra de um contra a do outro — exatamente a disputa que o
 * livro de custodia existe para nao ter.
 *
 * Nao e prova irrefutavel (celular mente, alguem pode declarar do
 * estacionamento ao lado), e nao pretende ser. E registro datado, assinado e
 * posicionado, que e o que resolve 99% dos casos reais entre parceiros.
 */
export type DropOffDeclaration = {
  readonly declaredByStoreId: StoreId;
  readonly declaredByUserId: UserId;
  readonly at: Instant;
  readonly geolocation: { readonly lat: number; readonly lng: number };
  /** "Chave na recepcao, vaga 12." O que o recebedor precisa para achar o carro. */
  readonly note: string | null;
};

export type CustodyTransfer = {
  readonly id: CustodyTransferId;
  readonly vehicleId: string;
  readonly fromStoreId: StoreId;
  readonly toStoreId: StoreId;
  readonly purpose: TransferPurpose;
  readonly status: TransferStatus;
  readonly checkout: InspectionTerm;
  readonly dropOff: DropOffDeclaration | null;
  readonly checkin: InspectionTerm | null;
  readonly openedAt: Instant;
  readonly closedAt: Instant | null;
  readonly discrepancies: readonly Discrepancy[];
  readonly recallId: RecallId | null;
};

export type VehicleWithTransfer = {
  readonly vehicle: Vehicle;
  readonly transfer: CustodyTransfer;
};

export type OpenTransferCommand = {
  readonly transferId: CustodyTransferId;
  readonly vehicle: Vehicle;
  readonly toStoreId: StoreId;
  readonly purpose: TransferPurpose;
  readonly checkout: InspectionTerm;
  readonly recallId?: RecallId | null;
  readonly now: Instant;
  /** Loja que detem trava ativa sobre o veiculo, se houver. */
  readonly activeLockHolderStoreId?: StoreId | null;
};

/**
 * Abre o termo: o carro sai do patio de origem.
 *
 * Quem assina a saida e a loja que ESTA com o carro — e ela quem pode atestar
 * em que estado ele saiu.
 */
export function openTransfer(command: OpenTransferCommand): Transition<VehicleWithTransfer> {
  const { vehicle, checkout, now } = command;
  const fromStoreId = vehicle.physical.custodianStoreId;

  if (checkout.signature.storeId !== fromStoreId) {
    return err(
      forbiddenError(
        'CHECKOUT_MUST_BE_SIGNED_BY_CUSTODIAN',
        'A saida precisa ser assinada pela loja que esta com o veiculo.',
        { custodianStoreId: fromStoreId, signedByStoreId: checkout.signature.storeId },
      ),
    );
  }
  if (command.toStoreId === fromStoreId) {
    return err(
      validationError('SAME_STORE_TRANSFER', 'Origem e destino da movimentacao sao a mesma loja.', {
        storeId: fromStoreId,
      }),
    );
  }
  if (vehicle.physical.state === PhysicalState.IN_TRANSIT) {
    return err(
      conflictError('TRANSFER_ALREADY_OPEN', 'Ja existe um termo de custodia aberto para este veiculo.', {
        vehicleId: vehicle.id,
        openTransferId: vehicle.physical.openTransferId,
      }),
    );
  }
  if (vehicle.physical.state === PhysicalState.DELIVERED_TO_CONSUMER) {
    return err(
      conflictError('VEHICLE_DELIVERED', 'Veiculo ja entregue ao consumidor final.', {
        vehicleId: vehicle.id,
      }),
    );
  }
  if (
    vehicle.commercialStatus === CommercialStatus.SOLD &&
    command.purpose !== TransferPurpose.SALE_HANDOVER
  ) {
    return err(
      conflictError(
        'VEHICLE_SOLD',
        'Veiculo vendido: a unica movimentacao aceita e SALE_HANDOVER, para entrega ao comprador.',
        { vehicleId: vehicle.id, purpose: command.purpose },
      ),
    );
  }

  // Enquanto uma loja detem trava ativa, o carro nao pode ir parar num terceiro:
  // isso deixaria quem esta negociando sem como apresentar o veiculo.
  const lockHolder = command.activeLockHolderStoreId ?? null;
  if (
    lockHolder !== null &&
    command.toStoreId !== lockHolder &&
    command.toStoreId !== vehicle.ownerStoreId
  ) {
    return err(
      conflictError(
        'VEHICLE_UNDER_ACTIVE_LOCK',
        'Ha trava comercial ativa de outra loja. O veiculo so pode ir para quem detem a trava ou para a loja proprietaria.',
        { vehicleId: vehicle.id, lockHolderStoreId: lockHolder, requestedStoreId: command.toStoreId },
      ),
    );
  }

  if (!verifyTerm(checkout)) {
    return err(
      validationError('TERM_HASH_MISMATCH', 'O termo de saida foi alterado depois de assinado.', {
        transferId: command.transferId,
      }),
    );
  }

  const transfer: CustodyTransfer = {
    id: command.transferId,
    vehicleId: vehicle.id,
    fromStoreId,
    toStoreId: command.toStoreId,
    purpose: command.purpose,
    status: TransferStatus.OPEN,
    checkout,
    dropOff: null,
    checkin: null,
    openedAt: now,
    closedAt: null,
    discrepancies: [],
    recallId: command.recallId ?? null,
  };

  const inTransit: Vehicle = {
    ...vehicle,
    physical: {
      state: PhysicalState.IN_TRANSIT,
      // Responsabilidade permanece com a origem ate a assinatura da entrada.
      custodianStoreId: fromStoreId,
      inboundStoreId: command.toStoreId,
      since: now,
      openTransferId: transfer.id,
    },
    updatedAt: now,
  };

  return transitioned({ vehicle: inTransit, transfer }, [
    domainEvent('custody.checked_out', vehicle.id, now, {
      transferId: transfer.id,
      fromStoreId,
      toStoreId: command.toStoreId,
      purpose: command.purpose,
      odometerKm: checkout.odometerKm,
      fuelEighths: checkout.fuelEighths,
      preexistingDamages: checkout.damages.length,
    }),
  ]);
}

export type CheckInCommand = {
  readonly vehicle: Vehicle;
  readonly transfer: CustodyTransfer;
  readonly checkin: InspectionTerm;
  readonly now: Instant;
  readonly policy?: CustodyPolicy;
};

/**
 * Fecha o termo: o carro deu entrada no destino.
 *
 * Este e o instante exato em que a responsabilidade civil muda de loja.
 */
export type DeclareDropOffCommand = {
  readonly vehicle: Vehicle;
  readonly transfer: CustodyTransfer;
  readonly actorStoreId: StoreId;
  readonly actorUserId: UserId;
  readonly geolocation: { readonly lat: number; readonly lng: number };
  /**
   * A loja de DESTINO. Parametro obrigatorio porque e a coordenada do patio
   * dela que faz a geolocalizacao significar alguma coisa — sem ela, a
   * declaracao provava *uma* posicao, nao *a* posicao.
   */
  readonly destination: Store;
  readonly note?: string | null;
  readonly now: Instant;
};

/**
 * Quem levou o carro declara que o deixou no patio de destino.
 *
 * Nao move a custodia. O carro esta la, mas quem recebe ainda nao conferiu — e
 * conferir e o que transfere multa, avaria e sinistro. Declarar entrega e
 * assumir uma posicao registrada, nao se livrar da responsabilidade.
 *
 * Quem declara e a loja de ORIGEM do termo, que e quem estava com o carro.
 */
export function declareDropOff(command: DeclareDropOffCommand): Transition<VehicleWithTransfer> {
  const { vehicle, transfer, actorStoreId, now } = command;

  if (transfer.status !== TransferStatus.OPEN) {
    return err(
      conflictError(
        'TRANSFER_NOT_IN_TRANSIT',
        'So um termo em transito pode receber declaracao de entrega.',
        { transferId: transfer.id, status: transfer.status },
      ),
    );
  }
  if (actorStoreId !== transfer.fromStoreId) {
    return err(
      forbiddenError(
        'DROP_OFF_MUST_BE_DECLARED_BY_CARRIER',
        'Quem declara a entrega e a loja que levou o veiculo.',
        { expectedStoreId: transfer.fromStoreId, actorStoreId },
      ),
    );
  }

  const geo = parseGeolocation(command.geolocation);
  if (geo === null) {
    return err(
      validationError(
        'DROP_OFF_GEOLOCATION_REQUIRED',
        'A entrega precisa de geolocalizacao: sem coordenada, "deixei no patio" nao e registro.',
        { transferId: transfer.id },
      ),
    );
  }

  // A coordenada e conferida contra o patio de destino. Recusar aqui e melhor
  // que registrar a falha depois: impede o erro em vez de puni-lo, e devolve a
  // distancia para quem esta com o celular na mao resolver na hora.
  //
  // O raio e generoso (500 m) justamente para que erro de GPS em rua de centro
  // nao vire acusacao. O que isto elimina e a declaracao feita de qualquer
  // lugar — que era o unico caso real.
  const metros = distanceMeters(geo, command.destination.profile.yard);
  if (metros > YARD_RADIUS_METERS) {
    return err(
      ruleViolation(
        'DROP_OFF_AWAY_FROM_YARD',
        `A coordenada informada esta a ${Math.round(metros)} m do patio de destino. ` +
          'Declare a entrega no patio: e a coordenada que faz o registro valer.',
        {
          transferId: transfer.id,
          distanceMeters: Math.round(metros),
          toleranceMeters: YARD_RADIUS_METERS,
        },
      ),
    );
  }

  const dropOff: DropOffDeclaration = {
    declaredByStoreId: actorStoreId,
    declaredByUserId: command.actorUserId,
    at: now,
    geolocation: geo,
    note: command.note ?? null,
  };

  const declared: CustodyTransfer = {
    ...transfer,
    status: TransferStatus.DROPPED_OFF,
    dropOff,
  };

  const parked: Vehicle = {
    ...vehicle,
    physical: {
      ...vehicle.physical,
      state: PhysicalState.AWAITING_ACCEPTANCE,
      // A custodia NAO muda aqui. Continua com quem levou ate o aceite.
      since: now,
    },
    updatedAt: now,
  };

  return transitioned({ vehicle: parked, transfer: declared }, [
    domainEvent('custody.dropped_off', vehicle.id, now, {
      transferId: transfer.id,
      fromStoreId: transfer.fromStoreId,
      toStoreId: transfer.toStoreId,
      purpose: transfer.purpose,
      lat: geo.lat,
      lng: geo.lng,
      recallId: transfer.recallId,
    }),
  ]);
}

export function checkIn(command: CheckInCommand): Transition<VehicleWithTransfer> {
  const { vehicle, transfer, checkin, now } = command;

  // Aceita tanto o carro que chegou com alguem para receber (OPEN) quanto o que
  // foi deixado e esperou o expediente (DROPPED_OFF).
  const aberto =
    transfer.status === TransferStatus.OPEN || transfer.status === TransferStatus.DROPPED_OFF;
  if (!aberto) {
    return err(
      conflictError('TRANSFER_NOT_OPEN', 'Este termo de custodia ja foi encerrado.', {
        transferId: transfer.id,
        status: transfer.status,
      }),
    );
  }
  if (checkin.signature.storeId !== transfer.toStoreId) {
    return err(
      forbiddenError(
        'CHECKIN_MUST_BE_SIGNED_BY_DESTINATION',
        'A entrada precisa ser assinada pela loja de destino, que e quem confere o veiculo.',
        { expectedStoreId: transfer.toStoreId, signedByStoreId: checkin.signature.storeId },
      ),
    );
  }
  if (!verifyTerm(checkin)) {
    return err(
      validationError('TERM_HASH_MISMATCH', 'O termo de entrada foi alterado depois de assinado.', {
        transferId: transfer.id,
      }),
    );
  }
  if (checkin.signature.signedAt < transfer.checkout.signature.signedAt) {
    return err(
      validationError(
        'CHECKIN_BEFORE_CHECKOUT',
        'A entrada nao pode ser anterior a saida.',
        { transferId: transfer.id },
      ),
    );
  }

  const discrepancies = detectDiscrepancies(transfer.checkout, checkin, command.policy);

  const completed: CustodyTransfer = {
    ...transfer,
    status: TransferStatus.COMPLETED,
    checkin,
    closedAt: now,
    discrepancies,
  };

  const delivered: Vehicle = {
    ...vehicle,
    physical: {
      state: PhysicalState.AT_YARD,
      // A partir de agora, quem responde por multa, avaria e sinistro e o destino.
      custodianStoreId: transfer.toStoreId,
      inboundStoreId: null,
      since: now,
      openTransferId: null,
    },
    // O odometro do veiculo passa a ser o da ultima vistoria.
    specs: { ...vehicle.specs, mileageKm: Math.max(vehicle.specs.mileageKm, checkin.odometerKm) },
    updatedAt: now,
  };

  const events: DomainEvent[] = [
    domainEvent('custody.checked_in', vehicle.id, now, {
      transferId: transfer.id,
      fromStoreId: transfer.fromStoreId,
      toStoreId: transfer.toStoreId,
      purpose: transfer.purpose,
      odometerKm: checkin.odometerKm,
      drivenKm: checkin.odometerKm - transfer.checkout.odometerKm,
      discrepancyCount: discrepancies.length,
      recallId: transfer.recallId,
    }),
  ];

  if (discrepancies.length > 0) {
    events.push(
      domainEvent('custody.discrepancies_found', vehicle.id, now, {
        transferId: transfer.id,
        fromStoreId: transfer.fromStoreId,
        toStoreId: transfer.toStoreId,
        discrepancies,
      }),
    );
  }

  return transitioned({ vehicle: delivered, transfer: completed }, events);
}

export type CancelTransferCommand = {
  readonly vehicle: Vehicle;
  readonly transfer: CustodyTransfer;
  readonly actorStoreId: StoreId;
  readonly reason: string;
  readonly now: Instant;
};

/** O carro nao chegou ao destino e voltou para a origem. Custodia nao muda. */
export function cancelTransfer(command: CancelTransferCommand): Transition<VehicleWithTransfer> {
  const { vehicle, transfer, now } = command;

  // Cancelar tambem vale depois da entrega declarada: e o caminho da recusa —
  // o recebedor abre o portao, ve que nao e o carro combinado (ou que chegou
  // batido) e devolve. O carro volta para quem levou, que nunca deixou de ser
  // o custodiante. A declaracao geolocalizada fica no historico, e e ela que
  // sustenta a conversa sobre quem pagou o guincho de volta.
  const encerravel =
    transfer.status === TransferStatus.OPEN || transfer.status === TransferStatus.DROPPED_OFF;
  if (!encerravel) {
    return err(
      conflictError('TRANSFER_NOT_OPEN', 'Este termo de custodia ja foi encerrado.', {
        transferId: transfer.id,
        status: transfer.status,
      }),
    );
  }
  if (command.actorStoreId !== transfer.fromStoreId && command.actorStoreId !== transfer.toStoreId) {
    return err(
      forbiddenError(
        'NOT_A_TRANSFER_PARTY',
        'Somente a loja de origem ou a de destino cancelam a movimentacao.',
        { transferId: transfer.id },
      ),
    );
  }

  const cancelled: CustodyTransfer = {
    ...transfer,
    status: TransferStatus.CANCELLED,
    closedAt: now,
  };
  const back: Vehicle = {
    ...vehicle,
    physical: {
      state: PhysicalState.AT_YARD,
      custodianStoreId: transfer.fromStoreId,
      inboundStoreId: null,
      since: now,
      openTransferId: null,
    },
    updatedAt: now,
  };

  return transitioned({ vehicle: back, transfer: cancelled }, [
    domainEvent('custody.transfer_cancelled', vehicle.id, now, {
      transferId: transfer.id,
      reason: command.reason,
      custodianStoreId: transfer.fromStoreId,
    }),
  ]);
}

export type DeliverToConsumerCommand = {
  readonly vehicle: Vehicle;
  readonly actorStoreId: StoreId;
  readonly finalTerm: InspectionTerm;
  readonly now: Instant;
};

/** Entrega ao comprador final: encerra o eixo fisico. Estado terminal. */
export function deliverToConsumer(command: DeliverToConsumerCommand): Transition<Vehicle> {
  const { vehicle, now } = command;

  if (vehicle.commercialStatus !== CommercialStatus.SOLD) {
    return err(
      conflictError(
        'VEHICLE_NOT_SOLD',
        'A entrega ao consumidor exige uma venda confirmada.',
        { vehicleId: vehicle.id, status: vehicle.commercialStatus },
      ),
    );
  }
  if (vehicle.physical.state === PhysicalState.DELIVERED_TO_CONSUMER) {
    return err(
      conflictError('VEHICLE_DELIVERED', 'Veiculo ja entregue.', { vehicleId: vehicle.id }),
    );
  }
  if (vehicle.physical.custodianStoreId !== command.actorStoreId) {
    return err(
      forbiddenError(
        'NOT_CURRENT_CUSTODIAN',
        'Somente a loja que esta com o veiculo pode entrega-lo ao comprador.',
        { custodianStoreId: vehicle.physical.custodianStoreId },
      ),
    );
  }
  if (!verifyTerm(command.finalTerm)) {
    return err(
      validationError('TERM_HASH_MISMATCH', 'O termo de entrega foi alterado depois de assinado.', {
        vehicleId: vehicle.id,
      }),
    );
  }

  return transitioned(
    {
      ...vehicle,
      physical: {
        state: PhysicalState.DELIVERED_TO_CONSUMER,
        custodianStoreId: command.actorStoreId,
        inboundStoreId: null,
        since: now,
        openTransferId: null,
      },
      updatedAt: now,
    },
    [
      domainEvent('custody.delivered_to_consumer', vehicle.id, now, {
        deliveredByStoreId: command.actorStoreId,
        odometerKm: command.finalTerm.odometerKm,
      }),
    ],
  );
}
