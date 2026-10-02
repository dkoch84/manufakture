import DxfParser from 'dxf-parser';
import { describe, expect, it } from 'vitest';
import { displayListToSheet } from './drawing-export';
import { dxfColor, dxfLineweight, dxfName, dxfText, writeDxf } from './dxf';
import {
  polylinePath,
  segmentPoint,
  signedSweep,
  type Segment2,
  type Sheet2,
  type Vec2,
} from './path2';
import { PLATE_SHEET, SHAPES_SHEET, bracketSheet } from './sheet-test-helpers';

/* eslint-disable @typescript-eslint/no-explicit-any -- dxf-parser's entity types are loose */

const parse = (text: string): any => new DxfParser().parseSync(text);

/** The file as group code and value pairs, checking the two-line framing. */
function groups(text: string): [number, string][] {
  const lines = text.split('\n');
  expect(lines.pop()).toBe('');
  expect(lines.length % 2).toBe(0);
  const out: [number, string][] = [];
  for (let i = 0; i < lines.length; i += 2) {
    expect(lines[i]).toMatch(/^ *-?\d+$/);
    out.push([Number(lines[i]), lines[i + 1]!]);
  }
  return out;
}

/** Records (`0` to the next `0`) as code to values maps. */
function records(pairs: [number, string][]): { type: string; codes: Map<number, string[]> }[] {
  const out: { type: string; codes: Map<number, string[]> }[] = [];
  for (const [code, value] of pairs) {
    if (code === 0) out.push({ type: value, codes: new Map() });
    else {
      const m = out[out.length - 1]!.codes;
      m.set(code, [...(m.get(code) ?? []), value]);
    }
  }
  return out;
}

function ellipseLength(a: number, b: number, t0: number, t1: number): number {
  let sum = 0;
  const steps = 4000;
  for (let i = 0; i < steps; i++) {
    const t = t0 + ((i + 0.5) / steps) * (t1 - t0);
    sum += Math.hypot(a * Math.sin(t), b * Math.cos(t));
  }
  return (sum * Math.abs(t1 - t0)) / steps;
}

function segmentLength(s: Segment2): number {
  if (s.kind === 'line') return Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
  const sweep = signedSweep(s);
  if (s.kind === 'arc') return s.radius * Math.abs(sweep);
  return ellipseLength(s.major, s.minor, s.start, s.start + sweep);
}

/** Stroked length per layer of a sheet, closing lines included. */
function sheetLengths(sheet: Sheet2): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of sheet.items) {
    if (item.kind !== 'path' || !item.segments.length) continue;
    let len = item.segments.reduce((s, seg) => s + segmentLength(seg), 0);
    if (item.closed) {
      const a = segmentPoint(item.segments[0]!, 'start');
      const b = segmentPoint(item.segments[item.segments.length - 1]!, 'end');
      len += Math.hypot(a[0] - b[0], a[1] - b[1]);
    }
    out[item.layer] = (out[item.layer] ?? 0) + len;
  }
  return out;
}

const TAU = 2 * Math.PI;
const dist = (a: any, b: any) => Math.hypot(a.x - b.x, a.y - b.y);

/** Stroked length per layer of parsed DXF entities. */
function dxfLengths(entities: any[]): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (layer: string, v: number) => (out[layer] = (out[layer] ?? 0) + v);
  for (const e of entities) {
    switch (e.type) {
      case 'LINE':
        add(e.layer, dist(e.vertices[0], e.vertices[1]));
        break;
      case 'CIRCLE':
        add(e.layer, TAU * e.radius);
        break;
      case 'ARC':
        add(e.layer, e.radius * ((((e.endAngle - e.startAngle) % TAU) + TAU) % TAU));
        break;
      case 'ELLIPSE': {
        const a = Math.hypot(e.majorAxisEndPoint.x, e.majorAxisEndPoint.y);
        add(e.layer, ellipseLength(a, a * e.axisRatio, e.startAngle, e.endAngle));
        break;
      }
      case 'LWPOLYLINE': {
        const v = e.vertices;
        const n = e.shape ? v.length : v.length - 1;
        for (let i = 0; i < n; i++) {
          const p = v[i];
          const q = v[(i + 1) % v.length];
          const chord = dist(p, q);
          const theta = 4 * Math.atan(p.bulge ?? 0);
          add(
            e.layer,
            theta === 0 ? chord : (chord / 2 / Math.sin(Math.abs(theta) / 2)) * Math.abs(theta),
          );
        }
        break;
      }
    }
  }
  return out;
}

function expectSameLengths(sheet: Sheet2, text: string): void {
  const want = sheetLengths(sheet);
  const got = dxfLengths(parse(text).entities);
  expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
  for (const k of Object.keys(want)) expect(got[k]).toBeCloseTo(want[k]!, 3);
}

describe('writeDxf', () => {
  it('writes an AC1015 file in millimetres with the full section and table skeleton', () => {
    const text = writeDxf(displayListToSheet(bracketSheet()));
    const pairs = groups(text);
    const sections = pairs.filter((p, i) => p[0] === 2 && pairs[i - 1]![1] === 'SECTION');
    expect(sections.map((p) => p[1])).toEqual([
      'HEADER',
      'CLASSES',
      'TABLES',
      'BLOCKS',
      'ENTITIES',
      'OBJECTS',
    ]);
    expect(pairs[pairs.length - 1]).toEqual([0, 'EOF']);
    const tables = pairs.filter((p, i) => p[0] === 2 && pairs[i - 1]![1] === 'TABLE');
    expect(tables.map((p) => p[1])).toEqual([
      'VPORT',
      'LTYPE',
      'LAYER',
      'STYLE',
      'VIEW',
      'UCS',
      'APPID',
      'DIMSTYLE',
      'BLOCK_RECORD',
    ]);
    const dxf = parse(text);
    expect(dxf.header).toMatchObject({
      $ACADVER: 'AC1015',
      $INSUNITS: 4,
      $MEASUREMENT: 1,
      $LIMMAX: { x: 420, y: 297 },
    });
    // Handles are unique, and $HANDSEED is above every one.
    const handles = pairs.filter((p) => p[0] === 5 || p[0] === 105).map((p) => p[1]);
    const seed = parseInt(dxf.header.$HANDSEED, 16);
    expect(new Set(handles.slice(1)).size).toBe(handles.length - 1);
    for (const h of handles.slice(1)) expect(parseInt(h, 16)).toBeLessThan(seed);
    // Every entity is owned by the model space block record.
    const recs = records(pairs);
    const modelSpace = recs.find(
      (r) => r.type === 'BLOCK_RECORD' && r.codes.get(2)?.[0] === '*Model_Space',
    )!;
    for (const e of dxf.entities) expect(e.ownerHandle).toBe(modelSpace.codes.get(5)![0]);
  });

  it('gives each drawing layer its linetype and weight, hidden lines HIDDEN', () => {
    const text = writeDxf(displayListToSheet(bracketSheet()));
    const dxf = parse(text);
    const lt = dxf.tables.lineType.lineTypes;
    expect(lt.HIDDEN).toMatchObject({ pattern: [3, -1.5], patternLength: 4.5 });
    expect(lt.CENTER).toMatchObject({ pattern: [8, -1.5, 1.5, -1.5], patternLength: 12.5 });
    expect(lt.CENTER_SECTION).toMatchObject({ pattern: [12, -2, 2, -2] });
    expect(lt.CONTINUOUS).toBeDefined();
    const layers = records(groups(text)).filter((r) => r.type === 'LAYER');
    const byName = Object.fromEntries(
      layers.map((r) => [r.codes.get(2)![0], [r.codes.get(6)![0], r.codes.get(370)![0]]]),
    );
    expect(byName).toEqual({
      '0': ['CONTINUOUS', '-3'],
      visible: ['CONTINUOUS', '50'],
      hidden: ['HIDDEN', '35'],
      smooth: ['CONTINUOUS', '25'],
      sewn: ['CONTINUOUS', '18'],
      centre: ['CENTER', '25'],
      dimension: ['CONTINUOUS', '25'],
      section: ['CENTER_SECTION', '50'],
      hatch: ['CONTINUOUS', '18'],
      text: ['CONTINUOUS', '25'],
      border: ['CONTINUOUS', '70'],
      titleBlock: ['CONTINUOUS', '35'],
    });
    expect(dxf.entities.filter((e: any) => e.layer === 'hidden').length).toBeGreaterThan(0);
  });

  it('writes the bracket drawing with the same geometry per layer', () => {
    const sheet = displayListToSheet(bracketSheet());
    const text = writeDxf(sheet);
    expectSameLengths(sheet, text);
    const dxf = parse(text);
    const types = new Set(dxf.entities.map((e: any) => e.type));
    expect([...types].sort()).toEqual(['ARC', 'CIRCLE', 'LINE', 'LWPOLYLINE', 'SOLID', 'TEXT']);
    const texts = dxf.entities.filter((e: any) => e.type === 'TEXT').map((e: any) => e.text);
    expect(texts).toEqual(expect.arrayContaining(['M1 bracket', 'MK-0001', '2x %%c8 CBORE']));
  });

  it('writes ellipses (axes swapped when the minor is longer), wrapping arcs and text', () => {
    const sheet = displayListToSheet(SHAPES_SHEET);
    const text = writeDxf(sheet);
    expectSameLengths(sheet, text);
    const e = parse(text).entities as any[];
    const ellipses = e.filter((x) => x.type === 'ELLIPSE');
    expect(ellipses).toHaveLength(3);
    const tall = ellipses.find((x) => x.center.x === 150)!;
    expect(tall.majorAxisEndPoint.x).toBeCloseTo(0, 6);
    expect(tall.majorAxisEndPoint.y).toBeCloseTo(15, 6);
    expect(tall.axisRatio).toBeCloseTo(1 / 3, 6);
    expect([tall.startAngle, tall.endAngle]).toEqual([3.141593, 6.283185]);
    // The arc from 3 pi / 2 to pi / 2 counter-clockwise: through 0, the right half.
    const arc = e.find((x) => x.type === 'ARC')!;
    expect([arc.startAngle, arc.endAngle]).toEqual([(3 * Math.PI) / 2, Math.PI / 2]);
    const texts = e.filter((x) => x.type === 'TEXT');
    expect(texts.map((t) => [t.text, t.halign ?? 0, t.valign ?? 0, t.rotation])).toEqual([
      ['%%c8 THRU', 0, 0, 0],
      ['R15 <45%%d> %%p0.1', 1, 2, 0],
      ['A & B "C"', 2, 3, 0],
      ['VERTICAL', 0, 0, 90],
    ]);
    expect(texts[1].endPoint).toEqual({ x: 105, y: 30, z: 0 });
    // The arrowhead: outline and SOLID.
    const solid = e.find((x) => x.type === 'SOLID')!;
    expect(solid.points.map((p: any) => [p.x, p.y])).toEqual([
      [100, 60],
      [103, 59.5],
      [103, 60.5],
      [103, 60.5],
    ]);
  });

  it('writes a laser part as one closed LWPOLYLINE with bulges and a circle', () => {
    const text = writeDxf(PLATE_SHEET);
    expectSameLengths(PLATE_SHEET, text);
    const dxf = parse(text);
    expect(dxf.header.$EXTMIN).toEqual({ x: 0, y: 0, z: 0 });
    expect(dxf.header.$EXTMAX).toEqual({ x: 60, y: 40, z: 0 });
    const [outer, hole] = dxf.entities;
    expect(outer).toMatchObject({ type: 'LWPOLYLINE', shape: true, layer: 'cut' });
    expect(outer.vertices).toHaveLength(8);
    const bulges = outer.vertices.map((v: any) => v.bulge ?? 0);
    expect(bulges.filter((b: number) => b !== 0)).toHaveLength(4);
    for (const b of bulges.filter((x: number) => x !== 0))
      expect(b).toBeCloseTo(Math.tan(Math.PI / 8), 6);
    expect(hole).toMatchObject({ type: 'CIRCLE', radius: 4, center: { x: 20, y: 20 } });
    const layer = records(groups(text)).find(
      (r) => r.type === 'LAYER' && r.codes.get(2)![0] === 'cut',
    )!;
    expect(layer.codes.get(62)).toEqual(['1']);
    expect(layer.codes.get(370)).toEqual(['9']);
  });

  it('closes open paths marked closed and keeps disjoint runs apart', () => {
    const p: Vec2[] = [
      [0, 0],
      [10, 0],
      [10, 10],
    ];
    const sheet: Sheet2 = {
      layers: [{ name: 'a' }],
      items: [
        {
          kind: 'path',
          layer: 'a',
          closed: true,
          segments: [{ kind: 'line', a: p[0]!, b: p[1]! }],
        },
        {
          kind: 'path',
          layer: 'a',
          segments: [
            { kind: 'line', a: p[0]!, b: p[1]! },
            { kind: 'line', a: p[1]!, b: p[2]! },
            { kind: 'arc', center: [50, 50], radius: 2, start: 0, end: 1 },
          ],
        },
      ],
    };
    const text = writeDxf(sheet);
    expectSameLengths(sheet, text);
    const types = parse(text).entities.map((e: any) => e.type);
    expect(types).toEqual(['LWPOLYLINE', 'LWPOLYLINE', 'ARC']);
  });
});

describe('DXF helpers', () => {
  it('maps weights, colours, names and text', () => {
    expect([0.5, 0.35, 0.7, 0.18, 0.25, 0.1, 3].map(dxfLineweight)).toEqual([
      50, 35, 70, 18, 25, 9, 211,
    ]);
    expect(
      ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000fe', '#808080', 'x'].map(dxfColor),
    ).toEqual([7, 7, 1, 3, 5, 8, 7]);
    expect(dxfName('a/b:c')).toBe('a_b_c');
    expect(dxfText('Ø5 ±0.1 45° é ⌀\nx')).toBe('%%c5 %%p0.1 45%%d \\U+00E9 %%c x');
  });

  it('keeps a literal %% from reading as a control code', () => {
    expect(dxfText('50%')).toBe('50%');
    expect(dxfText('%d')).toBe('%d');
    expect(dxfText('%%d')).toBe('%%%%d');
    expect(dxfText('%%')).toBe('%%%%');
    expect(dxfText('5%°')).toBe('5%%%%%d');
    expect(dxfText('%%%')).toBe('%%%%%%%');
  });

  it('keeps names ASCII, as the ANSI_1252 header promises', () => {
    expect(dxfName('Schnitt äöü')).toBe('Schnitt ___');
    expect(dxfName('切断')).toBe('__');
    expect(dxfName('a\u0001b😀')).toBe('a_b_');
    const text = writeDxf({
      layers: [
        { name: 'é', dash: [-1, 2], lineType: 'Ström' },
        { name: 'è', dash: [3, 1], lineType: 'Ström' },
      ],
      items: [
        polylinePath('é', [
          [0, 0],
          [1, 1],
        ]),
        polylinePath('è', [
          [0, 1],
          [1, 0],
        ]),
      ],
    });
    expect(text).toMatch(/^[\x20-\x7e\n]*$/);
    const ltypes = records(groups(text))
      .filter((r) => r.type === 'LTYPE')
      .map((r) => [r.codes.get(2)![0], r.codes.get(49)]);
    expect(ltypes).toEqual([
      ['ByBlock', undefined],
      ['ByLayer', undefined],
      ['CONTINUOUS', undefined],
      ['STR_M', ['0', '-2']],
      ['STR_M__', ['3', '-1']],
    ]);
  });
});
