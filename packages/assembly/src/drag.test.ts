import { describe, expect, it } from 'vitest';
import type { AssemblyInput } from './model';
import { drag, solve } from './solver';
import {
  I,
  at,
  deg,
  expectPoseClose,
  fourBar,
  inst,
  input,
  mate,
  rng,
  randomPose,
  rz,
} from './test-helpers';
import { compose, transformPoint, type Vec3 } from './transform';

/** Feeds a drag's poses back as the next input, like a worker does between moves. */
function withPoses(
  inp: AssemblyInput,
  poses: Record<string, (typeof inp.instances)[number]['pose']>,
) {
  return { ...inp, instances: inp.instances.map((i) => ({ ...i, pose: poses[i.id] ?? i.pose })) };
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('tree drags', () => {
  const lid = input(
    [inst('box', I, true), inst('lid', at([0, 0, 10]))],
    [
      mate('hinge', 'revolute', ['box', at([0, 0, 10])], ['lid', I], {
        limits: { min: 0, max: deg(120) },
      }),
    ],
  );

  it('a lid on a hinge turns so the grabbed point follows the pointer', () => {
    // Grab the lid's far edge (20 mm out on x) and pull it to 90 degrees.
    const r = drag(lid, 'lid', { point: [20, 0, 0], position: [0, 20, 10] });
    expect(r.target.reached).toBe(true);
    expectPoseClose(r.poses.lid, at([0, 0, 10], rz(deg(90))), 1e-7);
    expect(r.mates.hinge!.coordinates[0]).toBeCloseTo(deg(90), 7);
    expect(r.dof).toBe(1);
  });

  it('a target off the hinge circle goes to the nearest point on it', () => {
    const r = drag(lid, 'lid', { point: [20, 0, 0], position: [0, 40, 50] });
    expect(r.target.reached).toBe(false);
    expect(r.warnings.map((w) => w.code)).toEqual(['not-reached']);
    expect(r.mates.hinge!.coordinates[0]).toBeCloseTo(deg(90), 5);
    expect(r.poses.lid!.translation[2]).toBeCloseTo(10, 9);
  });

  it('limits clamp the drag', () => {
    const c = deg(150);
    const r = drag(lid, 'lid', {
      point: [20, 0, 0],
      position: [20 * Math.cos(c), 20 * Math.sin(c), 10],
    });
    expect(r.mates.hinge!.coordinates[0]).toBeCloseTo(deg(120), 9);
    const s = drag(lid, 'lid', { point: [20, 0, 0], position: [20, -5, 10] });
    expect(s.mates.hinge!.coordinates[0]).toBeCloseTo(0, 9);
  });

  it('a slider follows only along its axis', () => {
    const drawer = input(
      [inst('cabinet', I, true), inst('drawer', I), inst('handle', at([0, 0, 0]))],
      [
        mate(
          'rail',
          'slider',
          ['cabinet', at([0, 0, 0], [0, Math.SQRT1_2, 0, Math.SQRT1_2])],
          ['drawer', at([0, 0, 0], [0, Math.SQRT1_2, 0, Math.SQRT1_2])],
          { limits: { min: 0, max: 300 } },
        ),
        mate('grip', 'fastened', ['drawer', at([400, 0, 50])], ['handle', I]),
      ],
    );
    const r = drag(drawer, 'handle', { point: [0, 0, 0], position: [550, 30, -10] });
    expectPoseClose(r.poses.drawer, at([150, 0, 0]), 1e-7);
    expectPoseClose(r.poses.handle, at([550, 0, 50]), 1e-7);
    expect(r.dof).toBe(1);
    // Past the limit, the drawer stops at 300.
    const s = drag(drawer, 'handle', { point: [0, 0, 0], position: [2000, 0, 0] });
    expect(s.poses.drawer!.translation[0]).toBeCloseTo(300, 9);
  });

  it('a whole-pose target in a chain moves the joints nearest it', () => {
    const chain = input(
      [inst('g', I, true), inst('a', I), inst('b', I)],
      [
        mate('m1', 'revolute', ['g', I], ['a', I]),
        mate('m2', 'revolute', ['a', at([10, 0, 0])], ['b', I]),
      ],
    );
    // A reachable pose: m1 at 30 degrees, m2 at 45.
    const target = compose(
      at([0, 0, 0], rz(deg(30))),
      compose(at([10, 0, 0]), at([0, 0, 0], rz(deg(45)))),
    );
    const r = drag(chain, 'b', target);
    expect(r.target.reached).toBe(true);
    expect(r.mates.m1!.coordinates[0]).toBeCloseTo(deg(30), 7);
    expect(r.mates.m2!.coordinates[0]).toBeCloseTo(deg(45), 7);
  });

  it('a fixed instance does not move', () => {
    const r = drag(lid, 'box', at([100, 0, 0]));
    expect(r.poses.box).toBe(lid.instances[0]!.pose);
    expect(r.warnings.map((w) => w.code)).toEqual(['fixed-instance']);
  });

  it('an unknown instance is an issue', () => {
    const r = drag(lid, 'nope', at([1, 0, 0]));
    expect(r.outcome).toBe('invalid');
    expect(r.issues[0]!.code).toBe('unknown-instance');
  });

  it('a group with no fixed instance moves rigidly, rooted at the dragged instance', () => {
    const pa = randomPose(rng(1), 10);
    const inp = input(
      [inst('A', pa), inst('B', compose(pa, at([0, 0, 5], rz(0.4))))],
      [mate('m1', 'revolute', ['A', at([0, 0, 5])], ['B', I])],
    );
    const target = randomPose(rng(2), 10);
    const r = drag(inp, 'B', target);
    expect(r.target.reached).toBe(true);
    expectPoseClose(r.poses.B, target, 1e-9);
    // A follows B with the same relative pose.
    expectPoseClose(
      r.poses.A,
      compose(target, compose(at([0, 0, 0], rz(-0.4)), at([0, 0, -5]))),
      1e-9,
    );
    expect(r.mates.m1!.coordinates[0]).toBeCloseTo(0.4, 9);
    // A point target translates the group.
    const s = drag(inp, 'A', { point: [0, 0, 0], position: [1, 2, 3] });
    expect(s.poses.A!.translation).toEqual([1, 2, 3].map((v) => expect.closeTo(v, 9)));
    expectPoseClose(s.poses.A, at([1, 2, 3], pa.rotation), 1e-9);
  });
});

describe('loop drags', () => {
  it('a four-bar follows a crank drag and stays closed', () => {
    const fb = fourBar(deg(60));
    let inp = input(fb.instances, fb.mates);
    expect(solve(inp).dof).toBe(1);
    // Pull the crank's end round in 5 degree moves from 60 to 150 degrees.
    for (let a = 65; a <= 150; a += 5) {
      const target: Vec3 = [2 * Math.cos(deg(a)), 2 * Math.sin(deg(a)), 0];
      const r = drag(inp, 'crank', { point: [2, 0, 0], position: target });
      expect(r.outcome).toBe('solved');
      expect(r.target.reached).toBe(true);
      expect(r.mates.m1!.coordinates[0]).toBeCloseTo(deg(a), 7);
      expect(r.mates.m4!.residual.position).toBeLessThan(1e-9);
      expect(r.dof).toBe(1);
      // It matches the closed-form linkage on the same branch.
      const exact = fourBar(deg(a));
      for (const i of exact.instances) expectPoseClose(r.poses[i.id], i.pose, 1e-7);
      inp = withPoses(inp, r.poses);
    }
  });

  it('dragging the coupler moves the crank and the rocker', () => {
    const fb = fourBar(deg(60));
    const inp = input(fb.instances, fb.mates);
    const c = fb.instances[2]!.pose;
    const mid = transformPoint(c, [2.5, 0, 0]);
    const r = drag(inp, 'coupler', {
      point: [2.5, 0, 0],
      position: [mid[0] - 0.3, mid[1] + 0.1, 0],
    });
    expect(r.outcome).toBe('solved');
    expect(r.mates.m4!.residual.position).toBeLessThan(1e-9);
    // The coupler point moved toward the target (a one-DOF path, so not necessarily onto it).
    const got = transformPoint(r.poses.coupler!, [2.5, 0, 0]);
    expect(dist(got, [mid[0] - 0.3, mid[1] + 0.1, 0])).toBeLessThan(
      dist(mid, [mid[0] - 0.3, mid[1] + 0.1, 0]),
    );
    // Link lengths hold.
    const B = transformPoint(r.poses.crank!, [2, 0, 0]);
    const C = transformPoint(r.poses.rocker!, [4, 0, 0]);
    expect(dist(B, C)).toBeCloseTo(5, 9);
    expect(dist(C, [5, 0, 0])).toBeCloseTo(4, 9);
  });

  it('a slider-crank converts crank drags into slider travel', () => {
    // Crank 2 on a hinge at the origin, rod 6, piston on a slider along x.
    const sx = [0, Math.SQRT1_2, 0, Math.SQRT1_2] as const; // z onto x
    const theta = deg(40);
    const B: Vec3 = [2 * Math.cos(theta), 2 * Math.sin(theta), 0];
    const px = B[0] + Math.sqrt(36 - B[1] * B[1]);
    const inp = input(
      [
        inst('g', I, true),
        inst('crank', at([0, 0, 0], rz(theta))),
        inst('rod', at(B, rz(Math.atan2(-B[1], px - B[0])))),
        inst('piston', at([px, 0, 0])),
      ],
      [
        mate('m1', 'revolute', ['g', I], ['crank', I]),
        mate('m2', 'revolute', ['crank', at([2, 0, 0])], ['rod', I]),
        mate('m3', 'slider', ['g', at([0, 0, 0], sx)], ['piston', at([0, 0, 0], sx)]),
        mate('m4', 'revolute', ['rod', at([6, 0, 0])], ['piston', I]),
      ],
    );
    const s = solve(inp);
    expect(s.dof).toBe(1);
    expect(s.redundant).toEqual([]);
    const a = deg(80);
    const r = drag(inp, 'crank', {
      point: [2, 0, 0],
      position: [2 * Math.cos(a), 2 * Math.sin(a), 0],
    });
    const Bx = 2 * Math.cos(a),
      By = 2 * Math.sin(a);
    expect(r.poses.piston!.translation[0]).toBeCloseTo(Bx + Math.sqrt(36 - By * By), 7);
    expect(r.mates.m4!.residual.position).toBeLessThan(1e-9);
    // Dragging the piston turns the crank back.
    const back = drag(withPoses(inp, r.poses), 'piston', {
      point: [0, 0, 0],
      position: [px, 0, 0],
    });
    expect(back.mates.m1!.coordinates[0]).toBeCloseTo(theta, 6);
  });
});
