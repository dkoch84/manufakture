import type { MemberData } from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import { cornerRange, memberOutline, memberSection, type Segment3 } from './outline';

/** A 38 x 89 stud 100 long, standing up (local x up, y along world x, z = x cross y = world y). */
function stud(cuts: MemberData['cuts'] = []): MemberData {
  return {
    id: 's1',
    owner: 'extension#1',
    role: 'stud',
    stock: { id: 'us-2x4', name: '2x4', width: 38, depth: 89 },
    length: 100,
    placement: { origin: [10, 0, 0], x: [0, 0, 1], y: [1, 0, 0] },
    cuts,
  };
}

const length = ([a, b]: Segment3) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
const perimeter = (s: readonly Segment3[]) => s.reduce((sum, x) => sum + length(x), 0);
const FRONT = [0, 1, 0] as const;

describe('member outlines', () => {
  it('outlines the side that faces the viewer: a stud seen along the wall normal', () => {
    const s = memberOutline(stud(), FRONT);
    expect(s).toHaveLength(4);
    expect(perimeter(s)).toBeCloseTo(2 * (100 + 38), 9);
    // The near side (world y = 0), across x from 10 to 48 and up to 100.
    for (const [a, b] of s) for (const p of [a, b]) expect(p[1]).toBeCloseTo(0, 9);
    const xs = s.flatMap(([a, b]) => [a[0], b[0]]);
    const zs = s.flatMap(([a, b]) => [a[2], b[2]]);
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([10, 48]);
    expect([Math.min(...zs), Math.max(...zs)]).toEqual([0, 100]);
    // From the other side, the far face.
    const back = memberOutline(stud(), [0, -1, 0]);
    for (const [a] of back) expect(a[1]).toBeCloseTo(89, 9);
  });

  it('cuts a corner off with a plane cut (five sides)', () => {
    const n = [Math.SQRT1_2, Math.SQRT1_2, 0] as const;
    // Removes a + b >= 120: the top 20 of the far edge, the corner at (100, 38) clipped.
    const s = memberOutline(stud([{ kind: 'plane', n, k: 120 * Math.SQRT1_2 }]), FRONT);
    expect(s).toHaveLength(5);
    const cutEdge = s.find(
      ([a, b]) => Math.abs(a[0] - b[0]) > 1e-9 && Math.abs(a[2] - b[2]) > 1e-9,
    );
    expect(cutEdge).toBeDefined();
    expect(length(cutEdge!)).toBeCloseTo(18 * Math.SQRT2, 9);
  });

  it('draws a notch (a birdsmouth) as its two sides, the outline an L', () => {
    // Removed where a >= 60 and b >= 20.
    const s = memberOutline(
      stud([{ kind: 'notch', a: { n: [1, 0, 0], k: 60 }, b: { n: [0, 1, 0], k: 20 } }]),
      FRONT,
    );
    expect(s).toHaveLength(6);
    expect(perimeter(s)).toBeCloseTo(2 * (100 + 38), 9);
  });

  it('ignores a cut parallel to the side seen (the silhouette is the same)', () => {
    const s = memberOutline(stud([{ kind: 'plane', n: [0, 0, -1], k: -10 }]), FRONT);
    expect(perimeter(s)).toBeCloseTo(2 * (100 + 38), 9);
  });

  it('sections a member by a plane, and misses one the plane does not reach', () => {
    const s = memberSection(stud(), [0, 0, 1], 50);
    expect(s).toHaveLength(4);
    expect(perimeter(s)).toBeCloseTo(2 * (38 + 89), 9);
    for (const [a, b] of s) expect([a[2], b[2]]).toEqual([50, 50]);
    expect(memberSection(stud(), [0, 0, 1], 150)).toEqual([]);
    expect(memberSection(stud(), [0, 0, 1], -1)).toEqual([]);
    // Cut away above 40: the section at 50 is gone.
    expect(memberSection(stud([{ kind: 'plane', n: [1, 0, 0], k: 40 }]), [0, 0, 1], 50)).toEqual(
      [],
    );
  });

  it('gives the range of a member along an axis', () => {
    expect(cornerRange(stud(), [1, 0, 0])).toEqual([10, 48]);
    expect(cornerRange(stud(), [0, 0, 1])).toEqual([0, 100]);
  });
});
