// Extension features through the translator registry (ADR 0013 decisions 4 to 6), against the
// scripted kernel: fake domains make and change bodies, fail in every way a domain can, read
// domain data, and ask for geometry first. The real kernel builds one in integration.test.ts.

import {
  diffDocuments,
  serialize,
  type Command,
  type ExtensionFeature,
  type ManufaktureDocument,
} from '@manufakture/core';
import type { ExtrudeInput } from '@manufakture/kernel';
import { describe, expect, it } from 'vitest';
import { MemoryCache } from './cache';
import { RegenEngine } from './engine';
import {
  ExtensionRegistry,
  type ExtensionContext,
  type ExtensionDomain,
  type ExtensionType,
  type GeometryAnswer,
} from './extensions';
import { FakeKernel, FakeSolver } from './fake-kernel';
import { dirtyFeatures } from './graph';
import { add, apply, build, extrude, mm, rectangle, setVariable, statuses } from './test-helpers';
import type { FeatureResult, RegenResult } from './types';

// A fake woodworking domain ---------------------------------------------------------------------

interface BoardParams {
  sketch: string;
  stock?: string;
}

interface StockData {
  [id: string]: { thickness?: number; price?: number };
}

/** Params of version 1 named the sketch `profile`; version 2 calls it `sketch`. */
function boardParams(params: Readonly<Record<string, unknown>>, version: number) {
  const p: Record<string, unknown> =
    version === 1 ? { ...params, sketch: params.profile } : { ...params };
  if (typeof p.sketch !== 'string') {
    return { ok: false as const, message: 'A board needs a sketch', field: ['sketch'] };
  }
  if (p.stock !== undefined && typeof p.stock !== 'string') {
    return { ok: false as const, message: 'The stock must be an id', field: ['stock'] };
  }
  return { ok: true as const, value: { sketch: p.sketch, stock: p.stock } as BoardParams };
}

/** An extrude of the board's sketch by its thickness: the stock override's, else its own. */
function boardInput(ctx: ExtensionContext<BoardParams>): ExtrudeInput | { error: string } {
  const profile = ctx.profile(ctx.params.sketch);
  if (!profile.ok) return { error: profile.message };
  const stock = ctx.data.stock as StockData | undefined;
  const override = ctx.params.stock === undefined ? undefined : stock?.[ctx.params.stock];
  const thickness = override?.thickness ?? ctx.values.thickness!;
  return {
    kind: 'extrude',
    id: ctx.feature.id,
    profile: profile.value,
    extent: { type: 'blind', distance: thickness },
    mode: 'new',
  };
}

const board: ExtensionType<BoardParams> = {
  schemaVersion: 2,
  expressions: { thickness: 'length' },
  params: boardParams,
  translate(ctx) {
    const input = boardInput(ctx);
    if ('error' in input) return input;
    const distance = (input.extent as { distance: number }).distance;
    return { inputs: [input], metadata: { thickness: distance } };
  },
};

/** A translator that throws. */
const boom: ExtensionType = {
  schemaVersion: 1,
  translate() {
    throw new Error('the jig is broken');
  },
};

/**
 * A two-step joint: it asks where the face it names lies and how big the body it names is, then
 * cuts a pocket as deep as the face is high, as wide as the box is long.
 */
const asked: unknown[] = [];
const joint: ExtensionType<{ sketch: string; face: string; body: string }> = {
  schemaVersion: 1,
  queries(ctx) {
    asked.push(ctx.params);
    return [
      { type: 'resolve', ref: { face: ctx.params.face } },
      { type: 'obb', body: ctx.params.body },
    ];
  },
  translate(ctx, answers: readonly GeometryAnswer[]) {
    const [face, box] = answers;
    if (face?.type !== 'resolve' || !face.report.ok) return { error: 'the face is gone' };
    if (box?.type !== 'obb' || box.box === null) return { error: 'the body is gone' };
    const profile = ctx.profile(ctx.params.sketch);
    if (!profile.ok) return { error: profile.message };
    const z = face.report.geometry!.origin[2];
    return {
      inputs: [
        {
          kind: 'extrude',
          id: ctx.feature.id,
          profile: profile.value,
          extent: { type: 'blind', distance: z + box.box.sizes[0] },
          mode: 'subtract',
        },
      ],
      metadata: { faceBody: face.body, z },
    };
  },
};

function fakeDomain(extra: Partial<ExtensionDomain> = {}): ExtensionDomain {
  return {
    namespace: 'fake',
    implementation: 1,
    reads: ['stock'],
    data: {
      fake: { schemaVersion: 1, read: (data) => ({ ok: true, value: data }) },
      stock: {
        schemaVersion: 1,
        read: (data) =>
          typeof data === 'object' && data !== null && !Array.isArray(data)
            ? { ok: true, value: data }
            : { ok: false, message: 'expected stock overrides by id', field: [] },
      },
    },
    types: {
      'fake.board': board as ExtensionType,
      'fake.boom': boom,
      'fake.joint': joint as ExtensionType,
    },
    ...extra,
  };
}

/** A second domain, which reads only its own namespace. */
const otherDomain: ExtensionDomain = {
  namespace: 'other',
  implementation: 1,
  types: {
    'other.board': { ...board, schemaVersion: 2 } as ExtensionType,
  },
};

function setup(registry = new ExtensionRegistry()) {
  const kernel = new FakeKernel();
  const solver = new FakeSolver();
  const engine = new RegenEngine({
    kernel,
    solver,
    cache: new MemoryCache(),
    extensions: registry,
  });
  return { kernel, solver, engine, registry };
}

function withDomains(...domains: ExtensionDomain[]) {
  const registry = new ExtensionRegistry();
  for (const d of domains) registry.registerDomain(d);
  return setup(registry);
}

async function regen(
  engine: RegenEngine,
  doc: ManufaktureDocument,
  previous?: ManufaktureDocument,
) {
  const r =
    previous === undefined
      ? await engine.regen(doc)
      : await engine.regen(doc, { previous, change: diffDocuments(previous, doc) });
  if (r === null) throw new Error('superseded');
  return r;
}

function ext(id: string, type: string, extra: Partial<ExtensionFeature> = {}): ExtensionFeature {
  return {
    id,
    kind: 'extension',
    name: id,
    suppressed: false,
    extension: type,
    schemaVersion: 2,
    dependsOn: ['sketch#1'],
    references: [],
    expressions: { thickness: mm('18') },
    params: { sketch: 'sketch#1' },
    ...extra,
  };
}

const featureOf = (r: RegenResult, id: string): FeatureResult =>
  r.parts[0]!.features.find((f) => f.featureId === id)!;

const sketch = rectangle('sketch#1', { width: '600', depth: '300' });

/** A board on sketch#1, 18 mm thick. */
const oneBoard = (extra: Partial<ExtensionFeature> = {}) =>
  build([add(sketch), add(ext('extension#1', 'fake.board', { operation: 'new', ...extra }))]);

const stockData = (data: Record<string, unknown>): Command => ({
  type: 'setDomainData',
  namespace: 'stock',
  schemaVersion: 1,
  data: data as never,
});

describe('extensions that make bodies', () => {
  it('builds a new body from the translator, named after the extension', async () => {
    const { kernel, engine } = withDomains(fakeDomain());
    const r = await regen(engine, oneBoard());
    expect(statuses(r)).toEqual({ 'sketch#1': 'ok', 'extension#1': 'ok' });
    const input = kernel.inputs.get('extension#1') as ExtrudeInput & { body?: string };
    expect(input).toMatchObject({
      kind: 'extrude',
      id: 'extension#1',
      mode: 'new',
      body: 'extension#1',
      extent: { type: 'blind', distance: 18 },
    });
    expect(kernel.sets.get('extension#1')).toEqual([]);
    expect(r.parts[0]!.bodies.map((b) => [b.bodyId, b.creator])).toEqual([
      ['extension#1', 'extension#1'],
    ]);
    expect(featureOf(r, 'extension#1')).toMatchObject({
      status: 'ok',
      errors: [],
      warnings: [],
      cached: false,
      metadata: { thickness: 18 },
    });
  });

  it('serves the kernel step from the cache, and re-runs only what an edit changes', async () => {
    const { kernel, engine } = withDomains(fakeDomain());
    const doc = build([
      setVariable('t', '18'),
      add(sketch),
      add(
        ext('extension#1', 'fake.board', { operation: 'new', expressions: { thickness: mm('t') } }),
      ),
      add(extrude('extrude#1', 'sketch#1', '5', 'new')),
    ]);
    await regen(engine, doc);
    expect(kernel.featureOps).toEqual(['extension#1', 'extrude#1']);
    const again = await regen(engine, doc);
    expect(kernel.featureOps).toHaveLength(2);
    expect(featureOf(again, 'extension#1').cached).toBe(true);
    expect(again.counters).toMatchObject({ featureOps: 0, cacheMisses: 0 });

    const thicker = apply(doc, setVariable('t', '19'));
    const r = await regen(engine, thicker, doc);
    expect(r.parts[0]!.dirty).toEqual(['extension#1']);
    expect(kernel.featureOps).toEqual(['extension#1', 'extrude#1', 'extension#1']);
    expect((kernel.inputs.get('extension#1') as ExtrudeInput).extent).toEqual({
      type: 'blind',
      distance: 19,
    });
  });

  it('adds to and cuts existing bodies by operation and scope', async () => {
    const { kernel, engine } = withDomains(fakeDomain());
    const doc = build([
      add(sketch),
      add(extrude('extrude#1', 'sketch#1', '20')),
      add(extrude('extrude#2', 'sketch#1', '30')),
      add(ext('extension#1', 'fake.board', { operation: 'cut', scope: ['extrude#2'] })),
      add(ext('extension#2', 'fake.board', { operation: 'add' })),
    ]);
    const r = await regen(engine, doc);
    expect(statuses(r)).toMatchObject({ 'extension#1': 'ok', 'extension#2': 'ok' });
    // The cut reads only its scope, with the cut's mode; it makes no body of its own.
    expect(kernel.sets.get('extension#1')).toEqual(['extrude#2']);
    const cut = kernel.inputs.get('extension#1') as ExtrudeInput & { body?: string };
    expect(cut.mode).toBe('subtract');
    expect(cut.scope).toEqual(['extrude#2']);
    expect(cut.body).toBeUndefined();
    // The add reads every body and makes its body under its own id if it touches none.
    expect(kernel.sets.get('extension#2')).toEqual(['extrude#1', 'extrude#2']);
    expect(kernel.inputs.get('extension#2')).toMatchObject({ mode: 'add', body: 'extension#2' });
    expect(kernel.inputs.get('extension#2')).not.toHaveProperty('scope');
  });

  it('builds several inputs in order, each on the bodies the one before left', async () => {
    const two: ExtensionType<BoardParams> = {
      ...board,
      translate(ctx) {
        const input = boardInput(ctx);
        if ('error' in input) return input;
        return {
          inputs: [
            { ...input, body: `${ctx.feature.id}:a` },
            { ...input, body: `${ctx.feature.id}:b` },
          ],
        };
      },
    };
    const { kernel, engine } = withDomains(
      fakeDomain({ types: { 'fake.pair': two as ExtensionType } }),
    );
    const r = await regen(
      engine,
      build([add(sketch), add(ext('extension#1', 'fake.pair', { operation: 'new' }))]),
    );
    expect(statuses(r)).toMatchObject({ 'extension#1': 'ok' });
    expect(kernel.featureOps).toEqual(['extension#1', 'extension#1']);
    expect(r.parts[0]!.bodies.map((b) => b.bodyId)).toEqual(['extension#1:a', 'extension#1:b']);
  });

  it('cannot be repeated by a pattern of features', async () => {
    const { engine } = withDomains(fakeDomain());
    const doc = apply(
      oneBoard(),
      add({
        id: 'pattern#1',
        kind: 'pattern',
        name: 'Pattern 1',
        suppressed: false,
        features: ['extension#1'],
        layout: {
          type: 'linear',
          direction: { id: 'r1', ref: { faces: ['extension#1:cap:end', 'extension#1:side:e1'] } },
          count: mm('3'),
          spacing: mm('10'),
        },
      }),
    );
    const r = await regen(engine, doc);
    expect(featureOf(r, 'pattern#1').errors[0]).toMatchObject({
      code: 'unsupported',
      field: ['features'],
    });
  });

  it('reports a failed kernel step as the feature error', async () => {
    const { kernel, engine } = withDomains(fakeDomain());
    kernel.behaviours.set('extension#1', {
      errors: [{ featureId: 'extension#1', code: 'invalid', message: 'zero thickness' }],
    });
    const r = await regen(engine, oneBoard());
    expect(featureOf(r, 'extension#1')).toMatchObject({
      status: 'error',
      errors: [{ code: 'invalid', message: 'zero thickness' }],
    });
    expect(r.parts[0]!.bodies).toEqual([]);
  });
});

describe('what a domain can get wrong', () => {
  it('turns a throwing translator into a feature error and builds everything else', async () => {
    const { kernel, engine } = withDomains(fakeDomain());
    const doc = build([
      add(sketch),
      add(ext('extension#1', 'fake.boom', { operation: 'new', schemaVersion: 1 })),
      add(extrude('extrude#1', 'sketch#1', '20')),
    ]);
    const r = await regen(engine, doc);
    expect(statuses(r)).toEqual({ 'sketch#1': 'ok', 'extension#1': 'error', 'extrude#1': 'ok' });
    expect(featureOf(r, 'extension#1').errors).toEqual([
      { code: 'extension', message: 'The "fake.boom" translator failed: the jig is broken' },
    ]);
    expect(kernel.featureOps).toEqual(['extrude#1']);
  });

  it('refuses malformed results before the kernel sees them', async () => {
    const cases: [string, unknown, RegExp][] = [
      ['no inputs', {}, /expected \{ inputs \} or \{ error \}/],
      ['another id', { inputs: [{ kind: 'extrude', id: 'extrude#9', mode: 'new' }] }, /extrude#9/],
      ['a derive', { inputs: [{ kind: 'derive', id: 'extension#1' }] }, /is a derive/],
      [
        'a foreign body',
        { inputs: [{ kind: 'extrude', id: 'extension#1', mode: 'new', body: 'extrude#1' }] },
        /makes the body "extrude#1"/,
      ],
      [
        'a function',
        { inputs: [{ kind: 'extrude', id: 'extension#1', mode: 'new', extent: () => 1 }] },
        /cannot hash a function/,
      ],
      ['no input at all', { inputs: [] }, /at least one input/],
      [
        'a body that is a number',
        { inputs: [{ kind: 'extrude', id: 'extension#1', mode: 'new', body: 5 }] },
        /body that is not a string/,
      ],
      [
        'a scope that is a string',
        { inputs: [{ kind: 'extrude', id: 'extension#1', scope: 'extrude#1' }] },
        /scope that is not a list/,
      ],
      [
        'a getter that throws',
        {
          inputs: [
            {
              get kind(): string {
                throw new Error('no kind today');
              },
            },
          ],
        },
        /no kind today/,
      ],
      [
        'two unkeyed new solids',
        {
          inputs: [
            { kind: 'extrude', id: 'extension#1', mode: 'new' },
            { kind: 'extrude', id: 'extension#1', mode: 'new' },
          ],
        },
        /makes the body extension#1 a second time/,
      ],
      [
        'one key twice',
        {
          inputs: [
            { kind: 'extrude', id: 'extension#1', mode: 'new', body: 'extension#1:a' },
            { kind: 'extrude', id: 'extension#1', mode: 'new', body: 'extension#1:a' },
          ],
        },
        /makes the body extension#1:a a second time/,
      ],
    ];
    for (const [what, output, message] of cases) {
      const { kernel, engine } = withDomains(
        fakeDomain({
          types: { 'fake.bad': { schemaVersion: 2, translate: () => output as never } },
        }),
      );
      const r = await regen(
        engine,
        build([add(sketch), add(ext('extension#1', 'fake.bad', { operation: 'new' }))]),
      );
      const f = featureOf(r, 'extension#1');
      expect(f.status, what).toBe('error');
      expect(f.errors[0]!.code, what).toBe('extension');
      expect(f.errors[0]!.message, what).toMatch(message);
      expect(kernel.featureOps, what).toEqual([]);
    }
  });

  it('refuses malformed queries as a feature error, not a failed regen', async () => {
    const cases: [string, unknown, RegExp][] = [
      ['an empty ref', [{ type: 'resolve', ref: {} }], /query 0 has no well-formed ref/],
      ['faces of numbers', [{ type: 'resolve', ref: { faces: [1] } }], /no well-formed ref/],
      ['a face number', [{ type: 'resolve', ref: { face: 7 } }], /no well-formed ref/],
      [
        'ends that are a string',
        [{ type: 'resolve', ref: { faces: ['extrude#1:cap:end'], ends: 'x' } }],
        /no well-formed ref/,
      ],
      ['an obb of a number', [{ type: 'obb', body: 5 }], /names no body/],
      [
        'a getter that throws',
        [
          {
            type: 'resolve',
            get ref(): unknown {
              throw new Error('no ref today');
            },
          },
        ],
        /no ref today/,
      ],
    ];
    for (const [what, queries, message] of cases) {
      const { kernel, engine } = withDomains(
        fakeDomain({
          types: {
            'fake.ask': {
              schemaVersion: 2,
              queries: () => queries as never,
              translate: () => ({ inputs: [] }),
            },
          },
        }),
      );
      const r = await regen(
        engine,
        build([
          add(sketch),
          add(extrude('extrude#1', 'sketch#1', '20')),
          add(ext('extension#1', 'fake.ask', { operation: 'cut' })),
        ]),
      );
      const f = featureOf(r, 'extension#1');
      expect(f.status, what).toBe('error');
      expect(f.errors[0]!.code, what).toBe('extension');
      expect(f.errors[0]!.message, what).toMatch(message);
      expect(kernel.featureOps, what).toEqual(['extrude#1']);
    }
  });

  it('undoes what earlier inputs did when a later one fails', async () => {
    // Two inputs: the first fuses both blocks (extrude#2 is consumed), the second fails.
    const fuse: ExtensionType<BoardParams> = {
      ...board,
      translate(ctx) {
        const input = boardInput(ctx);
        if ('error' in input) return input;
        return { inputs: [input, { ...input }] };
      },
    };
    const { kernel, engine } = withDomains(
      fakeDomain({ types: { 'fake.fuse': fuse as ExtensionType } }),
    );
    const blocks = [
      add(sketch),
      add(extrude('extrude#1', 'sketch#1', '20')),
      add(extrude('extrude#2', 'sketch#1', '30')),
    ];
    const clean = await regen(withDomains(fakeDomain()).engine, build(blocks));
    const doc = build([...blocks, add(ext('extension#1', 'fake.fuse', { operation: 'add' }))]);
    kernel.behaviours.set('extension#1', { merge: true });
    kernel.onRun = () => {
      // The second extension op fails.
      if (kernel.featureOps.filter((x) => x === 'extension#1').length === 1) {
        kernel.behaviours.set('extension#1', {
          errors: [{ featureId: 'extension#1', code: 'invalid', message: 'the second one fails' }],
        });
      }
    };
    const r = await regen(engine, doc);
    expect(kernel.featureOps.filter((x) => x === 'extension#1')).toHaveLength(2);
    expect(featureOf(r, 'extension#1')).toMatchObject({
      status: 'error',
      errors: [{ code: 'invalid', message: 'the second one fails' }],
    });
    expect(r.parts[0]!.consumed).toEqual([]);
    expect(r.parts[0]!.bodies.map((b) => b.bodyId)).toEqual(['extrude#1', 'extrude#2']);
    expect(r.parts[0]!.bodies.map((b) => b.bodyKey)).toEqual(
      clean.parts[0]!.bodies.map((b) => b.bodyKey),
    );
  });

  it('undoes the bodies a new extension made when a later input fails', async () => {
    const two: ExtensionType<BoardParams> = {
      ...board,
      translate(ctx) {
        const input = boardInput(ctx);
        if ('error' in input) return input;
        return {
          inputs: [
            { ...input, body: `${ctx.feature.id}:a` },
            { ...input, body: `${ctx.feature.id}:b` },
          ],
        };
      },
    };
    const { kernel, engine } = withDomains(
      fakeDomain({ types: { 'fake.pair': two as ExtensionType } }),
    );
    kernel.onRun = () => {
      if (kernel.featureOps.length === 1) {
        kernel.behaviours.set('extension#1', {
          errors: [{ featureId: 'extension#1', code: 'invalid', message: 'no room for b' }],
        });
      }
    };
    const r = await regen(
      engine,
      build([add(sketch), add(ext('extension#1', 'fake.pair', { operation: 'new' }))]),
    );
    expect(kernel.featureOps).toEqual(['extension#1', 'extension#1']);
    expect(featureOf(r, 'extension#1').status).toBe('error');
    expect(r.parts[0]!.bodies).toEqual([]);
  });

  it('refuses a solid of its own from an extension with no operation', async () => {
    const { engine } = withDomains(fakeDomain());
    const r = await regen(engine, build([add(sketch), add(ext('extension#1', 'fake.board'))]));
    expect(featureOf(r, 'extension#1').errors[0]!.message).toMatch(/has no operation/);
  });

  it('fails a translator that writes to what it reads', async () => {
    const writer: ExtensionType = {
      schemaVersion: 2,
      translate(ctx) {
        (ctx.feature.params as Record<string, unknown>).sketch = 'sketch#9';
        return { inputs: [] };
      },
    };
    const { engine } = withDomains(fakeDomain({ types: { 'fake.writer': writer } }));
    const doc = build([add(sketch), add(ext('extension#1', 'fake.writer'))]);
    const before = serialize(doc);
    const r = await regen(engine, doc);
    expect(featureOf(r, 'extension#1').errors[0]).toMatchObject({ code: 'extension' });
    expect(serialize(doc)).toBe(before);
  });

  it('reports the error value a translator returns, with its field', async () => {
    const { engine } = withDomains(fakeDomain());
    const r = await regen(engine, oneBoard({ params: { sketch: 'sketch#7' } }));
    expect(featureOf(r, 'extension#1').errors).toEqual([
      {
        code: 'invalid',
        message: 'sketch#7 is not a solved sketch this feature depends on',
      },
    ]);
  });

  it('fails params the domain refuses with invalid, and migrates older ones', async () => {
    const { kernel, engine } = withDomains(fakeDomain());
    const bad = await regen(engine, oneBoard({ params: { stock: 'ply' } }));
    expect(featureOf(bad, 'extension#1').errors).toEqual([
      { code: 'invalid', field: ['params', 'sketch'], message: 'A board needs a sketch' },
    ]);
    const old = await regen(
      engine,
      oneBoard({ schemaVersion: 1, params: { profile: 'sketch#1' } }),
    );
    expect(featureOf(old, 'extension#1').status).toBe('ok');
    expect(kernel.featureOps).toEqual(['extension#1']);
  });

  it('fails an expression of the wrong kind', async () => {
    const { engine } = withDomains(fakeDomain());
    const r = await regen(engine, oneBoard({ expressions: { thickness: mm('45deg') } }));
    expect(featureOf(r, 'extension#1').errors[0]).toMatchObject({
      code: 'expression',
      field: ['expressions', 'thickness'],
    });
  });
});

describe('unknown and newer extensions', () => {
  it('fails an unregistered type with unsupported, with or without an operation', async () => {
    const { kernel, engine } = setup();
    const cutScope = build([
      add(sketch),
      add(ext('extension#1', 'fake.board', { operation: 'new' })),
      add(ext('extension#2', 'fake.board')),
      add(extrude('extrude#1', 'sketch#1', '20')),
      add({ ...extrude('extrude#2', 'sketch#1', '5', 'cut'), scope: ['extension#1'] }),
    ]);
    const before = serialize(cutScope);
    const r = await regen(engine, cutScope);
    expect(statuses(r)).toEqual({
      'sketch#1': 'ok',
      'extension#1': 'error',
      'extension#2': 'error',
      'extrude#1': 'ok',
      'extrude#2': 'upstream-error',
    });
    for (const id of ['extension#1', 'extension#2']) {
      const [error] = featureOf(r, id).errors;
      expect(error).toMatchObject({ code: 'unsupported', field: ['extension'] });
      expect(error!.message).toContain('"fake.board"');
      expect(error!.message).toContain('version 2');
    }
    expect(kernel.featureOps).toEqual(['extrude#1']);
    expect(r.parts[0]!.bodies.map((b) => b.bodyId)).toEqual(['extrude#1']);
    // Nothing is rewritten.
    expect(serialize(cutScope)).toBe(before);
  });

  it('fails a newer schemaVersion with unsupported, naming both versions', async () => {
    const { kernel, engine } = withDomains(fakeDomain());
    const r = await regen(engine, oneBoard({ schemaVersion: 3 }));
    expect(featureOf(r, 'extension#1').errors).toEqual([
      {
        code: 'unsupported',
        field: ['schemaVersion'],
        message:
          '"fake.board" version 3 is newer than this build reads (version 2): open the document in a newer build',
      },
    ]);
    expect(kernel.featureOps).toEqual([]);
  });

  it('builds a type once its domain is registered, and stops when it is removed', async () => {
    const { kernel, engine, registry } = setup();
    const doc = oneBoard();
    expect(featureOf(await regen(engine, doc), 'extension#1').status).toBe('error');
    const unregister = registry.registerDomain(fakeDomain());
    expect(featureOf(await regen(engine, doc), 'extension#1').status).toBe('ok');
    expect(kernel.featureOps).toEqual(['extension#1']);
    unregister();
    const r = await regen(engine, doc);
    expect(featureOf(r, 'extension#1').errors[0]!.code).toBe('unsupported');
    expect(r.parts[0]!.bodies).toEqual([]);
  });
});

describe('domain data', () => {
  /** Two fake boards (ply and oak), and a board of the other domain. */
  function boards(): ManufaktureDocument {
    return build([
      add(sketch),
      add(
        ext('extension#1', 'fake.board', {
          operation: 'new',
          params: { sketch: 'sketch#1', stock: 'ply' },
        }),
      ),
      add(
        ext('extension#2', 'fake.board', {
          operation: 'new',
          params: { sketch: 'sketch#1', stock: 'oak' },
        }),
      ),
      add(ext('extension#3', 'other.board', { operation: 'new' })),
      stockData({ ply: { thickness: 18.2, price: 40 }, oak: { price: 90 } }),
    ]);
  }

  it('gives translators the data of the namespaces they read', async () => {
    const { kernel, engine } = withDomains(fakeDomain(), otherDomain);
    const r = await regen(engine, boards());
    expect(statuses(r)).toMatchObject({
      'extension#1': 'ok',
      'extension#2': 'ok',
      'extension#3': 'ok',
    });
    const distance = (id: string) =>
      (kernel.inputs.get(id) as ExtrudeInput).extent as { distance: number };
    expect(distance('extension#1').distance).toBe(18.2);
    expect(distance('extension#2').distance).toBe(18);
    expect(featureOf(r, 'extension#1').metadata).toEqual({ thickness: 18.2 });
  });

  it('dirties every extension that may read a changed namespace; the cache sorts out the rest', async () => {
    const { kernel, engine } = withDomains(fakeDomain(), otherDomain);
    const doc = boards();
    await regen(engine, doc);
    expect(kernel.featureOps).toEqual(['extension#1', 'extension#2', 'extension#3']);

    // A price no translator reads: both fake boards are dirty, none rebuilds.
    const priced = apply(
      doc,
      stockData({ ply: { thickness: 18.2, price: 45 }, oak: { price: 90 } }),
    );
    const change = diffDocuments(doc, priced);
    expect(change.domainChanged).toEqual(['stock']);
    expect(change.parts).toEqual([]);
    const r1 = await regen(engine, priced, doc);
    expect(r1.parts[0]!.dirty).toEqual(['extension#1', 'extension#2']);
    expect(kernel.featureOps).toHaveLength(3);
    expect(r1.counters).toMatchObject({ featureOps: 0, cacheMisses: 0 });
    expect(featureOf(r1, 'extension#1').cached).toBe(true);

    // A thickness override of ply misses for the ply board only.
    const thicker = apply(
      priced,
      stockData({ ply: { thickness: 18.5, price: 45 }, oak: { price: 90 } }),
    );
    const r2 = await regen(engine, thicker, priced);
    expect(r2.parts[0]!.dirty).toEqual(['extension#1', 'extension#2']);
    expect(kernel.featureOps).toEqual(['extension#1', 'extension#2', 'extension#3', 'extension#1']);
    expect(featureOf(r2, 'extension#1').cached).toBe(false);
    expect(featureOf(r2, 'extension#2').cached).toBe(true);

    // Without the store's change, the namespaces are compared from the documents.
    const r3 = await regen(engine, priced);
    expect(r3.parts[0]!.dirty).toEqual(['extension#1', 'extension#2']);
  });

  it('marks only readers dirty in the graph, through the namespaces each type may read', () => {
    const doc = boards();
    const part = doc.parts[0]!;
    const next = { part, variables: doc.variables };
    const reads = (type: string) => (type.startsWith('fake.') ? ['fake', 'stock'] : ['other']);
    expect(
      dirtyFeatures(next, next, {
        firstAffectedIndex: null,
        domainChanged: ['stock'],
        domainReads: reads,
      }),
    ).toEqual(['extension#1', 'extension#2']);
    expect(
      dirtyFeatures(next, next, {
        firstAffectedIndex: null,
        domainChanged: ['other'],
        domainReads: reads,
      }),
    ).toEqual(['extension#3']);
    expect(dirtyFeatures(next, next, { firstAffectedIndex: null })).toEqual([]);
  });

  it('misses the cache when the domain bumps its implementation version', async () => {
    const registry = new ExtensionRegistry();
    const unregister = registry.registerDomain(fakeDomain());
    const { kernel, engine } = setup(registry);
    const doc = oneBoard();
    await regen(engine, doc);
    await regen(engine, doc);
    expect(kernel.featureOps).toEqual(['extension#1']);
    unregister();
    registry.registerDomain(fakeDomain({ implementation: 2 }));
    await regen(engine, doc);
    expect(kernel.featureOps).toEqual(['extension#1', 'extension#1']);
  });

  it('fails every reader of data that is newer or invalid, and nothing else', async () => {
    const { kernel, engine } = withDomains(fakeDomain(), otherDomain);
    const newer = apply(boards(), {
      type: 'setDomainData',
      namespace: 'stock',
      schemaVersion: 2,
      data: {},
    });
    const r = await regen(engine, newer);
    expect(statuses(r)).toMatchObject({
      'extension#1': 'error',
      'extension#2': 'error',
      'extension#3': 'ok',
    });
    expect(featureOf(r, 'extension#2').errors).toEqual([
      {
        code: 'unsupported',
        field: ['domains', 'stock'],
        message: 'The domain data "stock" is version 2, newer than this build reads (version 1)',
      },
    ]);
    expect(kernel.featureOps).toEqual(['extension#3']);

    const invalid = apply(boards(), stockData([1, 2] as never));
    const r2 = await regen(engine, invalid);
    expect(featureOf(r2, 'extension#1').errors).toEqual([
      {
        code: 'invalid',
        field: ['domains', 'stock', 'data'],
        message: 'The domain data "stock" is invalid: expected stock overrides by id',
      },
    ]);
  });

  it('keeps unknown namespaces and fails readers of a namespace nobody owns', async () => {
    const reader: ExtensionDomain = {
      namespace: 'shed',
      implementation: 1,
      reads: ['lumber'],
      types: { 'shed.wall': { ...board, schemaVersion: 2 } as ExtensionType },
    };
    const { engine } = withDomains(fakeDomain(), reader);
    const doc = build([
      add(sketch),
      add(ext('extension#1', 'fake.board', { operation: 'new' })),
      add(ext('extension#2', 'shed.wall', { operation: 'new' })),
      { type: 'setDomainData', namespace: 'lumber', schemaVersion: 1, data: { x: 1 } },
      { type: 'setDomainData', namespace: 'unheard', schemaVersion: 7, data: { y: 2 } },
    ]);
    const r = await regen(engine, doc);
    expect(statuses(r)).toMatchObject({ 'extension#1': 'ok', 'extension#2': 'error' });
    expect(featureOf(r, 'extension#2').errors[0]).toMatchObject({
      code: 'unsupported',
      field: ['domains', 'lumber'],
    });
  });
});

describe('references and the two-step form', () => {
  /** A block, then a joint on its top face cutting a pocket sized from the answers. */
  function jointed(face = 'extrude#1:cap:end'): ManufaktureDocument {
    return build([
      add(sketch),
      add(extrude('extrude#1', 'sketch#1', '20')),
      add(
        ext('extension#1', 'fake.joint', {
          schemaVersion: 1,
          operation: 'cut',
          scope: ['extrude#1'],
          dependsOn: ['sketch#1', 'extrude#1'],
          expressions: {},
          params: { sketch: 'sketch#1', face, body: 'extrude#1' },
        }),
      ),
    ]);
  }

  it('answers the queries against the part before the feature, then builds', async () => {
    asked.length = 0;
    const { kernel, engine } = withDomains(fakeDomain());
    const r = await regen(engine, jointed());
    expect(statuses(r)).toMatchObject({ 'extrude#1': 'ok', 'extension#1': 'ok' });
    expect(asked).toEqual([{ sketch: 'sketch#1', face: 'extrude#1:cap:end', body: 'extrude#1' }]);
    // The fake kernel puts every plane at z = 20 and every box at 40 x 30 x 20.
    expect((kernel.inputs.get('extension#1') as ExtrudeInput).extent).toEqual({
      type: 'blind',
      distance: 60,
    });
    expect(featureOf(r, 'extension#1').metadata).toEqual({ faceBody: 'extrude#1', z: 20 });
    expect(kernel.sets.get('extension#1')).toEqual(['extrude#1']);
  });

  it('gives an answer the translator can refuse', async () => {
    const { kernel, engine } = withDomains(fakeDomain());
    const r = await regen(engine, jointed('extrude#1:side:gone'));
    expect(featureOf(r, 'extension#1').errors).toEqual([
      { code: 'invalid', message: 'the face is gone' },
    ]);
    expect(kernel.featureOps).toEqual(['extrude#1']);
  });

  it('resolves the feature references with their geometry, and fails a lost one', async () => {
    let seen: unknown;
    const onFace: ExtensionType<BoardParams> = {
      ...board,
      translate(ctx) {
        seen = ctx.references;
        return board.translate(ctx, []);
      },
    };
    const { engine } = withDomains(
      fakeDomain({ types: { 'fake.onface': onFace as ExtensionType } }),
    );
    const on = (face: string) =>
      build([
        add(sketch),
        add(extrude('extrude#1', 'sketch#1', '20')),
        add(
          ext('extension#1', 'fake.onface', {
            operation: 'add',
            references: [{ id: 'r1', ref: { face } }],
          }),
        ),
      ]);
    const r = await regen(engine, on('extrude#1:cap:end'));
    expect(featureOf(r, 'extension#1').status).toBe('ok');
    expect(seen).toEqual({
      r1: {
        body: 'extrude#1',
        target: 'extrude#1:cap:end',
        via: 'exact',
        fragile: false,
        geometry: { kind: 'plane', origin: [0, 0, 20], direction: [0, 0, 1] },
      },
    });
    const lost = await regen(engine, on('extrude#1:side:gone'));
    expect(featureOf(lost, 'extension#1').errors).toEqual([
      {
        code: 'reference-lost',
        referenceId: 'r1',
        target: 'extrude#1:side:gone',
        missing: ['extrude#1:side:gone'],
        message: 'extrude#1:side:gone is lost: re-pick it',
      },
    ]);
  });

  it('gives later extensions of the namespace the results they name', async () => {
    let upstream: unknown;
    const reader: ExtensionType<BoardParams> = {
      ...board,
      translate(ctx) {
        upstream = ctx.upstream.get('extension#1');
        return board.translate(ctx, []);
      },
    };
    const { engine } = withDomains(
      fakeDomain({ types: { ...fakeDomain().types, 'fake.reader': reader as ExtensionType } }),
    );
    const r = await regen(
      engine,
      build([
        add(sketch),
        add(ext('extension#1', 'fake.board', { operation: 'new' })),
        add(
          ext('extension#2', 'fake.reader', {
            operation: 'new',
            dependsOn: ['sketch#1', 'extension#1'],
          }),
        ),
      ]),
    );
    expect(statuses(r)).toMatchObject({ 'extension#2': 'ok' });
    expect(upstream).toMatchObject({
      type: 'fake.board',
      metadata: { thickness: 18 },
      inputs: [{ kind: 'extrude', id: 'extension#1' }],
    });
  });
});

describe('the registry', () => {
  it('checks what registers', () => {
    const registry = new ExtensionRegistry();
    registry.registerDomain(fakeDomain());
    expect(() => registry.registerDomain(fakeDomain())).toThrow(/already registered/);
    expect(() => registry.registerDomain({ namespace: 'Bad', implementation: 1 })).toThrow(
      /not a domain namespace/,
    );
    expect(() =>
      registry.registerDomain({
        namespace: 'shed',
        implementation: 1,
        data: { stock: { schemaVersion: 1, read: (d) => ({ ok: true, value: d }) } },
      }),
    ).toThrow(/already owned by domain "fake"/);
    expect(() =>
      registry.registerDomain({
        namespace: 'shed',
        implementation: 1,
        types: { 'fake.wall': boom },
      }),
    ).toThrow(/not a type of domain "shed"/);
    expect(() => registry.register('nobody.thing', boom)).toThrow(/no domain "nobody"/);
    expect(() => registry.register('fake.boom', boom)).toThrow(/already registered/);
    expect(() =>
      registry.register('fake.zero', { schemaVersion: 0, translate: boom.translate }),
    ).toThrow(/schema version/);
  });

  it('registers and unregisters per type, and knows what each type reads', () => {
    const registry = new ExtensionRegistry();
    registry.registerDomain(fakeDomain({ types: {} }));
    expect(registry.lookup('fake.boom')).toBeUndefined();
    const off = registry.register('fake.boom', boom);
    expect(registry.lookup('fake.boom')).toMatchObject({
      namespace: 'fake',
      implementation: 1,
      reads: ['fake', 'stock'],
    });
    off();
    expect(registry.lookup('fake.boom')).toBeUndefined();
    registry.register('fake.boom', boom);
    expect(registry.unregister('fake.boom')).toBe(true);
    expect(registry.unregister('fake.boom')).toBe(false);
    expect(registry.readsOf('fake.anything')).toEqual(['fake', 'stock']);
    expect(registry.readsOf('nobody.thing')).toEqual(['nobody']);
    expect(registry.reader('stock')?.schemaVersion).toBe(1);
    expect(registry.unregisterDomain('fake')).toBe(true);
    expect(registry.namespaces).toEqual([]);
  });
});
