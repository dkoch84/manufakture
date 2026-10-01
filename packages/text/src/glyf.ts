// How much work a TrueType glyph's outline is, read from the raw `glyf` and
// `loca` bytes before opentype.js builds its path.
//
// opentype.js expands a composite glyph by copying every component's points,
// recursively, so a few hundred bytes of nested composites (a glyph of K
// references to a glyph of K references to ...) cost K^depth points: K = 300
// three levels deep runs V8 out of memory. And for a simple glyph it looks up
// every point in the list of contour ends, so its cost is points times
// contours. And it appends each component with `points.concat(...)`, which
// copies every point gathered so far, so a composite costs the sum of its
// running totals (a big simple glyph followed by many empty components is
// quadratic). This walk counts all three from the glyph headers and component
// records alone, memoised per glyph, so it costs at most one pass over each
// glyph's header, whatever the nesting. `checkGlyph` says whether a glyph is within
// the caps below; `loadFont` refuses (FontError `malformed`) any glyph that is
// not, before opentype.js touches it.
//
// Every read is bounded to the tables, so a damaged table throws a RangeError,
// which counts as a problem too.

import type { SfntTable } from './sfnt';

/** Deepest component nesting accepted (a composite of a composite is depth 2). */
export const MAX_COMPONENT_DEPTH = 8;
/** Most points and contours one glyph may expand to, components included. */
export const MAX_GLYPH_POINTS = 100_000;
/**
 * Most point-by-contour work one glyph may take to parse (opentype.js checks
 * every point against every contour end), components included, plus the points
 * copied while appending components.
 */
export const MAX_GLYPH_SCAN = 10_000_000;

const ARG_1_AND_2_ARE_WORDS = 0x1;
const WE_HAVE_A_SCALE = 0x8;
const MORE_COMPONENTS = 0x20;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x40;
const WE_HAVE_A_TWO_BY_TWO = 0x80;

interface Cost {
  /** Points plus contours after expanding components. */
  points: number;
  /**
   * Points times contours of every simple glyph, once per use, plus the running
   * point total copied for every component appended.
   */
  scan: number;
  /** 1 for a simple glyph, one more than its deepest component for a composite. */
  depth: number;
}

/** Thrown inside the walk; `checkGlyph` turns it into a message. */
class TooComplex extends Error {}

export type GlyphCheck = (index: number) => string | null;

/**
 * A checker for one font's glyphs: null when the glyph is within the caps,
 * else why not. `bytes` is the whole font file.
 */
export function glyphChecker(
  bytes: Uint8Array,
  tables: ReadonlyMap<string, SfntTable>,
): GlyphCheck {
  const glyf = tables.get('glyf');
  const loca = tables.get('loca');
  const head = tables.get('head');
  const maxp = tables.get('maxp');
  if (!glyf || !loca || !head || !maxp) return () => null;
  const view = (t: SfntTable) => new DataView(bytes.buffer, bytes.byteOffset + t.offset, t.length);
  const glyfView = view(glyf);
  const locaView = view(loca);
  const costs = new Map<number, Cost>();
  /** Glyphs being expanded, to catch a component cycle. */
  const open = new Set<number>();
  let longLoca = false;
  let numGlyphs = 0;
  let setupError: string | null = null;
  try {
    longLoca = view(head).getInt16(50) !== 0;
    numGlyphs = view(maxp).getUint16(4);
  } catch {
    setupError = 'its head or maxp table is damaged';
  }

  const glyphRange = (index: number): [number, number] => {
    const start = longLoca ? locaView.getUint32(index * 4) : locaView.getUint16(index * 2) * 2;
    const end = longLoca
      ? locaView.getUint32(index * 4 + 4)
      : locaView.getUint16(index * 2 + 2) * 2;
    if (end < start || end > glyf.length) throw new RangeError('glyph outside the glyf table');
    return [start, end];
  };

  const cost = (index: number, depth: number): Cost => {
    const known = costs.get(index);
    if (known) {
      if (depth + known.depth - 1 > MAX_COMPONENT_DEPTH) throw new TooComplex('depth');
      return known;
    }
    if (index >= numGlyphs) throw new RangeError(`component glyph ${index} does not exist`);
    if (depth > MAX_COMPONENT_DEPTH) throw new TooComplex('depth');
    if (open.has(index)) throw new RangeError('a composite glyph contains itself');
    const [start, end] = glyphRange(index);
    let result: Cost;
    if (end === start) {
      result = { points: 0, scan: 0, depth: 1 };
    } else {
      const contours = glyfView.getInt16(start);
      if (contours >= 0) {
        const points = contours > 0 ? glyfView.getUint16(start + 10 + (contours - 1) * 2) + 1 : 0;
        result = { points: points + contours, scan: points * contours, depth: 1 };
      } else {
        open.add(index);
        result = { points: 0, scan: 0, depth: 1 };
        let at = start + 10;
        for (;;) {
          const flags = glyfView.getUint16(at);
          const child = cost(glyfView.getUint16(at + 2), depth + 1);
          result.points += child.points;
          result.scan += child.scan;
          // opentype.js concat copies the running total per component, so charge the
          // points expanded so far (this component's included) plus one for the call.
          result.scan += result.points + 1;
          result.depth = Math.max(result.depth, child.depth + 1);
          if (result.points > MAX_GLYPH_POINTS || result.scan > MAX_GLYPH_SCAN) {
            throw new TooComplex('points');
          }
          at += 4 + (flags & ARG_1_AND_2_ARE_WORDS ? 4 : 2);
          if (flags & WE_HAVE_A_SCALE) at += 2;
          else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) at += 4;
          else if (flags & WE_HAVE_A_TWO_BY_TWO) at += 8;
          if (!(flags & MORE_COMPONENTS)) break;
          if (at >= end) throw new RangeError('component records run past the glyph');
        }
        open.delete(index);
      }
    }
    if (result.points > MAX_GLYPH_POINTS || result.scan > MAX_GLYPH_SCAN) {
      throw new TooComplex('points');
    }
    costs.set(index, result);
    return result;
  };

  return (index) => {
    if (setupError) return setupError;
    open.clear();
    try {
      cost(index, 1);
      return null;
    } catch (error) {
      if (error instanceof TooComplex) {
        return error.message === 'depth'
          ? `its components nest more than ${MAX_COMPONENT_DEPTH} deep`
          : 'it has more points than any real glyph';
      }
      return error instanceof Error ? error.message : String(error);
    }
  };
}
