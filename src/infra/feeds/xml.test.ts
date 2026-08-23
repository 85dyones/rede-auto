import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { attr, child, childText, children, findFirst, parseXml, textOrAttr } from './xml.ts';
import { unwrap } from '../../domain/shared/result.ts';

const parse = (xml: string) => unwrap(parseXml(xml));

describe('defesas do parser', () => {
  test('rejeita DOCTYPE — vetor de XXE e de expansao de entidades', () => {
    const xxe = `<?xml version="1.0"?>
<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<estoque><veiculo>&xxe;</veiculo></estoque>`;
    const result = parseXml(xxe);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'XML_DOCTYPE_REJECTED');
  });

  test('rejeita o billion laughs pelo mesmo guarda', () => {
    const bomb = `<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><lolz>&lol2;</lolz>`;
    assert.equal(parseXml(bomb).ok, false);
  });

  test('nao resolve entidade personalizada nem quando ela aparece sozinha', () => {
    // Sem DTD a entidade nao existe; tentar resolve-la e que seria o problema.
    const node = parse('<a>&minhaEntidade;</a>');
    assert.equal(node.text, '&minhaEntidade;');
  });

  test('limita tamanho, profundidade e quantidade de nos', () => {
    const grande = parseXml('<a>x</a>', { maxBytes: 4, maxDepth: 10, maxNodes: 10 });
    assert.equal(grande.ok === false && grande.error.code, 'XML_TOO_LARGE');

    const fundo = parseXml('<a><b><c><d>x</d></c></b></a>', {
      maxBytes: 1000,
      maxDepth: 2,
      maxNodes: 100,
    });
    assert.equal(fundo.ok === false && fundo.error.code, 'XML_TOO_DEEP');

    const muitos = parseXml('<a><b/><c/><d/></a>', { maxBytes: 1000, maxDepth: 10, maxNodes: 2 });
    assert.equal(muitos.ok === false && muitos.error.code, 'XML_TOO_MANY_NODES');
  });

  test('recusa XML malformado em vez de adivinhar', () => {
    for (const invalid of [
      '<a><b></a>',
      '<a>',
      '</a>',
      '<a><!-- comentario sem fim',
      '<a>x</a><b>y</b>',
      '',
    ]) {
      assert.equal(parseXml(invalid).ok, false, `deveria recusar: ${invalid}`);
    }
  });
});

describe('leitura de estrutura', () => {
  test('le elementos, atributos, texto e auto-fechamento', () => {
    const node = parse(`<?xml version="1.0" encoding="UTF-8"?>
      <estoque loja="42">
        <!-- comentario ignorado -->
        <veiculo id="A1"><marca>Chevrolet</marca><vendido/></veiculo>
      </estoque>`);

    assert.equal(node.name, 'estoque');
    assert.equal(attr(node, 'loja'), '42');
    const veiculo = child(node, 'veiculo');
    assert.equal(attr(veiculo, 'id'), 'A1');
    assert.equal(childText(veiculo, 'marca'), 'Chevrolet');
    assert.equal(child(veiculo, 'vendido')?.children.length, 0);
  });

  test('a busca ignora caixa e prefixo de namespace', () => {
    // Feeds reais alternam entre <veiculo>, <Veiculo> e <ns:Veiculo>.
    const node = parse('<Estoque><ns:Veiculo><MARCA>Fiat</MARCA></ns:Veiculo></Estoque>');
    assert.equal(childText(child(node, 'veiculo'), 'marca'), 'Fiat');
  });

  test('aceita nomes alternativos na mesma consulta', () => {
    const revendaMais = parse('<v><preco_repasse>85000</preco_repasse></v>');
    const motors = parse('<v><PrecoRepasse>85000</PrecoRepasse></v>');
    for (const node of [revendaMais, motors]) {
      assert.equal(childText(node, 'preco_repasse', 'precorepasse'), '85000');
    }
  });

  test('expande as cinco entidades predefinidas e referencias numericas', () => {
    const node = parse('<a>Fiat &amp; Cia &lt;teste&gt; &#233; &#xE9;</a>');
    assert.equal(node.text, 'Fiat & Cia <teste> é é');
  });

  test('CDATA preserva o conteudo literal, sem expandir entidade', () => {
    const node = parse('<obs><![CDATA[Ar & cia <novo> "aspas"]]></obs>');
    assert.equal(node.text, 'Ar & cia <novo> "aspas"');
  });

  test('elemento vazio equivale a ausente na leitura de texto', () => {
    const node = parse('<v><preco></preco><cor>   </cor></v>');
    assert.equal(childText(node, 'preco'), undefined);
    assert.equal(childText(node, 'cor'), undefined);
    assert.equal(childText(node, 'inexistente'), undefined);
  });

  test('children() devolve todas as repeticoes', () => {
    const node = parse('<fotos><foto>a.jpg</foto><foto>b.jpg</foto><foto>c.jpg</foto></fotos>');
    assert.deepEqual(children(node, 'foto').map((f) => f.text), ['a.jpg', 'b.jpg', 'c.jpg']);
  });

  test('textOrAttr cobre feeds que usam filho e feeds que usam atributo', () => {
    const comFilho = parse('<foto><url>https://x/a.jpg</url></foto>');
    const comAtributo = parse('<foto Url="https://x/a.jpg"/>');
    assert.equal(textOrAttr(comFilho, ['url'], ['url']), 'https://x/a.jpg');
    assert.equal(textOrAttr(comAtributo, ['url'], ['url']), 'https://x/a.jpg');
  });

  test('findFirst varre em profundidade', () => {
    const node = parse('<a><b><c><alvo>ok</alvo></c></b></a>');
    assert.equal(findFirst(node, 'alvo')?.text, 'ok');
    assert.equal(findFirst(node, 'ausente'), undefined);
  });

  test('atributos com aspas simples e com entidades sao lidos', () => {
    const node = parse(`<foto url='https://x/a.jpg?w=1&amp;h=2' Alt="Frente"/>`);
    assert.equal(attr(node, 'url'), 'https://x/a.jpg?w=1&h=2');
    assert.equal(attr(node, 'alt'), 'Frente');
  });
});
