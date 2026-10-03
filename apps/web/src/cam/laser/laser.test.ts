// The laser and plasma export's logic with a scripted geometry stage and section: the setup made
// up for the stage, sources to layers in one frame, the stage's errors named by source, the kerf
// checks, and the files read back (areas exact, kerf by Steiner's formula).

import { loopArea, loopLength, type Loop2, type PlanarLoops } from '@manufakture/cam';
import type { ManufaktureDocument } from '@manufakture/core';
import type { SectionLoops } from '@manufakture/kernel';
import type {
  CamGeometryResult,
  CamOperationResult,
  CamSourceResult,
  CamStageError,
} from '@manufakture/regen';
import { describe, expect, it, vi } from 'vitest';
import { setupDocument } from '../cam.test-fixture';
import type { CamGeometer } from '../geometer';
import {
  MAX_KERF,
  defaultLayer,
  extractLoops,
  kerfProblem,
  laserFile,
  laserSetupDocument,
  layerNameClashes,
  outlineSize,
  sameSource,
  sectionFrame,
  type LaserLayer,
  type LaserSource,
} from './laser';
import { dxfLoops, svgLoops } from './readBack.test-fixture';

/**
 * The M1 bracket's side profile, counter-clockwise: a 50 mm foot and a 40 mm upright, 6 mm thick,
 * with a 4 mm fillet in the inside corner (a clockwise arc, since the corner is concave).
 */
function bracketProfile(): Loop2 {
  const pts = {
    a: [0, 0],
    b: [50, 0],
    c: [50, 6],
    d: [10, 6],
    e: [6, 10],
    f: [6, 40],
    g: [0, 40],
  } as const;
  return {
    segments: [
      { kind: 'line', start: pts.a, end: pts.b },
      { kind: 'line', start: pts.b, end: pts.c },
      { kind: 'line', start: pts.c, end: pts.d },
      { kind: 'arc', start: pts.d, end: pts.e, center: [10, 10], ccw: false },
      { kind: 'line', start: pts.e, end: pts.f },
      { kind: 'line', start: pts.f, end: pts.g },
      { kind: 'line', start: pts.g, end: pts.a },
    ],
  };
}

/** 504 mm2 of L plus the fillet's corner: 16 - 4 pi. */
const PROFILE_AREA = 504 + 16 * (1 - Math.PI / 4);
const PROFILE_PERIMETER = 172 + 2 * Math.PI;

/** A clockwise circle (a hole). */
function hole(cx: number, cy: number, r: number): Loop2 {
  return {
    segments: [
      {
        kind: 'arc',
        start: [cx + r, cy],
        end: [cx + r, cy],
        center: [cx, cy],
        ccw: false,
        fullCircle: true,
      },
    ],
  };
}

/** The bracket's front face (Y = -15, outward normal -Y), seen from the front: X right, Z up. */
const FRONT: PlanarLoops = {
  origin: [0, -15, 0],
  xDir: [1, 0, 0],
  normal: [0, -1, 0],
  loops: [bracketProfile()],
};

type Reply =
  | { planar: PlanarLoops }
  | { error: Partial<CamStageError> & { code: CamStageError['code']; message: string } };

/** A geometer answering each source sent (by its index) from `replies`, by the setup's up. */
function scriptedGeometer(replies: (up: string) => Reply[]) {
  const calls: { document: ManufaktureDocument; setupId: string }[] = [];
  const geometer: CamGeometer = {
    geometry: vi.fn(async (document: ManufaktureDocument, setupId: string) => {
      calls.push({ document, setupId });
      const setup = document.cam.setups.find((s) => s.id === setupId)!;
      const up = setup.wcs.up.kind === 'axis' ? setup.wcs.up.axis : 'face';
      const op = setup.operations[0]!;
      const sources: CamSourceResult[] = [];
      const errors: CamStageError[] = [
        // The made-up operation's tool is missing: never reported.
        { code: 'invalid', field: ['tool'], message: `The document has no tool ${op.tool}` },
      ];
      replies(up).forEach((r, i) => {
        if ('planar' in r) {
          sources.push(
            op.geometry[i]!.kind === 'face'
              ? { source: i, kind: 'face', z: 0, facing: true, planar: r.planar }
              : { source: i, kind: 'region', z: 0, planar: r.planar },
          );
        } else errors.push({ source: i, ...r.error } as CamStageError);
      });
      const result: CamOperationResult = {
        operationId: op.id,
        kind: op.kind,
        key: 'k',
        status: 'error',
        errors,
        warnings: [],
        references: [],
        sources,
        values: null,
      };
      return {
        generation: 1,
        setupId,
        partId: setup.part,
        bodyId: 'extrude#1',
        bodyKey: 'b',
        key: 'k',
        status: 'ok',
        errors: [],
        warnings: [],
        references: [],
        bounds: { min: [0, -15, 0], max: [50, 15, 40] },
        setup: null,
        operations: [result],
        cached: false,
        ms: 1,
      } as CamGeometryResult;
    }),
  };
  return { geometer, calls };
}

const face = (name: string, layer = 'cut'): LaserSource => ({
  kind: 'face',
  ref: { face: name },
  label: `Face ${name}`,
  layer,
});
const region = (sketch: string, layer = 'cut'): LaserSource => ({
  kind: 'region',
  sketch,
  label: `Regions of ${sketch}`,
  layer,
});
const scope = { partId: 'part#1', viewId: 'part#1/extrude#1' };

const areaOf = (loops: readonly Loop2[]) => loops.reduce((a, l) => a + loopArea(l), 0);

/** The centres of a loop's arcs, in order. */
const arcCenters = (loop: Loop2) =>
  loop.segments.flatMap((s) => (s.kind === 'arc' ? [[s.center[0], s.center[1]]] : []));

/** Whether one of `centers` is within 1e-3 mm of `at`. */
const near = (centers: readonly (readonly number[])[], at: readonly [number, number]) =>
  centers.some((c) => Math.hypot(c[0]! - at[0], c[1]! - at[1]) < 1e-3);

describe('laserSetupDocument', () => {
  it('adds a setup the stage can resolve, under free ids, leaving the document alone', () => {
    const doc = setupDocument();
    const before = JSON.stringify(doc);
    const { document, setupId } = laserSetupDocument(
      doc,
      { partId: 'part#1', body: 'extrude#1' },
      [
        face('extrude#1:side:1') as Extract<LaserSource, { kind: 'face' }>,
        region('sketch#1') as Extract<LaserSource, { kind: 'region' }>,
      ],
      { kind: 'axis', axis: '+z' },
    );
    expect(JSON.stringify(doc)).toBe(before);
    expect(setupId).toBe('setup#2');
    const setup = document.cam.setups.find((s) => s.id === setupId)!;
    expect(setup.part).toBe('part#1');
    expect(setup.body).toBe('extrude#1');
    expect(setup.wcs.up).toEqual({ kind: 'axis', axis: '+z' });
    const op = setup.operations[0]!;
    expect(op.kind).toBe('profile');
    expect(document.cam.tools.some((t) => t.id === op.tool)).toBe(false);
    expect(op.geometry).toEqual([
      { kind: 'face', face: { id: 'r1', ref: { face: 'extrude#1:side:1' } } },
      { kind: 'region', sketch: 'sketch#1' },
    ]);
  });
});

describe('sources', () => {
  it('names layers by kind and number, and knows a source it already has', () => {
    const list = [face('a', 'face-1'), region('sketch#1', 'region-1')];
    expect(defaultLayer('face', list)).toBe('face-2');
    expect(defaultLayer('section', list)).toBe('section-1');
    expect(sameSource(face('a'), face('a', 'other'))).toBe(true);
    expect(sameSource(face('a'), face('b'))).toBe(false);
    expect(sameSource(region('sketch#1'), region('sketch#1'))).toBe(true);
  });

  it('frames sections as the standard views see the part', () => {
    expect(sectionFrame('y', -10)).toEqual({
      frame: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] },
      height: 10,
    });
    expect(sectionFrame('z', 3).height).toBe(3);
    expect(sectionFrame('x', 2).frame.xDir).toEqual([0, 1, 0]);
  });
});

describe('extractLoops', () => {
  it('reads a face through the stage, up from the face, into its layer', async () => {
    const { geometer, calls } = scriptedGeometer(() => [{ planar: FRONT }]);
    const r = await extractLoops(setupDocument(), scope, [face('extrude#1:front')], { geometer });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls).toHaveLength(1);
    const setup = calls[0]!.document.cam.setups.find((s) => s.id === calls[0]!.setupId)!;
    expect(setup.wcs.up).toEqual({
      kind: 'face',
      face: { id: 'r1', ref: { face: 'extrude#1:front' } },
    });
    expect(r.layers.map((l) => l.name)).toEqual(['cut']);
    const loops = r.layers[0]!.loops;
    expect(areaOf(loops)).toBeCloseTo(PROFILE_AREA, 9);
    expect(outlineSize(r.layers)).toMatchObject({ width: 50, height: 40 });
    // Not mirrored or turned: the fillet stays in the lower left corner, the upright on the left.
    expect(arcCenters(loops[0]!)).toEqual([[10, 10]]);
  });

  it('names each source in the stage errors and ignores the made-up tool', async () => {
    const { geometer } = scriptedGeometer(() => [
      { planar: FRONT },
      { error: { code: 'reference-lost', message: 'Part 1 has no sketch#9 any more' } },
    ]);
    const r = await extractLoops(
      setupDocument(),
      scope,
      [face('extrude#1:front'), region('sketch#9')],
      { geometer },
    );
    expect(r).toEqual({
      ok: false,
      messages: ['Regions of sketch#9: Part 1 has no sketch#9 any more'],
    });
  });

  it('tries the model axes for sketch regions alone, until they lie across one', async () => {
    const { geometer, calls } = scriptedGeometer((up) =>
      up === '+y'
        ? [{ planar: FRONT }]
        : [{ error: { code: 'not-parallel', message: 'sketch#1 is not parallel' } }],
    );
    const r = await extractLoops(setupDocument(), scope, [region('sketch#1')], { geometer });
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.document.cam.setups.at(-1)!.wcs.up)).toEqual([
      { kind: 'axis', axis: '+z' },
      { kind: 'axis', axis: '+y' },
    ]);
  });

  it('refuses a source that is not parallel to the first, and an empty layer name', async () => {
    const top: PlanarLoops = { ...FRONT, origin: [0, 0, 6], normal: [0, 0, 1] };
    const { geometer } = scriptedGeometer(() => [{ planar: FRONT }, { planar: top }]);
    const r = await extractLoops(setupDocument(), scope, [face('front'), face('top', 'top')], {
      geometer,
    });
    expect(r).toEqual({
      ok: false,
      messages: ['Face top: not parallel to Face front; export it on its own.'],
    });
    // The frame comes from the first source read, which need not be the first in the list: a
    // source the stage passes over silently (here the first) is not the one named.
    const skipped: Reply[] = [];
    skipped[1] = { planar: FRONT };
    skipped[2] = { planar: top };
    const later = scriptedGeometer(() => skipped).geometer;
    const named = await extractLoops(
      setupDocument(),
      scope,
      [region('sketch#1', 'r'), face('front'), face('top', 'top')],
      { geometer: later },
    );
    expect(named).toEqual({
      ok: false,
      messages: ['Face top: not parallel to Face front; export it on its own.'],
    });
    const one = scriptedGeometer(() => [{ planar: FRONT }]).geometer;
    const blank = await extractLoops(setupDocument(), scope, [face('front', ' ')], {
      geometer: one,
    });
    expect(blank).toEqual({ ok: false, messages: ['Face front: give it a layer name.'] });
  });

  it('cuts a section through the kernel, in the same frame as a face on a parallel plane', async () => {
    const { geometer } = scriptedGeometer(() => [{ planar: FRONT }]);
    // The kernel's section at Y = -10, in the frame `sectionFrame('y', -10)` gives: X and Z.
    const section: SectionLoops = {
      height: 10,
      regions: [
        {
          outer: {
            area: 100,
            segments: [
              { kind: 'line', start: [0, 0], end: [10, 0] },
              { kind: 'line', start: [10, 0], end: [10, 10] },
              {
                kind: 'polyline',
                points: [
                  [10, 10],
                  [5, 10],
                  [0, 10],
                ],
              },
              { kind: 'line', start: [0, 10], end: [0, 0] },
            ],
          },
          holes: [
            {
              area: -Math.PI,
              segments: [
                {
                  kind: 'arc',
                  start: [4, 6],
                  end: [4, 6],
                  center: [3, 6],
                  radius: 1,
                  sweep: -2 * Math.PI,
                },
              ],
            },
          ],
        },
      ],
      open: [],
    };
    const cut = vi.fn(async () => ({ ok: true as const, value: section }));
    const sources: LaserSource[] = [
      face('front', 'outline'),
      { kind: 'section', axis: 'y', position: -10, label: 'Section across Y', layer: 'section' },
    ];
    const r = await extractLoops(setupDocument(), scope, sources, { geometer, section: cut });
    expect(cut).toHaveBeenCalledWith('part#1/extrude#1', sectionFrame('y', -10).frame, 10, 0.01);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layers.map((l) => l.name)).toEqual(['outline', 'section']);
    const s = r.layers[1]!.loops;
    expect(s).toHaveLength(2);
    // The same plane orientation as the face: no mirror, the hole stays clockwise.
    expect(areaOf(s)).toBeCloseTo(100 - Math.PI, 9);
    expect(s[1]!.segments[0]).toMatchObject({ kind: 'arc', fullCircle: true, ccw: false });
    // And neither turned nor mirrored: the hole off centre stays where the kernel put it.
    expect(arcCenters(s[1]!)).toEqual([[3, 6]]);
    expect(arcCenters(r.layers[0]!.loops[0]!)).toEqual([[10, 10]]);
  });

  it('reports a section that misses the body, and a scene without a kernel', async () => {
    const miss = vi.fn(async () => ({
      ok: true as const,
      value: { height: 0, regions: [], open: [] },
    }));
    const src: LaserSource = {
      kind: 'section',
      axis: 'z',
      position: 99,
      label: 'Section across Z',
      layer: 's',
    };
    expect(
      await extractLoops(setupDocument(), scope, [src], { geometer: null, section: miss }),
    ).toEqual({
      ok: false,
      messages: ['Section across Z: the plane does not cut the body.'],
    });
    expect(await extractLoops(setupDocument(), scope, [face('a')], { geometer: null })).toEqual({
      ok: false,
      messages: ['Faces and sketch regions need the geometry kernel.'],
    });
    expect(await extractLoops(setupDocument(), scope, [], { geometer: null })).toEqual({
      ok: false,
      messages: ['Add a face, a sketch region or a section to export.'],
    });
  });
});

describe('kerfProblem', () => {
  const size = { min: [0, 0] as [number, number], width: 50, height: 40 };
  it('takes zero and a plausible kerf', () => {
    expect(kerfProblem(0, size)).toBeNull();
    expect(kerfProblem(0.2, size)).toBeNull();
    expect(kerfProblem(1.5, null)).toBeNull();
  });
  it('refuses a negative kerf, one over the limit, and one too wide for the part', () => {
    expect(kerfProblem(-0.1, size)).toBe('The kerf must be zero or more.');
    expect(kerfProblem(Number.NaN, size)).toBe('The kerf must be a finite number.');
    expect(kerfProblem(MAX_KERF + 1, null)).toMatch(/^A kerf over 10 mm/);
    expect(kerfProblem(11, size)).toMatch(/^A kerf over 10 mm/);
    const small = { min: [0, 0] as [number, number], width: 8, height: 4 };
    expect(kerfProblem(1.5, small)).toBe(
      'The kerf is too wide for this outline (8 x 4 mm): at most 1 mm, a quarter of its smaller side.',
    );
  });
});

describe('laserFile', () => {
  // The profile placed away from the origin, with a hole in the foot: the file moves it to (0, 0).
  const shifted = (dx: number, dy: number): Loop2 => {
    const p = (q: readonly [number, number]) => [q[0] + dx, q[1] + dy] as [number, number];
    return {
      segments: bracketProfile().segments.map((s) =>
        s.kind === 'line'
          ? { ...s, start: p(s.start), end: p(s.end) }
          : { ...s, start: p(s.start), end: p(s.end), center: p(s.center) },
      ),
    };
  };
  const layers: LaserLayer[] = [
    { name: 'outline', loops: [shifted(-25, 7)] },
    { name: 'holes', loops: [hole(0, 10, 2.25)] },
  ];
  const holeArea = Math.PI * 2.25 * 2.25;

  for (const format of ['dxf', 'svg'] as const) {
    it(`writes ${format.toUpperCase()} that reads back with the exact areas, at the origin`, () => {
      const r = laserFile(layers, { format, kerf: 0, baseName: 'Bracket' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.file.name).toBe(`Bracket.${format}`);
      expect(r.file.type).toBe(format === 'dxf' ? 'application/dxf' : 'image/svg+xml');
      const text = new TextDecoder().decode(r.file.bytes);
      const loops = format === 'dxf' ? dxfLoops(text) : svgLoops(text);
      expect(loops.map((l) => l.layer)).toEqual(['outline', 'holes']);
      const [outline, h] = loops as [(typeof loops)[0], (typeof loops)[0]];
      expect(outline.area).toBeCloseTo(PROFILE_AREA, 5);
      expect(outline.arcs).toBeGreaterThanOrEqual(1);
      expect(outline.min[0]).toBeCloseTo(0, 6);
      expect(outline.min[1]).toBeCloseTo(0, 6);
      expect(outline.max[0]).toBeCloseTo(50, 6);
      expect(outline.max[1]).toBeCloseTo(40, 6);
      // Asymmetric: the fillet's centre in the lower left (a mirror or a turn would move it), and
      // the hole low in the foot.
      expect(near(outline.centers, [10, 10])).toBe(true);
      expect(near(h.centers, [25, 3])).toBe(true);
      // A DXF circle has no direction; the SVG path keeps the hole clockwise.
      expect(Math.abs(h.area)).toBeCloseTo(holeArea, 5);
      expect(r.size).toMatchObject({ width: 50, height: 40 });
    });
  }

  it('compensates the kerf: the outline grows and the hole shrinks by about P k / 2', () => {
    const kerf = 0.2;
    const d = kerf / 2;
    const r = laserFile(layers, { format: 'dxf', kerf, baseName: 'Bracket' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [outline, h] = dxfLoops(new TextDecoder().decode(r.file.bytes)) as [
      ReturnType<typeof dxfLoops>[0],
      ReturnType<typeof dxfLoops>[0],
    ];
    // Steiner: P d + pi d^2 out, P d - pi d^2 in; the refit keeps loops within 0.002 mm.
    expect(
      Math.abs(outline.area - (PROFILE_AREA + PROFILE_PERIMETER * d + Math.PI * d * d)),
    ).toBeLessThan(0.002 * PROFILE_PERIMETER);
    expect(PROFILE_PERIMETER).toBeCloseTo(loopLength(bracketProfile()), 9);
    expect(Math.abs(h.area)).toBeCloseTo(Math.PI * (2.25 - d) ** 2, 3);
    // The fillet stays an arc (now of radius 3.9) and the outline is 50.2 x 40.2.
    expect(outline.arcs).toBeGreaterThanOrEqual(1);
    expect(near(outline.centers, [10.1, 10.1])).toBe(true);
    expect(r.size.width).toBeCloseTo(50.2, 3);
    expect(r.size.height).toBeCloseTo(40.2, 3);
  });

  it('warns when layer names become the same in the file', () => {
    expect(layerNameClashes(['cut', 'Cut', 'a/b', 'a:b', 'engrave'], 'dxf')).toEqual([
      'Layers "cut", "Cut" have the same name in DXF; all but the first are numbered (_2, _3...): rename them to tell them apart.',
      'Layers "a/b", "a:b" have the same name in DXF; all but the first are numbered (_2, _3...): rename them to tell them apart.',
    ]);
    expect(layerNameClashes(['0'], 'dxf')).toEqual([
      'Layer "0" is DXF\'s own default layer, so it is written as 0_2: rename it to keep it apart.',
    ]);
    // SVG keeps case apart, but not "a b" and "a_b".
    expect(layerNameClashes(['cut', 'Cut'], 'svg')).toEqual([]);
    expect(layerNameClashes(['a b', 'a_b'], 'svg')).toEqual([
      'Layers "a b", "a_b" have the same id in SVG; rename them to tell them apart.',
    ]);
    const r = laserFile(
      [
        { name: 'outer cut', loops: [shifted(0, 0)] },
        { name: 'Outer Cut', loops: [hole(25, 3, 1)] },
      ],
      { format: 'dxf', kerf: 0, baseName: 'x' },
    );
    expect(r.ok && r.warnings).toEqual([
      'Layers "outer cut", "Outer Cut" have the same name in DXF; all but the first are numbered (_2, _3...): rename them to tell them apart.',
    ]);
  });

  it('refuses a bad kerf and warns about a hole that closes up', () => {
    expect(laserFile(layers, { format: 'svg', kerf: -1, baseName: 'x' })).toEqual({
      ok: false,
      message: 'The kerf must be zero or more.',
    });
    const pin: LaserLayer[] = [{ name: 'cut', loops: [shifted(0, 0), hole(25, 3, 0.1)] }];
    const r = laserFile(pin, { format: 'svg', kerf: 0.4, baseName: 'x' });
    expect(r.ok && r.warnings).toEqual([
      'Layer cut: 1 hole(s) narrower than the kerf closed up and are left out.',
    ]);
  });
});
