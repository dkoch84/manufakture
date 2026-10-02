// Exploded views in the assembly workspace (T4.5a): the commands the Explode panel makes, the
// display offsets and trails the viewport takes from regen's resolution (through the shared
// regen function), and the drag that adds a step along an axis.

import { DEFAULT_UNITS, type ExplodedView, type ManufaktureDocument } from '@manufakture/core';
import { evaluateVariables } from '@manufakture/regen';
import { resolveExplodedView } from '@manufakture/regen/explode';
import { describe, expect, it, vi } from 'vitest';
import { geometryRef } from '../state/selection';
import { assemblyBodies } from './assembly';
import { A, LIFTED, apply, model, result, twoInstances } from './assembly.test-fixture';
import {
  addExplodedViewCommand,
  addStepCommand,
  alongAxis,
  axisVector,
  deleteStepCommand,
  directionLabel,
  displayOffsets,
  distanceExpression,
  dragPlaneNormal,
  explodeDrag,
  instanceCentres,
  moveStepCommand,
  newExplodedViewName,
  roundDistance,
  shownExplodedView,
  stepDistanceCommand,
  stepRows,
  worldTrails,
  type ExplodeDragHost,
} from './explode';

const mm = (source: string) => ({ source, lengthUnit: 'mm' as const, angleUnit: 'deg' as const });

/** The two instances, with an exploded view: the lid up 30, then both along +x by 10. */
function exploded(): ManufaktureDocument {
  let doc = twoInstances();
  const add = addExplodedViewCommand(doc.assemblies[0]!);
  doc = apply(doc, add.command);
  const view = () => doc.assemblies[0]!.explodedViews![0]!;
  doc = apply(
    doc,
    addStepCommand(doc.assemblies[0]!, view(), ['inst#2'], { vector: [0, 0, 1] }, mm('30')).command,
  );
  doc = apply(
    doc,
    addStepCommand(
      doc.assemblies[0]!,
      view(),
      ['inst#1', 'inst#2'],
      { vector: [1, 0, 0] },
      mm('10'),
    ).command,
  );
  return doc;
}

/** What regen reports for `doc`'s exploded views at the fixture's solved poses. */
function resolved(doc: ManufaktureDocument) {
  const r = result();
  const poses = new Map(r.instances.map((x) => [x.instanceId, x.transform]));
  r.explodedViews = (doc.assemblies[0]!.explodedViews ?? []).map((v: ExplodedView) =>
    resolveExplodedView(v, {
      variables: evaluateVariables([]),
      instances: new Set(doc.assemblies[0]!.instances.map((x) => x.id)),
      poses,
    }),
  );
  return r;
}

describe('Explode panel commands', () => {
  it('adds views and steps with fresh ids, and reorders, edits and deletes steps', () => {
    const doc = exploded();
    const asm = doc.assemblies[0]!;
    const view = asm.explodedViews![0]!;
    expect(view).toMatchObject({ id: 'explode#1', name: 'Exploded view 1' });
    expect(view.steps.map((s) => [s.id, s.instances])).toEqual([
      ['step#1', ['inst#2']],
      ['step#2', ['inst#1', 'inst#2']],
    ]);
    expect(newExplodedViewName('explode#4')).toBe('Exploded view 4');
    expect(addExplodedViewCommand(asm).id).toBe('explode#2');

    const moved = moveStepCommand(asm, view, 'step#2', -1)!;
    expect(moved.label).toBe('Move step 2 of Exploded view 1 up');
    const after = apply(doc, moved.command).assemblies[0]!.explodedViews![0]!;
    expect(after.steps.map((s) => s.id)).toEqual(['step#2', 'step#1']);
    expect(moveStepCommand(asm, view, 'step#1', -1)).toBeNull();
    expect(moveStepCommand(asm, view, 'step#2', 1)).toBeNull();

    const edit = stepDistanceCommand(asm, view, view.steps[0]!, mm('45'));
    expect(edit.label).toBe('Edit step 1 of Exploded view 1');
    expect(apply(doc, edit.command).assemblies[0]!.explodedViews![0]!.steps[0]!.distance).toEqual(
      mm('45'),
    );
    const del = deleteStepCommand(asm, view, 'step#1');
    expect(apply(doc, del.command).assemblies[0]!.explodedViews![0]!.steps).toHaveLength(1);
  });

  it('labels directions and rows, with what regen said about each step', () => {
    const doc = exploded();
    const asm = doc.assemblies[0]!;
    expect(directionLabel({ vector: [0, 0, -2] }, asm)).toBe('-Z');
    expect(directionLabel({ vector: [1, 1, 0] }, asm)).toBe('(1, 1, 0)');
    expect(directionLabel({ instance: 'inst#1', face: { face: 'f' } }, asm)).toBe(
      'along face of Box 1',
    );
    expect(directionLabel({ instance: 'inst#2', edge: { faces: ['a'] }, flip: true }, asm)).toBe(
      'against edge of Lid 1',
    );
    const view = asm.explodedViews![0]!;
    const r = resolved(doc).explodedViews![0]!;
    r.steps[1]!.warnings.push({ code: 'missing-instance', instances: ['x'], message: 'gone' });
    expect(stepRows(asm, view, r).map((row) => [row.names, row.direction, row.warnings])).toEqual([
      [['Lid 1'], '+Z', []],
      [['Box 1', 'Lid 1'], '+X', ['gone']],
    ]);
    expect(shownExplodedView(asm, 'explode#9')?.id).toBe('explode#1');
    expect(shownExplodedView(asm, null)?.id).toBe('explode#1');
    expect(shownExplodedView(twoInstances().assemblies[0], null)).toBeNull();
  });

  it('writes a dragged distance in the document unit', () => {
    expect(distanceExpression(25.4, DEFAULT_UNITS)).toMatchObject({ source: '25.4' });
    const inches = { ...DEFAULT_UNITS, length: { ...DEFAULT_UNITS.length, unit: 'in' as const } };
    expect(distanceExpression(25.4, inches)).toMatchObject({ source: '1', lengthUnit: 'in' });
  });
});

describe('exploded display', () => {
  it('moves instances by the offsets on top of the solved poses, as the slider plays', () => {
    const doc = exploded();
    const r = resolved(doc);
    const full = displayOffsets(r, 'explode#1', 1);
    expect(full.get('inst#1')).toEqual([10, 0, 0]);
    expect(full.get('inst#2')).toEqual([10, 0, 30]);
    // Half way: the first step done, the second not started.
    expect(displayOffsets(r, 'explode#1', 0.5).get('inst#2')).toEqual([0, 0, 30]);
    expect(displayOffsets(r, 'explode#1', 0).size).toBe(0);
    expect(displayOffsets(r, null, 1).size).toBe(0);
    // A dragged step adds to it.
    const dragging = displayOffsets(r, 'explode#1', 1, { instances: ['inst#1'], move: [0, 5, 0] });
    expect(dragging.get('inst#1')).toEqual([10, 5, 0]);

    const shown = assemblyBodies(doc, A, model([r]), undefined, full);
    expect(shown[0]!.transform!.translation).toEqual([10, 0, 0]);
    expect(shown[1]!.transform!.translation).toEqual([10, 0, 50]);
    expect(shown[1]!.transform!.rotation).toEqual(LIFTED.rotation);
    // The solved poses are as they were.
    expect(r.instances[1]!.transform).toEqual(LIFTED);
  });

  it('draws trails from the middle of each instance, step after step', () => {
    const doc = exploded();
    const r = resolved(doc);
    const bodies = assemblyBodies(doc, A, model([r]));
    const centres = instanceCentres(bodies, A);
    // The fixture's boxes: 40 x 30 x 20 and 40 x 30 x 5, from the origin.
    expect(centres.get('inst#1')).toEqual([20, 15, 10]);
    expect(centres.get('inst#2')).toEqual([20, 15, 2.5]);
    const poses = new Map(r.instances.map((x) => [x.instanceId, x.transform]));
    const trails = worldTrails(r, 'explode#1', 1, poses, centres);
    expect(trails.map((t) => [t.stepId, t.instanceId, t.start, t.end])).toEqual([
      ['step#1', 'inst#2', [20, 15, 22.5], [20, 15, 52.5]],
      ['step#2', 'inst#1', [20, 15, 10], [30, 15, 10]],
      ['step#2', 'inst#2', [20, 15, 52.5], [30, 15, 52.5]],
    ]);
    expect(worldTrails(r, 'explode#1', 0, poses, centres)).toEqual([]);
  });
});

describe('dragging a step along an axis', () => {
  it('measures the cursor along the axis on a plane facing the viewer', () => {
    expect(axisVector('-y')).toEqual([0, -1, 0]);
    expect(alongAxis([1, 1, 1], [0, 0, 1], [5, 9, 4])).toBe(3);
    expect(dragPlaneNormal([0, 0, 1], [0, -1, 0])).toEqual([0, -1, 0]);
    // Looking down the axis: no plane to drag on.
    expect(dragPlaneNormal([0, 0, 1], [0, 0, -1])).toBeNull();
    expect(roundDistance(23.46)).toBe(23);
    expect(roundDistance(4.26)).toBeCloseTo(4.3, 12);
  });

  function host(checked: string[] = []) {
    const h: ExplodeDragHost = {
      viewport: {
        surfacePoint: vi.fn(() => [10, 0, 25] as [number, number, number]),
        viewDirection: vi.fn(() => [0, -1, 0] as [number, number, number]),
        canvasToPlane: vi.fn((x: number, y: number) => [x, 0, y] as [number, number, number]),
      },
      assemblyId: () => A,
      axis: () => '+z',
      instances: () => checked,
      transformOf: (id) => (id === 'inst#2' ? LIFTED : undefined),
      show: vi.fn(),
      done: vi.fn(),
      refuse: vi.fn(),
    };
    return h;
  }
  const LID = geometryRef('face', `${A}/inst#2/extrude#1`, 'extrude#1:cap:end');

  it('moves the grabbed instance along the axis and adds the step on release', () => {
    const h = host();
    const drag = explodeDrag(h);
    expect(drag.start(null, { x: 0, y: 0 })).toBe(false);
    expect(drag.start(LID, { x: 10, y: 25 })).toBe(true);
    // Sideways movement does not count; only the part along +z.
    drag.move({ x: 40, y: 60.3 });
    expect(h.show).toHaveBeenLastCalledWith({ instances: ['inst#2'], move: [0, 0, 35] });
    drag.end({ x: 40, y: 60.3 });
    expect(h.show).toHaveBeenLastCalledWith(null);
    expect(h.done).toHaveBeenCalledWith(['inst#2'], 35);
  });

  it('moves the ticked instances instead, and adds nothing when cancelled or not moved', () => {
    const h = host(['inst#1', 'inst#2']);
    const drag = explodeDrag(h);
    drag.start(LID, { x: 10, y: 25 });
    drag.move({ x: 10, y: 15 });
    expect(h.show).toHaveBeenLastCalledWith({ instances: ['inst#1', 'inst#2'], move: [0, 0, -10] });
    drag.end(null);
    expect(h.done).toHaveBeenLastCalledWith(['inst#1', 'inst#2'], null);
    drag.start(LID, { x: 10, y: 25 });
    drag.end({ x: 10, y: 25 });
    expect(h.done).toHaveBeenLastCalledWith(['inst#1', 'inst#2'], null);
  });

  it('refuses a drag looking straight down the axis', () => {
    const h = host();
    h.viewport.viewDirection = vi.fn(() => [0, 0, -1] as [number, number, number]);
    expect(explodeDrag(h).start(LID, { x: 10, y: 25 })).toBe(false);
    expect(h.refuse).toHaveBeenCalledWith(
      'The view looks along Z: turn it to drag along that axis.',
    );
  });
});
