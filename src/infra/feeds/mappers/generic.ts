/**
 * Mapeador de ultimo recurso.
 *
 * Aceita qualquer XML com uma lista de veiculos e tenta os nomes de campo mais
 * comuns em portugues e ingles. Existe para o caso realista de uma loja mandar
 * o XML de um integrador que a rede ainda nao conhece: melhor ingerir o que da
 * para ingerir e reportar os itens que faltam campo do que recusar o arquivo
 * inteiro e deixar o lojista sem saber o que fazer.
 */

import { attr, child, childText, children, findFirst } from '../xml.ts';
import {
  type FeedIssue,
  type FeedVehicleRecord,
  buildRecord,
} from '../canonical.ts';
import type { FeedMapper } from './index.ts';
import { collectPhotos, collectVehicleNodes } from './revendamais.ts';

export const genericMapper: FeedMapper = {
  provider: 'generic',
  label: 'Generico',

  detect(root) {
    return (
      findFirst(root, 'veiculo', 'anuncio', 'carro', 'vehicle', 'item') !== undefined
    );
  },

  parse(root, context) {
    const records: FeedVehicleRecord[] = [];
    const issues: FeedIssue[] = [];

    for (const item of collectVehicleNodes(root)) {
      const laudo = child(item, 'laudo_cautelar', 'laudocautelar', 'laudo', 'cautelar', 'inspection');
      const pick = (...names: string[]): string | undefined =>
        childText(item, ...names) ?? attr(item, ...names);

      const built = buildRecord(
        {
          externalId: pick('id', 'codigo', 'externalid', 'external_id', 'sku', 'referencia'),
          plate: pick('placa', 'plate'),
          chassis: pick('chassi', 'chassis', 'vin'),
          brand: pick('marca', 'fabricante', 'brand', 'make'),
          model: pick('modelo', 'model'),
          version: pick('versao', 'version', 'trim', 'complemento'),
          manufactureYear: pick('anofabricacao', 'ano_fabricacao', 'ano', 'year'),
          modelYear: pick('anomodelo', 'ano_modelo', 'modelyear'),
          mileageKm: pick('km', 'quilometragem', 'hodometro', 'mileage', 'odometer'),
          color: pick('cor', 'color'),
          fuel: pick('combustivel', 'fuel'),
          transmission: pick('cambio', 'transmissao', 'transmission'),
          doors: pick('portas', 'doors'),
          publicPrice: pick('preco', 'valor', 'price', 'preco_venda', 'precovenda'),
          netPrice: pick(
            'preco_repasse',
            'precorepasse',
            'valor_repasse',
            'valorrepasse',
            'repasse',
            'netprice',
            'wholesaleprice',
          ),
          optionals: children(
            child(item, 'opcionais', 'acessorios', 'options', 'features'),
            'opcional',
            'acessorio',
            'option',
            'feature',
            'item',
          ).map((node) => node.text || attr(node, 'nome', 'descricao', 'name') || ''),
          photos: collectPhotos(item),
          inspectionStatus:
            childText(laudo, 'situacao', 'status', 'resultado') ??
            attr(laudo, 'status', 'situacao', 'aprovado') ??
            (laudo !== undefined && laudo.children.length === 0 ? laudo.text : undefined),
          inspectionProvider: childText(laudo, 'empresa', 'fornecedor') ?? attr(laudo, 'empresa'),
          inspectionNumber: childText(laudo, 'numero', 'codigo') ?? attr(laudo, 'numero'),
          inspectionIssuedAt: childText(laudo, 'data', 'emissao') ?? attr(laudo, 'data'),
          inspectionExpiresAt: childText(laudo, 'validade') ?? attr(laudo, 'validade'),
        },
        context,
      );

      if (built.ok) records.push(built.value);
      else issues.push(built.error);
    }

    return { provider: 'generic', records, issues };
  },
};
