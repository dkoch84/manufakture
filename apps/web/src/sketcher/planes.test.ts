import { XY_PLANE, XZ_PLANE, YZ_PLANE } from '@manufakture/sketch/geometry';
import { describe, expect, it } from 'vitest';
import { geometryRef } from '../state/selection';
import { boxBody } from '../viewport/testMeshes';
import { facePlacement, faceTarget, sketchUp } from './planes';
import { sketchView } from './projection';

describe('sketch planes', () => {
  it('puts a sketch on a planar face of a body, found by name', () => {
    const body = boxBody({ id: 'box', min: [-20, -15, 0], size: [40, 30, 20] });
    const top = facePlacement([body], geometryRef('face', 'box', 'box/top'));
    expect(top).toEqual({ origin: [0, 0, 20], normal: [0, 0, 1], xDir: [1, 0, 0] });
    const front = facePlacement([body], geometryRef('face', 'box', 'box/front'))!;
    expect(front.normal).toEqual([0, -1, 0]);
    expect(front.origin).toEqual([0, -15, 10]);
    expect(facePlacement([body], geometryRef('face', 'box', 'box/nothing'))).toBeNull();
    expect(facePlacement([body], geometryRef('edge', 'box', 'box/front|top'))).toBeNull();
    expect(facePlacement([], geometryRef('face', 'box', 'box/top'))).toBeNull();
  });

  it('references a face of a regenerated part, in the frame regen solves the sketch in', () => {
    const body = boxBody({ id: 'part#1', min: [-20, -15, 0], size: [40, 30, 20] });
    const top = geometryRef('face', 'part#1', 'part#1/top');
    // A part body: stored as a reference; the origin is the world origin on the plane.
    expect(faceTarget([body], top, new Set(['part#1']))).toEqual({
      placement: { origin: [0, 0, 20], normal: [0, 0, 1], xDir: [1, 0, 0] },
      face: { face: 'part#1/top' },
    });
    const front = faceTarget(
      [body],
      geometryRef('face', 'part#1', 'part#1/front'),
      new Set(['part#1']),
    )!;
    expect(front.placement.origin).toEqual([0, -15, 0]);
    // Any other body, or a placeholder name: the plane itself, centred on the face.
    expect(faceTarget([body], top)).toEqual({
      placement: { origin: [0, 0, 20], normal: [0, 0, 1], xDir: [1, 0, 0] },
      face: null,
    });
    const placeholder = geometryRef('face', 'part#1', 'part#1/top', { placeholder: true });
    expect(faceTarget([body], placeholder, new Set(['part#1']))!.face).toBeNull();
    expect(
      faceTarget([body], geometryRef('face', 'part#1', 'nothing'), new Set(['part#1'])),
    ).toBeNull();
  });

  it('points the view up along the sketch y axis', () => {
    expect(sketchUp(XY_PLANE)).toEqual([0, 1, 0]);
    expect(sketchUp(XZ_PLANE)).toEqual([0, 0, 1]);
    expect(sketchUp(YZ_PLANE)).toEqual([0, 0, 1]);
  });
});

describe('the sketch projection', () => {
  // A stand-in camera: looking down on XY, 2 px per mm, origin at (100, 100).
  const projector = {
    projectToCanvas: ([x, y]: readonly [number, number, number]) => ({
      x: 100 + 2 * x,
      y: 100 - 2 * y,
    }),
    canvasToPlane: (x: number, y: number) =>
      [(x - 100) / 2, (100 - y) / 2, 0] as [number, number, number],
  };

  it('maps sketch points to the canvas and back', () => {
    const view = sketchView(projector, XY_PLANE);
    expect(view.toCanvas([10, 5])).toEqual({ x: 120, y: 90 });
    expect(view.fromCanvas(120, 90)).toEqual([10, 5]);
    expect(view.unitsPerPixel(0, 0)).toBe(0.5);
  });

  it('falls back to one unit per pixel when the plane is edge on', () => {
    const view = sketchView({ ...projector, canvasToPlane: () => null }, XY_PLANE);
    expect(view.fromCanvas(1, 1)).toBeNull();
    expect(view.unitsPerPixel(1, 1)).toBe(1);
  });
});
