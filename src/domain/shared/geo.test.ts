import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { YARD_RADIUS_METERS, distanceMeters, isWithinYard } from './geo.ts';

/** Centro de Curitiba e Sao Jose dos Pinhais: ~12 km, a distancia real da praca. */
const CURITIBA = { lat: -25.4284, lng: -49.2733 };
const SAO_JOSE = { lat: -25.5307, lng: -49.2064 };

describe('distancia', () => {
  test('a mesma coordenada dista zero', () => {
    assert.equal(distanceMeters(CURITIBA, CURITIBA), 0);
  });

  test('e simetrica', () => {
    assert.equal(
      Math.round(distanceMeters(CURITIBA, SAO_JOSE)),
      Math.round(distanceMeters(SAO_JOSE, CURITIBA)),
    );
  });

  test('bate com a distancia real entre duas cidades da praca', () => {
    const km = distanceMeters(CURITIBA, SAO_JOSE) / 1000;
    assert.ok(km > 12 && km < 14, `${km.toFixed(1)} km entre Curitiba e Sao Jose dos Pinhais`);
  });

  test('um grau de latitude sao ~111 km em qualquer longitude', () => {
    const norte = { lat: CURITIBA.lat + 1, lng: CURITIBA.lng };
    const km = distanceMeters(CURITIBA, norte) / 1000;
    assert.ok(km > 110 && km < 112, `${km.toFixed(1)} km`);
  });
});

describe('raio do patio', () => {
  /** Metros ao norte viram graus de latitude direto: 1 grau ~ 111.320 m. */
  const aoNorte = (meters: number) => ({
    lat: CURITIBA.lat + meters / 111_320,
    lng: CURITIBA.lng,
  });

  test('erro comum de GPS urbano passa', () => {
    // Cem, duzentos metros e o que um celular erra entre predios. Um raio
    // apertado transformaria falha de sinal em acusacao de declaracao falsa.
    assert.equal(isWithinYard(aoNorte(100), CURITIBA), true);
    assert.equal(isWithinYard(aoNorte(400), CURITIBA), true);
  });

  test('declarar do outro lado da cidade nao passa', () => {
    assert.equal(isWithinYard(SAO_JOSE, CURITIBA), false);
    assert.equal(isWithinYard(aoNorte(2_000), CURITIBA), false);
  });

  test('o limite cai de um lado so', () => {
    assert.equal(isWithinYard(aoNorte(YARD_RADIUS_METERS - 1), CURITIBA), true);
    assert.equal(isWithinYard(aoNorte(YARD_RADIUS_METERS + 50), CURITIBA), false);
  });

  test('o raio e parametro: praca com patios colados pode aperta-lo', () => {
    assert.equal(isWithinYard(aoNorte(200), CURITIBA, 100), false);
    assert.equal(isWithinYard(aoNorte(200), CURITIBA, 300), true);
  });
});
