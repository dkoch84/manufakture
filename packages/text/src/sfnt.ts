// The outer shape of a font file, read before handing it to opentype.js: what
// kind of file it is and where its tables are. Every offset is checked against
// the file, so a truncated or hostile file fails here with a clear message
// rather than somewhere inside the parser.
//
// The character map gets a closer look. opentype.js expands every range of
// every cmap subtable it reads into one map entry per code point, so a range
// of a few bytes can cost it seconds (measured: one damaged byte, 3 s) and a
// hostile file far more. The ranges are summed here first and a map larger
// than any real font's is refused.

export type SfntFlavor = 'truetype' | 'cff';

export interface SfntTable {
  offset: number;
  length: number;
}

export interface Sfnt {
  flavor: SfntFlavor;
  tables: Map<string, SfntTable>;
}

/**
 * Most code points one cmap subtable may map (summed over its ranges): four
 * times the Basic Multilingual Plane, above the largest pan-Unicode fonts.
 */
export const MAX_CMAP_CODE_POINTS = 0x40000;

/** Why a file is not a font this package reads; `FontError` carries it. */
export type SfntProblem =
  | { code: 'unsupported-format'; message: string }
  | { code: 'malformed'; message: string }
  | { code: 'no-outlines'; message: string };

const tag = (view: DataView, offset: number) =>
  String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );

/** Reads the sfnt header and table directory, or says why it cannot. */
export function readSfnt(bytes: Uint8Array): Sfnt | SfntProblem {
  if (bytes.byteLength < 12) {
    return { code: 'malformed', message: 'The file is too short to be a font.' };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = tag(view, 0);
  let flavor: SfntFlavor;
  if (signature === '\0\x01\0\0' || signature === 'true') flavor = 'truetype';
  else if (signature === 'OTTO') flavor = 'cff';
  else if (signature === 'ttcf') {
    return {
      code: 'unsupported-format',
      message: 'Font collections (.ttc) are not supported; add one TTF or OTF font file.',
    };
  } else if (signature === 'wOFF' || signature === 'wOF2') {
    return {
      code: 'unsupported-format',
      message: 'WOFF and WOFF2 web fonts are not supported; add the TTF or OTF font file.',
    };
  } else {
    return { code: 'unsupported-format', message: 'The file is not a TrueType or OpenType font.' };
  }

  const numTables = view.getUint16(4);
  if (numTables === 0 || 12 + numTables * 16 > bytes.byteLength) {
    return { code: 'malformed', message: 'The font table directory is damaged.' };
  }
  const tables = new Map<string, SfntTable>();
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16;
    const name = tag(view, record);
    const offset = view.getUint32(record + 8);
    const length = view.getUint32(record + 12);
    if (offset + length > bytes.byteLength) {
      return {
        code: 'malformed',
        message: `The font's "${name.trim()}" table runs past the end of the file.`,
      };
    }
    tables.set(name, { offset, length });
  }

  for (const required of ['cmap', 'head', 'hhea', 'hmtx', 'maxp']) {
    if (!tables.has(required)) {
      return { code: 'malformed', message: `The font has no "${required}" table.` };
    }
  }
  const outlines =
    (tables.has('glyf') && tables.has('loca')) || tables.has('CFF ') || tables.has('CFF2');
  if (!outlines) {
    return {
      code: 'no-outlines',
      message: 'The font has no glyph outlines (a bitmap-only font); text needs outlines.',
    };
  }
  const cmap = checkCmap(bytes, tables.get('cmap')!);
  if (cmap) return { code: 'malformed', message: cmap };
  return { flavor, tables };
}

/** Bounds and sizes of every cmap subtable; a message when one is damaged or too large. */
function checkCmap(bytes: Uint8Array, table: SfntTable): string | null {
  const damaged = "The font's character map (cmap) is damaged.";
  const tooLarge = "The font's character map (cmap) maps more characters than any real font.";
  const view = new DataView(bytes.buffer, bytes.byteOffset + table.offset, table.length);
  const size = table.length;
  try {
    const count = view.getUint16(2);
    if (4 + count * 8 > size) return damaged;
    for (let i = 0; i < count; i++) {
      const at = view.getUint32(4 + i * 8 + 4);
      if (at + 2 > size) return damaged;
      const format = view.getUint16(at);
      let total = 0;
      if (format === 4) {
        const segments = view.getUint16(at + 6) >> 1;
        if (at + 16 + segments * 8 > size) return damaged;
        for (let k = 0; k < segments; k++) {
          const end = view.getUint16(at + 14 + k * 2);
          const start = view.getUint16(at + 16 + segments * 2 + k * 2);
          if (start <= end) total += end - start + 1;
        }
      } else if (format === 12 || format === 13) {
        const groups = view.getUint32(at + 12);
        if (at + 16 + groups * 12 > size) return damaged;
        for (let k = 0; k < groups; k++) {
          const start = view.getUint32(at + 16 + k * 12);
          const end = view.getUint32(at + 20 + k * 12);
          if (start > end || end > 0x10ffff) return damaged;
          total += end - start + 1;
          if (total > MAX_CMAP_CODE_POINTS) return tooLarge;
        }
      } else if (format === 14) {
        const records = view.getUint32(at + 6);
        if (at + 10 + records * 11 > size) return damaged;
        for (let k = 0; k < records; k++) {
          const record = at + 10 + k * 11;
          for (const list of [view.getUint32(record + 3), view.getUint32(record + 7)]) {
            if (list === 0) continue;
            if (at + list + 4 > size) return damaged;
            total += view.getUint32(at + list);
            if (total > MAX_CMAP_CODE_POINTS) return tooLarge;
          }
        }
      }
      if (total > MAX_CMAP_CODE_POINTS) return tooLarge;
    }
  } catch {
    return damaged;
  }
  return null;
}
