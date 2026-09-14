/**
 * Gerador de PDF minimo, sem dependencias.
 *
 * A ficha de divulgacao precisa sair como PDF de verdade — e o que o vendedor
 * anexa no WhatsApp e o que o cliente imprime. Trazer uma biblioteca de PDF para
 * isso seria desproporcional: a ficha e texto, linhas e retangulos numa A4.
 *
 * Escopo deliberado: fontes Type1 padrao (Helvetica), texto com quebra de linha
 * e alinhamento, linhas e retangulos. Sem imagens — as fotos vao na versao HTML
 * da ficha, que e a que o cliente abre no celular.
 *
 * Codificacao: WinAnsiEncoding. Para os caracteres do portugues (a-z, acentos,
 * cedilha) ela coincide byte a byte com Latin-1, entao a escrita e direta.
 */

export const A4 = { width: 595.28, height: 841.89 } as const;

export type Color = readonly [number, number, number];

export const Colors = {
  ink: [0.11, 0.12, 0.14] as Color,
  muted: [0.42, 0.45, 0.5] as Color,
  accent: [0.05, 0.4, 0.72] as Color,
  hairline: [0.85, 0.87, 0.89] as Color,
  panel: [0.96, 0.97, 0.98] as Color,
  white: [1, 1, 1] as Color,
} as const;

export type TextOptions = {
  readonly x: number;
  readonly y: number;
  readonly size?: number;
  readonly bold?: boolean;
  readonly color?: Color;
  /** Quebra o texto em varias linhas dentro desta largura. */
  readonly maxWidth?: number;
  readonly lineHeight?: number;
  readonly align?: 'left' | 'right' | 'center';
};

export class PdfDocument {
  readonly #pages: string[] = [];
  #current: string[] = [];
  readonly #width: number;
  readonly #height: number;

  constructor(pageSize: { width: number; height: number } = A4) {
    this.#width = pageSize.width;
    this.#height = pageSize.height;
  }

  get pageWidth(): number {
    return this.#width;
  }

  get pageHeight(): number {
    return this.#height;
  }

  addPage(): void {
    this.#pages.push(this.#current.join('\n'));
    this.#current = [];
  }

  /** Desenha texto e devolve o Y da linha de base seguinte. */
  text(value: string, options: TextOptions): number {
    const size = options.size ?? 10;
    const bold = options.bold ?? false;
    const color = options.color ?? Colors.ink;
    const lineHeight = options.lineHeight ?? size * 1.35;
    const font = bold ? '/F2' : '/F1';

    const lines =
      options.maxWidth === undefined
        ? [value]
        : wrapText(value, options.maxWidth, size, bold);

    let y = options.y;
    for (const line of lines) {
      const x = alignedX(line, options, size, bold);
      this.#current.push(
        `${fmt(color[0])} ${fmt(color[1])} ${fmt(color[2])} rg`,
        'BT',
        `${font} ${fmt(size)} Tf`,
        `1 0 0 1 ${fmt(x)} ${fmt(y)} Tm`,
        `(${escapeText(line)}) Tj`,
        'ET',
      );
      y -= lineHeight;
    }
    return y;
  }

  rect(x: number, y: number, width: number, height: number, color: Color): void {
    this.#current.push(
      `${fmt(color[0])} ${fmt(color[1])} ${fmt(color[2])} rg`,
      `${fmt(x)} ${fmt(y)} ${fmt(width)} ${fmt(height)} re f`,
    );
  }

  line(x1: number, y1: number, x2: number, y2: number, color: Color, width = 0.7): void {
    this.#current.push(
      `${fmt(color[0])} ${fmt(color[1])} ${fmt(color[2])} RG`,
      `${fmt(width)} w`,
      `${fmt(x1)} ${fmt(y1)} m ${fmt(x2)} ${fmt(y2)} l S`,
    );
  }

  /** Serializa o documento completo com tabela xref valida. */
  toBuffer(): Buffer {
    const pages = [...this.#pages];
    if (this.#current.length > 0) pages.push(this.#current.join('\n'));
    if (pages.length === 0) pages.push('');

    const objects: Buffer[] = [];
    const fontRegular = 3;
    const fontBold = 4;
    const firstPageObject = 5;

    const pageIds = pages.map((_, index) => firstPageObject + index * 2);
    const kids = pageIds.map((id) => `${id} 0 R`).join(' ');

    objects[1] = buf(`<< /Type /Catalog /Pages 2 0 R >>`);
    objects[2] = buf(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
    objects[fontRegular] = buf(
      `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
    );
    objects[fontBold] = buf(
      `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`,
    );

    pages.forEach((content, index) => {
      const pageId = pageIds[index] as number;
      const contentId = pageId + 1;
      objects[pageId] = buf(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(this.#width)} ${fmt(this.#height)}] ` +
          `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> ` +
          `/Contents ${contentId} 0 R >>`,
      );
      const stream = Buffer.from(content, 'latin1');
      objects[contentId] = Buffer.concat([
        buf(`<< /Length ${stream.length} >>\nstream\n`),
        stream,
        buf(`\nendstream`),
      ]);
    });

    const chunks: Buffer[] = [buf('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n')];
    let offset = chunks[0]?.length ?? 0;
    const offsets: number[] = [];

    const maxId = objects.length - 1;
    for (let id = 1; id <= maxId; id += 1) {
      const body = objects[id];
      if (body === undefined) continue;
      offsets[id] = offset;
      const chunk = Buffer.concat([buf(`${id} 0 obj\n`), body, buf('\nendobj\n')]);
      chunks.push(chunk);
      offset += chunk.length;
    }

    const xrefOffset = offset;
    const xrefLines = ['xref', `0 ${maxId + 1}`, '0000000000 65535 f '];
    for (let id = 1; id <= maxId; id += 1) {
      const entry = offsets[id];
      xrefLines.push(
        entry === undefined
          ? '0000000000 65535 f '
          : `${String(entry).padStart(10, '0')} 00000 n `,
      );
    }
    chunks.push(
      buf(
        `${xrefLines.join('\n')}\ntrailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
      ),
    );

    return Buffer.concat(chunks);
  }
}

function buf(value: string): Buffer {
  return Buffer.from(value, 'latin1');
}

/** Numeros do PDF: no maximo 2 casas, sem notacao cientifica. */
function fmt(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

/** Escapa os tres caracteres com significado dentro de uma string literal PDF. */
function escapeText(value: string): string {
  return toWinAnsi(value).replace(/[\\()]/g, (match) => `\\${match}`);
}

/**
 * Faixa 0x80-0x9F do WinAnsiEncoding, onde ele diverge do Latin-1.
 *
 * Sem este mapa, um travessao ou uma aspa tipografica — que entram no texto
 * sozinhos via copiar-e-colar do anuncio — sairiam como byte lixo no PDF, e o
 * defeito so apareceria na tela do cliente.
 */
const WIN_ANSI_HIGH: ReadonlyMap<string, number> = new Map([
  ['\u20AC', 0x80], ['\u201A', 0x82], ['\u0192', 0x83], ['\u201E', 0x84],
  ['\u2026', 0x85], ['\u2020', 0x86], ['\u2021', 0x87], ['\u02C6', 0x88],
  ['\u2030', 0x89], ['\u0160', 0x8a], ['\u2039', 0x8b], ['\u0152', 0x8c],
  ['\u017D', 0x8e], ['\u2018', 0x91], ['\u2019', 0x92], ['\u201C', 0x93],
  ['\u201D', 0x94], ['\u2022', 0x95], ['\u2013', 0x96], ['\u2014', 0x97],
  ['\u02DC', 0x98], ['\u2122', 0x99], ['\u0161', 0x9a], ['\u203A', 0x9b],
  ['\u0153', 0x9c], ['\u017E', 0x9e], ['\u0178', 0x9f],
]);

/**
 * Converte para uma string em que todo caractere e representavel em
 * WinAnsiEncoding, que e como o PDF sera lido.
 *
 * O que nao existe na tabela e transliterado (removendo o acento) antes de
 * virar '?': melhor "Sao Paulo" do que "S?o Paulo".
 */
export function toWinAnsi(value: string): string {
  let output = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 63;
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) {
      output += char;
      continue;
    }
    const mapped = WIN_ANSI_HIGH.get(char);
    if (mapped !== undefined) {
      output += String.fromCharCode(mapped);
      continue;
    }
    const stripped = char.normalize('NFD').replace(/\p{Diacritic}/gu, '');
    const fallback = stripped.codePointAt(0) ?? 63;
    output += stripped.length > 0 && fallback <= 0xff ? stripped : '?';
  }
  return output;
}

function alignedX(line: string, options: TextOptions, size: number, bold: boolean): number {
  if (options.align === undefined || options.align === 'left') return options.x;
  const width = measureText(line, size, bold);
  if (options.align === 'right') return options.x - width;
  return options.x - width / 2;
}

// ---------------------------------------------------------------------------
// Metrica das fontes
// ---------------------------------------------------------------------------

// Larguras oficiais das Type1 padrao, em milesimos de em (AFM).
const HELVETICA = buildWidths(
  '278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584',
);

const HELVETICA_BOLD = buildWidths(
  '278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 389 280 389 584',
);

function buildWidths(spec: string): number[] {
  const values = spec.split(' ').map(Number);
  const table: number[] = new Array(256).fill(556);
  values.forEach((width, index) => {
    table[32 + index] = width;
  });
  // Acentuados do Latin-1 ficam na largura da letra base correspondente.
  const accented: ReadonlyArray<readonly [number, number, string]> = [
    [0xc0, 0xc5, 'A'],
    [0xc8, 0xcb, 'E'],
    [0xcc, 0xcf, 'I'],
    [0xd2, 0xd6, 'O'],
    [0xd9, 0xdc, 'U'],
    [0xe0, 0xe5, 'a'],
    [0xe8, 0xeb, 'e'],
    [0xec, 0xef, 'i'],
    [0xf2, 0xf6, 'o'],
    [0xf9, 0xfc, 'u'],
  ];
  for (const [from, to, base] of accented) {
    const width = table[base.charCodeAt(0)] ?? 556;
    for (let code = from; code <= to; code += 1) table[code] = width;
  }
  table[0xc7] = table['C'.charCodeAt(0)] ?? 722; // C cedilha
  table[0xe7] = table['c'.charCodeAt(0)] ?? 500; // c cedilha
  table[0xd1] = table['N'.charCodeAt(0)] ?? 722;
  table[0xf1] = table['n'.charCodeAt(0)] ?? 556;
  return table;
}

export function measureText(value: string, size: number, bold = false): number {
  const widths = bold ? HELVETICA_BOLD : HELVETICA;
  let total = 0;
  // Mede o texto ja convertido: e ele que sera desenhado.
  for (const char of toWinAnsi(value)) {
    const code = char.charCodeAt(0);
    total += (code < 256 ? (widths[code] ?? 556) : 556) / 1000;
  }
  return total * size;
}

export function wrapText(value: string, maxWidth: number, size: number, bold = false): string[] {
  const paragraphs = value.split('\n');
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0) {
      lines.push('');
      continue;
    }

    let current = '';
    for (const word of words) {
      const candidate = current === '' ? word : `${current} ${word}`;
      if (measureText(candidate, size, bold) <= maxWidth || current === '') {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current !== '') lines.push(current);
  }

  return lines;
}

/** Corta o texto com reticencias se ele nao couber na largura dada. */
export function truncateText(value: string, maxWidth: number, size: number, bold = false): string {
  if (measureText(value, size, bold) <= maxWidth) return value;
  let truncated = value;
  while (truncated.length > 1 && measureText(`${truncated}...`, size, bold) > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated.trimEnd()}...`;
}
