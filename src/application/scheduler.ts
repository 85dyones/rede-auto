/**
 * Varredor periodico.
 *
 * Tres coisas dependem apenas da passagem do tempo e precisam acontecer mesmo
 * sem ninguem mexer no sistema:
 *   - a trava que venceu (o carro voltou a ficar disponivel para a rede);
 *   - o SLA de recall que estourou;
 *   - a mensalidade do ciclo, e a suspensao de quem passou dos 30 dias.
 *
 * As duas primeiras sao avisos: a leitura de qualquer veiculo ja reconcilia a
 * trava sozinha, entao ali o varredor garante PONTUALIDADE, nao correcao.
 *
 * O faturamento e diferente, e vale dizer por que nao e um problema: nada mais
 * emite mensalidade, entao um varredor que nao roda deixa receita parada. Mas
 * `pendingBillingPeriods` recupera todos os ciclos vencidos de uma vez, e a
 * fatura recuperada vence a partir da emissao — a plataforma nao perde o mes, e
 * o lojista nao herda um atraso que a falha nao foi dele.
 */

import type { AppContext } from './context.ts';
import { sweepExpiredLocks } from './inventory-service.ts';
import { sweepRecallBreaches } from './custody-service.ts';
import { runBillingSweep } from './billing-service.ts';

export type SweepResult = {
  readonly expiredLocks: number;
  readonly breachedRecalls: number;
  readonly chargesIssued: number;
  readonly membersSuspended: number;
};

export async function runSweep(context: AppContext): Promise<SweepResult> {
  const expiredLocks = await sweepExpiredLocks(context);
  const breachedRecalls = await sweepRecallBreaches(context);

  // Por praca, como todo o resto: nao existe operacao que atravesse a
  // fronteira, faturamento inclusive.
  let chargesIssued = 0;
  let membersSuspended = 0;
  for (const cluster of await context.repos.clusters.all()) {
    const billing = await runBillingSweep(context, cluster.id);
    chargesIssued += billing.issued;
    membersSuspended += billing.suspended;
  }

  return { expiredLocks, breachedRecalls, chargesIssued, membersSuspended };
}

export type Sweeper = { stop(): void };

export function startSweeper(
  context: AppContext,
  intervalMs: number,
  onError: (error: unknown) => void = (error) => console.error('[sweeper]', error),
): Sweeper {
  let running = false;

  const tick = async (): Promise<void> => {
    // Uma varredura lenta nao pode se sobrepor a proxima e duplicar trabalho.
    if (running) return;
    running = true;
    try {
      await runSweep(context);
    } catch (error) {
      onError(error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  // Nao segura o processo aberto: o varredor acompanha o servidor, nao o contrario.
  timer.unref();

  return { stop: () => clearInterval(timer) };
}
