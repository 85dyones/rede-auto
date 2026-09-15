/**
 * Coordenadas e distancia.
 *
 * Existe por um motivo estreito e concreto: a declaracao de entrega ja exigia
 * geolocalizacao obrigatoria, mas nao havia com o que compara-la. A coordenada
 * era guardada e nunca lida — provava *uma* posicao, nao *a* posicao. Um numero
 * que ninguem confere nao e registro, e decoracao.
 *
 * Com o patio da loja de destino em coordenada, "deixei no patio de voces" vira
 * afirmacao verificavel. E disso que dependem duas atribuicoes de quebra de
 * protocolo: quem declarou de longe, e quem recebeu e nao deu o aceite.
 */

import { assertInvariant } from './errors.ts';

export type GeoPoint = {
  readonly lat: number;
  readonly lng: number;
};

const EARTH_RADIUS_M = 6_371_000;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Distancia em metros pela formula de haversine.
 *
 * Haversine trata a Terra como esfera, o que erra ate ~0,5% — irrelevante aqui:
 * a pergunta e "esta no patio ou a quilometros dele?", com tolerancia de
 * centenas de metros. Precisao de elipsoide resolveria um erro que o GPS do
 * celular ja comete dez vezes maior.
 */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  assertInvariant(
    Number.isFinite(a.lat) && Number.isFinite(a.lng),
    'coordenada de origem invalida',
  );
  assertInvariant(
    Number.isFinite(b.lat) && Number.isFinite(b.lng),
    'coordenada de destino invalida',
  );

  const deltaLat = toRadians(b.lat - a.lat);
  const deltaLng = toRadians(b.lng - a.lng);
  const latA = toRadians(a.lat);
  const latB = toRadians(b.lat);

  const h =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(deltaLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Raio em que uma coordenada ainda conta como "no patio".
 *
 * Quinhentos metros, e generoso de proposito. O erro de GPS de celular em rua
 * de centro, entre predios, passa de cem metros com facilidade; um raio
 * apertado transformaria falha de sinal em acusacao de declaracao falsa. O que
 * este numero precisa separar e "no patio" de "declarei do escritorio, do outro
 * lado da cidade" — e para isso 500 m sobra.
 *
 * O custo aceito: quem declarar do posto da esquina passa. Tudo bem. A
 * coordenada nao e prova irrefutavel e nunca pretendeu ser; ela elimina a
 * declaracao feita de qualquer lugar, que era o caso real.
 */
export const YARD_RADIUS_METERS = 500;

export function isWithinYard(
  point: GeoPoint,
  yard: GeoPoint,
  radiusMeters: number = YARD_RADIUS_METERS,
): boolean {
  return distanceMeters(point, yard) <= radiusMeters;
}
