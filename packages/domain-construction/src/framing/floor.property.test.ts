// Property tests on random floors (seeded, so a failure reproduces): rectangles and L, T and U
// outlines at any rotation. No two members overlap, every member but the skids stays inside the
// outline, every joist end bears fully on a rim, every block spans between two joists, ids are
// unique and parse, and framing is deterministic.

import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../geom';
import { memberFullId } from '../member-ids';
import { memberCorners, type Member } from '../members';
import { S2X10, S2X6, S2X8, inch, seededRandom } from '../test-helpers';
import { frameFloor, parseFloorMemberId, type FloorBlocking, type FrameFloorInput } from './floor';

const TOL = 0.01; // mm

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

/** A random outline in its own frame (x along the joists or across them), in inches. */
function randomShape(random: () => number): Array<[number, number]> {
  const r = (lo: number, hi: number) => Math.round((lo + random() * (hi - lo)) * 8) / 8;
  const W = r(48, 300);
  const H = r(48, 300);
  const a = r(12, W / 2 - 4);
  const b = r(12, H / 2 - 4);
  switch (pick(random, ['rect', 'L', 'T', 'U'] as const)) {
    case 'rect':
      return [
        [0, 0],
        [W, 0],
        [W, H],
        [0, H],
      ];
    case 'L':
      return [
        [0, 0],
        [W, 0],
        [W, b],
        [a, b],
        [a, H],
        [0, H],
      ];
    case 'T':
      return [
        [a, 0],
        [W - a, 0],
        [W - a, b],
        [W, b],
        [W, H],
        [0, H],
        [0, b],
        [a, b],
      ];
    case 'U':
      return [
        [0, 0],
        [W, 0],
        [W, H],
        [W - a, H],
        [W - a, b],
        [a, b],
        [a, H],
        [0, H],
      ];
  }
}

interface Case {
  input: FrameFloorInput;
  /** Joist direction and layout axis, unit vectors in plan. */
  U: Vec2;
  V: Vec2;
  /** The outline in (u, v). */
  poly: Array<[number, number]>;
}

function randomFloor(seed: number): Case {
  const random = seededRandom(seed);
  const shape = randomShape(random);
  const angle = random() * 2 * Math.PI;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const off: [number, number] = [inch(random() * 400 - 200), inch(random() * 400 - 200)];
  const toPlan = ([x, y]: [number, number]): Vec2 => [
    off[0] + inch(x) * c - inch(y) * s,
    off[1] + inch(x) * s + inch(y) * c,
  ];
  const outline = shape.map(toPlan);
  const alongX = random() < 0.5;
  const U: Vec2 = alongX ? [c, s] : [-s, c];
  const V: Vec2 = [-U[1], U[0]];
  const joist = pick(random, [S2X6, S2X8, S2X10]);
  const W = Math.max(...shape.map((p) => p[0]));
  const H = Math.max(...shape.map((p) => p[1]));
  const walls = Array.from({ length: Math.floor(random() * 3) }, (_, i) => {
    const t = random();
    const along = random() < 0.7;
    const [p, q]: [[number, number], [number, number]] =
      along === alongX
        ? [
            [0, t * H],
            [W, t * H],
          ]
        : [
            [t * W, 0],
            [t * W, H],
          ];
    return { id: `extension#${20 + i}`, start: toPlan(p), end: toPlan(q) };
  });
  const blocking: FloorBlocking = pick(random, [
    { kind: 'none' },
    { kind: 'mid-span' },
    { kind: 'at', positions: [inch(random() * 200), inch(random() * 200)] },
  ] as const);
  const input: FrameFloorInput = {
    floor: 'extension#9',
    outline: random() < 0.5 ? outline : [...outline].reverse(),
    direction: [U[0] * 3, U[1] * 3],
    elevation: inch(random() * 50),
    walls,
    settings: {
      joistStock: joist,
      ...(random() < 0.3 ? { rimStock: pick(random, [S2X6, S2X8, S2X10]) } : {}),
      spacing: pick(random, [inch(12), inch(16), inch(19.2), inch(24)]),
      layoutOrigin: pick(random, [0, 0, inch(-3.5), inch(random() * 40 - 20)]),
      layoutFrom: pick(random, ['start', 'end'] as const),
      blocking,
      stockLengths: pick(random, [[inch(96), inch(144), inch(192)], [inch(240)]]),
      ...(random() < 0.5
        ? {
            skids: {
              stock: { id: 'us-4x6', name: '4x6', width: inch(3.5), depth: inch(5.5) },
              count: 1 + Math.floor(random() * 4),
              overhang: inch(random() * 12),
            },
          }
        : {}),
    },
  };
  const toUV = (p: Vec2): [number, number] => [
    p[0] * U[0] + p[1] * U[1],
    p[0] * V[0] + p[1] * V[1],
  ];
  return { input, U, V, poly: outline.map(toUV) };
}

interface Box {
  u: [number, number];
  v: [number, number];
  z: [number, number];
}

function boxOf(m: Member, U: Vec2, V: Vec2): Box {
  const b: Box = { u: [Infinity, -Infinity], v: [Infinity, -Infinity], z: [Infinity, -Infinity] };
  for (const p of memberCorners(m)) {
    const q = { u: p[0] * U[0] + p[1] * U[1], v: p[0] * V[0] + p[1] * V[1], z: p[2] };
    for (const k of ['u', 'v', 'z'] as const) {
      b[k][0] = Math.min(b[k][0], q[k]);
      b[k][1] = Math.max(b[k][1], q[k]);
    }
  }
  return b;
}

function inside(poly: ReadonlyArray<[number, number]>, u: number, v: number): boolean {
  let n = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ui, vi] = poly[i]!;
    const [uj, vj] = poly[j]!;
    if (vi > v !== vj > v && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui) n = !n;
  }
  return n;
}

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);
const ov = (a: [number, number], b: [number, number]) =>
  Math.min(a[1], b[1]) - Math.max(a[0], b[0]);

describe('frameFloor properties', () => {
  it('never puts two members in the same space', () => {
    for (const seed of SEEDS) {
      const { input, U, V } = randomFloor(seed);
      const ms = frameFloor(input).members;
      const boxes = ms.map((m) => boxOf(m, U, V));
      for (let i = 0; i < ms.length; i++)
        for (let j = i + 1; j < ms.length; j++)
          if ((['u', 'v', 'z'] as const).every((k) => ov(boxes[i]![k], boxes[j]![k]) > TOL))
            expect.fail(`seed ${seed}: ${memberFullId(ms[i]!)} overlaps ${memberFullId(ms[j]!)}`);
    }
  });

  it('keeps every member but the skids inside the outline, and the skids under it', () => {
    for (const seed of SEEDS) {
      const { input, U, V, poly } = randomFloor(seed);
      const r = frameFloor(input);
      const base = input.elevation ?? 0;
      for (const m of r.members) {
        const b = boxOf(m, U, V);
        const where = `seed ${seed}: ${memberFullId(m)}`;
        if (m.role === 'skid') {
          expect(b.z[1], where).toBeCloseTo(base, 6);
          continue;
        }
        expect(b.z[0], where).toBeGreaterThanOrEqual(base - TOL);
        expect(b.z[1], where).toBeLessThanOrEqual(r.top + TOL);
        // A grid of points just inside the member's plan box.
        for (let i = 0; i <= 4; i++)
          for (let j = 0; j <= 4; j++) {
            const u = b.u[0] + TOL + ((b.u[1] - b.u[0] - 2 * TOL) * i) / 4;
            const v = b.v[0] + TOL + ((b.v[1] - b.v[0] - 2 * TOL) * j) / 4;
            if (!inside(poly, u, v)) expect.fail(`${where} leaves the outline at (${u}, ${v})`);
          }
      }
    }
  });

  it('gives every joist end full bearing on a rim, and every block a joist each side', () => {
    for (const seed of SEEDS) {
      const { input, U, V } = randomFloor(seed);
      const r = frameFloor(input);
      const boxes = r.members.map((m) => ({ m, b: boxOf(m, U, V) }));
      const rims = boxes.filter((x) => x.m.role === 'rim');
      const joists = boxes.filter((x) => x.m.role === 'joist');
      // Rims may be spliced: a joist end bears on the union of the rim pieces at its face.
      const bears = (u: number, v: [number, number]) => {
        const at = rims
          .filter((x) => Math.abs(x.b.u[0] - u) < TOL || Math.abs(x.b.u[1] - u) < TOL)
          .map((x) => x.b.v)
          .sort((p, q) => p[0] - q[0]);
        let reach = v[0];
        for (const p of at) if (p[0] <= reach + TOL && p[1] > reach) reach = p[1];
        return reach >= v[1] - TOL;
      };
      for (const { m, b } of joists) {
        const where = `seed ${seed}: ${memberFullId(m)}`;
        expect(bears(b.u[0], b.v), `${where} start`).toBe(true);
        expect(bears(b.u[1], b.v), `${where} end`).toBe(true);
      }
      for (const { m, b } of boxes.filter((x) => x.m.role === 'blocking')) {
        const side = (v: number) =>
          joists.some(
            (j) =>
              (Math.abs(j.b.v[0] - v) < TOL || Math.abs(j.b.v[1] - v) < TOL) &&
              j.b.u[0] <= b.u[0] + TOL &&
              j.b.u[1] >= b.u[1] - TOL,
          );
        const where = `seed ${seed}: ${memberFullId(m)}`;
        expect(side(b.v[0]) && side(b.v[1]), where).toBe(true);
      }
    }
  });

  it('with mid-span blocking, puts one block in every bay between adjacent joists', () => {
    let checked = 0;
    for (const seed of SEEDS) {
      const c = randomFloor(seed);
      const input: FrameFloorInput = {
        ...c.input,
        settings: { ...c.input.settings, blocking: { kind: 'mid-span' } },
      };
      const { U, V, poly } = c;
      const r = frameFloor(input);
      const jw = input.settings.joistStock.width;
      const joists = r.members.filter((m) => m.role === 'joist').map((m) => boxOf(m, U, V));
      const blocks = r.members.filter((m) => m.role === 'blocking').map((m) => boxOf(m, U, V));
      for (const a of joists)
        for (const b of joists) {
          const gap: [number, number] = [a.v[1], b.v[0]];
          // b above a with a gap a block can fill, and spans that overlap.
          if (gap[1] - gap[0] < 1 + TOL || ov(a.u, b.u) <= TOL) continue;
          // Adjacent: the parts of the overlap with no joist between them.
          const between = joists.filter((k) => k !== a && k !== b && ov(k.v, gap) > TOL);
          let bays: Array<[number, number]> = [
            [Math.max(a.u[0], b.u[0]), Math.min(a.u[1], b.u[1])],
          ];
          for (const k of between)
            bays = bays.flatMap(([p, q]): Array<[number, number]> => {
              if (k.u[1] <= p + TOL || k.u[0] >= q - TOL) return [[p, q]];
              const parts: Array<[number, number]> = [
                [p, k.u[0]],
                [k.u[1], q],
              ];
              return parts.filter((x) => x[1] - x[0] > TOL);
            });
          for (const bay of bays) {
            const mid = (bay[0] + bay[1]) / 2;
            if (bay[1] - bay[0] < jw - TOL || !inside(poly, mid, (gap[0] + gap[1]) / 2)) continue;
            const n = blocks.filter(
              (k) =>
                Math.abs(k.v[0] - gap[0]) < TOL &&
                Math.abs(k.v[1] - gap[1]) < TOL &&
                k.u[0] >= bay[0] - TOL &&
                k.u[1] <= bay[1] + TOL,
            ).length;
            const where = `seed ${seed}: bay ${JSON.stringify(bay)} x ${JSON.stringify(gap)}`;
            expect(n, where).toBe(1);
            checked++;
          }
        }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('gives unique ids that parse, and is deterministic', () => {
    for (const seed of SEEDS) {
      const { input } = randomFloor(seed);
      const a = frameFloor(input);
      const ids = a.members.map((m) => m.id);
      expect(new Set(ids).size, `seed ${seed}`).toBe(ids.length);
      for (const m of a.members) {
        expect(m.owner).toBe('extension#9');
        expect(parseFloorMemberId(m.id), `seed ${seed}: ${m.id}`).toBeDefined();
      }
      expect(frameFloor(input)).toEqual(a);
    }
  });
});
