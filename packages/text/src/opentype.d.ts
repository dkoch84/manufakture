// The part of opentype.js 2.0.0's API this package uses. The package ships no
// type declarations; these are written from its source (`dist/opentype.mjs`).

declare module 'opentype.js' {
  export type PathCommand =
    | { type: 'M'; x: number; y: number }
    | { type: 'L'; x: number; y: number }
    | { type: 'Q'; x1: number; y1: number; x: number; y: number }
    | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
    | { type: 'Z' };

  export interface Path {
    commands: PathCommand[];
  }

  export interface BoundingBox {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }

  export interface Glyph {
    index: number;
    name: string | null;
    advanceWidth: number | undefined;
    /** Outline in font units, y up. */
    readonly path: Path;
    getBoundingBox(): BoundingBox;
  }

  export interface Os2Table {
    version: number;
    fsType: number;
    fsSelection: number;
    sCapHeight?: number;
    sxHeight?: number;
    sTypoAscender: number;
    sTypoDescender: number;
    sTypoLineGap: number;
  }

  export interface HheaTable {
    ascender: number;
    descender: number;
    lineGap: number;
  }

  export interface Font {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    numGlyphs: number;
    outlinesFormat: 'truetype' | 'cff' | string;
    tables: {
      os2?: Os2Table;
      hhea?: HheaTable;
      fvar?: unknown;
      [name: string]: unknown;
    };
    /** Pairs from the legacy `kern` table, keyed `"<left>,<right>"` by glyph index. */
    kerningPairs: Record<string, number>;
    charToGlyph(char: string): Glyph;
    getEnglishName(name: string): string | undefined;
  }

  export function parse(buffer: ArrayBuffer, options?: { lowMemory?: boolean }): Font;
}
