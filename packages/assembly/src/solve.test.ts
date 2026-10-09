import { describe, expect, it } from 'vitest';
import type { MateInput, MateKind } from './model';
import { wrapAngle } from './mates';
import { solve } from './solver';
import {
  I,
  at,
  deg,
  expectPoseClose,
  fourBar,
  inst,
  input,
  mate,
  perturb,
  place,
  randomPose,
  randomQuat,
  rng,
  rz,
} from './test-helpers';
import { compose, quatFromAxisAngle, rotateVector, type Pose } from './transform';

const ry90 = quatFromAxisAngle([0, 1, 0], Math.PI / 2);

describe('hand-computed poses per mate kind', () => {
  it('fastened: b takes the connector frame exactly', () => {
    const r = solve(
      input(
        [inst('A', I, true), inst('B', at([3, 3, 3]))],
        [mate('m1', 'fastened', ['A', at([10, 0, 0], rz(deg(90)))], ['B', at([0, 5, 0])])],
      ),
    );
    expect(r.outcome).toBe('solved');
    // T(10,0,0) Rz(90) T(0,-5,0): (10,0,0) + Rz(90)(0,-5,0) = (15,0,0).
    expectPoseClose(r.poses.B, at([15, 0, 0], rz(deg(90))));
    expect(r.dof).toBe(0);
    expect(r.mates.m1).toMatchObject({ status: 'ok', coordinates: [] });
  });

  it('revolute: keeps the angle about the axis, snaps the rest', () => {
    const r = solve(
      input(
        [inst('A', I, true), inst('B', at([3, 4, 12], rz(deg(30))))],
        [mate('m1', 'revolute', ['A', at([0, 0, 10])], ['B', I])],
      ),
    );
    expectPoseClose(r.poses.B, at([0, 0, 10], rz(deg(30))));
    expect(r.mates.m1!.coordinates[0]).toBeCloseTo(deg(30), 12);
    expect(r.dof).toBe(1);
  });

  it('slider: keeps the distance along the axis', () => {
    // Both connectors' z axes along world x.
    const r = solve(
      input(
        [inst('A', I, true), inst('B', at([7, 1, 2]))],
        [mate('m1', 'slider', ['A', at([0, 0, 0], ry90)], ['B', at([0, 0, 0], ry90)])],
      ),
    );
    expectPoseClose(r.poses.B, at([7, 0, 0]));
    expect(r.mates.m1!.coordinates[0]).toBeCloseTo(7, 12);
    expect(r.dof).toBe(1);
  });

  it('planar: keeps x, y and the angle in the plane', () => {
    const r = solve(
      input(
        [inst('A', I, true), inst('B', at([3, 4, 5], rz(deg(45))))],
        [mate('m1', 'planar', ['A', I], ['B', I])],
      ),
    );
    expectPoseClose(r.poses.B, at([3, 4, 0], rz(deg(45))));
    const [x, y, a] = r.mates.m1!.coordinates;
    expect([x, y]).toEqual([3, 4]);
    expect(a).toBeCloseTo(deg(45), 12);
    expect(r.dof).toBe(3);
  });

  it('cylindrical: keeps the distance and the angle', () => {
    const r = solve(
      input(
        [inst('A', I, true), inst('B', at([1, 2, 5], rz(deg(20))))],
        [mate('m1', 'cylindrical', ['A', I], ['B', I])],
      ),
    );
    expectPoseClose(r.poses.B, at([0, 0, 5], rz(deg(20))));
    expect(r.dof).toBe(2);
  });

  it('ball: keeps the orientation, the centres meet', () => {
    const q = randomQuat(rng(5));
    const r = solve(
      input(
        [inst('A', I, true), inst('B', at([9, 9, 9], q))],
        [mate('m1', 'ball', ['A', at([0, 0, 10])], ['B', at([0, 0, -2])])],
      ),
    );
    const c = rotateVector(q, [0, 0, -2]);
    expectPoseClose(r.poses.B, at([-c[0], -c[1], 10 - c[2]], q));
    expect(r.dof).toBe(3);
  });

  it('an offset applies in connector a frame before the free coordinates', () => {
    const r = solve(
      input(
        [inst('A', I, true), inst('B', at([0, 0, 0], rz(deg(10))))],
        [mate('m1', 'revolute', ['A', I], ['B', I], { offset: at([0, 0, 2]) })],
      ),
    );
    expectPoseClose(r.poses.B, at([0, 0, 2], rz(deg(10))));
  });

  it('limits clamp a tree coordinate', () => {
    const r = solve(
      input(
        [inst('A', I, true), inst('B', at([0, 0, 50]))],
        [mate('m1', 'slider', ['A', I], ['B', I], { limits: { min: 0, max: 20 } })],
      ),
    );
    expectPoseClose(r.poses.B, at([0, 0, 20]));
    expect(r.mates.m1!.coordinates[0]).toBeCloseTo(20, 12);
  });

  it('a seed past a limit is clamped with a warning naming the mate, the bound and the value', () => {
    const r = solve(
      input(
        [inst('A', I, true), inst('B', at([0, 0, 50]))],
        [mate('m1', 'slider', ['A', I], ['B', I], { limits: { min: 0, max: 20 } })],
      ),
    );
    expect(r.outcome).toBe('solved');
    expect(r.warnings).toEqual([
      {
        code: 'clamped',
        mateId: 'm1',
        bound: 'max',
        limit: 20,
        value: expect.closeTo(50, 9) as number,
        message: expect.stringMatching(/50\.00 mm, past its maximum of 20\.00 mm/) as string,
      },
    ]);
    const below = solve(
      input(
        [inst('A', I, true), inst('B', at([0, 0, -5]))],
        [mate('m1', 'slider', ['A', I], ['B', I], { limits: { min: 0 } })],
      ),
    );
    expect(below.warnings).toMatchObject([{ code: 'clamped', bound: 'min', limit: 0 }]);
    expect(below.poses.B!.translation[2]).toBeCloseTo(0, 12);
  });

  it('a seed at or within a limit (up to rounding) gives no warning', () => {
    for (const z of [0, 20, 20 + 1e-12, 7]) {
      const r = solve(
        input(
          [inst('A', I, true), inst('B', at([0, 0, z]))],
          [mate('m1', 'slider', ['A', I], ['B', I], { limits: { min: 0, max: 20 } })],
        ),
      );
      expect(r.warnings).toEqual([]);
    }
  });

  it('a revolute seed past its limit is clamped in angle', () => {
    const r = solve(
      input(
        [inst('A', I, true), inst('B', at([0, 0, 0], rz(deg(100))))],
        [mate('m1', 'revolute', ['A', I], ['B', I], { limits: { min: 0, max: deg(90) } })],
      ),
    );
    expect(r.mates.m1!.coordinates[0]).toBeCloseTo(deg(90), 12);
    expect(r.warnings).toMatchObject([{ code: 'clamped', bound: 'max', limit: deg(90) }]);
    expect(r.warnings[0]!.value).toBeCloseTo(deg(100), 9);
    expect(r.warnings[0]!.message).toMatch(/100\.00 degrees/);
  });

  it('a revolute limit picks the turn inside the range', () => {
    // 200 degrees is -160 wrapped; the limits [0, 270] want 200.
    const r = solve(
      input(
        [inst('A', I, true), inst('B', at([0, 0, 0], rz(deg(200))))],
        [mate('m1', 'revolute', ['A', I], ['B', I], { limits: { min: 0, max: deg(270) } })],
      ),
    );
    expect(r.mates.m1!.coordinates[0]).toBeCloseTo(deg(200), 12);
    expectPoseClose(r.poses.B, at([0, 0, 0], rz(deg(200))));
  });
});

describe('graph', () => {
  it('unconnected instances keep their poses (the same objects)', () => {
    const p = randomPose(rng(9));
    const q = randomPose(rng(10));
    const inp = input(
      [inst('A', I, true), inst('B', at([1, 1, 1])), inst('C', p), inst('D', q, true)],
      [mate('m1', 'revolute', ['A', I], ['B', I])],
    );
    const r = solve(inp);
    expect(r.poses.C).toBe(p);
    expect(r.poses.D).toBe(q);
    // B moved (snapped onto the axis), so it is a new pose.
    expect(r.poses.B).not.toBe(inp.instances[1]!.pose);
    // A free instance adds 6 DOF, the revolute 1.
    expect(r.dof).toBe(7);
  });

  it('an already solved assembly comes back unchanged', () => {
    const fb = fourBar(deg(60));
    const r = solve(input(fb.instances, fb.mates));
    for (const i of fb.instances) expect(r.poses[i.id]).toBe(i.pose);
  });

  it('a group with no fixed instance keeps its first instance in place', () => {
    const p = randomPose(rng(11));
    const r = solve(
      input([inst('A', p), inst('B', I)], [mate('m1', 'fastened', ['A', I], ['B', at([0, 0, 1])])]),
    );
    expect(r.poses.A).toBe(p);
    expectPoseClose(r.poses.B, compose(p, at([0, 0, -1])));
    expect(r.dof).toBe(6);
  });

  it('suppressed mates are ignored', () => {
    const r = solve(
      input(
        [inst('A', I, true), inst('B', at([5, 0, 0]))],
        [mate('m1', 'fastened', ['A', I], ['B', I], { suppressed: true })],
      ),
    );
    expect(r.poses.B).toEqual(at([5, 0, 0]));
    expect(r.mates.m1!.status).toBe('suppressed');
    expect(r.dof).toBe(6);
  });

  it('reports input problems and solves the rest', () => {
    const r = solve(
      input(
        [inst('A', I, true), inst('B', at([5, 0, 0])), inst('B', I)],
        [
          mate('m1', 'fastened', ['A', I], ['B', I]),
          mate('m2', 'revolute', ['A', I], ['Z', I]),
          mate('m3', 'slider', ['B', I], ['B', I]),
          mate('m4', 'bogus' as MateKind, ['A', I], ['B', I]),
          mate(
            'm5',
            'fastened',
            ['A', { translation: [0, 0, 0], rotation: [0, 0, 0, 0] }],
            ['B', I],
          ),
          mate('m6', 'slider', ['A', I], ['B', I], { limits: { min: 3, max: 1 } }),
        ],
      ),
    );
    expect(r.outcome).toBe('invalid');
    expect(r.issues.map((i) => i.code)).toEqual([
      'duplicate-id',
      'unknown-instance',
      'self-mate',
      'unknown-kind',
      'invalid-pose',
      'invalid-limits',
    ]);
    expect(r.mates.m2!.status).toBe('invalid');
    expect(r.mates.m2!.message).toMatch(/instance Z/);
    expectPoseClose(r.poses.B, I);
    expect(r.message).toMatch(/input problems/);
  });
});

describe('diagnostics', () => {
  it('two fastened mates between one pair: the newer is redundant', () => {
    const r = solve(
      input(
        [inst('A', I, true), inst('B', at([1, 2, 3]))],
        [
          mate('m1', 'fastened', ['A', at([0, 0, 5])], ['B', I]),
          mate('m2', 'fastened', ['A', at([0, 0, 5])], ['B', I]),
        ],
      ),
    );
    expect(r.outcome).toBe('solved');
    expect(r.dof).toBe(0);
    expect(r.redundant).toHaveLength(1);
    expect(r.redundant[0]).toMatchObject({ mates: ['m1', 'm2'], blame: 'm2' });
    expect(r.redundant[0]!.message).toMatch(/m2 is redundant/);
    expect(r.mates.m2!.status).toBe('redundant');
    expect(r.mates.m1!.status).toBe('ok');
    expect(r.conflicting).toEqual([]);
  });

  it('two coaxial revolutes: redundant, one DOF left', () => {
    const r = solve(
      input(
        [inst('A', I, true), inst('B', at([0, 0, 0], rz(0.3)))],
        [
          mate('m1', 'revolute', ['A', I], ['B', I]),
          mate('m2', 'revolute', ['A', at([0, 0, 4])], ['B', at([0, 0, 4])]),
        ],
      ),
    );
    expect(r.dof).toBe(1);
    expect(r.redundant.map((g) => g.blame)).toEqual(['m2']);
  });

  it('a four-bar has one DOF and nothing redundant', () => {
    const fb = fourBar(deg(60));
    const r = solve(input(perturb(fb.instances, rng(3)), fb.mates));
    expect(r.outcome).toBe('solved');
    expect(r.dof).toBe(1);
    expect(r.redundant).toEqual([]);
    expect(r.mates.m4!.residual.position).toBeLessThan(1e-9);
    for (const i of fb.instances) expectPoseClose(r.poses[i.id], i.pose, 0.05);
  });

  it('a loop that cannot close is a conflict naming its mates, the newest blamed', () => {
    // A 10 mm arm on a hinge at the origin cannot reach a hinge 20 mm away.
    const r = solve(
      input(
        [inst('G', I, true), inst('arm', I)],
        [
          mate('m1', 'revolute', ['G', I], ['arm', I]),
          mate('m2', 'revolute', ['arm', at([10, 0, 0])], ['G', at([20, 0, 0])]),
        ],
      ),
    );
    expect(r.outcome).toBe('conflicting');
    expect(r.dof).toBeNull();
    expect(r.conflicting).toHaveLength(1);
    expect(r.conflicting[0]).toMatchObject({ mates: ['m1', 'm2'], blame: 'm2' });
    expect(r.conflicting[0]!.message).toMatch(/10\.00 mm/);
    expect(r.mates.m1!.status).toBe('conflicting');
    expect(r.mates.m2!.status).toBe('conflicting');
    expect(r.mates.m2!.residual.position).toBeCloseTo(10, 6);
    // Poses stay finite and as near as they can get.
    expect(Number.isFinite(r.poses.arm!.translation[0])).toBe(true);
  });

  it('two fixed instances fastened at the wrong distance conflict', () => {
    const r = solve(
      input(
        [inst('A', I, true), inst('B', at([5, 0, 0]), true)],
        [mate('m1', 'fastened', ['A', I], ['B', I])],
      ),
    );
    expect(r.outcome).toBe('conflicting');
    expect(r.conflicting[0]).toMatchObject({ mates: ['m1'], blame: 'm1' });
    expect(r.poses.B).toEqual(at([5, 0, 0]));
  });

  it('a loop mate outside its limits is a warning', () => {
    const fb = fourBar(deg(60));
    const mates = fb.mates.map((m) => (m.id === 'm4' ? { ...m, limits: { min: 0, max: 0.1 } } : m));
    const r = solve(input(fb.instances, mates));
    expect(r.outcome).toBe('solved');
    expect(r.warnings.map((w) => w.code)).toEqual(['outside-limits']);
    expect(r.warnings[0]).toMatchObject({ mateId: 'm4', bound: 'min', limit: 0 });
    expect(r.warnings[0]!.value).toBeLessThan(0);
  });
});

describe('near-singular cases do not blow up', () => {
  it('a revolute axis on a slider line, closed by a cylindrical: redundant, DOF 2', () => {
    const r = solve(
      input(
        [inst('G', I, true), inst('B', at([0, 0, 3])), inst('C', at([0, 0, 3], rz(1)))],
        [
          mate('m1', 'slider', ['G', I], ['B', I]),
          mate('m2', 'revolute', ['B', I], ['C', I]),
          mate('m3', 'cylindrical', ['C', I], ['G', I]),
        ],
      ),
    );
    expect(r.outcome).toBe('solved');
    expect(r.dof).toBe(2);
    expect(r.redundant.map((g) => g.blame)).toEqual(['m3']);
  });

  for (const eps of [0, 1e-9, 1e-6, 1e-3]) {
    it(`a revolute axis ${eps} rad off a slider, closed by a fastened mate`, () => {
      const tilt = quatFromAxisAngle([1, 0, 0], eps);
      const r = solve(
        input(
          [
            inst('G', I, true),
            inst('B', at([0.01, 0.02, 0.5])),
            inst('C', at([0.03, 0, 0.4], rz(0.2))),
          ],
          [
            mate('m1', 'slider', ['G', I], ['B', I]),
            mate('m2', 'revolute', ['B', at([0, 0, 0], tilt)], ['C', at([0, 0, 0], tilt)]),
            mate('m3', 'fastened', ['C', I], ['G', I]),
          ],
        ),
      );
      for (const p of Object.values(r.poses)) {
        for (const v of [...p.translation, ...p.rotation]) expect(Number.isFinite(v)).toBe(true);
      }
      expect(r.outcome).toBe('solved');
      expect(r.mates.m3!.residual.position).toBeLessThan(1e-9);
      expectPoseClose(r.poses.C, I, 1e-9);
      expect(r.dof).toBe(0);
    });
  }
});

describe('randomised round trips: coordinates to poses and back', () => {
  const kinds: MateKind[] = ['fastened', 'revolute', 'slider', 'planar', 'cylindrical', 'ball'];
  it('random trees solve to the poses they were built from', () => {
    const r = rng(42);
    for (let trial = 0; trial < 40; trial++) {
      const n = 2 + Math.floor(r() * 12);
      const instances = [inst('i0', randomPose(r), true)];
      const mates: MateInput[] = [];
      const coords: Record<string, number[]> = {};
      const poses: Pose[] = [instances[0]!.pose];
      for (let i = 1; i < n; i++) {
        const p = Math.floor(r() * i);
        const kind = kinds[Math.floor(r() * kinds.length)]!;
        const m = mate(`m${i}`, kind, [`i${p}`, randomPose(r, 20)], [`i${i}`, randomPose(r, 20)]);
        if (r() < 0.3) m.offset = randomPose(r, 5);
        const q =
          kind === 'ball'
            ? [...Array(3)].map(() => (r() - 0.5) * 2)
            : [...Array(3)].map(() => (r() - 0.5) * 5);
        const pose = place(poses[p]!, m, q);
        poses.push(pose);
        instances.push(inst(`i${i}`, pose));
        if (!m.offset && r() < 0.5) {
          // The same mate stated from the child's side: J becomes J^-1, still of its kind.
          mates.push(mate(m.id, kind, [`i${i}`, m.b.frame], [`i${p}`, m.a.frame]));
        } else {
          mates.push(m);
          coords[m.id] = q;
        }
      }
      // Instances in a shuffled order.
      const shuffled = instances
        .map((i) => ({ i, key: r() }))
        .sort((a, b) => a.key - b.key)
        .map((x) => x.i);
      const res = solve(input(shuffled, mates));
      expect(res.outcome).toBe('solved');
      instances.forEach((i, k) => expectPoseClose(res.poses[i.id], poses[k]!, 1e-7));
      for (const m of mates) {
        const got = res.mates[m.id]!.coordinates;
        const want = coords[m.id];
        if (!want) continue;
        got.forEach((v, k) => {
          const angular =
            m.kind === 'revolute' ||
            (m.kind === 'planar' && k === 2) ||
            (m.kind === 'cylindrical' && k === 1);
          const d = angular ? wrapAngle(v - want[k]!) : v - want[k]!;
          expect(Math.abs(d)).toBeLessThan(1e-7);
        });
      }
    }
  });

  it('solving from perturbed poses recovers a tree mate to its seed nearest coordinates', () => {
    const r = rng(8);
    for (let trial = 0; trial < 20; trial++) {
      const m = mate('m', 'revolute', ['A', randomPose(r, 10)], ['B', randomPose(r, 10)]);
      const angle = (r() - 0.5) * 6;
      const b = place(I, m, [angle]);
      const res = solve(input([inst('A', I, true), ...perturb([inst('B', b)], r, 1e-4)], [m]));
      expectPoseClose(res.poses.B, b, 1e-3);
    }
  });
});
