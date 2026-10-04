// Scripted features end to end in Node (T7.2c): the real kernel service, the real solver and the
// real QuickJS engine (`@manufakture/script/node`). The example scripts of the plan: a parametric
// box with fillets on the edges it made, a bolt circle, a spiral of holes. Checked: volumes, face
// names, references into a script's faces surviving edits, what a parameter change rebuilds,
// script errors with source positions, limits, and the runaway list the watchdog fills.

import {
  applyCommand,
  remapDocument,
  type Command,
  type ManufaktureDocument,
  type Script,
  type ScriptedFeature,
} from '@manufakture/core';
import type { KernelFailure, KernelService, ShapeId } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import { SCRIPT_API_VERSIONS } from '@manufakture/script';
import { nodeScriptEngine } from '@manufakture/script/node';
import { createSolverService, type SolverService } from '@manufakture/sketch';
import { beforeAll, describe, expect, it } from 'vitest';
import { RegenEngine, type RegenKernel } from './engine';
import { SCRIPT_APIS, SCRIPT_API_V1_SURFACE } from './script-api';
import { HOST_ERROR_MESSAGE, scriptRegenError, type ScriptRunEvent } from './scripted';
import {
  PART,
  add,
  build,
  extrude,
  fillet,
  mm,
  rectangle,
  setVariable,
  statuses,
  unwrap,
} from './test-helpers';
import type { RegenError, RegenResult } from './types';

let service: KernelService;
let solver: SolverService;

beforeAll(async () => {
  service = await createNodeService();
  solver = createSolverService();
}, 60_000);

function engineWith(
  options: { timeMs?: number; onRun?: (e: ScriptRunEvent) => void } = {},
): RegenEngine {
  return new RegenEngine({
    kernel: service,
    solver,
    scripts: {
      engine: nodeScriptEngine,
      limits: { timeMs: options.timeMs ?? 2000 },
      ...(options.onRun ? { onRun: options.onRun } : {}),
    },
  });
}

async function volumeOf(engine: RegenEngine, shape: ShapeId): Promise<number> {
  const reply = await service.run({
    generation: engine.generation,
    ops: [{ op: 'properties', shape }],
  });
  const r = reply.results[0]!;
  if (!r.ok) throw new Error(r.error.message);
  return (r.value as { volume: number }).volume;
}

async function totalVolume(engine: RegenEngine, result: RegenResult): Promise<number> {
  let v = 0;
  for (const b of result.parts[0]!.bodies) v += await volumeOf(engine, b.shape!);
  return v;
}

function faceNamesOf(shape: ShapeId): string[] {
  return service.kernel.named(shape)!.names.faces.map((f) => f.name);
}

function feature(result: RegenResult, id: string) {
  return result.parts[0]!.features.find((f) => f.featureId === id)!;
}

const script = (source: string, over: Partial<Script> = {}): Script => ({
  id: 'script#1',
  name: 'Script',
  language: 'js',
  apiVersion: 1,
  source,
  ...over,
});

const scripted = (over: Partial<ScriptedFeature> = {}): ScriptedFeature => ({
  id: 'scripted#1',
  kind: 'scripted',
  name: 'Scripted 1',
  suppressed: false,
  script: 'script#1',
  params: {},
  seed: 0,
  dependsOn: [],
  ...over,
});

type Edit = Command | ((doc: ManufaktureDocument) => Command);

function edit(doc: ManufaktureDocument, ...edits: Edit[]): ManufaktureDocument {
  for (const e of edits)
    doc = unwrap(applyCommand(doc, typeof e === 'function' ? e(doc) : e)).document;
  return doc;
}

/** Edit the scripted feature: its whole new state, as `editFeature` takes it. */
const editScripted =
  (changes: Partial<ScriptedFeature>, id = 'scripted#1'): Edit =>
  (doc) => {
    const f = doc.parts[0]!.features.find((x) => x.id === id) as ScriptedFeature;
    return { type: 'editFeature', partId: PART, feature: { ...f, ...changes } };
  };

const setParams = (params: ScriptedFeature['params']): Edit => editScripted({ params });

// The example scripts ---------------------------------------------------------------------------

/** A parametric box, its vertical edges filleted: TypeScript, so erasure and positions count. */
const BOX = `import type { Ctx } from 'manufakture';

export const params = {
  width: { kind: 'length', default: 40, min: 1 },
  depth: { kind: 'length', default: 30, min: 1 },
  height: { kind: 'length', default: 20, min: 1 },
  radius: { kind: 'length', default: 2, min: 0 },
};

interface Size { width: number; depth: number; height: number; radius: number }

export function run(ctx: any, p: Size): void {
  const base = ctx.sketch('base', {
    plane: 'XY',
    loops: [[
      { kind: 'line', id: 'front', start: [0, 0], end: [p.width, 0] },
      { kind: 'line', id: 'right', start: [p.width, 0], end: [p.width, p.depth] },
      { kind: 'line', id: 'back', start: [p.width, p.depth], end: [0, p.depth] },
      { kind: 'line', id: 'left', start: [0, p.depth], end: [0, 0] },
    ]],
  });
  const box = ctx.extrude('box', base, { distance: p.height });
  if (p.radius > 0) ctx.fillet('round', ctx.edges(box, { direction: [0, 0, 1] }), p.radius);
}
`;

const boxVolume = (w: number, d: number, h: number, r: number) =>
  w * d * h - (4 - Math.PI) * r * r * h;

/** A plate with a bolt circle: one hole cut, then patterned round the axis. */
const BOLT_CIRCLE = `
export const params = {
  count: { kind: 'number', default: 6, min: 1, max: 64, integer: true },
  pitch: { kind: 'length', default: 30 },
  hole: { kind: 'length', default: 3 },
};
export function run(ctx, p) {
  const disk = ctx.sketch('disk', { loops: [[{ kind: 'circle', id: 'rim', center: [0, 0], radius: 50 }]] });
  ctx.extrude('plate', disk, { distance: 10 });
  const at = ctx.sketch('spot', {
    plane: { origin: [0, 0, 10], normal: [0, 0, 1] },
    loops: [[{ kind: 'circle', id: 'c', center: [p.pitch, 0], radius: p.hole }]],
  });
  const drill = ctx.extrude('drill', at, { through: true, reverse: true, mode: 'cut' });
  ctx.pattern('circle', drill, { circular: { axis: { origin: [0, 0, 0], direction: [0, 0, 1] }, count: p.count } });
}
`;

/** A block with a spiral of holes, one cut per hole, placed with Math.cos and Math.sin. */
const SPIRAL = `
export const params = { turns: { kind: 'number', default: 1.5 }, holes: { kind: 'number', default: 9, integer: true, min: 1, max: 40 } };
export function run(ctx, p) {
  const block = ctx.sketch('block', { loops: [[
    { kind: 'line', id: 'a', start: [-50, -50], end: [50, -50] },
    { kind: 'line', id: 'b', start: [50, -50], end: [50, 50] },
    { kind: 'line', id: 'c', start: [50, 50], end: [-50, 50] },
    { kind: 'line', id: 'd', start: [-50, 50], end: [-50, -50] },
  ]] });
  ctx.extrude('slab', block, { distance: 5 });
  for (let i = 0; i < p.holes; i++) {
    const t = (i / p.holes) * p.turns * 2 * Math.PI;
    const r = 10 + 30 * (i / p.holes);
    const s = ctx.sketch('at' + i, {
      plane: { origin: [0, 0, 5], normal: [0, 0, 1] },
      loops: [[{ kind: 'circle', id: 'c', center: [r * Math.cos(t), r * Math.sin(t)], radius: 2 }]],
    });
    ctx.extrude('hole' + i, s, { through: true, reverse: true, mode: 'cut' });
  }
  return { holes: ctx.faces(undefined, { surface: 'cylinder' }).length };
}
`;

function scriptDoc(
  source: string,
  params: ScriptedFeature['params'] = {},
  over: Partial<Script> = {},
) {
  return build([{ type: 'setScript', script: script(source, over) }, add(scripted({ params }))]);
}

describe('scripted features: the example scripts', () => {
  it('a parametric box: volume, names born in the script, fillets on the edges it made', async () => {
    const engine = engineWith();
    const doc = scriptDoc(BOX, {}, { language: 'ts' });
    const r = (await engine.regen(doc))!;
    expect(statuses(r)).toEqual({ 'scripted#1': 'ok' });
    const bodies = r.parts[0]!.bodies;
    expect(bodies.map((b) => b.bodyId)).toEqual(['scripted#1:box']);
    expect(await volumeOf(engine, bodies[0]!.shape!)).toBeCloseTo(boxVolume(40, 30, 20, 2), 3);
    const names = faceNamesOf(bodies[0]!.shape!);
    expect(names).toContain('scripted#1:box/cap:end');
    expect(names).toContain('scripted#1:box/cap:start');
    expect(names).toContain('scripted#1:box/side:front');
    expect(names).toContain(
      'scripted#1:round/round:scripted#1:box/side:front&scripted#1:box/side:right',
    );
    expect(names.every((n) => !n.includes('scriptop'))).toBe(true);
    // The viewport's name table carries the script's names.
    expect(r.names).toContain('scripted#1:box/cap:end');
    await engine.dispose();
  });

  it('a bolt circle: a cut and a circular pattern of it', async () => {
    const engine = engineWith();
    const r = (await engine.regen(scriptDoc(BOLT_CIRCLE)))!;
    expect(statuses(r)).toEqual({ 'scripted#1': 'ok' });
    const body = r.parts[0]!.bodies[0]!;
    expect(body.bodyId).toBe('scripted#1:plate');
    const v = Math.PI * 50 * 50 * 10 - 6 * Math.PI * 9 * 10;
    expect(await volumeOf(engine, body.shape!)).toBeCloseTo(v, 2);
    const names = faceNamesOf(body.shape!);
    expect(names).toContain('scripted#1:drill/side:c');
    expect(names).toContain('scripted#1:circle/i2/scripted#1:drill/side:c');
    expect(names).toContain('scripted#1:circle/i6/scripted#1:drill/side:c');
    // Eight holes now: only the scripted feature reran.
    const more = (await engine.regen(
      edit(
        scriptDoc(BOLT_CIRCLE),
        setParams({ count: { kind: 'expression', expression: mm('8') } }),
      ),
    ))!;
    expect(await volumeOf(engine, more.parts[0]!.bodies[0]!.shape!)).toBeCloseTo(
      Math.PI * 50 * 50 * 10 - 8 * Math.PI * 9 * 10,
      2,
    );
    await engine.dispose();
  });

  it('a spiral of holes placed with Math.cos and Math.sin, one operation per hole', async () => {
    const engine = engineWith();
    const r = (await engine.regen(scriptDoc(SPIRAL)))!;
    expect(statuses(r)).toEqual({ 'scripted#1': 'ok' });
    const body = r.parts[0]!.bodies[0]!;
    expect(await volumeOf(engine, body.shape!)).toBeCloseTo(100 * 100 * 5 - 9 * Math.PI * 4 * 5, 2);
    const names = faceNamesOf(body.shape!);
    for (let i = 0; i < 9; i++) expect(names).toContain(`scripted#1:hole${i}/side:c`);
    await engine.dispose();
  });
});

describe('scripted features in the part', () => {
  /** A GUI block, a script putting a boss on its top face (a reference parameter), and a GUI
   * fillet on an edge the script made. */
  const BOSS = `
export const params = {
  on: { kind: 'reference', select: 'face' },
  size: { kind: 'length', default: 5 },
  tall: { kind: 'length', default: 8 },
};
export function run(ctx, p) {
  const s = ctx.sketch('spot', { plane: p.on, loops: [[{ kind: 'circle', id: 'c', center: [20, 15], radius: p.size }]] });
  ctx.extrude('boss', s, { distance: p.tall, mode: 'add' });
}
`;
  function bossDoc(size = '5'): ManufaktureDocument {
    return build([
      setVariable('size', size),
      add(rectangle('sketch#1', { width: '40', depth: '30' })),
      add(extrude('extrude#1', 'sketch#1', '20')),
      { type: 'setScript', script: script(BOSS) },
      add(
        scripted({
          params: {
            on: {
              kind: 'reference',
              references: [{ id: 'r1', ref: { face: 'extrude#1:cap:end' } }],
            },
            size: { kind: 'expression', expression: mm('size') },
          },
        }),
      ),
      add(fillet('fillet#1', ['scripted#1:boss/cap:end', 'scripted#1:boss/side:c'], '1', 'r2')),
    ]);
  }

  it('builds on a GUI body, and a GUI fillet resolves an edge the script made, through edits', async () => {
    const engine = engineWith();
    const r = (await engine.regen(bossDoc()))!;
    expect(statuses(r)).toEqual({
      'sketch#1': 'ok',
      'extrude#1': 'ok',
      'scripted#1': 'ok',
      'fillet#1': 'ok',
    });
    expect(feature(r, 'scripted#1').references).toEqual([
      { referenceId: 'r1', target: 'extrude#1:cap:end', via: 'exact', fragile: false },
    ]);
    // The boss fused into the block: one body, the block's, changed.
    expect(r.parts[0]!.bodies.map((b) => b.bodyId)).toEqual(['extrude#1']);
    expect(feature(r, 'fillet#1').references[0]).toMatchObject({
      target: 'scripted#1:boss/cap:end|scripted#1:boss/side:c',
      via: 'exact',
    });
    const v5 = await totalVolume(engine, r);
    // A bigger boss through the variable: the script reruns, the fillet still finds its edge.
    const bigger = (await engine.regen(bossDoc('7')))!;
    expect(statuses(bigger)).toEqual({
      'sketch#1': 'ok',
      'extrude#1': 'ok',
      'scripted#1': 'ok',
      'fillet#1': 'ok',
    });
    expect(feature(bigger, 'scripted#1').cached).toBe(false);
    expect(feature(bigger, 'extrude#1').cached).toBe(true);
    expect(feature(bigger, 'fillet#1').references[0]!.via).toBe('exact');
    // The boss grew by pi (7^2 - 5^2) 8; the fillet round its top edge removes (1 - pi/4) 2 pi
    // more per mm of radius (Pappus).
    expect((await totalVolume(engine, bigger)) - v5).toBeCloseTo(
      Math.PI * (49 - 25) * 8 - (1 - Math.PI / 4) * 2 * Math.PI * 2,
      3,
    );
    await engine.dispose();
  });

  it('hits the cache only where it should: parameters, seed, script source, other variables', async () => {
    const engine = engineWith();
    const base = bossDoc();
    await engine.regen(base);
    const runs = () => engine.scriptStats!.runs;
    const before = runs();
    // The same document again: nothing runs.
    const again = (await engine.regen(edit(base, setVariable('unrelated', '1'))))!;
    expect(runs()).toBe(before);
    expect(feature(again, 'scripted#1').cached).toBe(true);
    // The seed is in the key (it seeds Math.random).
    const seeded = (await engine.regen(edit(base, editScripted({ seed: 7 }))))!;
    expect(feature(seeded, 'scripted#1').cached).toBe(false);
    expect(runs()).toBe(before + 1);
    // So is the source, even a comment.
    const commented = (await engine.regen(
      edit(base, { type: 'setScript', script: script(`${BOSS}// a comment\n`) }),
    ))!;
    expect(feature(commented, 'scripted#1').cached).toBe(false);
    expect(runs()).toBe(before + 2);
    // Back to the first document: every result from the cache.
    const back = (await engine.regen(base))!;
    expect(back.parts[0]!.features.every((f) => f.cached)).toBe(true);
    expect(runs()).toBe(before + 2);
    await engine.dispose();
  });

  it('the feature id is in the key: a remapped id misses and its faces carry the new id', async () => {
    const engine = engineWith();
    const doc = scriptDoc(BOX, {}, { language: 'ts' });
    const first = (await engine.regen(doc))!;
    const key = feature(first, 'scripted#1').key!;
    // Sync renamed the feature: a hit would serve bodies and faces named scripted#1.
    const remapped = remapDocument(doc, { [`part:${PART}`]: { 'scripted#1': 'scripted#4' } });
    const r = (await engine.regen(remapped))!;
    const f = feature(r, 'scripted#4');
    expect(f.status).toBe('ok');
    expect(f.cached).toBe(false);
    expect(f.key).not.toBe(key);
    const body = r.parts[0]!.bodies[0]!;
    expect(body.bodyId).toBe('scripted#4:box');
    const names = faceNamesOf(body.shape!);
    expect(names).toContain('scripted#4:box/cap:end');
    expect(names.some((n) => n.includes('scripted#1'))).toBe(false);
    // Renamed back (undo): the first result again, from the cache.
    const back = (await engine.regen(doc))!;
    expect(feature(back, 'scripted#1')).toMatchObject({ cached: true, key });
    await engine.dispose();
  });

  it('a duplicated part whose scripted id was remapped misses; the original part still hits', async () => {
    const engine = engineWith();
    const doc = scriptDoc(BOX, {}, { language: 'ts' });
    await engine.regen(doc);
    const duplicated = edit(doc, {
      type: 'duplicatePart',
      sourcePartId: PART,
      partId: 'part#2',
      name: 'Copy',
    });
    const remapped = remapDocument(duplicated, {
      ['part:part#2']: { 'scripted#1': 'scripted#3' },
    });
    const runs = engine.scriptStats!.runs;
    const r = (await engine.regen(remapped))!;
    const original = r.parts.find((p) => p.partId === PART)!;
    const copy = r.parts.find((p) => p.partId === 'part#2')!;
    expect(original.features.find((f) => f.featureId === 'scripted#1')!.cached).toBe(true);
    const f = copy.features.find((x) => x.featureId === 'scripted#3')!;
    expect(f).toMatchObject({ status: 'ok', cached: false });
    expect(engine.scriptStats!.runs).toBe(runs + 1);
    expect(copy.bodies.map((b) => b.bodyId)).toEqual(['scripted#3:box']);
    const names = faceNamesOf(copy.bodies[0]!.shape!);
    expect(names).toContain('scripted#3:box/cap:end');
    expect(names.some((n) => n.includes('scripted#1'))).toBe(false);
    await engine.dispose();
  });

  it('a lost reference parameter is a reference error, not a script run', async () => {
    const engine = engineWith();
    const doc = edit(
      bossDoc(),
      setParams({
        on: { kind: 'reference', references: [{ id: 'r1', ref: { face: 'extrude#1:side:e9' } }] },
      }),
    );
    const r = (await engine.regen(doc))!;
    expect(feature(r, 'scripted#1').status).toBe('error');
    expect(feature(r, 'scripted#1').errors[0]).toMatchObject({
      code: 'reference-lost',
      referenceId: 'r1',
    });
    expect(feature(r, 'fillet#1').status).toBe('upstream-error');
    expect(engine.scriptStats!.runs).toBe(0);
    await engine.dispose();
  });

  it('evaluates numeric parameters as declared: units and dimension errors', async () => {
    const engine = engineWith();
    const inches = edit(
      scriptDoc(BOX, {}, { language: 'ts' }),
      setParams({
        width: {
          kind: 'expression',
          expression: { source: '2in', lengthUnit: 'mm', angleUnit: 'deg' },
        },
      }),
    );
    const r = (await engine.regen(inches))!;
    expect(await volumeOf(engine, r.parts[0]!.bodies[0]!.shape!)).toBeCloseTo(
      boxVolume(50.8, 30, 20, 2),
      3,
    );
    const wrong = edit(
      inches,
      setParams({ width: { kind: 'expression', expression: mm('30deg') } }),
    );
    const w = (await engine.regen(wrong))!;
    expect(feature(w, 'scripted#1').errors[0]).toMatchObject({
      code: 'expression',
      field: ['params', 'width', 'expression'],
    });
    const kind = edit(inches, setParams({ width: { kind: 'boolean', value: true } }));
    const k = (await engine.regen(kind))!;
    expect(feature(k, 'scripted#1').errors[0]).toMatchObject({
      code: 'script',
      scriptCode: 'bad-param',
    });
    await engine.dispose();
  });
});

describe('scripted features: errors', () => {
  async function errorOf(
    source: string,
    over: Partial<Script> = {},
    timeMs?: number,
  ): Promise<RegenError> {
    const engine = engineWith(timeMs === undefined ? {} : { timeMs });
    const r = (await engine.regen(scriptDoc(source, {}, over)))!;
    await engine.dispose();
    const f = feature(r, 'scripted#1');
    expect(f.status).toBe('error');
    return f.errors[0]!;
  }

  it('a throw is a script error at its position, mapped through TypeScript erasure', async () => {
    const e = await errorOf(
      'const width: number = 3;\nexport function run(ctx: any): void {\n  const n: number = width;\n  throw new Error("no " + n);\n}\n',
      { language: 'ts' },
    );
    expect(e).toMatchObject({
      code: 'script',
      scriptCode: 'runtime',
      scriptId: 'script#1',
      line: 4,
    });
    expect(e.message).toContain('no 3');
  });

  it('a failed operation the script does not catch, with the operation in the message', async () => {
    const e = await errorOf(`
export function run(ctx) {
  const s = ctx.sketch('s', { loops: [[{ kind: 'circle', id: 'c', center: [0, 0], radius: 5 }]] });
  ctx.extrude('cut', s, { distance: 5, mode: 'cut' });
}`);
    expect(e).toMatchObject({ code: 'script', scriptCode: 'runtime', line: 4 });
    expect(e.message).toContain('extrude cut failed');
  });

  it('a script may catch a failed operation and go on', async () => {
    const engine = engineWith();
    const r = (await engine.regen(
      scriptDoc(`
export function run(ctx) {
  const s = ctx.sketch('s', { loops: [[{ kind: 'circle', id: 'c', center: [0, 0], radius: 5 }]] });
  try { ctx.extrude('cut', s, { distance: 5, mode: 'cut' }); } catch (e) { /* no body yet */ }
  ctx.extrude('post', s, { distance: 5 });
}`),
    ))!;
    expect(statuses(r)).toEqual({ 'scripted#1': 'ok' });
    expect(r.parts[0]!.bodies.map((b) => b.bodyId)).toEqual(['scripted#1:post']);
    await engine.dispose();
  });

  it('refuses bad arguments: operation ids, non-finite numbers, unknown options', async () => {
    const sketch = `ctx.sketch('s', { loops: [[{ kind: 'circle', id: 'c', center: [0, 0], radius: 5 }]] })`;
    for (const [call, text] of [
      [`ctx.extrude('Bad', ${sketch}, { distance: 1 })`, 'operation id'],
      [
        `const s = ${sketch}; ctx.extrude('a', s, { distance: 1 }); ctx.extrude('a', s, { distance: 1 })`,
        'used twice',
      ],
      [`ctx.extrude('a', ${sketch}, { distance: NaN })`, 'finite'],
      [`ctx.extrude('a', ${sketch}, { distance: 1e9 })`, 'within'],
      [`ctx.extrude('a', ${sketch}, { distance: 1, colour: 'red' })`, 'unknown option'],
      [`ctx.extrude('a', { kind: 'sketch' }, { distance: 1 })`, 'must be a sketch'],
      [
        `ctx.sketch('s', { loops: [[{ kind: 'circle', id: 'e#1', center: [0, 0], radius: 5 }]] })`,
        'id must be',
      ],
      [`ctx.fillet('f', [], 1)`, 'give 1 to'],
    ] as const) {
      const e = await errorOf(`export function run(ctx) { ${call}; }`);
      expect(e, call).toMatchObject({ code: 'script', scriptCode: 'runtime' });
      expect(e.message, call).toContain(text);
    }
  });

  it('an infinite loop fails with timeout; a declaration error with bad-declaration', async () => {
    expect(await errorOf('export function run(ctx) { for (;;) {} }', {}, 200)).toMatchObject({
      code: 'script',
      scriptCode: 'timeout',
    });
    expect(await errorOf('export const params = 3;\nexport function run() {}')).toMatchObject({
      scriptCode: 'bad-declaration',
    });
    expect(await errorOf('export function run( {')).toMatchObject({
      scriptCode: 'syntax',
      line: 1,
    });
  });

  it('a script API version this build does not have, before anything runs', async () => {
    expect(await errorOf('export function run() {}', { apiVersion: 99 })).toMatchObject({
      code: 'script',
      scriptCode: 'api-version',
    });
  });

  it('a runaway run the watchdog stopped fails with timeout and does not run again', async () => {
    const events: ScriptRunEvent[] = [];
    const engine = engineWith({ onRun: (e) => events.push(e) });
    const doc = scriptDoc(BOX, {}, { language: 'ts' });
    const first = (await engine.regen(doc))!;
    const key = feature(first, 'scripted#1').key!;
    // Every run was announced with the feature's key, start then end.
    expect(events.map((e) => e.phase)).toEqual(['start', 'end', 'start', 'end']);
    expect(new Set(events.map((e) => e.key))).toEqual(new Set([key]));
    // A fresh engine (the restarted worker) told about the key.
    const restarted = engineWith();
    restarted.addRunawayScripts([key]);
    const r = (await restarted.regen(doc))!;
    expect(feature(r, 'scripted#1').errors[0]).toMatchObject({
      code: 'script',
      scriptCode: 'timeout',
    });
    expect(restarted.scriptStats!.runs).toBe(0);
    // A parameter change makes a new key: it runs again.
    const changed = (await restarted.regen(
      edit(doc, setParams({ radius: { kind: 'expression', expression: mm('1') } })),
    ))!;
    expect(statuses(changed)).toEqual({ 'scripted#1': 'ok' });
    await engine.dispose();
    await restarted.dispose();
  });

  it('a run that took the kernel down is remembered: no recycle loop until the key changes', async () => {
    // A kernel whose sessions fail fatally (as an out-of-memory trap does), on the real service.
    let sessions = 0;
    const kernel: RegenKernel = {
      run: (request) => service.run(request),
      release: (shapes) => service.release(shapes),
      cancel: (generation) => service.cancel(generation),
      stats: () => service.stats(),
      session: async (request) => {
        sessions++;
        const real = await service.session(request, async () => ({ value: null, keep: [] }));
        const error: KernelFailure = {
          code: 'fatal',
          operation: 'session',
          message: 'memory access out of bounds',
        };
        return { ...real, result: { ok: false, error }, recycle: 'fatal' };
      },
    };
    const engine = new RegenEngine({
      kernel,
      solver,
      scripts: { engine: nodeScriptEngine, limits: { timeMs: 2000 } },
    });
    const doc = scriptDoc(BOX, {}, { language: 'ts' });
    const first = (await engine.regen(doc))!;
    expect(feature(first, 'scripted#1').errors[0]).toMatchObject({ code: 'kernel' });
    expect(sessions).toBe(1);
    // The recycle made the host regenerate: the feature fails without a session.
    const again = (await engine.regen(doc))!;
    expect(feature(again, 'scripted#1').status).toBe('error');
    expect(feature(again, 'scripted#1').errors[0]).toMatchObject({
      code: 'script',
      scriptCode: 'session-fatal',
      scriptId: 'script#1',
    });
    expect(feature(again, 'scripted#1').errors[0]!.message).toContain('change the script');
    expect(sessions).toBe(1);
    // A parameter change makes a new key: it runs again.
    await engine.regen(
      edit(doc, setParams({ radius: { kind: 'expression', expression: mm('1') } })),
    );
    expect(sessions).toBe(2);
    await engine.dispose();
  });

  it('a host-error shows a fixed message; the raw text is kept only in detail', () => {
    const e = scriptRegenError('script#1', {
      code: 'host-error',
      message: 'ctx.extrude failed: TypeError: Cannot read properties of undefined (reading "x")',
    });
    expect(e).toMatchObject({
      code: 'script',
      scriptCode: 'host-error',
      scriptId: 'script#1',
      message: HOST_ERROR_MESSAGE,
    });
    expect(e.message).not.toContain('TypeError');
    expect(e).toHaveProperty('detail', expect.stringContaining('TypeError'));
    // Other script errors are the script's own and keep their text.
    expect(scriptRegenError('script#1', { code: 'runtime', message: 'no 3' }).message).toBe('no 3');
  });

  it('without a script engine a scripted feature is unsupported, never a crash', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const r = (await engine.regen(scriptDoc(BOX)))!;
    expect(feature(r, 'scripted#1').errors[0]).toMatchObject({ code: 'unsupported' });
    await engine.dispose();
  });
});

describe('script API versions', () => {
  it('every version the sandbox runs has a ctx here, and version 1 is exactly its surface', () => {
    for (const v of SCRIPT_API_VERSIONS) expect(SCRIPT_APIS.has(v), `version ${v}`).toBe(true);
    const paths: string[] = [];
    const walk = (node: object, prefix: string) => {
      for (const [k, v] of Object.entries(node)) {
        const path = prefix === '' ? k : `${prefix}.${k}`;
        if (typeof v === 'function' || (v !== null && typeof v === 'object' && 'fn' in v))
          paths.push(path);
        else walk(v as object, path);
      }
    };
    walk(SCRIPT_APIS.get(1)!({} as never), '');
    // Additions within a version are allowed only when they cannot change what a script sees;
    // a removal or a change is a new version. This list only grows.
    expect(paths.sort()).toEqual([...SCRIPT_API_V1_SURFACE]);
  });
});
