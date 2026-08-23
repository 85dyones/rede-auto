/**
 * Mapeador no padrao Revenda Mais: tags minusculas com separador `_`,
 * dados em elementos filhos.
 *
 *   <estoque>
 *     <veiculo>
 *       <id>...</id><placa>...</placa><chassi>...</chassi>
 *       <marca/><modelo/><versao/><anofabricacao/><anomodelo/>
 *       <km/><cor/><combustivel/><cambio/><portas/>
 *       <preco/><preco_repasse/>
 *       <opcionais><opcional>...</opcional></opcionais>
 *       <fotos><foto>https://...</foto></fotos>
 *       <laudo_cautelar><situacao/><numero/><empresa/><data/></laudo_cautelar>
 *     </veiculo>
 *   </estoque>
 */

import { type XmlNode, attr, child, childText, children, findFirst } from '../xml.ts';
import {
  type BuildContext,
  type FeedIssue,
  type FeedVehicleRecord,
  type ParsedFeed,
  buildRecord,
} from '../canonical.ts';
import type { FeedMapper } from './index.ts';

export const revendaMaisMapper: FeedMapper = {
  provider: 'revendamais',
  label: 'Revenda Mais',

  detect(root) {
    if (!['estoque', 'veiculos', 'anuncios'].includes(root.name)) return false;
    const item = findFirst(root, 'veiculo');
    if (item === undefined) return false;
    // A marca registrada do formato: repasse em snake_case, dado em filho.
    return child(item, 'preco_repasse', 'precorepasse') !== undefined;
  },

  parse(root, context) {
    return parseVehicleList(root, context, 'revendamais');
  },
};

/**
 * Leitura comum aos formatos com elementos `<veiculo>`. Compartilhada com o
 * mapeador generico, que aceita a mesma forma com nomes um pouco diferentes.
 */
export function parseVehicleList(
  root: XmlNode,
  context: BuildContext,
  provider: string,
): ParsedFeed {
  const records: FeedVehicleRecord[] = [];
  const issues: FeedIssue[] = [];

  const items = collectVehicleNodes(root);
  for (const item of items) {
    const laudo = child(item, 'laudo_cautelar', 'laudocautelar', 'laudo', 'cautelar');

    const built = buildRecord(
      {
        externalId: childText(item, 'id', 'codigo', 'id_veiculo', 'idveiculo') ?? attr(item, 'id', 'codigo'),
        plate: childText(item, 'placa'),
        chassis: childText(item, 'chassi', 'chassis', 'vin'),
        brand: childText(item, 'marca', 'fabricante'),
        model: childText(item, 'modelo'),
        version: childText(item, 'versao', 'complemento'),
        manufactureYear: childText(item, 'anofabricacao', 'ano_fabricacao', 'ano'),
        modelYear: childText(item, 'anomodelo', 'ano_modelo'),
        mileageKm: childText(item, 'km', 'quilometragem', 'hodometro'),
        color: childText(item, 'cor'),
        fuel: childText(item, 'combustivel'),
        transmission: childText(item, 'cambio', 'transmissao'),
        doors: childText(item, 'portas', 'numero_portas'),
        publicPrice: childText(item, 'preco', 'valor', 'preco_venda'),
        netPrice: childText(item, 'preco_repasse', 'precorepasse', 'valor_repasse', 'repasse'),
        optionals: children(child(item, 'opcionais', 'acessorios'), 'opcional', 'acessorio').map(
          (node) => node.text,
        ),
        photos: collectPhotos(item),
        inspectionStatus:
          childText(laudo, 'situacao', 'status', 'resultado') ??
          attr(laudo, 'aprovado', 'situacao', 'status') ??
          (laudo !== undefined && laudo.children.length === 0 ? laudo.text : undefined),
        inspectionProvider: childText(laudo, 'empresa', 'fornecedor', 'provedor') ?? attr(laudo, 'empresa'),
        inspectionNumber: childText(laudo, 'numero', 'codigo') ?? attr(laudo, 'numero'),
        inspectionIssuedAt: childText(laudo, 'data', 'data_emissao', 'emissao') ?? attr(laudo, 'data'),
        inspectionExpiresAt: childText(laudo, 'validade', 'data_validade') ?? attr(laudo, 'validade'),
      },
      context,
    );

    if (built.ok) records.push(built.value);
    else issues.push(built.error);
  }

  return { provider, records, issues };
}

export function collectVehicleNodes(root: XmlNode): XmlNode[] {
  const direct = children(root, 'veiculo', 'anuncio', 'carro', 'item');
  if (direct.length > 0) return direct;

  // Alguns feeds embrulham a lista em um nivel extra (<estoque><veiculos>...).
  for (const wrapper of root.children) {
    const nested = children(wrapper, 'veiculo', 'anuncio', 'carro', 'item');
    if (nested.length > 0) return nested;
  }
  return [];
}

export function collectPhotos(item: XmlNode): string[] {
  const container = child(item, 'fotos', 'imagens', 'photos');
  const nodes = children(container, 'foto', 'imagem', 'photo', 'url');
  const photos = nodes.map((node) => node.text || attr(node, 'url', 'href', 'src') || '');
  if (photos.some((photo) => photo.length > 0)) return photos.filter((photo) => photo.length > 0);

  // Feeds mais simples listam <foto1>, <foto2>... direto no veiculo.
  return item.children
    .filter((node) => /^foto\d*$/.test(node.name))
    .map((node) => node.text)
    .filter((photo) => photo.length > 0);
}
