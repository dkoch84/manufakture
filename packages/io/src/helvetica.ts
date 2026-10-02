// Helvetica, one of the PDF standard 14 fonts: every PDF reader has it (or a metric-compatible
// substitute), so a PDF that uses it needs no embedded font and no font license. Here: its
// WinAnsiEncoding (Windows-1252) byte for a Unicode character, and its advance widths from
// Adobe's Helvetica AFM (1000 units per em), for anchoring text by its width.

/** Helvetica's cap height, in ems (AFM `CapHeight 718`). Font size = cap height / this. */
export const HELVETICA_CAP_HEIGHT = 0.718;

/** How far Helvetica's descenders reach below the baseline, in ems (AFM `Descender -207`). */
export const HELVETICA_DESCENT = 0.207;

// Widths of bytes 32 to 126 (ASCII), in AFM order.
// prettier-ignore
const ASCII_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // space to /
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 0 to ?
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // @ to O
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // P to _
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // ` to o
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, // p to ~
];

// Widths of bytes 160 to 255 (Latin-1, the same in Windows-1252).
// prettier-ignore
const LATIN1_WIDTHS = [
  278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, // nbsp to macron
  400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611, // degree to inverted ?
  667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, // A grave to I diaeresis
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, // Eth to sharp s
  556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278, // a grave to i diaeresis
  556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500, // eth to y diaeresis
];

// Windows-1252's bytes 128 to 159 that hold characters: [byte, Unicode code point, width].
// prettier-ignore
const CP1252_EXTRA: readonly (readonly [number, number, number])[] = [
  [0x80, 0x20ac, 556], [0x82, 0x201a, 222], [0x83, 0x0192, 556], [0x84, 0x201e, 333],
  [0x85, 0x2026, 1000], [0x86, 0x2020, 556], [0x87, 0x2021, 556], [0x88, 0x02c6, 333],
  [0x89, 0x2030, 1000], [0x8a, 0x0160, 667], [0x8b, 0x2039, 333], [0x8c, 0x0152, 1000],
  [0x8e, 0x017d, 611], [0x91, 0x2018, 222], [0x92, 0x2019, 222], [0x93, 0x201c, 333],
  [0x94, 0x201d, 333], [0x95, 0x2022, 350], [0x96, 0x2013, 556], [0x97, 0x2014, 1000],
  [0x98, 0x02dc, 333], [0x99, 0x2122, 1000], [0x9a, 0x0161, 500], [0x9b, 0x203a, 333],
  [0x9c, 0x0153, 944], [0x9e, 0x017e, 500], [0x9f, 0x0178, 667],
];

const EXTRA_BY_CODE_POINT = new Map(CP1252_EXTRA.map(([byte, cp]) => [cp, byte]));
const EXTRA_WIDTH = new Map(CP1252_EXTRA.map(([byte, , w]) => [byte, w]));

/** The byte that stands for '?', used for characters Windows-1252 does not have. */
const REPLACEMENT = 0x3f;

/**
 * Text as WinAnsiEncoding bytes. Characters outside Windows-1252 become `?`; so do controls.
 * Tabs become spaces.
 */
export function winAnsiBytes(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x09) out.push(0x20);
    else if (cp >= 0x20 && cp <= 0x7e) out.push(cp);
    else if (cp >= 0xa0 && cp <= 0xff) out.push(cp);
    else out.push(EXTRA_BY_CODE_POINT.get(cp) ?? REPLACEMENT);
  }
  return out;
}

/** Advance width of a WinAnsi byte, in thousandths of an em. */
export function helveticaWidth(byte: number): number {
  if (byte >= 32 && byte <= 126) return ASCII_WIDTHS[byte - 32]!;
  if (byte >= 160 && byte <= 255) return LATIN1_WIDTHS[byte - 160]!;
  return EXTRA_WIDTH.get(byte) ?? ASCII_WIDTHS[REPLACEMENT - 32]!;
}

/** Width of `text` set in Helvetica at `fontSize`, in the units of `fontSize`. */
export function helveticaTextWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const b of winAnsiBytes(text)) w += helveticaWidth(b);
  return (w / 1000) * fontSize;
}
