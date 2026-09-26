// @vitest-environment node
// The session against the real solver (planegcs in Node), plus a hand-driven
// fake for ordering. Coordinates are sketch millimetres; the pick tolerance
// stands for the 10 px the viewport would give.

import { DEFAULT_UNITS } from '@manufakture/core';
import { SolverService, XY_PLANE, type SketchSolverApi } from '@manufakture/sketch';
import type { LineEntity, SketchInput, SolveResult, Vec2 } from '@manufakture/sketch/model';
import { lengthQuantity } from '@manufakture/units';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createSketchSession, type SketchSource } from './session';

const service = new SolverService();
afterAll(() => service.close('sketch#1'));

function source(patch: Partial<SketchSource> = {}): SketchSource {
  return {
    featureId: 'sketch#1',
    isNew: true,
    name: 'Sketch 1',
    placement: XY_PLANE,
    entities: [],
    constraints: [],
    nextEntity: 1,
    nextConstraint: 1,
    units: DEFAULT_UNITS,
    variables: {},
    ...patch,
  };
}

async function started(solver: SketchSolverApi = service, patch: Partial<SketchSource> = {}) {
  const session = createSketchSession(solver);
  session.getState().begin(source(patch));
  await session.getState().idle();
  const s = () => session.getState();
  const at = (p: Vec2, suppress = false) => ({ at: p, tolerance: 0.5, suppress });
  const click = async (p: Vec2, mode: 'replace' | 'add' | 'toggle' = 'replace') => {
    s().pointerMove(at(p));
    s().click({ ...at(p), mode });
    await s().idle();
  };
  const rectangle = async (a: Vec2, b: Vec2) => {
    s().setTool('rectangle');
    await click(a);
    await click(b);
  };
  const dimension = async (on: Vec2, label: Vec2, value: string) => {
    s().setTool('dimension');
    await click(on);
    await click(label);
    const id = s().editing!.id;
    expect(s().setDimensionValue(id, value).ok).toBe(true);
    await s().idle();
    return id;
  };
  return { session, s, at, click, rectangle, dimension };
}

const lines = (sketch: SketchInput) => sketch.entities as LineEntity[];

describe('a sketch session on the real solver', () => {
  it('draws a rectangle snapped to the origin and solves it', async () => {
    const t = await started();
    expect(t.s().solve?.diagnosis.dof).toBe(0); // empty
    await t.rectangle([0.1, -0.1], [40, 25]);
    const { sketch, solve } = t.s();
    expect(sketch.entities.map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(sketch.constraints.map((c) => c.id)).toEqual(
      Array.from({ length: 9 }, (_, i) => `k${i + 1}`),
    );
    expect(lines(sketch)[0]!.start).toEqual([0, 0]);
    expect(solve).toMatchObject({ status: 'solved', diagnosis: { dof: 2, conflicting: [] } });
    expect(t.s().canUndo).toBe(true);
  });

  it('takes the same text typed under other angle units as a new value', async () => {
    const t = await started(service, {
      units: { length: { unit: 'mm' }, angle: { unit: 'rad' } },
      entities: [
        { id: 'e1', kind: 'line', construction: false, start: [0, 0], end: [10, 0] },
        { id: 'e2', kind: 'line', construction: false, start: [0, 0], end: [8, 6] },
      ],
      constraints: [
        {
          id: 'k1',
          kind: 'angle',
          a: 'e1',
          b: 'e2',
          value: { source: '0.5', lengthUnit: 'mm', angleUnit: 'deg' },
        },
      ],
      nextEntity: 3,
      nextConstraint: 2,
    });
    expect(t.s().canUndo).toBe(false);
    // `0.5` meant degrees; typed again under radians it means half a radian.
    expect(t.s().setDimensionValue('k1', '0.5').ok).toBe(true);
    await t.s().idle();
    expect(t.s().sketch.constraints[0]).toMatchObject({
      value: { source: '0.5', angleUnit: 'rad' },
    });
    expect(t.s().canUndo).toBe(true);
    const direction = (l: LineEntity) => Math.atan2(l.end[1] - l.start[1], l.end[0] - l.start[0]);
    const [e1, e2] = lines(t.s().sketch);
    expect(direction(e2!) - direction(e1!)).toBeCloseTo(0.5, 6);
  });

  it('places a dimension at its measured value and takes the typed value as the same step', async () => {
    const t = await started();
    await t.rectangle([0, 0], [40, 25]);
    t.s().setTool('dimension');
    await t.click([20, 0.1]); // the bottom line
    expect(t.s().dimensionPicks).toEqual([{ kind: 'curve', entity: 'e1' }]);
    await t.click([20, -8]); // empty space: place it
    const editing = t.s().editing!;
    expect(editing.fresh).toBe(true);
    const dim = t.s().sketch.constraints.at(-1)!;
    expect(dim).toMatchObject({ id: editing.id, kind: 'distance', value: { source: '40' } });
    expect(t.s().labels[dim.id]).toEqual([20, -8]);

    expect(t.s().setDimensionValue(dim.id, '30').ok).toBe(true);
    await t.s().idle();
    const bottom = lines(t.s().sketch)[0]!;
    expect(bottom.end[0] - bottom.start[0]).toBeCloseTo(30, 9);
    // One undo removes the dimension placed and typed.
    t.s().undo();
    await t.s().idle();
    expect(t.s().sketch.constraints.find((c) => c.id === dim.id)).toBeUndefined();
  });

  it('refuses dimension text that is not a length and leaves the sketch alone', async () => {
    const t = await started(service, { variables: { t: lengthQuantity(4) } });
    await t.rectangle([0, 0], [40, 25]);
    const id = await t.dimension([20, 0], [20, -8], '2*#t');
    const before = t.s().sketch;
    const r = t.s().setDimensionValue(id, '30deg');
    expect(r).toMatchObject({ ok: false, error: { code: 'dimension' } });
    expect(t.s().sketch).toBe(before);
    expect(lines(before)[0]!.end[0]).toBeCloseTo(8, 9);
  });

  it('fully constrains, then blames a conflicting constraint until it is deleted', async () => {
    const t = await started();
    await t.rectangle([0, 0], [40, 25]);
    await t.dimension([20, 0], [20, -8], '40');
    await t.dimension([40, 12], [48, 12], '25');
    expect(t.s().solve?.diagnosis.dof).toBe(0);
    expect(t.s().solve?.diagnosis.entities).toMatchObject({ e1: 'fully', e2: 'fully' });

    t.s().setTool('select');
    await t.click([40, 8]);
    expect(t.s().selection).toEqual([{ kind: 'entity', id: 'e2' }]);
    expect(t.s().applyConstraint('horizontal')).toBe(true);
    await t.s().idle();
    const added = t.s().sketch.constraints.at(-1)!;
    expect(added).toMatchObject({ kind: 'horizontal', line: 'e2' });
    expect(t.s().lastAdded).toEqual([added.id]);
    expect(t.s().solve?.diagnosis.conflicting).toContain(added.id);
    // The geometry keeps its last shape.
    expect(lines(t.s().sketch)[1]!.end).toEqual([40, 25]);

    t.s().deleteConstraint(added.id);
    await t.s().idle();
    expect(t.s().solve?.diagnosis).toMatchObject({ dof: 0, conflicting: [] });
  });

  it('drags a point live and records the whole drag as one undo step', async () => {
    const t = await started();
    await t.rectangle([5, 5], [35, 20]);
    t.s().setTool('select');
    expect(t.s().dragStart(t.at([35, 20]))).toBe(true);
    for (let i = 1; i <= 5; i++) t.s().dragMove(t.at([35 + i, 20 + i]));
    await t.s().dragEnd();
    const [bottom, right, top] = lines(t.s().sketch);
    expect(right!.end[0]).toBeCloseTo(40, 6);
    expect(right!.end[1]).toBeCloseTo(25, 6);
    expect(top!.start).toEqual(right!.end);
    expect(bottom!.start[1]).toBeCloseTo(bottom!.end[1], 9);
    t.s().undo();
    await t.s().idle();
    expect(lines(t.s().sketch)[1]!.end[0]).toBeCloseTo(35, 9);
    expect(t.s().canRedo).toBe(true);
  });

  it('drags a line by its body, moving what is joined to it', async () => {
    const t = await started();
    await t.rectangle([5, 5], [35, 20]);
    t.s().setTool('select');
    expect(t.s().dragStart(t.at([20, 20]))).toBe(true); // the top side
    t.s().dragMove(t.at([20, 24]));
    await t.s().dragEnd();
    const [, right, top, left] = lines(t.s().sketch);
    expect(top!.start[1]).toBeCloseTo(24, 6);
    expect(right!.end[1]).toBeCloseTo(24, 6);
    expect(left!.start[1]).toBeCloseTo(24, 6);
  });

  it('never drags the origin or empty space', async () => {
    const t = await started();
    t.s().setTool('select');
    expect(t.s().dragStart(t.at([0, 0]))).toBe(false);
    expect(t.s().dragStart(t.at([50, 50]))).toBe(false);
  });

  it('chains lines and joins each to the one before by its permanent id', async () => {
    const t = await started();
    t.s().setTool('line');
    await t.click([10, 10]);
    await t.click([30, 10.2]); // inferred horizontal
    await t.click([30.2, 30]); // inferred vertical
    const c = t.s().sketch.constraints;
    expect(c).toContainEqual({ id: 'k1', kind: 'horizontal', line: 'e1' });
    expect(c).toContainEqual({
      id: 'k2',
      kind: 'coincident',
      a: { entity: 'e1', at: 'end' },
      b: { entity: 'e2', at: 'start' },
    });
    expect(c).toContainEqual({ id: 'k3', kind: 'vertical', line: 'e2' });
    t.s().doubleClick();
    expect(t.s().draw).toEqual({ tool: 'line', start: null });
  });

  it('deletes geometry together with the constraints that name it', async () => {
    const t = await started();
    await t.rectangle([0, 0], [40, 25]);
    t.s().setTool('select');
    await t.click([40, 10]);
    t.s().deleteSelection();
    await t.s().idle();
    const { sketch } = t.s();
    expect(sketch.entities.map((e) => e.id)).toEqual(['e1', 'e3', 'e4']);
    for (const c of sketch.constraints) expect(JSON.stringify(c)).not.toContain('"e2"');
    expect(t.s().solve?.status).toBe('solved');
  });

  it('toggles construction on the selection, or for new geometry without one', async () => {
    const t = await started();
    await t.rectangle([0, 0], [40, 25]);
    t.s().setTool('select');
    await t.click([20, 0]);
    t.s().toggleConstruction();
    expect(t.s().sketch.entities.map((e) => e.construction)).toEqual([true, false, false, false]);
    expect(t.s().construction).toBe(false);
    t.s().clearSelection();
    t.s().toggleConstruction();
    expect(t.s().construction).toBe(true);
  });

  it('escapes the shape, then the tool, then the selection', async () => {
    const t = await started();
    t.s().setTool('circle');
    await t.click([5, 5]);
    t.s().escape();
    expect(t.s().draw).toEqual({ tool: 'circle', first: null });
    t.s().escape();
    expect(t.s().tool).toBe('select');
  });

  it('hands back the solved sketch on finish and forgets it', async () => {
    const close = vi.spyOn(service, 'close');
    const t = await started();
    await t.rectangle([0, 0], [10, 10]);
    const done = t.s().finish()!;
    expect(done.source.featureId).toBe('sketch#1');
    expect(done.sketch.entities).toHaveLength(4);
    expect(t.s().active).toBe(false);
    expect(close).toHaveBeenCalledWith('sketch#1');
    close.mockRestore();
  });
});

describe('a sketch session and a slow solver', () => {
  /** A solver whose updates wait until the test answers them. */
  function manualSolver() {
    const pending: { sketch: SketchInput; resolve: (r: SolveResult) => void }[] = [];
    const solver = {
      update: vi.fn(
        (_id: string, sketch: SketchInput) =>
          new Promise<SolveResult>((resolve) => pending.push({ sketch, resolve })),
      ),
      close: vi.fn(async () => {}),
    } as unknown as SketchSolverApi;
    const answer = (i: number, dof: number) => {
      const p = pending[i]!;
      p.resolve({
        status: 'solved',
        entities: [...p.sketch.entities],
        diagnosis: { dof, conflicting: [], redundant: [], partiallyRedundant: [], entities: {} },
        issues: [],
      });
    };
    return { solver, pending, answer };
  }

  it('drops a solve that a newer edit overtook', async () => {
    const m = manualSolver();
    const session = createSketchSession(m.solver);
    const s = () => session.getState();
    s().begin(source());
    const at = (p: Vec2) => ({ at: p, tolerance: 0.5 });
    s().setTool('circle');
    s().click(at([5, 5]));
    s().click(at([7, 5]));
    s().click(at([20, 5]));
    s().click(at([22, 5]));
    expect(m.pending).toHaveLength(3); // begin, and one per circle
    m.answer(2, 6);
    await vi.waitFor(() => expect(s().solve?.diagnosis.dof).toBe(6));
    // The first circle's solve arrives late: ignored.
    m.answer(1, 3);
    m.answer(0, 0);
    await s().idle();
    expect(s().solve?.diagnosis.dof).toBe(6);
    expect(s().solving).toBe(false);
  });

  it('reports a solver that fails outright', async () => {
    const solver = {
      update: vi.fn(async () => {
        throw new Error('worker died');
      }),
      close: vi.fn(async () => {}),
    } as unknown as SketchSolverApi;
    const session = createSketchSession(solver);
    session.getState().begin(source());
    await session.getState().idle();
    expect(session.getState().solverError).toBe('worker died');
  });
});
