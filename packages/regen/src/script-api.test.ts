// The host functions of the script API (`script-api.ts`), called directly as the sandbox calls
// them: every operation on the real kernel, and hostile arguments, each of which must be refused
// with a `ScriptHostError` (catchable by the script) before anything reaches the kernel.

import type { Kernel, ShapeId } from '@manufakture/kernel';
import { createNodeKernel } from '@manufakture/kernel/node';
import { ScriptHandle, ScriptHostError, type ScriptValue } from '@manufakture/script';
import { beforeAll, describe, expect, it } from 'vitest';
import { MAX_HANDLES_PER_CALL, MAX_SKETCH_ENTITIES, ScriptRun } from './script-api';

let k: Kernel;

beforeAll(async () => {
  k = await createNodeKernel();
}, 60_000);

const square = (size: number, ids = ['a', 'b', 'c', 'd']): ScriptValue => [
  { kind: 'line', id: ids[0]!, start: [0, 0], end: [size, 0] },
  { kind: 'line', id: ids[1]!, start: [size, 0], end: [size, size] },
  { kind: 'line', id: ids[2]!, start: [size, size], end: [0, size] },
  { kind: 'line', id: ids[3]!, start: [0, size], end: [0, 0] },
];

function cube(run: ScriptRun, id: string, size = 10): ScriptHandle {
  const s = run.sketch(`${id}Sketch`, { loops: [square(size)] });
  return run.extrude(id, s, { distance: size });
}

const volume = (shape: ShapeId) => k.properties(shape).volume;

function refused(fn: () => unknown, text: string | RegExp): void {
  let error: unknown = null;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect(error, `expected a refusal mentioning ${String(text)}`).toBeInstanceOf(ScriptHostError);
  expect((error as Error).message).toMatch(text);
}

function release(run: ScriptRun): void {
  const out = run.finish();
  for (const s of out.keep) if (k.has(s)) k.release(s);
}

describe('operations', () => {
  it('revolve, shell, chamfer, boolean, transform and mirror name their faces under the prefix', () => {
    const run = new ScriptRun(k, 'scripted#4', []);
    // A cylinder by revolving a rectangle about z.
    const profile = run.sketch('section', {
      plane: 'XZ',
      loops: [
        [
          { kind: 'line', id: 'bottom', start: [0, 0], end: [10, 0] },
          { kind: 'line', id: 'wall', start: [10, 0], end: [10, 20] },
          { kind: 'line', id: 'top', start: [10, 20], end: [0, 20] },
          { kind: 'line', id: 'axis', start: [0, 20], end: [0, 0] },
        ],
      ],
    });
    const can = run.revolve('can', profile, { axis: { origin: [0, 0, 0], direction: [0, 0, 1] } });
    const [body] = run.bodiesOf(can);
    expect(volume(run.bodies[0]!.shape)).toBeCloseTo(Math.PI * 100 * 20, 3);
    // Hollow it from the top face.
    const top = run.faces(can, { surface: 'plane', normal: [0, 0, 1] });
    expect(top.map((f) => run.nameOf(f))).toEqual(['scripted#4:can/side:top']);
    run.shell('hollow', top, 1, undefined);
    const inner = Math.PI * 81 * 19;
    expect(run.volume(undefined)).toBeCloseTo(Math.PI * 100 * 20 - inner, 2);
    expect(
      run.faces(undefined, {}).some((f) => run.nameOf(f).startsWith('scripted#4:hollow/offset:')),
    ).toBe(true);
    // A cube beside it, chamfered, moved down over the rim and fused.
    const box = cube(run, 'box', 30);
    run.chamfer('bevel', run.edges(box, { direction: [0, 0, 1] }), 1);
    const [boxBody] = run.bodiesOf(box);
    run.transform('lift', boxBody, { translate: [-15, -15, 19] });
    const bounds = run.bounds(boxBody) as { min: number[]; max: number[] };
    expect(bounds.min[2]).toBeCloseTo(19, 5);
    expect(bounds.max[0]).toBeCloseTo(15, 5);
    run.boolean('join', 'union', body, boxBody);
    expect(run.bodies.map((b) => b.id)).toEqual(['scripted#4:can']);
    const names = run.faces(undefined, {}).map((f) => run.nameOf(f));
    expect(names).toContain('scripted#4:bevel/bevel:scripted#4:box/side:a&scripted#4:box/side:b');
    // A mirrored copy as a new body.
    run.mirror('copy', body, { origin: [0, 0, -1], normal: [0, 0, 1] }, { mode: 'new' });
    expect(run.bodies.map((b) => b.id)).toEqual(['scripted#4:can', 'scripted#4:copy/image']);
    const all = run.faces(undefined, {}).map((f) => run.nameOf(f));
    expect(all.every((n) => n.startsWith('scripted#4:') && !n.includes('scriptop'))).toBe(true);
    expect(all).toContain('scripted#4:copy/image/scripted#4:can/side:wall');
    // Measurements of a face and an edge.
    const wall = run.faces(can, { role: 'side', surface: 'cylinder' })[0]!;
    expect(run.face(wall)).toMatchObject({ surface: 'cylinder', radius: 10 });
    const out = run.finish();
    expect(out.outcome.created).toEqual(['scripted#4:can', 'scripted#4:copy/image']);
    expect(out.keep).toHaveLength(2);
    release(run);
  });

  it('reports what it did to the bodies it was given: changed, consumed, created', () => {
    const before = new ScriptRun(k, 'scripted#1', []);
    cube(before, 'a');
    cube(before, 'b');
    const given = before.bodies.map((b) => ({ ...b }));
    const run = new ScriptRun(k, 'scripted#2', given);
    const [a, b] = run.bodiesOf(undefined);
    run.transform('move', b!, { translate: [5, 0, 0] });
    run.boolean('cut', 'subtract', a!, b!);
    cube(run, 'c', 3);
    const out = run.finish();
    expect(out.outcome.changed).toEqual(['scripted#1:a']);
    expect(out.outcome.consumed).toEqual(['scripted#1:b']);
    expect(out.outcome.created).toEqual(['scripted#2:c']);
    expect(volume(run.bodies[0]!.shape)).toBeCloseTo(500, 6);
    // The moved copy of b was made and consumed inside the run: not kept.
    expect(out.keep).toHaveLength(2);
    release(run);
    release(before);
  });
});

describe('hostile arguments are refused before the kernel', () => {
  const run = () => new ScriptRun(k, 'scripted#1', []);

  it('operation ids', () => {
    const r = run();
    const s = r.sketch('s', { loops: [square(5)] });
    for (const id of [
      '',
      'A',
      '1a',
      'a b',
      'a/b',
      'a:b',
      'scriptop#1000001',
      'a'.repeat(65),
      3,
      null,
      s,
    ]) {
      refused(() => r.extrude(id as ScriptValue, s, { distance: 1 }), /operation id/);
    }
    refused(() => r.sketch('s', { loops: [square(5)] }), /used twice/);
  });

  it('numbers: NaN, the infinities, -0, out of range', () => {
    const r = run();
    const s = r.sketch('s', { loops: [square(5)] });
    let n = 0;
    for (const d of [Number.NaN, Infinity, -Infinity, 0, -1, 1e7, '5', true, null]) {
      refused(() => r.extrude(`e${n++}`, s, { distance: d as ScriptValue }), /distance/);
    }
    refused(
      () =>
        r.sketch('t', {
          loops: [[{ kind: 'circle', id: 'c', center: [Number.NaN, 0], radius: 1 }]],
        }),
      /finite/,
    );
    refused(
      () => r.sketch('u', { plane: { origin: [0, 0, 0], normal: [0, 0, 0] }, loops: [square(1)] }),
      /zero vector/,
    );
    refused(
      () => r.revolve('v', s, { axis: { origin: [0, 0, 0], direction: [0, 0, 1] }, angle: 7 }),
      /angle/,
    );
  });

  it('counts are bounded', () => {
    const r = run();
    const many = Array.from({ length: MAX_SKETCH_ENTITIES + 1 }, (_, i) => ({
      kind: 'circle',
      id: `c${i}`,
      center: [i * 3, 0],
      radius: 1,
    }));
    refused(() => r.sketch('big', { regions: many.map((c) => [[c]]) }), /loops|items/);
    refused(() => r.sketch('big2', { loops: [many] }), /entities|items/);
    const s = r.sketch('s', { loops: [square(5)] });
    const box = r.extrude('box', s, { distance: 5 });
    const edge = r.edges(box, {})[0]!;
    refused(
      () =>
        r.fillet(
          'f',
          Array.from({ length: MAX_HANDLES_PER_CALL + 1 }, () => edge),
          1,
        ),
      /give 1 to/,
    );
    refused(() => r.fillet('g', [edge, edge], 1), /listed twice/);
    refused(
      () => r.pattern('p', box, { linear: { direction: [1, 0, 0], count: 1001, spacing: 10 } }),
      /count/,
    );
    refused(
      () => r.pattern('q', box, { linear: { direction: [1, 0, 0], count: 2.5, spacing: 10 } }),
      /count/,
    );
    release(r);
  });

  it('handles: of the wrong kind, imitations, and bodies that are gone', () => {
    const r = run();
    const s = r.sketch('s', { loops: [square(5)] });
    const a = r.extrude('a', s, { distance: 5 });
    const b = r.extrude('b', r.sketch('s2', { loops: [square(5)] }), { distance: 5, mode: 'new' });
    const [bodyA] = r.bodiesOf(a);
    const [bodyB] = r.bodiesOf(b);
    // A plain object shaped like a handle is not one; nor is a handle of another kind.
    refused(
      () => r.extrude('x', { kind: 'sketch' } as ScriptValue, { distance: 1 }),
      /must be a sketch/,
    );
    refused(() => r.extrude('y', a, { distance: 1 }), /must be a sketch/);
    refused(() => r.fillet('z', [bodyA!], 1), /must be a edge/);
    refused(() => r.boolean('w', 'union', bodyA!, bodyA!), /target and a tool/);
    refused(() => r.boolean('v', 'xor', bodyA!, bodyB!), /kind must be/);
    r.boolean('join', 'union', bodyA!, bodyB!);
    // b was consumed by the union: its handle names a body that is not there.
    refused(() => r.transform('t', bodyB!, { translate: [1, 0, 0] }), /not there any more/);
    refused(() => r.volume(bodyB!), /not there any more/);
    // A body handle whose id was never a body (only the host makes handles; defence in depth).
    refused(
      () => r.transform('u', new ScriptHandle('body', 'extrude#9'), { translate: [1, 0, 0] }),
      /not there/,
    );
    release(r);
  });

  it('unknown options and malformed shapes of data', () => {
    const r = run();
    const s = r.sketch('s', { loops: [square(5)] });
    refused(() => r.extrude('a', s, { distance: 1, __proto__x: 1 }), /unknown option/);
    refused(() => r.extrude('b', s, 'tall'), /options must be an object/);
    refused(() => r.sketch('c', { plane: 'XW', loops: [square(1)] }), /plane must be/);
    refused(() => r.sketch('d', { loops: [square(1)], regions: [[square(1)]] }), /not both/);
    refused(() => r.sketch('e', { loops: [[{ kind: 'spline', id: 'x' }]] }), /kind must be/);
    refused(
      () => r.sketch('f', { loops: [[{ kind: 'line', id: 'x', start: [0, 0, 0], end: [1, 1] }]] }),
      /\[x, y\]/,
    );
    refused(() => r.sketch('g', { loops: [square(1, ['a', 'a', 'b', 'c'])] }), /used twice/);
    refused(() => r.transform('h', [], { translate: [1, 0, 0] }), /give 1 to/);
    refused(() => r.extrude('i', s, { distance: 1, mode: 'new', bodies: [] }), /takes no bodies/);
    refused(() => r.extrude('j', s, { through: true }), /cannot go through all/);
    refused(() => r.faces(undefined, { surface: 'Plane!' }), /lower-case word/);
  });
});
