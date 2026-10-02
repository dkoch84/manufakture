// ASCII DXF from a `Sheet2`, AutoCAD 2000 (AC1015): the oldest version with LWPOLYLINE and
// ELLIPSE, and the one nearly every reader takes (LibreCAD, QCAD, Inkscape, FreeCAD, ezdxf,
// laser and plasma software). Millimetres, stated in the header ($INSUNITS 4, $MEASUREMENT 1).
// The file carries the full AC1015 skeleton (handles, owners, subclass markers, the symbol
// tables, model and paper space blocks, the root dictionary), since AutoCAD is documented to
// refuse a DXF 2000 without it (not verified against AutoCAD here; ezdxf's audit was run by
// hand). No LAYOUT objects are written. Laxer readers ignore what they do not need.
//
// Layers are the sheet's, each with its colour, lineweight and linetype; dashed layers get a
// linetype in the LTYPE table built from their dash pattern (HIDDEN for drawings' hidden lines).
// Entities: LINE, ARC, CIRCLE, ELLIPSE, LWPOLYLINE (connected lines and arcs, with bulges),
// TEXT, and SOLID for small filled polygons (arrowheads).

import {
  JOIN_TOLERANCE,
  connectedRuns,
  formatNumber,
  isFullTurn,
  itemsByLayer,
  layerDash,
  pageOf,
  samePoint,
  segmentPoint,
  sheetBounds,
  signedSweep,
  type Layer2,
  type Path2,
  type Segment2,
  type Sheet2,
  type Text2,
  type Vec2,
} from './path2';

/** AutoCAD's standard lineweights, hundredths of a millimetre. */
export const DXF_LINEWEIGHTS = [
  0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200,
  211,
] as const;

/** The nearest standard lineweight to `mm`, in hundredths of a millimetre. */
export function dxfLineweight(mm: number): number {
  const target = mm * 100;
  let best: number = DXF_LINEWEIGHTS[0];
  for (const w of DXF_LINEWEIGHTS) if (Math.abs(w - target) < Math.abs(best - target)) best = w;
  return best;
}

// The AutoCAD Color Index entries a `#rrggbb` is matched to (7 draws black on white paper).
const ACI: readonly (readonly [number, number, number, number])[] = [
  [1, 255, 0, 0],
  [2, 255, 255, 0],
  [3, 0, 255, 0],
  [4, 0, 255, 255],
  [5, 0, 0, 255],
  [6, 255, 0, 255],
  [7, 0, 0, 0],
  [8, 128, 128, 128],
  [9, 192, 192, 192],
];

/** The nearest of ACI colours 1 to 9 to a `#rrggbb` colour; black (and white) is 7. */
export function dxfColor(hex: string | undefined): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '#000000');
  if (!m) return 7;
  const [r, g, b] = [m[1]!, m[2]!, m[3]!].map((h) => parseInt(h, 16)) as [number, number, number];
  if (r === 255 && g === 255 && b === 255) return 7;
  let best = 7;
  let bestD = Infinity;
  for (const [i, cr, cg, cb] of ACI) {
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < bestD) [best, bestD] = [i, d];
  }
  return best;
}

/**
 * A layer or linetype name DXF accepts: `<>/\":;?*|=`, backquote, controls and every character
 * outside printable ASCII become `_`. Names cannot hold the `\U+XXXX` escape text uses, and
 * keeping them ASCII makes them read the same under the header's `ANSI_1252` code page and any
 * other.
 */
export function dxfName(name: string): string {
  const s = name.replace(/[<>/\\":;?*|=`]|[^\x20-\x7e]/gu, '_').trim();
  return s.length ? s : '_';
}

const PERCENT_CODES: Readonly<Record<string, string>> = {
  Ø: '%%c',
  '⌀': '%%c',
  '°': '%%d',
  '±': '%%p',
};

/**
 * Text for a DXF string value: Ø, ° and ± as AutoCAD's `%%c`, `%%d` and `%%p`; other characters
 * outside printable ASCII as `\U+XXXX`; line breaks as spaces. A `%` followed by a `%` (a
 * literal one, or the start of one of those codes) is written `%%%`, AutoCAD's code for a
 * percent sign, so `%%d` in the text stays `%%d` and is not read as a degree sign.
 */
export function dxfText(text: string): string {
  let out = '';
  const chars = [...text.replace(/[\r\n\t]+/g, ' ')];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const cp = ch.codePointAt(0)!;
    const next = chars[i + 1];
    const code = PERCENT_CODES[ch];
    if (code) out += code;
    else if (ch === '%' && next !== undefined && (next === '%' || PERCENT_CODES[next]))
      out += '%%%';
    else if (cp >= 0x20 && cp <= 0x7e) out += ch;
    else if (cp <= 0xffff) out += `\\U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
    else out += '?';
  }
  return out;
}

const n = (v: number): string => formatNumber(v);
const deg = (rad: number): number => (rad * 180) / Math.PI;

/** Group codes and values, written two lines per pair. */
class Groups {
  readonly lines: string[] = [];
  add(code: number, value: string | number): this {
    this.lines.push(String(code).padStart(3, ' '), typeof value === 'number' ? n(value) : value);
    return this;
  }
  point(code: number, p: Vec2, z = 0): this {
    return this.add(code, p[0])
      .add(code + 10, p[1])
      .add(code + 20, z);
  }
}

interface LineTypeDef {
  readonly name: string;
  readonly dash: readonly number[];
}

/** One linetype per distinct dash pattern; names from the layers, made unique. */
function lineTypes(layers: readonly Layer2[]): {
  defs: LineTypeDef[];
  byLayer: Map<string, string>;
} {
  const defs: LineTypeDef[] = [];
  const byLayer = new Map<string, string>();
  for (const layer of layers) {
    const dash = layerDash(layer);
    if (!dash.length) {
      byLayer.set(layer.name, 'CONTINUOUS');
      continue;
    }
    const same = defs.find(
      (d) => d.dash.length === dash.length && d.dash.every((v, i) => v === dash[i]),
    );
    if (same) {
      byLayer.set(layer.name, same.name);
      continue;
    }
    let name = dxfName((layer.lineType ?? 'DASHED').toUpperCase());
    if (
      name === 'CONTINUOUS' ||
      name === 'BYLAYER' ||
      name === 'BYBLOCK' ||
      defs.some((d) => d.name === name)
    )
      name = dxfName(`${name}_${layer.name}`.toUpperCase());
    // Names that only differed in characters `dxfName` replaces can still meet.
    for (let i = 2, base = name; defs.some((d) => d.name === name); i++) name = `${base}_${i}`;
    defs.push({ name, dash });
    byLayer.set(layer.name, name);
  }
  return { defs, byLayer };
}

/** An ASCII DXF (AC1015, millimetres) of the sheet. */
export function writeDxf(sheet: Sheet2): string {
  const groups = itemsByLayer(sheet);
  const names = new Set<string>(['0']);
  const layerName = new Map<string, string>();
  for (const { layer } of groups) {
    let name = dxfName(layer.name);
    for (let i = 2; names.has(name.toUpperCase()) || names.has(name); i++)
      name = `${dxfName(layer.name)}_${i}`;
    names.add(name.toUpperCase());
    layerName.set(layer.name, name);
  }
  const { defs: ltypes, byLayer: ltypeOf } = lineTypes(groups.map((g) => g.layer));

  let next = 1;
  const handle = (): string => (next++).toString(16).toUpperCase();
  // Handles first, so owners can point at records written later.
  const h = {
    rootDict: handle(),
    groupDict: handle(),
    plotStyleDict: handle(),
    plotStyleNormal: handle(),
    vportTable: handle(),
    vportActive: handle(),
    ltypeTable: handle(),
    ltypeByBlock: handle(),
    ltypeByLayer: handle(),
    ltypeContinuous: handle(),
    layerTable: handle(),
    layer0: handle(),
    styleTable: handle(),
    styleStandard: handle(),
    viewTable: handle(),
    ucsTable: handle(),
    appidTable: handle(),
    appidAcad: handle(),
    dimstyleTable: handle(),
    dimstyleStandard: handle(),
    blockRecordTable: handle(),
    modelSpace: handle(),
    paperSpace: handle(),
    modelBlock: handle(),
    modelBlockEnd: handle(),
    paperBlock: handle(),
    paperBlockEnd: handle(),
  };

  const body = new Groups();
  const section = (name: string) => body.add(0, 'SECTION').add(2, name);
  const endSection = () => body.add(0, 'ENDSEC');
  const table = (name: string, hnd: string, count: number) =>
    body
      .add(0, 'TABLE')
      .add(2, name)
      .add(5, hnd)
      .add(330, '0')
      .add(100, 'AcDbSymbolTable')
      .add(70, count);
  const record = (type: string, hnd: string, owner: string, subclass: string) =>
    body
      .add(0, type)
      .add(5, hnd)
      .add(330, owner)
      .add(100, 'AcDbSymbolTableRecord')
      .add(100, subclass);

  // CLASSES (none), TABLES.
  section('CLASSES');
  endSection();
  section('TABLES');

  const page = pageOf(sheet);
  table('VPORT', h.vportTable, 1);
  record('VPORT', h.vportActive, h.vportTable, 'AcDbViewportTableRecord')
    .add(2, '*Active')
    .add(70, 0)
    .add(10, 0)
    .add(20, 0)
    .add(11, 1)
    .add(21, 1)
    .add(12, page.origin[0] + page.width / 2)
    .add(22, page.origin[1] + page.height / 2)
    .add(13, 0)
    .add(23, 0)
    .add(14, 10)
    .add(24, 10)
    .add(15, 10)
    .add(25, 10)
    .add(16, 0)
    .add(26, 0)
    .add(36, 1)
    .add(17, 0)
    .add(27, 0)
    .add(37, 0)
    .add(40, Math.max(page.height, 1) * 1.05)
    .add(41, page.height > 0 ? page.width / page.height : 1)
    .add(42, 50)
    .add(43, 0)
    .add(44, 0)
    .add(50, 0)
    .add(51, 0)
    .add(71, 0)
    .add(72, 100)
    .add(73, 1)
    .add(74, 3)
    .add(75, 0)
    .add(76, 0)
    .add(77, 0)
    .add(78, 0);
  body.add(0, 'ENDTAB');

  const ltypeHandles = ltypes.map(() => handle());
  table('LTYPE', h.ltypeTable, 3 + ltypes.length);
  for (const [hnd, name] of [
    [h.ltypeByBlock, 'ByBlock'],
    [h.ltypeByLayer, 'ByLayer'],
  ] as const)
    record('LTYPE', hnd, h.ltypeTable, 'AcDbLinetypeTableRecord')
      .add(2, name)
      .add(70, 0)
      .add(3, '')
      .add(72, 65)
      .add(73, 0)
      .add(40, 0);
  record('LTYPE', h.ltypeContinuous, h.ltypeTable, 'AcDbLinetypeTableRecord')
    .add(2, 'CONTINUOUS')
    .add(70, 0)
    .add(3, 'Solid line')
    .add(72, 65)
    .add(73, 0)
    .add(40, 0);
  ltypes.forEach((lt, i) => {
    const dash = lt.dash.length % 2 ? [...lt.dash, ...lt.dash] : lt.dash;
    record('LTYPE', ltypeHandles[i]!, h.ltypeTable, 'AcDbLinetypeTableRecord')
      .add(2, lt.name)
      .add(70, 0)
      .add(3, dash.map((_, k) => (k % 2 ? ' ' : '__')).join(''))
      .add(72, 65)
      .add(73, dash.length)
      .add(
        40,
        dash.reduce((s, v) => s + Math.abs(v), 0),
      );
    dash.forEach((v, k) => body.add(49, k % 2 ? -Math.abs(v) : Math.abs(v)).add(74, 0));
  });
  body.add(0, 'ENDTAB');

  const layerHandles = groups.map(() => handle());
  table('LAYER', h.layerTable, 1 + groups.length);
  record('LAYER', h.layer0, h.layerTable, 'AcDbLayerTableRecord')
    .add(2, '0')
    .add(70, 0)
    .add(62, 7)
    .add(6, 'CONTINUOUS')
    .add(370, -3)
    .add(390, h.plotStyleNormal);
  groups.forEach(({ layer }, i) =>
    record('LAYER', layerHandles[i]!, h.layerTable, 'AcDbLayerTableRecord')
      .add(2, layerName.get(layer.name)!)
      .add(70, 0)
      .add(62, dxfColor(layer.color))
      .add(6, ltypeOf.get(layer.name)!)
      .add(370, dxfLineweight(layer.weight ?? 0.25))
      .add(390, h.plotStyleNormal),
  );
  body.add(0, 'ENDTAB');

  table('STYLE', h.styleTable, 1);
  record('STYLE', h.styleStandard, h.styleTable, 'AcDbTextStyleTableRecord')
    .add(2, 'STANDARD')
    .add(70, 0)
    .add(40, 0)
    .add(41, 1)
    .add(50, 0)
    .add(71, 0)
    .add(42, 2.5)
    .add(3, 'arial.ttf')
    .add(4, '');
  body.add(0, 'ENDTAB');

  table('VIEW', h.viewTable, 0);
  body.add(0, 'ENDTAB');
  table('UCS', h.ucsTable, 0);
  body.add(0, 'ENDTAB');

  table('APPID', h.appidTable, 1);
  record('APPID', h.appidAcad, h.appidTable, 'AcDbRegAppTableRecord').add(2, 'ACAD').add(70, 0);
  body.add(0, 'ENDTAB');

  table('DIMSTYLE', h.dimstyleTable, 1)
    .add(100, 'AcDbDimStyleTable')
    .add(71, 1)
    .add(340, h.dimstyleStandard);
  body
    .add(0, 'DIMSTYLE')
    .add(105, h.dimstyleStandard)
    .add(330, h.dimstyleTable)
    .add(100, 'AcDbSymbolTableRecord')
    .add(100, 'AcDbDimStyleTableRecord')
    .add(2, 'STANDARD')
    .add(70, 0);
  body.add(0, 'ENDTAB');

  table('BLOCK_RECORD', h.blockRecordTable, 2);
  record('BLOCK_RECORD', h.modelSpace, h.blockRecordTable, 'AcDbBlockTableRecord').add(
    2,
    '*Model_Space',
  );
  record('BLOCK_RECORD', h.paperSpace, h.blockRecordTable, 'AcDbBlockTableRecord').add(
    2,
    '*Paper_Space',
  );
  body.add(0, 'ENDTAB');
  endSection();

  // BLOCKS: the model and paper space blocks, empty (entities go in ENTITIES).
  section('BLOCKS');
  for (const [hb, he, owner, name, paper] of [
    [h.modelBlock, h.modelBlockEnd, h.modelSpace, '*Model_Space', false],
    [h.paperBlock, h.paperBlockEnd, h.paperSpace, '*Paper_Space', true],
  ] as const) {
    body.add(0, 'BLOCK').add(5, hb).add(330, owner).add(100, 'AcDbEntity');
    if (paper) body.add(67, 1);
    body
      .add(8, '0')
      .add(100, 'AcDbBlockBegin')
      .add(2, name)
      .add(70, 0)
      .point(10, [0, 0])
      .add(3, name)
      .add(1, '');
    body.add(0, 'ENDBLK').add(5, he).add(330, owner).add(100, 'AcDbEntity');
    if (paper) body.add(67, 1);
    body.add(8, '0').add(100, 'AcDbBlockEnd');
  }
  endSection();

  // ENTITIES, by layer in the sheet's order.
  section('ENTITIES');
  const entity = (type: string, layer: string, subclass: string) =>
    body
      .add(0, type)
      .add(5, handle())
      .add(330, h.modelSpace)
      .add(100, 'AcDbEntity')
      .add(8, layer)
      .add(100, subclass);
  const ctx: EntityWriter = { body, entity };
  for (const { layer, items } of groups) {
    const name = layerName.get(layer.name)!;
    for (const item of items) {
      if (item.kind === 'path') writePath(ctx, item, name);
      else writeText(ctx, item, name);
    }
  }
  endSection();

  // OBJECTS: the root dictionary, the group dictionary and the plot style placeholder.
  section('OBJECTS');
  body
    .add(0, 'DICTIONARY')
    .add(5, h.rootDict)
    .add(330, '0')
    .add(100, 'AcDbDictionary')
    .add(281, 1)
    .add(3, 'ACAD_GROUP')
    .add(350, h.groupDict)
    .add(3, 'ACAD_PLOTSTYLENAME')
    .add(350, h.plotStyleDict);
  body
    .add(0, 'DICTIONARY')
    .add(5, h.groupDict)
    .add(330, h.rootDict)
    .add(100, 'AcDbDictionary')
    .add(281, 1);
  body
    .add(0, 'ACDBDICTIONARYWDFLT')
    .add(5, h.plotStyleDict)
    .add(330, h.rootDict)
    .add(100, 'AcDbDictionary')
    .add(281, 1)
    .add(3, 'Normal')
    .add(350, h.plotStyleNormal)
    .add(100, 'AcDbDictionaryWithDefault')
    .add(340, h.plotStyleNormal);
  body.add(0, 'ACDBPLACEHOLDER').add(5, h.plotStyleNormal).add(330, h.plotStyleDict);
  endSection();
  body.add(0, 'EOF');

  // HEADER last, now that the next free handle and the extents are known.
  const head = new Groups();
  const bounds = sheetBounds(sheet);
  head.add(0, 'SECTION').add(2, 'HEADER');
  head.add(9, '$ACADVER').add(1, 'AC1015');
  head.add(9, '$DWGCODEPAGE').add(3, 'ANSI_1252');
  head.add(9, '$INSBASE').point(10, [0, 0]);
  head.add(9, '$EXTMIN').point(10, bounds.min);
  head.add(9, '$EXTMAX').point(10, bounds.max);
  head.add(9, '$LIMMIN').add(10, page.origin[0]).add(20, page.origin[1]);
  head
    .add(9, '$LIMMAX')
    .add(10, page.origin[0] + page.width)
    .add(20, page.origin[1] + page.height);
  head.add(9, '$LTSCALE').add(40, 1);
  head.add(9, '$TEXTSTYLE').add(7, 'STANDARD');
  head.add(9, '$CLAYER').add(8, '0');
  head.add(9, '$LUNITS').add(70, 2);
  head.add(9, '$LUPREC').add(70, 4);
  head.add(9, '$INSUNITS').add(70, 4);
  head.add(9, '$MEASUREMENT').add(70, 1);
  head.add(9, '$HANDSEED').add(5, next.toString(16).toUpperCase());
  head.add(0, 'ENDSEC');

  return [...head.lines, ...body.lines, ''].join('\n');
}

interface EntityWriter {
  readonly body: Groups;
  readonly entity: (type: string, layer: string, subclass: string) => Groups;
}

function writeSegment(ctx: EntityWriter, seg: Segment2, layer: string): void {
  switch (seg.kind) {
    case 'line':
      ctx.entity('LINE', layer, 'AcDbLine').point(10, seg.a).point(11, seg.b);
      return;
    case 'arc': {
      if (isFullTurn(seg)) {
        ctx.entity('CIRCLE', layer, 'AcDbCircle').point(10, seg.center).add(40, seg.radius);
        return;
      }
      // DXF arcs run counter-clockwise: a clockwise one is the same arc from its end.
      const sweep = signedSweep(seg);
      const [a0, a1] = sweep > 0 ? [seg.start, seg.start + sweep] : [seg.start + sweep, seg.start];
      ctx
        .entity('ARC', layer, 'AcDbCircle')
        .point(10, seg.center)
        .add(40, seg.radius)
        .add(100, 'AcDbArc')
        .add(50, normDeg(deg(a0)))
        .add(51, normDeg(deg(a1)));
      return;
    }
    case 'ellipseArc': {
      // DXF wants major >= minor (ratio <= 1): otherwise the minor axis becomes the major one,
      // a quarter turn on, and the parameters shift back by the same.
      let { major, minor, rotation, start } = seg;
      const sweep = signedSweep(seg);
      if (minor > major) {
        [major, minor] = [minor, major];
        rotation += Math.PI / 2;
        start -= Math.PI / 2;
      }
      const full = isFullTurn(seg);
      const [p0, p1] = full
        ? [0, 2 * Math.PI]
        : sweep > 0
          ? [start, start + sweep]
          : [start + sweep, start];
      const w0 = full ? 0 : normRad(p0);
      let w1 = full ? 2 * Math.PI : normRad(p1);
      if (!full && w1 <= w0) w1 += 2 * Math.PI;
      ctx
        .entity('ELLIPSE', layer, 'AcDbEllipse')
        .point(10, seg.center)
        .point(11, [major * Math.cos(rotation), major * Math.sin(rotation)])
        .add(210, 0)
        .add(220, 0)
        .add(230, 1)
        .add(40, major > 0 ? minor / major : 1)
        .add(41, w0)
        .add(42, w1);
      return;
    }
  }
}

const normDeg = (d: number): number => {
  const r = d % 360;
  return r < 0 ? r + 360 : r;
};
const normRad = (a: number): number => {
  const t = 2 * Math.PI;
  const r = a % t;
  return r < 0 ? r + t : r;
};

function writePath(ctx: EntityWriter, path: Path2, layer: string): void {
  const runs = connectedRuns(path.segments);
  if (!runs.length) return;
  const first = segmentPoint(runs[0]![0]!, 'start');
  const lastRun = runs[runs.length - 1]!;
  const last = segmentPoint(lastRun[lastRun.length - 1]!, 'end');
  const closesItself = runs.length === 1 && samePoint(first, last);
  // A closing line from the last end to the first start, when `closed` asks for one.
  const closingLine = path.closed === true && !samePoint(first, last);
  if (runs.length === 1 && !runs[0]!.some((s) => s.kind === 'ellipseArc')) {
    const run = runs[0]!;
    if (run.length === 1 && !closingLine) writeSegment(ctx, run[0]!, layer);
    else writePolyline(ctx, run, layer, closesItself || closingLine, !closesItself);
  } else {
    for (const run of runs) {
      if (run.length === 1 || run.some((s) => s.kind === 'ellipseArc'))
        for (const seg of run) writeSegment(ctx, seg, layer);
      else writePolyline(ctx, run, layer, false, true);
    }
    if (closingLine) ctx.entity('LINE', layer, 'AcDbLine').point(10, last).point(11, first);
  }
  if (path.fill && runs.length === 1) writeSolid(ctx, runs[0]!, layer);
}

/**
 * Lines and circular arcs as one LWPOLYLINE, arcs as bulges (a full circle in two halves).
 * `withEnd` adds the last segment's end as a vertex (not when the run returns to its start).
 */
function writePolyline(
  ctx: EntityWriter,
  run: readonly Segment2[],
  layer: string,
  closed: boolean,
  withEnd: boolean,
): void {
  const vertices: { p: Vec2; bulge: number }[] = [];
  for (const seg of run) {
    if (seg.kind === 'line') vertices.push({ p: seg.a, bulge: 0 });
    else if (seg.kind === 'arc') {
      const sweep = signedSweep(seg);
      const pieces = isFullTurn(seg) ? 2 : 1;
      for (let i = 0; i < pieces; i++) {
        const piece = {
          ...seg,
          start: seg.start + (sweep / pieces) * i,
          end: seg.start + (sweep / pieces) * (i + 1),
        };
        vertices.push({ p: segmentPoint(piece, 'start'), bulge: Math.tan(sweep / pieces / 4) });
      }
    }
  }
  if (withEnd) vertices.push({ p: segmentPoint(run[run.length - 1]!, 'end'), bulge: 0 });
  const g = ctx
    .entity('LWPOLYLINE', layer, 'AcDbPolyline')
    .add(90, vertices.length)
    .add(70, closed ? 1 : 0)
    .add(43, 0);
  for (const v of vertices) {
    g.add(10, v.p[0]).add(20, v.p[1]);
    if (Math.abs(v.bulge) > 1e-12) g.add(42, v.bulge);
  }
}

/** A filled polygon of three or four straight sides as a SOLID (its corners in DXF's Z order). */
function writeSolid(ctx: EntityWriter, run: readonly Segment2[], layer: string): void {
  if (run.some((s) => s.kind !== 'line')) return;
  const pts = run.map((s) => segmentPoint(s, 'start'));
  const end = segmentPoint(run[run.length - 1]!, 'end');
  if (!samePoint(end, pts[0]!, JOIN_TOLERANCE)) pts.push(end);
  if (pts.length < 3 || pts.length > 4) return;
  const [a, b, c, d] = [pts[0]!, pts[1]!, pts[2]!, pts[3] ?? pts[2]!];
  ctx.entity('SOLID', layer, 'AcDbTrace').point(10, a).point(11, b).point(12, d).point(13, c);
}

const H_JUSTIFY = { start: 0, middle: 1, end: 2 } as const;
const V_JUSTIFY = { bottom: 0, middle: 2, top: 3 } as const;

function writeText(ctx: EntityWriter, t: Text2, layer: string): void {
  const h = H_JUSTIFY[t.anchor];
  const v = V_JUSTIFY[t.baseline];
  const g = ctx
    .entity('TEXT', layer, 'AcDbText')
    .point(10, t.at)
    .add(40, t.height)
    .add(1, dxfText(t.text))
    .add(50, normDeg(deg(t.rotation)))
    .add(7, 'STANDARD');
  if (h) g.add(72, h);
  if (h || v) g.point(11, t.at);
  g.add(100, 'AcDbText');
  if (v) g.add(73, v);
}
