import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_EXIT_POLICY,
  type ExitPendencies,
  completeExit,
  exitReadiness,
  giveExitNotice,
  withdrawExitNotice,
} from './exit.ts';
import { MemberStatus, memberInGoodStanding } from './member.ts';
import { StoreStatus } from './store.ts';
import { DAY } from '../shared/clock.ts';
import { unwrap } from '../shared/result.ts';
import { buildMemberWithStore } from '../../testing/builders.ts';

const NOW = Date.parse('2026-08-24T13:00:00Z');
const PRAZO = DEFAULT_EXIT_POLICY.noticeDays * DAY;

const LIMPO: ExitPendencies = {
  holdingOthersVehicles: 0,
  vehiclesHeldByOthers: 0,
  openLocks: 0,
  openDeals: 0,
  outstandingChargeCents: 0,
};

const { member: empresa, store: patio } = buildMemberWithStore();

const avisou = (at = NOW) => unwrap(giveExitNotice(empresa, at)).state;

describe('aviso de saida', () => {
  test('avisar poe a empresa em LEAVING e guarda a data', () => {
    const saindo = avisou();
    assert.equal(saindo.status, MemberStatus.LEAVING);
    assert.equal(saindo.exitNoticeAt, NOW);
  });

  test('LEAVING ja impede exposicao nova, sem regra nova em cada lugar', () => {
    // `memberInGoodStanding` e por onde `canTransact` passa. Entao trava
    // comercial, apadrinhamento e endosso param sozinhos — e check-in,
    // devolucao e liquidacao, que nao passam por ali, seguem funcionando.
    assert.equal(memberInGoodStanding(avisou()), false);
  });

  test('avisar duas vezes e bloqueado', () => {
    const result = giveExitNotice(avisou(), NOW + DAY);
    assert.equal(result.ok === false && result.error.code, 'EXIT_NOTICE_ALREADY_GIVEN');
  });

  test('quem ja saiu nao avisa saida', () => {
    const result = giveExitNotice({ ...empresa, status: MemberStatus.EXITED }, NOW);
    assert.equal(result.ok === false && result.error.code, 'MEMBER_ALREADY_EXITED');
  });

  test('empresa SUSPENSA pode avisar saida', () => {
    // Impedir isso faria da suspensao uma armadilha: a loja ficaria presa a uma
    // rede em que nao opera, acumulando mensalidade. Ela ainda vai ter de
    // quitar para sair — a comporta de estado nao abre com cobranca aberta.
    const suspensa = { ...empresa, status: MemberStatus.SUSPENDED };
    assert.equal(unwrap(giveExitNotice(suspensa, NOW)).state.status, MemberStatus.LEAVING);
  });

  test('desistir volta para ACTIVE e apaga o aviso', () => {
    const voltou = unwrap(withdrawExitNotice(avisou(), NOW + DAY)).state;
    assert.equal(voltou.status, MemberStatus.ACTIVE);
    assert.equal(voltou.exitNoticeAt, null);
  });

  test('quem nao avisou nao desiste', () => {
    const result = withdrawExitNotice(empresa, NOW);
    assert.equal(result.ok === false && result.error.code, 'NO_EXIT_NOTICE');
  });
});

describe('as duas comportas', () => {
  test('sem aviso, nada feito', () => {
    const readiness = exitReadiness(empresa, LIMPO, NOW);
    assert.equal(readiness.clear, false);
    assert.deepEqual(readiness.blockers, ['AVISO_NAO_DADO']);
  });

  test('aviso em curso segura, mesmo com tudo limpo', () => {
    const readiness = exitReadiness(avisou(), LIMPO, NOW + 10 * DAY);
    assert.deepEqual(readiness.blockers, ['AVISO_EM_CURSO']);
    assert.equal(readiness.noticePeriodEndsAt, NOW + PRAZO);
  });

  test('prazo vencido e tudo limpo: sai', () => {
    const readiness = exitReadiness(avisou(), LIMPO, NOW + PRAZO);
    assert.equal(readiness.clear, true);
    assert.equal(readiness.blockers.length, 0);
  });

  test('prazo vencido NAO basta: carro de terceiro no patio segura', () => {
    // A comporta de estado e a que importa. Depois de EXITED nao ha mais recall
    // a pedir nem prazo a cobrar — o carro ficaria sem contraparte.
    const readiness = exitReadiness(
      avisou(),
      { ...LIMPO, holdingOthersVehicles: 1 },
      NOW + 365 * DAY,
    );
    assert.equal(readiness.clear, false);
    assert.deepEqual(readiness.blockers, ['CUSTODIA_DE_TERCEIROS']);
  });

  test('carro dela em patio alheio segura igualmente', () => {
    // Simetrico de proposito: depois da saida, quem esta com o carro dela
    // tambem fica sem a quem devolver.
    const readiness = exitReadiness(
      avisou(),
      { ...LIMPO, vehiclesHeldByOthers: 2 },
      NOW + 365 * DAY,
    );
    assert.deepEqual(readiness.blockers, ['VEICULOS_EM_PATIO_ALHEIO']);
  });

  test('trava, negociacao e cobranca tambem seguram', () => {
    const readiness = exitReadiness(
      avisou(),
      { ...LIMPO, openLocks: 1, openDeals: 1, outstandingChargeCents: 59_900 },
      NOW + 365 * DAY,
    );
    assert.deepEqual(readiness.blockers, [
      'TRAVAS_ABERTAS',
      'NEGOCIACOES_ABERTAS',
      'COBRANCAS_EM_ABERTO',
    ]);
  });

  test('a lista diz TUDO o que falta, nao so a primeira pendencia', () => {
    // "Voce nao pode sair" sem o motivo transformaria a saida num muro. E a
    // mesma lista que a tela mostra como checklist.
    const readiness = exitReadiness(
      empresa,
      { ...LIMPO, holdingOthersVehicles: 1, openDeals: 1 },
      NOW,
    );
    assert.equal(readiness.blockers.length, 3);
  });
});

describe('conclusao', () => {
  test('a empresa e todos os patios dela saem juntos', () => {
    const readiness = exitReadiness(avisou(), LIMPO, NOW + PRAZO);
    const { member, stores } = unwrap(completeExit(avisou(), [patio], readiness));

    assert.equal(member.status, MemberStatus.EXITED);
    assert.equal(stores[0]?.status, StoreStatus.EXITED);
  });

  test('com pendencia, a conclusao e recusada e diz quais', () => {
    const readiness = exitReadiness(avisou(), { ...LIMPO, openLocks: 1 }, NOW + PRAZO);
    const result = completeExit(avisou(), [patio], readiness);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'EXIT_NOT_CLEAR');
    assert.deepEqual(
      result.ok === false && result.error.details?.['blockers'],
      ['TRAVAS_ABERTAS'],
    );
  });

  test('quem nao avisou nao e concluido, mesmo com tudo limpo', () => {
    const readiness = exitReadiness({ ...empresa, exitNoticeAt: NOW }, LIMPO, NOW + PRAZO);
    const result = completeExit(empresa, [patio], readiness);

    assert.equal(result.ok === false && result.error.code, 'NO_EXIT_NOTICE');
  });
});
