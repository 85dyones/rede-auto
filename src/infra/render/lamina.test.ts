import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, renderLaminaHtml, renderLaminaPdf } from './lamina.ts';
import { measureText, toWinAnsi, truncateText, wrapText } from '../pdf/pdf-document.ts';
import { buildWhiteLabelSheet, forbiddenTermsFor } from '../../domain/sharing/spec-sheet.ts';
import { createShareLink } from '../../domain/sharing/share-link.ts';
import { asShareLinkId } from '../../domain/shared/ids.ts';
import { fromReais } from '../../domain/shared/money.ts';
import { unwrap } from '../../domain/shared/result.ts';
import { buildFoundingNetwork, buildSpecs, buildVehicle } from '../../testing/builders.ts';

const network = buildFoundingNetwork(6);
const lojaA = network.founderAt(0);
const lojaB = network.founderAt(1);
const T0 = Date.parse('2026-08-24T13:00:00Z');

const vehicle = buildVehicle({
  ownerStoreId: lojaA.id,
  createdAt: T0,
  plate: 'ABC1D23',
  chassis: '9BWZZZ377VT004251',
  specs: buildSpecs({
    version: 'Premier 1.0 Turbo (Aut)',
    color: 'Cinza Satélite',
    optionals: ['Ar-condicionado', 'Direçao eletrica', 'Multimidia'],
    photos: ['https://cdn.primemotors.com.br/a.jpg', 'https://cdn.primemotors.com.br/b.jpg'],
  }),
  pricing: { publicPrice: fromReais(92_900), netPrice: fromReais(85_000), updatedAt: T0 },
});

const link = unwrap(
  createShareLink({
    linkId: asShareLinkId('shr_1'),
    vehicle,
    sharedByStoreId: lojaB.id,
    createdByUserId: network.principalAt(1).id,
    now: T0,
  }),
).state;

const sheet = buildWhiteLabelSheet(vehicle, link, lojaB, {
  photoProxyBase: `/s/${link.token}/fotos`,
  now: T0,
});

describe('lamina em PDF', () => {
  test('produz um PDF estruturalmente valido', () => {
    const pdf = renderLaminaPdf(sheet);
    const text = pdf.toString('latin1');

    assert.match(text, /^%PDF-1\.7/);
    assert.match(text, /%%EOF\n$/);
    assert.match(text, /\/Type \/Catalog/);
    assert.match(text, /\/Type \/Page[^s]/);
    assert.match(text, /\/BaseFont \/Helvetica-Bold/);
  });

  test('a tabela xref aponta para o inicio real de cada objeto', () => {
    // Um xref desalinhado gera um arquivo que abre em alguns leitores e falha
    // em outros — o tipo de bug que so aparece no celular do cliente.
    const pdf = renderLaminaPdf(sheet);
    const text = pdf.toString('latin1');

    const startxref = /startxref\n(\d+)\n%%EOF/.exec(text);
    assert.ok(startxref, 'o arquivo declara startxref');
    const xrefOffset = Number(startxref[1]);
    assert.equal(text.slice(xrefOffset, xrefOffset + 4), 'xref');

    const entries = [...text.slice(xrefOffset).matchAll(/^(\d{10}) 00000 n $/gm)];
    assert.ok(entries.length >= 5, 'ha uma entrada por objeto');
    entries.forEach((entry, index) => {
      const offset = Number(entry[1]);
      assert.match(
        text.slice(offset, offset + 12),
        new RegExp(`^${index + 1} 0 obj`),
        `objeto ${index + 1} deve comecar no offset declarado`,
      );
    });
  });

  test('o texto do PDF nao contem nenhum termo proibido', () => {
    const text = renderLaminaPdf(sheet).toString('latin1').toLowerCase();
    for (const term of forbiddenTermsFor(vehicle, lojaA)) {
      assert.equal(text.includes(term.toLowerCase()), false, `vazou no PDF: ${term}`);
    }
  });

  test('imprime a loja que compartilhou e o preco escolhido por ela', () => {
    const text = renderLaminaPdf(sheet).toString('latin1');
    assert.ok(text.includes(lojaB.profile.tradeName));
    assert.ok(text.includes('92.900,00'));
  });

  test('acentos do portugues sobrevivem a codificacao WinAnsi', () => {
    const text = renderLaminaPdf(sheet).toString('latin1');
    assert.ok(text.includes('Cinza Satélite'), 'acento agudo preservado');
    assert.ok(text.includes('Direçao'), 'cedilha preservada');
  });

  test('caracteres tipograficos fora do Latin-1 viram o byte WinAnsi correto', () => {
    // Travessao e aspa curva entram sozinhos ao colar texto de um anuncio.
    assert.equal(toWinAnsi('a — b'), 'a \u0097 b');
    assert.equal(toWinAnsi('“aspas”'), '\u0093aspas\u0094');
    assert.equal(toWinAnsi('reticencias…'), 'reticencias\u0085');
  });

  test('o que nao existe em WinAnsi e transliterado antes de virar interrogacao', () => {
    assert.equal(toWinAnsi('Sao Paulo'), 'Sao Paulo');
    assert.equal(toWinAnsi('\u0100rea'), 'Area', 'A com macron vira A, nao ?');
    assert.equal(toWinAnsi('preco \u4EF7'), 'preco ?');
  });

  test('parenteses e barras invertidas do conteudo sao escapados', () => {
    // Sem escape, um "(Aut)" no nome da versao quebraria o parser do PDF.
    const text = renderLaminaPdf(sheet).toString('latin1');
    assert.ok(text.includes('\\(Aut\\)'));
  });
});

describe('metrica de texto do PDF', () => {
  test('mede largura proporcional, nao monoespacada', () => {
    assert.ok(measureText('iiii', 10) < measureText('MMMM', 10));
  });

  test('quebra o texto respeitando a largura', () => {
    const lines = wrapText('Ar-condicionado Direcao eletrica Multimidia Sensor de re', 120, 10);
    assert.ok(lines.length > 1);
    for (const line of lines) {
      assert.ok(measureText(line, 10) <= 120, `linha estourou a largura: "${line}"`);
    }
  });

  test('palavra unica maior que a largura nao entra em laco infinito', () => {
    const lines = wrapText('Superlongapalavrasemespacosnenhum', 40, 10);
    assert.deepEqual(lines, ['Superlongapalavrasemespacosnenhum']);
  });

  test('trunca com reticencias dentro do limite', () => {
    const truncated = truncateText('Chevrolet Onix Premier 1.0 Turbo Automatico', 80, 10);
    assert.match(truncated, /\.\.\.$/);
    assert.ok(measureText(truncated, 10) <= 80);
  });

  test('texto que cabe nao e truncado', () => {
    assert.equal(truncateText('Onix', 200, 10), 'Onix');
  });
});

describe('lamina em HTML', () => {
  test('nao vaza nenhum termo proibido', () => {
    const html = renderLaminaHtml(sheet).toLowerCase();
    for (const term of forbiddenTermsFor(vehicle, lojaA)) {
      assert.equal(html.includes(term.toLowerCase()), false, `vazou no HTML: ${term}`);
    }
  });

  test('serve as fotos pela plataforma', () => {
    const html = renderLaminaHtml(sheet);
    assert.ok(html.includes(`/s/${link.token}/fotos/0`));
    assert.equal(html.includes('primemotors'), false);
  });

  test('pede aos buscadores que nao indexem a lamina', () => {
    // Uma lamina indexada viraria anuncio publico do carro de outra loja.
    assert.match(renderLaminaHtml(sheet), /<meta name="robots" content="noindex, nofollow">/);
  });

  test('escapa conteudo para nao permitir injecao de HTML', () => {
    assert.equal(
      escapeHtml('<script>alert("x")</script>'),
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );

    const malicioso = buildWhiteLabelSheet(
      { ...vehicle, specs: { ...vehicle.specs, color: '"><script>alert(1)</script>' } },
      link,
      lojaB,
      { now: T0 },
    );
    const html = renderLaminaHtml(malicioso);
    assert.equal(html.includes('<script>alert(1)</script>'), false);
    assert.ok(html.includes('&lt;script&gt;'));
  });

  test('funciona em tema claro e escuro e tem regra de impressao', () => {
    const html = renderLaminaHtml(sheet);
    assert.match(html, /prefers-color-scheme: dark/);
    assert.match(html, /@media print/);
  });
});
