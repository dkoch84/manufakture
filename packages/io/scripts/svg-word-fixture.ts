// The SVG word fixture (M5 T5.8): a whole word of sign lettering as an SVG of paths, the way a
// drawing program saves text converted to paths, for the SVG import's end-to-end check
// (`apps/web/e2e/svg-import.spec.ts`). Each glyph of Inter Bold (packages/text/fonts, SIL OFL
// 1.1) is one <path> of the font's own quadratic outline commands in font units, placed by a
// transform that scales it to a 20 mm cap height and flips it (font units run y up, SVG y
// down). Glyphs are spaced by their advance widths, without kerning, so none overlap.
//
//   node scripts/svg-word-fixture.ts          (from packages/io) writes src/fixtures/svg/word.svg
//
// Plain Node (type stripping); opentype.js is resolved from packages/text, which ships it.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

export const WORD = 'WOODSHOP';
export const CAP_HEIGHT_MM = 20;
const MARGIN_MM = 5;

interface FontCommand {
  type: 'M' | 'L' | 'Q' | 'C' | 'Z';
  x: number;
  y: number;
  x1: number;
  y1: number;
}
interface Opentype {
  parse(buffer: ArrayBuffer): {
    tables: { os2: { sCapHeight: number } };
    charToGlyph(c: string): { advanceWidth: number; path: { commands: FontCommand[] } };
  };
}

const textDir = new URL('../../text/', import.meta.url);
const opentype = createRequire(new URL('package.json', textDir))('opentype.js') as Opentype;
const bytes = readFileSync(new URL('fonts/Inter-Bold.ttf', textDir));
const font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));

const s = CAP_HEIGHT_MM / font.tables.os2.sCapHeight;
const n = (v: number) => String(Math.round(v * 1000) / 1000);
const paths: string[] = [];
let x = MARGIN_MM;
for (const c of WORD) {
  const glyph = font.charToGlyph(c);
  const d = glyph.path.commands
    .map((k) => {
      switch (k.type) {
        case 'M':
        case 'L':
          return `${k.type}${n(k.x)} ${n(k.y)}`;
        case 'Q':
          return `Q${n(k.x1)} ${n(k.y1)} ${n(k.x)} ${n(k.y)}`;
        case 'Z':
          return 'Z';
        default:
          throw new Error('Inter Bold has quadratic outlines only');
      }
    })
    .join('');
  paths.push(
    `  <path id="glyph-${paths.length}" transform="translate(${n(x)} ${n(MARGIN_MM + CAP_HEIGHT_MM)}) scale(${s} -${s})" d="${d}"/>`,
  );
  x += glyph.advanceWidth * s;
}
const width = n(x + MARGIN_MM);
const height = n(CAP_HEIGHT_MM + 2 * MARGIN_MM);
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<!-- "${WORD}" in Inter Bold (SIL Open Font License 1.1), converted to paths: written by
     packages/io/scripts/svg-word-fixture.ts. One user unit is one millimetre. -->
<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}">
${paths.join('\n')}
</svg>
`;
writeFileSync(new URL('../src/fixtures/svg/word.svg', import.meta.url), svg);
console.log(`wrote word.svg: ${WORD}, ${paths.length} glyphs, ${width} x ${height} mm`);
