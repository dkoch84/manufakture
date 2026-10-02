import { describe, expect, it } from 'vitest';
import { validateOp } from './ops';

const XY = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };

describe('validateOp', () => {
  it('accepts every op in its documented shape', () => {
    const ops: unknown[] = [
      { op: 'box', size: [1, 2, 3] },
      { op: 'box', size: [1, 2, 3], at: [0, 0, 0], featureId: 'box#1', keep: false },
      { op: 'cylinder', radius: 1, height: 2, axis: [0, 1, 0] },
      {
        op: 'profile',
        frame: XY,
        loops: [
          {
            entities: [
              { kind: 'line', start: [0, 0], end: [1, 0], id: 'e1' },
              { kind: 'arc', center: [1, 1], start: [1, 0], end: [1, 2], clockwise: true },
              { kind: 'line', start: [1, 2], end: [0, 0], id: 'e3#2' },
            ],
          },
          { entities: [{ kind: 'circle', center: [0.5, 0.5], radius: 0.1 }] },
        ],
      },
      { op: 'extrude', profile: 3, distance: 5, history: false },
      { op: 'extrude', profile: { result: 0 }, distance: [0, 0, 1] },
      { op: 'boolean', kind: 'common', shape: 1, tools: [2, { result: 1 }], simplify: true },
      { op: 'fillet', shape: 1, edges: [1, 2], radius: 0.5 },
      { op: 'tessellate', shape: 1 },
      { op: 'tessellate', shape: 1, deflection: { linear: 0.01 } },
      { op: 'topology', shape: { result: 2 } },
      { op: 'properties', shape: 1 },
      { op: 'release', shapes: [] },
      { op: 'measure', shape: 1, targets: [] },
      {
        op: 'measure',
        shape: { result: 0 },
        targets: [
          { kind: 'face', name: 'extrude#1:cap:end' },
          { kind: 'vertex', index: 3 },
        ],
        body: true,
      },
      { op: 'obb', shape: 1 },
      { op: 'obb', shape: { result: 0 }, optimal: false },
    ];
    for (const op of ops) expect(validateOp(op), JSON.stringify(op)).toBeNull();
  });

  it.each([
    [undefined, /must be an object/],
    [[], /must be an object/],
    [{}, /unknown op undefined/],
    [{ op: 'explode' }, /unknown op "explode"/],
    [{ op: 'box' }, /op\.size must be \[number, number, number\]/],
    [{ op: 'box', size: [1, 2, '3'] }, /op\.size/],
    [{ op: 'box', size: [1, 2, 3], at: [0, 0] }, /op\.at/],
    [{ op: 'box', size: [1, 2, 3], keep: 'no' }, /op\.keep must be a boolean/],
    [{ op: 'cylinder', radius: '1', height: 1 }, /op\.radius must be a number/],
    [{ op: 'profile', frame: XY, loops: [] }, /op\.loops must not be empty/],
    [
      { op: 'profile', frame: { ...XY, normal: null }, loops: [{ entities: [] }] },
      /op\.frame\.normal/,
    ],
    [{ op: 'profile', frame: XY, loops: [{ entities: [] }] }, /entities must not be empty/],
    [
      { op: 'profile', frame: XY, loops: [{ entities: [{ kind: 'circle', center: [0, 0] }] }] },
      /entities\[0\]\.radius must be a number/,
    ],
    [
      {
        op: 'profile',
        frame: XY,
        loops: [{ entities: [{ kind: 'circle', center: [0, 0], radius: 1, id: 7 }] }],
      },
      /entities\[0\]\.id must be a string/,
    ],
    [{ op: 'extrude', profile: 1.5, distance: 1 }, /op\.profile must be a shape id/],
    [{ op: 'extrude', profile: 1, distance: 'far' }, /a number or a vector/],
    [{ op: 'boolean', kind: 'xor', shape: 1, tools: [2] }, /one of fuse, cut, common/],
    [{ op: 'boolean', kind: 'cut', shape: 1, tools: [] }, /op\.tools must not be empty/],
    [{ op: 'measure', shape: 1 }, /op\.targets must be an array/],
    [
      { op: 'measure', shape: 1, targets: [{ kind: 'solid', index: 1 }] },
      /op\.targets\[0\]\.kind must be one of face, edge, vertex/,
    ],
    [{ op: 'measure', shape: 1, targets: [{ kind: 'edge' }] }, /op\.targets\[0\]\.index/],
    [{ op: 'measure', shape: 1, targets: [], body: 1 }, /op\.body must be a boolean/],
    [{ op: 'obb' }, /op\.shape must be a shape id/],
    [{ op: 'obb', shape: 1, optimal: 1 }, /op\.optimal must be a boolean/],
    [{ op: 'fillet', shape: 1, edges: 1, radius: 1 }, /op\.edges must be an array/],
    [{ op: 'tessellate', shape: 1, deflection: { linear: 'fine' } }, /deflection\.linear/],
    [{ op: 'release', shapes: [{ result: '0' }] }, /op\.shapes\[0\]/],
  ])('rejects %j', (op, message) => {
    expect(validateOp(op)).toMatch(message);
  });
});
