// IR to line geometry: arcs tessellated within the tolerance (helices and partial arcs too),
// buffers per operation and move class with the expected sizes, the time line, and the playback
// lookups (the tool at a move's end, the segments drawn before it).

import type { ArcMove, Toolpath, Vec3 } from '@manufakture/cam';
import { describe, expect, it } from 'vitest';
import {
  PREVIEW_ARC_TOLERANCE,
  arcSegmentCount,
  minutesAt,
  movesDoneAt,
  previewGeometry,
  segmentsBefore,
  tessellateArc,
  toolPositionAt,
} from './geometry';
import { circle, rectangle } from './preview.test-fixture';

/** The largest distance from a chord's middle to the arc (the chord's worst point). */
function maxChordError(from: Vec3, points: Vec3[], center: readonly [number, number], r: number) {
  let worst = 0;
  let prev = from;
  for (const p of points) {
    const mx = (prev[0] + p[0]) / 2 - center[0];
    const my = (prev[1] + p[1]) / 2 - center[1];
    worst = Math.max(worst, Math.abs(r - Math.hypot(mx, my)));
    prev = p;
  }
  return worst;
}

const arc = (
  to: Vec3,
  center: [number, number],
  direction: 'cw' | 'ccw',
  full = false,
): ArcMove => ({
  kind: 'arc',
  op: 'a',
  pass: 0,
  to,
  center,
  direction,
  fullCircle: full,
  feed: 1000,
  feedClass: 'cut',
});

describe('arc tessellation', () => {
  it.each([
    [0.5, 0.01],
    [3, 0.01],
    [25, 0.01],
    [400, 0.002],
    [10, 0.1],
  ])('keeps every chord of a radius %d arc within %d mm', (r, tolerance) => {
    for (const [direction, full, to] of [
      ['ccw', true, [r, 0, 0]],
      ['cw', false, [0, r, 0]],
      ['ccw', false, [-r, 0, 0]],
    ] as const) {
      const from: Vec3 = [r, 0, 0];
      const points = tessellateArc(from, arc(to as Vec3, [0, 0], direction, full), tolerance);
      expect(maxChordError(from, points, [0, 0], r)).toBeLessThanOrEqual(tolerance + 1e-12);
      // Every vertex lies on the arc and the last is the move's end, exactly.
      for (const p of points) expect(Math.hypot(p[0], p[1])).toBeCloseTo(r, 9);
      expect(points.at(-1)).toEqual(to);
    }
  });

  it('runs the right way round', () => {
    const ccw = tessellateArc([5, 0, 0], arc([0, 5, 0], [0, 0], 'ccw'), 0.01);
    const cw = tessellateArc([5, 0, 0], arc([0, 5, 0], [0, 0], 'cw'), 0.01);
    // A quarter counter-clockwise stays in the first quadrant; clockwise goes round the other three.
    expect(ccw.every((p) => p[0] >= -1e-9 && p[1] >= -1e-9)).toBe(true);
    expect(cw.some((p) => p[1] < -4)).toBe(true);
    expect(cw.length).toBeGreaterThan(ccw.length * 2);
  });

  it('lowers Z linearly with the angle on a helix', () => {
    const from: Vec3 = [5, 0, 1];
    const points = tessellateArc(from, arc([5, 0, -1], [0, 0], 'ccw', true), 0.01);
    const n = points.length;
    points.forEach((p, k) => expect(p[2]).toBeCloseTo(1 - (2 * (k + 1)) / n, 9));
  });

  it('uses the fewest chords the tolerance allows, within bounds', () => {
    // r (1 - cos(t / 2)) <= tol gives t <= 2 acos(1 - tol / r).
    const step = 2 * Math.acos(1 - 0.01 / 5);
    expect(arcSegmentCount(5, Math.PI, 0.01)).toBe(Math.ceil(Math.PI / step));
    // A tiny radius still gets a few chords (at most pi/8 each), never zero.
    expect(arcSegmentCount(0.001, 2 * Math.PI, 0.01)).toBe(16);
    expect(arcSegmentCount(1e9, 2 * Math.PI, 1e-6)).toBe(4096);
  });
});

describe('previewGeometry', () => {
  const both: Toolpath = {
    start: rectangle.start,
    entries: [
      { kind: 'toolChange', tool: 'tool#1', name: '6 mm flat' },
      ...rectangle.entries,
      { kind: 'rapid', op: 'link', pass: 0, to: circle.start },
      { kind: 'toolChange', tool: 'tool#2', name: 'V-bit' },
      { kind: 'dwell', seconds: 6 },
      ...circle.entries,
    ],
  };
  const path = previewGeometry(both, { rapidRate: 5000 });

  it('makes one buffer per operation and move class, two points per segment', () => {
    const turn = arcSegmentCount(5, 2 * Math.PI, PREVIEW_ARC_TOLERANCE);
    const sizes = Object.fromEntries(
      path.buffers.map((b) => [`${b.op}/${b.moveClass}`, b.positions.length / 6]),
    );
    expect(sizes).toEqual({
      'profile#1/rapid': 2,
      'profile#1/plunge': 1,
      'profile#1/cut': 4,
      'link/rapid': 1,
      'pocket#1/rapid': 2,
      'pocket#1/ramp': turn,
      'pocket#1/cut': turn,
    });
    for (const b of path.buffers) {
      expect(b.moves.length * 6).toBe(b.positions.length);
      expect(b.lineDistances?.length ?? 0).toBe(b.moveClass === 'rapid' ? b.moves.length * 2 : 0);
    }
    expect(path.moveCount).toBe(12);
    expect(path.ends.length).toBe(36);
  });

  it('dashes rapids from each segment start', () => {
    const link = path.buffers.find((b) => b.op === 'link')!;
    expect([...link.lineDistances!]).toEqual([0, Math.fround(Math.hypot(25, 10, 0))]);
  });

  it('numbers moves in program order, whatever their passes', () => {
    const shuffled: Toolpath = {
      start: [0, 0, 5],
      entries: [3, 1, 2].map((pass, i) => ({
        kind: 'rapid' as const,
        op: 'drill#1',
        pass,
        to: [i, 0, 5] as Vec3,
      })),
    };
    const p = previewGeometry(shuffled, { rapidRate: 1000 });
    expect([...p.buffers[0]!.moves]).toEqual([0, 1, 2]);
    expect(toolPositionAt(p, 2)).toEqual([1, 0, 5]);
  });

  it('keeps the tool loaded for each move', () => {
    expect([...path.toolOf]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
    expect(path.tools).toEqual(['tool#1', 'tool#2']);
  });

  it('times moves at their feed and rapids at the rapid rate, dwells included', () => {
    // Rectangle: 3 mm rapid, 4 mm plunge at 300, 120 mm at 1000, 7 mm rapid.
    expect(minutesAt(path, 1)).toBeCloseTo(3 / 5000, 12);
    expect(minutesAt(path, 2)).toBeCloseTo(3 / 5000 + 4 / 300, 12);
    expect(minutesAt(path, 7)).toBeCloseTo(10 / 5000 + 4 / 300 + 120 / 1000, 12);
    // The link rapid, then the dwell before the circle's first move.
    const link = Math.hypot(25, 10, 0) / 5000;
    expect(minutesAt(path, 9) - minutesAt(path, 7)).toBeCloseTo(link + 0.1 + 4 / 5000, 12);
    expect(movesDoneAt(path, minutesAt(path, 2))).toBe(2);
    expect(movesDoneAt(path, minutesAt(path, 2) - 1e-9)).toBe(1);
  });

  it('puts the tool at the end of the move scrubbed to', () => {
    expect(toolPositionAt(path, 0)).toEqual(rectangle.start);
    expect(toolPositionAt(path, 3)).toEqual([50, 10, -2]);
    expect(toolPositionAt(path, 10)).toEqual([35, 20, -1]);
    expect(toolPositionAt(path, 99)).toEqual([35, 20, 5]);
  });

  it('draws only the segments of the moves done', () => {
    const cut = path.buffers.find((b) => b.op === 'profile#1' && b.moveClass === 'cut')!;
    expect([0, 2, 3, 4, 6, 12].map((d) => segmentsBefore(cut, d))).toEqual([0, 0, 1, 2, 4, 4]);
    const ramp = path.buffers.find((b) => b.moveClass === 'ramp')!;
    expect(segmentsBefore(ramp, 9)).toBe(0);
    expect(segmentsBefore(ramp, 10)).toBe(ramp.moves.length);
  });

  it('bounds every point drawn', () => {
    expect(path.bounds).toEqual({ min: [10, 10, -2], max: [50, 30, 5] });
  });

  it('handles a program with no moves', () => {
    const p = previewGeometry({ start: [1, 2, 3], entries: [] }, { rapidRate: 1000 });
    expect(p.moveCount).toBe(0);
    expect(p.buffers).toEqual([]);
    expect(toolPositionAt(p, 0)).toEqual([1, 2, 3]);
  });
});
