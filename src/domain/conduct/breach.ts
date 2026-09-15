/**
 * Registro de conduta: as quebras de protocolo de entrega e retirada.
 *
 * "Quebrar o protocolo repetidamente por tres vezes suspende" so vira regra se
 * QUEBRA for uma coisa que o sistema mede sozinho. Julgamento humano sobre
 * quem falhou seria um tribunal entre concorrentes, que e exatamente o que esta
 * rede nao pode ter. Entao toda quebra aqui atende tres criterios:
 *
 *  1. OBJETIVA — sai de um prazo vencido ou de um carimbo que faltou, nunca de
 *     opiniao;
 *  2. ATRIBUIVEL — sobra para uma loja so, sem ambiguidade;
 *  3. JA MEDIDA — o sistema conhece o fato antes de alguem reclamar.
 *
 * O que ficou DE FORA, e por que:
 *
 *  - divergencia de vistoria (odometro alem da tolerancia, combustivel a menos,
 *    avaria nova) NAO e quebra de protocolo. E dano, e o produto deliberadamente
 *    nao arbitra dano — ele registra a divergencia e deixa as duas lojas
 *    conversarem. Contar avaria como quebra transformaria o registro objetivo
 *    numa acusacao automatica, e a primeira loja a marcar um risco no termo
 *    aprenderia a nao marcar mais;
 *  - declaracao de entrega feita longe do patio tambem nao entra. Ela e
 *    RECUSADA na hora (`DROP_OFF_AWAY_FROM_YARD`), e ato recusado nao causou
 *    dano. Registrar tentativa recusada como quebra puniria falha de GPS, que
 *    e indistinguivel de ma-fe com os dados que existem.
 *
 * A janela e MOVEL, de 12 meses. Uma quebra por ano durante tres anos e um
 * problema diferente de tres quebras num mes, e so a janela movel separa os
 * dois: com contagem vitalicia, toda loja antiga viraria candidata a suspensao
 * por acumulo lento.
 */

import { type Instant, addMonths } from '../shared/clock.ts';
import { domainEvent } from '../shared/events.ts';
import { type Transition, transitioned, unchanged } from '../shared/transition.ts';
import type { BreachId, ClusterId, MemberId, StoreId } from '../shared/ids.ts';
import { type Store, StoreStatus } from '../network/store.ts';

export const BreachKind = {
  /**
   * O SLA de recall venceu com o carro ainda no patio do custodiante.
   *
   * Atribuida ao CUSTODIANTE. E a quebra central: o contrato da rede e "quatro
   * horas uteis", e ele foi descumprido com prazo correndo e relogio visivel.
   */
  RECALL_SLA: 'RECALL_SLA',
  /**
   * O custodiante disponibilizou o carro pelo escape operacional e a parte
   * interessada nao foi busca-lo no prazo.
   *
   * Atribuida a QUEM PEDIU O RECALL. E o espelho da anterior, e existe pelo
   * mesmo motivo que o escape existe: se so o custodiante responde por atraso,
   * o escape vira jeito de a interessada travar o carro de graca no patio
   * alheio, ja fora do prazo de quem o guarda.
   */
  PICKUP_NOT_COLLECTED: 'PICKUP_NOT_COLLECTED',
  /**
   * A entrega foi declarada NO PATIO — coordenada conferida — e quem recebe nao
   * deu o aceite no prazo.
   *
   * Atribuida a QUEM RECEBE. So e atribuivel porque a coordenada foi conferida
   * contra o patio de destino: e ela que desloca o onus. Sem a conferencia,
   * "declarei que deixei" contra "nao chegou" seria palavra contra palavra, e
   * nenhuma quebra poderia ser imputada a ninguem.
   */
  DROPOFF_NOT_ACKNOWLEDGED: 'DROPOFF_NOT_ACKNOWLEDGED',
  /**
   * O carro saiu com termo assinado e ficou em transito muito alem do plausivel,
   * sem declaracao de entrega nem cancelamento.
   *
   * Atribuida a LOJA DE ORIGEM, que e quem tirou o carro do patio e, ate o
   * aceite, continua respondendo por ele.
   */
  TRANSFER_ABANDONED: 'TRANSFER_ABANDONED',
} as const;
export type BreachKind = (typeof BreachKind)[keyof typeof BreachKind];

export type Breach = {
  readonly id: BreachId;
  readonly clusterId: ClusterId;
  /** O patio que quebrou. A sancao de conduta e do patio, nao da empresa. */
  readonly storeId: StoreId;
  /** A empresa dele, para a governanca enxergar o grupo sem uma segunda consulta. */
  readonly memberId: MemberId;
  readonly kind: BreachKind;
  readonly occurredAt: Instant;
  /** O agregado que produziu o fato: o recall ou o termo de custodia. */
  readonly evidenceId: string;
  /** Por quanto tempo o prazo foi estourado. Zero quando nao se aplica. */
  readonly overdueMinutes: number;
};

export type ConductPolicy = {
  /** Meses da janela movel. */
  readonly windowMonths: number;
  /** Quebras na janela que suspendem o patio. */
  readonly breachesToSuspend: number;
  /**
   * Horas UTEIS que a interessada tem para buscar o carro disponibilizado,
   * contadas do aviso de "pronto para retirada".
   *
   * Generoso perto das 4 horas do custodiante: quem vai buscar precisa encaixar
   * o deslocamento na propria operacao, e o carro ja esta seguro no patio de
   * quem o guarda. O prazo existe para haver um limite, nao para ser apertado.
   */
  readonly pickupGraceBusinessHours: number;
  /**
   * Horas UTEIS para dar o aceite de uma entrega declarada no patio.
   *
   * Curto: o carro esta fisicamente la, e enquanto nao houver aceite a
   * responsabilidade civil segue com quem entregou. Cada hora de silencio e
   * risco de graca as custas do outro.
   */
  readonly acceptanceGraceBusinessHours: number;
  /** Horas UTEIS em transito antes de o termo ser considerado abandonado. */
  readonly transitGraceBusinessHours: number;
};

export const DEFAULT_CONDUCT_POLICY: ConductPolicy = {
  windowMonths: 12,
  breachesToSuspend: 3,
  pickupGraceBusinessHours: 8,
  acceptanceGraceBusinessHours: 4,
  transitGraceBusinessHours: 24,
};

/**
 * Identidade deterministica: uma quebra por (especie, agregado).
 *
 * Nao e detalhe de persistencia, e a regra que torna a deteccao segura. O
 * varredor roda a cada minuto sobre os mesmos recalls e termos vencidos; sem id
 * estavel, o mesmo atraso viraria sessenta quebras por hora e suspenderia a
 * rede inteira antes do almoco.
 */
export function breachIdFor(kind: BreachKind, evidenceId: string): BreachId {
  return `brc_${kind.toLowerCase()}_${evidenceId}` as BreachId;
}

// ---------------------------------------------------------------------------
// Apuracao
// ---------------------------------------------------------------------------

/** Inicio da janela movel que termina agora. */
export function windowStart(now: Instant, policy: ConductPolicy = DEFAULT_CONDUCT_POLICY): Instant {
  return addMonths(now, -policy.windowMonths);
}

export function breachesInWindow(
  breaches: readonly Breach[],
  now: Instant,
  policy: ConductPolicy = DEFAULT_CONDUCT_POLICY,
): Breach[] {
  const inicio = windowStart(now, policy);
  return breaches
    .filter((breach) => breach.occurredAt > inicio && breach.occurredAt <= now)
    .sort((a, b) => a.occurredAt - b.occurredAt);
}

export type ConductRecord = {
  readonly storeId: StoreId;
  readonly withinWindow: number;
  readonly threshold: number;
  readonly reachedThreshold: boolean;
  /** Quando a mais antiga da janela sai dela — e a contagem alivia. */
  readonly oldestExpiresAt: Instant | null;
  readonly breaches: readonly Breach[];
};

export function conductRecord(
  storeId: StoreId,
  breaches: readonly Breach[],
  now: Instant,
  policy: ConductPolicy = DEFAULT_CONDUCT_POLICY,
): ConductRecord {
  const naJanela = breachesInWindow(breaches, now, policy);
  const maisAntiga = naJanela[0];

  return {
    storeId,
    withinWindow: naJanela.length,
    threshold: policy.breachesToSuspend,
    reachedThreshold: naJanela.length >= policy.breachesToSuspend,
    oldestExpiresAt:
      maisAntiga === undefined ? null : addMonths(maisAntiga.occurredAt, policy.windowMonths),
    breaches: naJanela,
  };
}

// ---------------------------------------------------------------------------
// Sancao
// ---------------------------------------------------------------------------

/**
 * Suspende o PATIO por conduta.
 *
 * Do patio, e nao da empresa: quem quebrou o protocolo foi este patio, e
 * derrubar a matriz porque a filial atrasou tres entregas puniria quem nao fez
 * nada. Inadimplencia e o caso oposto — la o contrato e da empresa, e a
 * suspensao alcanca todos os patios (`suspendForArrears`).
 *
 * Como em toda suspensao nesta rede, a custodia em curso sobrevive: o carro de
 * terceiro no patio suspenso continua podendo voltar para a dona. Transformar o
 * carro em refem da sancao puniria quem nao errou.
 */
export function suspendForConduct(
  store: Store,
  record: ConductRecord,
  now: Instant,
): Transition<Store> {
  if (store.status !== StoreStatus.ACTIVE) return unchanged(store);
  if (!record.reachedThreshold) return unchanged(store);

  return transitioned({ ...store, status: StoreStatus.SUSPENDED }, [
    domainEvent('conduct.store_suspended', store.id, now, {
      clusterId: store.clusterId,
      memberId: store.memberId,
      tradeName: store.profile.tradeName,
      breaches: record.withinWindow,
      threshold: record.threshold,
      kinds: record.breaches.map((breach) => breach.kind),
    }),
  ]);
}

/**
 * Reabre o patio quando a janela movel alivia.
 *
 * A reabertura e automatica de proposito. A sancao e por um numero medido; no
 * dia em que o numero deixa de existir, mante-la exigiria que alguem decidisse
 * mante-la — e essa decisao nao esta em lugar nenhum das regras que a praca
 * combinou. Punicao que depende de alguem lembrar de tirar vira permanente.
 *
 * Reincidencia nao fica impune por causa disso: ela e contada em separado, e e
 * ela que abre a mocao de desligamento.
 */
export function reopenAfterWindow(
  store: Store,
  record: ConductRecord,
  now: Instant,
): Transition<Store> {
  if (store.status !== StoreStatus.SUSPENDED) return unchanged(store);
  if (record.reachedThreshold) return unchanged(store);

  return transitioned({ ...store, status: StoreStatus.ACTIVE }, [
    domainEvent('conduct.store_reopened', store.id, now, {
      clusterId: store.clusterId,
      memberId: store.memberId,
      tradeName: store.profile.tradeName,
      breachesRemaining: record.withinWindow,
    }),
  ]);
}

export function describeBreach(kind: BreachKind): string {
  switch (kind) {
    case BreachKind.RECALL_SLA:
      return 'nao devolveu o veiculo no prazo do recall';
    case BreachKind.PICKUP_NOT_COLLECTED:
      return 'nao retirou o veiculo disponibilizado';
    case BreachKind.DROPOFF_NOT_ACKNOWLEDGED:
      return 'nao deu aceite em entrega declarada no patio';
    case BreachKind.TRANSFER_ABANDONED:
      return 'deixou o veiculo em transito sem entrega nem cancelamento';
  }
}
