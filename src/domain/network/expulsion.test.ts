import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_EXPULSION_POLICY,
  MotionStatus,
  type ExpulsionGrounds,
  type ExpulsionMotion,
  executeExpulsion,
  lapseMotion,
  openExpulsionMotion,
  requiredSupport,
  supportExpulsion,
  supportTally,
  withdrawMotion,
} from './expulsion.ts';
import { MemberKind, MemberStatus } from './member.ts';
import { StoreStatus, UserRole } from './store.ts';
import { BreachKind } from '../conduct/breach.ts';
import { DAY } from '../shared/clock.ts';
import { asMotionId } from '../shared/ids.ts';
import { unwrap } from '../shared/result.ts';
import { buildFoundingNetwork, buildUser } from '../../testing/builders.ts';

const network = buildFoundingNetwork(6);
const NOW = Date.parse('2026-08-24T13:00:00Z');
const MOTION = asMotionId('mot_1');

/** A acusada e a fundadora 5; a proponente, a 0. */
const acusada = network.memberAt(5);

const REINCIDENTE: ExpulsionGrounds = {
  storeId: network.founderAt(5).id,
  conductSuspensions: 2,
  breachesInWindow: 3,
  kinds: [BreachKind.RECALL_SLA, BreachKind.DROPOFF_NOT_ACKNOWLEDGED],
  observedAt: NOW,
};

function motionAberta(grounds = REINCIDENTE): ExpulsionMotion {
  return unwrap(
    openExpulsionMotion({
      id: MOTION,
      accused: acusada,
      grounds,
      openedBy: network.memberAt(0),
      openedByStore: network.founderAt(0),
      user: network.principalAt(0),
      now: NOW,
    }),
  ).state;
}

function apoiadaPor(motion: ExpulsionMotion, indices: readonly number[]): ExpulsionMotion {
  let current = motion;
  for (const i of indices) {
    current = unwrap(
      supportExpulsion({
        motion: current,
        founder: network.memberAt(i),
        founderStore: network.founderAt(i),
        user: network.principalAt(i),
        now: NOW,
        founders: network.members,
      }),
    ).state;
  }
  return current;
}

describe('o fundamento: sair e probatorio, entrar e discricionario', () => {
  test('sem reincidencia registrada nao ha mocao', () => {
    // Esta e a guarda central. Sem ela o desligamento viraria o veto que a
    // admissao recusou — com a agravante de servir para remover quem esta
    // vendendo bem.
    const result = openExpulsionMotion({
      id: MOTION,
      accused: acusada,
      grounds: { ...REINCIDENTE, conductSuspensions: 1 },
      openedBy: network.memberAt(0),
      openedByStore: network.founderAt(0),
      user: network.principalAt(0),
      now: NOW,
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'NO_RECIDIVISM_ON_RECORD');
  });

  test('uma suspensao so nao basta: ela ja e a sancao das tres quebras', () => {
    // Abrir mocao na primeira suspensao puniria duas vezes o mesmo fato.
    const result = openExpulsionMotion({
      id: MOTION,
      accused: acusada,
      grounds: { ...REINCIDENTE, conductSuspensions: 0, breachesInWindow: 0 },
      openedBy: network.memberAt(0),
      openedByStore: network.founderAt(0),
      user: network.principalAt(0),
      now: NOW,
    });

    assert.equal(result.ok === false && result.error.code, 'NO_RECIDIVISM_ON_RECORD');
  });

  test('com reincidencia, a mocao abre', () => {
    const motion = motionAberta();
    assert.equal(motion.status, MotionStatus.OPEN);
    assert.equal(motion.memberId, acusada.id);
    assert.equal(motion.grounds.conductSuspensions, 2);
  });

  test('so fundadora em dia abre mocao', () => {
    const inadimplente = { ...network.memberAt(0), status: MemberStatus.SUSPENDED };
    const result = openExpulsionMotion({
      id: MOTION,
      accused: acusada,
      grounds: REINCIDENTE,
      openedBy: inadimplente,
      openedByStore: network.founderAt(0),
      user: network.principalAt(0),
      now: NOW,
    });

    assert.equal(result.ok === false && result.error.code, 'NOT_AN_ELIGIBLE_PROPONENT');
  });

  test('empresa membro, nao fundadora, nao abre mocao', () => {
    const membro = { ...network.memberAt(0), kind: MemberKind.MEMBER };
    const result = openExpulsionMotion({
      id: MOTION,
      accused: acusada,
      grounds: REINCIDENTE,
      openedBy: membro,
      openedByStore: network.founderAt(0),
      user: network.principalAt(0),
      now: NOW,
    });

    assert.equal(result.ok === false && result.error.code, 'NOT_AN_ELIGIBLE_PROPONENT');
  });

  test('vendedor nao assina mocao', () => {
    const vendedor = buildUser(network.founderAt(0).id, { role: UserRole.SALESPERSON });
    const result = openExpulsionMotion({
      id: MOTION,
      accused: acusada,
      grounds: REINCIDENTE,
      openedBy: network.memberAt(0),
      openedByStore: network.founderAt(0),
      user: vendedor,
      now: NOW,
    });

    assert.equal(result.ok === false && result.error.code, 'NOT_A_PRINCIPAL');
  });

  test('ninguem abre mocao contra si mesmo', () => {
    const result = openExpulsionMotion({
      id: MOTION,
      accused: network.memberAt(0),
      grounds: REINCIDENTE,
      openedBy: network.memberAt(0),
      openedByStore: network.founderAt(0),
      user: network.principalAt(0),
      now: NOW,
    });

    assert.equal(result.ok === false && result.error.code, 'CANNOT_EXPEL_SELF');
  });
});

describe('quorum: proporcional, e por isso diferente dos tres endossos', () => {
  test('dois tercos das elegiveis, com piso de duas', () => {
    // Piso de duas: em praca minuscula, dois tercos de uma elegivel daria 1, e
    // desligamento decidido por uma unica loja e o veto individual disfarcado.
    assert.equal(requiredSupport(5), 4);
    assert.equal(requiredSupport(9), 6);
    assert.equal(requiredSupport(2), 2);
    assert.equal(requiredSupport(1), 2, 'impossivel de atingir, e melhor assim');
  });

  test('a acusada sai do denominador e nao vota no proprio caso', () => {
    const tally = supportTally(motionAberta(), network.members);

    assert.equal(tally.required, requiredSupport(5), 'seis fundadoras, menos a acusada');
    assert.equal(tally.foundersYetToSupport, 5);
  });

  test('a acusada nao apoia a propria mocao', () => {
    const result = supportExpulsion({
      motion: motionAberta(),
      founder: acusada,
      founderStore: network.founderAt(5),
      user: network.principalAt(5),
      now: NOW,
      founders: network.members,
    });

    assert.equal(result.ok === false && result.error.code, 'ACCUSED_CANNOT_SUPPORT');
  });

  test('o apoio que fecha o quorum ja carrega a mocao', () => {
    const parcial = apoiadaPor(motionAberta(), [0, 1, 2]);
    assert.equal(parcial.status, MotionStatus.OPEN, 'tres de cinco ainda nao sao dois tercos');

    const carregada = apoiadaPor(parcial, [3]);
    assert.equal(carregada.status, MotionStatus.CARRIED);
    assert.equal(carregada.decidedAt, NOW);
  });

  test('apoiar de novo atualiza a nota em vez de somar', () => {
    // Sem isto, uma fundadora desligaria uma concorrente sozinha, apoiando
    // quatro vezes. E o mesmo cuidado do endosso.
    const uma = apoiadaPor(motionAberta(), [0]);
    const denovo = apoiadaPor(uma, [0]);

    assert.equal(denovo.supports.length, 1);
    assert.equal(denovo.status, MotionStatus.OPEN);
  });

  test('empresa inadimplente nao apoia', () => {
    const result = supportExpulsion({
      motion: motionAberta(),
      founder: { ...network.memberAt(1), status: MemberStatus.SUSPENDED },
      founderStore: network.founderAt(1),
      user: network.principalAt(1),
      now: NOW,
      founders: network.members,
    });

    assert.equal(result.ok === false && result.error.code, 'NOT_AN_ELIGIBLE_SUPPORTER');
  });

  test('nao ha voto CONTRA: o silencio ja e contra', () => {
    // `supportExpulsion` nao tem parametro de decisao. Registrar "sou contra"
    // nao acrescentaria informacao e tornaria visivel quem defendeu quem, que e
    // como se constroi retaliacao entre concorrentes.
    const motion = motionAberta();
    assert.equal('votes' in motion, false);
    assert.ok(motion.supports.every((s) => !('decision' in s)));
  });
});

describe('prazo: o desfecho por inercia e "fica"', () => {
  test('mocao sem quorum caduca no prazo', () => {
    // Se "sai" fosse o default do silencio, bastaria abrir mocoes e esperar.
    const parada = apoiadaPor(motionAberta(), [0, 1]);
    const vencida = unwrap(
      lapseMotion({ motion: parada, now: NOW + DEFAULT_EXPULSION_POLICY.windowDays * DAY }),
    ).state;

    assert.equal(vencida.status, MotionStatus.DISMISSED);
  });

  test('nao caduca antes do prazo', () => {
    const motion = motionAberta();
    const cedo = unwrap(lapseMotion({ motion, now: NOW + 20 * DAY }));
    assert.equal(cedo.events.length, 0);
    assert.equal(cedo.state.status, MotionStatus.OPEN);
  });

  test('mocao ja decidida nao caduca', () => {
    const carregada = apoiadaPor(motionAberta(), [0, 1, 2, 3]);
    const depois = unwrap(lapseMotion({ motion: carregada, now: NOW + 365 * DAY }));

    assert.equal(depois.state.status, MotionStatus.CARRIED);
    assert.equal(depois.events.length, 0);
  });

  test('so quem abriu retira a mocao', () => {
    const motion = motionAberta();
    const outra = withdrawMotion(motion, network.memberAt(2).id, NOW);
    assert.equal(outra.ok === false && outra.error.code, 'NOT_THE_PROPONENT');

    const propria = unwrap(withdrawMotion(motion, network.memberAt(0).id, NOW)).state;
    assert.equal(propria.status, MotionStatus.WITHDRAWN);
  });
});

describe('efeito do desligamento', () => {
  test('a empresa e todos os patios dela saem', () => {
    const carregada = apoiadaPor(motionAberta(), [0, 1, 2, 3]);
    const patios = [network.founderAt(5), { ...network.founderAt(5), id: network.founderAt(4).id }];

    const { member, stores } = unwrap(executeExpulsion(carregada, acusada, patios));

    assert.equal(member.status, MemberStatus.EXITED);
    assert.ok(stores.every((store) => store.status === StoreStatus.EXITED));
  });

  test('mocao nao aprovada nao desliga ninguem', () => {
    const result = executeExpulsion(motionAberta(), acusada, [network.founderAt(5)]);
    assert.equal(result.ok === false && result.error.code, 'MOTION_NOT_CARRIED');
  });

  test('a mocao nao desliga uma empresa que nao e a acusada', () => {
    const carregada = apoiadaPor(motionAberta(), [0, 1, 2, 3]);
    const result = executeExpulsion(carregada, network.memberAt(1), [network.founderAt(1)]);

    assert.equal(result.ok === false && result.error.code, 'MOTION_MEMBER_MISMATCH');
  });

  test('empresa ja desligada nao vira alvo de nova mocao', () => {
    const result = openExpulsionMotion({
      id: MOTION,
      accused: { ...acusada, status: MemberStatus.EXITED },
      grounds: REINCIDENTE,
      openedBy: network.memberAt(0),
      openedByStore: network.founderAt(0),
      user: network.principalAt(0),
      now: NOW,
    });

    assert.equal(result.ok === false && result.error.code, 'MEMBER_ALREADY_EXITED');
  });
});
