// SVG import (M5 T5.8): an SVG file's shapes for sketch geometry (sign artwork, lettering
// converted to paths), in millimetres with y up. `parseSvg` reads the file once into shapes
// (path commands with their transforms and fill rules); from those, `svgOutlinePaths` gives
// paths of lines and Beziers for a sketch's `svg` outline (exact, elliptical arcs as cubics
// within a tolerance), and `fitSvg` gives lines, circular arcs and circles for sketch entities
// (Beziers and ellipses approximated by arcs within a tolerance; circles stay circles).
//
// No DOM: a small XML reader here parses the file, so this runs the same on the main thread, in
// a worker and in Node. The file is untrusted, so the input, the nesting, the work of walking
// it (`<use>` fan-out included), the commands and the output are bounded, and anything that is
// not finite is dropped (see the README's "SVG import").

import type { Vec2 } from './path2';

/** Default largest distance (mm) between an imported curve and the arcs that replace it. */
export const DEFAULT_SVG_TOLERANCE = 0.01;
/** Larger files are refused before parsing (characters of the text). */
export const MAX_SVG_CHARS = 32 * 1024 * 1024;
/** More elements than this are refused. */
export const MAX_SVG_ELEMENTS = 200_000;
/** Default cap on the lines and arcs an import may make. */
export const MAX_SVG_SEGMENTS = 100_000;
/** Deepest element nesting accepted (the XML's, and the walk's through `<use>`). */
export const MAX_SVG_DEPTH = 256;
/**
 * Elements the walk may visit, `<use>` instances counted each time: a file of nested `<use>`
 * fans out exponentially, and this stops it whatever its leaves make.
 */
export const MAX_SVG_VISITS = 4 * MAX_SVG_ELEMENTS;
/** Most path commands the shapes of a file may have in all, `<use>` instances counted. */
export const MAX_SVG_COMMANDS = 1_000_000;
/** Default largest distance (mm) between an elliptical arc and the cubics of an outline path. */
export const DEFAULT_SVG_OUTLINE_TOLERANCE = 0.001;

/** CSS pixels per inch: SVG user units without a viewBox are pixels. */
const PX_PER_IN = 96;
const MM_PER_PX = 25.4 / PX_PER_IN;
const MAX_USE_DEPTH = 8;
const MAX_FIT_DEPTH = 24;
/** Most pieces one curve may be fitted with before the rest of it is one line. */
const MAX_FIT_PIECES = 1 << 16;
/** Interior samples per fitted piece. */
const SAMPLES = 16;
/** The fit uses this share of the tolerance; joining short pieces may use a little more. */
const FIT_SHARE = 0.8;
/** Lines shorter than this share of the tolerance are merged into their neighbours. */
const MIN_SHARE = 0.05;

/** Longest piece of a name, id or attribute a message quotes. */
const QUOTE = 40;

/** `s` cut to `QUOTE` characters, marked when cut. */
const quote = (s: string): string => (s.length > QUOTE ? `${s.slice(0, QUOTE)}...` : s);

// Types ------------------------------------------------------------------------------------

/**
 * A piece of an imported loop, in millimetres with y up. An arc runs from `start` to `end`
 * around `center`, clockwise or counter-clockwise; `start` and `end` lie on the same circle.
 */
export type SvgSegment =
  | { readonly kind: 'line'; readonly start: Vec2; readonly end: Vec2 }
  | {
      readonly kind: 'arc';
      readonly center: Vec2;
      readonly start: Vec2;
      readonly end: Vec2;
      readonly clockwise: boolean;
    };

/** One subpath of a shape: segments joined end to start. */
export interface SvgContour {
  readonly segments: readonly SvgSegment[];
  /** The last end is the first start. */
  readonly closed: boolean;
  /** The element it came from, `tag` or `tag#id`. */
  readonly element: string;
}

/** A `<circle>` (or a round `<ellipse>`) under a transform that keeps it round. */
export interface SvgCircle {
  readonly center: Vec2;
  readonly radius: number;
  readonly element: string;
}

export interface SvgBounds {
  readonly min: Vec2;
  readonly max: Vec2;
}

export type SvgIssueCode =
  /** Elements that are not geometry this import reads (text, images); skipped. */
  | 'unsupported-element'
  /** Path data or a points list with an error: read up to the error, as browsers draw it. */
  | 'path-error'
  /** Subpaths that do not close: imported as open chains, which bound no region. */
  | 'open-path'
  /** A length or transform that could not be read; the attribute was ignored. */
  | 'attribute'
  /** A `<use>` that names nothing, or nests too deep. */
  | 'use'
  /** A shape whose coordinates overflow (are not finite) under its transforms; dropped. */
  | 'not-finite';

export interface SvgIssue {
  readonly code: SvgIssueCode;
  readonly message: string;
}

export interface SvgImport {
  readonly contours: readonly SvgContour[];
  readonly circles: readonly SvgCircle[];
  readonly issues: readonly SvgIssue[];
  /** Extent of the geometry, arcs by their true extremes; null when nothing was imported. */
  readonly bounds: SvgBounds | null;
  /**
   * The SVG's page (its width and height, or its viewBox) in millimetres after scaling, with its
   * bottom left corner at (0, 0); null when the file gives neither.
   */
  readonly page: { readonly width: number; readonly height: number } | null;
  /**
   * The largest distance found between a source curve and its lines and arcs, mm: an estimate
   * from the points the fit checks, not a bound over every point.
   */
  readonly maxDeviation: number;
}

export type SvgImportErrorCode = 'too-large' | 'xml' | 'not-svg' | 'too-complex' | 'out-of-range';

/** Which of `svgOutlinePaths`'s caps a refusal is for. */
export type SvgOutlineLimit = 'paths' | 'commands' | 'coordinates';

/** A file that cannot be imported at all. */
export class SvgImportError extends Error {
  constructor(
    readonly code: SvgImportErrorCode,
    message: string,
    /** For a refusal by `svgOutlinePaths`: the cap it hit. */
    readonly limit?: SvgOutlineLimit,
  ) {
    super(message);
    this.name = 'SvgImportError';
  }
}

export interface SvgFitOptions {
  /**
   * Multiplies the file's own size (its width and height in real units, else 96 user units to
   * the inch). Default 1. Applied before fitting, so the tolerance holds at the final size.
   */
  scale?: number;
  /** Largest distance (mm) between a curve and its arcs. Default `DEFAULT_SVG_TOLERANCE`. */
  tolerance?: number;
  /** Most lines and arcs to make before giving up with `too-complex`. */
  maxSegments?: number;
  /**
   * `arcs` (default): curves become circular arcs and lines. `lines`: lines only, within the
   * same tolerance, for consumers (or solvers) that cannot take many arcs. Circles stay circles.
   */
  curves?: 'arcs' | 'lines';
}

/** `SvgFitOptions` for `importSvg`, which parses and fits in one call. */
export type SvgImportOptions = SvgFitOptions;

// XML --------------------------------------------------------------------------------------

/** An element of the parsed file: its local name (prefix dropped), attributes and children. */
export interface XmlElement {
  readonly name: string;
  readonly attrs: ReadonlyMap<string, string>;
  readonly children: readonly XmlElement[];
}

const NAME_END = /[\s/>]/;

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (whole, body: string) => {
    if (body === 'amp') return '&';
    if (body === 'lt') return '<';
    if (body === 'gt') return '>';
    if (body === 'quot') return '"';
    if (body === 'apos') return "'";
    const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

const localName = (name: string): string => {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(i + 1);
};

/**
 * Parse XML into elements. Text, comments, CDATA, processing instructions and the DOCTYPE
 * (internal subset included) are skipped; entities other than the five predefined ones and
 * character references are left as written, so nothing expands. Throws `SvgImportError` (`xml`)
 * on a malformed tag or unbalanced elements.
 */
export function parseXml(text: string): XmlElement {
  if (text.length > MAX_SVG_CHARS) {
    throw new SvgImportError(
      'too-large',
      `The file is too large to import (over ${MAX_SVG_CHARS / 1048576} MB).`,
    );
  }
  type Open = { name: string; attrs: Map<string, string>; children: XmlElement[] };
  const stack: Open[] = [];
  let root: XmlElement | null = null;
  let count = 0;
  let i = 0;
  const n = text.length;
  const fail = (what: string): never => {
    // Counted, not split: no array of every line of a large file.
    let line = 1;
    for (let k = text.indexOf('\n'); k >= 0 && k < i; k = text.indexOf('\n', k + 1)) line++;
    throw new SvgImportError('xml', `The file is not well-formed XML: ${what} (line ${line}).`);
  };
  const skipTo = (end: string, what: string) => {
    const j = text.indexOf(end, i);
    if (j < 0) fail(`unterminated ${what}`);
    i = j + end.length;
  };

  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    i = lt;
    if (text.startsWith('<!--', i)) {
      skipTo('-->', 'comment');
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      skipTo(']]>', 'CDATA section');
      continue;
    }
    if (text.startsWith('<?', i)) {
      skipTo('?>', 'processing instruction');
      continue;
    }
    if (text.startsWith('<!', i)) {
      // DOCTYPE and its internal subset: up to the '>' outside brackets and quotes.
      let depth = 0;
      let quote = '';
      let j = i + 2;
      for (; j < n; j++) {
        const c = text[j]!;
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      if (j >= n) fail('unterminated declaration');
      i = j + 1;
      continue;
    }
    if (text[i + 1] === '/') {
      const gt = text.indexOf('>', i);
      if (gt < 0) fail('unterminated end tag');
      const name = text.slice(i + 2, gt).trim();
      const top = stack.pop();
      if (!top || top.name !== name) fail(`unexpected </${quote(name)}>`);
      const done: XmlElement = {
        name: localName(top!.name),
        attrs: top!.attrs,
        children: top!.children,
      };
      if (stack.length > 0) stack[stack.length - 1]!.children.push(done);
      else root ??= done;
      i = gt + 1;
      continue;
    }
    // A start tag.
    let j = i + 1;
    while (j < n && !NAME_END.test(text[j]!)) j++;
    const name = text.slice(i + 1, j);
    if (name === '') fail('a tag without a name');
    if (++count > MAX_SVG_ELEMENTS) {
      throw new SvgImportError(
        'too-complex',
        `The file has more than ${MAX_SVG_ELEMENTS.toLocaleString('en')} elements.`,
      );
    }
    const attrs = new Map<string, string>();
    let selfClosing = false;
    for (;;) {
      while (j < n && /\s/.test(text[j]!)) j++;
      if (j >= n) {
        i = j;
        fail(`unterminated <${quote(name)}>`);
      }
      if (text[j] === '>') {
        j++;
        break;
      }
      if (text.startsWith('/>', j)) {
        selfClosing = true;
        j += 2;
        break;
      }
      let k = j;
      while (k < n && !/[\s=/>]/.test(text[k]!)) k++;
      const attr = text.slice(j, k);
      while (k < n && /\s/.test(text[k]!)) k++;
      if (attr === '' || text[k] !== '=') {
        i = k;
        fail(`a malformed attribute in <${quote(name)}>`);
      }
      k++;
      while (k < n && /\s/.test(text[k]!)) k++;
      const q = text[k];
      if (q !== '"' && q !== "'") {
        i = k;
        fail(`an unquoted attribute value in <${quote(name)}>`);
      }
      const end = text.indexOf(q!, k + 1);
      if (end < 0) {
        i = k;
        fail(`an unterminated attribute value in <${quote(name)}>`);
      }
      if (!attrs.has(attr)) attrs.set(attr, decodeEntities(text.slice(k + 1, end)));
      j = end + 1;
    }
    i = j;
    if (selfClosing) {
      const done: XmlElement = { name: localName(name), attrs, children: [] };
      if (stack.length > 0) stack[stack.length - 1]!.children.push(done);
      else root ??= done;
    } else {
      if (stack.length >= MAX_SVG_DEPTH) {
        throw new SvgImportError(
          'too-complex',
          `The file nests elements more than ${MAX_SVG_DEPTH} deep.`,
        );
      }
      stack.push({ name, attrs, children: [] });
    }
  }
  if (stack.length > 0) fail(`<${quote(stack[stack.length - 1]!.name)}> is never closed`);
  if (!root) throw new SvgImportError('not-svg', 'The file has no elements: it is not an SVG.');
  return root;
}

// Numbers, lengths, transforms -------------------------------------------------------------

/** An affine map `[a, b, c, d, e, f]`: x' = a x + c y + e, y' = b x + d y + f (SVG's order). */
export type SvgMatrix = readonly [number, number, number, number, number, number];

export const IDENTITY: SvgMatrix = [1, 0, 0, 1, 0, 0];

/** `m` then `n`: the matrix applying `n` first. */
export function multiply(m: SvgMatrix, n: SvgMatrix): SvgMatrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function applyMatrix(m: SvgMatrix, p: Vec2): Vec2 {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

const translate = (x: number, y: number): SvgMatrix => [1, 0, 0, 1, x, y];
const scaling = (x: number, y: number): SvgMatrix => [x, 0, 0, y, 0, 0];

const NUMBER = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;

/** All numbers in a list such as `points` or a viewBox, and whether anything else was there. */
function numberList(s: string): { values: number[]; clean: boolean } {
  const values: number[] = [];
  let i = 0;
  let clean = true;
  const skip = () => {
    while (i < s.length && /[\s,]/.test(s[i]!)) i++;
  };
  skip();
  while (i < s.length) {
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(s);
    if (!m) {
      clean = false;
      break;
    }
    const v = Number(m[0]);
    if (!Number.isFinite(v)) {
      // `1e999`: not a number SVG can use; the list stops here.
      clean = false;
      break;
    }
    values.push(v);
    i = NUMBER.lastIndex;
    skip();
  }
  return { values, clean };
}

/**
 * A transform list (`translate(10) rotate(45 5 5) matrix(...)`), or null when it does not
 * parse (SVG then ignores the attribute).
 */
export function parseTransform(s: string): SvgMatrix | null {
  let m = IDENTITY;
  // Sticky, with the separators skipped by hand: no ambiguous whitespace for the regex to try.
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/y;
  let i = 0;
  const text = s;
  const skip = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text[i] === ',') i++;
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  for (;;) {
    skip();
    if (i >= text.length) break;
    re.lastIndex = i;
    const hit = re.exec(text);
    if (!hit) return null;
    i = re.lastIndex;
    const { values: v, clean } = numberList(hit[2]!);
    if (!clean || v.some((x) => !Number.isFinite(x))) return null;
    let t: SvgMatrix;
    const rad = (deg: number) => (deg * Math.PI) / 180;
    switch (hit[1]) {
      case 'matrix':
        if (v.length !== 6) return null;
        t = [v[0]!, v[1]!, v[2]!, v[3]!, v[4]!, v[5]!];
        break;
      case 'translate':
        if (v.length !== 1 && v.length !== 2) return null;
        t = translate(v[0]!, v[1] ?? 0);
        break;
      case 'scale':
        if (v.length !== 1 && v.length !== 2) return null;
        t = scaling(v[0]!, v[1] ?? v[0]!);
        break;
      case 'rotate': {
        if (v.length !== 1 && v.length !== 3) return null;
        const a = rad(v[0]!);
        const r: SvgMatrix = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
        t =
          v.length === 3
            ? multiply(multiply(translate(v[1]!, v[2]!), r), translate(-v[1]!, -v[2]!))
            : r;
        break;
      }
      case 'skewX':
        if (v.length !== 1) return null;
        t = [1, 0, Math.tan(rad(v[0]!)), 1, 0, 0];
        break;
      default:
        if (v.length !== 1) return null;
        t = [1, Math.tan(rad(v[0]!)), 0, 1, 0, 0];
    }
    m = multiply(m, t);
  }
  return m.every(Number.isFinite) ? m : null;
}

/** User units (CSS pixels) per unit. A Map, so `constructor` and its kin are not units. */
const LENGTH_UNITS: ReadonlyMap<string, number> = new Map(
  Object.entries({
    '': 1,
    px: 1,
    mm: PX_PER_IN / 25.4,
    cm: PX_PER_IN / 2.54,
    q: PX_PER_IN / 101.6,
    in: PX_PER_IN,
    pt: PX_PER_IN / 72,
    pc: PX_PER_IN / 6,
    em: 16,
    ex: 8,
  }),
);

/**
 * A number and its unit (`%` or letters), with surrounding whitespace allowed; null otherwise.
 * Scanned by hand: no regex with ambiguous whitespace on untrusted text.
 */
function splitLength(s: string): { value: number; unit: string } | null {
  const t = s.trim();
  NUMBER.lastIndex = 0;
  const m = NUMBER.exec(t);
  if (!m) return null;
  const unit = t.slice(NUMBER.lastIndex).trim();
  if (unit !== '%' && !/^[a-zA-Z]*$/.test(unit)) return null;
  const value = Number(m[0]);
  return Number.isFinite(value) ? { value, unit: unit.toLowerCase() } : null;
}

/**
 * A length in user units: a number with an optional CSS unit, or a percentage of `base` (null
 * when there is no base). Null when it does not parse.
 */
export function parseLength(s: string | undefined, base: number | null = null): number | null {
  if (s === undefined) return null;
  return lengthValue(splitLength(s), base);
}

/** A split length (`splitLength`) in user units, or null. */
function lengthValue(
  l: { value: number; unit: string } | null,
  base: number | null,
): number | null {
  if (!l) return null;
  const v =
    l.unit === '%'
      ? base === null
        ? null
        : (l.value / 100) * base
      : LENGTH_UNITS.has(l.unit)
        ? l.value * LENGTH_UNITS.get(l.unit)!
        : null;
  return v !== null && Number.isFinite(v) ? v : null;
}

/** Millimetres per unit, for the root's width and height. */
const LENGTH_MM: ReadonlyMap<string, number> = new Map(
  Object.entries({
    '': MM_PER_PX,
    px: MM_PER_PX,
    mm: 1,
    cm: 10,
    q: 0.25,
    in: 25.4,
    pt: 25.4 / 72,
    pc: 25.4 / 6,
    em: 16 * MM_PER_PX,
    ex: 8 * MM_PER_PX,
  }),
);

/** A length in millimetres, or null (percentages included: they have no base at the root). */
function lengthMm(s: string | undefined): number | null {
  if (s === undefined) return null;
  const l = splitLength(s);
  const k = l ? LENGTH_MM.get(l.unit) : undefined;
  const v = l && k !== undefined ? l.value * k : NaN;
  return Number.isFinite(v) ? v : null;
}

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function parseViewBox(s: string | undefined): ViewBox | null {
  if (s === undefined) return null;
  const { values, clean } = numberList(s);
  if (!clean || values.length !== 4) return null;
  const [x, y, w, h] = values as [number, number, number, number];
  return w > 0 && h > 0 && [x, y, w, h].every(Number.isFinite) ? { x, y, w, h } : null;
}

/** A `preserveAspectRatio`: its alignment and whether it slices (else meets). */
interface Aspect {
  align: string;
  slice: boolean;
}

function parseAspect(par: string | undefined): Aspect {
  const words = (par ?? '')
    .trim()
    .split(/\s+/)
    .filter((w) => w && w !== 'defer');
  return { align: words[0] ?? 'xMidYMid', slice: words[1] === 'slice' };
}

/** The map from a viewBox to a viewport of `width` by `height` at (x, y). */
function viewBoxMatrix(
  vb: ViewBox,
  x: number,
  y: number,
  width: number,
  height: number,
  aspect: Aspect,
): SvgMatrix {
  const { align } = aspect;
  const sx = width / vb.w;
  const sy = height / vb.h;
  if (align === 'none') return [sx, 0, 0, sy, x - vb.x * sx, y - vb.y * sy];
  const s = aspect.slice ? Math.max(sx, sy) : Math.min(sx, sy);
  const fx = align.startsWith('xMin') ? 0 : align.startsWith('xMax') ? 1 : 0.5;
  const fy = align.endsWith('YMin') ? 0 : align.endsWith('YMax') ? 1 : 0.5;
  return [
    s,
    0,
    0,
    s,
    x - vb.x * s + (width - vb.w * s) * fx,
    y - vb.y * s + (height - vb.h * s) * fy,
  ];
}

// Path data --------------------------------------------------------------------------------

/** A path command, absolute; `H` and `V` become `L`, `S` and `T` their full forms. */
export type SvgPathCommand =
  | { readonly kind: 'M'; readonly to: Vec2 }
  | { readonly kind: 'L'; readonly to: Vec2 }
  | { readonly kind: 'C'; readonly c1: Vec2; readonly c2: Vec2; readonly to: Vec2 }
  | { readonly kind: 'Q'; readonly c: Vec2; readonly to: Vec2 }
  | {
      readonly kind: 'A';
      readonly rx: number;
      readonly ry: number;
      /** Degrees. */
      readonly rotation: number;
      readonly large: boolean;
      readonly sweep: boolean;
      readonly to: Vec2;
    }
  | { readonly kind: 'Z' };

const ARG_COUNT: ReadonlyMap<string, number> = new Map(
  Object.entries({
    m: 2,
    l: 2,
    h: 1,
    v: 1,
    c: 6,
    s: 4,
    q: 4,
    t: 2,
    a: 7,
    z: 0,
  }),
);

/**
 * Parse SVG path data (`d`): every command, absolute and relative, with implicit repeats and the
 * compact number and flag forms (`1.5.5`, `a1 1 0 00 1 1`). On an error, the commands before it
 * are kept, as browsers draw them, and `error` says where it stopped.
 */
export function parsePathData(d: string): {
  commands: SvgPathCommand[];
  error: string | null;
} {
  const commands: SvgPathCommand[] = [];
  let i = 0;
  const n = d.length;
  let cur: Vec2 = [0, 0];
  let start: Vec2 = [0, 0];
  let lastCubic: Vec2 | null = null;
  let lastQuad: Vec2 | null = null;
  let cmd = '';
  const ws = () => {
    while (i < n && /\s/.test(d[i]!)) i++;
  };
  const sep = () => {
    ws();
    if (d[i] === ',') {
      i++;
      ws();
    }
  };
  const num = (): number | null => {
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(d);
    if (!m) return null;
    i = NUMBER.lastIndex;
    const v = Number(m[0]);
    return Number.isFinite(v) ? v : null;
  };
  const flag = (): boolean | null => {
    const c = d[i];
    if (c !== '0' && c !== '1') return null;
    i++;
    return c === '1';
  };
  const error = (what: string) => ({
    commands,
    error: `${what} at character ${i + 1}`,
  });

  for (;;) {
    ws();
    if (i >= n) break;
    const c = d[i]!;
    if (/[a-zA-Z]/.test(c)) {
      if (!ARG_COUNT.has(c.toLowerCase())) return error(`unknown command '${c}'`);
      if (cmd === '' && c !== 'M' && c !== 'm') return error('path data must start with M');
      cmd = c;
      i++;
    } else if (cmd === '' || cmd === 'z' || cmd === 'Z') {
      return error(`unexpected '${c}'`);
    }
    const lower = cmd.toLowerCase();
    const rel = cmd === lower;
    if (lower === 'z') {
      commands.push({ kind: 'Z' });
      cur = start;
      lastCubic = lastQuad = null;
      continue;
    }
    const args: number[] = [];
    const count = ARG_COUNT.get(lower)!;
    for (let k = 0; k < count; k++) {
      if (k > 0) sep();
      else ws();
      const v = lower === 'a' && (k === 3 || k === 4) ? flag() : num();
      if (v === null) {
        return error(k === 0 && args.length === 0 ? `'${cmd}' without numbers` : 'a bad number');
      }
      args.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    sep();
    const pt = (x: number, y: number): Vec2 => (rel ? [cur[0] + x, cur[1] + y] : [x, y]);
    let cubic: Vec2 | null = null;
    let quad: Vec2 | null = null;
    switch (lower) {
      case 'm': {
        const to = pt(args[0]!, args[1]!);
        commands.push({ kind: 'M', to });
        cur = start = to;
        cmd = rel ? 'l' : 'L'; // further pairs are lines
        break;
      }
      case 'l':
        cur = pt(args[0]!, args[1]!);
        commands.push({ kind: 'L', to: cur });
        break;
      case 'h':
        cur = [rel ? cur[0] + args[0]! : args[0]!, cur[1]];
        commands.push({ kind: 'L', to: cur });
        break;
      case 'v':
        cur = [cur[0], rel ? cur[1] + args[0]! : args[0]!];
        commands.push({ kind: 'L', to: cur });
        break;
      case 'c':
      case 's': {
        let c1: Vec2;
        let rest = args;
        if (lower === 'c') {
          c1 = pt(args[0]!, args[1]!);
          rest = args.slice(2);
        } else {
          c1 = lastCubic ? [2 * cur[0] - lastCubic[0], 2 * cur[1] - lastCubic[1]] : cur;
        }
        const c2 = pt(rest[0]!, rest[1]!);
        const to = pt(rest[2]!, rest[3]!);
        commands.push({ kind: 'C', c1, c2, to });
        cubic = c2;
        cur = to;
        break;
      }
      case 'q':
      case 't': {
        const c: Vec2 =
          lower === 'q'
            ? pt(args[0]!, args[1]!)
            : lastQuad
              ? [2 * cur[0] - lastQuad[0], 2 * cur[1] - lastQuad[1]]
              : cur;
        const to = lower === 'q' ? pt(args[2]!, args[3]!) : pt(args[0]!, args[1]!);
        commands.push({ kind: 'Q', c, to });
        quad = c;
        cur = to;
        break;
      }
      default: {
        const to = pt(args[5]!, args[6]!);
        commands.push({
          kind: 'A',
          rx: args[0]!,
          ry: args[1]!,
          rotation: args[2]!,
          large: args[3] === 1,
          sweep: args[4] === 1,
          to,
        });
        cur = to;
      }
    }
    lastCubic = cubic;
    lastQuad = quad;
  }
  return { commands, error: null };
}

// Geometry ---------------------------------------------------------------------------------

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cross = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0];

/** The circle through three points, or null when they are (nearly) on a line. */
function circleThrough(a: Vec2, b: Vec2, c: Vec2): { center: Vec2; radius: number } | null {
  // Relative to `a`, for precision far from the origin.
  const bx = b[0] - a[0];
  const by = b[1] - a[1];
  const cx = c[0] - a[0];
  const cy = c[1] - a[1];
  const d = 2 * (bx * cy - by * cx);
  const scale = Math.max(bx * bx + by * by, cx * cx + cy * cy);
  if (scale === 0 || Math.abs(d) <= 1e-14 * scale) return null;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const ux = (cy * b2 - by * c2) / d;
  const uy = (bx * c2 - cx * b2) / d;
  return { center: [a[0] + ux, a[1] + uy], radius: Math.hypot(ux, uy) };
}

function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const len2 = ab[0] * ab[0] + ab[1] * ab[1];
  if (len2 === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / len2));
  return dist(p, [a[0] + t * ab[0], a[1] + t * ab[1]]);
}

const TAU = 2 * Math.PI;

/** The angle from `from` to `to` about `c`, in [0, 2 pi), measured in direction `dir` (1 or -1). */
function sweepAngle(c: Vec2, from: Vec2, to: Vec2, dir: number): number {
  const a = Math.atan2(from[1] - c[1], from[0] - c[0]);
  const b = Math.atan2(to[1] - c[1], to[0] - c[0]);
  let s = dir * (b - a);
  s %= TAU;
  if (s < 0) s += TAU;
  return s;
}

/** An arc as the fit makes it: with the point it was fitted through, to refit after a move. */
interface RawArc {
  kind: 'arc';
  start: Vec2;
  mid: Vec2;
  end: Vec2;
}
interface RawLine {
  kind: 'line';
  start: Vec2;
  end: Vec2;
}
type Raw = RawArc | RawLine;

/** The output form of a raw arc, or a line when its points are (nearly) on a line. */
function finishArc(raw: RawArc): SvgSegment {
  const circle = circleThrough(raw.start, raw.mid, raw.end);
  if (!circle) return { kind: 'line', start: raw.start, end: raw.end };
  return {
    kind: 'arc',
    center: circle.center,
    start: raw.start,
    end: raw.end,
    clockwise: cross(sub(raw.mid, raw.start), sub(raw.end, raw.mid)) < 0,
  };
}

/** Everything one import shares: the tolerances, the counts and the results. */
interface Context {
  /** Curves become arcs and lines, or lines only. */
  arcs: boolean;
  /** The fit's tolerance (a share of the user's). */
  fitTolerance: number;
  /** Shorter lines are merged into their neighbours. */
  minLength: number;
  maxSegments: number;
  segments: number;
  maxDeviation: number;
  contours: SvgContour[];
  circles: SvgCircle[];
  openPaths: number;
}

/** One piece fitted: a line or an arc within the tolerance, with its deviation; or null. */
function fitPiece(
  f: (t: number) => Vec2,
  t0: number,
  t1: number,
  a: Vec2,
  b: Vec2,
  tol: number,
  arcs: boolean,
): { raw: Raw; deviation: number; lineDeviation: number } | { raw: null; lineDeviation: number } {
  const samples: Vec2[] = [];
  for (let k = 1; k < SAMPLES; k++) samples.push(f(t0 + ((t1 - t0) * k) / SAMPLES));
  const m = samples[SAMPLES / 2 - 1]!;
  let lineDev = 0;
  for (const s of samples) lineDev = Math.max(lineDev, pointSegmentDistance(s, a, b));
  if (lineDev <= tol) {
    return { raw: { kind: 'line', start: a, end: b }, deviation: lineDev, lineDeviation: lineDev };
  }
  if (!arcs) return { raw: null, lineDeviation: lineDev };
  // Arcs through the piece's ends, by their signed sagitta (the arc's middle off the chord's,
  // to the left of a -> b): first the one through the curve's middle, then, when that misses,
  // the one with the least deviation, which may be up to twice as long a piece.
  const half = dist(a, b) / 2;
  if (half === 0) return { raw: null, lineDeviation: lineDev };
  const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const n: Vec2 = [-(b[1] - a[1]) / (2 * half), (b[0] - a[0]) / (2 * half)];
  const arcAt = (sag: number) => {
    const r = (half * half + sag * sag) / (2 * Math.abs(sag));
    const k = sag - Math.sign(sag) * r;
    const center: Vec2 = [mid[0] + k * n[0], mid[1] + k * n[1]];
    const top: Vec2 = [mid[0] + sag * n[0], mid[1] + sag * n[1]];
    const dir = sag > 0 ? -1 : 1; // bulging left of a -> b turns clockwise
    const total = sweepAngle(center, a, b, dir);
    let dev = 0;
    let last = 0;
    let ordered = true;
    for (const p of samples) {
      dev = Math.max(dev, Math.abs(dist(p, center) - r));
      const u = sweepAngle(center, a, p, dir);
      if (u < last || u > total) ordered = false;
      last = u;
    }
    return { dev: ordered ? dev : Infinity, top };
  };
  const s0 = (m[0] - mid[0]) * n[0] + (m[1] - mid[1]) * n[1];
  if (s0 === 0) return { raw: null, lineDeviation: lineDev };
  const first = arcAt(s0);
  let best = { sag: s0, ...first };
  if (best.dev > tol && Number.isFinite(best.dev) && best.dev < 4 * tol) {
    // Golden-section search for the least deviation, keeping the sagitta's sign.
    let lo = s0 - 2 * best.dev;
    let hi = s0 + 2 * best.dev;
    if (Math.sign(lo) !== Math.sign(s0)) lo = s0 * 1e-3;
    if (Math.sign(hi) !== Math.sign(s0)) hi = s0 * 1e-3;
    if (lo > hi) [lo, hi] = [hi, lo];
    const g = (Math.sqrt(5) - 1) / 2;
    let x1 = hi - g * (hi - lo);
    let x2 = lo + g * (hi - lo);
    let f1 = arcAt(x1);
    let f2 = arcAt(x2);
    for (let i = 0; i < 30 && best.dev > tol; i++) {
      if (f1.dev < best.dev) best = { sag: x1, ...f1 };
      if (f2.dev < best.dev) best = { sag: x2, ...f2 };
      if (f1.dev <= f2.dev) {
        hi = x2;
        x2 = x1;
        f2 = f1;
        x1 = hi - g * (hi - lo);
        f1 = arcAt(x1);
      } else {
        lo = x1;
        x1 = x2;
        f1 = f2;
        x2 = lo + g * (hi - lo);
        f2 = arcAt(x2);
      }
    }
  }
  if (best.dev <= tol) {
    return {
      raw: { kind: 'arc', start: a, mid: best.top, end: b },
      deviation: best.dev,
      lineDeviation: lineDev,
    };
  }
  return { raw: null, lineDeviation: lineDev };
}

/** Bisection steps that lengthen a piece that fits towards one that does not. */
const GROW_STEPS = 8;

/**
 * Lines and arcs (or lines only) within the fit tolerance of the curve `f` on [0, 1], from
 * `p0` = f(0) to `p1` = f(1). Greedy: from where the last piece ended, the longest piece that
 * fits (an arc through its ends and middle, checked at `SAMPLES` points; a line when the piece
 * is flat within the tolerance), found by halving until one fits and then bisecting towards the
 * shortest that does not. Long pieces mean few arcs, which the sketch solver needs.
 */
function fitCurve(
  f: (t: number) => Vec2,
  p0: Vec2,
  p1: Vec2,
  ctx: Context,
  emit: (raw: Raw) => void,
): void {
  const tol = ctx.fitTolerance;
  const at = (t: number): Vec2 => (t === 1 ? p1 : f(t));
  let t0 = 0;
  let a = p0;
  let pieces = 0;
  if (![...p0, ...p1, ...f(0.5)].every(Number.isFinite)) {
    // Overflowed: one line, which the import then drops as not finite.
    emit({ kind: 'line', start: p0, end: p1 });
    return;
  }
  while (t0 < 1) {
    if (++pieces > MAX_FIT_PIECES) {
      // Never for a real curve; a pathological one ends in a line, its deviation unknown.
      emit({ kind: 'line', start: a, end: p1 });
      return;
    }
    let good: { t: number; b: Vec2; raw: Raw; deviation: number } | null = null;
    let bad = 1;
    let t = 1;
    let lastLineDev = 0;
    for (let depth = 0; depth <= MAX_FIT_DEPTH; depth++) {
      const b = at(t);
      const r = fitPiece(f, t0, t, a, b, tol, ctx.arcs);
      lastLineDev = r.lineDeviation;
      if (r.raw) {
        good = { t, b, raw: r.raw, deviation: r.deviation };
        break;
      }
      bad = t;
      t = t0 + (t - t0) / 2;
    }
    if (!good) {
      // A cusp or worse, a millionth of the curve long: a line, with its deviation recorded.
      const b = at(t);
      ctx.maxDeviation = Math.max(ctx.maxDeviation, lastLineDev);
      emit({ kind: 'line', start: a, end: b });
      t0 = t;
      a = b;
      continue;
    }
    if (good.t < 1) {
      for (let k = 0; k < GROW_STEPS; k++) {
        const tm: number = (good.t + bad) / 2;
        const b = at(tm);
        const r = fitPiece(f, t0, tm, a, b, tol, ctx.arcs);
        if (r.raw) good = { t: tm, b, raw: r.raw, deviation: r.deviation };
        else bad = tm;
      }
    }
    ctx.maxDeviation = Math.max(ctx.maxDeviation, good.deviation);
    emit(good.raw);
    t0 = good.t;
    a = good.b;
  }
}

/** Collects one shape's subpaths into contours, in millimetres. */
class ContourBuilder {
  private segments: SvgSegment[] = [];
  private pending: Raw | null = null;
  /** Where the next segment starts: the end of the last one kept. */
  private cursor: Vec2 | null = null;
  private start: Vec2 | null = null;
  /** The source's current point (fits start here, not at the cursor). */
  private current: Vec2 | null = null;

  constructor(
    private readonly ctx: Context,
    private readonly element: string,
  ) {}

  moveTo(p: Vec2): void {
    this.finish(false);
    this.start = this.cursor = this.current = p;
  }

  lineTo(p: Vec2): void {
    if (!this.current) this.moveTo(p);
    this.push({ kind: 'line', start: this.current!, end: p });
    this.current = p;
  }

  curveTo(f: (t: number) => Vec2, end: Vec2): void {
    if (!this.current) this.moveTo(f(0));
    fitCurve(f, this.current!, end, this.ctx, (raw) => this.push(raw));
    this.current = end;
  }

  close(): void {
    this.finish(true);
    this.cursor = this.current = this.start;
  }

  /** Close or end the current subpath. */
  finish(close: boolean): void {
    const start = this.start;
    if (!start || !this.cursor) return;
    const gap = dist(this.cursor, start);
    const count = this.segments.length + (this.pending ? 1 : 0);
    let closed = false;
    if (count > 0 && gap <= this.ctx.minLength) {
      // Ends within a hair of the start: closed, the last end moved onto the start.
      if (this.pending) this.pending = { ...this.pending, end: start };
      else this.segments.push(this.retarget(this.segments.pop()!, start));
      this.ctx.maxDeviation = Math.max(this.ctx.maxDeviation, gap);
      closed = count > 1;
    } else if (close && count > 0) {
      this.push({ kind: 'line', start: this.cursor, end: start });
      closed = true;
    }
    this.flush();
    const segments = this.segments;
    this.segments = [];
    this.start = null;
    if (segments.length === 0) return;
    if (closed && Math.abs(signedArea(segments)) <= this.ctx.minLength ** 2) return;
    if (!closed) this.ctx.openPaths++;
    this.ctx.contours.push({ segments, closed, element: this.element });
  }

  private retarget(seg: SvgSegment, end: Vec2): SvgSegment {
    if (seg.kind === 'line') return { kind: 'line', start: seg.start, end };
    // Refit through the arc's middle (from its centre and the old ends).
    const c = seg.center;
    const r = dist(seg.start, c);
    const dir = seg.clockwise ? -1 : 1;
    const a0 = Math.atan2(seg.start[1] - c[1], seg.start[0] - c[0]);
    const half = (dir * sweepAngle(c, seg.start, seg.end, dir)) / 2;
    const mid: Vec2 = [c[0] + r * Math.cos(a0 + half), c[1] + r * Math.sin(a0 + half)];
    return finishArc({ kind: 'arc', start: seg.start, mid, end });
  }

  private push(raw: Raw): void {
    // Start at the end of the last piece kept: the same point unless short pieces were dropped.
    const moved: Raw = { ...raw, start: this.cursor! };
    if (dist(moved.start, moved.end) < this.ctx.minLength) {
      // Too short to keep: the next piece starts where this one did.
      return;
    }
    this.flush();
    if (++this.ctx.segments > this.ctx.maxSegments) {
      throw new SvgImportError(
        'too-complex',
        `The file makes more than ${this.ctx.maxSegments.toLocaleString('en')} lines and arcs.`,
      );
    }
    this.pending = moved;
    this.cursor = moved.end;
  }

  private flush(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.segments.push(
      p.kind === 'line' ? { kind: 'line', start: p.start, end: p.end } : finishArc(p),
    );
  }
}

/** The signed area of a loop of lines and arcs, positive counter-clockwise. */
function signedArea(segments: readonly SvgSegment[]): number {
  let a = 0;
  for (const s of segments) {
    a += cross(s.start, s.end) / 2;
    if (s.kind === 'arc') {
      const r = dist(s.start, s.center);
      const dir = s.clockwise ? -1 : 1;
      const sweep = sweepAngle(s.center, s.start, s.end, dir);
      // The circular segment between the chord and the arc.
      a += (dir * r * r * (sweep - Math.sin(sweep))) / 2;
    }
  }
  return a;
}

/** An SVG elliptical arc in centre form: centre, radii, rotation and angles, all finite. */
interface ArcParams {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  cos: number;
  sin: number;
  theta1: number;
  delta: number;
}

/**
 * The centre form of an SVG elliptical arc (endpoint form, SVG 1.1 F.6.5), or null for a line
 * (a zero radius, or radii so large that the numbers overflow: then the arc is a line anyway).
 */
function arcParams(from: Vec2, cmd: Extract<SvgPathCommand, { kind: 'A' }>): ArcParams | null {
  const [x1, y1] = from;
  const [x2, y2] = cmd.to;
  let rx = Math.abs(cmd.rx);
  let ry = Math.abs(cmd.ry);
  if (rx === 0 || ry === 0) return null;
  const phi = (cmd.rotation * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy;
  const yp = -sin * dx + cos * dy;
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const den = rx * rx * yp * yp + ry * ry * xp * xp;
  const k = (cmd.large !== cmd.sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (k * rx * yp) / ry;
  const cyp = (-k * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const ux = (xp - cxp) / rx;
  const uy = (yp - cyp) / ry;
  const vx = (-xp - cxp) / rx;
  const vy = (-yp - cyp) / ry;
  const theta1 = angle(1, 0, ux, uy);
  let delta = angle(ux, uy, vx, vy);
  if (!cmd.sweep && delta > 0) delta -= TAU;
  else if (cmd.sweep && delta < 0) delta += TAU;
  const out = { cx, cy, rx, ry, cos, sin, theta1, delta };
  return Object.values(out).every(Number.isFinite) ? out : null;
}

/** The point of an arc at angle `th` (its eccentric anomaly). */
function arcPoint(a: ArcParams, th: number): Vec2 {
  const ex = a.rx * Math.cos(th);
  const ey = a.ry * Math.sin(th);
  return [a.cx + a.cos * ex - a.sin * ey, a.cy + a.sin * ex + a.cos * ey];
}

/** The parametric form of an SVG elliptical arc on [0, 1], or null for a line. */
function ellipticalArc(
  from: Vec2,
  cmd: Extract<SvgPathCommand, { kind: 'A' }>,
): ((t: number) => Vec2) | null {
  const a = arcParams(from, cmd);
  return a ? (t) => arcPoint(a, a.theta1 + t * a.delta) : null;
}

/** Feed path commands (user units) through `m` into a contour builder. */
function drawPath(commands: readonly SvgPathCommand[], m: SvgMatrix, out: ContourBuilder): void {
  let cur: Vec2 = [0, 0];
  let start: Vec2 = [0, 0];
  const map = (p: Vec2) => applyMatrix(m, p);
  for (const c of commands) {
    switch (c.kind) {
      case 'M':
        out.moveTo(map(c.to));
        cur = start = c.to;
        break;
      case 'L':
        out.lineTo(map(c.to));
        cur = c.to;
        break;
      case 'C': {
        const p0 = cur;
        const { c1, c2, to } = c;
        out.curveTo((t) => {
          const u = 1 - t;
          const a = u * u * u;
          const b = 3 * u * u * t;
          const d = 3 * u * t * t;
          const e = t * t * t;
          return map([
            a * p0[0] + b * c1[0] + d * c2[0] + e * to[0],
            a * p0[1] + b * c1[1] + d * c2[1] + e * to[1],
          ]);
        }, map(to));
        cur = to;
        break;
      }
      case 'Q': {
        const p0 = cur;
        const { c: k, to } = c;
        out.curveTo((t) => {
          const u = 1 - t;
          return map([
            u * u * p0[0] + 2 * u * t * k[0] + t * t * to[0],
            u * u * p0[1] + 2 * u * t * k[1] + t * t * to[1],
          ]);
        }, map(to));
        cur = to;
        break;
      }
      case 'A': {
        if (cur[0] === c.to[0] && cur[1] === c.to[1]) break; // SVG: an arc to itself is omitted
        const f = ellipticalArc(cur, c);
        if (f) out.curveTo((t) => map(f(t)), map(c.to));
        else out.lineTo(map(c.to));
        cur = c.to;
        break;
      }
      case 'Z':
        out.close();
        cur = start;
        break;
    }
  }
  out.finish(false);
}

/** Whether `m` keeps circles round: a rotation, uniform scale and maybe a reflection. */
function isSimilarity(m: SvgMatrix): boolean {
  const sx = m[0] * m[0] + m[1] * m[1];
  const sy = m[2] * m[2] + m[3] * m[3];
  const dot = m[0] * m[2] + m[1] * m[3];
  return Math.abs(sx - sy) <= 1e-9 * Math.max(sx, sy) && Math.abs(dot) <= 1e-9 * Math.max(sx, sy);
}

/** The path commands of an ellipse, as four quarter arcs. */
function ellipseCommands(cx: number, cy: number, rx: number, ry: number): SvgPathCommand[] {
  const arc = (to: Vec2): SvgPathCommand => ({
    kind: 'A',
    rx,
    ry,
    rotation: 0,
    large: false,
    sweep: true,
    to,
  });
  return [
    { kind: 'M', to: [cx + rx, cy] },
    arc([cx, cy + ry]),
    arc([cx - rx, cy]),
    arc([cx, cy - ry]),
    arc([cx + rx, cy]),
    { kind: 'Z' },
  ];
}

// The walk ---------------------------------------------------------------------------------

/** Elements skipped with everything inside them, without a word. */
const SILENT: ReadonlySet<string> = new Set([
  'defs',
  'symbol',
  'clipPath',
  'mask',
  'pattern',
  'marker',
  'linearGradient',
  'radialGradient',
  'filter',
  'metadata',
  'title',
  'desc',
  'style',
  'script',
  'foreignObject',
]);
/** Elements skipped with an issue: they draw something this import cannot read. */
const UNSUPPORTED: ReadonlyMap<string, string> = new Map([
  ['text', 'convert text to paths in your drawing program first'],
  ['image', 'bitmap images have no outlines to import'],
]);

export type SvgFillRule = 'nonzero' | 'evenodd';

/**
 * A shape of the file: path commands in its own user units, the map from them to millimetres
 * (y up, the page's bottom left corner at the origin, at scale 1), the fill rule it is drawn
 * with and the element it came from. Every coordinate it maps to is finite.
 */
export interface SvgShape {
  readonly element: string;
  readonly fillRule: SvgFillRule;
  readonly matrix: SvgMatrix;
  readonly commands: readonly SvgPathCommand[];
  /** For a `<circle>` (or a round `<ellipse>`): its centre and radius in user units. */
  readonly circle?: { readonly center: Vec2; readonly radius: number };
}

/** A file read once by `parseSvg`, for `fitSvg` and `svgOutlinePaths`. */
export interface ParsedSvg {
  readonly shapes: readonly SvgShape[];
  readonly issues: readonly SvgIssue[];
  /** The page in millimetres at scale 1, or null when the file gives none. */
  readonly page: { readonly width: number; readonly height: number } | null;
}

interface Viewport {
  width: number;
  height: number;
}

/**
 * CSS declarations of a `style` attribute, by property; split by hand (linear time). For a
 * presentation property the style declaration wins over the attribute (`Walker.property`).
 */
function styleOf(e: XmlElement): Map<string, string> {
  const out = new Map<string, string>();
  const style = e.attrs.get('style');
  if (style === undefined) return out;
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const value = decl
      .slice(i + 1)
      .replace(/!important/i, '')
      .trim();
    out.set(decl.slice(0, i).trim().toLowerCase(), value);
  }
  return out;
}

const notFinite = (p: Vec2) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]);

/**
 * What the walk reads from one element, worked out on its first visit. A `<use>` makes the walk
 * visit an element many times, and an attribute may be megabytes long: reading it again on every
 * visit would make the work the attribute's length times the visits, not their sum.
 */
interface ElementInfo {
  label?: string;
  style?: Map<string, string>;
  /** Presentation properties (`property`), by name. */
  props?: Map<string, string | undefined>;
  hidden?: boolean;
  transform?: SvgMatrix;
  /** Lengths split into number and unit (`splitLength`), by attribute. */
  lengths?: Map<string, { value: number; unit: string } | null>;
  viewBox?: ViewBox | null;
  aspect?: Aspect;
  /** A polyline's or polygon's commands. */
  points?: SvgPathCommand[];
  /** What a `<use>` names. */
  use?: { target: XmlElement | undefined };
}

/** Examples a grouped issue quotes; the rest are counted. */
const ISSUE_EXAMPLES = 3;
/**
 * Problems of one kind, however many: a count and the first few examples, so a file of 100,000
 * bad elements makes one short issue, not 100,000.
 */
class IssueTally {
  private count = 0;
  private readonly examples: string[] = [];

  constructor(
    private readonly code: SvgIssueCode,
    /** The issue's lead for `n` (above 1) problems. */
    private readonly many: (n: string) => string,
  ) {}

  /** One problem, as a sentence without its full stop. An example already quoted is not again. */
  add(example: string): void {
    this.count++;
    if (this.examples.length < ISSUE_EXAMPLES && !this.examples.includes(example)) {
      this.examples.push(example);
    }
  }

  issue(): SvgIssue | null {
    if (this.count === 0) return null;
    if (this.count === 1) return { code: this.code, message: `${this.examples[0]}.` };
    const rest = this.count - this.examples.length;
    return {
      code: this.code,
      message:
        `${this.many(this.count.toLocaleString('en'))}, for example: ${this.examples.join('; ')}` +
        (rest > 0 ? `; and ${rest.toLocaleString('en')} more.` : '.'),
    };
  }
}

class Walker {
  readonly shapes: SvgShape[] = [];
  private readonly info = new WeakMap<XmlElement, ElementInfo>();
  private readonly unsupported = new Map<string, number>();
  private readonly attributeIssues = new IssueTally(
    'attribute',
    (n) => `${n} attributes could not be read`,
  );
  private readonly pathErrors = new IssueTally(
    'path-error',
    (n) => `${n} elements have path data or points with an error, read up to it`,
  );
  private readonly useIssues = new IssueTally('use', (n) => `${n} <use> elements were skipped`);
  /** `<use>` elements already reported for a cycle or nesting too deep. */
  private readonly loopingUses = new WeakSet<XmlElement>();
  private readonly parsedPaths = new WeakMap<XmlElement, SvgPathCommand[]>();
  private ids: Map<string, XmlElement> | null = null;
  private visits = 0;
  private commandCount = 0;
  private overflowed = 0;

  constructor(private readonly root: XmlElement) {}

  issues(): SvgIssue[] {
    const out: SvgIssue[] = [];
    for (const [tag, count] of this.unsupported) {
      out.push({
        code: 'unsupported-element',
        message: `${count.toLocaleString('en')} <${tag}> element${count === 1 ? ' was' : 's were'} not imported: ${UNSUPPORTED.get(tag)}.`,
      });
    }
    for (const tally of [this.pathErrors, this.attributeIssues, this.useIssues]) {
      const issue = tally.issue();
      if (issue) out.push(issue);
    }
    if (this.overflowed > 0) out.push(notFiniteIssue(this.overflowed));
    return out;
  }

  private byId(id: string): XmlElement | undefined {
    if (!this.ids) {
      // Iterative: a deep file must not overflow the stack here.
      const ids = new Map<string, XmlElement>();
      const todo: XmlElement[] = [this.root];
      while (todo.length > 0) {
        const e = todo.pop()!;
        const v = e.attrs.get('id');
        if (v !== undefined && !ids.has(v)) ids.set(v, e);
        for (let i = e.children.length - 1; i >= 0; i--) todo.push(e.children[i]!);
      }
      this.ids = ids;
    }
    return this.ids.get(id);
  }

  private infoOf(e: XmlElement): ElementInfo {
    let i = this.info.get(e);
    if (!i) {
      i = {};
      this.info.set(e, i);
    }
    return i;
  }

  private label(e: XmlElement): string {
    const info = this.infoOf(e);
    if (info.label === undefined) {
      // Cut: a label reaches issues and contours, and an id may be megabytes long.
      const id = e.attrs.get('id');
      info.label = quote(id ? `${e.name}#${id}` : e.name);
    }
    return info.label;
  }

  /** `property`, read once per element and name. */
  property(e: XmlElement, name: string): string | undefined {
    const info = this.infoOf(e);
    info.props ??= new Map();
    if (info.props.has(name)) return info.props.get(name);
    info.style ??= styleOf(e);
    const v = info.style.get(name) ?? e.attrs.get(name)?.trim();
    info.props.set(name, v);
    return v;
  }

  private hidden(e: XmlElement): boolean {
    const info = this.infoOf(e);
    info.hidden ??= this.property(e, 'display')?.toLowerCase() === 'none';
    return info.hidden;
  }

  private viewBox(e: XmlElement): ViewBox | null {
    const info = this.infoOf(e);
    if (info.viewBox === undefined) info.viewBox = parseViewBox(e.attrs.get('viewBox'));
    return info.viewBox;
  }

  private aspect(e: XmlElement): Aspect {
    const info = this.infoOf(e);
    info.aspect ??= parseAspect(e.attrs.get('preserveAspectRatio'));
    return info.aspect;
  }

  private len(e: XmlElement, name: string, base: number | null, fallback = 0): number {
    const raw = e.attrs.get(name);
    if (raw === undefined) return fallback;
    const info = this.infoOf(e);
    info.lengths ??= new Map();
    let split = info.lengths.get(name);
    if (split === undefined) {
      split = splitLength(raw);
      info.lengths.set(name, split);
      // Reported once per element and attribute, however often the element is drawn.
      if (lengthValue(split, base) === null) {
        this.attributeIssues.add(
          `${name}="${quote(raw)}" on <${quote(e.name)}> could not be read; it was taken as ${fallback}`,
        );
      }
    }
    return lengthValue(split, base) ?? fallback;
  }

  transformOf(e: XmlElement): SvgMatrix {
    const info = this.infoOf(e);
    if (info.transform) return info.transform;
    const raw = e.attrs.get('transform');
    let t = raw === undefined ? IDENTITY : parseTransform(raw);
    if (!t) {
      this.attributeIssues.add(
        `transform="${quote(raw!)}" on <${quote(e.name)}> could not be read; it was ignored`,
      );
      t = IDENTITY;
    }
    info.transform = t;
    return t;
  }

  /** Record a shape, unless what it maps to is not finite (then it is counted and dropped). */
  private shape(
    e: XmlElement,
    commands: readonly SvgPathCommand[],
    matrix: SvgMatrix,
    fillRule: SvgFillRule,
    circle?: SvgShape['circle'],
  ): void {
    this.commandCount += commands.length;
    if (this.commandCount > MAX_SVG_COMMANDS) {
      throw new SvgImportError(
        'too-complex',
        `The file's shapes have more than ${MAX_SVG_COMMANDS.toLocaleString('en')} path commands in all.`,
      );
    }
    if (commands.length === 0) return;
    let ok = matrix.every(Number.isFinite);
    for (const c of commands) {
      if (!ok) break;
      if (c.kind === 'Z') continue;
      const points = c.kind === 'C' ? [c.c1, c.c2, c.to] : c.kind === 'Q' ? [c.c, c.to] : [c.to];
      for (const p of points) if (notFinite(applyMatrix(matrix, p))) ok = false;
      if (
        c.kind === 'A' &&
        !Number.isFinite(Math.max(c.rx, c.ry) * Math.hypot(...matrix.slice(0, 4)))
      )
        ok = false;
    }
    if (circle && !Number.isFinite(circle.radius * Math.hypot(...matrix.slice(0, 4)))) ok = false;
    if (!ok) {
      this.overflowed++;
      return;
    }
    this.shapes.push({
      element: this.label(e),
      fillRule,
      matrix,
      commands,
      ...(circle ? { circle } : {}),
    });
  }

  /**
   * Walk an element under the matrix `m` (its parent's user units to millimetres), with the fill
   * rule it inherits. Every call counts against `MAX_SVG_VISITS`, and `depth` against
   * `MAX_SVG_DEPTH` (nesting through `<use>` included).
   */
  walk(
    e: XmlElement,
    m: SvgMatrix,
    vp: Viewport,
    uses: readonly XmlElement[],
    depth: number,
    inherited: SvgFillRule,
  ): void {
    if (++this.visits > MAX_SVG_VISITS) {
      throw new SvgImportError(
        'too-complex',
        `The file draws more than ${MAX_SVG_VISITS.toLocaleString('en')} elements (counting each <use> of one).`,
      );
    }
    if (depth > MAX_SVG_DEPTH) {
      throw new SvgImportError(
        'too-complex',
        `The file nests elements more than ${MAX_SVG_DEPTH} deep (counting <use>).`,
      );
    }
    if (this.hidden(e)) return;
    const name = e.name;
    if (SILENT.has(name)) return;
    const why = UNSUPPORTED.get(name);
    if (why !== undefined) {
      this.unsupported.set(name, (this.unsupported.get(name) ?? 0) + 1);
      return;
    }
    const rule = this.property(e, 'fill-rule');
    const fill: SvgFillRule =
      rule === 'evenodd' ? 'evenodd' : rule === 'nonzero' ? 'nonzero' : inherited;
    const here = multiply(m, this.transformOf(e));
    const diag = Math.hypot(vp.width, vp.height) / Math.SQRT2;
    const next = depth + 1;
    switch (name) {
      case 'svg': {
        // A nested viewport (the root is set up by `parseSvg`).
        const x = this.len(e, 'x', vp.width);
        const y = this.len(e, 'y', vp.height);
        const w = this.len(e, 'width', vp.width, vp.width);
        const h = this.len(e, 'height', vp.height, vp.height);
        const vb = this.viewBox(e);
        const inner = vb
          ? multiply(here, viewBoxMatrix(vb, x, y, w, h, this.aspect(e)))
          : multiply(here, translate(x, y));
        const port = vb ? { width: vb.w, height: vb.h } : { width: w, height: h };
        for (const c of e.children) this.walk(c, inner, port, uses, next, fill);
        return;
      }
      case 'g':
      case 'a':
      case 'switch':
        for (const c of e.children) this.walk(c, here, vp, uses, next, fill);
        return;
      case 'use': {
        const info = this.infoOf(e);
        if (!info.use) {
          const href = (e.attrs.get('href') ?? e.attrs.get('xlink:href') ?? '').trim();
          const target = href.startsWith('#') ? this.byId(href.slice(1)) : undefined;
          if (!target) {
            this.useIssues.add(
              `A <use> names "${quote(href)}", which is not in the file; it was skipped`,
            );
          }
          info.use = { target };
        }
        const { target } = info.use;
        if (!target) return;
        if (uses.includes(target) || uses.length >= MAX_USE_DEPTH) {
          if (!this.loopingUses.has(e)) {
            this.loopingUses.add(e);
            this.useIssues.add('A <use> refers to itself or nests too deep; it was skipped');
          }
          return;
        }
        const at = multiply(
          here,
          translate(this.len(e, 'x', vp.width), this.len(e, 'y', vp.height)),
        );
        const chain = [...uses, target];
        if (target.name === 'symbol') {
          if (this.hidden(target)) return;
          const vb = this.viewBox(target);
          const w = this.len(e, 'width', vp.width, vb?.w ?? vp.width);
          const h = this.len(e, 'height', vp.height, vb?.h ?? vp.height);
          const inner = vb ? multiply(at, viewBoxMatrix(vb, 0, 0, w, h, this.aspect(target))) : at;
          const port = vb ? { width: vb.w, height: vb.h } : vp;
          for (const c of target.children) this.walk(c, inner, port, chain, next + 1, fill);
        } else {
          this.walk(target, at, vp, chain, next, fill);
        }
        return;
      }
      case 'path': {
        const d = e.attrs.get('d');
        if (d === undefined) return;
        let commands = this.parsedPaths.get(e);
        if (!commands) {
          const parsed = parsePathData(d);
          if (parsed.error) {
            this.pathErrors.add(
              `<${this.label(e)}>: the path data has an error (${parsed.error}); it was read up to it`,
            );
          }
          commands = parsed.commands;
          this.parsedPaths.set(e, commands);
        }
        this.shape(e, commands, here, fill);
        return;
      }
      case 'rect': {
        const x = this.len(e, 'x', vp.width);
        const y = this.len(e, 'y', vp.height);
        const w = this.len(e, 'width', vp.width);
        const h = this.len(e, 'height', vp.height);
        if (!(w > 0 && h > 0)) return;
        const rxRaw = e.attrs.get('rx');
        const ryRaw = e.attrs.get('ry');
        let rx = rxRaw === undefined || rxRaw === 'auto' ? null : this.len(e, 'rx', vp.width);
        let ry = ryRaw === undefined || ryRaw === 'auto' ? null : this.len(e, 'ry', vp.height);
        rx ??= ry ?? 0;
        ry ??= rx;
        rx = Math.min(Math.max(rx, 0), w / 2);
        ry = Math.min(Math.max(ry, 0), h / 2);
        const cmds: SvgPathCommand[] = [];
        const arc = (to: Vec2): SvgPathCommand => ({
          kind: 'A',
          rx: rx!,
          ry: ry!,
          rotation: 0,
          large: false,
          sweep: true,
          to,
        });
        if (rx > 0 && ry > 0) {
          cmds.push(
            { kind: 'M', to: [x + rx, y] },
            { kind: 'L', to: [x + w - rx, y] },
            arc([x + w, y + ry]),
            { kind: 'L', to: [x + w, y + h - ry] },
            arc([x + w - rx, y + h]),
            { kind: 'L', to: [x + rx, y + h] },
            arc([x, y + h - ry]),
            { kind: 'L', to: [x, y + ry] },
            arc([x + rx, y]),
            { kind: 'Z' },
          );
        } else {
          cmds.push(
            { kind: 'M', to: [x, y] },
            { kind: 'L', to: [x + w, y] },
            { kind: 'L', to: [x + w, y + h] },
            { kind: 'L', to: [x, y + h] },
            { kind: 'Z' },
          );
        }
        this.shape(e, cmds, here, fill);
        return;
      }
      case 'circle':
      case 'ellipse': {
        const cx = this.len(e, 'cx', vp.width);
        const cy = this.len(e, 'cy', vp.height);
        let rx: number;
        let ry: number;
        if (name === 'circle') {
          rx = ry = this.len(e, 'r', diag);
        } else {
          const rxRaw = e.attrs.get('rx');
          const ryRaw = e.attrs.get('ry');
          const a = rxRaw === undefined || rxRaw === 'auto' ? null : this.len(e, 'rx', vp.width);
          const b = ryRaw === undefined || ryRaw === 'auto' ? null : this.len(e, 'ry', vp.height);
          rx = a ?? b ?? 0;
          ry = b ?? a ?? 0;
        }
        if (!(rx > 0 && ry > 0)) return;
        this.shape(
          e,
          ellipseCommands(cx, cy, rx, ry),
          here,
          fill,
          rx === ry ? { center: [cx, cy], radius: rx } : undefined,
        );
        return;
      }
      case 'line': {
        const a: Vec2 = [this.len(e, 'x1', vp.width), this.len(e, 'y1', vp.height)];
        const b: Vec2 = [this.len(e, 'x2', vp.width), this.len(e, 'y2', vp.height)];
        this.shape(
          e,
          [
            { kind: 'M', to: a },
            { kind: 'L', to: b },
          ],
          here,
          fill,
        );
        return;
      }
      case 'polyline':
      case 'polygon': {
        const info = this.infoOf(e);
        if (!info.points) {
          const { values, clean } = numberList(e.attrs.get('points') ?? '');
          if (!clean || values.length % 2 === 1) {
            this.pathErrors.add(`<${this.label(e)}>: its points list has an error; read up to it`);
          }
          const cmds: SvgPathCommand[] = [];
          for (let k = 0; k + 1 < values.length; k += 2) {
            cmds.push({ kind: k === 0 ? 'M' : 'L', to: [values[k]!, values[k + 1]!] });
          }
          if (cmds.length >= 2 && name === 'polygon') cmds.push({ kind: 'Z' });
          info.points = cmds;
        }
        if (info.points.length < 2) return;
        this.shape(e, info.points, here, fill);
        return;
      }
      default:
        // Elements of other vocabularies (editor metadata) and unknown ones: nothing to draw.
        return;
    }
  }
}

function notFiniteIssue(n: number): SvgIssue {
  return {
    code: 'not-finite',
    message: `${n.toLocaleString('en')} shape${n === 1 ? '' : 's'} whose coordinates overflow under their transforms ${n === 1 ? 'was' : 'were'} dropped.`,
  };
}

// Parse ------------------------------------------------------------------------------------

/**
 * Read an SVG file's shapes, once: paths, rectangles, circles, ellipses, lines, polylines and
 * polygons, under their transforms, the root's viewBox and their fill rules, mapped to
 * millimetres with y up and the SVG page's bottom left corner at the origin (the top left of the
 * user space when the file gives no page size). Styles other than `display` and `fill-rule` are
 * not read: stroked and filled shapes alike become outlines. Throws `SvgImportError` for a file
 * that cannot be read at all; everything else is reported in `issues`.
 */
export function parseSvg(text: string): ParsedSvg {
  const root = parseXml(text);
  if (root.name !== 'svg') {
    throw new SvgImportError(
      'not-svg',
      `The file's root element is <${quote(root.name)}>, not <svg>.`,
    );
  }
  // The root viewport: width and height in real units, the viewBox in user units.
  const vb = parseViewBox(root.attrs.get('viewBox'));
  let width = lengthMm(root.attrs.get('width'));
  let height = lengthMm(root.attrs.get('height'));
  if (vb) {
    if (width === null && height === null) {
      width = vb.w * MM_PER_PX;
      height = vb.h * MM_PER_PX;
    } else if (width === null) width = (height! * vb.w) / vb.h;
    else if (height === null) height = (width * vb.h) / vb.w;
  }
  const hasPage =
    width !== null && height !== null && width > 0 && height > 0 && Number.isFinite(width * height);
  // User units to millimetres, y down: through the viewBox, or 96 user units to the inch.
  const toPage: SvgMatrix =
    vb && hasPage
      ? viewBoxMatrix(vb, 0, 0, width!, height!, parseAspect(root.attrs.get('preserveAspectRatio')))
      : scaling(MM_PER_PX, MM_PER_PX);
  // y flipped so the page's bottom left corner is the origin.
  const toMm: SvgMatrix = [1, 0, 0, -1, 0, hasPage ? height! : 0];
  const walker = new Walker(root);
  const rootMatrix = multiply(multiply(toMm, toPage), walker.transformOf(root));
  const vp: Viewport = vb
    ? { width: vb.w, height: vb.h }
    : { width: (width ?? 0) / MM_PER_PX, height: (height ?? 0) / MM_PER_PX };
  const rule = walker.property(root, 'fill-rule');
  const fill: SvgFillRule = rule === 'evenodd' ? 'evenodd' : 'nonzero';
  for (const c of root.children) walker.walk(c, rootMatrix, vp, [], 1, fill);
  return {
    shapes: walker.shapes,
    issues: walker.issues(),
    page: hasPage ? { width: width!, height: height! } : null,
  };
}

// Fit: lines, arcs and circles -------------------------------------------------------------

/**
 * The shapes as lines, circular arcs and circles (`SvgImport`), at `scale` (about the page's
 * bottom left corner), within `tolerance`. Contours or circles that are not finite after scaling
 * are dropped with a `not-finite` issue.
 */
export function fitSvg(parsed: ParsedSvg, options: SvgFitOptions = {}): SvgImport {
  const scale = options.scale ?? 1;
  const tolerance = options.tolerance ?? DEFAULT_SVG_TOLERANCE;
  const maxSegments = options.maxSegments ?? MAX_SVG_SEGMENTS;
  if (!(Number.isFinite(scale) && scale > 0)) throw new RangeError('scale must be above 0');
  if (!(Number.isFinite(tolerance) && tolerance > 0)) {
    throw new RangeError('tolerance must be above 0');
  }
  const ctx: Context = {
    arcs: options.curves !== 'lines',
    fitTolerance: tolerance * FIT_SHARE,
    minLength: tolerance * MIN_SHARE,
    maxSegments,
    segments: 0,
    maxDeviation: 0,
    contours: [],
    circles: [],
    openPaths: 0,
  };
  const s = scaling(scale, scale);
  for (const shape of parsed.shapes) {
    const m = multiply(s, shape.matrix);
    if (shape.circle && isSimilarity(m)) {
      if (++ctx.segments > ctx.maxSegments) {
        throw new SvgImportError(
          'too-complex',
          `The file makes more than ${ctx.maxSegments.toLocaleString('en')} lines and arcs.`,
        );
      }
      const k = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
      ctx.circles.push({
        center: applyMatrix(m, shape.circle.center),
        radius: shape.circle.radius * k,
        element: shape.element,
      });
      continue;
    }
    drawPath(shape.commands, m, new ContourBuilder(ctx, shape.element));
  }
  // Drop anything that overflowed (a scale past what the numbers hold).
  const finiteSegment = (g: SvgSegment) =>
    !notFinite(g.start) && !notFinite(g.end) && (g.kind !== 'arc' || !notFinite(g.center));
  const contours = ctx.contours.filter((c) => c.segments.every(finiteSegment));
  const circles = ctx.circles.filter(
    (c) => !notFinite(c.center) && Number.isFinite(c.radius) && c.radius > 0,
  );
  const dropped = ctx.contours.length - contours.length + ctx.circles.length - circles.length;
  const issues: SvgIssue[] = [...parsed.issues];
  if (dropped > 0) issues.push(notFiniteIssue(dropped));
  const open = contours.filter((c) => !c.closed).length;
  if (open > 0) {
    issues.push({
      code: 'open-path',
      message: `${open.toLocaleString('en')} open path${open === 1 ? '' : 's'} (lines that do not close) bound no region.`,
    });
  }
  return {
    contours,
    circles,
    issues,
    bounds: svgGeometryBounds(contours, circles),
    page: parsed.page
      ? { width: parsed.page.width * scale, height: parsed.page.height * scale }
      : null,
    maxDeviation: ctx.maxDeviation,
  };
}

/** `fitSvg(parseSvg(text), options)`. */
export function importSvg(text: string, options: SvgImportOptions = {}): SvgImport {
  const scale = options.scale ?? 1;
  const tolerance = options.tolerance ?? DEFAULT_SVG_TOLERANCE;
  if (!(Number.isFinite(scale) && scale > 0)) throw new RangeError('scale must be above 0');
  if (!(Number.isFinite(tolerance) && tolerance > 0)) {
    throw new RangeError('tolerance must be above 0');
  }
  return fitSvg(parseSvg(text), options);
}

/** The extent of contours and circles, arcs by their true extremes; null when there are none. */
export function svgGeometryBounds(
  contours: readonly SvgContour[],
  circles: readonly SvgCircle[],
): SvgBounds | null {
  const box = new BoundsBuilder();
  for (const c of contours) {
    for (const s of c.segments) {
      box.add(s.start);
      box.add(s.end);
      if (s.kind !== 'arc') continue;
      const r = dist(s.start, s.center);
      const dir = s.clockwise ? -1 : 1;
      const sweep = sweepAngle(s.center, s.start, s.end, dir);
      for (let q = 0; q < 4; q++) {
        const extreme: Vec2 = [
          s.center[0] + r * Math.cos((q * Math.PI) / 2),
          s.center[1] + r * Math.sin((q * Math.PI) / 2),
        ];
        if (sweepAngle(s.center, s.start, extreme, dir) <= sweep) box.add(extreme);
      }
    }
  }
  for (const c of circles) {
    box.add([c.center[0] - c.radius, c.center[1] - c.radius]);
    box.add([c.center[0] + c.radius, c.center[1] + c.radius]);
  }
  return box.bounds();
}

class BoundsBuilder {
  private x0 = Infinity;
  private y0 = Infinity;
  private x1 = -Infinity;
  private y1 = -Infinity;
  add(p: Vec2): void {
    this.x0 = Math.min(this.x0, p[0]);
    this.y0 = Math.min(this.y0, p[1]);
    this.x1 = Math.max(this.x1, p[0]);
    this.y1 = Math.max(this.y1, p[1]);
  }
  bounds(): SvgBounds | null {
    return Number.isFinite(this.x0) ? { min: [this.x0, this.y0], max: [this.x1, this.y1] } : null;
  }
}

/** Which point of the artwork goes to the placement point. */
export type SvgAnchor = 'page' | 'bottom-left' | 'center';

/**
 * The point of the artwork that `anchor` names: the page's bottom left corner (the origin;
 * the geometry's bottom left when there is no page), or the geometry's bottom left corner or
 * centre.
 */
export function svgAnchorPoint(
  bounds: SvgBounds,
  page: { width: number; height: number } | null,
  anchor: SvgAnchor,
): Vec2 {
  if (anchor === 'center') {
    return [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2];
  }
  return anchor === 'page' && page ? [0, 0] : bounds.min;
}

/**
 * The import moved so that its anchor lands on `at`. A translation, so arcs stay exact; placing
 * needs no fit, so it is cheap to redo.
 */
export function placeSvgImport(imp: SvgImport, anchor: SvgAnchor, at: Vec2): SvgImport {
  const b = imp.bounds;
  if (!b) return imp;
  const from = svgAnchorPoint(b, imp.page, anchor);
  const dx = at[0] - from[0];
  const dy = at[1] - from[1];
  if (dx === 0 && dy === 0) return imp;
  const move = (p: Vec2): Vec2 => [p[0] + dx, p[1] + dy];
  const segment = (s: SvgSegment): SvgSegment =>
    s.kind === 'line'
      ? { kind: 'line', start: move(s.start), end: move(s.end) }
      : { ...s, center: move(s.center), start: move(s.start), end: move(s.end) };
  return {
    ...imp,
    contours: imp.contours.map((c) => ({ ...c, segments: c.segments.map(segment) })),
    circles: imp.circles.map((c) => ({ ...c, center: move(c.center) })),
    bounds: { min: move(b.min), max: move(b.max) },
  };
}

/** Lines, arcs and circles in an import. */
export function svgImportCounts(imp: SvgImport): { lines: number; arcs: number; circles: number } {
  let lines = 0;
  let arcs = 0;
  for (const c of imp.contours) {
    for (const s of c.segments) {
      if (s.kind === 'line') lines++;
      else arcs++;
    }
  }
  return { lines, arcs, circles: imp.circles.length };
}

// Outline paths: lines and Beziers ---------------------------------------------------------

/** A path command of an outline path: the shape of `@manufakture/sketch`'s `PathCommand`. */
export type SvgOutlineCommand =
  | { readonly kind: 'moveTo'; readonly to: Vec2 }
  | { readonly kind: 'lineTo'; readonly to: Vec2 }
  | { readonly kind: 'quadTo'; readonly control: Vec2; readonly to: Vec2 }
  | {
      readonly kind: 'cubicTo';
      readonly control1: Vec2;
      readonly control2: Vec2;
      readonly to: Vec2;
    }
  | { readonly kind: 'close' };

/** One shape as an outline path, in millimetres (y up, page origin, scale 1). */
export interface SvgOutlinePath {
  readonly element: string;
  readonly fillRule: SvgFillRule;
  readonly commands: readonly SvgOutlineCommand[];
}

export interface SvgOutlinePaths {
  readonly paths: readonly SvgOutlinePath[];
  /** Extent of the paths, Beziers by their true extremes; null when there are none. */
  readonly bounds: SvgBounds | null;
  /** Path commands in all. */
  readonly commands: number;
}

/** Distance from a quarter circle of radius 1 to its usual cubic (de facto 2.7253e-4). */
const QUARTER_CUBIC_ERROR = 2.7253e-4;
/** Most cubics one elliptical arc becomes. */
const MAX_ARC_CUBICS = 256;

/** The largest stretch (operator 2-norm) of a 2 x 2 linear map `[a, b, c, d]` (columns). */
function stretch(a: number, b: number, c: number, d: number): number {
  const p = a * a + b * b + c * c + d * d;
  const q = a * d - b * c;
  return Math.sqrt((p + Math.sqrt(Math.max(0, p * p - 4 * q * q))) / 2);
}

export interface SvgOutlineOptions {
  /** Largest distance (mm) between an elliptical arc and its cubics. Default 0.001. */
  tolerance?: number;
  /** Most path commands in all; more is refused (`too-complex`) as soon as it is passed. */
  maxCommands?: number;
  /** Most paths; more is refused (`too-complex`) before the next is made. */
  maxPaths?: number;
  /**
   * Largest coordinate (mm, either sign) a command may have; one past it (or not finite) is
   * refused (`out-of-range`) when it is made, and an arc is checked before it is split.
   */
  maxCoordinate?: number;
}

/**
 * The shapes as paths of lines, quadratic and cubic Beziers, for a sketch outline: lines and
 * Beziers mapped exactly (an affine map keeps a Bezier a Bezier), elliptical arcs as cubics of
 * at most a quarter turn, as many as keep them within `tolerance` (mm) of the true arc. Closed
 * subpaths keep their `close`.
 *
 * The output is bounded while it is made: past `maxCommands` (default `MAX_SVG_COMMANDS`) or
 * `maxPaths`, or with a coordinate past `maxCoordinate`, it throws `SvgImportError` at once, so a
 * file whose arcs are reused under a huge scale never builds more than the caps.
 */
export function svgOutlinePaths(
  parsed: ParsedSvg,
  options: SvgOutlineOptions = {},
): SvgOutlinePaths {
  const tolerance = options.tolerance ?? DEFAULT_SVG_OUTLINE_TOLERANCE;
  const maxCommands = options.maxCommands ?? MAX_SVG_COMMANDS;
  const maxPaths = options.maxPaths ?? Infinity;
  const maxCoordinate = options.maxCoordinate ?? Infinity;
  if (!(Number.isFinite(tolerance) && tolerance > 0)) {
    throw new RangeError('tolerance must be above 0');
  }
  const paths: SvgOutlinePath[] = [];
  const box = new BoundsBuilder();
  let total = 0;
  const tooMany = (): never => {
    throw new SvgImportError(
      'too-complex',
      `The file makes more than ${maxCommands.toLocaleString('en')} path commands.`,
      'commands',
    );
  };
  const inRange = (v: number) => Number.isFinite(v) && Math.abs(v) <= maxCoordinate;
  const check = (p: Vec2) => {
    if (!inRange(p[0]) || !inRange(p[1])) {
      throw new SvgImportError(
        'out-of-range',
        Number.isFinite(maxCoordinate)
          ? `The file reaches past ${maxCoordinate.toLocaleString('en')} mm from the page's corner.`
          : 'The file has coordinates that are not finite.',
        'coordinates',
      );
    }
  };
  for (const shape of parsed.shapes) {
    if (paths.length >= maxPaths) {
      throw new SvgImportError(
        'too-complex',
        `The file has more than ${maxPaths.toLocaleString('en')} shapes.`,
        'paths',
      );
    }
    const m = shape.matrix;
    const map = (p: Vec2) => applyMatrix(m, p);
    const out: SvgOutlineCommand[] = [];
    let cur: Vec2 = [0, 0];
    let start: Vec2 = [0, 0];
    let last: Vec2 = [0, 0];
    const push = (c: SvgOutlineCommand) => {
      if (total + out.length >= maxCommands) tooMany();
      if (c.kind === 'cubicTo') {
        check(c.control1);
        check(c.control2);
      } else if (c.kind === 'quadTo') check(c.control);
      if (c.kind !== 'close') check(c.to);
      out.push(c);
      if (c.kind === 'close') return;
      box.add(c.to);
      if (c.kind === 'quadTo') bezierExtremes([last, c.control, c.to], box);
      if (c.kind === 'cubicTo') bezierExtremes([last, c.control1, c.control2, c.to], box);
      last = c.to;
    };
    for (const c of shape.commands) {
      switch (c.kind) {
        case 'M':
          push({ kind: 'moveTo', to: map(c.to) });
          cur = start = c.to;
          break;
        case 'L':
          push({ kind: 'lineTo', to: map(c.to) });
          cur = c.to;
          break;
        case 'C':
          push({ kind: 'cubicTo', control1: map(c.c1), control2: map(c.c2), to: map(c.to) });
          cur = c.to;
          break;
        case 'Q':
          push({ kind: 'quadTo', control: map(c.c), to: map(c.to) });
          cur = c.to;
          break;
        case 'A': {
          if (cur[0] === c.to[0] && cur[1] === c.to[1]) break;
          // Both ends within range before the arc is split: a scale that throws the artwork
          // out of range is refused here, not after the arc has made its cubics.
          check(map(cur));
          check(map(c.to));
          const a = arcParams(cur, c);
          if (!a) {
            push({ kind: 'lineTo', to: map(c.to) });
            cur = c.to;
            break;
          }
          // The arc is the image of a unit circle under m after the ellipse's own map.
          const ea = a.rx * a.cos;
          const eb = a.rx * a.sin;
          const ec = -a.ry * a.sin;
          const ed = a.ry * a.cos;
          const k = stretch(
            m[0] * ea + m[2] * eb,
            m[1] * ea + m[3] * eb,
            m[0] * ec + m[2] * ed,
            m[1] * ec + m[3] * ed,
          );
          // The error of a cubic over a circular arc grows as the sixth power of its angle.
          const maxAngle = Math.min(
            Math.PI / 2,
            (Math.PI / 2) * Math.pow(tolerance / (QUARTER_CUBIC_ERROR * k), 1 / 6),
          );
          // At most MAX_ARC_CUBICS, whatever the scale: the stretch `k` grows with it (and is
          // unbounded for a degenerate ellipse even within range), so the cap is what bounds it.
          const wanted = Math.ceil(Math.abs(a.delta) / maxAngle);
          const n = Number.isNaN(wanted)
            ? MAX_ARC_CUBICS
            : Math.min(MAX_ARC_CUBICS, Math.max(1, wanted));
          if (total + out.length + n > maxCommands) tooMany();
          const step = a.delta / n;
          const h = (4 / 3) * Math.tan(step / 4);
          for (let i = 0; i < n; i++) {
            const t0 = a.theta1 + i * step;
            const t1 = t0 + step;
            const p0 = arcPoint(a, t0);
            const p3 = arcPoint(a, t1);
            // Tangents of the ellipse: its derivative by the angle.
            const d0: Vec2 = [
              -a.rx * Math.sin(t0) * a.cos - a.ry * Math.cos(t0) * a.sin,
              -a.rx * Math.sin(t0) * a.sin + a.ry * Math.cos(t0) * a.cos,
            ];
            const d1: Vec2 = [
              -a.rx * Math.sin(t1) * a.cos - a.ry * Math.cos(t1) * a.sin,
              -a.rx * Math.sin(t1) * a.sin + a.ry * Math.cos(t1) * a.cos,
            ];
            push({
              kind: 'cubicTo',
              control1: map([p0[0] + h * d0[0], p0[1] + h * d0[1]]),
              control2: map([p3[0] - h * d1[0], p3[1] - h * d1[1]]),
              to: i === n - 1 ? map(c.to) : map(p3),
            });
          }
          cur = c.to;
          break;
        }
        case 'Z':
          push({ kind: 'close' });
          cur = start;
          break;
      }
    }
    if (out.length === 0) continue;
    total += out.length;
    paths.push({ element: shape.element, fillRule: shape.fillRule, commands: out });
  }
  return { paths, bounds: box.bounds(), commands: total };
}

/** Add the extremes of a quadratic or cubic Bezier (its points where x or y turns) to `box`. */
function bezierExtremes(p: readonly Vec2[], box: BoundsBuilder): void {
  for (const axis of [0, 1] as const) {
    const v = p.map((q) => q[axis]);
    const roots: number[] = [];
    if (v.length === 3) {
      const den = v[0]! - 2 * v[1]! + v[2]!;
      if (den !== 0) roots.push((v[0]! - v[1]!) / den);
    } else {
      // Derivative / 3: a t^2 + b t + c.
      const a = -v[0]! + 3 * v[1]! - 3 * v[2]! + v[3]!;
      const b = 2 * (v[0]! - 2 * v[1]! + v[2]!);
      const c = v[1]! - v[0]!;
      if (Math.abs(a) < 1e-12 * (Math.abs(b) + Math.abs(c) + 1e-300)) {
        if (b !== 0) roots.push(-c / b);
      } else {
        const disc = b * b - 4 * a * c;
        if (disc >= 0) {
          const r = Math.sqrt(disc);
          roots.push((-b + r) / (2 * a), (-b - r) / (2 * a));
        }
      }
    }
    for (const t of roots) {
      if (!(t > 0 && t < 1)) continue;
      box.add(bezierAt(p, t));
    }
  }
}

function bezierAt(p: readonly Vec2[], t: number): Vec2 {
  let pts = p.map((q) => [q[0], q[1]] as [number, number]);
  while (pts.length > 1) {
    pts = pts
      .slice(1)
      .map((q, i) => [pts[i]![0] + t * (q[0] - pts[i]![0]), pts[i]![1] + t * (q[1] - pts[i]![1])]);
  }
  return pts[0]!;
}
