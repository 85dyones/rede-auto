/**
 * Mapeador no padrao Motors: tags em PascalCase, boa parte dos dados em
 * atributos.
 *
 *   <Anuncios>
 *     <Anuncio ID="..." Placa="..." Chassi="...">
 *       <Marca/><Modelo/><Versao/><AnoFabricacao/><AnoModelo/>
 *       <Quilometragem/><Cor/><Combustivel/><Cambio/><Portas/>
 *       <Preco/><PrecoRepasse/>
 *       <Opcionais><Opcional>...</Opcional></Opcionais>
 *       <Fotos><Foto Url="https://..."/></Fotos>
 *       <LaudoCautelar Status="APROVADO" Numero="..." Empresa="..." Data="..."/>
 *     </Anuncio>
 *   </Anuncios>
 */

import { attr, child, childText, children, findFirst } from '../xml.ts';
import {
  type FeedIssue,
  type FeedVehicleRecord,
  buildRecord,
} from '../canonical.ts';
import type { FeedMapper } from './index.ts';
import { collectPhotos, collectVehicleNodes } from './revendamais.ts';

export const motorsMapper: FeedMapper = {
  provider: 'motors',
  label: 'Motors',

  detect(root) {
    if (!['anuncios', 'estoque', 'veiculos'].includes(root.name)) return false;
    const item = findFirst(root, 'anuncio');
    if (item === undefined) return false;
    // A marca do formato: identificacao em atributo, repasse em PascalCase.
    const hasIdAttribute = attr(item, 'id') !== undefined;
    const hasNetPrice = child(item, 'precorepasse') !== undefined;
    return hasIdAttribute || hasNetPrice;
  },

  parse(root, context) {
    const records: FeedVehicleRecord[] = [];
    const issues: FeedIssue[] = [];

    for (const item of collectVehicleNodes(root)) {
      const laudo = child(item, 'laudocautelar', 'laudo');

      const built = buildRecord(
        {
          externalId: attr(item, 'id', 'codigo') ?? childText(item, 'id', 'codigo'),
          plate: attr(item, 'placa') ?? childText(item, 'placa'),
          chassis: attr(item, 'chassi', 'chassis') ?? childText(item, 'chassi', 'chassis'),
          brand: childText(item, 'marca') ?? attr(item, 'marca'),
          model: childText(item, 'modelo') ?? attr(item, 'modelo'),
          version: childText(item, 'versao') ?? attr(item, 'versao'),
          manufactureYear: childText(item, 'anofabricacao') ?? attr(item, 'anofabricacao'),
          modelYear: childText(item, 'anomodelo') ?? attr(item, 'anomodelo'),
          mileageKm: childText(item, 'quilometragem', 'km') ?? attr(item, 'quilometragem', 'km'),
          color: childText(item, 'cor') ?? attr(item, 'cor'),
          fuel: childText(item, 'combustivel') ?? attr(item, 'combustivel'),
          transmission: childText(item, 'cambio') ?? attr(item, 'cambio'),
          doors: childText(item, 'portas') ?? attr(item, 'portas'),
          publicPrice: childText(item, 'preco', 'precovenda') ?? attr(item, 'preco', 'precovenda'),
          netPrice: childText(item, 'precorepasse', 'valorrepasse') ?? attr(item, 'precorepasse'),
          optionals: children(child(item, 'opcionais'), 'opcional').map(
            (node) => node.text || attr(node, 'nome', 'descricao') || '',
          ),
          photos: collectPhotos(item),
          inspectionStatus: attr(laudo, 'status', 'situacao', 'aprovado') ?? childText(laudo, 'status'),
          inspectionProvider: attr(laudo, 'empresa', 'fornecedor') ?? childText(laudo, 'empresa'),
          inspectionNumber: attr(laudo, 'numero') ?? childText(laudo, 'numero'),
          inspectionIssuedAt: attr(laudo, 'data', 'dataemissao') ?? childText(laudo, 'data'),
          inspectionExpiresAt: attr(laudo, 'validade', 'datavalidade') ?? childText(laudo, 'validade'),
        },
        context,
      );

      if (built.ok) records.push(built.value);
      else issues.push(built.error);
    }

    return { provider: 'motors', records, issues };
  },
};
