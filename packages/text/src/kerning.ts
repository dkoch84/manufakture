// Pair kerning from a font's GPOS table, read from the raw bytes.
//
// opentype.js 2.0.0 cannot be used for this: it does not parse Extension
// (type 9) lookups, which is where fonts built with current tools (Inter
// among them) keep their class kerning, and its pair lookup stops at the first
// class subtable that covers the left glyph. This reader follows the OpenType
// spec instead: the `kern` feature of the `latn` script (else `DFLT`, else the
// first script), default language; its lookups in lookup-list order, each
// contributing the first subtable that applies; PairPos formats 1 and 2, inside
// Extension lookups or not. Only the first glyph's x advance is used, which is
// what horizontal left-to-right kerning sets.
//
// Every read goes through a DataView bounded to the table, so a damaged table
// throws a RangeError, which the caller turns into "no kerning".
//
// A hostile table can also make the work multiply without any read going out
// of bounds: a language system listing one feature 65,535 times, a feature
// listing 65,535 lookups, lookup records that all point at one lookup with
// thousands of subtables. Features are therefore read once each (by index and by
// offset), a lookup's subtables are kept once per offset, and the total work
// is capped (`MAX_KERN_LOOKUP_INDEXES`, `MAX_KERN_SUBTABLES`): past a cap the
// reader throws `KerningTooComplex`, and the font is used without kerning, with
// a warning, as for a damaged table. Real fonts are far below the caps (Inter
// Bold: one kern lookup index, a handful of subtables).

import type { SfntTable } from './sfnt';

const PAIR_POS = 2;
const EXTENSION_POS = 9;

/** Most lookup indexes read from the `kern` features, duplicates included. */
export const MAX_KERN_LOOKUP_INDEXES = 1024;
/** Most subtable records read from the kerning lookups, duplicates included. */
export const MAX_KERN_SUBTABLES = 4096;

/** A GPOS table that would take more work to read than any real font's. */
export class KerningTooComplex extends Error {
  constructor(what: string) {
    super(`the kerning table has more ${what} than any real font`);
    this.name = 'KerningTooComplex';
  }
}

/** Bytes a ValueRecord of this format takes: two per set bit of the low byte. */
function valueRecordSize(format: number): number {
  let n = 0;
  for (let bits = format & 0xff; bits; bits >>= 1) n += bits & 1;
  return 2 * n;
}

/** Offset of xAdvance within a ValueRecord, or -1 when the format has none. */
function xAdvanceOffset(format: number): number {
  if (!(format & 0x4)) return -1;
  return 2 * ((format & 0x1) + ((format & 0x2) >> 1));
}

interface PairSubtable {
  /** Absolute offset in the table view. */
  offset: number;
  format: 1 | 2;
}

export interface Kerning {
  /** Kerning between two glyphs, in font units (negative pulls them together). */
  pair(left: number, right: number): number;
  /** Lookups found under the `kern` feature. */
  readonly lookups: number;
}

export const NO_KERNING: Kerning = { pair: () => 0, lookups: 0 };

/** Reads the GPOS pair kerning of a font, or null when it has none. Throws on a damaged table. */
export function readGposKerning(bytes: Uint8Array, table: SfntTable): Kerning | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset + table.offset, table.length);
  const u16 = (o: number) => view.getUint16(o);
  const u32 = (o: number) => view.getUint32(o);
  const tagAt = (o: number) =>
    String.fromCharCode(
      view.getUint8(o),
      view.getUint8(o + 1),
      view.getUint8(o + 2),
      view.getUint8(o + 3),
    );

  const scriptList = u16(4);
  const featureList = u16(6);
  const lookupList = u16(8);

  // The script: latn, else DFLT, else the first.
  const scriptCount = u16(scriptList);
  const scripts = new Map<string, number>();
  for (let i = 0; i < scriptCount; i++) {
    const record = scriptList + 2 + i * 6;
    scripts.set(tagAt(record), scriptList + u16(record + 4));
  }
  const script = scripts.get('latn') ?? scripts.get('DFLT') ?? scripts.values().next().value;
  if (script === undefined) return null;
  const langSysOffset = u16(script);
  if (langSysOffset === 0) return null;
  const langSys = script + langSysOffset;

  // Its `kern` features' lookups, in lookup-list order. Each feature is read
  // once, by index and by offset, however often it is listed.
  const lookupIndexes = new Set<number>();
  const featureCount = u16(featureList);
  const indexCount = u16(langSys + 4);
  const seenFeatures = new Set<number>();
  let indexesRead = 0;
  for (let i = 0; i < indexCount; i++) {
    const featureIndex = u16(langSys + 6 + i * 2);
    if (featureIndex >= featureCount || seenFeatures.has(featureIndex)) continue;
    seenFeatures.add(featureIndex);
    const record = featureList + 2 + featureIndex * 6;
    if (tagAt(record) !== 'kern') continue;
    const feature = featureList + u16(record + 4);
    if (seenFeatures.has(-1 - feature)) continue;
    seenFeatures.add(-1 - feature);
    const lookups = u16(feature + 2);
    indexesRead += lookups;
    if (indexesRead > MAX_KERN_LOOKUP_INDEXES) throw new KerningTooComplex('lookup indexes');
    for (let j = 0; j < lookups; j++) lookupIndexes.add(u16(feature + 4 + j * 2));
  }
  if (lookupIndexes.size === 0) return null;

  // Within a lookup, a subtable is kept once by offset: only the first that
  // applies counts, so a repeat can never contribute. Lookups are not merged by
  // offset (font compilers share identical ones, and each applies); the
  // subtable cap bounds them instead.
  const lookupCount = u16(lookupList);
  const lookups: PairSubtable[][] = [];
  let subtablesRead = 0;
  for (const index of [...lookupIndexes].sort((a, b) => a - b)) {
    if (index >= lookupCount) continue;
    const lookup = lookupList + u16(lookupList + 2 + index * 2);
    const type = u16(lookup);
    if (type !== PAIR_POS && type !== EXTENSION_POS) continue;
    const subtableCount = u16(lookup + 4);
    subtablesRead += subtableCount;
    if (subtablesRead > MAX_KERN_SUBTABLES) throw new KerningTooComplex('subtables');
    const subtables: PairSubtable[] = [];
    const seenSubtables = new Set<number>();
    for (let s = 0; s < subtableCount; s++) {
      let offset = lookup + u16(lookup + 6 + s * 2);
      if (type === EXTENSION_POS) {
        if (u16(offset + 2) !== PAIR_POS) continue;
        offset += u32(offset + 4);
      }
      if (seenSubtables.has(offset)) continue;
      seenSubtables.add(offset);
      const format = u16(offset);
      if (format === 1 || format === 2) subtables.push({ offset, format });
    }
    if (subtables.length > 0) lookups.push(subtables);
  }
  if (lookups.length === 0) return null;

  /** Coverage index of a glyph, or -1. */
  const coverage = (offset: number, glyph: number): number => {
    const format = u16(offset);
    const count = u16(offset + 2);
    let lo = 0;
    let hi = count - 1;
    if (format === 1) {
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const g = u16(offset + 4 + mid * 2);
        if (g === glyph) return mid;
        if (g < glyph) lo = mid + 1;
        else hi = mid - 1;
      }
      return -1;
    }
    if (format === 2) {
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const range = offset + 4 + mid * 6;
        if (glyph < u16(range)) hi = mid - 1;
        else if (glyph > u16(range + 2)) lo = mid + 1;
        else return u16(range + 4) + glyph - u16(range);
      }
      return -1;
    }
    return -1;
  };

  /** Class of a glyph in a ClassDef (0 when unlisted). */
  const glyphClass = (offset: number, glyph: number): number => {
    const format = u16(offset);
    if (format === 1) {
      const start = u16(offset + 2);
      const count = u16(offset + 4);
      return glyph >= start && glyph < start + count ? u16(offset + 6 + (glyph - start) * 2) : 0;
    }
    if (format === 2) {
      let lo = 0;
      let hi = u16(offset + 2) - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const range = offset + 4 + mid * 6;
        if (glyph < u16(range)) hi = mid - 1;
        else if (glyph > u16(range + 2)) lo = mid + 1;
        else return u16(range + 4);
      }
    }
    return 0;
  };

  /** The subtable's x advance for the pair, or null when it does not apply. */
  const apply = (subtable: PairSubtable, left: number, right: number): number | null => {
    const { offset, format } = subtable;
    const covered = coverage(offset + u16(offset + 2), left);
    if (covered < 0) return null;
    const format1 = u16(offset + 4);
    const format2 = u16(offset + 6);
    const advance = xAdvanceOffset(format1);
    const recordSize = valueRecordSize(format1) + valueRecordSize(format2);
    if (format === 1) {
      if (covered >= u16(offset + 8)) return null;
      const pairSet = offset + u16(offset + 10 + covered * 2);
      const stride = 2 + recordSize;
      let lo = 0;
      let hi = u16(pairSet) - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const record = pairSet + 2 + mid * stride;
        const second = u16(record);
        if (second === right) return advance < 0 ? 0 : view.getInt16(record + 2 + advance);
        if (second < right) lo = mid + 1;
        else hi = mid - 1;
      }
      return null;
    }
    const class1 = glyphClass(offset + u16(offset + 8), left);
    const class2 = glyphClass(offset + u16(offset + 10), right);
    const class1Count = u16(offset + 12);
    const class2Count = u16(offset + 14);
    if (class1 >= class1Count || class2 >= class2Count) return null;
    if (advance < 0) return 0;
    return view.getInt16(offset + 16 + (class1 * class2Count + class2) * recordSize + advance);
  };

  const cache = new Map<number, number>();
  return {
    lookups: lookups.length,
    pair(left, right) {
      const key = left * 65536 + right;
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      let total = 0;
      for (const subtables of lookups) {
        for (const subtable of subtables) {
          const value = apply(subtable, left, right);
          if (value !== null) {
            total += value;
            break;
          }
        }
      }
      cache.set(key, total);
      return total;
    },
  };
}
