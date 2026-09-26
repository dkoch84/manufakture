// The planegcs-backed SketchSystem: DOF, diagnosis, the tangent arc, every
// constraint kind, expressions, incremental edits and dragging.

import { lengthQuantity } from '@manufakture/units';
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  PointRef,
  SketchConstraint,
  SketchEntity,
  SketchInput,
  SolveResult,
  Vec2,
} from './model';
import { SKETCH_X_AXIS, SKETCH_Y_AXIS, applyCoordinates, packCoordinates } from './model';
import { loadPlanegcsBackend, type PlanegcsBackend } from './planegcs/system';
import {
  ORIGIN,
  RECT_STAGES,
  ROUNDED_STAGES,
  arc,
  center,
  circle,
  deg,
  end,
  entity,
  line,
  mm,
  point,
  pointAt,
  rectangle,
  roundedRectangle,
  start,
  type Stage,
} from './test-helpers';

let backend: PlanegcsBackend;
beforeAll(async () => {
  backend = await loadPlanegcsBackend();
});

const solve = (
  sketch: SketchInput,
  variables?: Parameters<ReturnType<PlanegcsBackend['createSystem']>['update']>[1],
) => {
  const system = backend.createSystem();
  return { system, result: system.update(sketch, variables) };
};

const with_ = (sketch: SketchInput, ...constraints: SketchConstraint[]): SketchInput => ({
  entities: sketch.entities,
  constraints: [...sketch.constraints, ...constraints],
});

const close = (a: Vec2, b: Vec2, digits = 7) => {
  expect(a[0]).toBeCloseTo(b[0], digits);
  expect(a[1]).toBeCloseTo(b[1], digits);
};

/** The same outcome as a fresh load: status and diagnosis, and coordinates to rounding. */
const sameResult = (a: SolveResult, b: SolveResult) => {
  expect(a.status).toBe(b.status);
  expect(a.diagnosis).toEqual(b.diagnosis);
  const pa = packCoordinates(a.entities);
  const pb = packCoordinates(b.entities);
  expect(pa.length).toBe(pb.length);
  pa.forEach((v, i) => expect(v).toBeCloseTo(pb[i]!, 9));
};

describe('rectangle: DOF', () => {
  it('goes 16 -> 8 -> 4 -> 2 -> 0 as constraints are added', () => {
    const dofs = RECT_STAGES.map(
      (_, i) =>
        solve(rectangle({ stages: RECT_STAGES.slice(0, i + 1), perturb: 2 })).result.diagnosis.dof,
    );
    expect(dofs).toEqual([16, 8, 4, 2, 0]);
  });

  it('the JS analysis agrees with planegcs at every stage', () => {
    for (let i = 0; i < RECT_STAGES.length; i++) {
      const { system, result } = solve(
        rectangle({ stages: RECT_STAGES.slice(0, i + 1), perturb: 2 }),
      );
      expect(system.lastAnalysis?.dof).toBe(result.diagnosis.dof);
    }
  });

  it('a fully constrained rectangle has DOF 0, every entity fully constrained, nothing redundant', () => {
    const { result } = solve(rectangle({ perturb: 2 }));
    expect(result.status).toBe('solved');
    expect(result.diagnosis).toEqual({
      dof: 0,
      conflicting: [],
      redundant: [],
      partiallyRedundant: [],
      entities: { bottom: 'fully', right: 'fully', top: 'fully', left: 'fully' },
    });
  });

  it('solves a perturbed start to the exact rectangle', () => {
    const { result } = solve(rectangle({ perturb: 2 }));
    const bottom = entity(result.entities, 'bottom', 'line');
    const right = entity(result.entities, 'right', 'line');
    close(bottom.start, [0, 0]);
    close(bottom.end, [40, 0]);
    close(right.end, [40, 25]);
  });

  it('without the anchor every entity is under-constrained (the rectangle can slide)', () => {
    const { result } = solve(
      rectangle({ stages: ['geometry', 'coincident', 'hv', 'dimensions'], perturb: 1 }),
    );
    expect(result.diagnosis.dof).toBe(2);
    expect(Object.values(result.diagnosis.entities)).toEqual(['under', 'under', 'under', 'under']);
  });

  it('reports per-entity status when only part of a sketch is constrained', () => {
    const sketch: SketchInput = {
      entities: [...rectangle({ perturb: 1 }).entities, line('free', [60, 0], [80, 10])],
      constraints: rectangle({ perturb: 1 }).constraints,
    };
    const { result } = solve(sketch);
    expect(result.diagnosis.dof).toBe(4);
    expect(result.diagnosis.entities).toMatchObject({
      bottom: 'fully',
      left: 'fully',
      free: 'under',
    });
  });

  it('a line with one fixed end is under-constrained, and fully once its other end is fixed', () => {
    const l = line('l', [0, 0], [10, 5]);
    const half = solve({
      entities: [l],
      constraints: [{ id: 'f1', kind: 'fix', point: start('l') }],
    }).result;
    expect(half.diagnosis).toMatchObject({ dof: 2, entities: { l: 'under' } });
    const both = solve({
      entities: [l],
      constraints: [
        { id: 'f1', kind: 'fix', point: start('l') },
        { id: 'f2', kind: 'fix', point: end('l') },
      ],
    }).result;
    expect(both.diagnosis).toMatchObject({ dof: 0, entities: { l: 'fully' } });
  });

  it('a partly determined entity: a point on a fixed horizontal line keeps one DOF', () => {
    // Fixed y, free x: the point is under-constrained even though one of its
    // coordinates is determined.
    const sketch: SketchInput = {
      entities: [point('p', [3, 4])],
      constraints: [{ id: 'on', kind: 'pointOnObject', point: { entity: 'p' }, on: SKETCH_X_AXIS }],
    };
    const { system, result } = solve(sketch);
    expect(result.diagnosis).toMatchObject({ dof: 1, entities: { p: 'under' } });
    close(pointAt(result.entities, { entity: 'p' }), [3, 0]);
    // The layout puts p after the 6 built-in parameters: x free, y determined.
    expect(Array.from(system.lastAnalysis!.determined.slice(6, 8))).toEqual([0, 1]);
  });
});

describe('redundant and conflicting constraints', () => {
  const full = () => rectangle({ perturb: 2 });

  it('a redundant constraint is reported with its id; DOF stays 0; the sketch still solves', () => {
    const { result } = solve(
      with_(full(), {
        id: 'dup',
        kind: 'distance',
        a: start('bottom'),
        b: end('bottom'),
        value: mm(40),
      }),
    );
    expect(result.status).toBe('solved');
    expect(result.diagnosis).toMatchObject({ dof: 0, redundant: ['dup'], conflicting: [] });
    expect(result.diagnosis.entities.bottom).toBe('over');
    expect(result.diagnosis.entities.top).toBe('fully');
  });

  it('blames the newest of equivalent constraints (creation order decides)', () => {
    const sketch = full();
    const constraints = [...sketch.constraints];
    const at = constraints.findIndex((c) => c.id === 'width');
    constraints.splice(at, 0, {
      id: 'older',
      kind: 'distance',
      a: start('bottom'),
      b: end('bottom'),
      value: mm(40),
    });
    const { result } = solve({ entities: sketch.entities, constraints });
    expect(result.diagnosis.redundant).toEqual(['width']);
  });

  it('a horizontal constraint on an already horizontal line is redundant', () => {
    const { result } = solve(
      with_(full(), { id: 'h2', kind: 'horizontal', a: start('bottom'), b: end('bottom') }),
    );
    expect(result.diagnosis).toMatchObject({ redundant: ['h2'], conflicting: [], dof: 0 });
  });

  it('a contradicting dimension conflicts: the whole group is listed, DOF is null, geometry unchanged', () => {
    const sketch = with_(full(), {
      id: 'x',
      kind: 'distance',
      a: start('bottom'),
      b: end('bottom'),
      value: mm(50),
    });
    const { result } = solve(sketch);
    expect(result.status).toBe('conflicting');
    expect(result.diagnosis.conflicting).toEqual(['width', 'x']);
    expect(result.diagnosis.dof).toBeNull();
    expect(result.entities).toEqual(sketch.entities);
    expect(result.message).toContain('width, x');
    expect(result.diagnosis.entities.bottom).toBe('over');
  });

  it('three constraints fighting over one line are all listed', () => {
    const sketch = with_(full(), {
      id: 'slant',
      kind: 'angle',
      a: SKETCH_X_AXIS,
      b: 'bottom',
      value: deg(10),
    });
    const { result } = solve(sketch);
    expect(result.status).toBe('conflicting');
    expect(result.diagnosis.conflicting).toContain('slant');
    expect(result.diagnosis.conflicting).toContain('h-bottom');
  });

  it('removing the redundant constraint clears it (incremental removal)', () => {
    const system = backend.createSystem();
    const dup: SketchConstraint = {
      id: 'dup',
      kind: 'distance',
      a: start('bottom'),
      b: end('bottom'),
      value: mm(40),
    };
    expect(system.update(with_(full(), dup)).diagnosis.redundant).toEqual(['dup']);
    const r = system.update(full());
    expect(r.diagnosis).toMatchObject({ dof: 0, redundant: [], conflicting: [] });
  });

  it('a value edit that turns a redundant constraint into a conflict is re-diagnosed', () => {
    // planegcs caches its diagnosis until a constraint is added or removed, so
    // this needs the rebuild the wrapper does while anything is redundant.
    const system = backend.createSystem();
    const diag = (value: string): SketchConstraint => ({
      id: 'diag',
      kind: 'distance',
      a: start('bottom'),
      b: end('right'),
      value: mm(value),
    });
    const first = system.update(with_(full(), diag(String(Math.hypot(40, 25)))));
    expect(first.diagnosis.redundant).toEqual(['diag']);
    const second = system.update(with_(full(), diag('50')));
    expect(second.status).toBe('conflicting');
    expect(second.diagnosis.conflicting).toContain('diag');
    expect(second.diagnosis.conflicting).toContain('width');
  });
});

describe('tangent arc (rounded rectangle)', () => {
  it('goes 21 -> 11 -> 7 -> 5 -> 2 -> 0 DOF, agreeing with the JS analysis', () => {
    const dofs = ROUNDED_STAGES.map((_, i) => {
      const { system, result } = solve(
        roundedRectangle(ROUNDED_STAGES.slice(0, i + 1) as Stage[], 1),
      );
      expect(system.lastAnalysis?.dof).toBe(result.diagnosis.dof);
      return result.diagnosis.dof;
    });
    expect(dofs).toEqual([21, 11, 7, 5, 2, 0]);
  });

  it('solves: centre (34, 19), radius 6, endpoints on the joints, every entity fully constrained', () => {
    const { result } = solve(roundedRectangle(ROUNDED_STAGES, 1));
    expect(result.status).toBe('solved');
    expect(result.diagnosis).toMatchObject({ dof: 0, redundant: [], conflicting: [] });
    const a = entity(result.entities, 'arc', 'arc');
    close(a.center, [34, 19]);
    close(a.start, [40, 19]);
    close(a.end, [34, 25]);
    close(entity(result.entities, 'right', 'line').end, [40, 19]);
    close(entity(result.entities, 'top', 'line').start, [34, 25]);
    expect(Object.values(result.diagnosis.entities).every((s) => s === 'fully')).toBe(true);
  });

  it('endpoint tangency stays regular at the exact solution (no false redundancy)', () => {
    const { result } = solve(roundedRectangle(ROUNDED_STAGES, 0));
    expect(result.diagnosis).toMatchObject({ dof: 0, redundant: [], conflicting: [] });
  });

  it('a line running into the arc against its direction is joined with angle pi and still solves', () => {
    // The right line runs downwards here (its start is at the arc), so the
    // curves meet at pi, not 0.
    const base = roundedRectangle(ROUNDED_STAGES, 0.5);
    const right = entity(base.entities, 'right', 'line');
    const entities: SketchEntity[] = base.entities.map((e) =>
      e.id === 'right' ? { ...right, start: right.end, end: right.start } : e,
    );
    const flip = (r: PointRef): PointRef =>
      r.entity === 'right' ? { entity: 'right', at: r.at === 'start' ? 'end' : 'start' } : r;
    const constraints = base.constraints.map((c): SketchConstraint => {
      if (c.kind === 'coincident') return { ...c, a: flip(c.a), b: flip(c.b) };
      if (c.kind === 'tangent' && c.a === 'right') return { ...c, at: ['start', 'start'] };
      return c;
    });
    const { result } = solve({ entities, constraints });
    expect(result.status).toBe('solved');
    expect(result.diagnosis.dof).toBe(0);
    close(entity(result.entities, 'arc', 'arc').center, [34, 19]);
    close(entity(result.entities, 'right', 'line').start, [40, 19]);
  });

  it('an arc edge-tangent to a line and a circle tangent to both axes', () => {
    const sketch: SketchInput = {
      entities: [
        circle('c', [12, 9], 4),
        line('l', [0, 20], [30, 21]),
        arc('a', [10, 30], [15, 30], [5, 30.5]),
      ],
      constraints: [
        { id: 'r', kind: 'radius', entity: 'c', value: mm(5) },
        { id: 'tx', kind: 'tangent', a: SKETCH_X_AXIS, b: 'c' },
        { id: 'ty', kind: 'tangent', a: 'c', b: SKETCH_Y_AXIS },
        { id: 'hl', kind: 'horizontal', line: 'l' },
        { id: 'ta', kind: 'tangent', a: 'l', b: 'a' },
        { id: 'ra', kind: 'radius', entity: 'a', value: mm(3) },
      ],
    };
    const { result } = solve(sketch);
    expect(result.status).toBe('solved');
    const c = entity(result.entities, 'c', 'circle');
    close(c.center, [5, 5]);
    const l = entity(result.entities, 'l', 'line');
    const a = entity(result.entities, 'a', 'arc');
    expect(Math.abs(a.center[1] - l.start[1])).toBeCloseTo(3, 7);
  });

  it('two circles tangent externally and internally', () => {
    const ext = solve({
      entities: [circle('a', [0, 0], 5), circle('b', [12, 0], 3)],
      constraints: [
        { id: 'fa', kind: 'fix', point: center('a') },
        { id: 't', kind: 'tangent', a: 'a', b: 'b' },
      ],
    }).result;
    const ea = entity(ext.entities, 'a', 'circle');
    const eb = entity(ext.entities, 'b', 'circle');
    expect(Math.hypot(eb.center[0] - ea.center[0], eb.center[1] - ea.center[1])).toBeCloseTo(
      ea.radius + eb.radius,
      7,
    );

    const int = solve({
      entities: [circle('a', [0, 0], 10), circle('b', [1, 0], 3)],
      constraints: [{ id: 't', kind: 'tangent', a: 'a', b: 'b' }],
    }).result;
    const ia = entity(int.entities, 'a', 'circle');
    const ib = entity(int.entities, 'b', 'circle');
    expect(Math.hypot(ib.center[0] - ia.center[0], ib.center[1] - ia.center[1])).toBeCloseTo(
      ia.radius - ib.radius,
      7,
    );
  });
});

describe('every constraint kind', () => {
  const l1 = line('l1', [1, 1], [11, 3]);
  const l2 = line('l2', [2, 8], [9, 12]);
  const run = (entities: SketchEntity[], constraints: SketchConstraint[]) => {
    const { result } = solve({ entities, constraints });
    expect(result.status, result.message).toBe('solved');
    return result.entities;
  };
  const dir = (l: SketchEntity) => {
    const e = l as Extract<SketchEntity, { kind: 'line' }>;
    return [e.end[0] - e.start[0], e.end[1] - e.start[1]] as const;
  };
  const length = (l: SketchEntity) => Math.hypot(...dir(l));

  it('coincident', () => {
    const r = run([l1, l2], [{ id: 'c', kind: 'coincident', a: end('l1'), b: start('l2') }]);
    close(pointAt(r, end('l1')), pointAt(r, start('l2')));
  });

  it('horizontal and vertical, on lines and on point pairs', () => {
    const r = run(
      [l1, l2, point('p', [5, 5]), point('q', [7, 9])],
      [
        { id: 'h', kind: 'horizontal', line: 'l1' },
        { id: 'v', kind: 'vertical', line: 'l2' },
        { id: 'hp', kind: 'horizontal', a: { entity: 'p' }, b: { entity: 'q' } },
        { id: 'vp', kind: 'vertical', a: { entity: 'p' }, b: ORIGIN },
      ],
    );
    expect(dir(r[0]!)[1]).toBeCloseTo(0, 9);
    expect(dir(r[1]!)[0]).toBeCloseTo(0, 9);
    expect(pointAt(r, { entity: 'p' })[1]).toBeCloseTo(pointAt(r, { entity: 'q' })[1], 9);
    expect(pointAt(r, { entity: 'p' })[0]).toBeCloseTo(0, 9);
  });

  it('parallel and perpendicular', () => {
    const r = run([l1, l2], [{ id: 'p', kind: 'parallel', a: 'l1', b: 'l2' }]);
    const [ax, ay] = dir(r[0]!);
    const [bx, by] = dir(r[1]!);
    expect((ax * by - ay * bx) / (length(r[0]!) * length(r[1]!))).toBeCloseTo(0, 9);
    const q = run([l1, l2], [{ id: 'q', kind: 'perpendicular', a: 'l1', b: 'l2' }]);
    const [cx, cy] = dir(q[0]!);
    const [dx, dy] = dir(q[1]!);
    expect((cx * dx + cy * dy) / (length(q[0]!) * length(q[1]!))).toBeCloseTo(0, 9);
  });

  it('equal lengths and equal radii', () => {
    const r = run([l1, l2], [{ id: 'e', kind: 'equal', a: 'l1', b: 'l2' }]);
    expect(length(r[0]!)).toBeCloseTo(length(r[1]!), 9);
    const c = run(
      [circle('c', [0, 0], 3), arc('a', [10, 0], [14, 0], [10, 4])],
      [{ id: 'e', kind: 'equal', a: 'c', b: 'a' }],
    );
    const a = entity(c, 'a', 'arc');
    expect(entity(c, 'c', 'circle').radius).toBeCloseTo(
      Math.hypot(a.start[0] - a.center[0], a.start[1] - a.center[1]),
      9,
    );
  });

  it('distance between points and from a point to a line', () => {
    const r = run(
      [l1, point('p', [4, 6])],
      [
        { id: 'len', kind: 'distance', a: start('l1'), b: end('l1'), value: mm(20) },
        { id: 'pl', kind: 'distance', point: { entity: 'p' }, line: 'l1', value: mm(7.5) },
      ],
    );
    expect(length(r[0]!)).toBeCloseTo(20, 9);
    const l = entity(r, 'l1', 'line');
    const p = pointAt(r, { entity: 'p' });
    const [dx, dy] = dir(l);
    expect(
      Math.abs(dx * (p[1] - l.start[1]) - dy * (p[0] - l.start[0])) / Math.hypot(dx, dy),
    ).toBeCloseTo(7.5, 9);
  });

  it('horizontal and vertical distances are signed (b minus a)', () => {
    const r = run(
      [point('p', [1, 1]), point('q', [3, 3])],
      [
        { id: 'fp', kind: 'fix', point: { entity: 'p' } },
        {
          id: 'dx',
          kind: 'horizontalDistance',
          a: { entity: 'p' },
          b: { entity: 'q' },
          value: mm(-12),
        },
        {
          id: 'dy',
          kind: 'verticalDistance',
          a: { entity: 'p' },
          b: { entity: 'q' },
          value: mm(5),
        },
      ],
    );
    close(pointAt(r, { entity: 'q' }), [-11, 6]);
  });

  it('angle from line a to line b, counter-clockwise', () => {
    const r = run(
      [line('l', [0, 0], [10, 1])],
      [
        { id: 'f', kind: 'fix', point: start('l') },
        { id: 'len', kind: 'distance', a: start('l'), b: end('l'), value: mm(10) },
        { id: 'a', kind: 'angle', a: SKETCH_X_AXIS, b: 'l', value: deg(30) },
      ],
    );
    close(pointAt(r, end('l')), [10 * Math.cos(Math.PI / 6), 10 * Math.sin(Math.PI / 6)]);
  });

  it('radius and diameter of circles and arcs', () => {
    const r = run(
      [circle('c', [0, 0], 3), arc('a', [10, 0], [14, 0], [10, 4]), circle('d', [20, 0], 2)],
      [
        { id: 'rc', kind: 'radius', entity: 'c', value: mm(7) },
        { id: 'ra', kind: 'radius', entity: 'a', value: mm(2.5) },
        { id: 'dd', kind: 'diameter', entity: 'd', value: mm(9) },
      ],
    );
    expect(entity(r, 'c', 'circle').radius).toBeCloseTo(7, 9);
    const a = entity(r, 'a', 'arc');
    expect(Math.hypot(a.end[0] - a.center[0], a.end[1] - a.center[1])).toBeCloseTo(2.5, 9);
    expect(entity(r, 'd', 'circle').radius).toBeCloseTo(4.5, 9);
  });

  it('fix holds a point while the rest moves', () => {
    const r = run(
      [l1],
      [
        { id: 'f', kind: 'fix', point: start('l1') },
        { id: 'len', kind: 'distance', a: start('l1'), b: end('l1'), value: mm(3) },
      ],
    );
    close(pointAt(r, start('l1')), [1, 1]);
    expect(length(r[0]!)).toBeCloseTo(3, 9);
  });

  it('midpoint', () => {
    const r = run(
      [l1, point('m', [0, 0])],
      [{ id: 'm', kind: 'midpoint', point: { entity: 'm' }, line: 'l1' }],
    );
    const l = entity(r, 'l1', 'line');
    close(pointAt(r, { entity: 'm' }), [(l.start[0] + l.end[0]) / 2, (l.start[1] + l.end[1]) / 2]);
  });

  it('point on a line, a circle and an arc', () => {
    const r = run(
      [
        l1,
        circle('c', [20, 0], 5),
        arc('a', [0, 20], [4, 20], [0, 24]),
        point('p', [5, 9]),
        point('q', [20, 9]),
        point('s', [3, 23]),
      ],
      [
        { id: 'pl', kind: 'pointOnObject', point: { entity: 'p' }, on: 'l1' },
        { id: 'pc', kind: 'pointOnObject', point: { entity: 'q' }, on: 'c' },
        { id: 'pa', kind: 'pointOnObject', point: { entity: 's' }, on: 'a' },
      ],
    );
    const l = entity(r, 'l1', 'line');
    const p = pointAt(r, { entity: 'p' });
    const [dx, dy] = dir(l);
    expect(dx * (p[1] - l.start[1]) - dy * (p[0] - l.start[0])).toBeCloseTo(0, 9);
    const c = entity(r, 'c', 'circle');
    const q = pointAt(r, { entity: 'q' });
    expect(Math.hypot(q[0] - c.center[0], q[1] - c.center[1])).toBeCloseTo(c.radius, 9);
    const a = entity(r, 'a', 'arc');
    const s = pointAt(r, { entity: 's' });
    expect(Math.hypot(s[0] - a.center[0], s[1] - a.center[1])).toBeCloseTo(
      Math.hypot(a.start[0] - a.center[0], a.start[1] - a.center[1]),
      9,
    );
  });

  it('symmetric about a line and about a point', () => {
    const r = run(
      [point('a', [-3, 2]), point('b', [4, 1])],
      [
        { id: 'fa', kind: 'fix', point: { entity: 'a' } },
        { id: 's', kind: 'symmetric', a: { entity: 'a' }, b: { entity: 'b' }, line: SKETCH_Y_AXIS },
      ],
    );
    close(pointAt(r, { entity: 'b' }), [3, 2]);
    const q = run(
      [point('a', [-3, 2]), point('b', [4, 1]), point('c', [1, 1])],
      [
        { id: 'fa', kind: 'fix', point: { entity: 'a' } },
        { id: 'fc', kind: 'fix', point: { entity: 'c' } },
        {
          id: 's',
          kind: 'symmetric',
          a: { entity: 'a' },
          b: { entity: 'b' },
          center: { entity: 'c' },
        },
      ],
    );
    close(pointAt(q, { entity: 'b' }), [5, 0]);
  });
});

describe('expressions', () => {
  it('evaluates dimension expressions with the caller variables and stored units', () => {
    const sketch = rectangle({ perturb: 1 });
    const constraints = sketch.constraints.map((c): SketchConstraint => {
      if (c.id === 'width') return { ...c, value: mm('2 * #t + 1/2"') } as SketchConstraint;
      if (c.id === 'height')
        return {
          ...c,
          value: { source: '1', lengthUnit: 'in', angleUnit: 'deg' },
        } as SketchConstraint;
      return c;
    });
    const vars = new Map([['t', lengthQuantity(10)]]);
    const { result } = solve(
      { entities: sketch.entities, constraints },
      { variables: (n) => vars.get(n) },
    );
    expect(result.status).toBe('solved');
    close(pointAt(result.entities, end('right')), [20 + 12.7, 25.4]);
  });

  it('an unknown variable is an invalid input with the units error and its range', () => {
    const sketch = rectangle();
    const constraints = sketch.constraints.map((c) =>
      c.id === 'width' ? ({ ...c, value: mm('#missing + 1') } as SketchConstraint) : c,
    );
    const { result } = solve({ entities: sketch.entities, constraints });
    expect(result.status).toBe('invalid');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      code: 'expression',
      constraintId: 'width',
      error: { code: 'unknown-variable', start: 0, end: 8 },
    });
    expect(result.entities).toEqual(sketch.entities);
  });

  it('a variable edit is a value change: no rebuild, same solver parameters', () => {
    const system = backend.createSystem();
    const sketch = rectangle({ perturb: 1 });
    const constraints = sketch.constraints.map((c) =>
      c.id === 'width' ? ({ ...c, value: mm('#w') } as SketchConstraint) : c,
    );
    const run = (w: number) =>
      system.update(
        { entities: sketch.entities, constraints },
        { variables: (n) => (n === 'w' ? lengthQuantity(w) : undefined) },
      );
    run(40);
    const params = system.solverParamCount;
    for (const w of [30, 55, 41]) {
      const r = run(w);
      expect(r.status).toBe('solved');
      expect(pointAt(r.entities, end('bottom'))[0]).toBeCloseTo(w, 9);
    }
    expect(system.solverParamCount).toBe(params);
  });
});

describe('incremental updates', () => {
  it('adding constraints one by one gives the same diagnosis as loading them at once', () => {
    const system = backend.createSystem();
    const full = rectangle({ perturb: 2 });
    let last;
    for (let i = 0; i <= full.constraints.length; i++) {
      last = system.update({ entities: full.entities, constraints: full.constraints.slice(0, i) });
      expect(last.status).toBe('solved');
    }
    expect(last!.diagnosis).toEqual(solve(full).result.diagnosis);
  });

  it('a later added duplicate is the one blamed, even when its id sorts first', () => {
    const system = backend.createSystem();
    const full = rectangle({ perturb: 2 });
    system.update(full);
    const r = system.update(
      with_(full, {
        id: 'a-dup',
        kind: 'distance',
        a: start('bottom'),
        b: end('bottom'),
        value: mm(40),
      }),
    );
    expect(r.diagnosis.redundant).toEqual(['a-dup']);
  });

  it('removing and re-adding constraints keeps the solver consistent', () => {
    const system = backend.createSystem();
    const full = rectangle({ perturb: 2 });
    system.update(full);
    const without = system.update({
      entities: full.entities,
      constraints: full.constraints.filter((c) => c.id !== 'height'),
    });
    expect(without.diagnosis.dof).toBe(1);
    const back = system.update({ entities: without.entities, constraints: full.constraints });
    expect(back.diagnosis.dof).toBe(0);
    close(pointAt(back.entities, end('right')), [40, 25]);
  });

  it('a changed constraint (same id, new references) is replaced', () => {
    const system = backend.createSystem();
    const full = rectangle({ perturb: 1 });
    system.update(full);
    const constraints = full.constraints.map((c) =>
      c.id === 'height' ? ({ ...c, a: start('left'), b: end('left') } as SketchConstraint) : c,
    );
    const r = system.update({ entities: full.entities, constraints });
    expect(r.diagnosis).toMatchObject({ dof: 0, redundant: [] });
  });

  it('a new entity rebuilds; the starting point is the caller coordinates', () => {
    const system = backend.createSystem();
    const full = rectangle({ perturb: 1 });
    const first = system.update(full);
    const r = system.update({
      entities: [...first.entities, point('p', [7, 7])],
      constraints: full.constraints,
    });
    expect(r.diagnosis).toMatchObject({ dof: 2, entities: { p: 'under', bottom: 'fully' } });
    close(pointAt(r.entities, { entity: 'p' }), [7, 7]);
  });

  it('invalid input leaves the loaded sketch as it was', () => {
    const system = backend.createSystem();
    const full = rectangle({ perturb: 1 });
    const good = system.update(full);
    const bad = system.update(
      with_(full, { id: 'x', kind: 'coincident', a: start('nope'), b: ORIGIN }),
    );
    expect(bad.status).toBe('invalid');
    expect(bad.issues[0]).toMatchObject({ code: 'unknown-entity', constraintId: 'x' });
    const again = system.update({ entities: good.entities, constraints: full.constraints });
    expect(again.diagnosis).toEqual(good.diagnosis);
  });

  it('the construction flag is carried through solving', () => {
    const sketch: SketchInput = {
      entities: [line('c', [0, 0], [5, 1], true), line('l', [0, 3], [5, 4])],
      constraints: [{ id: 'h', kind: 'horizontal', line: 'c' }],
    };
    const { result } = solve(sketch);
    expect(result.entities.map((e) => e.construction)).toEqual([true, false]);
  });

  it('a fixed point whose stored coordinates change is pinned where it now is, as a fresh load would', () => {
    const at = (x: number, y: number): SketchInput => ({
      entities: [line('l', [x, y], [x + 10, y + 1])],
      constraints: [
        { id: 'f', kind: 'fix', point: start('l') },
        { id: 'h', kind: 'horizontal', line: 'l' },
        { id: 'd', kind: 'distance', a: start('l'), b: end('l'), value: mm(10) },
      ],
    });
    const system = backend.createSystem();
    const first = system.update(at(0, 0));
    close(pointAt(first.entities, start('l')), [0, 0]);
    // Same ids, same constraints, the stored point moved: no rebuild, and no stale pin.
    const moved = system.update(at(5, 5));
    expect(moved.status).toBe('solved');
    close(pointAt(moved.entities, start('l')), [5, 5]);
    close(pointAt(moved.entities, end('l')), [15, 5]);
    sameResult(moved, solve(at(5, 5)).result);
    // And back again, still without history.
    close(pointAt(system.update(at(-2, 3)).entities, start('l')), [-2, 3]);
  });

  it('an endpoint tangency takes 0 or pi from the incoming geometry on every update', () => {
    // The arc leaves (10, 0) heading +x. The line arrives there heading +x
    // (a smooth continuation, 0) or heading -x (a turn back, pi).
    const joint = (fromX: number): SketchInput => ({
      entities: [line('l', [fromX, 0], [10, 0]), arc('a', [10, 5], [10, 0], [15, 5])],
      constraints: [{ id: 't', kind: 'tangent', a: 'l', b: 'a', at: ['end', 'start'] }],
    });
    const heading = (entities: SketchEntity[]) => {
      const l = entity(entities, 'l', 'line');
      const a = entity(entities, 'a', 'arc');
      const [lx, ly] = [l.end[0] - l.start[0], l.end[1] - l.start[1]];
      const [ax, ay] = [-(a.start[1] - a.center[1]), a.start[0] - a.center[0]];
      return (lx * ax + ly * ay) / (Math.hypot(lx, ly) * Math.hypot(ax, ay));
    };
    const system = backend.createSystem();
    expect(heading(system.update(joint(0)).entities)).toBeCloseTo(1, 9);
    const back = system.update(joint(20));
    expect(back.status).toBe('solved');
    expect(heading(back.entities)).toBeCloseTo(-1, 9);
    close(pointAt(back.entities, start('l')), [20, 0]);
    sameResult(back, solve(joint(20)).result);
  });

  it('two tangent circles take internal or external from the incoming geometry on every update', () => {
    const pair = (x: number): SketchInput => ({
      entities: [circle('c1', [0, 0], 5), circle('c2', [x, 0], 2)],
      constraints: [
        { id: 'f', kind: 'fix', point: center('c1') },
        { id: 'r1', kind: 'radius', entity: 'c1', value: mm(5) },
        { id: 'r2', kind: 'radius', entity: 'c2', value: mm(2) },
        { id: 't', kind: 'tangent', a: 'c1', b: 'c2' },
      ],
    });
    const gap = (entities: SketchEntity[]) => pointAt(entities, center('c2'))[0];
    const system = backend.createSystem();
    expect(gap(system.update(pair(3.5)).entities)).toBeCloseTo(3, 9); // internal
    const outside = system.update(pair(9));
    expect(outside.status).toBe('solved');
    expect(gap(outside.entities)).toBeCloseTo(7, 9); // external
    sameResult(outside, solve(pair(9)).result);
    expect(gap(system.update(pair(2)).entities)).toBeCloseTo(3, 9); // internal again
  });

  it('many incremental edits stay bounded (orphaned solver parameters trigger a rebuild)', () => {
    const system = backend.createSystem();
    const full = rectangle({ perturb: 1 });
    system.update(full);
    const base = system.solverParamCount;
    for (let i = 0; i < 400; i++) {
      const c: SketchConstraint = {
        id: `d${i}`,
        kind: 'distance',
        a: start('bottom'),
        b: end('top'),
        value: mm(10 + i),
      };
      const partial = {
        entities: full.entities,
        constraints: full.constraints.filter((x) => x.id !== 'height'),
      };
      system.update(with_(partial, c));
    }
    expect(system.solverParamCount).toBeLessThan(base + 300);
  });
});

describe('dragging', () => {
  const underRect = () => rectangle({ stages: ['geometry', 'coincident', 'hv', 'anchor'] });

  it('the dragged point follows the target and the rest follows the constraints', () => {
    const system = backend.createSystem();
    const loaded = system.update(underRect());
    expect(loaded.diagnosis.dof).toBe(2);
    system.beginDrag(end('right'));
    expect(system.dragging).toBe(true);
    const r = system.drag([60, 30]);
    expect(r.status).toBe('solved');
    const entities = applyCoordinates(loaded.entities, r.coordinates);
    close(pointAt(entities, end('right')), [60, 30]);
    close(pointAt(entities, end('bottom')), [60, 0]);
    close(pointAt(entities, start('left')), [0, 30]);
    const done = system.endDrag();
    expect(system.dragging).toBe(false);
    expect(done.status).toBe('solved');
    // The temporary constraints used no DOF and are gone.
    expect(done.diagnosis.dof).toBe(2);
    close(pointAt(done.entities, end('right')), [60, 30]);
  });

  it('a fully constrained point does not move, and nothing conflicts', () => {
    const system = backend.createSystem();
    system.update(rectangle());
    system.beginDrag(end('right'));
    const r = system.drag([70, 70]);
    const entities = applyCoordinates(rectangle().entities, r.coordinates);
    close(pointAt(entities, end('right')), [40, 25]);
    expect(system.endDrag().diagnosis).toMatchObject({ dof: 0, conflicting: [] });
  });

  it('a partly constrained point slides along what is left free', () => {
    const system = backend.createSystem();
    const sketch: SketchInput = {
      entities: [line('l', [0, 0], [10, 0])],
      constraints: [
        { id: 'f', kind: 'fix', point: start('l') },
        { id: 'h', kind: 'horizontal', line: 'l' },
      ],
    };
    const loaded = system.update(sketch);
    system.beginDrag(end('l'));
    const r = system.drag([25, 8]);
    close(pointAt(applyCoordinates(loaded.entities, r.coordinates), end('l')), [25, 0]);
    system.endDrag();
  });

  it('dragging an arc end keeps the arc on its circle', () => {
    const system = backend.createSystem();
    const sketch: SketchInput = {
      entities: [arc('a', [0, 0], [5, 0], [0, 5])],
      constraints: [
        { id: 'fc', kind: 'fix', point: center('a') },
        { id: 'r', kind: 'radius', entity: 'a', value: mm(5) },
      ],
    };
    const loaded = system.update(sketch);
    system.beginDrag(end('a'));
    const r = system.drag([-10, 10]);
    const a = entity(applyCoordinates(loaded.entities, r.coordinates), 'a', 'arc');
    close(a.end, [-5 / Math.SQRT2, 5 / Math.SQRT2], 6);
    expect(Math.hypot(...a.start)).toBeCloseTo(5, 9);
  });

  it('an update during a drag ends the drag', () => {
    const system = backend.createSystem();
    system.update(underRect());
    system.beginDrag(end('right'));
    system.update(underRect());
    expect(system.dragging).toBe(false);
  });

  it('rejects bad drag requests', () => {
    const system = backend.createSystem();
    expect(() => system.beginDrag(end('right'))).toThrow(/Nothing is loaded/);
    expect(() => system.drag([0, 0])).toThrow(/No drag in progress/);
    system.update(underRect());
    expect(() => system.beginDrag(end('nope'))).toThrow(/unknown entity/);
    expect(() => system.beginDrag(ORIGIN)).toThrow(/cannot be used/);
    expect(() => system.drag([0, 0])).toThrow(/No drag in progress/);
  });
});
