// SVG artwork through regen with the real kernel and solver (M5 T5.8): an outline entity with an
// `svg` source in a plate, the plate cut around the artwork and the artwork extruded on its own,
// its scale from a variable; fill rules; the conversion cached by content across regens (every
// regen gets a fresh copy of the document); and artwork that cannot be converted.

import type {
  ExtrudeFeature,
  ManufaktureDocument,
  OutlineEntity,
  PathCommand,
  SketchFeature,
  SvgOutlinePath,
} from '@manufakture/core';
import type { KernelService, ShapeId } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import { createSolverService, type SolverService } from '@manufakture/sketch';
import { beforeAll, describe, expect, it } from 'vitest';
import { RegenEngine } from './engine';
import { cachedSvgOutlineRegions, sketchKeyDefinition, svgPathsHash } from './sketches';
import {
  PART,
  add,
  apply,
  build,
  extrude,
  mm,
  rectangle,
  setVariable,
  statuses,
} from './test-helpers';
import type { RegenResult } from './types';

let service: KernelService;
let solver: SolverService;

beforeAll(async () => {
  service = await createNodeService();
  solver = createSolverService();
}, 60_000);

const square = (x: number, y: number, s: number, ccw = true): PathCommand[] => {
  const p: [number, number][] = [
    [x, y],
    [x + s, y],
    [x + s, y + s],
    [x, y + s],
  ];
  const q = ccw ? p : [...p].reverse();
  return [
    { kind: 'moveTo', to: q[0]! },
    ...q.slice(1).map((to): PathCommand => ({ kind: 'lineTo', to })),
    { kind: 'close' },
  ];
};

/**
 * Artwork about the anchor: a 6 mm square frame drawn as one evenodd path (both squares the
 * same way round), and a 2 mm square of its own beside it. Area 36 - 16 + 4 = 24 at scale 1.
 */
const PATHS: SvgOutlinePath[] = [
  { fillRule: 'evenodd', commands: [...square(-6, -3, 6), ...square(-5, -2, 4)] },
  { fillRule: 'nonzero', commands: square(2, -1, 2, false) },
];
const AREA = 24;

function artwork(paths = PATHS): OutlineEntity {
  return {
    id: 'e5',
    kind: 'outline',
    construction: false,
    anchor: [20, 15],
    angle: 0,
    source: { kind: 'svg', fileName: 'sign.svg', paths, scale: mm('#k') },
  };
}

function profiled(id: string, entities: string[], depth: string): ExtrudeFeature {
  return { ...extrude(id, 'sketch#1', depth), profile: { sketch: 'sketch#1', entities } };
}

/** The 40 x 30 plate with the artwork; extrude#1 the plate 2 mm, extrude#2 the artwork 1 mm. */
function signed(paths = PATHS): ManufaktureDocument {
  const sketch = rectangle('sketch#1', { width: '40', depth: '30' });
  return build([
    setVariable('k', '2'),
    add({ ...sketch, entities: [...sketch.entities, artwork(paths)] }),
    add(profiled('extrude#1', ['e1', 'e2', 'e3', 'e4'], '2')),
    add(profiled('extrude#2', ['e5'], '1')),
  ]);
}

function engine(): RegenEngine {
  return new RegenEngine({ kernel: service, solver });
}

async function volumes(e: RegenEngine, result: RegenResult): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const b of result.parts[0]!.bodies) {
    const reply = await service.run({
      generation: e.generation,
      ops: [{ op: 'properties', shape: b.shape as ShapeId }],
    });
    const r = reply.results[0]!;
    if (!r.ok) throw new Error(r.error.message);
    out[b.bodyId] = (r.value as { volume: number }).volume;
  }
  return out;
}

describe('SVG artwork in a sketch, through regen and the kernel', () => {
  it('cuts the plate around the artwork and extrudes it, at its scale variable', async () => {
    const e = engine();
    let doc = signed();
    const result = (await e.regen(doc))!;
    expect(statuses(result)).toEqual({ 'sketch#1': 'ok', 'extrude#1': 'ok', 'extrude#2': 'ok' });
    const sketch = result.parts[0]!.features[0]!;
    expect(sketch.warnings).toEqual([]);
    // The frame with its hole (evenodd), and the small square.
    expect(sketch.outlines!.map((s) => [s.key, s.holes.length])).toEqual([
      ['e5.g0.c0', 1],
      ['e5.g1.c0', 0],
    ]);
    let v = await volumes(e, result);
    expect(v['extrude#2']).toBeCloseTo(AREA * 4, 6);
    expect(v['extrude#1']).toBeCloseTo((1200 - AREA * 4) * 2, 6);
    doc = apply(doc, setVariable('k', '3'));
    const bigger = (await e.regen(doc))!;
    v = await volumes(e, bigger);
    expect(v['extrude#2']).toBeCloseTo(AREA * 9, 6);
    // Unchanged on a fresh copy: the sketch from the cache.
    const again = (await e.regen(structuredClone(doc)))!;
    expect(again.parts[0]!.features[0]!.cached).toBe(true);
  });

  it('caches the conversion by content, and keys the sketch by a hash of the paths', () => {
    const a = cachedSvgOutlineRegions(structuredClone(PATHS), 2);
    const b = cachedSvgOutlineRegions(structuredClone(PATHS), 2);
    expect(b).toBe(a);
    expect(cachedSvgOutlineRegions(structuredClone(PATHS), 3)).not.toBe(a);
    expect(svgPathsHash(structuredClone(PATHS))).toBe(svgPathsHash(PATHS));
    const sketch = signed().parts[0]!.features[0] as SketchFeature;
    const keyed = sketchKeyDefinition(sketch);
    const source = (keyed.entities[4] as OutlineEntity).source as unknown as { paths: unknown };
    expect(source.paths).toBe(svgPathsHash(PATHS));
    // A sketch without artwork is keyed as it always was.
    const plain = rectangle('sketch#1', { width: '1', depth: '1' });
    expect(sketchKeyDefinition(plain)).toBe(plain);
  });

  it('fails the sketch on a scale that is not above 0, and on artwork it cannot convert', async () => {
    const e = engine();
    const zero = apply(signed(), setVariable('k', '0'));
    let result = (await e.regen(zero))!;
    let sketch = result.parts[0]!.features[0]!;
    expect(sketch.status).toBe('error');
    expect(sketch.errors[0]).toMatchObject({
      code: 'invalid',
      field: ['entities', 4, 'source', 'scale'],
    });
    // A curve and a piece of the same curve in another contour: refused, not silently dropped.
    const overlap: SvgOutlinePath[] = [
      {
        fillRule: 'nonzero',
        commands: [
          { kind: 'moveTo', to: [0, 0] },
          { kind: 'cubicTo', control1: [1, 2], control2: [3, 2], to: [4, 0] },
          { kind: 'close' },
          { kind: 'moveTo', to: [0, 0] },
          { kind: 'cubicTo', control1: [0.5, 1], control2: [1.25, 1.5], to: [2, 1.5] },
          { kind: 'lineTo', to: [2, -1] },
          { kind: 'lineTo', to: [0, -1] },
          { kind: 'close' },
        ],
      },
    ];
    result = (await e.regen(signed(overlap)))!;
    sketch = result.parts[0]!.features[0]!;
    expect(sketch.status).toBe('error');
    expect(sketch.errors[0]!.message).toMatch(
      /^The SVG artwork e5 \(sign\.svg, shape 1\) could not be converted/,
    );
    expect(PART).toBe('part#1');
  });

  it('groups the warnings of artwork with 30,000 open subpaths into a few short ones', async () => {
    const open: PathCommand[] = [];
    for (let i = 0; i < 30_000; i++) {
      const x = -9 + (i % 300) * 0.06;
      const y = -6 + Math.floor(i / 300) * 0.06;
      open.push({ kind: 'moveTo', to: [x, y] }, { kind: 'lineTo', to: [x + 0.03, y] });
    }
    const paths: SvgOutlinePath[] = [...PATHS, { fillRule: 'nonzero', commands: open }];
    const result = (await engine().regen(signed(paths)))!;
    const sketch = result.parts[0]!.features[0]!;
    expect(sketch.status).not.toBe('error');
    const svgWarnings = sketch.warnings.filter((w) => w.message.includes('sign.svg'));
    expect(svgWarnings.length).toBeGreaterThan(0);
    expect(svgWarnings.length).toBeLessThanOrEqual(9);
    const text = svgWarnings.map((w) => w.message).join('');
    expect(text.length).toBeLessThan(2000);
    expect(text).toMatch(/30,000 contours do not end where they start/);
    expect(text).toMatch(/and 29,997 more/);
  }, 60_000);

  it('shares one budget between the SVG outlines of a regen pass, and caches no refusal', async () => {
    // 120 thin bars crossing at one point: one outline costs about half the per-outline budget.
    const bars: PathCommand[] = Array.from({ length: 120 }, (_, i) => {
      const a = (Math.PI * i) / 120;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const w = 0.01;
      const p: [number, number][] = [
        [-50 * c + w * s, -50 * s - w * c],
        [50 * c + w * s, 50 * s - w * c],
        [50 * c - w * s, 50 * s + w * c],
        [-50 * c - w * s, -50 * s + w * c],
      ];
      return [
        { kind: 'moveTo', to: p[0]! },
        ...p.slice(1).map((to): PathCommand => ({ kind: 'lineTo', to })),
        { kind: 'close' },
      ] as PathCommand[];
    }).flat();
    // Each outline's paths a little different, so no conversion is a cache hit of another's.
    const shifted = (dx: number): PathCommand[] =>
      bars.map((c) => (c.kind === 'close' ? c : { ...c, to: [c.to[0] + dx, c.to[1]] as const }));
    const outline = (id: string, x: number): OutlineEntity => ({
      ...artwork([{ fillRule: 'nonzero', commands: shifted(x / 1000) }]),
      id,
      anchor: [x, 0],
    });
    const sketch = rectangle('sketch#1', { width: '700', depth: '30' });
    const doc = build([
      setVariable('k', '1'),
      add({
        ...sketch,
        entities: [...sketch.entities, outline('e5', 100), outline('e6', 300), outline('e7', 500)],
      }),
    ]);
    const e = engine();
    const t0 = performance.now();
    const result = (await e.regen(doc))!;
    const ms = performance.now() - t0;
    console.log(`SVG-REGEN 3 costly outlines in one pass: ${ms.toFixed(0)} ms`);
    // One budget for the pass, not one per outline: bounded however many outlines there are.
    expect(ms).toBeLessThan(30_000);
    const f = result.parts[0]!.features[0]!;
    expect(f.status).toBe('error');
    expect(f.errors.map((x) => x.message).join('\n')).toMatch(
      /too complex to convert in one rebuild/,
    );
    // Not cached: the next regen tries again (and is bounded the same way).
    const again = (await e.regen(structuredClone(doc)))!;
    expect(again.parts[0]!.features[0]!.cached).toBe(false);
  }, 120_000);
});
