// Checks on the spike's own code and on the findings the report relies on.

import { beforeAll, describe, expect, it } from 'vitest';
import { type WasmLoad, loadWasm, tsEngine, wasm64Engine, wasmDEngine } from './engines.ts';
import { bracket, circlePoints, dumbbell, flower10k, frame, narrowSlots } from './fixtures.ts';
import {
  type Shape,
  dist,
  flatten,
  pathsArea,
  polygonShape,
  shapeArea,
  vertexCount,
} from './geometry.ts';
import { deviationOfElements, deviationOfPaths, exactOffsetSamples } from './metrics.ts';
import {
  type Element,
  arcRadius,
  arcSweep,
  demoteArcs,
  grblArcCheck,
  grblRadiusError,
  refitTagged,
  refitUntagged,
} from './refit.ts';

const O = { scale: 1e4, arcTol: 0.001 };
const all = (shapes: readonly Shape[]): Shape => ({ loops: shapes.flatMap((s) => s.loops) });
const arcsOf = (loops: Element[][]) =>
  loops.flat().filter((e): e is Element & { kind: 'arc' } => e.kind === 'arc');

let wasm: WasmLoad;
beforeAll(async () => {
  wasm = await loadWasm();
});

describe('fixtures from detectRegions', () => {
  it('give the exact areas of their sketches', () => {
    const b = all(bracket().shapes);
    const expected = 100 * 60 - (4 - Math.PI) * 64 - 2 * Math.PI * 36 - (30 * 10 + Math.PI * 25);
    expect(shapeArea(b)).toBeCloseTo(expected, 9);
    expect(shapeArea(all(dumbbell().shapes))).toBeGreaterThan(0);
  });

  it('tag every flattened vertex with its source curve', () => {
    const fl = flatten(all(bracket().shapes), 0.001);
    const z = fl.paths.flatMap((p) => [...p.z]);
    expect(new Set(z).size).toBe(z.length);
    expect(Math.min(...z)).toBe(1);
    for (const v of fl.vertices) {
      const c = fl.curves[v.curves[0]!]!;
      if (c.kind === 'arc') expect(Math.abs(dist(v.point, c.c) - c.r)).toBeLessThan(1e-9);
    }
  });
});

describe('offsets', () => {
  it('agree between clipper2-ts and clipper2-wasm', () => {
    const fl = flatten(all(bracket().shapes), 0.001);
    for (const d of [3, -3]) {
      const a = tsEngine.offset(fl.paths, d, O);
      const b = wasm64Engine(wasm.module).offset(fl.paths, d, O);
      const c = wasmDEngine(wasm.module).offset(fl.paths, d, O);
      expect(vertexCount(a)).toBe(vertexCount(b));
      expect(pathsArea(a)).toBeCloseTo(pathsArea(b), 6);
      expect(pathsArea(c)).toBeCloseTo(pathsArea(b), 6);
    }
  });

  it('match the exact offset within the flattening and join tolerances', () => {
    for (const c of [bracket(), frame()]) {
      const shape = all(c.shapes);
      const fl = flatten(shape, 0.001);
      for (const d of c.deltas) {
        const out = tsEngine.offset(fl.paths, d, O);
        const dev = deviationOfPaths(out, shape, d, exactOffsetSamples(shape, d, 0.1));
        expect(dev.hausdorff).toBeLessThan(0.0013);
        expect(Math.abs(pathsArea(out) - c.exactArea!(d)!)).toBeLessThan(0.2);
      }
    }
  });

  it('let a slot narrower than the tool vanish and keep a 0.2 mm sliver', () => {
    const c = narrowSlots();
    for (const e of [tsEngine, wasm64Engine(wasm.module)]) {
      const out = e.offset(flatten(all(c.shapes), 0.001).paths, -3, O);
      expect(out).toHaveLength(1);
      expect(pathsArea(out)).toBeCloseTo(c.exactArea!(-3)!, 2);
    }
  });

  it('split the dumbbell in two', () => {
    const shape = all(dumbbell().shapes);
    const out = tsEngine.offset(flatten(shape, 0.001).paths, -3, O);
    expect(out).toHaveLength(2);
    expect(
      deviationOfPaths(out, shape, -3, exactOffsetSamples(shape, -3, 0.1)).hausdorff,
    ).toBeLessThan(0.0013);
  });

  it('carry Z tags through clipper2-wasm as well as clipper2-ts', () => {
    const fl = flatten(all(bracket().shapes), 0.001);
    for (const e of [tsEngine, wasm64Engine(wasm.module), wasmDEngine(wasm.module)]) {
      const out = e.offset(fl.paths, 3, O);
      const z = out.flatMap((p) => [...p.z]);
      expect(z.every((t) => t > 0 && t <= fl.vertices.length)).toBe(true);
    }
  });

  it('keep the WASM heap flat when every object is deleted', () => {
    const fl = flatten(all(bracket().shapes), 0.001);
    const e = wasm64Engine(wasm.module);
    for (let i = 0; i < 10; i++) e.offset(fl.paths, -3, O);
    const top = () => {
      const p = wasm.malloc(1 << 20);
      wasm.free(p);
      return p;
    };
    const before = top();
    for (let i = 0; i < 200; i++) e.offset(fl.paths, -3, O);
    expect(top()).toBe(before);
  });
});

describe('arc refit', () => {
  it('turns a 10,000-gon offset back into two arcs', () => {
    const shape = polygonShape(circlePoints([0, 0], 50, 10_000));
    const out = tsEngine.offset(flatten(shape, 1).paths, -3, O);
    const loops = out.map((p) => refitUntagged(p, 0.002));
    const arcs = arcsOf(loops);
    expect(loops.flat()).toHaveLength(2);
    for (const a of arcs) expect(arcRadius(a)).toBeCloseTo(47, 3);
  });

  it('keeps a rectangle as four lines', () => {
    const shape = polygonShape([
      [0, 0],
      [40, 0],
      [40, 20],
      [0, 20],
    ]);
    const out = tsEngine.offset(flatten(shape, 1).paths, -2, O);
    const loops = out.map((p) => refitUntagged(p, 0.002));
    expect(loops.flat().map((e) => e.kind)).toEqual(['line', 'line', 'line', 'line']);
  });

  it('puts tagged arcs on the exact offset circles', () => {
    const c = frame();
    const shape = all(c.shapes);
    const fl = flatten(shape, 0.01);
    for (const d of c.deltas) {
      const out = tsEngine.offset(fl.paths, d, O);
      const loops = out.map((p) => refitTagged(p, fl, d, 0.002, 0.0115));
      const dev = deviationOfElements(loops, shape, d, exactOffsetSamples(shape, d, 0.1));
      expect(dev.hausdorff).toBeLessThan(1e-6);
    }
  });

  it('stays within the tolerance untagged and passes GRBL radius check', () => {
    const shape = all(bracket().shapes);
    const fl = flatten(shape, 0.001);
    for (const d of [3, -3]) {
      const out = tsEngine.offset(fl.paths, d, O);
      for (const loops of [
        out.map((p) => refitUntagged(p, 0.002)),
        out.map((p) => refitTagged(p, fl, d, 0.002, 0.0025)),
      ]) {
        const dev = deviationOfElements(loops, shape, d, exactOffsetSamples(shape, d, 0.1));
        expect(dev.hausdorff).toBeLessThan(0.0035);
        for (const a of arcsOf(loops)) expect(grblRadiusError(a).ok).toBe(true);
        // Closed and continuous.
        for (const l of loops) {
          l.forEach((e, i) => expect(dist(e.b, l[(i + 1) % l.length]!.a)).toBeLessThan(1e-9));
        }
      }
    }
  });

  it('flags an arc whose end radius is off by more than GRBL allows', () => {
    const bad: Element & { kind: 'arc' } = {
      kind: 'arc',
      a: [10, 0],
      b: [0, 10.02],
      c: [0, 0],
      ccw: true,
    };
    expect(grblRadiusError(bad).ok).toBe(false);
    const good: Element & { kind: 'arc' } = {
      kind: 'arc',
      a: [10, 0],
      b: [0, 10.004],
      c: [0, 0],
      ccw: true,
    };
    expect(grblRadiusError(good).ok).toBe(true);
  });

  it('turns a degenerate tiny arc, which Grbl would run as a full circle, into a line', () => {
    // From the review: flower-10k +3, tagged + Z callback, tagTol 0.0015. Written as
    // G2 X36.494 Y-6.533 I-2.832 J-0.991, its end equals its start: Grbl cuts a 6 mm circle.
    const a: [number, number] = [36.49430847, -6.53339703];
    const b: [number, number] = [36.49431939, -6.53342822];
    // The centre 3 mm away, on the bisector of the chord, on the side that makes it a G2.
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const h = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u = [(b[0] - a[0]) / h, (b[1] - a[1]) / h];
    const k = Math.sqrt(9 - (h * h) / 4);
    const c: [number, number] = [m[0]! + u[1]! * k, m[1]! - u[0]! * k];
    const tiny: Element & { kind: 'arc' } = { kind: 'arc', a, b, c, ccw: false };
    expect(Math.abs(arcRadius(tiny) - 3)).toBeLessThan(1e-9);
    expect(Math.abs(arcSweep(tiny))).toBeLessThan(2e-5);
    const check = grblArcCheck(tiny);
    expect(check.radiusOk).toBe(true); // error 33 does not catch it
    expect(check.travelOk).toBe(false);
    expect(Math.abs(check.travel)).toBeCloseTo(2 * Math.PI, 3);
    const { elements, demoted } = demoteArcs([tiny], 0.0005);
    expect(demoted).toBe(1);
    expect(elements[0]).toEqual({ kind: 'line', a, b });
    // A proper arc stays an arc, and passes.
    const quarter: Element & { kind: 'arc' } = {
      kind: 'arc',
      a: [3, 0],
      b: [0, 3],
      c: [0, 0],
      ccw: true,
    };
    expect(grblArcCheck(quarter).ok).toBe(true);
    expect(demoteArcs([quarter], 0.0005).demoted).toBe(0);
  });

  it('leaves no arc Grbl would cut differently in the refit of the 10,000-vertex outlines', () => {
    const c = flower10k();
    const fl = flatten(all(c.shapes), 1);
    for (const tagTol of [0.0015, 0.0025]) {
      const out = tsEngine.offset(fl.paths, 3, { ...O, zCallback: true });
      const stats = { demoted: 0 };
      const loops = out.map((p) => refitTagged(p, fl, 3, 0.002, tagTol, { stats }));
      for (const arc of arcsOf(loops)) expect(grblArcCheck(arc).ok).toBe(true);
      const raw = out.map((p) => refitTagged(p, fl, 3, 0.002, tagTol, { demote: false }));
      if (tagTol === 0.0015) {
        expect(arcsOf(raw).some((arc) => !grblArcCheck(arc).travelOk)).toBe(true);
        expect(stats.demoted).toBeGreaterThan(0);
      }
    }
  });
});
