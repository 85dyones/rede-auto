import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_GOVERNANCE_POLICY,
  MembershipStatus,
  admitApprovedStore,
  admitCandidate,
  endorse,
  endorsementTally,
  openApplication,
  rejectCandidate,
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

/** Endossos de fundadoras, por indice. */
function endorsedBy(
  application: MembershipApplication,
  indices: readonly number[],
): MembershipApplication {
  let current = application;
  for (const i of indices) {
    current = unwrap(
      endorse({
        application: current,
        founderStore: network.founderAt(i),
        user: network.principalAt(i),
        now: NOW,
      }),
    ).state;
  }
  return current;
}

const OPERADOR = 'Operacao rede-auto';

/** Caminho feliz completo: dois endossos e a plataforma admite. */
function admitida(): MembershipApplication {
  const comEndossos = endorsedBy(pendingApplication(), [1, 2]);
  return unwrap(admitCandidate({ application: comEndossos, operator: OPERADOR, now: NOW })).state;
}

describe('endosso: sinal de qualidade, nao voto', () => {
  test('endossar NAO credencia — a candidatura segue pendente', () => {
    // E a diferenca inteira entre endosso e quorum. Se tres endossos
    // credenciassem sozinhos, as fundadoras voltariam a ter poder de veto pela
    // porta dos fundos: bastaria nao endossar ninguem.
    const comTodos = endorsedBy(pendingApplication(), [1, 2, 3, 4, 5]);

    assert.equal(comTodos.status, MembershipStatus.PENDING);
    assert.equal(comTodos.endorsements.length, 5);
    assert.equal(comTodos.decidedAt, null);
  });

  test('nao existe endosso contrario', () => {
    // Quem tem restricao simplesmente nao endossa. Modelar rejeicao devolveria
    // o veto — por isso `endorse` nao tem parametro de decisao.
    const tally = endorsementTally(pendingApplication());
    assert.equal(tally.endorsements, 0);
    assert.equal(tally.meetsRecommendation, false);
  });

  test('a padrinho nao endossa a propria indicacao', () => {
    const result = endorse({
      application: pendingApplication(),
      founderStore: network.founderAt(0),
      user: network.principalAt(0),
      now: NOW,
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'SPONSOR_CANNOT_ENDORSE');
  });

  test('endossar de novo atualiza a nota em vez de somar', () => {
    const uma = endorsedBy(pendingApplication(), [1]);
    const denovo = unwrap(
      endorse({
        application: uma,
        founderStore: network.founderAt(1),
        user: network.principalAt(1),
        note: 'Conversei com o titular; segue valendo.',
        now: NOW,
      }),
    ).state;

    assert.equal(denovo.endorsements.length, 1, 'continua sendo uma fundadora');
    assert.equal(denovo.endorsements[0]?.note, 'Conversei com o titular; segue valendo.');
  });

  test('loja que nao e fundadora ativa nao endossa', () => {
    const suspensa = { ...network.founderAt(1), status: StoreStatus.SUSPENDED };
    const result = endorse({
      application: pendingApplication(),
      founderStore: suspensa,
      user: network.principalAt(1),
      now: NOW,
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'NOT_AN_ENDORSING_FOUNDER');
  });

  test('vendedor nao endossa, mesmo em loja fundadora', () => {
    const vendedor = buildUser(network.founderAt(1).id, { role: UserRole.SALESPERSON });
    const result = endorse({
      application: pendingApplication(),
      founderStore: network.founderAt(1),
      user: vendedor,
      now: NOW,
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'NOT_AN_ENDORSING_FOUNDER');
  });

  test('a apuracao tira a padrinho do denominador', () => {
    // Ela nao pode endossar, entao contar com ela deixaria o numero sempre
    // inalcancavel por um.
    const tally = endorsementTally(pendingApplication());
    assert.equal(tally.foundersYetToEndorse, DEFAULT_GOVERNANCE_POLICY.founderCount - 1);
  });
});

describe('a decisao e da plataforma', () => {
  test('com o endosso recomendado, a plataforma admite', () => {
    const decidida = admitida();

    assert.equal(decidida.status, MembershipStatus.APPROVED);
    assert.equal(decidida.decidedBy, OPERADOR);
    assert.equal(decidida.endorsementOverride, null, 'nao houve excecao');
  });

  test('abaixo do recomendado exige justificativa registrada', () => {
    // A plataforma PODE admitir sem endosso — mas nao em silencio. Sem isso o
    // endosso viraria enfeite.
    const semEndosso = pendingApplication();
    const result = admitCandidate({ application: semEndosso, operator: OPERADOR, now: NOW });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'ENDORSEMENT_BELOW_RECOMMENDED');
  });

  test('a excecao fica registrada na candidatura', () => {
    const justificativa = 'Loja do mesmo grupo de uma fundadora; operacao ja conhecida.';
    const decidida = unwrap(
      admitCandidate({
        application: pendingApplication(),
        operator: OPERADOR,
        endorsementOverride: justificativa,
        now: NOW,
      }),
    ).state;

    assert.equal(decidida.status, MembershipStatus.APPROVED);
    assert.equal(decidida.endorsementOverride, justificativa);
  });

  test('recusar exige motivo: quem indicou precisa saber o que dizer', () => {
    const semMotivo = rejectCandidate({
      application: endorsedBy(pendingApplication(), [1, 2]),
      operator: OPERADOR,
      now: NOW,
    });
    assert.equal(semMotivo.ok, false);
    assert.equal(semMotivo.ok === false && semMotivo.error.code, 'REJECTION_NOTE_REQUIRED');

    const comMotivo = unwrap(
      rejectCandidate({
        application: endorsedBy(pendingApplication(), [1, 2]),
        operator: OPERADOR,
        note: 'Pendencia cadastral no CNPJ da candidata.',
        now: NOW,
      }),
    ).state;
    assert.equal(comMotivo.status, MembershipStatus.REJECTED);
    assert.equal(comMotivo.decisionNote, 'Pendencia cadastral no CNPJ da candidata.');
  });

  test('a plataforma pode recusar candidata com endosso de todas', () => {
    // O endosso informa; nao obriga.
    const todas = endorsedBy(pendingApplication(), [1, 2, 3, 4, 5]);
    const recusada = unwrap(
      rejectCandidate({
        application: todas,
        operator: OPERADOR,
        note: 'Restricao documental que as fundadoras nao tinham como ver.',
        now: NOW,
      }),
    ).state;

    assert.equal(recusada.status, MembershipStatus.REJECTED);
  });

  test('candidatura ja decidida nao aceita novo endosso nem nova decisao', () => {
    const decidida = admitida();

    const tardio = endorse({
      application: decidida,
      founderStore: network.founderAt(3),
      user: network.principalAt(3),
      now: NOW,
    });
    assert.equal(tardio.ok === false && tardio.error.code, 'APPLICATION_ALREADY_DECIDED');

    const denovo = admitCandidate({ application: decidida, operator: OPERADOR, now: NOW });
    assert.equal(denovo.ok === false && denovo.error.code, 'APPLICATION_ALREADY_DECIDED');
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
    const { store } = unwrap(admitApprovedStore(admitida(), asStoreId('str_new'), NOW));

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
    const first = unwrap(admitApprovedStore(admitida(), asStoreId('str_new'), NOW));
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
