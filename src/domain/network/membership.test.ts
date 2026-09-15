import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_GOVERNANCE_POLICY,
  MembershipStatus,
  admitApprovedStore,
  endorse,
  endorsementTally,
  lapseApplication,
  openApplication,
  withdrawApplication,
  type MembershipApplication,
} from './membership.ts';
import { StoreKind, StoreStatus, UserRole, parseStoreProfile } from './store.ts';
import { asApplicationId, asClusterId, asStoreId } from '../shared/ids.ts';
import { unwrap } from '../shared/result.ts';
import {
  buildCluster,
  buildFoundingNetwork,
  buildStoreProfile,
  buildUser,
} from '../../testing/builders.ts';
import { DAY } from '../shared/clock.ts';

const network = buildFoundingNetwork(6);
const APPLICATION_ID = asApplicationId('app_0001');
const NOW = Date.parse('2026-08-24T13:00:00Z');

/** Praca com a janela de fundacao aberta. Quem for credenciado aqui e fundadora. */
const PRACA = buildCluster({ foundedAt: NOW - 10 * DAY, foundingWindowEndsAt: NOW + 30 * DAY });

/** A mesma praca depois de fechada a janela. Quem chega agora entra como membro. */
const PRACA_FECHADA = buildCluster({ foundedAt: NOW - 400 * DAY, foundingWindowEndsAt: NOW - DAY });

/** Candidata apresentada pela fundadora 0; fundadoras 1..5 podem endossar. */
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

/** Caminho feliz: tres endossos credenciam na hora. */
function admitida(): MembershipApplication {
  return endorsedBy(pendingApplication(), [1, 2, 3]);
}

describe('endosso: quem decide quem entra sao os membros', () => {
  test('o terceiro endosso ja credencia, sem passo intermediario', () => {
    const decidida = admitida();

    assert.equal(decidida.status, MembershipStatus.APPROVED);
    assert.equal(decidida.decidedAt, NOW);
    assert.equal(decidida.endorsements.length, 3);
  });

  test('dois endossos ainda nao credenciam', () => {
    const parcial = endorsedBy(pendingApplication(), [1, 2]);

    assert.equal(parcial.status, MembershipStatus.PENDING);
    assert.equal(endorsementTally(parcial, network.founders).stillNeeded, 1);
  });

  test('nao existe endosso contrario', () => {
    // Quem tem restricao simplesmente nao endossa. Modelar rejeicao daria a
    // cada fundadora um veto individual sobre concorrencia direta — por isso
    // `endorse` nao tem parametro de decisao e nao ha como escrever "sou contra".
    const tally = endorsementTally(pendingApplication(), network.founders);
    assert.equal(tally.endorsements, 0);
    assert.equal(tally.credentialed, false);
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
    // Sem isto, uma fundadora credenciaria sozinha endossando tres vezes.
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
    assert.equal(denovo.status, MembershipStatus.PENDING);
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

  test('a apuracao conta as fundadoras que existem, nao um numero declarado', () => {
    // Nada em GovernancePolicy diz quantas fundadoras ha — e de proposito: com
    // janela de fundacao, esse numero e resultado, nao parametro.
    const tally = endorsementTally(pendingApplication(), network.founders);

    // Seis fundadoras, menos a padrinho, que nao endossa a propria indicacao.
    assert.equal(tally.foundersYetToEndorse, 5);
    assert.equal(tally.reachable, true);
    assert.equal(
      'founderCount' in DEFAULT_GOVERNANCE_POLICY,
      false,
      'o numero de fundadoras nao volta a ser politica',
    );
  });

  test('quem ja endossou sai da conta de quem ainda pode endossar', () => {
    const tally = endorsementTally(endorsedBy(pendingApplication(), [1, 2]), network.founders);

    assert.equal(tally.endorsements, 2);
    assert.equal(tally.foundersYetToEndorse, 3, 'seis, menos a padrinho, menos as duas que ja deram');
  });

  test('loja que nao e fundadora nao entra na apuracao nem se for passada', () => {
    // O filtro espelha `canEndorseMembership`: se a apuracao usasse criterio
    // proprio, mostraria como disponivel quem `endorse` vai recusar.
    const comUmMembro = [
      ...network.founders,
      { ...network.founderAt(2), id: asStoreId('str_membro'), kind: StoreKind.MEMBER },
    ];
    assert.equal(
      endorsementTally(pendingApplication(), comUmMembro).foundersYetToEndorse,
      5,
      'membro nao endossa',
    );
  });

  test('fundadora de outra praca nao conta', () => {
    const comForasteira = [
      ...network.founders,
      { ...network.founderAt(2), id: asStoreId('str_ldb'), clusterId: asClusterId('clu_londrina') },
    ];
    assert.equal(
      endorsementTally(pendingApplication(), comForasteira).foundersYetToEndorse,
      5,
      'endosso e contado dentro de uma praca so',
    );
  });

  test('fundadora suspensa nao conta como endosso disponivel', () => {
    const comUmaSuspensa = network.founders.map((store, index) =>
      index === 5 ? { ...store, status: StoreStatus.SUSPENDED } : store,
    );
    const tally = endorsementTally(pendingApplication(), comUmaSuspensa);

    assert.equal(tally.foundersYetToEndorse, 4, 'nao adianta contar quem nao pode endossar');
    assert.equal(tally.reachable, true);
  });

  test('praca pequena demais deixa a candidatura inalcancavel — e diz isso na hora', () => {
    // Tres fundadoras, e uma delas e a padrinho: sobram duas para dar tres
    // endossos. Sem este sinal, a unica noticia seria a caducidade 30 dias
    // depois, sem ninguem saber que nunca houve chance.
    const minuscula = buildFoundingNetwork(3);
    const candidatura = unwrap(
      openApplication({
        id: APPLICATION_ID,
        candidate: buildStoreProfile({ tradeName: 'Nova Garagem', cnpj: '02558157000162' }),
        sponsor: minuscula.founderAt(0),
        now: NOW,
      }),
    ).state;

    const tally = endorsementTally(candidatura, minuscula.founders);
    assert.equal(tally.foundersYetToEndorse, 2);
    assert.equal(tally.stillNeeded, 3);
    assert.equal(tally.reachable, false);
  });

  test('candidatura credenciada nao aceita novo endosso', () => {
    const tardio = endorse({
      application: admitida(),
      founderStore: network.founderAt(4),
      user: network.principalAt(4),
      now: NOW,
    });

    assert.equal(tardio.ok === false && tardio.error.code, 'APPLICATION_ALREADY_DECIDED');
  });
});

describe('caducidade: o silencio ganha data', () => {
  const JANELA = DEFAULT_GOVERNANCE_POLICY.applicationWindowDays * 24 * 60 * 60 * 1000;

  test('dentro do prazo, a candidatura continua de pe', () => {
    const transicao = unwrap(
      lapseApplication({ application: pendingApplication(), now: NOW + JANELA - 1 }),
    );

    assert.equal(transicao.state.status, MembershipStatus.PENDING);
    assert.equal(transicao.events.length, 0);
  });

  test('vencido o prazo sem os endossos, caduca', () => {
    // E o unico desfecho negativo que existe, e de proposito: ninguem recusa
    // ninguem. O prazo transforma o silencio em resposta.
    const caducada = unwrap(
      lapseApplication({ application: endorsedBy(pendingApplication(), [1]), now: NOW + JANELA }),
    ).state;

    assert.equal(caducada.status, MembershipStatus.LAPSED);
    assert.equal(caducada.decidedAt, NOW + JANELA);
  });

  test('candidatura ja credenciada nao caduca', () => {
    const transicao = unwrap(lapseApplication({ application: admitida(), now: NOW + JANELA * 10 }));
    assert.equal(transicao.state.status, MembershipStatus.APPROVED);
    assert.equal(transicao.events.length, 0);
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

  test('quem entra na janela de fundacao leva: a loja nasce FUNDADORA', () => {
    const { store } = unwrap(admitApprovedStore(admitida(), asStoreId('str_new'), PRACA, NOW));

    assert.equal(store.kind, StoreKind.FOUNDER, 'a janela ainda estava aberta');
    assert.equal(store.status, StoreStatus.ACTIVE);
    assert.equal(store.sponsorStoreId, network.founderAt(0).id);
    assert.equal(store.profile.tradeName, 'Nova Garagem');
  });

  test('fechada a janela, a mesma candidatura vira MEMBER', () => {
    // Mesmos endossos, mesma candidata, mesmo instante: o que muda e so a
    // praca. E o unico eixo que decide fundadora ou membro.
    const { store } = unwrap(
      admitApprovedStore(admitida(), asStoreId('str_new'), PRACA_FECHADA, NOW),
    );

    assert.equal(store.kind, StoreKind.MEMBER);
  });

  test('o instante exato do fim ja esta fora da janela', () => {
    // O limite tem de cair de um lado so: duas lojas credenciadas no mesmo
    // milissegundo nao podem receber condicoes diferentes por ordem de gravacao.
    const noLimite = buildCluster({ foundingWindowEndsAt: NOW });
    const { store } = unwrap(admitApprovedStore(admitida(), asStoreId('str_new'), noLimite, NOW));

    assert.equal(store.kind, StoreKind.MEMBER);
  });

  test('nao ha campo dizendo por que a loja e fundadora: da para reconstruir', () => {
    const { store } = unwrap(admitApprovedStore(admitida(), asStoreId('str_new'), PRACA, NOW));

    assert.equal(
      store.joinedAt < PRACA.foundingWindowEndsAt,
      store.kind === StoreKind.FOUNDER,
      'joinedAt contra a janela responde sozinho — um segundo registro so divergiria',
    );
  });

  test('candidatura nao aprovada nao vira loja', () => {
    const result = admitApprovedStore(pendingApplication(), asStoreId('str_new'), PRACA, NOW);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'APPLICATION_NOT_APPROVED');
  });

  test('credenciar duas vezes a mesma candidatura e bloqueado', () => {
    const first = unwrap(admitApprovedStore(admitida(), asStoreId('str_new'), PRACA, NOW));
    const second = admitApprovedStore(first.application, asStoreId('str_other'), PRACA, NOW);
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.error.code, 'STORE_ALREADY_ADMITTED');
  });

  test('candidatura de uma praca nao e credenciada em outra', () => {
    const outraPraca = buildCluster({ id: asClusterId('clu_outra') });
    const result = admitApprovedStore(admitida(), asStoreId('str_new'), outraPraca, NOW);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'CROSS_CLUSTER');
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
