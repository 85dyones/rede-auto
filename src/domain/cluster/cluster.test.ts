import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ClusterStatus,
  MAX_OPERATING_RADIUS_KM,
  parseClusterDraft,
  parseClusterSlug,
  requireSameCluster,
  sameCluster,
  transactsInCluster,
} from './cluster.ts';
import { asClusterId } from '../shared/ids.ts';

const CWB = asClusterId('clu_curitiba');
const LDB = asClusterId('clu_londrina');

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
  const base = {
    name: 'Curitiba e Regiao',
    slug: 'curitiba-rmc',
    state: 'PR',
    cities: ['Curitiba', 'Sao Jose dos Pinhais'],
  };

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
    const emFormacao = {
      id: CWB,
      name: 'Curitiba e Regiao',
      slug: 'curitiba-rmc',
      state: 'PR',
      cities: ['Curitiba'],
      operatingRadiusKm: 60,
      status: ClusterStatus.FORMING,
      foundedAt: 0,
    };
    assert.equal(transactsInCluster(emFormacao), false);
    assert.equal(transactsInCluster({ ...emFormacao, status: ClusterStatus.ACTIVE }), true);
  });
});
