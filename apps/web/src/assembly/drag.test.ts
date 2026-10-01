// Dragging instances: what a press on an instance grabs, what each move asks the worker for,
// and what the release commits; plus the workspace state that shows the poses meanwhile.

import type { Pose } from '@manufakture/core';
import type { DragResult } from '@manufakture/regen';
import { describe, expect, it, vi } from 'vitest';
import { geometryRef } from '../state/selection';
import type { Assembler } from './assembly';
import { A, LIFTED, apply, twoInstances } from './assembly.test-fixture';
import { instanceDrag, type DragHost } from './drag';
import { createAssemblyUiStore } from './state';

const LID = `${A}/inst#2/extrude#1`;

function step(z: number, moved = true): DragResult {
  const pose: Pose = { translation: [0, 0, z], rotation: [0, 0, 0, 1] };
  return {
    generation: 1,
    assemblyId: A,
    instanceId: 'inst#2',
    outcome: 'solved',
    transforms: { 'inst#1': { translation: [0, 0, 0], rotation: [0, 0, 0, 1] }, 'inst#2': pose },
    moved: moved ? ['inst#2'] : [],
    target: { position: 0, angle: 0, reached: true },
    dof: 1,
    warnings: [],
  };
}

function host(options: { fixed?: boolean } = {}) {
  let doc = twoInstances();
  if (options.fixed) {
    doc = apply(doc, { type: 'editInstance', assemblyId: A, instanceId: 'inst#2', fixed: true });
  }
  const answers: ((r: DragResult | null) => void)[] = [];
  const assembler: Assembler = {
    solve: vi.fn(),
    drag: vi.fn(() => new Promise<DragResult | null>((resolve) => answers.push(resolve))),
    endDrag: vi.fn(),
  };
  const h: DragHost = {
    viewport: {
      // The press lands on the lid's top, 20 mm up; the plane faces +Y.
      surfacePoint: vi.fn(() => [10, 0, 25] as [number, number, number]),
      viewDirection: vi.fn(() => [0, -1, 0] as [number, number, number]),
      canvasToPlane: vi.fn((x: number, y: number) => [x, 0, y] as [number, number, number]),
    },
    assembler,
    assemblyId: () => A,
    document: () => doc,
    transformOf: (id) => (id === 'inst#2' ? LIFTED : undefined),
    show: vi.fn(),
    done: vi.fn(),
    refuse: vi.fn(),
  };
  return { h, assembler, answers };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('instanceDrag', () => {
  it('grabs the point under the cursor in the instance, and commits the last step on release', async () => {
    const { h, assembler, answers } = host();
    const drag = instanceDrag(h);
    expect(drag.start(geometryRef('face', LID, 'top'), { x: 1, y: 2 })).toBe(true);
    drag.move({ x: 10, y: 30 });
    drag.move({ x: 10, y: 40 });
    // The grabbed point in the lid's coordinates (it is 20 mm up), toward the cursor's plane.
    expect(assembler.drag).toHaveBeenLastCalledWith(A, 'inst#2', {
      point: [10, 0, 5],
      position: [10, 0, 40],
    });
    // The worker answers the newest step only.
    answers[0]!(null);
    answers[1]!(step(40));
    await flush();
    expect(h.show).toHaveBeenLastCalledWith(A, new Map(Object.entries(step(40).transforms)));
    drag.move({ x: 10, y: 50 });
    drag.end({ x: 10, y: 50 });
    expect(h.done).not.toHaveBeenCalled();
    answers[2]!(step(50));
    await flush();
    expect(h.done).toHaveBeenCalledWith(
      A,
      { 'inst#2': { translation: [0, 0, 50], rotation: [0, 0, 0, 1] } },
      'Drag Lid 1',
    );
    // Committed: the regen of the new poses replaces the worker's drag state.
    expect(assembler.endDrag).not.toHaveBeenCalled();
  });

  it('leaves fixed instances, other bodies and the background to the camera and selection', () => {
    const fixed = host({ fixed: true });
    const drag = instanceDrag(fixed.h);
    expect(drag.start(geometryRef('face', LID, 'top'), { x: 0, y: 0 })).toBe(false);
    expect(fixed.h.refuse).toHaveBeenCalledWith('Lid 1 is fixed: unfix it to drag it.');
    const free = instanceDrag(host().h);
    expect(free.start(null, { x: 0, y: 0 })).toBe(false);
    expect(free.start(geometryRef('face', 'part#1/extrude#1', 'top'), { x: 0, y: 0 })).toBe(false);
  });

  it('commits nothing when cancelled or when nothing moved', async () => {
    const { h } = host();
    const drag = instanceDrag(h);
    drag.start(geometryRef('face', LID, 'top'), { x: 0, y: 0 });
    drag.move({ x: 1, y: 1 });
    drag.end(null);
    expect(h.done).toHaveBeenCalledWith(A, null, 'Drag Lid 1');
    expect(h.assembler.endDrag).toHaveBeenCalledWith(A);
    const again = host();
    const still = instanceDrag(again.h);
    still.start(geometryRef('face', LID, 'top'), { x: 0, y: 0 });
    still.move({ x: 1, y: 1 });
    still.end({ x: 1, y: 1 });
    again.answers[0]!(step(20, false));
    await flush();
    expect(again.h.done).toHaveBeenCalledWith(A, null, 'Drag Lid 1');
    expect(again.assembler.endDrag).toHaveBeenCalledWith(A);
  });
});

describe('the workspace state', () => {
  it('shows poses for one assembly and keeps them until the model shows the committed document', () => {
    const ui = createAssemblyUiStore();
    ui.getState().open({ kind: 'mate', mateId: null });
    expect(ui.getState().panel).toEqual({ kind: 'mate', mateId: null });
    const poses = new Map([['inst#2', LIFTED]]);
    ui.getState().show(A, poses);
    expect(ui.getState()).toMatchObject({ poses, posesFor: A, until: null });
    const doc = twoInstances();
    ui.getState().holdUntil(doc);
    expect(ui.getState().until).toBe(doc);
    ui.getState().clearPoses();
    expect(ui.getState()).toMatchObject({ posesFor: null, until: null });
    expect(ui.getState().poses.size).toBe(0);
    // Nothing to hold: holding is a no-op.
    ui.getState().holdUntil(doc);
    expect(ui.getState().until).toBeNull();
    ui.getState().close();
    expect(ui.getState().panel).toBeNull();
  });
});
