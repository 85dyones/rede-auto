import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ClusterStatus,
  DEFAULT_FOUNDING_WINDOW_DAYS,
  MAX_FOUNDING_WINDOW_DAYS,
  MAX_OPERATING_RADIUS_KM,
  foundingWindowDaysLeft,
  parseClusterDraft,
  parseClusterSlug,
  requireSameCluster,
  sameCluster,
  transactsInCluster,
  withinFoundingWindow,
} from './cluster.ts';
import { asClusterId } from '../shared/ids.ts';
import { DAY } from '../shared/clock.ts';
import { unwrap } from '../shared/result.ts';
import { buildCluster } from '../../testing/builders.ts';

const CWB = asClusterId('clu_curitiba');
const LDB = asClusterId('clu_londrina');

/** Cadastro de praca valido, menos o campo que cada teste coloca sob analise. */
const base = {
  name: 'Curitiba e Regiao',
  slug: 'curitiba-rmc',
  state: 'PR',
  cities: ['Curitiba', 'Sao Jose dos Pinhais'],
};

describe('identificador da praca', () => {
  test('aceita minusculas, numeros e hifen', () => {
    const slug = parseClusterSlug('curitiba-rmc');
    assert.ok(slug.ok && slug.value === 'curitiba-rmc');
  });

  test('normaliza maiusculas em vez de recusar', () => {
    const slug = parseClusterSlug('Curitiba-RMC');
    assert.ok(slug.ok && slug.value === 'curitiba-rmc');
  });

  test('recusa espaco, acento e hifen solto', () => {
    for (const ruim of ['curitiba rmc', 'curitibá', 'curitiba-', '-rmc', 'curitiba--rmc']) {
      const slug = parseClusterSlug(ruim);
      assert.ok(!slug.ok, `deveria recusar ${JSON.stringify(ruim)}`);
    }
  });
});

describe('raio operacional', () => {
  test('aceita um raio compativel com custodia fisica', () => {
    const draft = parseClusterDraft({ ...base, operatingRadiusKm: 60 });
    assert.ok(draft.ok && draft.value.operatingRadiusKm === 60);
  });

  test('recusa raio em que o SLA de 4 horas deixa de ser cumprivel', () => {
    const draft = parseClusterDraft({ ...base, operatingRadiusKm: MAX_OPERATING_RADIUS_KM + 1 });
    assert.ok(!draft.ok);
    assert.equal(draft.error.code, 'CLUSTER_RADIUS_TOO_LARGE');
  });

  test('exige ao menos um municipio: praca sem alcance declarado nao e praca', () => {
    const draft = parseClusterDraft({ ...base, cities: [], operatingRadiusKm: 60 });
    assert.ok(!draft.ok);
    assert.equal(draft.error.code, 'CLUSTER_CITIES_REQUIRED');
  });
});

describe('a fronteira', () => {
  test('mesma praca passa', () => {
    assert.ok(sameCluster({ clusterId: CWB }, { clusterId: CWB }));
    const guard = requireSameCluster({ clusterId: CWB }, { clusterId: CWB }, 'O veiculo');
    assert.ok(guard.ok);
  });

  test('pracas diferentes nao se enxergam', () => {
    assert.ok(!sameCluster({ clusterId: CWB }, { clusterId: LDB }));
    const guard = requireSameCluster({ clusterId: CWB }, { clusterId: LDB }, 'O veiculo');
    assert.ok(!guard.ok);
    assert.equal(guard.error.code, 'CROSS_CLUSTER');
    assert.equal(guard.error.kind, 'FORBIDDEN');
  });

  test('a praca em formacao nao transaciona', () => {
    const emFormacao = buildCluster({ id: CWB, status: ClusterStatus.FORMING });
    assert.equal(transactsInCluster(emFormacao), false);
    assert.equal(transactsInCluster({ ...emFormacao, status: ClusterStatus.ACTIVE }), true);
  });
});

describe('janela de fundacao: quem entrar na janela, leva', () => {
  const ABERTURA = Date.parse('2026-01-10T12:00:00Z');
  const praca = buildCluster({
    id: CWB,
    foundedAt: ABERTURA,
    foundingWindowEndsAt: ABERTURA + 90 * DAY,
  });

  test('dentro da janela a praca ainda admite fundadoras', () => {
    assert.equal(withinFoundingWindow(praca, ABERTURA), true);
    assert.equal(withinFoundingWindow(praca, ABERTURA + 89 * DAY), true);
  });

  test('o instante do fim ja esta fora — o limite cai de um lado so', () => {
    assert.equal(withinFoundingWindow(praca, praca.foundingWindowEndsAt), false);
    assert.equal(withinFoundingWindow(praca, praca.foundingWindowEndsAt + 1), false);
  });

  test('os dias restantes sao o argumento de venda, e chegam a zero', () => {
    assert.equal(foundingWindowDaysLeft(praca, ABERTURA), 90);
    assert.equal(foundingWindowDaysLeft(praca, ABERTURA + 89.5 * DAY), 1, 'meio dia ainda e um dia');
    assert.equal(foundingWindowDaysLeft(praca, praca.foundingWindowEndsAt), 0);
    assert.equal(foundingWindowDaysLeft(praca, praca.foundingWindowEndsAt + 5 * DAY), 0);
  });

  test('janela padrao de 90 dias quando o cadastro nao informa', () => {
    const draft = unwrap(parseClusterDraft({ ...base, operatingRadiusKm: 60 }));
    assert.equal(draft.foundingWindowDays, DEFAULT_FOUNDING_WINDOW_DAYS);
  });

  test('janela longa demais e recusada: a adesao cheia nunca entraria', () => {
    const result = parseClusterDraft({
      ...base,
      operatingRadiusKm: 60,
      foundingWindowDays: MAX_FOUNDING_WINDOW_DAYS + 1,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'FOUNDING_WINDOW_TOO_LONG');
  });

  test('janela fracionada ou negativa nao passa', () => {
    for (const invalido of [0, -30, 45.5, '90']) {
      const result = parseClusterDraft({
        ...base,
        operatingRadiusKm: 60,
        foundingWindowDays: invalido,
      });
      assert.equal(result.ok, false, `${String(invalido)} deveria ser recusado`);
      assert.equal(result.ok === false && result.error.code, 'FOUNDING_WINDOW_INVALID');
    }
  });
});
