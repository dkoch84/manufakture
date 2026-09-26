// The T0.5 test part, shared by the scenarios and the bench: a 40 x 30 x 20
// block extruded from a rectangle (sketch entities e1 front, e2 right, e3, e4),
// an open slot cut#4 through the front face and a through hole cut#2 that
// breaks through the slot's back wall, both sketched on the top cap, and a
// fillet#3 on one edge reference.

import type { ExtrudeFeature, Feature } from './model.ts';
import type { EdgeRef } from './naming.ts';

export const H = 20;
export const FILLET = 3;
export const TOP = 'extrude#1:cap:end';
export const BOTTOM = 'extrude#1:cap:start';
export const side = (id: string) => `extrude#1:side:${id}`;
export const onTop = { kind: 'face', face: { face: TOP } } as const;

export type Point = readonly [number, number];

export function block(points: Point[], ids: string[]): ExtrudeFeature {
  return {
    kind: 'extrude',
    id: 'extrude#1',
    plane: { kind: 'xy' },
    loop: { kind: 'polygon', points, ids },
    from: 0,
    to: H,
    operation: 'new',
  };
}

export const rectangle = (w: number, d: number) =>
  block(
    [
      [0, 0],
      [w, 0],
      [w, d],
      [0, d],
    ],
    ['e1', 'e2', 'e3', 'e4'],
  );

/** An open slot through the front face (e1), 5 deep. */
export const slot: ExtrudeFeature = {
  kind: 'extrude',
  id: 'cut#4',
  plane: onTop,
  loop: {
    kind: 'polygon',
    points: [
      [15, -1],
      [25, -1],
      [25, 5],
      [15, 5],
    ],
    ids: ['s1', 's2', 's3', 's4'],
  },
  from: 1000,
  to: -5,
  operation: 'cut',
};

/** A through hole that breaks through the slot's back wall (s3). */
export const hole: ExtrudeFeature = {
  kind: 'extrude',
  id: 'cut#2',
  plane: onTop,
  loop: { kind: 'circle', center: [20, 7], radius: 4, id: 'c1' },
  from: 1000,
  to: -1000,
  operation: 'cut',
};

export const fillet = (ref: EdgeRef): Feature => ({
  kind: 'fillet',
  id: 'fillet#3',
  radius: FILLET,
  edges: [{ id: 'r1', ref }],
});
