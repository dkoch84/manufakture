import { describe, expect, it } from 'vitest';
import type { Loop2, Segment2, Vec2 } from '../types';
import { offsetLoops, type Region2 } from './engine';
import { flattenSegments } from './flatten';
import { distToLoops, pointInLoops, segmentTangent } from './geometry';
import { grblArcPrecheck } from './grbl';
import {
  allLoops,
  allSegments,
  circle,
  convexPolygon,
  hausdorff,
  hole,
  rng,
  roundedRect,
  samples,
  starPolygon,
} from './test-shapes';
import { REFIT_TOLERANCE } from './tolerances';

// Property tests on random polygons (M5 plan, T5.2a acceptance). Morphology gives exact identities
// to test against without knowing the answer: with D the outward offset by d and E the inward one,
//
// - closing C = E(D(P)) contains P and is P with its concave corners rounded (radius d) and gaps
//   narrower than 2d bridged; for a convex P it is P itself;
// - D(C) = D(P) (D E D = D).
//
// Each offset after refit is within REFIT_TOLERANCE of the exact one; a chain of three can add up.

const SEEDS = 25;
const CHAIN_TOLERANCE = 3 * REFIT_TOLERANCE;

function value(r: ReturnType<typeof offsetLoops>): Region2[] {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function polylines(loops: readonly Loop2[]): Vec2[][] {
  return loops.map((l) => flattenSegments(l.segments, true, 0.0005));
}

/** The signed turn from segment `a` into segment `b`, radians: positive to the left. */
function turnAngle(a: Segment2, b: Segment2): number {
  const t0 = segmentTangent(a, 1);
  const t1 = segmentTangent(b, 0);
  return Math.atan2(t0[0] * t1[1] - t0[1] * t1[0], t0[0] * t1[0] + t0[1] * t1[1]);
}

function expectArcsPassGrbl(regions: readonly Region2[]): void {
  for (const s of allSegments(regions)) {
    if (s.kind === 'arc') expect(grblArcPrecheck(s).ok).toBe(true);
  }
}

describe('offset out then in (closing) on random polygons', () => {
  it('contains the original, rounds only its concave side, and D(C) = D(P)', () => {
    let checked = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const random = rng(seed);
      const p = starPolygon(random, 8 + Math.floor(random() * 30), 10, 40);
      const d = 0.5 + 3 * random();
      const dilated = value(offsetLoops([p], d));
      const closed = value(offsetLoops(allLoops(dilated), -d));
      expectArcsPassGrbl(dilated);
      expectArcsPassGrbl(closed);
      expect(closed.length).toBeGreaterThan(0);
      const cLoops = allLoops(closed);
      const cPoly = polylines(cLoops);
      const pPoly = polylines([p]);
      // P inside C: every vertex of P is inside C or on its boundary. At a sharp convex tip the
      // chord error of the joins pushes the tip back by error / sin(half the tip angle).
      let sharpest = Math.PI / 2;
      p.segments.forEach((s, i) => {
        const v = s.start;
        const prev = p.segments[(i + p.segments.length - 1) % p.segments.length]!;
        const halfTip = Math.max((Math.PI - Math.abs(turnAngle(prev, s))) / 2, 0.01);
        sharpest = Math.min(sharpest, halfTip);
        const allowed = CHAIN_TOLERANCE / Math.sin(halfTip);
        expect(pointInLoops(v, cPoly) || distToLoops(v, cLoops) <= allowed).toBe(true);
      });
      // C's boundary is outside P (or on it), and within d of it.
      for (const q of samples(cLoops, 4)) {
        const dq = distToLoops(q, [p]);
        expect(!pointInLoops(q, pPoly) || dq <= CHAIN_TOLERANCE).toBe(true);
        expect(dq).toBeLessThanOrEqual(d + CHAIN_TOLERANCE);
      }
      // D E D = D, within the tolerance the sharpest tip allows.
      const again = value(offsetLoops(cLoops, d));
      expect(hausdorff(allLoops(again), allLoops(dilated), 4)).toBeLessThanOrEqual(
        CHAIN_TOLERANCE / Math.sin(sharpest),
      );
      checked++;
    }
    expect(checked).toBe(SEEDS);
  });

  it('returns a convex polygon unchanged', () => {
    for (let seed = 100; seed < 100 + SEEDS; seed++) {
      const random = rng(seed);
      const p = convexPolygon(random, 5 + Math.floor(random() * 20), 30, 15 + 20 * random());
      const d = 0.5 + 4 * random();
      for (const analytic of [true, false]) {
        const dilated = value(offsetLoops([p], d, { analytic }));
        const closed = value(offsetLoops(allLoops(dilated), -d, { analytic }));
        expect(closed).toHaveLength(1);
        expect(hausdorff(allLoops(closed), [p], 4)).toBeLessThanOrEqual(2 * REFIT_TOLERANCE);
      }
    }
  });

  it('holds for regions with holes and islands', () => {
    for (let seed = 200; seed < 200 + 10; seed++) {
      const random = rng(seed);
      const plate = [
        roundedRect(120, 80, 4 + 10 * random()),
        hole(circle([-40, 0], 3 + 10 * random())),
        hole(roundedRect(30, 30, 5)),
      ];
      const d = 0.5 + 2 * random();
      const dilated = value(offsetLoops(plate, d));
      const closed = value(offsetLoops(allLoops(dilated), -d));
      expectArcsPassGrbl(closed);
      // Nothing here has a concave corner or a narrow gap, so closing returns the plate.
      expect(hausdorff(allLoops(closed), plate, 4)).toBeLessThanOrEqual(2 * REFIT_TOLERANCE);
    }
  });
});
