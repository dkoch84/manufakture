import { describe, expect, it } from 'vitest';
import { grblArcPrecheck } from '../offset/grbl';
import { seededRandom } from '../test-helpers';
import type { Vec3 } from '../types';
import { distToSegment3, fitPolyline, type FitElement } from './fit';

/** The largest distance from any point to the fitted path (each point against every element). */
function deviation(points: readonly Vec3[], fit: readonly FitElement[]): number {
  // Sample every element densely, then measure each input point against the nearest sample chord.
  const path: Vec3[] = [points[0]!];
  let from = points[0]!;
  for (const e of fit) {
    if (e.kind === 'line') {
      path.push(e.to);
    } else {
      const [cx, cy] = e.center;
      const a0 = Math.atan2(from[1] - cy, from[0] - cx);
      const a1 = Math.atan2(e.to[1] - cy, e.to[0] - cx);
      let sweep = a1 - a0;
      if (e.ccw && sweep <= 0) sweep += 2 * Math.PI;
      if (!e.ccw && sweep >= 0) sweep -= 2 * Math.PI;
      const r = Math.hypot(from[0] - cx, from[1] - cy);
      for (let k = 1; k <= 400; k++) {
        const a = a0 + (sweep * k) / 400;
        path.push([
          cx + r * Math.cos(a),
          cy + r * Math.sin(a),
          from[2] + ((e.to[2] - from[2]) * k) / 400,
        ]);
      }
    }
    from = e.to;
  }
  let worst = 0;
  for (const p of points) {
    let best = Infinity;
    for (let k = 0; k + 1 < path.length; k++) {
      best = Math.min(best, distToSegment3(p, path[k]!, path[k + 1]!));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

describe('fitPolyline', () => {
  it('turns collinear points into one line', () => {
    const pts: Vec3[] = Array.from({ length: 50 }, (_, k) => [k * 0.1, 2, -1 - k * 0.05]);
    expect(fitPolyline(pts, 0.001)).toEqual([{ kind: 'line', to: pts[49] }]);
  });

  it('keeps a raster profile within the tolerance with far fewer lines', () => {
    // A raster line over a bump: z = 3 cos(x / 4) on [0, 20], sampled every 0.05 mm.
    const pts: Vec3[] = Array.from({ length: 401 }, (_, k) => {
      const x = k * 0.05;
      return [x, 5, 3 * Math.cos(x / 4)];
    });
    for (const tol of [0.001, 0.005, 0.02]) {
      const fit = fitPolyline(pts, tol);
      expect(fit.every((e) => e.kind === 'line')).toBe(true);
      expect(fit.length).toBeLessThan(pts.length / 4);
      expect(deviation(pts, fit)).toBeLessThanOrEqual(tol + 1e-12);
      expect(fit[fit.length - 1]!.to).toEqual(pts[400]);
    }
  });

  it('fits arcs to a circle at one height, in both directions', () => {
    for (const ccw of [true, false]) {
      const pts: Vec3[] = Array.from({ length: 181 }, (_, k) => {
        const a = ((ccw ? 1 : -1) * (k * Math.PI)) / 180;
        return [10 + 7 * Math.cos(a), -3 + 7 * Math.sin(a), -2];
      });
      const fit = fitPolyline(pts, 0.002);
      expect(fit.length).toBeLessThanOrEqual(2);
      expect(fit.every((e) => e.kind === 'arc' && e.ccw === ccw)).toBe(true);
      for (const e of fit) {
        if (e.kind !== 'arc') continue;
        expect(e.center[0]).toBeCloseTo(10, 6);
        expect(e.center[1]).toBeCloseTo(-3, 6);
      }
      expect(deviation(pts, fit)).toBeLessThanOrEqual(0.002);
    }
  });

  it('fits helices, Z linear in the angle', () => {
    const pts: Vec3[] = Array.from({ length: 91 }, (_, k) => {
      const a = (k * Math.PI) / 180;
      return [5 * Math.cos(a), 5 * Math.sin(a), -0.01 * k];
    });
    const fit = fitPolyline(pts, 0.002);
    expect(fit).toHaveLength(1);
    expect(fit[0]!.kind).toBe('arc');
    expect(fit[0]!.to[2]).toBeCloseTo(-0.9, 12);
  });

  it('never fits an arc Grbl would cut wrong, nor beyond half a turn', () => {
    const pts: Vec3[] = Array.from({ length: 361 }, (_, k) => {
      const a = (k * Math.PI) / 180;
      return [20 * Math.cos(a), 20 * Math.sin(a), 0];
    });
    const fit = fitPolyline(pts, 0.002);
    let from = pts[0]!;
    for (const e of fit) {
      if (e.kind === 'arc') {
        const check = grblArcPrecheck({
          kind: 'arc',
          start: [from[0], from[1]],
          end: [e.to[0], e.to[1]],
          center: e.center,
          ccw: e.ccw,
        });
        expect(check.ok).toBe(true);
        expect(Math.abs(check.sweep)).toBeLessThanOrEqual(Math.PI + 1e-9);
      }
      from = e.to;
    }
    expect(fit.length).toBeGreaterThanOrEqual(2);
  });

  it('stays within the tolerance on random walks', () => {
    const rand = seededRandom(5);
    for (let trial = 0; trial < 30; trial++) {
      const pts: Vec3[] = [[0, 0, 0]];
      let heading = rand() * 6;
      for (let k = 0; k < 200; k++) {
        heading += (rand() - 0.5) * 0.3;
        const p = pts[pts.length - 1]!;
        pts.push([
          p[0] + 0.1 * Math.cos(heading),
          p[1] + 0.1 * Math.sin(heading),
          p[2] + (rand() - 0.5) * 0.02,
        ]);
      }
      const tol = 0.005;
      const fit = fitPolyline(pts, tol);
      expect(deviation(pts, fit)).toBeLessThanOrEqual(tol + 1e-9);
      expect(fit[fit.length - 1]!.to).toEqual(pts[pts.length - 1]);
    }
  });

  it('gives nothing for fewer than two points', () => {
    expect(fitPolyline([], 0.01)).toEqual([]);
    expect(fitPolyline([[1, 2, 3]], 0.01)).toEqual([]);
  });
});
