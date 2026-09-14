/**
 * Notificações da rede: transforma evento de domínio em aviso para uma loja.
 *
 * Sem isto o produto fica pela metade. A regra da trava de 4 horas só entrega
 * valor se, quando ela cai, a rede FICA SABENDO que o carro voltou a estar
 * disponível — caso contrário o gerente continua descobrindo por telefone, que
 * é exatamente o atrito que a plataforma existe para remover.
 *
 * O mapeamento é a única coisa que este módulo faz: quem recebe o quê, e com
 * que urgência. O domínio não sabe que notificação existe; ele só registra o
 * que aconteceu.
 */

import { type DomainEvent } from '../domain/shared/events.ts';
import type { Instant } from '../domain/shared/clock.ts';
import { formatDuration } from '../domain/shared/clock.ts';
import type { ClusterId, StoreId } from '../domain/shared/ids.ts';
import type { Store } from '../domain/network/store.ts';
import { StoreKind, StoreStatus } from '../domain/network/store.ts';
import type { AppContext } from './context.ts';

export const NotificationSeverity = {
  /** Informativo: uma oportunidade apareceu. */
  INFO: 'INFO',
  /** Alguém precisa fazer alguma coisa, e há prazo correndo. */
  ACTION_REQUIRED: 'ACTION_REQUIRED',
  /** Prazo estourado ou inconsistência que já custou algo. */
  ALERT: 'ALERT',
} as const;
export type NotificationSeverity =
  (typeof NotificationSeverity)[keyof typeof NotificationSeverity];

export type Notification = {
  readonly id: string;
  readonly storeId: StoreId;
  readonly eventType: string;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body: string;
  readonly aggregateId: string;
  readonly occurredAt: Instant;
  readonly readAt: Instant | null;
};

/** A quem entregar, e o texto. `null` significa "este evento não notifica". */
type Draft = {
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body: string;
  /** Lojas específicas; se ausente, é broadcast — e aí `broadcast` é obrigatório. */
  readonly to?: readonly (StoreId | null | undefined)[];
  /** Lojas que não devem receber, mesmo no broadcast (quem causou o evento). */
  readonly except?: readonly (StoreId | null | undefined)[];
  /**
   * Alcance do broadcast. O `clusterId` é obrigatório aqui de propósito: "avise
   * a rede" só faz sentido dentro de **uma** praça, e um broadcast sem praça
   * mandaria aviso de estoque de Curitiba para uma loja de outra cidade.
   * Exigir no tipo obriga o evento a carregar a praça no payload.
   */
  readonly broadcast?: { readonly clusterId: ClusterId; readonly foundersOnly?: boolean };
};

function draftFor(event: DomainEvent): Draft | null {
  const payload = event.payload;
  const store = (key: string): StoreId | undefined => payload[key] as StoreId | undefined;
  const text = (key: string): string => String(payload[key] ?? '');
  /**
   * A praça do evento. Se um evento que faz broadcast chegar sem ela, é bug de
   * quem emitiu — e `resolveTargets` entrega a ninguém em vez de entregar à
   * rede errada. Silêncio é a falha segura aqui; vazamento entre praças não é.
   */
  const cluster = (): ClusterId => payload['clusterId'] as ClusterId;

  switch (event.type) {
    // -- o carro voltou para a rede -------------------------------------------
    case 'vehicle.available_again':
      return {
        severity: NotificationSeverity.INFO,
        title: 'Veículo disponível novamente',
        body:
          payload['onExtendedCustody'] === true
            ? 'Um veículo voltou a ficar disponível na rede e está no pátio de uma loja parceira — pronto para apresentação imediata.'
            : 'Um veículo voltou a ficar disponível na rede.',
        // Sem `except`: a custodiante e justamente quem mais precisa saber. No
        // estoque avancado o carro esta no showroom dela e acabou de voltar a
        // ser vendavel — e o aviso mais valioso da rede, nao ruido.
        broadcast: { clusterId: cluster() },
      };

    case 'vehicle.neutral_photos_published':
      return {
        severity: NotificationSeverity.INFO,
        title: 'Material de divulgacao disponivel',
        body: 'Um veiculo da rede ganhou fotos neutras: o material ja pode ser baixado e usado no seu canal.',
        except: [store('ownerStoreId')],
      };

    case 'feed.vehicle_created':
      return {
        severity: NotificationSeverity.INFO,
        title: 'Novo veículo na rede',
        body: `Uma loja publicou um veículo novo no estoque compartilhado (placa ${text('plate')}).`,
        except: [store('storeId')],
      };

    // -- recall ---------------------------------------------------------------
    case 'recall.requested':
      return {
        severity: NotificationSeverity.ACTION_REQUIRED,
        title: 'Retorno de veículo solicitado',
        body:
          payload['blockedByLockId'] === null || payload['blockedByLockId'] === undefined
            ? 'A loja proprietária pediu o veículo de volta. O prazo de liberação já está correndo.'
            : 'A loja proprietária pediu o veículo de volta. Sua trava comercial segue valendo até o fim do prazo; o SLA começa depois dela.',
        to: [store('custodianStoreId')],
      };

    case 'recall.sla_started':
      return {
        severity: NotificationSeverity.ACTION_REQUIRED,
        title: 'Prazo de devolução iniciado',
        body: 'A trava comercial terminou. O prazo para disponibilizar o retorno do veículo começou a correr agora.',
        to: [store('custodianStoreId')],
      };

    case 'recall.collection_elected':
      return {
        severity: NotificationSeverity.ACTION_REQUIRED,
        title: 'A loja proprietaria vem buscar o veiculo',
        body: 'Voce nao precisa organizar transporte — basta deixar o carro disponivel, com chave e alguem para assinar a saida.',
        to: [store('custodianStoreId')],
      };

    case 'recall.ready_for_pickup':
      return {
        severity: NotificationSeverity.ACTION_REQUIRED,
        title: 'Veiculo disponivel para retirada',
        body: 'A loja que esta com o carro o deixou pronto. O prazo dela parou aqui: agora depende de voce buscar.',
        to: [store('requestedByStoreId')],
      };

    case 'recall.deadline_reopened':
      return {
        severity: NotificationSeverity.ALERT,
        title: 'Retirada frustrada: o prazo voltou a correr',
        body: 'A loja foi buscar o veiculo e ele nao estava disponivel. O prazo retomou de onde havia parado.',
        to: [store('custodianStoreId')],
      };

    case 'recall.sla_breached':
      return {
        severity: NotificationSeverity.ALERT,
        title: 'Prazo de devolução estourado',
        body: 'O SLA de retorno do veículo venceu sem a devolução ter sido registrada.',
        to: [store('custodianStoreId'), store('requestedByStoreId')],
      };

    case 'recall.superseded_by_sale':
      return {
        severity: NotificationSeverity.INFO,
        title: 'Retorno cancelado: o veículo foi vendido',
        body: 'O veículo que você chamou de volta foi vendido pela loja que estava com a trava. Não há devolução — a liquidação vem no lugar.',
        to: [store('requestedByStoreId')],
      };

    // -- negociação -----------------------------------------------------------
    case 'deal.trade_in_acceptance_requested':
      return {
        severity: NotificationSeverity.ACTION_REQUIRED,
        title: 'Transbordo aguardando seu aceite',
        body: 'Uma loja da rede propôs entregar o veículo de troca do cliente a você, abatendo do líquido. A negociação está parada até a sua resposta.',
        to: [store('ownerStoreId')],
      };

    case 'deal.settled':
      return {
        severity: NotificationSeverity.INFO,
        title: 'Repasse liquidado',
        body: 'O valor líquido do repasse foi integralmente liquidado.',
        to: [store('ownerStoreId')],
      };

    case 'deal.confirmed':
      return {
        severity: NotificationSeverity.ACTION_REQUIRED,
        title: 'Venda fechada: aguardando liquidação',
        body: 'Uma loja da rede fechou a venda de um veículo seu. Acompanhe a liquidação e prepare a emissão do ATPV-e.',
        to: [store('ownerStoreId')],
      };

    // -- custódia -------------------------------------------------------------
    case 'custody.discrepancies_found':
      return {
        severity: NotificationSeverity.ALERT,
        title: 'Divergência na vistoria',
        body: 'A vistoria de entrada apontou diferenças em relação à de saída. Os detalhes estão no termo de custódia.',
        to: [store('fromStoreId'), store('toStoreId')],
      };

    // -- estoque --------------------------------------------------------------
    case 'feed.duplicate_vin_detected':
      return {
        severity: NotificationSeverity.ALERT,
        title: 'Chassi já anunciado na rede',
        body: 'Um veículo do seu feed tem chassi já anunciado por outra loja. Duas lojas não podem ofertar o mesmo carro.',
        to: [store('storeId'), store('otherStoreId')],
      };

    case 'feed.vehicle_missing':
      return payload['action'] === 'FLAGGED_ON_EXTENDED_CUSTODY'
        ? {
            severity: NotificationSeverity.ACTION_REQUIRED,
            title: 'Veículo sumiu do feed, mas está com um parceiro',
            body: 'Um veículo saiu do seu feed enquanto está no pátio de outra loja da rede. Combine o retorno ou reative o anúncio.',
            to: [store('storeId'), store('custodianStoreId')],
          }
        : null;

    // -- governança -----------------------------------------------------------
    case 'membership.application_opened':
      return {
        severity: NotificationSeverity.ACTION_REQUIRED,
        title: 'Nova candidatura para credenciamento',
        body: `${text('candidateTradeName')} foi apresentada à rede e aguarda o aval dos fundadores.`,
        broadcast: { clusterId: cluster(), foundersOnly: true },
        except: [store('sponsorStoreId')],
      };

    case 'network.store_admitted':
      return {
        severity: NotificationSeverity.INFO,
        title: 'Nova loja na rede',
        body: `${text('tradeName')} foi credenciada e já está operando.`,
        broadcast: { clusterId: cluster() },
      };

    default:
      return null;
  }
}

/** Título e corpo prontos, para os testes conferirem sem repetir o mapa. */
export function previewNotification(event: DomainEvent): Draft | null {
  return draftFor(event);
}

/**
 * Assina o barramento e materializa as notificações.
 *
 * Roda depois da transação de negócio: uma falha aqui não desfaz a venda, e o
 * `EventBus` já isola erros de handler.
 */
export function registerNotificationSubscriber(context: AppContext): void {
  context.events.on('*', (event) => {
    void deliver(context, event);
  });
}

async function deliver(context: AppContext, event: DomainEvent): Promise<void> {
  const draft = draftFor(event);
  if (draft === null) return;

  const targets = await resolveTargets(context, draft);
  for (const storeId of targets) {
    await context.repos.notifications.append({
      id: context.ids.next('aud'),
      storeId,
      eventType: event.type,
      severity: draft.severity,
      title: draft.title,
      body: draft.body,
      aggregateId: event.aggregateId,
      occurredAt: event.occurredAt,
      readAt: null,
    });
  }
}

async function resolveTargets(context: AppContext, draft: Draft): Promise<StoreId[]> {
  const excluded = new Set((draft.except ?? []).filter((id): id is StoreId => id !== undefined && id !== null));

  if (draft.to !== undefined) {
    const explicit = draft.to.filter((id): id is StoreId => id !== undefined && id !== null);
    return [...new Set(explicit)].filter((id) => !excluded.has(id));
  }

  const broadcast = draft.broadcast;
  if (broadcast === undefined || broadcast.clusterId === undefined) return [];

  const stores = broadcast.foundersOnly
    ? await context.repos.stores.founders(broadcast.clusterId)
    : await context.repos.stores.byCluster(broadcast.clusterId);

  return stores
    .filter((store: Store) => store.status === StoreStatus.ACTIVE)
    .filter((store: Store) => !broadcast.foundersOnly || store.kind === StoreKind.FOUNDER)
    .map((store: Store) => store.id)
    .filter((id) => !excluded.has(id));
}

/** Resumo legível de prazo, usado nos textos que citam SLA. */
export function describeDeadline(dueAt: Instant, now: Instant): string {
  const remaining = dueAt - now;
  return remaining <= 0 ? 'prazo vencido' : `faltam ${formatDuration(remaining)}`;
}
