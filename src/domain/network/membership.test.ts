import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_GOVERNANCE_POLICY,
  MembershipStatus,
  VoteDecision,
  admitApprovedStore,
  castVote,
  openApplication,
  rejectionThreshold,
  tally,
  withdrawApplication,
  type MembershipApplication,
} from './membership.ts';
import { StoreKind, StoreStatus, UserRole, parseStoreProfile } from './store.ts';
import { asApplicationId, asStoreId } from '../shared/ids.ts';
import { unwrap } from '../shared/result.ts';
import { buildFoundingNetwork, buildStoreProfile, buildUser } from '../../testing/builders.ts';

const network = buildFoundingNetwork(6);
const APPLICATION_ID = asApplicationId('app_0001');
const NOW = Date.parse('2026-08-24T13:00:00Z');

/** Candidata apresentada pelo fundador 0; fundadores 1..5 podem votar. */
function pendingApplication(): MembershipApplication {
  return unwrap(
    openApplication({
      id: APPLICATION_ID,
      candidate: buildStoreProfile({ tradeName: 'Nova Garagem', cnpj: '02558157000162' }),
      sponsor: network.founderAt(0),
      now: NOW,
    }),
  ).state;
}

/** Aplica uma sequencia de votos de fundadores (por indice), parando no primeiro erro. */
function voteSequence(
  application: MembershipApplication,
  votes: ReadonlyArray<readonly [number, 'APPROVE' | 'REJECT']>,
): MembershipApplication {
  let current = application;
  for (const [founderIndex, decision] of votes) {
    current = unwrap(
      castVote({
        application: current,
        founderStore: network.founderAt(founderIndex),
        user: network.principalAt(founderIndex),
        decision,
        now: NOW,
      }),
    ).state;
  }
  return current;
}

describe('quorum de credenciamento (3 de 6 fundadores)', () => {
  test('a candidatura nasce pendente, sem votos', () => {
    const application = pendingApplication();
    assert.equal(application.status, MembershipStatus.PENDING);
    assert.equal(application.votes.length, 0);
    assert.equal(tally(application).approvalsStillNeeded, 3);
  });

  test('dois avais ainda nao credenciam', () => {
    const application = voteSequence(pendingApplication(), [
      [1, 'APPROVE'],
      [2, 'APPROVE'],
    ]);
    assert.equal(application.status, MembershipStatus.PENDING);
    assert.equal(tally(application).approvals, 2);
    assert.equal(tally(application).approvalsStillNeeded, 1);
  });

  test('o terceiro aval aprova na hora, sem esperar os demais fundadores', () => {
    const application = voteSequence(pendingApplication(), [
      [1, 'APPROVE'],
      [2, 'APPROVE'],
      [3, 'APPROVE'],
    ]);
    assert.equal(application.status, MembershipStatus.APPROVED);
    assert.equal(application.decidedAt, NOW);
    // Tres fundadores decidem: nao ha razao para bloquear a entrada aguardando
    // os outros tres votarem.
    assert.equal(application.votes.length, 3);
  });

  test('quatro votos contrarios reprovam, porque 3 avais viram impossiveis', () => {
    assert.equal(rejectionThreshold(DEFAULT_GOVERNANCE_POLICY), 4);
    const application = voteSequence(pendingApplication(), [
      [1, 'REJECT'],
      [2, 'REJECT'],
      [3, 'REJECT'],
    ]);
    assert.equal(application.status, MembershipStatus.PENDING, 'com 3 contra ainda restam 3 a favor possiveis');

    const rejected = voteSequence(application, [[4, 'REJECT']]);
    assert.equal(rejected.status, MembershipStatus.REJECTED);
  });

  test('emite evento de aprovacao listando quem avalizou', () => {
    const twoApprovals = voteSequence(pendingApplication(), [
      [1, 'APPROVE'],
      [2, 'APPROVE'],
    ]);
    const third = unwrap(
      castVote({
        application: twoApprovals,
        founderStore: network.founderAt(3),
        user: network.principalAt(3),
        decision: VoteDecision.APPROVE,
        now: NOW,
      }),
    );

    const approved = third.events.find((e) => e.type === 'membership.application_approved');
    assert.ok(approved, 'evento de aprovacao deve ser emitido');
    assert.deepEqual(approved.payload['approvedBy'], ['str_f2', 'str_f3', 'str_f4']);
  });
});

describe('regras de voto', () => {
  test('um fundador pode trocar o proprio voto enquanto a decisao nao saiu', () => {
    const rejectedByOne = voteSequence(pendingApplication(), [[1, 'REJECT']]);
    assert.equal(tally(rejectedByOne).rejections, 1);

    const reconsidered = voteSequence(rejectedByOne, [[1, 'APPROVE']]);
    assert.equal(reconsidered.votes.length, 1, 'o voto e substituido, nao somado');
    assert.equal(tally(reconsidered).approvals, 1);
    assert.equal(tally(reconsidered).rejections, 0);
  });

  test('votar duas vezes nao conta como dois avais', () => {
    const application = voteSequence(pendingApplication(), [
      [1, 'APPROVE'],
      [1, 'APPROVE'],
      [2, 'APPROVE'],
    ]);
    assert.equal(application.status, MembershipStatus.PENDING);
    assert.equal(tally(application).approvals, 2);
  });

  test('a loja padrinho nao vota na propria indicacao', () => {
    const result = castVote({
      application: pendingApplication(),
      founderStore: network.founderAt(0),
      user: network.principalAt(0),
      decision: VoteDecision.APPROVE,
      now: NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'SPONSOR_CANNOT_VOTE');
  });

  test('loja nao fundadora nao vota', () => {
    const member = { ...network.founderAt(1), kind: StoreKind.MEMBER };
    const result = castVote({
      application: pendingApplication(),
      founderStore: member,
      user: network.principalAt(1),
      decision: VoteDecision.APPROVE,
      now: NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'NOT_A_VOTING_FOUNDER');
  });

  test('vendedor de loja fundadora nao vota — o aval e do titular', () => {
    const salesperson = buildUser(network.founderAt(1).id, { role: UserRole.SALESPERSON });
    const result = castVote({
      application: pendingApplication(),
      founderStore: network.founderAt(1),
      user: salesperson,
      decision: VoteDecision.APPROVE,
      now: NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'NOT_A_VOTING_FOUNDER');
  });

  test('fundadora suspensa perde o direito de voto', () => {
    const suspended = { ...network.founderAt(1), status: StoreStatus.SUSPENDED };
    const result = castVote({
      application: pendingApplication(),
      founderStore: suspended,
      user: network.principalAt(1),
      decision: VoteDecision.APPROVE,
      now: NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'NOT_A_VOTING_FOUNDER');
  });

  test('candidatura ja decidida nao aceita mais votos', () => {
    const approved = voteSequence(pendingApplication(), [
      [1, 'APPROVE'],
      [2, 'APPROVE'],
      [3, 'APPROVE'],
    ]);
    const late = castVote({
      application: approved,
      founderStore: network.founderAt(4),
      user: network.principalAt(4),
      decision: VoteDecision.REJECT,
      now: NOW,
    });
    assert.equal(late.ok, false);
    assert.equal(late.ok === false && late.error.code, 'APPLICATION_ALREADY_DECIDED');
  });
});

describe('retirada e credenciamento efetivo', () => {
  test('so o padrinho retira a candidatura', () => {
    const application = pendingApplication();
    const byOther = withdrawApplication({
      application,
      requestedByStoreId: network.founderAt(2).id,
      now: NOW,
    });
    assert.equal(byOther.ok, false);
    assert.equal(byOther.ok === false && byOther.error.code, 'NOT_THE_SPONSOR');

    const bySponsor = unwrap(
      withdrawApplication({ application, requestedByStoreId: network.founderAt(0).id, now: NOW }),
    ).state;
    assert.equal(bySponsor.status, MembershipStatus.WITHDRAWN);
  });

  test('credenciamento cria loja MEMBER (sem voto) vinculada ao padrinho', () => {
    const approved = voteSequence(pendingApplication(), [
      [1, 'APPROVE'],
      [2, 'APPROVE'],
      [3, 'APPROVE'],
    ]);
    const { store } = unwrap(admitApprovedStore(approved, asStoreId('str_new'), NOW));

    assert.equal(store.kind, StoreKind.MEMBER, 'quem entra depois nao vira fundador');
    assert.equal(store.status, StoreStatus.ACTIVE);
    assert.equal(store.sponsorStoreId, network.founderAt(0).id);
    assert.equal(store.profile.tradeName, 'Nova Garagem');
  });

  test('candidatura nao aprovada nao vira loja', () => {
    const result = admitApprovedStore(pendingApplication(), asStoreId('str_new'), NOW);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'APPLICATION_NOT_APPROVED');
  });

  test('credenciar duas vezes a mesma candidatura e bloqueado', () => {
    const approved = voteSequence(pendingApplication(), [
      [1, 'APPROVE'],
      [2, 'APPROVE'],
      [3, 'APPROVE'],
    ]);
    const first = unwrap(admitApprovedStore(approved, asStoreId('str_new'), NOW));
    const second = admitApprovedStore(first.application, asStoreId('str_other'), NOW);
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.error.code, 'STORE_ALREADY_ADMITTED');
  });
});

describe('ficha cadastral da candidata', () => {
  test('valida CNPJ, UF, telefone e e-mail antes de gastar voto de fundador', () => {
    const valid = parseStoreProfile({
      legalName: 'Nova Garagem Veiculos LTDA',
      tradeName: 'Nova Garagem',
      cnpj: '11.222.333/0001-81',
      city: 'Sorocaba',
      state: 'sp',
      phone: '(15) 99876-5432',
      email: 'Contato@NovaGaragem.com.BR',
      responsibleName: 'Joao Pereira',
    });
    const profile = unwrap(valid);
    assert.equal(profile.cnpj, '11222333000181');
    assert.equal(profile.state, 'SP');
    assert.equal(profile.phone, '15998765432');
    assert.equal(profile.email, 'contato@novagaragem.com.br');
  });

  test('reporta o primeiro erro e lista os demais na mesma resposta', () => {
    const result = parseStoreProfile({
      legalName: 'X',
      tradeName: 'Nova Garagem',
      cnpj: '00000000000000',
      city: 'Sorocaba',
      state: 'ZZ',
      phone: '123',
      email: 'nao-e-email',
      responsibleName: 'Joao Pereira',
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    const others = result.error.details?.['outrosErros'] as unknown[];
    assert.ok(Array.isArray(others) && others.length >= 3, 'o formulario recebe todos os erros de uma vez');
  });
});
