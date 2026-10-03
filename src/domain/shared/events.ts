/**
 * Eventos de dominio e barramento em processo.
 *
 * O dominio nao dispara notificacao, nao escreve log e nao chama webhook — ele
 * apenas registra o que aconteceu. Quem reage (broadcast na rede, alerta de SLA,
 * trilha de auditoria) assina o barramento. Isso mantem as regras testaveis sem
 * infraestrutura e permite adicionar reacoes sem tocar no agregado.
 */

import type { Instant } from './clock.ts';

export type DomainEvent<
  TType extends string = string,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> = {
  readonly type: TType;
  readonly occurredAt: Instant;
  /** Id do agregado que originou o evento (veiculo, deal, candidatura...). */
  readonly aggregateId: string;
  readonly payload: TPayload;
};

export function domainEvent<TType extends string, TPayload extends Record<string, unknown>>(
  type: TType,
  aggregateId: string,
  occurredAt: Instant,
  payload: TPayload,
): DomainEvent<TType, TPayload> {
  return { type, aggregateId, occurredAt, payload };
}

export type EventHandler = (event: DomainEvent) => void;

/**
 * Reacao que precisa terminar antes de a operacao ser dada como concluida —
 * hoje, gravar o aviso no mural. Um handler sincrono que dispara uma promessa
 * e esquece (`void deliver(...)`) deixa o aviso para depois da resposta: numa
 * funcao serverless o processo pode congelar ali, e o aviso se perde; numa
 * transacao, ele cairia fora dela.
 */
export type AsyncEventHandler = (event: DomainEvent) => Promise<void>;

export type Subscription = { unsubscribe(): void };

/**
 * Barramento sincrono em processo. Um handler que lanca nao derruba os demais
 * nem a transacao de negocio: o erro e entregue ao `onHandlerError`.
 */
export class EventBus {
  readonly #handlers = new Map<string, Set<EventHandler>>();
  readonly #wildcard = new Set<EventHandler>();
  readonly #asyncWildcard = new Set<AsyncEventHandler>();
  readonly #onHandlerError: (error: unknown, event: DomainEvent) => void;

  constructor(onHandlerError?: (error: unknown, event: DomainEvent) => void) {
    this.#onHandlerError =
      onHandlerError ??
      ((error, event) => {
        console.error(`[eventbus] handler falhou para ${event.type}:`, error);
      });
  }

  /** Assina um tipo especifico de evento, ou `'*'` para todos. */
  on(type: string, handler: EventHandler): Subscription {
    const set = type === '*' ? this.#wildcard : this.#handlerSetFor(type);
    set.add(handler);
    return { unsubscribe: () => set.delete(handler) };
  }

  /**
   * Assina todos os eventos com uma reacao assincrona. So e aguardada por
   * `publishAllAndWait`; `publish` sozinho nao a dispara.
   */
  onEveryAsync(handler: AsyncEventHandler): Subscription {
    this.#asyncWildcard.add(handler);
    return { unsubscribe: () => this.#asyncWildcard.delete(handler) };
  }

  /**
   * Publica e espera as reacoes assincronas terminarem, em ordem. Um handler
   * que falha continua nao derrubando os demais nem a operacao: o erro vai para
   * `onHandlerError`, como nos sincronos.
   */
  async publishAllAndWait(events: readonly DomainEvent[]): Promise<void> {
    this.publishAll(events);
    for (const event of events) {
      for (const handler of this.#asyncWildcard) {
        try {
          await handler(event);
        } catch (error) {
          this.#onHandlerError(error, event);
        }
      }
    }
  }

  publish(event: DomainEvent): void {
    for (const handler of this.#handlerSetFor(event.type)) this.#dispatch(handler, event);
    for (const handler of this.#wildcard) this.#dispatch(handler, event);
  }

  publishAll(events: readonly DomainEvent[]): void {
    for (const event of events) this.publish(event);
  }

  #handlerSetFor(type: string): Set<EventHandler> {
    let set = this.#handlers.get(type);
    if (set === undefined) {
      set = new Set();
      this.#handlers.set(type, set);
    }
    return set;
  }

  #dispatch(handler: EventHandler, event: DomainEvent): void {
    try {
      handler(event);
    } catch (error) {
      this.#onHandlerError(error, event);
    }
  }
}

/** Coletor usado em testes: guarda tudo que passou pelo barramento. */
export class RecordingEventBus extends EventBus {
  readonly recorded: DomainEvent[] = [];

  override publish(event: DomainEvent): void {
    this.recorded.push(event);
    super.publish(event);
  }

  typesOf(): string[] {
    return this.recorded.map((event) => event.type);
  }

  find(type: string): DomainEvent | undefined {
    return this.recorded.find((event) => event.type === type);
  }

  countOf(type: string): number {
    return this.recorded.filter((event) => event.type === type).length;
  }

  clear(): void {
    this.recorded.length = 0;
  }
}
