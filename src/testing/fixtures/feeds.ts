/**
 * Feeds XML de exemplo, nos formatos que a rede consome.
 *
 * Sao MODELADOS a partir dos padroes publicos dos integradores automotivos
 * brasileiros; nao sao a especificacao oficial de nenhum deles. Servem aos
 * testes e ao roteiro de demonstracao.
 */

export type FeedItemOverrides = {
  id?: string;
  placa?: string;
  chassi?: string;
  preco?: string;
  precoRepasse?: string;
  km?: string;
  laudo?: string;
  laudoData?: string;
};

export function revendaMaisFeed(items: readonly FeedItemOverrides[]): string {
  const body = items
    .map(
      (item) => `  <veiculo>
    <id>${item.id ?? 'RM-1001'}</id>
    <placa>${item.placa ?? 'ABC1D23'}</placa>
    <chassi>${item.chassi ?? '9BWZZZ377VT004251'}</chassi>
    <marca>Chevrolet</marca>
    <modelo>Onix</modelo>
    <versao>1.0 Turbo LTZ</versao>
    <anofabricacao>2022</anofabricacao>
    <anomodelo>2023</anomodelo>
    <km>${item.km ?? '38400'}</km>
    <cor>Prata</cor>
    <combustivel>Flex</combustivel>
    <cambio>Automatico</cambio>
    <portas>4</portas>
    <preco>${item.preco ?? '92.900,00'}</preco>
    <preco_repasse>${item.precoRepasse ?? '85.000,00'}</preco_repasse>
    <opcionais>
      <opcional>Ar-condicionado</opcional>
      <opcional>Direcao eletrica</opcional>
      <opcional><![CDATA[Multimidia 8" & camera de re]]></opcional>
    </opcionais>
    <fotos>
      <foto>https://cdn.exemplo.com/${item.id ?? 'RM-1001'}-1.jpg</foto>
      <foto>https://cdn.exemplo.com/${item.id ?? 'RM-1001'}-2.jpg</foto>
    </fotos>
    <laudo_cautelar>
      <situacao>${item.laudo ?? 'APROVADO'}</situacao>
      <numero>LC-2026-004512</numero>
      <empresa>Cautelar Brasil</empresa>
      <data>${item.laudoData ?? '10/08/2026'}</data>
    </laudo_cautelar>
  </veiculo>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<estoque>
${body}
</estoque>`;
}

export function motorsFeed(items: readonly FeedItemOverrides[]): string {
  const body = items
    .map(
      (item) => `  <Anuncio ID="${item.id ?? 'MT-77'}" Placa="${item.placa ?? 'XYZ9K88'}" Chassi="${item.chassi ?? '9BGRD08X04G117974'}">
    <Marca>Fiat</Marca>
    <Modelo>Argo</Modelo>
    <Versao>1.3 Drive</Versao>
    <AnoFabricacao>2021</AnoFabricacao>
    <AnoModelo>2022</AnoModelo>
    <Quilometragem>${item.km ?? '54210'}</Quilometragem>
    <Cor>Branco</Cor>
    <Combustivel>Flex</Combustivel>
    <Cambio>Manual</Cambio>
    <Portas>4</Portas>
    <Preco>${item.preco ?? '68900.00'}</Preco>
    <PrecoRepasse>${item.precoRepasse ?? '62500.00'}</PrecoRepasse>
    <Opcionais>
      <Opcional>Vidros eletricos</Opcional>
      <Opcional>Sensor de re</Opcional>
    </Opcionais>
    <Fotos>
      <Foto Url="https://cdn.motors.com.br/${item.id ?? 'MT-77'}/1.jpg"/>
      <Foto Url="https://cdn.motors.com.br/${item.id ?? 'MT-77'}/2.jpg"/>
    </Fotos>
    <LaudoCautelar Status="${item.laudo ?? 'APROVADO'}" Numero="MC-99812" Empresa="Motors Check" Data="${item.laudoData ?? '2026-08-05'}"/>
  </Anuncio>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Anuncios>
${body}
</Anuncios>`;
}
