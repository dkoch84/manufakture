// The `thread` feature on a picked face (M3 plan, T3.2f): the face supplies the axis, side,
// radius and extent; the ends are chamfered where the cylinder ends freely and closed where it
// meets the rest of the body; the phase follows the axis line, so a bolt and a nut threaded
// apart mate; a cosmetic thread resizes the cylinder; a cylinder the size cannot be cut into
// fails with the range. The thread geometry itself is tested in test/threads.test.ts.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyFeature,
  type FeatureBody,
  type FeatureOutcome,
  type ThreadFaceInput,
} from './features';
import { atZ, circle, profile, rectangle } from './fixtures/parts';
import type { Kernel } from './kernel';
import { createNodeKernel } from './node';
import { threadSize } from './threads';

let k: Kernel;

beforeAll(async () => {
  k = await createNodeKernel();
}, 60_000);

const M6 = threadSize('iso-metric', 'M6')!;

function ok(out: FeatureOutcome): FeatureBody[] {
  expect(out.errors).toEqual([]);
  return out.bodies.map((b) => ({ id: b.id, shape: b.shape }));
}

/** A shaft of `radius` along z from z0 to z1, a body of its own. */
function shaft(bodies: FeatureBody[], id: string, radius: number, z0: number, z1: number) {
  return ok(
    applyFeature(k, bodies, {
      kind: 'extrude',
      id,
      mode: 'new',
      profile: profile(atZ(z0), circle([0, 0], radius)),
      extent: { type: 'blind', distance: z1 - z0 },
    }),
  );
}

/** A bolt: a head of radius 5 from z 0 to 4 and a shank of `radius` from 4 to `tip`. */
function bolt(radius = 3, tip = 24): FeatureBody[] {
  const head = shaft([], 'extrude#1', 5, 0, 4);
  return ok(
    applyFeature(k, head, {
      kind: 'extrude',
      id: 'extrude#2',
      mode: 'add',
      profile: profile(atZ(4), circle([0, 0], radius)),
      extent: { type: 'blind', distance: tip - 4 },
    }),
  );
}

/** A square nut 12 across with a hole of `radius`, from z0 to z1, a body of its own. */
function nut(bodies: FeatureBody[], radius: number, z0: number, z1: number, id = 'extrude#3') {
  return ok(
    applyFeature(k, bodies, {
      kind: 'extrude',
      id,
      mode: 'new',
      profile: profile(atZ(z0), rectangle(-6, -6, 6, 6), circle([0, 0], radius, 'h1')),
      extent: { type: 'blind', distance: z1 - z0 },
    }),
  );
}

function thread(
  bodies: FeatureBody[],
  face: string,
  extra: Partial<ThreadFaceInput> = {},
): FeatureOutcome {
  return applyFeature(k, bodies, {
    kind: 'thread',
    id: 'thread#9',
    face: { id: 'r1', ref: { face } },
    length: 'full',
    major: M6.major,
    pitch: M6.pitch,
    tapDrill: M6.tapDrill,
    clearance: 0.1,
    label: 'M6',
    ...extra,
  });
}

function body(out: FeatureOutcome, id: string) {
  const b = out.bodies.find((x) => x.id === id)!;
  return { shape: b.shape, names: b.names!, topology: k.topology(b.shape) };
}

function threadNames(out: FeatureOutcome, id: string): string[] {
  return body(out, id)
    .names.faces.map((f) => f.name)
    .filter((n) => n.startsWith('thread#9:thread:'));
}

describe('a thread on a picked face', () => {
  it('threads a shaft, chamfering both free ends, and reports what it built', () => {
    const out = thread(shaft([], 'extrude#1', 3, 0, 10), 'extrude#1:side:c1');
    expect(out.errors).toEqual([]);
    expect(out.changed).toEqual(['extrude#1']);
    const b = body(out, 'extrude#1');
    expect(k.isValid(b.shape)).toBe(true);
    expect(threadNames(out, 'extrude#1').some((n) => n.startsWith('thread#9:thread:root:'))).toBe(
      true,
    );
    expect(out.thread).toMatchObject({
      bodyId: 'extrude#1',
      side: 'external',
      representation: 'modelled',
      radius: 3,
      length: 10,
      pitch: 1,
      hand: 'right',
      start: 'chamfer',
      end: 'chamfer',
    });
    expect(out.resolved.map((r) => r.ref)).toEqual(['r1']);
  }, 60_000);

  it('starts at the first cap by name, or at the picked edge', () => {
    const bodies = shaft([], 'extrude#1', 3, 0, 10);
    // cap:end sorts before cap:start, so the axis points to the top: the thread starts there.
    const byName = thread(bodies, 'extrude#1:side:c1', { length: 6 });
    expect(byName.errors).toEqual([]);
    expect(byName.thread!.axis.origin[2]).toBeCloseTo(10, 6);
    expect(byName.thread!.axis.direction[2]).toBeCloseTo(-1, 9);
    // A thread shorter than the face stops with a closed end.
    expect(byName.thread).toMatchObject({ start: 'chamfer', end: 'closed', length: 6 });
    const picked = thread(bodies, 'extrude#1:side:c1', {
      length: 6,
      start: { id: 'r2', ref: { faces: ['extrude#1:cap:start', 'extrude#1:side:c1'] } },
    });
    expect(picked.errors).toEqual([]);
    expect(picked.thread!.axis.origin[2]).toBeCloseTo(0, 6);
    expect(picked.thread!.axis.direction[2]).toBeCloseTo(1, 9);
  }, 60_000);

  it('closes the end at a bolt head and chamfers the tip', () => {
    const out = thread(bolt(), 'extrude#2:side:c1');
    expect(out.errors).toEqual([]);
    expect(k.isValid(body(out, 'extrude#1').shape)).toBe(true);
    const t = out.thread!;
    const atHead = Math.abs(t.axis.origin[2] - 4) < 1e-6;
    expect(atHead ? t.start : t.end).toBe('closed');
    expect(atHead ? t.end : t.start).toBe('chamfer');
    // The head is untouched: its rim is still where it was.
    const box = k.properties(body(out, 'extrude#1').shape).boundingBox!;
    expect(box.min[2]).toBeCloseTo(0, 3);
    expect(box.max[0]).toBeCloseTo(5, 3);
  }, 60_000);

  it('threads a bolt and a nut threaded apart so they mate, cutting only the owning body', () => {
    const parts = nut(bolt(), M6.minor / 2, 10, 16);
    const onBolt = thread(parts, 'extrude#2:side:c1');
    expect(onBolt.errors).toEqual([]);
    // The nut is coaxial and inside the thread's reach, but not the face's body: untouched.
    expect(onBolt.changed).toEqual(['extrude#1']);
    const threaded = ok(onBolt);
    const onNut = thread(threaded, 'extrude#3:side:h1', { id: 'thread#10' });
    expect(onNut.errors).toEqual([]);
    expect(onNut.changed).toEqual(['extrude#3']);
    expect(onNut.thread).toMatchObject({ side: 'internal', start: 'chamfer', end: 'chamfer' });
    const boltShape = onNut.bodies.find((b) => b.id === 'extrude#1')!.shape;
    const nutShape = onNut.bodies.find((b) => b.id === 'extrude#3')!.shape;
    expect(k.isValid(nutShape)).toBe(true);
    const clash = k.interference([{ shapes: [boltShape] }, { shapes: [nutShape] }]);
    expect(clash.failures).toEqual([]);
    expect(clash.pairs).toEqual([]);
  }, 120_000);

  /** A bolt and a nut from z0 to z1 both threaded with `hand` and `nutHand`: the clash. */
  function mate(z0: number, z1: number, hand: 'right' | 'left', nutHand = hand) {
    const onBolt = thread(nut(bolt(), M6.minor / 2, z0, z1), 'extrude#2:side:c1', { hand });
    const onNut = thread(ok(onBolt), 'extrude#3:side:h1', { id: 'thread#10', hand: nutHand });
    expect(onNut.errors).toEqual([]);
    const boltShape = onNut.bodies.find((b) => b.id === 'extrude#1')!.shape;
    const nutShape = onNut.bodies.find((b) => b.id === 'extrude#3')!.shape;
    expect(k.isValid(nutShape)).toBe(true);
    const clash = k.interference([{ shapes: [boltShape] }, { shapes: [nutShape] }]);
    expect(clash.failures).toEqual([]);
    return clash.pairs;
  }

  it('mates a nut a fraction of a pitch along, of either hand', () => {
    expect(mate(10.3, 16.3, 'right')).toEqual([]);
    expect(mate(10.5, 16.5, 'right')).toEqual([]);
    expect(mate(10.37, 16.37, 'left')).toEqual([]);
  }, 240_000);

  it('clashes with a nut of the opposite hand', () => {
    expect(mate(10.3, 16.3, 'right', 'left').length).toBeGreaterThan(0);
  }, 120_000);

  it('keeps every name of the turns it keeps when the length changes', () => {
    const bodies = shaft([], 'extrude#1', 3, 0, 12);
    const start = { id: 'r2', ref: { faces: ['extrude#1:cap:start', 'extrude#1:side:c1'] } };
    const a = thread(bodies, 'extrude#1:side:c1', { length: 6, start });
    const b = thread(bodies, 'extrude#1:side:c1', { length: 8, start });
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    const turns = (out: FeatureOutcome) =>
      new Set(
        threadNames(out, 'extrude#1').filter((n) => /:(root|flank-a|flank-b):[1-4]$/.test(n)),
      );
    expect(turns(a).size).toBeGreaterThan(0);
    expect(turns(b)).toEqual(turns(a));
    const names = (out: FeatureOutcome) => new Set(threadNames(out, 'extrude#1'));
    expect(new Set([...names(a)].filter((n) => names(b).has(n))).size).toBeGreaterThan(0);
    // No name is used twice.
    for (const out of [a, b]) {
      const all = body(out, 'extrude#1').names.faces.map((f) => f.name);
      expect(new Set(all).size).toBe(all.length);
    }
  }, 60_000);

  it('fails on a cylinder the size cannot be cut into, naming the range', () => {
    const out = thread(shaft([], 'extrude#1', 5, 0, 10), 'extrude#1:side:c1');
    expect(out.ok).toBe(false);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatchObject({ code: 'invalid', ref: 'r1' });
    expect(out.errors[0]!.message).toMatch(/^M6 \(external\) needs a shaft [\d.]+ to 8 mm across/);
    expect(out.errors[0]!.message).toMatch(/is 10 mm$/);
    const cosmetic = thread(shaft([], 'extrude#1', 5, 0, 10), 'extrude#1:side:c1', {
      representation: 'cosmetic',
    });
    expect(cosmetic.errors[0]?.message).toBe(out.errors[0]!.message);
  }, 60_000);

  it('refuses a face that is not a cylinder, a thread longer than the face and a stray edge', () => {
    const bodies = shaft([], 'extrude#1', 3, 0, 10);
    expect(thread(bodies, 'extrude#1:cap:end').errors[0]?.message).toMatch(/not a cylindrical/);
    expect(thread(bodies, 'extrude#1:side:c1', { length: 11 }).errors[0]?.message).toMatch(
      /11 mm long, but extrude#1:side:c1 is 10 mm long/,
    );
    const scoped = applyFeature(k, bodies, {
      kind: 'thread',
      id: 'thread#9',
      face: { id: 'r1', ref: { face: 'extrude#1:side:c1' } },
      length: 'full',
      major: 6,
      pitch: 1,
      tapDrill: 5,
      scope: ['extrude#1'],
    } as unknown as ThreadFaceInput);
    expect(scoped.errors[0]?.message).toMatch(/no scope/);
    // An edge of the body that does not bound the face: the head's lower rim on a bolt.
    const stray = thread(bolt(), 'extrude#2:side:c1', {
      length: 6,
      start: { id: 'r2', ref: { faces: ['extrude#1:cap:start', 'extrude#1:side:c1'] } },
    });
    expect(stray.errors[0]).toMatchObject({ code: 'invalid', ref: 'r2' });
    expect(stray.errors[0]?.message).toMatch(/is not an end edge of extrude#2:side:c1/);
  }, 60_000);
});

describe('a cosmetic thread', () => {
  const radiusOf = (out: FeatureOutcome, id: string, name: string) => {
    const b = body(out, id);
    const i = b.names.faces.findIndex((f) => f.name === name);
    expect(i).toBeGreaterThanOrEqual(0);
    return b.topology.faces[i]!.radius;
  };

  it('shrinks a shaft to the major diameter less the clearance', () => {
    const out = thread(shaft([], 'extrude#1', 3, 0, 10), 'extrude#1:side:c1', {
      representation: 'cosmetic',
    });
    expect(out.errors).toEqual([]);
    expect(radiusOf(out, 'extrude#1', 'thread#9:thread:cosmetic')).toBeCloseTo(2.9, 9);
    expect(out.thread).toMatchObject({ representation: 'cosmetic', radius: 2.9, side: 'external' });
    const b = body(out, 'extrude#1');
    expect(k.isValid(b.shape)).toBe(true);
    // Its caps keep their names; the old side is gone.
    const names = b.names.faces.map((f) => f.name);
    expect(names).toContain('extrude#1:cap:start');
    expect(names).toContain('extrude#1:cap:end');
    expect(names).not.toContain('extrude#1:side:c1');
    expect(k.properties(b.shape).volume).toBeCloseTo(Math.PI * 2.9 ** 2 * 10, 3);
  }, 60_000);

  it('grows a thin shaft, stepping at the head', () => {
    const out = thread(bolt(2.7), 'extrude#2:side:c1', { representation: 'cosmetic' });
    expect(out.errors).toEqual([]);
    expect(radiusOf(out, 'extrude#1', 'thread#9:thread:cosmetic')).toBeCloseTo(2.9, 9);
    const b = body(out, 'extrude#1');
    expect(k.isValid(b.shape)).toBe(true);
    expect(k.properties(b.shape).volume).toBeCloseTo(Math.PI * (25 * 4 + 2.9 ** 2 * 20), 2);
  }, 60_000);

  it('resizes a hole to the tap drill, smaller or larger', () => {
    for (const radius of [2.9, 2.2]) {
      const out = thread(nut([], radius, 0, 6), 'extrude#3:side:h1', {
        representation: 'cosmetic',
      });
      expect(out.errors).toEqual([]);
      expect(radiusOf(out, 'extrude#3', 'thread#9:thread:cosmetic')).toBeCloseTo(2.5, 9);
      const b = body(out, 'extrude#3');
      expect(k.isValid(b.shape)).toBe(true);
      expect(k.properties(b.shape).volume).toBeCloseTo((144 - Math.PI * 2.5 ** 2) * 6, 2);
      expect(out.thread).toMatchObject({ side: 'internal', radius: 2.5 });
    }
  }, 60_000);

  it('leaves a cylinder already at size as it is', () => {
    const bodies = nut([], 2.5, 0, 6);
    const out = thread(bodies, 'extrude#3:side:h1', { representation: 'cosmetic' });
    expect(out.errors).toEqual([]);
    expect(out.changed).toEqual([]);
    expect(out.bodies[0]!.shape).toBe(bodies[0]!.shape);
    expect(out.thread).toMatchObject({ radius: 2.5, length: 6 });
  }, 60_000);
});
