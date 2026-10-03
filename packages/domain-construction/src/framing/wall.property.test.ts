// Property tests on random walls (seeded, so a failure reproduces): no two members overlap, every
// member stays inside the wall's envelope, every stud bears fully on the bottom plate, splices in
// the top courses keep their offset unless a warning says otherwise, ids are unique and parse,
// and framing is deterministic.

import { describe, expect, it } from 'vitest';
import { memberFullId, parseOpeningMemberId, parseWallMemberId } from '../member-ids';
import type { Member } from '../members';
import { DOUBLE_2X8, S2X10, S2X4, S2X6, S2X8, extentIn, inch, seededRandom } from '../test-helpers';
import {
  frameWall,
  type BlockingRows,
  type CornerStyle,
  type FrameWallInput,
  type HeaderSpec,
  type Justification,
  type WallJoin,
  type WallOpening,
  type WallSegment,
} from './wall';

const TOL = 0.01; // mm

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

/** A random single-segment wall; sizes on a 1/8" grid so exact touches happen often. */
function randomWall(seed: number): FrameWallInput {
  const random = seededRandom(seed);
  const eighth = (lo: number, hi: number) => inch(Math.round((lo + random() * (hi - lo)) * 8) / 8);
  const stud = pick(random, [S2X4, S2X6]);
  const T = stud.depth;
  const L = eighth(30, 480);
  const height = pick(random, [inch(97.125), inch(109.125), eighth(80, 130)]);
  const angle = random() * 2 * Math.PI;
  const start: [number, number] = [eighth(-500, 500), eighth(-500, 500)];
  const end: [number, number] = [start[0] + L * Math.cos(angle), start[1] + L * Math.sin(angle)];
  const join = (): WallJoin => {
    const k = random();
    const other = pick(random, [inch(3.5), inch(5.5)]);
    if (k < 0.4) return { kind: 'free' };
    if (k < 0.7) return { kind: 'L', through: true, otherThickness: other };
    if (k < 0.85) return { kind: 'L', through: false, otherThickness: other };
    return { kind: 'T', otherThickness: other };
  };
  const headers: HeaderSpec[] = [
    DOUBLE_2X8,
    { stock: S2X10, plies: 2, jacks: 2 },
    { stock: S2X6, plies: 1, jacks: 1 },
    // A 2x6 wall's header: three plies with a spacer only when they fit.
    stud === S2X6 ? { stock: S2X8, plies: 3, jacks: 1 } : { stock: S2X8, plies: 2, jacks: 1 },
  ];
  const openings: WallOpening[] = [];
  const nOpen = Math.floor(random() * 4);
  for (let i = 0; i < nOpen; i++) {
    const door = random() < 0.4;
    const o: WallOpening = {
      id: `extension#${10 + i}`,
      position: eighth(0, L / inch(1)),
      width: eighth(18, 72),
      height: door ? eighth(70, 90) : eighth(12, 60),
      sill: door ? 0 : eighth(0.5, 50),
      ...(random() < 0.5 ? { header: pick(random, headers) } : {}),
      ...(random() < 0.3 ? { kings: 2 } : {}),
    };
    openings.push(o);
  }
  const tees = Array.from({ length: Math.floor(random() * 3) }, () => ({
    at: eighth(0, L / inch(1)),
    otherThickness: pick(random, [inch(3.5), inch(5.5)]),
  }));
  const blocking: BlockingRows = pick(random, [
    { kind: 'none' },
    { kind: 'mid-height' },
    { kind: 'heights', heights: [eighth(10, 120), eighth(10, 120)] },
  ] as const);
  const segment: WallSegment = {
    start,
    end,
    base: eighth(-50, 200),
    height,
    thickness: T,
    justification: pick<Justification>(random, ['left', 'center', 'right']),
    joins: { start: join(), end: join() },
    openings,
    tees,
  };
  return {
    wall: 'extension#1',
    segments: [segment],
    settings: {
      studStock: stud,
      defaultHeader: pick(random, headers),
      spacing: pick(random, [inch(12), inch(16), inch(19.2), inch(24)]),
      layoutOrigin: pick(random, [0, 0, inch(-3.5), eighth(-20, 20)]),
      layoutFrom: pick(random, ['start', 'end'] as const),
      bottomPlates: pick(random, [1, 1, 2]),
      topPlates: pick(random, [1, 2, 2, 3]),
      cornerStyle: pick<CornerStyle>(random, ['two-stud', 'three-stud', 'ladder']),
      blocking,
      plateStockLengths: pick(random, [[inch(96), inch(144), inch(192)], [inch(120)], [inch(240)]]),
      headerRules:
        random() < 0.5
          ? []
          : [{ maxWidth: inch(40), header: { stock: S2X6, plies: 2, spacer: S2X4, jacks: 1 } }],
    },
  };
}

const SEEDS = Array.from({ length: 400 }, (_, i) => i + 1);

function overlapVolume(a: ReturnType<typeof extentIn>, b: ReturnType<typeof extentIn>): boolean {
  return (['s', 't', 'z'] as const).every(
    (k) => Math.min(a[k][1], b[k][1]) - Math.max(a[k][0], b[k][0]) > TOL,
  );
}

describe('frameWall properties', () => {
  it('never puts two members in the same space', () => {
    for (const seed of SEEDS) {
      const input = randomWall(seed);
      const seg = input.segments[0]!;
      const { members } = frameWall(input);
      const boxes = members.map((m) => [m, extentIn(seg, m)] as const);
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++)
          if (overlapVolume(boxes[i]![1], boxes[j]![1]))
            expect.fail(
              `seed ${seed}: ${memberFullId(boxes[i]![0])} overlaps ${memberFullId(boxes[j]![0])}`,
            );
    }
  });

  it('keeps every member inside the wall envelope (cap plates lapping over the walls they meet)', () => {
    for (const seed of SEEDS) {
      const input = randomWall(seed);
      const seg = input.segments[0]!;
      const L = Math.hypot(seg.end[0] - seg.start[0], seg.end[1] - seg.start[1]);
      const lap = (j: WallJoin | undefined) =>
        j && j.kind !== 'free' && !(j.kind === 'L' && j.through) ? j.otherThickness : 0;
      const T = seg.thickness;
      const t0 = seg.justification === 'left' ? 0 : seg.justification === 'right' ? -T : -T / 2;
      for (const m of frameWall(input).members) {
        const e = extentIn(seg, m);
        const capLap = m.role === 'top-plate';
        const lo = capLap ? -lap(seg.joins?.start) : 0;
        const hi = L + (capLap ? lap(seg.joins?.end) : 0);
        const where = `seed ${seed}: ${memberFullId(m)}`;
        expect(e.s[0], where).toBeGreaterThanOrEqual(lo - TOL);
        expect(e.s[1], where).toBeLessThanOrEqual(hi + TOL);
        expect(e.t[0], where).toBeGreaterThanOrEqual(t0 - TOL);
        expect(e.t[1], where).toBeLessThanOrEqual(t0 + T + TOL);
        expect(e.z[0], where).toBeGreaterThanOrEqual(-TOL);
        // Precut snapping may move the top by up to 0.5 mm.
        expect(e.z[1], where).toBeLessThanOrEqual(seg.height + 0.5 + TOL);
      }
    }
  });

  it('gives every stud full bearing on the bottom plate', () => {
    const standing = new Set(['stud', 'king', 'jack', 'corner', 'cripple']);
    for (const seed of SEEDS) {
      const input = randomWall(seed);
      const seg = input.segments[0]!;
      const course = input.settings.bottomPlates ?? 1;
      const zbot = course * input.settings.studStock.width;
      const members = frameWall(input).members;
      const plates = members
        .filter((m) => m.role === 'bottom-plate' && m.id.startsWith(`bottom${course}:`))
        .map((m) => extentIn(seg, m));
      for (const m of members) {
        if (!standing.has(m.role)) continue;
        const e = extentIn(seg, m);
        if (Math.abs(e.z[0] - zbot) > TOL) continue; // cripples above a header
        // Covered end to end by the top bottom course (a stud may stand across a splice).
        let reach = e.s[0];
        for (const p of plates
          .filter((q) => Math.abs(q.z[1] - zbot) < TOL)
          .sort((a, b) => a.s[0] - b.s[0]))
          if (p.s[0] <= reach + TOL && p.s[1] > reach) reach = p.s[1];
        const bears = reach >= e.s[1] - TOL;
        expect(bears, `seed ${seed}: ${memberFullId(m)}`).toBe(true);
      }
    }
  });

  it('keeps top plate splices apart unless it says it could not', () => {
    for (const seed of SEEDS) {
      const input = randomWall(seed);
      const seg = input.segments[0]!;
      const r = frameWall(input);
      if (r.warnings.some((w) => w.code === 'splice-offset')) continue;
      const offset = inch(24);
      const splicesOf = (course: number) => {
        const pieces = r.members
          .filter((m) => m.id.startsWith(`top${course}:`))
          .map((m) => extentIn(seg, m).s)
          .sort((a, b) => a[0] - b[0]);
        const out: number[] = [];
        for (let i = 0; i + 1 < pieces.length; i++)
          if (Math.abs(pieces[i]![1] - pieces[i + 1]![0]) < TOL) out.push(pieces[i]![1]);
        return out;
      };
      const courses = input.settings.topPlates ?? 2;
      for (let a = 1; a <= courses; a++)
        for (let b = a + 1; b <= courses; b++)
          for (const p of splicesOf(a))
            for (const q of splicesOf(b))
              expect(
                Math.abs(p - q),
                `seed ${seed}: top${a} at ${p}, top${b} at ${q}`,
              ).toBeGreaterThanOrEqual(offset - TOL);
      for (const m of r.members)
        if (m.role.endsWith('plate'))
          expect(m.length).toBeLessThanOrEqual(
            Math.max(...input.settings.plateStockLengths!) + TOL,
          );
    }
  });

  it('gives unique ids that parse, and is deterministic', () => {
    for (const seed of SEEDS) {
      const input = randomWall(seed);
      const a = frameWall(input);
      const ids = a.members.map((m: Member) => memberFullId(m));
      expect(new Set(ids).size, `seed ${seed}`).toBe(ids.length);
      const openings = new Set((input.segments[0]!.openings ?? []).map((o) => o.id));
      for (const m of a.members) {
        const where = `seed ${seed}: ${memberFullId(m)}`;
        if (m.owner === input.wall) expect(parseWallMemberId(m.id), where).toBeDefined();
        else {
          expect(openings.has(m.owner), where).toBe(true);
          expect(parseOpeningMemberId(m.id), where).toBeDefined();
        }
      }
      expect(frameWall(input)).toEqual(a);
    }
  });

  it('reports every opening once, with the header it used', () => {
    for (const seed of SEEDS) {
      const input = randomWall(seed);
      const r = frameWall(input);
      const openings = input.segments[0]!.openings ?? [];
      expect(r.openings.map((o) => o.id).sort()).toEqual(openings.map((o) => o.id).sort());
      for (const o of r.openings) {
        const framed = r.members.some((m) => m.owner === o.id && m.id === 'header');
        expect(framed, `seed ${seed}: ${o.id}`).toBe(o.framed);
      }
    }
  });
});
