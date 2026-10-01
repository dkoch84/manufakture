// Shared by the tests: tiny hand-built TrueType fonts and crafted tables, for
// the hostile inputs a real font never has.

/** Concatenates byte arrays. */
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const pad4 = (b: Uint8Array) => (b.length % 4 ? concat(b, new Uint8Array(4 - (b.length % 4))) : b);

/** Big-endian unsigned 16-bit values. */
function u16s(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setUint16(i * 2, v & 0xffff));
  return out;
}

export interface TestFontOptions {
  /** Character code to glyph index; a format 4 cmap with one segment each. */
  cmap: [number, number][];
  /** Extra tables (a crafted GPOS, say). */
  tables?: Record<string, Uint8Array>;
  /** Leave the `post` table out. */
  noPost?: boolean;
}

/**
 * A minimal TrueType font: 1000 units per em, every glyph 600 units wide, long
 * `loca` offsets, the given glyph records (glyph 0 is the first).
 */
export function buildTtf(glyphs: Uint8Array[], options: TestFontOptions): Uint8Array {
  const n = glyphs.length;
  const head = new Uint8Array(54);
  {
    const v = new DataView(head.buffer);
    v.setUint32(0, 0x10000);
    v.setUint32(12, 0x5f0f3cf5);
    v.setUint16(18, 1000);
    v.setInt16(36, -1000);
    v.setInt16(38, -1000);
    v.setInt16(40, 1000);
    v.setInt16(42, 1000);
    v.setInt16(50, 1); // long loca
  }
  const hhea = new Uint8Array(36);
  {
    const v = new DataView(hhea.buffer);
    v.setUint32(0, 0x10000);
    v.setInt16(4, 800);
    v.setInt16(6, -200);
    v.setUint16(34, n);
  }
  const maxp = new Uint8Array(6);
  new DataView(maxp.buffer).setUint32(0, 0x5000);
  new DataView(maxp.buffer).setUint16(4, n);
  const hmtx = new Uint8Array(4 * n);
  for (let i = 0; i < n; i++) new DataView(hmtx.buffer).setUint16(i * 4, 600);

  const loca = new Uint8Array(4 * (n + 1));
  const locaView = new DataView(loca.buffer);
  const glyfParts: Uint8Array[] = [];
  let offset = 0;
  glyphs.forEach((g, i) => {
    locaView.setUint32(i * 4, offset);
    const padded = pad4(g);
    glyfParts.push(padded);
    offset += padded.length;
  });
  locaView.setUint32(n * 4, offset);

  const segments = [
    ...options.cmap.map(([code, glyph]) => ({ start: code, end: code, delta: glyph - code })),
    { start: 0xffff, end: 0xffff, delta: 1 },
  ];
  const count = segments.length;
  const subtable = concat(
    u16s(4, 16 + count * 8, 0, count * 2, 0, 0, 0),
    u16s(...segments.map((s) => s.end)),
    u16s(0),
    u16s(...segments.map((s) => s.start)),
    u16s(...segments.map((s) => s.delta)),
    u16s(...segments.map(() => 0)),
  );
  const cmap = concat(u16s(0, 1, 3, 1, 0, 12), subtable);
  const name = u16s(0, 0, 6);
  const post = new Uint8Array(32);
  new DataView(post.buffer).setUint32(0, 0x30000);

  const tables: [string, Uint8Array][] = [
    ['cmap', cmap],
    ['glyf', concat(...glyfParts)],
    ['head', head],
    ['hhea', hhea],
    ['hmtx', hmtx],
    ['loca', loca],
    ['maxp', maxp],
    ['name', name],
  ];
  if (!options.noPost) tables.push(['post', post]);
  for (const [tag, data] of Object.entries(options.tables ?? {})) tables.push([tag, data]);
  tables.sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const header = new Uint8Array(12 + tables.length * 16);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, 0x10000);
  headerView.setUint16(4, tables.length);
  let at = header.length;
  const bodies: Uint8Array[] = [];
  tables.forEach(([tag, data], i) => {
    const record = 12 + i * 16;
    for (let k = 0; k < 4; k++) header[record + k] = tag.charCodeAt(k);
    headerView.setUint32(record + 8, at);
    headerView.setUint32(record + 12, data.length);
    const padded = pad4(data);
    bodies.push(padded);
    at += padded.length;
  });
  return concat(header, ...bodies);
}

/** A composite glyph of `k` copies of glyph `child`, each moved a little. */
export function compositeGlyph(child: number, k: number): Uint8Array {
  const out = new Uint8Array(10 + k * 8);
  const v = new DataView(out.buffer);
  v.setInt16(0, -1);
  for (let i = 0; i < k; i++) {
    const at = 10 + i * 8;
    // ARG_1_AND_2_ARE_WORDS | ARGS_ARE_XY_VALUES, MORE_COMPONENTS on all but the last.
    v.setUint16(at, (i < k - 1 ? 0x20 : 0) | 0x1 | 0x2);
    v.setUint16(at + 2, child);
    v.setInt16(at + 4, i % 7);
    v.setInt16(at + 6, (i * 3) % 11);
  }
  return out;
}

/** A composite glyph of one component per entry of `children`, all at the origin. */
export function compositeOf(children: readonly number[]): Uint8Array {
  const out = new Uint8Array(10 + children.length * 6);
  const v = new DataView(out.buffer);
  v.setInt16(0, -1);
  children.forEach((child, i) => {
    const at = 10 + i * 6;
    // ARGS_ARE_XY_VALUES (byte offsets of 0), MORE_COMPONENTS on all but the last.
    v.setUint16(at, (i < children.length - 1 ? 0x20 : 0) | 0x2);
    v.setUint16(at + 2, child);
  });
  return out;
}

/** A simple glyph with no contours and no points (unlike an empty glyph, it has a header). */
export function noContoursGlyph(): Uint8Array {
  return new Uint8Array(10);
}

/** A simple glyph of one contour of `points` points, all at the origin. */
export function onePathGlyph(points: number): Uint8Array {
  const flagBytes = Math.ceil(points / 256) * 2;
  const out = new Uint8Array(10 + 2 + 2 + flagBytes);
  const v = new DataView(out.buffer);
  v.setInt16(0, 1);
  v.setUint16(10, points - 1);
  let at = 14;
  for (let left = points; left > 0;) {
    const run = Math.min(256, left);
    out[at++] = 0x31 | 0x8; // on-curve, x and y repeated (zero deltas), repeat flag
    out[at++] = run - 1;
    left -= run;
  }
  return out;
}

/** A simple glyph: one triangle, (0, 0), (500, 0), (250, 500). */
export function triangleGlyph(): Uint8Array {
  const out = new Uint8Array(29);
  const v = new DataView(out.buffer);
  v.setInt16(0, 1);
  v.setUint16(10, 2); // end point of contour 0
  v.setUint16(12, 0); // no instructions
  out.set([1, 1, 1], 14); // on-curve, 16-bit deltas
  [0, 500, -250].forEach((dx, i) => v.setInt16(17 + i * 2, dx));
  [0, 0, 500].forEach((dy, i) => v.setInt16(23 + i * 2, dy));
  return out;
}

/** A simple glyph of `contours` contours of two points each, all at the origin. */
export function manyContoursGlyph(contours: number): Uint8Array {
  const points = contours * 2;
  const flagBytes = Math.ceil(points / 256) * 2;
  const out = new Uint8Array(10 + contours * 2 + 2 + flagBytes);
  const v = new DataView(out.buffer);
  v.setInt16(0, contours);
  for (let i = 0; i < contours; i++) v.setUint16(10 + i * 2, i * 2 + 1);
  let at = 10 + contours * 2 + 2;
  for (let left = points; left > 0;) {
    const run = Math.min(256, left);
    out[at++] = 0x31 | 0x8; // on-curve, x and y repeated (zero deltas), repeat flag
    out[at++] = run - 1;
    left -= run;
  }
  return out;
}

/**
 * A GPOS table whose kerning lookups multiply: the `latn` default language
 * system lists feature 0 (`kern`) `features` times; the feature lists
 * `lookups` lookup indexes (all 0, or 0 to lookups - 1 with `distinct`), every
 * lookup record points at one PairPos lookup, and that lookup lists one
 * format 1 subtable (which covers no glyph) `subtables` times.
 */
export function multiplyingGpos(options: {
  features: number;
  lookups: number;
  distinct: boolean;
  subtables: number;
}): Uint8Array {
  const { features, lookups, distinct, subtables } = options;
  const lookupCount = distinct ? lookups : 1;
  const scriptList = 10;
  const featureList = 30;
  const feature = featureList + 8;
  const lookupList = feature + 4 + 2 * lookups;
  const lookupRelative = 2 + lookupCount * 2;
  const lookup = lookupList + lookupRelative;
  const subtableRelative = 6 + subtables * 2;
  const subtable = lookup + subtableRelative;
  const script = subtable + 16;
  const langSys = script + 4;
  const length = langSys + 6 + 2 * features;
  if (lookupList > 0xffff || script - scriptList > 0xffff || subtableRelative > 0xffff) {
    throw new Error('GPOS offsets overflow');
  }
  const out = new Uint8Array(length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x10000);
  v.setUint16(4, scriptList);
  v.setUint16(6, featureList);
  v.setUint16(8, lookupList);
  // ScriptList: one script, latn.
  v.setUint16(scriptList, 1);
  out.set([0x6c, 0x61, 0x74, 0x6e], scriptList + 2);
  v.setUint16(scriptList + 6, script - scriptList);
  v.setUint16(script, 4); // default LangSys right after the Script table
  v.setUint16(langSys + 4, features);
  // FeatureList: one feature, kern.
  v.setUint16(featureList, 1);
  out.set([0x6b, 0x65, 0x72, 0x6e], featureList + 2);
  v.setUint16(featureList + 6, feature - featureList);
  v.setUint16(feature + 2, lookups);
  for (let j = 0; j < lookups; j++) v.setUint16(feature + 4 + j * 2, distinct ? j : 0);
  // LookupList: every record points at the one lookup.
  v.setUint16(lookupList, lookupCount);
  for (let i = 0; i < lookupCount; i++) v.setUint16(lookupList + 2 + i * 2, lookupRelative);
  v.setUint16(lookup, 2);
  v.setUint16(lookup + 4, subtables);
  for (let s = 0; s < subtables; s++) v.setUint16(lookup + 6 + s * 2, subtableRelative);
  // PairPos format 1 with an empty coverage.
  v.setUint16(subtable, 1);
  v.setUint16(subtable + 2, 10);
  v.setUint16(subtable + 4, 4);
  v.setUint16(subtable + 10, 1);
  return out;
}
