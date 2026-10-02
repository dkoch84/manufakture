import { describe, expect, it } from 'vitest';
import { angleAbout, arcBounds, arcLength, arcSweep, normalizeAngle } from './arc';
import type { Arc3 } from './arc';
import type { Vec2, Vec3 } from './types';

const deg = (d: number) => (d * Math.PI) / 180;

/** An arc on the circle of radius `r` about `c` between two angles in degrees, at Z 0. */
function arc(
  fromDeg: number,
  toDeg: number,
  direction: 'cw' | 'ccw',
  c: Vec2 = [0, 0],
  r = 1,
  z: [number, number] = [0, 0],
  fullCircle = false,
): Arc3 {
  const at = (d: number, zz: number): Vec3 => [
    c[0] + r * Math.cos(deg(d)),
    c[1] + r * Math.sin(deg(d)),
    zz,
  ];
  return { start: at(fromDeg, z[0]), end: at(toDeg, z[1]), center: c, direction, fullCircle };
}

function expectBox(
  box: { min: Vec3; max: Vec3 },
  min: [number, number, number],
  max: [number, number, number],
): void {
  box.min.forEach((v, i) => expect(v, `min[${i}]`).toBeCloseTo(min[i]!, 12));
  box.max.forEach((v, i) => expect(v, `max[${i}]`).toBeCloseTo(max[i]!, 12));
}

describe('arcSweep', () => {
  it('measures in the arc direction', () => {
    expect(arcSweep(arc(0, 90, 'ccw'))).toBeCloseTo(Math.PI / 2, 12);
    expect(arcSweep(arc(0, 90, 'cw'))).toBeCloseTo((3 * Math.PI) / 2, 12);
    expect(arcSweep(arc(170, -170, 'ccw'))).toBeCloseTo(deg(20), 12);
    expect(arcSweep(arc(170, -170, 'cw'))).toBeCloseTo(deg(340), 12);
  });

  it('is 2 pi only for an explicit full circle, 0 for a degenerate arc', () => {
    expect(arcSweep(arc(30, 30, 'ccw', [0, 0], 1, [0, 0], true))).toBe(2 * Math.PI);
    expect(arcSweep(arc(30, 30, 'ccw'))).toBe(0);
  });

  it('normalizeAngle', () => {
    expect(normalizeAngle(-Math.PI / 2)).toBeCloseTo((3 * Math.PI) / 2, 12);
    expect(normalizeAngle(5 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(angleAbout([1, 1], [1, 2])).toBeCloseTo(Math.PI / 2, 12);
  });
});

describe('arcLength', () => {
  it('a planar quarter and a helical full turn', () => {
    expect(arcLength(arc(0, 90, 'ccw', [5, 5], 2))).toBeCloseTo(Math.PI, 12);
    const helix = arc(0, 0, 'cw', [0, 0], 2, [0, -1], true);
    expect(arcLength(helix)).toBeCloseTo(Math.hypot(4 * Math.PI, 1), 12);
  });
});

describe('arcBounds across quadrants', () => {
  it('a quarter in the first quadrant: end points only', () => {
    expectBox(arcBounds(arc(0, 90, 'ccw')), [0, 0, 0], [1, 1, 0]);
    expectBox(arcBounds(arc(90, 0, 'cw')), [0, 0, 0], [1, 1, 0]);
  });

  it('three quarters through quadrants II, III and IV', () => {
    expectBox(arcBounds(arc(90, 0, 'ccw')), [-1, -1, 0], [1, 1, 0]);
    expectBox(arcBounds(arc(0, 90, 'cw')), [-1, -1, 0], [1, 1, 0]);
  });

  it('crossing +Y between end points', () => {
    const c30 = Math.cos(deg(30));
    expectBox(arcBounds(arc(30, 150, 'ccw')), [-c30, 0.5, 0], [c30, 1, 0]);
  });

  it('crossing +X clockwise, and -X counter-clockwise', () => {
    const c30 = Math.cos(deg(30));
    expectBox(arcBounds(arc(30, -30, 'cw')), [c30, -0.5, 0], [1, 0.5, 0]);
    const c170 = Math.cos(deg(170));
    const s170 = Math.sin(deg(170));
    expectBox(arcBounds(arc(170, -170, 'ccw')), [-1, -s170, 0], [c170, s170, 0]);
  });

  it('crossing -Y, off the origin', () => {
    // Centre (10, -5), radius 3, from 200 to 340 degrees counter-clockwise: through 270.
    const b = arcBounds(arc(200, 340, 'ccw', [10, -5], 3));
    expectBox(
      b,
      [10 + 3 * Math.cos(deg(200)), -8, 0],
      [10 + 3 * Math.cos(deg(340)), -5 + 3 * Math.sin(deg(200)), 0],
    );
  });

  it('a helical full circle: the whole circle and both Z ends', () => {
    expectBox(arcBounds(arc(45, 45, 'cw', [2, 3], 4, [0, -2], true)), [-2, -1, -2], [6, 7, 0]);
  });

  it('a helical half turn: Z between its ends', () => {
    expectBox(arcBounds(arc(0, 180, 'ccw', [0, 0], 1, [-1, -3])), [-1, 0, -3], [1, 1, -1]);
  });

  it('contains every sampled point of random arcs, and is tight', () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let n = 0; n < 200; n++) {
      const a0 = rand() * 720 - 360;
      const a1 = rand() * 720 - 360;
      const dir = rand() < 0.5 ? 'ccw' : 'cw';
      const full = rand() < 0.1;
      const c: Vec2 = [rand() * 100 - 50, rand() * 100 - 50];
      const r = 0.1 + rand() * 20;
      const z: [number, number] = [rand() * 10, rand() * -10];
      const a = arc(a0, full ? a0 : a1, dir, c, r, z, full);
      const box = arcBounds(a);
      const sweep = arcSweep(a);
      const start = angleAbout(c, a.start);
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      const steps = 4000;
      let outside = 0;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const ang = start + (dir === 'ccw' ? 1 : -1) * sweep * t;
        const p = [c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang), z[0] + (z[1] - z[0]) * t];
        for (let k = 0; k < 3; k++) {
          if (p[k]! < box.min[k]! - 1e-9 || p[k]! > box.max[k]! + 1e-9) outside++;
          min[k] = Math.min(min[k]!, p[k]!);
          max[k] = Math.max(max[k]!, p[k]!);
        }
      }
      expect(outside, `arc ${n}: samples outside the bounds`).toBe(0);
      // Sampling every 1/4000 of the sweep gets within r * (1 - cos(pi / 4000)) of an extreme.
      const slack = r * (1 - Math.cos(Math.PI / steps)) + 1e-9;
      for (let k = 0; k < 3; k++) {
        expect(box.min[k]!).toBeGreaterThanOrEqual(min[k]! - slack);
        expect(box.max[k]!).toBeLessThanOrEqual(max[k]! + slack);
      }
    }
  });
});
