/**
 * Registro de mapeadores por integrador.
 *
 * Os esquemas aqui sao MODELADOS a partir dos padroes publicos dos integradores
 * automotivos brasileiros (Revenda Mais, Motors) — nao sao a especificacao
 * oficial de nenhum deles, que muda sem aviso e exige contrato para acessar.
 *
 * O desenho leva isso em conta: cada mapeador so declara nomes de tag, e aceita
 * varias grafias para o mesmo campo. Ajustar para o XML real de um integrador
 * significa acrescentar nomes a uma lista, nao reescrever regra de negocio.
 */

import type { XmlNode } from '../xml.ts';
import type { BuildContext, ParsedFeed } from '../canonical.ts';
import { revendaMaisMapper } from './revendamais.ts';
import { motorsMapper } from './motors.ts';
import { genericMapper } from './generic.ts';

export type FeedMapper = {
  readonly provider: string;
  readonly label: string;
  /** Reconhece o formato pela raiz e pela forma dos itens. */
  detect(root: XmlNode): boolean;
  parse(root: XmlNode, context: BuildContext): ParsedFeed;
};

/** Ordem importa: o generico e o ultimo, por ser o mais permissivo. */
export const FEED_MAPPERS: readonly FeedMapper[] = [
  revendaMaisMapper,
  motorsMapper,
  genericMapper,
];

export function mapperFor(provider: string): FeedMapper | undefined {
  const wanted = provider.trim().toLowerCase();
  return FEED_MAPPERS.find((mapper) => mapper.provider === wanted);
}

/** Descobre o formato pelo conteudo, quando o cliente nao declara o integrador. */
export function detectMapper(root: XmlNode): FeedMapper | undefined {
  return FEED_MAPPERS.find((mapper) => mapper.detect(root));
}

export { revendaMaisMapper, motorsMapper, genericMapper };
