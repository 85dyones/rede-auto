/**
 * Renderizacao da lamina white-label em PDF e em HTML.
 *
 * Duas saidas porque sao dois usos diferentes: o HTML e o que o cliente abre no
 * celular (com fotos, responsivo); o PDF e o que o vendedor anexa e o cliente
 * imprime ou leva ao banco.
 *
 * Ambas partem do MESMO `WhiteLabelSheet` ja sanitizado. Nenhuma das duas
 * recebe o agregado `Vehicle` — assim nao ha como um renderizador imprimir por
 * engano um campo que a sanitizacao deixou de fora.
 */

import type { WhiteLabelSheet } from '../../domain/sharing/spec-sheet.ts';
import { A4, Colors, PdfDocument, truncateText } from '../pdf/pdf-document.ts';

const MARGIN = 44;
const CONTENT_WIDTH = A4.width - MARGIN * 2;

export function renderLaminaPdf(sheet: WhiteLabelSheet): Buffer {
  const doc = new PdfDocument(A4);
  let y = A4.height - MARGIN;

  // Cabecalho: apenas a loja que compartilhou.
  doc.rect(0, A4.height - 96, A4.width, 96, Colors.panel);
  y = A4.height - 46;
  doc.text(sheet.presentedBy.tradeName, {
    x: MARGIN,
    y,
    size: 18,
    bold: true,
    color: Colors.ink,
  });
  doc.text(
    `${sheet.presentedBy.city}/${sheet.presentedBy.state}  -  ${sheet.presentedBy.phone}`,
    { x: MARGIN, y: y - 20, size: 10, color: Colors.muted },
  );
  doc.text(`Ref. ${sheet.reference}`, {
    x: A4.width - MARGIN,
    y,
    size: 10,
    color: Colors.muted,
    align: 'right',
  });

  // Titulo do veiculo e preco.
  y = A4.height - 140;
  y = doc.text(truncateText(sheet.title, CONTENT_WIDTH, 22, true), {
    x: MARGIN,
    y,
    size: 22,
    bold: true,
  });

  y -= 6;
  doc.text(sheet.price.formatted, { x: MARGIN, y, size: 26, bold: true, color: Colors.accent });
  y -= 34;

  doc.line(MARGIN, y, A4.width - MARGIN, y, Colors.hairline);
  y -= 26;

  // Ficha tecnica em duas colunas.
  const rows: ReadonlyArray<readonly [string, string]> = [
    ['Ano', sheet.yearLabel],
    ['Quilometragem', sheet.mileageLabel],
    ['Cor', sheet.color],
    ['Combustivel', sheet.fuelLabel],
    ['Cambio', sheet.transmissionLabel],
    ['Portas', sheet.doors === null ? '-' : String(sheet.doors)],
    ...(sheet.plate === null ? [] : [['Placa', sheet.plate] as const]),
  ];

  const columnWidth = CONTENT_WIDTH / 2;
  rows.forEach(([label, value], index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = MARGIN + column * columnWidth;
    const rowY = y - row * 34;
    doc.text(label.toUpperCase(), { x, y: rowY, size: 7.5, color: Colors.muted });
    doc.text(value, { x, y: rowY - 14, size: 12, bold: true });
  });
  y -= Math.ceil(rows.length / 2) * 34 + 12;

  doc.line(MARGIN, y, A4.width - MARGIN, y, Colors.hairline);
  y -= 26;

  // Laudo cautelar: o selo de qualificacao da rede.
  doc.text('LAUDO CAUTELAR', { x: MARGIN, y, size: 7.5, color: Colors.muted });
  y -= 15;
  y = doc.text(sheet.inspection.label, {
    x: MARGIN,
    y,
    size: 12,
    bold: true,
    color: sheet.inspection.approved ? Colors.accent : Colors.ink,
  });
  if (sheet.inspection.provider !== null) {
    y = doc.text(`Emitido por ${sheet.inspection.provider}`, {
      x: MARGIN,
      y: y - 2,
      size: 9,
      color: Colors.muted,
    });
  }
  y -= 18;

  // Opcionais.
  if (sheet.optionals.length > 0) {
    doc.line(MARGIN, y, A4.width - MARGIN, y, Colors.hairline);
    y -= 26;
    doc.text('OPCIONAIS E EQUIPAMENTOS', { x: MARGIN, y, size: 7.5, color: Colors.muted });
    y -= 16;
    y = doc.text(sheet.optionals.join('  -  '), {
      x: MARGIN,
      y,
      size: 10,
      maxWidth: CONTENT_WIDTH,
      lineHeight: 15,
    });
  }

  // Rodape.
  const footerY = MARGIN + 34;
  doc.line(MARGIN, footerY + 22, A4.width - MARGIN, footerY + 22, Colors.hairline);
  doc.text(sheet.disclaimer, {
    x: MARGIN,
    y: footerY,
    size: 8,
    color: Colors.muted,
    maxWidth: CONTENT_WIDTH,
    lineHeight: 11,
  });
  doc.text(`Proposta valida ate ${formatDateTime(sheet.validUntil)}`, {
    x: A4.width - MARGIN,
    y: footerY - 13,
    size: 8,
    color: Colors.muted,
    align: 'right',
  });

  return doc.toBuffer();
}

export function renderLaminaHtml(sheet: WhiteLabelSheet): string {
  const gallery =
    sheet.photos.length === 0
      ? ''
      : `<div class="galeria">${sheet.photos
          .map(
            (photo, index) =>
              `<img src="${escapeHtml(photo)}" alt="Foto ${index + 1} do veiculo" loading="lazy">`,
          )
          .join('')}</div>`;

  const specs: ReadonlyArray<readonly [string, string]> = [
    ['Ano', sheet.yearLabel],
    ['Quilometragem', sheet.mileageLabel],
    ['Cor', sheet.color],
    ['Combustivel', sheet.fuelLabel],
    ['Cambio', sheet.transmissionLabel],
    ...(sheet.doors === null ? [] : [['Portas', String(sheet.doors)] as const]),
    ...(sheet.plate === null ? [] : [['Placa', sheet.plate] as const]),
  ];

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(sheet.title)}</title>
<style>
  :root {
    color-scheme: light dark;
    --fundo: #ffffff; --texto: #1c1f24; --suave: #6b7280;
    --linha: #e5e7eb; --painel: #f6f8fa; --destaque: #0d66b8;
  }
  @media (prefers-color-scheme: dark) {
    :root { --fundo: #16181d; --texto: #eef1f5; --suave: #9aa3af;
            --linha: #2a2e36; --painel: #1e2128; --destaque: #64b0ff; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--fundo); color: var(--texto);
         font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .folha { max-width: 720px; margin: 0 auto; padding: 24px 20px 56px; }
  header { padding-bottom: 16px; border-bottom: 1px solid var(--linha); }
  .loja { font-size: 20px; font-weight: 700; margin: 0; }
  .contato { color: var(--suave); font-size: 14px; margin: 4px 0 0; }
  .ref { float: right; color: var(--suave); font-size: 13px; }
  h1 { font-size: 26px; line-height: 1.25; margin: 24px 0 8px; }
  .preco { font-size: 30px; font-weight: 700; color: var(--destaque); margin: 0 0 20px; }
  .galeria { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
             gap: 10px; margin: 0 0 24px; }
  .galeria img { width: 100%; height: 100%; aspect-ratio: 4/3; object-fit: cover;
                 border-radius: 10px; background: var(--painel); }
  .ficha { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
           gap: 14px; padding: 18px; background: var(--painel); border-radius: 12px; }
  .ficha dt { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--suave); }
  .ficha dd { margin: 3px 0 0; font-size: 17px; font-weight: 600; }
  .bloco { margin-top: 28px; }
  .bloco h2 { font-size: 12px; letter-spacing: .06em; text-transform: uppercase;
              color: var(--suave); margin: 0 0 10px; font-weight: 600; }
  .selo { display: inline-block; padding: 7px 14px; border-radius: 999px; font-weight: 600;
          font-size: 15px; background: color-mix(in srgb, var(--destaque) 14%, transparent);
          color: var(--destaque); }
  .selo.reprovado { background: color-mix(in srgb, #b4341f 14%, transparent); color: #b4341f; }
  .opcionais { display: flex; flex-wrap: wrap; gap: 8px; padding: 0; margin: 0; list-style: none; }
  .opcionais li { padding: 5px 12px; border: 1px solid var(--linha); border-radius: 999px; font-size: 14px; }
  footer { margin-top: 36px; padding-top: 16px; border-top: 1px solid var(--linha);
           color: var(--suave); font-size: 13px; }
  @media print {
    body { background: #fff; color: #000; }
    .folha { max-width: none; padding: 0; }
    .galeria { grid-template-columns: repeat(2, 1fr); }
  }
</style>
</head>
<body>
<main class="folha">
  <header>
    <span class="ref">Ref. ${escapeHtml(sheet.reference)}</span>
    <p class="loja">${escapeHtml(sheet.presentedBy.tradeName)}</p>
    <p class="contato">${escapeHtml(sheet.presentedBy.city)}/${escapeHtml(sheet.presentedBy.state)} &middot; ${escapeHtml(sheet.presentedBy.phone)}</p>
  </header>

  <h1>${escapeHtml(sheet.title)}</h1>
  <p class="preco">${escapeHtml(sheet.price.formatted)}</p>

  ${gallery}

  <dl class="ficha">
    ${specs.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('\n    ')}
  </dl>

  <section class="bloco">
    <h2>Laudo cautelar</h2>
    <span class="selo${sheet.inspection.approved ? '' : ' reprovado'}">${escapeHtml(sheet.inspection.label)}</span>
    ${sheet.inspection.provider === null ? '' : `<p class="contato">Emitido por ${escapeHtml(sheet.inspection.provider)}</p>`}
  </section>

  ${
    sheet.optionals.length === 0
      ? ''
      : `<section class="bloco">
    <h2>Opcionais e equipamentos</h2>
    <ul class="opcionais">${sheet.optionals.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
  </section>`
  }

  <footer>
    <p>${escapeHtml(sheet.disclaimer)}</p>
    <p>Proposta valida ate ${escapeHtml(formatDateTime(sheet.validUntil))}.</p>
  </footer>
</main>
</body>
</html>`;
}

/** Escapa para contexto de texto e de atributo HTML. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  }).format(date);
}
