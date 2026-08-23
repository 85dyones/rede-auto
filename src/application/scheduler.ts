/**
 * Varredor periodico.
 *
 * Duas coisas dependem apenas da passagem do tempo e precisam ser anunciadas
 * mesmo sem ninguem mexer no sistema:
 *   - a trava que venceu (o carro voltou a ficar disponivel para a rede);
 *   - o SLA de recall que estourou.
 *
 * A leitura de qualquer veiculo ja reconcilia a trava sozinha, entao o varredor
 * nao e o que garante CORRECAO — ele e o que garante PONTUALIDADE do aviso. Por
 * isso ele pode falhar, atrasar ou nem rodar sem produzir estado invalido.
 */

import type { AppContext } from './context.ts';
import { sweepExpiredLocks } from './inventory-service.ts';
import { sweepRecallBreaches } from './custody-service.ts';

export type SweepResult = {
  readonly expiredLocks: number;
  readonly breachedRecalls: number;
};

export async function runSweep(context: AppContext): Promise<SweepResult> {
  const expiredLocks = await sweepExpiredLocks(context);
  const breachedRecalls = await sweepRecallBreaches(context);
  return { expiredLocks, breachedRecalls };
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
