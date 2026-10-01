// Loading a font: the bundled one or a user's TTF or OTF file.
//
// User fonts are attack surface (ADR 0011, decision 7): the bytes are checked
// for size and shape before opentype.js sees them, the parse runs inside a
// try/catch, and every failure is a `FontError` with a code and a message a
// user can act on. Callers parse in a worker, never on the main thread, with
// a time limit (see the README): what the checks here cannot bound (CFF
// subroutine fan-out) only the worker's watchdog can.

import { parse, type Font as OpentypeFont, type Glyph } from 'opentype.js';
import { glyphChecker } from './glyf';
import { NO_KERNING, readGposKerning, type Kerning } from './kerning';
import { readSfnt } from './sfnt';

/** Largest font file accepted, as for imported files (core's `MAX_IMPORT_BYTES`, 20 MiB). */
export const MAX_FONT_BYTES = 20 * 1024 * 1024;

export type FontErrorCode =
  'empty' | 'too-large' | 'unsupported-format' | 'malformed' | 'no-outlines';

export class FontError extends Error {
  readonly code: FontErrorCode;
  constructor(code: FontErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FontError';
    this.code = code;
  }
}

/** OS/2 `fsType` embedding permissions, as ADR 0011 decision 7 shows them. */
export interface EmbeddingPermissions {
  /** The usage level: bits 1 to 3; the least restrictive wins when several are set. */
  level: 'installable' | 'restricted' | 'preview-and-print' | 'editable';
  /** Bit 8: the font may not be subsetted before embedding. */
  noSubsetting: boolean;
  /** Bit 9: only bitmaps may be embedded. */
  bitmapOnly: boolean;
  /**
   * Restricted, or preview and print: storing the font in a document that is
   * shared may not be allowed by its license, which the app warns about.
   */
  restrictive: boolean;
}

export interface FontInfo {
  /** The typographic family (name 16), else the family (name 1). */
  family: string;
  /** The typographic style (name 17), else the subfamily (name 2). */
  style: string;
  fullName?: string;
  /** Name 5. */
  version?: string;
  /** Name 0. */
  copyright?: string;
  /** Name 13. */
  license?: string;
  /** Name 14. */
  licenseUrl?: string;
  /** OS/2 `fsType`, as stored. */
  fsType: number;
  embedding: EmbeddingPermissions;
  outlines: 'truetype' | 'cff';
  /** A variable font; it is used at its default instance. */
  variable: boolean;
  unitsPerEm: number;
  glyphCount: number;
}

export function embeddingPermissions(fsType: number): EmbeddingPermissions {
  const level: EmbeddingPermissions['level'] =
    fsType & 0x8
      ? 'editable'
      : fsType & 0x4
        ? 'preview-and-print'
        : fsType & 0x2
          ? 'restricted'
          : 'installable';
  return {
    level,
    noSubsetting: (fsType & 0x100) !== 0,
    bitmapOnly: (fsType & 0x200) !== 0,
    restrictive: level === 'restricted' || level === 'preview-and-print',
  };
}

/** A parsed font, ready for `layoutText`. */
export interface LoadedFont {
  readonly info: FontInfo;
  /** Cap height in font units: OS/2 `sCapHeight`, else the height of "H", else 0.7 em. */
  readonly capHeight: number;
  /** Baseline-to-baseline distance in font units (ascender - descender + line gap). */
  readonly lineHeight: number;
  /** Non-fatal problems met while loading (a kerning table that could not be read). */
  readonly warnings: string[];
  /**
   * The glyph for one character (a code point), or null when the font has none.
   * Throws a `FontError` (`malformed`) for a TrueType glyph whose outline is
   * damaged or bigger than any real glyph's (components nested more than 8
   * deep, more than 100,000 points): checked here, before its path is built.
   */
  glyph(char: string): Glyph | null;
  /** Kerning between two glyph indices, in font units. */
  kerning(left: number, right: number): number;
}

const USE_TYPO_METRICS = 0x80;

/**
 * Tables opentype.js is not given. Layout tables: this package reads kerning
 * from GPOS itself and applies no substitutions, and opentype.js 2.0.0 parses
 * them eagerly and throws on lookups it does not know (Inter's GSUB has one),
 * which would refuse a font whose outlines are fine. Variation tables: a
 * variable font is used at its default instance, which is what `glyf` holds.
 * Colour and SVG tables: outlines only. Fewer tables parsed is also less of
 * the parser exposed to a hostile file.
 */
const HIDDEN_TABLES = [
  'GSUB',
  'GPOS',
  'GDEF',
  'JSTF',
  'BASE',
  'MATH',
  'fvar',
  'gvar',
  'avar',
  'cvar',
  'HVAR',
  'VVAR',
  'MVAR',
  'STAT',
  'COLR',
  'CPAL',
  'SVG ',
  'meta',
];

/** Renames hidden tables in the directory (first letter to `_`, which no real tag uses), so parsers skip them. */
function hideTables(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4);
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16;
    const tag = String.fromCharCode(...bytes.subarray(record, record + 4));
    if (HIDDEN_TABLES.includes(tag)) bytes[record] = 0x5f;
  }
}

/**
 * Parses a TTF or OTF file. Throws a `FontError` for anything it cannot use:
 * an empty or oversized file, a collection or web font, a damaged file, or a
 * font without outlines.
 */
export function loadFont(
  data: ArrayBuffer | Uint8Array,
  options: { maxBytes?: number } = {},
): LoadedFont {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const maxBytes = options.maxBytes ?? MAX_FONT_BYTES;
  if (bytes.byteLength === 0) throw new FontError('empty', 'The font file is empty.');
  if (bytes.byteLength > maxBytes) {
    throw new FontError(
      'too-large',
      `The font file is ${(bytes.byteLength / 1048576).toFixed(1)} MiB; the limit is ${(maxBytes / 1048576).toFixed(0)} MiB.`,
    );
  }
  const sfnt = readSfnt(bytes);
  if ('code' in sfnt) throw new FontError(sfnt.code, sfnt.message);

  let font: OpentypeFont;
  try {
    // A private copy: opentype.js keeps views into the buffer it is given, and
    // the tables it should not read are hidden in the copy's directory.
    const copy = bytes.slice();
    hideTables(copy);
    font = parse(copy.buffer, { lowMemory: true });
  } catch (error) {
    throw new FontError('malformed', `The font file could not be read: ${describe(error)}`, {
      cause: error,
    });
  }

  // Without a `post` table opentype.js 2.0.0 has no glyph name list, and every
  // lazy glyph lookup throws on it, so no character would map. Glyph names are
  // not used here: an empty list lets the cmap work.
  const parsed = font as unknown as { glyphNames?: object };
  if (!parsed.glyphNames) parsed.glyphNames = {};

  const unitsPerEm = font.unitsPerEm;
  if (!Number.isFinite(unitsPerEm) || unitsPerEm < 16 || unitsPerEm > 16384) {
    throw new FontError('malformed', `The font's units per em (${unitsPerEm}) is out of range.`);
  }
  if (!(font.numGlyphs > 0)) throw new FontError('malformed', 'The font has no glyphs.');

  const warnings: string[] = [];
  let kerning: Kerning = NO_KERNING;
  const gpos = sfnt.tables.get('GPOS');
  try {
    kerning = (gpos && readGposKerning(bytes, gpos)) ?? NO_KERNING;
  } catch (error) {
    warnings.push(`The font's GPOS kerning could not be read and is not used: ${describe(error)}`);
  }
  const legacyPairs = kerning === NO_KERNING ? font.kerningPairs : undefined;

  const name = (key: string): string | undefined => {
    try {
      const value = font.getEnglishName(key);
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const os2 = font.tables.os2;
  const fsType = os2?.fsType ?? 0;
  const info: FontInfo = {
    family: name('preferredFamily') ?? name('fontFamily') ?? 'Unnamed font',
    style: name('preferredSubfamily') ?? name('fontSubfamily') ?? 'Regular',
    fsType,
    embedding: embeddingPermissions(fsType),
    outlines: sfnt.flavor,
    variable: sfnt.tables.has('fvar'),
    unitsPerEm,
    glyphCount: font.numGlyphs,
  };
  const optional = {
    fullName: name('fullName'),
    version: name('version'),
    copyright: name('copyright'),
    license: name('license'),
    licenseUrl: name('licenseURL'),
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) Object.assign(info, { [key]: value });
  }

  const check = sfnt.flavor === 'truetype' ? glyphChecker(bytes, sfnt.tables) : () => null;
  const glyph = (char: string): Glyph | null => {
    let g: Glyph | null;
    try {
      g = font.charToGlyph(char);
    } catch {
      return null;
    }
    if (!g || !(g.index > 0)) return null;
    const problem = check(g.index);
    if (problem) {
      throw new FontError(
        'malformed',
        `The font's glyph for "${char}" could not be read: ${problem}.`,
      );
    }
    return g;
  };

  let capHeight = os2 && os2.version >= 2 && (os2.sCapHeight ?? 0) > 0 ? os2.sCapHeight! : 0;
  if (!capHeight) {
    try {
      capHeight = glyph('H')?.getBoundingBox().y2 ?? 0;
    } catch (error) {
      warnings.push(`The font's "H" could not be read for the cap height: ${describe(error)}`);
      capHeight = 0;
    }
  }
  if (!(capHeight > 0)) capHeight = 0.7 * unitsPerEm;

  const typo = os2 && os2.fsSelection & USE_TYPO_METRICS;
  const hhea = font.tables.hhea;
  const lineHeight = typo
    ? os2.sTypoAscender - os2.sTypoDescender + os2.sTypoLineGap
    : (hhea?.ascender ?? font.ascender) -
      (hhea?.descender ?? font.descender) +
      (hhea?.lineGap ?? 0);

  let kerningBroken = false;
  return {
    info,
    capHeight,
    lineHeight: lineHeight > 0 ? lineHeight : 1.2 * unitsPerEm,
    warnings,
    glyph,
    kerning(left, right) {
      if (legacyPairs) return legacyPairs[`${left},${right}`] ?? 0;
      if (kerningBroken) return 0;
      try {
        return kerning.pair(left, right);
      } catch (error) {
        kerningBroken = true;
        warnings.push(`The font's GPOS kerning is damaged and is not used: ${describe(error)}`);
        return 0;
      }
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Lower-case hex SHA-256 of a font file, as documents record it (ADR 0011). */
export async function fontSha256(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
