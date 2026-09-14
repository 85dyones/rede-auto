/**
 * Ficha tecnica do veiculo em PDF — o material impresso que a loja parceira
 * baixa e usa no canal dela.
 *
 * Nasce NEUTRA: sem nome de loja, sem preco, sem placa. E material bruto, para
 * a parceira montar o proprio anuncio. Se ela quiser, gera a mesma ficha ja com
 * a marca e o preco DELA — nunca os da loja dona.
 *
 * Nao existe versao HTML hospedada: a plataforma nao tem pagina voltada ao
 * consumidor, e uma ficha em PDF e o que de fato circula por WhatsApp, imprime
 * na vitrine e vai junto na proposta ao banco.
 */

import type { MaterialKit } from '../../domain/material/kit.ts';
import { A4, Colors, PdfDocument, truncateText } from '../pdf/pdf-document.ts';

const MARGIN = 44;
const CONTENT_WIDTH = A4.width - MARGIN * 2;

export function renderFichaPdf(kit: MaterialKit): Buffer {
  const doc = new PdfDocument(A4);
  const { sheet, branding } = kit;
  let y = A4.height - MARGIN;

  // Cabecalho: so existe se a parceira pediu a propria marca.
  if (branding !== null) {
    doc.rect(0, A4.height - 92, A4.width, 92, Colors.panel);
    y = A4.height - 44;
    doc.text(branding.tradeName, { x: MARGIN, y, size: 17, bold: true });
    doc.text(`${branding.city}/${branding.state}  -  ${branding.phone}`, {
      x: MARGIN,
      y: y - 19,
      size: 10,
      color: Colors.muted,
    });
    doc.text(`Ref. ${sheet.reference}`, {
      x: A4.width - MARGIN,
      y,
      size: 10,
      color: Colors.muted,
      align: 'right',
    });
    y = A4.height - 136;
  } else {
    doc.text(`Ficha tecnica  -  Ref. ${sheet.reference}`, {
      x: MARGIN,
      y: y - 10,
      size: 9.5,
      color: Colors.muted,
    });
    y -= 44;
  }

  y = doc.text(truncateText(sheet.title, CONTENT_WIDTH, 22, true), {
    x: MARGIN,
    y,
    size: 22,
    bold: true,
  });

  if (branding?.price != null) {
    y -= 6;
    doc.text(branding.price.formatted, { x: MARGIN, y, size: 26, bold: true, color: Colors.accent });
    y -= 34;
  } else {
    y -= 14;
  }

  doc.line(MARGIN, y, A4.width - MARGIN, y, Colors.hairline);
  y -= 26;

  const rows: ReadonlyArray<readonly [string, string]> = [
    ['Ano', sheet.yearLabel],
    ['Quilometragem', sheet.mileageLabel],
    ['Cor', sheet.color],
    ['Combustivel', sheet.fuelLabel],
    ['Cambio', sheet.transmissionLabel],
    ['Portas', sheet.doors === null ? '-' : String(sheet.doors)],
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

  if (sheet.photos.length > 0) {
    y -= 8;
    doc.line(MARGIN, y, A4.width - MARGIN, y, Colors.hairline);
    y -= 26;
    doc.text('MATERIAL FOTOGRAFICO', { x: MARGIN, y, size: 7.5, color: Colors.muted });
    y -= 16;
    // O gerador nao embute imagem; a ficha lista o que acompanha o kit.
    doc.text(
      `${sheet.photos.length} fotos neutras disponiveis: ${sheet.photos.map((p) => p.angleLabel).join(', ')}.`,
      { x: MARGIN, y, size: 10, maxWidth: CONTENT_WIDTH, lineHeight: 15, color: Colors.muted },
    );
  }

  const footerY = MARGIN + 34;
  doc.line(MARGIN, footerY + 22, A4.width - MARGIN, footerY + 22, Colors.hairline);
  doc.text(
    branding === null
      ? 'Material neutro para uso da loja parceira. Preencha preco e contato antes de publicar.'
      : 'Valores e disponibilidade sujeitos a confirmacao. Consulte o vendedor antes de fechar negocio.',
    { x: MARGIN, y: footerY, size: 8, color: Colors.muted, maxWidth: CONTENT_WIDTH, lineHeight: 11 },
  );

  return doc.toBuffer();
}
