import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  QUICKJS_BUILD,
  type ScriptInstance,
  type ScriptInstanceOptions,
  type ScriptRunRequest,
} from './engine';
import { MAX_SOURCE_LENGTH } from './erase';
import { ScriptHostError } from './errors';
import { kernelOp, ScriptHandle, type HostApi, type ScriptValue } from './host';
import { DEFAULT_LIMITS } from './limits';
import { nodeScriptEngine } from './node';

const MIB = 1024 * 1024;

async function instance(options: ScriptInstanceOptions = {}): Promise<ScriptInstance> {
  return (await nodeScriptEngine()).createInstance(options);
}

function js(source: string, extra: Partial<ScriptRunRequest> = {}): ScriptRunRequest {
  return { source, language: 'js', apiVersion: 1, ...extra };
}

/**
 * A real clock that counts its reads. The cost tests assert on the count rather than on wall time:
 * the count is the same on an idle machine and under heavy load, and a guard that read the clock on
 * every call (the regression they exist for) multiplies it by about 100. The interrupt handler's
 * own polls (every 10,000 bytecode branches) are in the count too, so it is never zero.
 */
function countingClock(): { now: () => number; reads: () => number } {
  let reads = 0;
  return {
    now: () => {
      reads++;
      return performance.now();
    },
    reads: () => reads,
  };
}

/** `run` returning `expression` (so tests read as the expression they check). */
const returning = (expression: string) =>
  `export function run(ctx, params) { return ${expression}; }`;

async function value(source: string, extra: Partial<ScriptRunRequest> = {}): Promise<ScriptValue> {
  const out = await (await instance()).run(js(source, extra));
  if (!out.ok) throw new Error(`${out.error.code}: ${out.error.message}`);
  return out.value;
}

/** The bits of every double in a value, so determinism checks compare exactly. */
function bits(v: unknown): unknown {
  if (typeof v === 'number') {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, v);
    return view.getBigUint64(0).toString(16);
  }
  if (Array.isArray(v)) return v.map(bits);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bits(x)]));
  }
  return v;
}

describe('running a script', () => {
  it('passes params and a host API, and returns plain data with handles', async () => {
    const made: ScriptHandle[] = [];
    const host: HostApi = {
      box: kernelOp((size) => {
        const h = new ScriptHandle('body', { size: size as number });
        made.push(h);
        return h;
      }),
      measure: { volume: (h) => (h as ScriptHandle<{ size: number }>).value.size ** 3 },
    };
    const inst = await instance();
    const out = await inst.run(
      js(
        `export function run(ctx, p) {
           const b = ctx.box(p.size);
           return { body: b, kind: b.kind, text: String(b), volume: ctx.measure.volume(b), frozen: Object.isFrozen(b) };
         }`,
        { params: { size: 3 }, host },
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const result = out.value as Record<string, ScriptValue>;
    expect(result.body).toBe(made[0]);
    expect(result).toMatchObject({ kind: 'body', text: '[handle body]', volume: 27, frozen: true });
    expect(out.stats).toMatchObject({ hostCalls: 2, kernelOps: 1, recycled: false });
  });

  it('carries NaN, the infinities and -0 both ways, and undefined as JSON does', async () => {
    const out = await value(
      `export function run(ctx) {
         const back = ctx.echo([NaN, Infinity, -Infinity, -0, 0]);
         return { back, signs: back.map((x) => Object.is(x, -0)), list: [1, undefined], gone: undefined, nothing: ctx.nothing() };
       }`,
      { host: { echo: (v) => v, nothing: () => undefined } },
    );
    const r = out as { back: number[]; signs: boolean[]; list: unknown[]; nothing?: unknown };
    expect(r.back[0]).toBeNaN();
    expect(r.back.slice(1, 3)).toEqual([Infinity, -Infinity]);
    expect(Object.is(r.back[3], -0)).toBe(true);
    expect(r.signs).toEqual([false, false, false, true, false]);
    expect(r.list).toEqual([1, null]);
    expect('gone' in r).toBe(false);
    expect('nothing' in r).toBe(false);
  });

  it('returns undefined when run returns nothing', async () => {
    expect(await value('export function run() {}')).toBeUndefined();
  });

  it('lets a script catch a ScriptHostError, and ends the run on any other host exception', async () => {
    const host: HostApi = {
      picky: () => {
        throw new ScriptHostError('picky: no');
      },
      broken: () => {
        throw new Error('bug');
      },
    };
    const caught = await value(
      returning('(() => { try { ctx.picky(); } catch (e) { return e.message; } })()'),
      { host },
    );
    expect(caught).toBe('picky: no');
    const out = await (
      await instance()
    ).run(
      js(returning('(() => { try { ctx.broken(); } catch (e) { return "swallowed"; } })()'), {
        host,
      }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok)
      expect(out.error).toMatchObject({ code: 'host-error', message: 'broken failed: bug' });
  });

  it('refuses values that are not plain data, as an ordinary error the script can catch', async () => {
    const host = { take: () => 1 };
    for (const bad of ['() => 1', 'new Map()', 'Symbol()', '1n', '[new Uint8Array(2)]']) {
      const out = await (await instance()).run(js(returning(`ctx.take(${bad})`), { host }));
      expect(out.ok, bad).toBe(false);
      if (!out.ok) expect(out.error.code, bad).toBe('runtime');
    }
    const caught = await value(
      returning(
        '(() => { try { ctx.take(() => 1); } catch (e) { return e instanceof TypeError; } })()',
      ),
      { host },
    );
    expect(caught).toBe(true);
  });

  it('runs TypeScript, enums included, and maps error positions to the TypeScript source', async () => {
    const source = [
      'interface Params { width: number }',
      'enum Side { Left, Right }',
      'export function run(ctx: unknown, p: Params): number {',
      '  const w: number = p.width as number; const missing: any = undefined;',
      '  return Side.Right + w + missing.field;',
      '}',
    ].join('\n');
    const out = await (
      await instance()
    ).run({ source, language: 'ts', apiVersion: 1, params: { width: 2 } });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('runtime');
    expect(out.error.line).toBe(5);
    // The same expression in plain JavaScript points at the same character.
    const plain = await (
      await instance()
    ).run(
      js(
        [
          '',
          '',
          'export function run(ctx, p) {',
          '  const w = p.width; const missing = undefined;',
          '  return 1 + w + missing.field;',
          '}',
        ].join('\n'),
        { params: { width: 2 } },
      ),
    );
    if (plain.ok) throw new Error('expected an error');
    const tsLine = source.split('\n')[4]!;
    const jsLine = '  return 1 + w + missing.field;';
    expect(tsLine.slice(out.error.column! - 1)).toBe(jsLine.slice(plain.error.column! - 1));
    expect(out.error.stack).toContain(`script.ts:5:${out.error.column}`);
  });

  it('reports syntax errors with positions, in JavaScript and TypeScript', async () => {
    const inst = await instance();
    const a = await inst.run(js('export function run() {\n  return 1 +;\n}'));
    expect(a.ok ? null : a.error).toMatchObject({ code: 'syntax', line: 2 });
    const b = await inst.run({
      source: 'const a: number = 1;\nlet b: = 2;',
      language: 'ts',
      apiVersion: 1,
    });
    expect(b.ok ? null : b.error).toMatchObject({ code: 'syntax', line: 2, column: 8 });
  });

  it('refuses top-level await, async run and imports', async () => {
    const inst = await instance();
    const tla = await inst.run(js('await 1;\nexport function run() { return 1; }'));
    expect(tla.ok ? null : tla.error.message).toMatch(/Top-level await/);
    const asyncRun = await inst.run(js('export async function run() { return 1; }'));
    expect(asyncRun.ok ? null : asyncRun.error.message).toMatch(/async functions/);
    const imported = await inst.run(js("import x from 'fs';\nexport function run() { return x; }"));
    expect(imported.ok ? null : imported.error).toMatchObject({
      code: 'unsupported-syntax',
      line: 1,
      column: 1,
    });
  });

  it('reports thrown non-errors', async () => {
    const out = await (await instance()).run(js('export function run() { throw "boom"; }'));
    expect(out.ok ? null : out.error).toMatchObject({
      code: 'runtime',
      message: 'The script threw "boom".',
    });
  });
});

describe('declarations', () => {
  it('reads params and the declared API version without calling run', async () => {
    const inst = await instance();
    const out = await inst.readDeclarations(
      js(`export const apiVersion = 1;
          export const params = {
            width: { kind: 'length', default: 40, min: 1, label: 'Width' },
            count: { kind: 'number', default: 6, min: 1, max: 64, integer: true },
            style: { kind: 'choice', options: ['round', 'square'], default: 'round' },
          };
          export function run() { for (;;) {} }`),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.declaredApiVersion).toBe(1);
    expect(out.value.params.map((p) => p.name)).toEqual(['width', 'count', 'style']);
    expect(out.value.params[0]).toEqual({
      name: 'width',
      kind: 'length',
      default: 40,
      min: 1,
      label: 'Width',
    });
    expect(out.stats.ms).toBeLessThan(500);
  });

  it('needs a run function and well-formed params', async () => {
    const inst = await instance();
    const noRun = await inst.readDeclarations(js('export const params = {};'));
    expect(noRun.ok ? null : noRun.error.code).toBe('bad-declaration');
    const badParams = await inst.readDeclarations(
      js(
        "export const params = { w: { kind: 'length', default: 'ten' } }; export function run() {}",
      ),
    );
    expect(badParams.ok ? null : badParams.error).toMatchObject({
      code: 'bad-declaration',
      message: 'Parameter "w": default must be a finite number.',
    });
  });
});

describe('API versions', () => {
  it('refuses an unknown version before running anything', async () => {
    const inst = await instance();
    const out = await inst.run(js('export function run() { for (;;) {} }', { apiVersion: 2 }));
    expect(out.ok ? null : out.error.code).toBe('api-version');
    if (!out.ok)
      expect(out.error.message).toMatch(/needs script API version 2.*Update manufakture/);
    expect(out.stats.ms).toBeLessThan(100);
    const zero = await inst.run(js('export function run() {}', { apiVersion: 0 }));
    expect(zero.ok ? null : zero.error.code).toBe('api-version');
  });

  it('refuses a declared version that differs from the stamped one, or that it does not know', async () => {
    const inst = await instance();
    const mismatch = await inst.readDeclarations(
      js('export const apiVersion = 3; export function run() {}'),
    );
    expect(mismatch.ok ? null : mismatch.error.code).toBe('api-version');
  });
});

describe('limits', () => {
  // Tolerance past the deadline for script code and guarded builtins: T7.0c measured 2 ms for
  // script loops; a guarded builtin adds at most one call. Generous for loaded CI machines.
  const TOLERANCE_MS = 250;

  async function failsWith(
    source: string,
    code: string,
    options: ScriptInstanceOptions = {},
    extra: Partial<ScriptRunRequest> = {},
  ) {
    const inst = await instance(options);
    const out = await inst.run(js(source, extra));
    expect(out.ok, `expected ${code}`).toBe(false);
    if (!out.ok) expect(out.error.code).toBe(code);
    return { inst, out };
  }

  it('stops an infinite loop at the time limit', async () => {
    const { out } = await failsWith('export function run() { for (;;) {} }', 'timeout', {
      limits: { timeMs: 200 },
    });
    expect(out.stats.ms).toBeGreaterThanOrEqual(200);
    expect(out.stats.ms).toBeLessThan(200 + TOLERANCE_MS);
    if (!out.ok)
      expect(out.error).toMatchObject({
        line: 1,
        message: 'The script ran longer than the 200 ms limit.',
      });
  });

  it('stops a loop that catches every error it can', async () => {
    const { out } = await failsWith(
      'export function run() { for (;;) { try { for (;;) {} } catch (e) {} } }',
      'timeout',
      { limits: { timeMs: 100 } },
    );
    expect(out.stats.ms).toBeLessThan(100 + TOLERANCE_MS);
  });

  it.each([
    [
      'sort()',
      'const a = Array.from({ length: 20000 }, (_, i) => (i * 7919) % 20000); for (;;) a.slice().sort();',
    ],
    [
      'JSON round trips',
      "const d = Array.from({ length: 500 }, (_, i) => ({ i, s: 'x' + i, a: [i, i + 1] })); for (;;) JSON.parse(JSON.stringify(d));",
    ],
    ['string search', "const s = 'ab'.repeat(500000); for (;;) s.indexOf('c');"],
    [
      'getOwnPropertyDescriptors on a 100,000-key object',
      "const o = {}; for (let i = 0; i < 1e5; i++) o['k' + i] = i; for (;;) Object.getOwnPropertyDescriptors(o);",
    ],
    [
      'freeze of a 100,000-key object',
      "const o = {}; for (let i = 0; i < 1e5; i++) o['k' + i] = i; for (;;) Object.freeze(o);",
    ],
    [
      'assign from a 100,000-key object',
      "const o = {}; for (let i = 0; i < 1e5; i++) o['k' + i] = i; for (;;) Object.assign({}, o);",
    ],
    [
      'defineProperties',
      "const d = {}; for (let i = 0; i < 1e5; i++) d['k' + i] = { value: i }; for (;;) Object.defineProperties({}, d);",
    ],
    ['keys() spread', 'const a = new Array(1e6).fill(0); for (;;) { const b = [...a.keys()]; }'],
    [
      'entries() spread',
      'const a = new Array(3e5).fill(0); for (;;) { const b = [...a.entries()]; }',
    ],
    [
      'Map spread',
      'const m = new Map(Array.from({ length: 2e5 }, (_, i) => [i, i])); for (;;) { const b = [...m]; }',
    ],
    ['String.raw', 'for (;;) String.raw({ raw: { length: 1e6 } });'],
    ['ArrayBuffer slice', 'const b = new ArrayBuffer(16e6); for (;;) b.slice(0);'],
    [
      'a Proxy with a huge ownKeys result as an argument',
      'const ks = Array.from({ length: 1e6 }, (_, i) => String(i)); const p = new Proxy({}, { ownKeys: () => ks }); for (;;) { try { [1, 2].indexOf(p); } catch (e) {} }',
    ],
    [
      'Function.prototype.apply',
      'const a = new Array(6e4).fill(65); for (;;) String.fromCharCode.apply(null, a);',
    ],
    [
      'Reflect.apply',
      'const a = new Array(6e4).fill(65); for (;;) Reflect.apply(String.fromCharCode, null, a);',
    ],
    [
      'Reflect.construct',
      'const a = new Array(6e4).fill(1); for (;;) Reflect.construct(Array, a);',
    ],
    ['Reflect.ownKeys', 'const a = new Array(1e6).fill(0); for (;;) Reflect.ownKeys(a);'],
    [
      'Object.getOwnPropertyDescriptors',
      'const a = new Array(3e5).fill(0); for (;;) Object.getOwnPropertyDescriptors(a);',
    ],
    ['Object.freeze', 'for (;;) Object.freeze(new Array(1e5).fill(0));'],
    ['encodeURIComponent', "const s = 'a b'.repeat(300000); for (;;) encodeURIComponent(s);"],
    ['decodeURIComponent', "const s = '%20'.repeat(300000); for (;;) decodeURIComponent(s);"],
    ['escape', "const s = 'a b'.repeat(300000); for (;;) escape(s);"],
    [
      'localeCompare',
      "const s = 'a'.repeat(1e6), t = 'a'.repeat(1e6); for (;;) s.localeCompare(t);",
    ],
    ['toWellFormed', "const s = 'ab'.repeat(5e5); for (;;) s.toWellFormed();"],
    [
      'typed array from an array',
      'const a = new Array(1e6).fill(1.5); for (;;) new Float64Array(a);',
    ],
    ['Float64Array.from', 'const a = new Array(1e6).fill(1.5); for (;;) Float64Array.from(a);'],
    [
      'array spread',
      'const a = Array.from({ length: 1000000 }, (_, i) => i); for (;;) { const b = [...a]; }',
    ],
    ['string spread', "const s = 'ab'.repeat(5e5); for (;;) { const b = [...s]; }"],
    ['Set from a string', "const s = 'ab'.repeat(5e5); for (;;) new Set(s);"],
    ['new RegExp', "const p = 'a'.repeat(1e6); for (;;) new RegExp(p);"],
    ['RegExp called', "const p = 'a'.repeat(1e6); for (;;) RegExp(p, 'g');"],
    ['RegExp from a RegExp', "const r = new RegExp('a'.repeat(1e6)); for (;;) new RegExp(r);"],
    ['RegExp compile', "const p = 'a'.repeat(1e6); const r = /x/; for (;;) r.compile(p);"],
    ['Number', "const s = ' '.repeat(1e6) + '1'; for (;;) Number(s);"],
    ['new Number', "const s = ' '.repeat(1e6) + '1'; for (;;) new Number(s);"],
    ['parseFloat', "const s = ' '.repeat(1e6) + '1'; for (;;) parseFloat(s);"],
    ['Number.parseInt', "const s = ' '.repeat(1e6) + '1'; for (;;) Number.parseInt(s);"],
    [
      'shift and unshift',
      'const a = new Array(1e6).fill(0); for (;;) { a.unshift(1); a.shift(); }',
    ],
    ['startsWith', "const s = 'a'.repeat(1e6); for (;;) s.startsWith(s);"],
    ['endsWith', "const s = 'a'.repeat(1e6); for (;;) s.endsWith(s);"],
    ['match with a string pattern', "const s = 'a'.repeat(1e6); for (;;) 'b'.match(s);"],
    ['search with a string pattern', "const s = 'a'.repeat(1e6); for (;;) 'b'.search(s);"],
    [
      'flat over shared holey arrays',
      'const a = new Array(100).fill(new Array(100000)); for (;;) a.flat();',
    ],
    [
      'flat with a deep depth',
      'const a = new Array(10).fill([new Array(10).fill(new Array(100000))]); for (;;) a.flat(3);',
    ],
    [
      'flat with a species that makes a plain object',
      'const a = new Array(200).fill(new Array(5000).fill(1)); a.constructor = { [Symbol.species]: function () { return {}; } }; for (;;) a.flat();',
    ],
    [
      // A descriptor inherits Object.prototype.value: an accessor element must not pass as data
      // (before, this ran about 1 s past a 300 ms limit).
      'flat over accessor elements with Object.prototype.value set',
      'const h = new Array(100000); const a = []; for (let i = 0; i < 100; i++) Object.defineProperty(a, i, { get() { return h; }, enumerable: true, configurable: true }); Object.prototype.value = 0; for (;;) a.flat();',
    ],
    [
      'slice with a species that makes a plain object',
      'const a = new Array(1e5).fill(1); a.constructor = { [Symbol.species]: function () { return {}; } }; for (;;) a.slice();',
    ],
    [
      'flatMap returning a large holey array',
      'const h = new Array(100000); const a = new Array(100).fill(0); for (;;) a.flatMap(() => h);',
    ],
    [
      'concat of many shared arrays',
      'const h = new Array(100000); const hs = new Array(100).fill(h); for (;;) [].concat(...hs);',
    ],
    // Hole walkers: the callback methods skip holes natively, so on a sparse array no callback
    // ran and nothing was counted (a loop of some() over new Array(1e5) ran 6.4 s past a 300 ms
    // limit, forEach 6.3 s, map 3.3 s). The rest of these walk every slot too.
    ['some over holes', 'const h = new Array(1e5); for (;;) h.some(() => true);'],
    ['every over holes', 'const h = new Array(1e5); for (;;) h.every(() => false);'],
    ['forEach over holes', 'const h = new Array(1e5); for (;;) h.forEach(() => 0);'],
    ['map over holes', 'const h = new Array(1e5); for (;;) h.map((x) => x);'],
    ['filter over holes', 'const h = new Array(1e5); for (;;) h.filter(() => true);'],
    ['reduce over holes', 'const h = new Array(1e5); for (;;) h.reduce((a) => a, 0);'],
    ['reduceRight over holes', 'const h = new Array(1e5); for (;;) h.reduceRight((a) => a, 0);'],
    ['find over holes', 'const h = new Array(1e5); for (;;) h.find(() => false);'],
    ['findLast over holes', 'const h = new Array(1e5); for (;;) h.findLast(() => false);'],
    ['fill over holes', 'const h = new Array(1e5); for (;;) h.fill(0, 0, 0);'],
    ['join over holes', 'const h = new Array(1e5); for (;;) h.join();'],
    ['toString over holes', 'const h = new Array(1e5); for (;;) h.toString();'],
    ['copyWithin over holes', 'const h = new Array(1e5); for (;;) h.copyWithin(0, 1);'],
    ['toReversed over holes', 'const h = new Array(1e5); for (;;) h.toReversed();'],
    ['toSorted over holes', 'const h = new Array(1e5); for (;;) h.toSorted();'],
    ['toSpliced over holes', 'const h = new Array(1e5); for (;;) h.toSpliced(0, 0);'],
    ['with over holes', 'const h = new Array(1e5); for (;;) h.with(0, 1);'],
    ['includes over holes', 'const h = new Array(1e5); for (;;) h.includes(1);'],
    ['indexOf over holes', 'const h = new Array(1e5); for (;;) h.indexOf(1);'],
    ['lastIndexOf over holes', 'const h = new Array(1e5); for (;;) h.lastIndexOf(1);'],
    ['values spread over holes', 'const h = new Array(1e5); for (;;) [...h.values()];'],
    ['entries spread over holes', 'const h = new Array(1e5); for (;;) [...h.entries()];'],
  ])('stops a loop of builtins (%s) within one builtin call of the limit', async (_name, body) => {
    const { out } = await failsWith(`export function run() { ${body} }`, 'timeout', {
      limits: { timeMs: 300 },
    });
    expect(out.stats.ms).toBeLessThan(300 + TOLERANCE_MS);
  });

  it.each([
    ['flat', 'a.flat()'],
    ['flat with a depth', 'a.flat(2)'],
    ['indexOf', '[1, 2].indexOf(o)'],
    ['Object.keys', 'Object.keys(o)'],
    ['concat', 'a.concat(o, o)'],
  ])(
    'never runs a getPrototypeOf trap of a proxy in a prototype chain from a guard (%s)',
    async (_name, call) => {
      // The size estimate walks prototype chains; a proxy there must not be asked for its own
      // prototype, or its trap could change a value the guard already sized.
      expect(
        await value(`export function run() {
          let traps = 0;
          const p = new Proxy({}, { getPrototypeOf() { traps++; return Object.prototype; } });
          const o = Object.create(p);
          const a = [o, [o]];
          ${call};
          return traps;
        }`),
      ).toBe(0);
    },
  );

  it('never runs an Object.prototype.value getter from a guard', async () => {
    // Descriptors inherit from Object.prototype; the guards must read only their own properties.
    expect(
      await value(`export function run() {
        const a = [];
        Object.defineProperty(a, 0, { get() { return [1]; }, enumerable: true, configurable: true });
        const t = {};
        Object.defineProperty(t, 'raw', { get() { return ['x', 'y']; } });
        let runs = 0;
        Object.defineProperty(Object.prototype, 'value', { get() { runs++; return undefined; }, configurable: true });
        const flat = a.flat();
        const raw = String.raw(t, 1);
        delete Object.prototype.value;
        return [runs, flat, raw];
      }`),
    ).toEqual([0, [1], 'x1y']);
  });

  it('keeps species, flat and flatMap working behind their guards', async () => {
    expect(
      await value(`export function run() {
        const a = [1, [2, [3, [4]]], , 5];
        const s = [1, 2, 3];
        s.constructor = { [Symbol.species]: function () { return { made: true }; } };
        const r = s.slice(1);
        class Sub extends Array {}
        const sub = Sub.from([1, [2]]).flat();
        const holed = [[1, , 3]];
        Array.prototype[1] = 'p';
        const inherited = holed.flat();
        delete Array.prototype[1];
        let self;
        const fm = [1, 2].flatMap(function (x, i, o) { self = this; return [x, [i]]; }, 'thisArg');
        let threw = false;
        try { [1].flatMap(3); } catch (e) { threw = e instanceof TypeError; }
        return [a.flat(), a.flat(Infinity), a.flat(0).length, r.made, r[0], r.length,
          sub instanceof Sub, sub.length, inherited, fm.length, fm[1][0], String(self), threw,
          [1].concat([2], 3, [[4]]).length];
      }`),
    ).toEqual([
      [1, 2, [3, [4]], 5],
      [1, 2, 3, 4, 5],
      3,
      true,
      2,
      2,
      true,
      2,
      [1, 'p', 3],
      4,
      0,
      'thisArg',
      true,
      4,
    ]);
  });

  it('reads the clock on every call over a generic array-like whose length lies', async () => {
    // One call over 1e7 missing elements is a single native loop; the run must stop within about
    // one such call of the deadline, whatever the length getter says the next time.
    const body =
      'let t = 0; const o = { get length() { t ^= 1; return t ? 1e7 : 0; } }; for (;;) Array.prototype.indexOf.call(o, 1);';
    const single = await (
      await instance()
    ).run(
      js(
        `export function run() { let t = 0; const o = { get length() { return 1e7; } }; Array.prototype.indexOf.call(o, 1); }`,
      ),
    );
    const { out } = await failsWith(`export function run() { ${body} }`, 'timeout', {
      limits: { timeMs: 300 },
    });
    expect(out.stats.ms).toBeLessThan(300 + 2 * single.stats.ms + TOLERANCE_MS);
  });

  it('checks the time in host calls, so a slow host function ends the run', async () => {
    const busy = (ms: number) => {
      const end = performance.now() + ms;
      while (performance.now() < end);
    };
    const { out } = await failsWith(
      'export function run(ctx) { for (;;) ctx.slow(); }',
      'timeout',
      { limits: { timeMs: 100 } },
      { host: { slow: kernelOp(() => busy(30)) } },
    );
    expect(out.stats.ms).toBeLessThan(100 + 30 + TOLERANCE_MS);
  });

  it('turns deep recursion into a stack-limit error, below any browser stack', async () => {
    const { out, inst } = await failsWith(
      'export function run() { function f(a, b, c) { return f(a + 1, b, c) + 1; } return f(0, 1, 2); }',
      'stack-limit',
    );
    if (!out.ok) {
      expect(out.error.stack).toMatch(/repeated \d+ more times/);
      expect(out.error.stack!.split('\n').length).toBeLessThanOrEqual(21);
    }
    expect(out.stats.recycled).toBe(false);
    expect((await inst.run(js(returning('1')))).ok).toBe(true);
  });

  it.each([
    [
      'many small objects',
      'const m = new Map(); for (let i = 0; ; i++) m.set(i, { i, s: String(i) });',
    ],
    ['arrays of doubles', 'const a = []; for (;;) a.push(new Array(1e5).fill(1.5));'],
    ['one huge typed array', 'return new Float64Array(2e8).length;'],
    ['string doubling', "let s = 'x'; for (;;) s = s + s;"],
  ])(
    'ends an allocation bomb (%s) at the heap limit, and the next run works',
    async (_name, body) => {
      const { inst, out } = await failsWith(`export function run() { ${body} }`, 'heap-limit');
      expect(out.stats.ms).toBeLessThan(DEFAULT_LIMITS.timeMs);
      expect(inst.memoryBytes).toBeLessThanOrEqual(16 * MIB + DEFAULT_LIMITS.heapBytes);
      const next = await inst.run(
        js(returning('[1 + 1, Array.from({ length: 1000 }, (_, i) => i).length]')),
      );
      expect(next.ok ? next.value : next.error).toEqual([2, 1000]);
    },
  );

  it('replaces the instance after a fatal error', async () => {
    const inst = await instance();
    expect(inst.generation).toBe(1);
    const bomb = await inst.run(
      js('export function run() { const m = new Map(); for (let i = 0; ; i++) m.set(i, { i }); }'),
    );
    expect(bomb.ok).toBe(false);
    expect(bomb.stats.recycled).toBe(true);
    const next = await inst.run(js(returning('42')));
    expect(next.ok ? next.value : null).toBe(42);
    expect(inst.generation).toBe(2);
    expect(inst.memoryBytes).toBe(16 * MIB);
  });

  it('replaces an instance whose memory grew past the recycle threshold', async () => {
    const inst = await instance({ limits: { recycleAboveBytes: 17 * MIB } });
    const out = await inst.run(
      js(
        returning(
          '(() => { const a = []; for (let i = 0; i < 10; i++) a.push(new Array(1e5).fill(i)); return a.length; })()',
        ),
      ),
    );
    expect(out.ok ? out.value : out.error).toBe(10);
    expect(out.stats.recycled).toBe(true);
  });

  it.each([
    ['a long string', "'x'.repeat(1024 * 1024 + 1)"],
    ['many elements', 'Array.from({ length: 100001 }, () => 0)'],
    [
      'many small arrays',
      'Array.from({ length: 1000 }, () => Array.from({ length: 101 }, () => 0))',
    ],
    ['deep nesting', '(() => { let v = 0; for (let i = 0; i < 100; i++) v = [v]; return v; })()'],
    ['a long key', "({ ['k'.repeat(1024 * 1024 + 1)]: 1 })"],
  ])('refuses a huge return value (%s)', async (_name, expression) => {
    await failsWith(returning(expression), 'value-too-large');
  });

  it('refuses huge arguments to a host call, even if the script catches the error', async () => {
    const { out } = await failsWith(
      `export function run(ctx) {
         try { ctx.take('x'.repeat(2 * 1024 * 1024)); } catch (e) {}
         return 'kept going';
       }`,
      'value-too-large',
      {},
      { host: { take: () => 1 } },
    );
    expect(out.stats.hostCalls).toBe(0);
  });

  it('refuses a huge value from the host', async () => {
    await failsWith(
      returning('ctx.big()'),
      'host-error',
      {},
      { host: { big: () => 'x'.repeat(2 * MIB) } },
    );
  });

  it('caps host calls per run', async () => {
    const { out } = await failsWith(
      'export function run(ctx) { for (;;) { try { ctx.noop(); } catch (e) {} } }',
      'call-limit',
      { limits: { hostCalls: 1000 } },
      { host: { noop: () => undefined } },
    );
    expect(out.stats.hostCalls).toBe(1001);
  });

  it('caps the default 100,000 host calls in well under the time limit', async () => {
    const { out } = await failsWith(
      'export function run(ctx) { for (;;) ctx.noop(); }',
      'call-limit',
      {},
      { host: { noop: () => undefined } },
    );
    expect(out.stats.ms).toBeLessThan(DEFAULT_LIMITS.timeMs);
  });

  it('keeps guarded builtins cheap on ordinary data (plain objects, RegExps, valueOf)', async () => {
    // Before results were charged by size only, each of these calls read the clock: the queue
    // loop alone took 1.6 s and the whole body about 3.8 s, past the 2 s limit. Now about 0.6 s.
    // Wall time depends on machine load, so the check counts clock reads instead (see countingClock).
    const clock = countingClock();
    const out = await (
      await instance({ now: clock.now })
    ).run(
      js(
        `export function run() {
        const q = [];
        for (let i = 0; i < 100000; i++) { q.push({ i }); q.shift(); }
        const o = { valueOf() { return 1; } };
        let n = 0;
        for (let i = 0; i < 100000; i++) n += Number(o);
        for (let i = 0; i < 20000; i++) {
          n += 'a,b,c'.split(/,/).length + 'a,b,c'.match(/,/).index + 'a,b,c'.search(/,/);
          n += 'a,b,c'.replace(/,/g, '').length + [...'a,b,c'.matchAll(/,/g)].length;
        }
        return n;
      }`,
        { limits: { timeMs: 10_000 } },
      ),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value).toBe(100000 + 20000 * 10);
    // 400,000 guarded calls: reading the clock on each would be 400,000 reads.
    expect(clock.reads()).toBeLessThan(40_000);
  });

  it('keeps the callback methods cheap and correct on ordinary arrays', async () => {
    // forEach, map, filter, some, every and reduce are guarded (for holes); on small dense arrays
    // the guard must stay cheap: this body took about 0.3 s unguarded and 0.55 s guarded. Wall
    // time depends on machine load, so the check counts clock reads instead (see countingClock).
    const clock = countingClock();
    const out = await (
      await instance({ now: clock.now })
    ).run(
      js(
        `export function run() {
        const a = [1, 2, 3, 4, 5, 6, 7, 8];
        let n = 0;
        for (let i = 0; i < 100000; i++) {
          n += a.map((x) => x + 1).filter((x) => x > 3).length;
          a.forEach((x) => { n += x; });
          n += a.reduce((s, x) => s + x, 0);
          if (a.some((x) => x > 7) && a.every((x) => x > 0)) n++;
        }
        const t = { k: 2 };
        const holey = [1, , 3];
        class Sub extends Array {}
        return [
          n,
          [1, 2, 3].reduce((s, x) => s + x),
          [1, 2, 3].reduceRight((s, x) => s + x, ''),
          holey.map(function (x) { return x * this.k; }, t),
          holey.filter(() => true),
          Sub.from([1, 2]).map((x) => x) instanceof Sub,
          Array.prototype.map.length,
          Array.prototype.reduce.name,
          Array.prototype.some.call({ length: 2, 0: 0, 1: 1 }, (x) => x === 1),
        ];
      }`,
        { limits: { timeMs: 10_000 } },
      ),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value).toEqual([7900000, 6, '321', [2, null, 6], [1, 3], true, 1, 'reduce', true]);
    }
    // 600,000 guarded calls: reading the clock on each would be 600,000 reads.
    expect(clock.reads()).toBeLessThan(60_000);
  });

  it('caps kernel operations per run', async () => {
    const { out } = await failsWith(
      'export function run(ctx) { for (let i = 0; i < 2000; i++) { ctx.query(); ctx.op(); } }',
      'op-limit',
      {},
      { host: { op: kernelOp(() => undefined), query: () => undefined } },
    );
    expect(out.stats.kernelOps).toBe(1001);
  });
});

describe('isolation', () => {
  it('has exactly the ECMAScript globals the sandbox installs', async () => {
    const names = (await value(
      returning('Object.getOwnPropertyNames(globalThis).sort()'),
    )) as string[];
    expect(names).toEqual(
      [
        'AggregateError',
        'Array',
        'ArrayBuffer',
        'BigInt',
        'BigInt64Array',
        'BigUint64Array',
        'Boolean',
        'DataView',
        'Error',
        'EvalError',
        'Float16Array',
        'Float32Array',
        'Float64Array',
        'Function',
        'Infinity',
        'Int16Array',
        'Int32Array',
        'Int8Array',
        'InternalError',
        'Iterator',
        'JSON',
        'Map',
        'Math',
        'NaN',
        'Number',
        'Object',
        'Promise',
        'Proxy',
        'RangeError',
        'ReferenceError',
        'Reflect',
        'RegExp',
        'Set',
        'String',
        'Symbol',
        'SyntaxError',
        'TypeError',
        'URIError',
        'Uint16Array',
        'Uint32Array',
        'Uint8Array',
        'Uint8ClampedArray',
        'WeakMap',
        'WeakSet',
        'decodeURI',
        'decodeURIComponent',
        'encodeURI',
        'encodeURIComponent',
        'escape',
        'eval',
        'globalThis',
        'isFinite',
        'isNaN',
        'parseFloat',
        'parseInt',
        'undefined',
        'unescape',
      ].sort(),
    );
  });

  it('reaches no host global', async () => {
    const out = await value(
      returning(
        `['fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'postMessage', 'indexedDB', 'navigator',
          'process', 'require', 'setTimeout', 'Date', 'SharedArrayBuffer', 'Atomics', 'WeakRef',
          'FinalizationRegistry', 'console', 'performance', 'crypto', 'print', 'std', 'os']
          .filter((n) => typeof globalThis[n] !== 'undefined')`,
      ),
    );
    expect(out).toEqual([]);
  });

  it.each([
    ["Function('return this')()"],
    ["(function () {}).constructor('return this')()"],
    ["globalThis.constructor.constructor('return this')()"],
    ["Object.getPrototypeOf(function* () {}).constructor('yield 1')"],
    ["Object.getPrototypeOf(async function () {}).constructor('return 1')"],
    ["eval('1 + 1')"],
    ["(0, eval)('1 + 1')"],
    ["new Function('return 1')"],
  ])('has no code generation: %s throws', async (expression) => {
    const out = await (await instance()).run(js(returning(expression)));
    expect(out.ok ? out.value : out.error.message).toMatch(/not available in scripts/);
  });

  it('keeps typed arrays working behind the guarded constructors, subclasses included', async () => {
    const out = await value(
      returning(`(() => {
        class V extends Float64Array { sum() { return this.reduce((a, b) => a + b, 0); } }
        const v = new V([1, 2, 3]);
        let called = 'no error';
        try { Float64Array(2); } catch (e) { called = e instanceof TypeError; }
        return [v instanceof V, v instanceof Float64Array, v.sum(), V.from([1, 2]) instanceof V,
          v.map((x) => x * 2) instanceof V, v.subarray(1) instanceof V, Float64Array.name,
          Float64Array.BYTES_PER_ELEMENT, new Float64Array(2).constructor === Float64Array,
          Object.getPrototypeOf(Float64Array) === Object.getPrototypeOf(Int8Array), called,
          Set.prototype.keys === Set.prototype.values, Set.prototype[Symbol.iterator] === Set.prototype.values,
          typeof Proxy, typeof Proxy.prototype, new Proxy([1, 2], {}).length, Proxy.revocable({}, {}).proxy !== undefined,
          [...new Set([1, 2]).keys()].length, [...new Map([[1, 2]])][0][1], [...[5, 6].entries()][1][1]];
      })()`),
    );
    expect(out).toEqual([
      true,
      true,
      6,
      true,
      true,
      true,
      'Float64Array',
      8,
      true,
      true,
      true,
      true,
      true,
      'function',
      'undefined',
      2,
      true,
      2,
      2,
      6,
    ]);
  });

  it('keeps Proxy without a prototype property, as in ECMAScript', async () => {
    expect(
      await value(
        returning(`[
          'prototype' in Proxy, Object.getOwnPropertyNames(Proxy).sort().join(), Proxy.name,
          Proxy.length, typeof Proxy.revocable, (() => { try { Proxy({}, {}); return 'called'; } catch (e) { return e instanceof TypeError; } })(),
          (() => { try { class P extends Proxy {} return 'extended'; } catch (e) { return e instanceof TypeError; } })(),
          new Proxy({ a: 1 }, { get: (t, k) => k + '!' }).a,
        ]`),
      ),
    ).toEqual([false, 'length,name,revocable', 'Proxy', 2, 'function', true, true, 'a!']);
  });

  it('keeps Number, RegExp and the string iterator working behind their guards', async () => {
    expect(
      await value(
        returning(`(() => {
          class R extends RegExp { tag() { return 'r'; } }
          const r = /b+/g;
          const re = new RegExp('a(b)', 'i');
          return [
            Number('  42 '), new Number('7') + 1, Number(), Number.MAX_SAFE_INTEGER, Number.isInteger(3),
            Number.parseFloat === parseFloat, Number.parseInt === parseInt, parseInt('ff', 16),
            parseFloat('2.5e1x'), (5).constructor === Number, new Number(1) instanceof Number,
            Number.prototype.constructor === Number, Number.name, Number.length,
            re.exec('xAB')[1], re instanceof RegExp, /x/.constructor === RegExp, RegExp(r) === r,
            RegExp(r, 'i') === r, new RegExp(r) === r, new RegExp(r).source, RegExp.name, RegExp.length,
            RegExp[Symbol.species] === RegExp, new R('q').tag(), new R('q') instanceof RegExp,
            'a,b'.split(/,/).length, 'abba'.replace(/b+/g, 'c'), [...'abbb'.matchAll(/b/g)].length,
            'xbbx'.match(r)[0], 'xbbx'.search(/b/), /c/.compile('d').source,
            [...'ab\u{1F600}'].length, Array.from(new Set('abca')).join(''),
            String.prototype[Symbol.iterator].name, 'ab'.startsWith('a'), 'ab'.endsWith('b'),
            [1, 2].concat().shift(), [2].unshift(0, 1),
          ];
        })()`),
      ),
    ).toEqual([
      42,
      8,
      0,
      9007199254740991,
      true,
      true,
      true,
      255,
      25,
      true,
      true,
      true,
      'Number',
      1,
      'B',
      true,
      true,
      true,
      false,
      false,
      'b+',
      'RegExp',
      2,
      true,
      'r',
      true,
      2,
      'aca',
      3,
      'bb',
      1,
      'd',
      3,
      'abc',
      '[Symbol.iterator]',
      true,
      true,
      1,
      3,
    ]);
  });

  it('keeps instanceof Function and ordinary functions working', async () => {
    expect(
      await value(
        returning('[(() => 1) instanceof Function, typeof Function, [3, 1, 2].sort().join()]'),
      ),
    ).toEqual([true, 'function', '3,1,2'.split(',').sort().join()]);
  });

  it('keeps prototype tampering inside the run', async () => {
    const inst = await instance();
    const out = await inst.run(
      js(
        returning(
          "(() => { Object.prototype.polluted = 'yes'; Array.prototype.extra = 1; Math.sin = () => 0; return { a: [1] }; })()",
        ),
      ),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      const result = out.value as { a: number[] };
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      expect('polluted' in result).toBe(false);
      expect('extra' in result.a).toBe(false);
    }
    expect('polluted' in {}).toBe(false);
    const next = await inst.run(
      js(returning('[typeof ({}).polluted, typeof [].extra, Math.sin(Math.PI / 2)]')),
    );
    expect(next.ok ? next.value : null).toEqual(['undefined', 'undefined', 1]);
  });

  it('refuses __proto__ keys in returned objects', async () => {
    for (const expression of [
      'JSON.parse(\'{"__proto__": {"polluted": true}}\')',
      "({ ['__proto__']: { polluted: true } })",
      "Object.defineProperty({}, '__proto__', { value: 1, enumerable: true })",
    ]) {
      const out = await (await instance()).run(js(returning(expression)));
      expect(out.ok, expression).toBe(false);
      if (!out.ok) expect(out.error.message).toMatch(/__proto__/);
    }
    expect('polluted' in {}).toBe(false);
  });

  it('accepts an object literal __proto__ (it sets the prototype, not a key)', async () => {
    expect(await value(returning('({ __proto__: null, a: 1 })'))).toEqual({ a: 1 });
  });

  it('refuses plain objects that carry the marker key', async () => {
    const out = await (await instance()).run(js(returning("({ '\\u0000mfk': 0 })")));
    expect(out.ok ? null : out.error.code).toBe('runtime');
    const fake = await (
      await instance()
    ).run(
      js(returning('ctx.use(Object.freeze({ kind: "body" }))'), {
        host: { use: (h) => (h instanceof ScriptHandle ? 'handle' : 'data') },
      }),
    );
    expect(fake.ok ? fake.value : null).toBe('data');
  });

  it('resolves a marker forged with a Proxy only to a handle issued in the same run', async () => {
    // The Proxy hides the marker key from the glue's own-property check and shows it to
    // JSON.stringify, so the forged marker reaches the host. The host resolves it only against
    // this run's handle table: index 0 is the handle the script already holds, other indices
    // (out of range, negative, fractional) are refused with an error the script sees.
    const issued: ScriptHandle[] = [];
    const host: HostApi = {
      make: () => {
        const h = new ScriptHandle('body', issued.length);
        issued.push(h);
        return h;
      },
      use: (h) => (h instanceof ScriptHandle ? issued.indexOf(h) : 'data'),
    };
    const source = `
      const forge = (index) => {
        let calls = 0;
        const key = '\\u0000mfk';
        return new Proxy({}, {
          ownKeys: () => [key],
          getOwnPropertyDescriptor: (t, k) =>
            k === key && calls++ > 0 ? { value: index, enumerable: true, configurable: true } : undefined,
          get: (t, k) => (k === key ? index : undefined),
        });
      };
      const attempt = (index) => { try { return ctx.use(forge(index)); } catch (e) { return e.message; } };
      export function run(ctx_) { ctx = ctx_; const real = ctx.make(); return [ctx.use(real), attempt(0), attempt(1), attempt(-1), attempt(0.5)]; }
      let ctx;`;
    const out = await (await instance()).run(js(source, { host }));
    expect(out.ok ? out.value : out.error).toEqual([
      0,
      0,
      'use: Unknown handle in a script value.',
      'use: Unknown handle in a script value.',
      'use: Unknown handle in a script value.',
    ]);
    expect(issued).toHaveLength(1);
  });

  it('gives each run a fresh context', async () => {
    const inst = await instance();
    const source =
      'let count = 0; export function run() { globalThis.leak = (globalThis.leak ?? 0) + 1; return [++count, globalThis.leak]; }';
    expect((await inst.run(js(source))).ok).toBe(true);
    const second = await inst.run(js(source));
    expect(second.ok ? second.value : null).toEqual([1, 1]);
  });

  it('gives each document its own module instance and memory', async () => {
    const a = await instance();
    const b = await instance();
    expect(a.memory).not.toBe(b.memory);
    const grow = await a.run(
      js(
        returning(
          '(() => { const x = []; for (let i = 0; i < 10; i++) x.push(new Array(1e5).fill(i)); return x.length; })()',
        ),
      ),
    );
    expect(grow.ok).toBe(true);
    expect(a.memoryBytes).toBeGreaterThan(16 * MIB);
    expect(b.memoryBytes).toBe(16 * MIB);
  });
});

describe('determinism', () => {
  const source = `
    export function run(ctx, p) {
      const r = [Math.random(), Math.random(), Math.random()];
      const spiral = Array.from({ length: 50 }, (_, i) => [Math.cos(i * 0.37) * i, Math.sin(i * 0.37) * i, Math.exp(i / 10)]);
      const sorted = Array.from({ length: 200 }, () => Math.random()).sort();
      return { r, spiral, sorted: sorted.slice(0, 5), text: (Math.PI * 1e6).toFixed(3) + Math.pow(10, -7).toString(), id: ctx.featureId() };
    }`;
  const run = async (inst: ScriptInstance, seed: number, id = 'scripted#1', src = source) => {
    const out = await inst.run(js(src, { seed, host: { featureId: () => id } }));
    if (!out.ok) throw new Error(out.error.message);
    // The script reads the feature id (as a real API would offer it); only the rest is compared.
    const rest = { ...(out.value as Record<string, unknown>) };
    expect(rest.id).toBe(id);
    delete rest.id;
    return bits(rest);
  };

  it('gives identical output across runs and fresh instances', async () => {
    const a = await instance();
    const first = await run(a, 0);
    expect(await run(a, 0)).toEqual(first);
    expect(await run(await instance(), 0)).toEqual(first);
  });

  it('depends on the source and seed, never on the feature id', async () => {
    const inst = await instance();
    const base = await run(inst, 7, 'scripted#1');
    expect(await run(inst, 7, 'scripted#99')).toEqual(base);
    expect(await run(inst, 8, 'scripted#1')).not.toEqual(base);
    expect(await run(inst, 7, 'scripted#1', `${source}\n// edited`)).not.toEqual(base);
  });

  it('refuses a seed that is not a safe integer', async () => {
    const out = await (await instance()).run(js(returning('1'), { seed: 1.5 }));
    expect(out.ok ? null : out.error.code).toBe('bad-param');
  });
});

describe('engine details', () => {
  it('names the installed QuickJS build in QUICKJS_BUILD', () => {
    const require = createRequire(import.meta.url);
    const packageDir = (name: string) => join(dirname(require.resolve(name)), '..');
    const version = (dir: string) =>
      (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }).version;
    const core = { version: version(packageDir('quickjs-emscripten-core')) };
    const variantDir = packageDir('@jitl/quickjs-wasmfile-release-sync');
    const variant = { version: version(variantDir) };
    const readme = readFileSync(join(variantDir, 'README.md'), 'utf8');
    const commit = /Version \[([0-9-]+\+[0-9a-f]+)\]/.exec(readme)?.[1];
    expect(QUICKJS_BUILD).toBe(`quickjs-${commit}/quickjs-emscripten-${core.version}/release-sync`);
    expect(variant.version).toBe(core.version);
  });

  it('drops the instance when a run leaves promise jobs behind', async () => {
    const inst = await instance();
    const out = await inst.run(js(returning('(Promise.resolve().then(() => 1), 7)')));
    expect(out.ok ? out.value : out.error).toBe(7);
    expect(out.stats.recycled).toBe(true);
    expect((await inst.run(js(returning('8')))).ok).toBe(true);
  });

  it('refuses a source over the length cap before erasing it', async () => {
    const out = await (
      await instance()
    ).run(js(`// ${'x'.repeat(MAX_SOURCE_LENGTH)}\nexport function run() {}`));
    expect(out.ok ? null : out.error.code).toBe('value-too-large');
  });
});

describe('hostile thrown values', () => {
  it('ends the run when reading the thrown value loops or throws', async () => {
    for (const thrown of [
      '{ get message() { for (;;) {} } }',
      '{ get name() { throw 1; }, toJSON() { throw 2; } }',
      'new Proxy({}, { get() { throw 3; } })',
    ]) {
      const inst = await instance({ limits: { timeMs: 200 } });
      const out = await inst.run(js(`export function run() { throw ${thrown}; }`));
      expect(out.ok, thrown).toBe(false);
      expect(out.stats.ms, thrown).toBeLessThan(1000);
      const next = await inst.run(js(returning('1')));
      expect(next.ok, thrown).toBe(true);
    }
  });
});
