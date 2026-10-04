// Hostile inputs at the script boundary (T7.2e): a seeded fuzz of the binding with hostile values
// (proxies, getters, cycles, huge strings, NaN payloads, prototype pollution), a mutation fuzz of
// the host codec, and the soft-limit gaps the hardening pass closed. The findings are listed in
// README.md ("Hardening findings"); this file is the evidence for them.

import { describe, expect, it } from 'vitest';
import { CodecError, HandleTable, decodePayload, encodeValue, type ValueLimits } from './codec';
import type { ScriptInstance, ScriptInstanceOptions, ScriptRunRequest } from './engine';
import { kernelOp, ScriptHandle, type HostApi, type ScriptValue } from './host';
import { DEFAULT_LIMITS } from './limits';
import { nodeScriptEngine } from './node';
import { parseParamDeclarations, resolveParams, type ParamSpec } from './params';
import { MARK } from './prelude';

async function instance(options: ScriptInstanceOptions = {}): Promise<ScriptInstance> {
  return (await nodeScriptEngine()).createInstance(options);
}

function js(source: string, extra: Partial<ScriptRunRequest> = {}): ScriptRunRequest {
  return { source, language: 'js', apiVersion: 1, ...extra };
}

/** mulberry32: the fuzz is reproducible from its seed. */
function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)]!;

/** The bits of every double in a value, so determinism checks compare exactly. */
function bits(v: unknown): unknown {
  if (typeof v === 'number') {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, v);
    return view.getBigUint64(0).toString(16);
  }
  if (v instanceof ScriptHandle) return { handle: v.kind };
  if (Array.isArray(v)) return v.map(bits);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bits(x)]));
  }
  return v;
}

/**
 * Throws unless `v` is a value a host function may receive: plain data built by the host itself
 * (host prototypes, data properties only, no `__proto__` or marker keys, no symbol keys, no
 * holes), strings and sizes within the limits, and handles only from `issued`.
 */
function checkScriptValue(
  v: unknown,
  issued: ReadonlySet<ScriptHandle>,
  limits: ValueLimits,
  maxDepth: number,
  depth = 0,
): void {
  if (depth > maxDepth) throw new Error(`nested deeper than ${maxDepth}`);
  if (v === null || typeof v === 'boolean' || typeof v === 'number') return;
  if (v === undefined) {
    if (depth > 0) throw new Error('undefined inside a value');
    return;
  }
  if (typeof v === 'string') {
    if (v.length > limits.maxStringLength) throw new Error('string over the limit');
    return;
  }
  if (v instanceof ScriptHandle) {
    if (!issued.has(v)) throw new Error('a handle the run was never given');
    return;
  }
  if (typeof v !== 'object') throw new Error(`a ${typeof v} reached the host`);
  if (Object.getOwnPropertySymbols(v).length > 0) throw new Error('symbol keys');
  const descriptors = Object.getOwnPropertyDescriptors(v);
  if (Array.isArray(v)) {
    if (Object.getPrototypeOf(v) !== Array.prototype) throw new Error('foreign array prototype');
    if (v.length > limits.maxElements) throw new Error('array over the limit');
    for (let i = 0; i < v.length; i++) {
      if (!(i in v)) throw new Error('a hole');
      checkScriptValue(v[i], issued, limits, maxDepth, depth + 1);
    }
    return;
  }
  if (Object.getPrototypeOf(v) !== Object.prototype) throw new Error('foreign object prototype');
  for (const [key, d] of Object.entries(descriptors)) {
    if (key === '__proto__' || key === MARK) throw new Error(`key ${JSON.stringify(key)}`);
    if (key.length > limits.maxStringLength) throw new Error('key over the limit');
    if (!('value' in d) || !d.enumerable) throw new Error(`accessor or hidden key ${key}`);
    checkScriptValue(d.value, issued, limits, maxDepth, depth + 1);
  }
}

/** Own names of the host's intrinsic prototypes, to show nothing a script does reaches them. */
function hostPrototypes(): string {
  return [Object.prototype, Array.prototype, Function.prototype, String.prototype]
    .map((p) => Reflect.ownKeys(p).map(String).sort().join(','))
    .join('|');
}

// ---- the binding fuzz

/** Values a script can try to pass: each an expression in a scope with `ctx`. */
const LEAVES: readonly string[] = [
  '0',
  '-0',
  'NaN',
  'Infinity',
  '-Infinity',
  '1e308',
  '5e-324',
  '-1.5',
  // A NaN with a payload, and a signalling one: the host must see a canonical NaN.
  '(() => { const f = new Float64Array(1); new Uint32Array(f.buffer).set([7, 0x7ff00001]); return f[0]; })()',
  '(() => { const f = new Float64Array(1); new Uint32Array(f.buffer).set([0xdeadbeef, 0xfff8dead]); return f[0]; })()',
  'undefined',
  'null',
  'true',
  '""',
  '"\\u0000mfk"',
  '"\\ud800"',
  '"a\\"b\\\\c"',
  "'x'.repeat(1 << 20)",
  "'x'.repeat((1 << 20) + 1)",
  "'\\u0000'.repeat(1000)",
  'Symbol("s")',
  '10n',
  '(() => 1)',
  'new Map([[1, 2]])',
  'new Set([1])',
  'new Uint8Array(4)',
  'new ArrayBuffer(4)',
  'new Number(1)',
  'new String("s")',
  '/re/g',
  'new Error("e")',
  'Math',
  'globalThis',
  'ctx',
  'ctx.echo',
  'Object.create(null)',
  'Object.freeze({ kind: "body" })',
  'ctx.make()',
  'ctx.make()',
  '(function () { return arguments; })(1, 2)',
  'new (class A {})()',
  'new (class X extends Array {})(3)',
  'Object.setPrototypeOf({ a: 1 }, Array.prototype)',
  'Object.setPrototypeOf([1, 2], null)',
  'new Array(5)',
  'new Array(100001)',
  'Array.from({ length: 100001 }, () => 0)',
  'JSON.parse("[".repeat(64) + "]".repeat(64))',
  'JSON.parse("[".repeat(65) + "]".repeat(65))',
  '(() => { const o = { a: 1 }; o.self = o; return o; })()',
  '(() => { const a = [1]; a.push(a); return a; })()',
  '(() => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; })()',
  'new Proxy({}, { ownKeys() { throw new Error("trap"); } })',
  "new Proxy({}, { ownKeys: () => ['a', 'a'], getOwnPropertyDescriptor: () => ({ value: 1, enumerable: true, configurable: true }) })",
  "new Proxy({}, { ownKeys: () => ['a'], getOwnPropertyDescriptor: () => ({ value: 1, enumerable: true, configurable: true }), get: (t, k) => (k === 'a' ? { deeper: [1] } : undefined) })",
  'new Proxy([1, 2, 3], {})',
  "new Proxy({}, { getPrototypeOf: () => Object.prototype, ownKeys: () => ['\\u0000mfk'], getOwnPropertyDescriptor: (t, k) => ({ value: 0, enumerable: true, configurable: true }), get: () => 0 })",
  "new Proxy({}, { getPrototypeOf: () => Object.prototype, ownKeys: () => ['\\u0000mfk'], getOwnPropertyDescriptor: (t, k) => ({ value: 99, enumerable: true, configurable: true }), get: () => 99 })",
  '({ get a() { throw new Error("getter"); } })',
  '({ get a() { throw null; } })',
  "({ get a() { return 'y'.repeat(1 << 21); } })",
  '(() => { const o = { a: 1, get b() { o.c = o; return 2; } }; return o; })()',
  '({ toJSON() { return new Map(); } })',
  "({ toJSON() { return { ['__proto__']: 1 }; } })",
  "({ toJSON() { return 'from toJSON'; } })",
  "({ ['__proto__']: { polluted: 1 } })",
  'JSON.parse(\'{"__proto__": {"polluted": 1}}\')',
  "Object.defineProperty({}, '__proto__', { value: 1, enumerable: true })",
  '({ constructor: { prototype: { polluted: 1 } } })',
  "({ '\\u0000mfk': 0 })",
  "({ '\\u0000mfk': 'NaN' })",
  "({ ['k'.repeat((1 << 20) + 1)]: 1 })",
  '(() => { const o = {}; for (let i = 0; i < 100001; i++) o["k" + i] = 0; return o; })()',
  '({ [Symbol.iterator]: 1, a: 2 })',
  "Object.defineProperty({}, 'hidden', { value: 1 })",
  '(() => { const a = [1]; a.extra = 2; return a; })()',
];

/** Operation ids and names a script could pass to a modelling call (regen validates them). */
const OPERATION_IDS: readonly string[] = [
  'boss',
  'x'.repeat(64),
  'x'.repeat(65),
  'scripted#1:boss/',
  'extrude#2:cap:end',
  '__proto__',
  'constructor',
  MARK,
  '\ud800',
  'a/b(c)&d+e|f',
  '',
  'x'.repeat(300),
];

/** Statements a script runs first to tamper with what the glue relies on. */
const POLLUTION: readonly string[] = [
  'Object.prototype.toJSON = function () { return { polluted: 1 }; };',
  "Array.prototype.toJSON = function () { return 'arr'; };",
  "Object.prototype['\\u0000mfk'] = 0;",
  "Object.prototype.kind = 'body';",
  'JSON.stringify = () => \'{"\\u0000mfk":0}\'; JSON.parse = () => ({});',
  'Object.getPrototypeOf = () => null; Reflect.apply = () => 1; Array.isArray = () => false;',
  "Object.defineProperty(Object.prototype, 'value', { get() { return 1; }, configurable: true });",
  'Object.prototype.polluted = 1; Array.prototype.polluted = 1;',
  "Number.prototype.toJSON = () => 'n'; String.prototype.toJSON = () => 's'; Boolean.prototype.toJSON = () => 'b';",
  "Object.defineProperty(Array.prototype, 0, { get() { return 'proto0'; }, configurable: true });",
  "Symbol.prototype.toJSON = () => 'sym';",
  'WeakMap.prototype.get = () => 0; Map.prototype.get = () => undefined; WeakSet.prototype.has = () => true;',
  'Object.freeze(Object.prototype); Object.freeze(Array.prototype);',
  "Error.prototype.message = 'x'; TypeError.prototype.name = 'Y';",
  'Function.prototype.call = () => 0; Function.prototype.apply = () => 0; Function.prototype.bind = () => 0;',
];

function expression(r: () => number, depth: number): string {
  if (depth >= 3 || r() < 0.55) return pick(r, LEAVES);
  const a = expression(r, depth + 1);
  const b = expression(r, depth + 1);
  switch (Math.floor(r() * 4)) {
    case 0:
      return `[${a}, ${b}]`;
    case 1:
      return `({ a: ${a}, b: ${b} })`;
    case 2:
      return `({ [String(${JSON.stringify(pick(r, ['k', '__proto__', MARK, 'constructor', '0']))})]: ${a} })`;
    default:
      return `[${a}]`;
  }
}

function fuzzCase(seed: number): string {
  const r = rng(seed);
  const pollution = Array.from({ length: Math.floor(r() * 3) }, () => pick(r, POLLUTION)).join(
    '\n',
  );
  const values = Array.from({ length: 4 }, () => expression(r, 0));
  const ids = Array.from({ length: 4 }, () => pick(r, OPERATION_IDS));
  const returnsHostile = r() < 0.4;
  return `export function run(ctx) {
    ${pollution}
    const out = [];
    const makers = [${values.map((v) => `() => (${v})`).join(', ')}];
    for (let i = 0; i < makers.length; i++) {
      try { out.push(['ok', ctx.echo(makers[i]())]); } catch (e) { out.push(['err', typeof e]); }
      try { ctx.op(${JSON.stringify(ids)}[i], i); } catch (e) { out.push(['err', typeof e]); }
    }
    return ${returnsHostile ? `makers[${Math.floor(r() * 4)}]()` : 'out'};
  }`;
}

/** Codes a hostile but well-behaved-host run may end with; never `host-error`. */
const SCRIPT_SIDE_CODES = new Set([
  'runtime',
  'value-too-large',
  'internal',
  'timeout',
  'stack-limit',
  'heap-limit',
]);

describe('binding fuzz with hostile values', () => {
  const CASES = 300;

  it(`keeps the host's invariants over ${CASES} seeded hostile scripts`, async () => {
    const limits = { ...DEFAULT_LIMITS };
    const before = hostPrototypes();
    const inst = await instance();
    const codes = new Map<string, number>();
    let received = 0;
    let opIds = 0;
    for (let seed = 1; seed <= CASES; seed++) {
      const source = fuzzCase(seed);
      const issued = new Set<ScriptHandle>();
      const run = async (target: ScriptInstance) => {
        issued.clear();
        const host: HostApi = {
          make: () => {
            const h = new ScriptHandle('body', issued.size);
            issued.add(h);
            return h;
          },
          // A modelling call: its id arrives exactly as the script wrote it, or the run fails.
          op: kernelOp((...args) => {
            expect(OPERATION_IDS, source).toContain(args[0]);
            expect(args[1], source).toBeTypeOf('number');
            opIds++;
          }),
          echo: (...args) => {
            expect(args.length, source).toBeLessThanOrEqual(1);
            const v = args[0];
            checkScriptValue(v, issued, limits, limits.maxDepth);
            if (typeof v === 'number' && Number.isNaN(v)) expect(bits(v)).toBe('7ff8000000000000');
            received++;
            return v;
          },
        };
        return target.run(js(source, { host }));
      };
      // run() resolves whatever the script does: it never rejects into the host.
      const out = await run(inst);
      if (out.ok) {
        checkScriptValue(out.value, issued, limits, limits.maxDepth);
      } else {
        expect(SCRIPT_SIDE_CODES.has(out.error.code), `${out.error.code}: ${source}`).toBe(true);
        expect(out.error.message.length).toBeLessThan(2000);
        codes.set(out.error.code, (codes.get(out.error.code) ?? 0) + 1);
      }
      // Determinism under hostile input: a fresh instance gives the same outcome, bit for bit.
      if (seed % 8 === 0) {
        const fresh = await instance();
        const again = await run(fresh);
        expect(again.ok).toBe(out.ok);
        if (out.ok && again.ok) expect(bits(again.value)).toEqual(bits(out.value));
        if (!out.ok && !again.ok) expect(again.error.code).toBe(out.error.code);
        fresh.dispose();
      }
      // The instance is still sound for the next run, whatever this one did.
      const canary = await inst.run(js('export function run() { return [1, NaN, -0, "ok"]; }'));
      expect(canary.ok ? bits(canary.value) : canary.error).toEqual(
        bits([1, Number.NaN, -0, 'ok']),
      );
    }
    expect(hostPrototypes()).toBe(before);
    expect('polluted' in {}).toBe(false);
    // The fuzz reached the host with real values and also ended runs in each way.
    expect(received).toBeGreaterThan(CASES);
    expect(opIds).toBeGreaterThan(CASES);
    expect(codes.get('runtime') ?? 0).toBeGreaterThan(0);
    expect(codes.get('value-too-large') ?? 0).toBeGreaterThan(0);
  }, 120_000);

  it('canonicalizes NaN payloads both ways, so no host bits reach a script', async () => {
    const payloadNaN = new Float64Array(new BigUint64Array([0x7ff4_0000_dead_beefn]).buffer)[0]!;
    expect(Number.isNaN(payloadNaN)).toBe(true);
    const seen: string[] = [];
    const out = await (
      await instance()
    ).run(
      js(
        `export function run(ctx) {
          const f = new Float64Array(1);
          const u = new Uint32Array(f.buffer);
          u.set([0xdeadbeef, 0x7ff4dead]);
          ctx.take(f[0], [f[0]], { n: f[0] });
          const back = ctx.give();
          f[0] = back;
          return { hi: u[1], lo: u[0], same: Object.is(back, NaN), returned: f[0] };
        }`,
        {
          host: {
            take: (...args) => {
              seen.push(JSON.stringify(bits(args)));
            },
            give: () => payloadNaN,
          },
        },
      ),
    );
    expect(seen).toEqual([
      JSON.stringify(['7ff8000000000000', ['7ff8000000000000'], { n: '7ff8000000000000' }]),
    ]);
    expect(out.ok ? bits(out.value) : out.error).toEqual({
      hi: bits(0x7ff80000),
      lo: bits(0),
      same: true,
      returned: '7ff8000000000000',
    });
  });

  it('ends a run on a host value that cannot cross, without recursing or walking holes', async () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const cases: [string, () => unknown][] = [
      ['a cycle', () => cyclic],
      ['a huge sparse array', () => new Array(1e9)],
      ['a class instance', () => new (class Shape {})()],
      ['a Map', () => new Map()],
      ['a symbol', () => Symbol('s')],
      ['a BigInt', () => 1n],
      ['a function', () => () => 1],
      ['a __proto__ key', () => JSON.parse('{"__proto__": 1}') as unknown],
      ['a marker key', () => ({ [MARK]: 0 })],
    ];
    const inst = await instance();
    for (const [name, make] of cases) {
      const t0 = performance.now();
      const out = await inst.run(
        js('export function run(ctx) { try { ctx.f(); } catch (e) {} return 1; }', {
          host: { f: make as () => ScriptValue },
        }),
      );
      expect(out.ok, name).toBe(false);
      if (!out.ok) expect(out.error.code, name).toBe('host-error');
      expect(performance.now() - t0, name).toBeLessThan(1000);
    }
  });
});

// ---- the host codec, fed directly

describe('host codec fuzz', () => {
  const limits: ValueLimits = {
    maxStringLength: 20,
    maxElements: 50,
    maxDepth: 6,
    maxPayloadLength: 2000,
  };

  function randomJson(r: () => number, depth: number): string {
    const leaf = () =>
      pick(r, [
        '0',
        '-1.5e300',
        '1e400',
        'true',
        'null',
        '"s"',
        '"\\u0000mfk"',
        '"\\ud800"',
        '"__proto__"',
        `"${'x'.repeat(25)}"`,
        `{"\\u0000mfk":${pick(r, ['0', '1', '2', '-1', '0.5', '1e300', '"NaN"', '"-0"', '"Infinity"', '"constructor"', '"__proto__"', '"toString"', 'null', '[]', '{}'])}}`,
        `{"\\u0000mfk":0,"kind":"body"}`,
      ]);
    if (depth > 7 || r() < 0.4) return leaf();
    const n = Math.floor(r() * 4);
    const items = Array.from({ length: n }, () => randomJson(r, depth + 1));
    if (r() < 0.5) return `[${items.join(',')}]`;
    return `{${items
      .map(
        (v, i) =>
          `${JSON.stringify(pick(r, ['a', 'b', '__proto__', MARK, 'constructor', String(i)]))}:${v}`,
      )
      .join(',')}}`;
  }

  function mutate(r: () => number, s: string): string {
    const alphabet = ['[', ']', '{', '}', '"', ',', ':', '\\', '0', 'a', MARK, '\\u0000mfk', 'e9'];
    let out = s;
    const edits = 1 + Math.floor(r() * 3);
    for (let k = 0; k < edits; k++) {
      const i = Math.floor(r() * (out.length + 1));
      const op = r();
      if (op < 0.4) out = out.slice(0, i) + pick(r, alphabet) + out.slice(i);
      else if (op < 0.7) out = out.slice(0, i) + out.slice(i + 1);
      else out = out.slice(0, i) + pick(r, alphabet) + out.slice(i + 1);
    }
    return out;
  }

  it('returns a valid value or throws CodecError for 5,000 random and mutated payloads', () => {
    const r = rng(1095);
    const before = hostPrototypes();
    let valid = 0;
    let refused = 0;
    for (let n = 0; n < 5000; n++) {
      const handles = new HandleTable();
      const issued = new Set([new ScriptHandle('body', 0), new ScriptHandle('face', 1)]);
      for (const h of issued) handles.indexOf(h);
      const base = randomJson(r, 0);
      const json = r() < 0.5 ? base : mutate(r, base);
      const extraDepth = r() < 0.5 ? 0 : 1;
      try {
        const v = decodePayload(json, handles, limits, extraDepth);
        checkScriptValue(v, issued, limits, limits.maxDepth + extraDepth);
        valid++;
      } catch (e) {
        if (!(e instanceof CodecError)) throw new Error(`${String(e)} for ${json}`, { cause: e });
        refused++;
      }
    }
    expect(hostPrototypes()).toBe(before);
    expect(valid).toBeGreaterThan(500);
    expect(refused).toBeGreaterThan(500);
  });

  it('refuses a huge sparse host array by its length, before walking it', () => {
    const t0 = performance.now();
    expect(() => encodeValue(new Array(1e9), new HandleTable(), DEFAULT_LIMITS)).toThrow(
      expect.objectContaining({ tooLarge: true }) as Error,
    );
    expect(encodeValue(new Array(3), new HandleTable(), DEFAULT_LIMITS)).toBe('[null,null,null]');
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it('refuses a deeply nested payload before parsing it', () => {
    const t0 = performance.now();
    for (const json of ['['.repeat(1e6), '{"a":'.repeat(2e5), `[${'['.repeat(65)}`]) {
      expect(() =>
        decodePayload(json, new HandleTable(), { ...DEFAULT_LIMITS, maxPayloadLength: 1e7 }),
      ).toThrow(CodecError);
    }
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('never resolves a marker to anything but a special number or an issued handle', () => {
    const handles = new HandleTable();
    const h = new ScriptHandle('body', 0);
    handles.indexOf(h);
    expect(decodePayload(`{"${'\\u0000mfk'}":0}`, handles, limits)).toBe(h);
    for (const m of [
      '1',
      '-1',
      '0.5',
      '1e300',
      '"constructor"',
      '"__proto__"',
      '"toString"',
      '"hasOwnProperty"',
      'null',
      'true',
      '[]',
      '{}',
      '"0"',
    ]) {
      expect(() => decodePayload(`{"\\u0000mfk":${m}}`, handles, limits), m).toThrow(CodecError);
    }
  });
});

// ---- parameter names

describe('a parameter named __proto__', () => {
  it('is refused by the declaration parser', () => {
    const declared = JSON.parse('{"__proto__": {"kind": "number", "default": 1}}') as ScriptValue;
    const out = parseParamDeclarations(declared);
    expect(out.ok ? null : out.error).toMatchObject({ code: 'bad-declaration' });
  });

  it('is refused when a script declares it', async () => {
    const inst = await instance();
    for (const declaration of [
      "{ ['__proto__']: { kind: 'number', default: 1 } }",
      "Object.defineProperty({}, '__proto__', { value: { kind: 'number', default: 1 }, enumerable: true })",
    ]) {
      const out = await inst.readDeclarations(
        js(`export const params = ${declaration}; export function run() {}`),
      );
      expect(out.ok, declaration).toBe(false);
      if (!out.ok) expect(out.error.message).toMatch(/__proto__/);
    }
    // The literal form sets the prototype instead: no parameter, and nothing inherited counts.
    const literal = await inst.readDeclarations(
      js(
        "export const params = { __proto__: { evil: { kind: 'number', default: 1 } } }; export function run() {}",
      ),
    );
    expect(literal.ok).toBe(false);
  });

  it('never sets the prototype of the resolved params, even from a hand-made spec', () => {
    const specs: ParamSpec[] = [{ name: '__proto__', kind: 'number', default: 1 }];
    const out = resolveParams(specs, {});
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(Object.getPrototypeOf(out.value)).toBe(Object.prototype);
      expect(Object.getOwnPropertyDescriptor(out.value, '__proto__')?.value).toBe(1);
    }
  });
});

// ---- soft-limit gaps closed by this pass

describe('builtins guarded by the hardening pass', () => {
  const TOLERANCE_MS = 250;

  it.each([
    [
      'Map.has with a huge key',
      "const k = 'a'.repeat(1e6); const m = new Map([[k, 1]]); const k2 = 'a'.repeat(1e6); for (;;) m.has(k2);",
    ],
    [
      'Map.get with a huge key',
      "const k = 'a'.repeat(1e6); const m = new Map(); for (;;) m.get(k);",
    ],
    [
      'Map.set with a huge key',
      "const k = 'a'.repeat(1e6); const m = new Map(); for (;;) m.set(k, 1);",
    ],
    [
      'Map.delete with a huge key',
      "const k = 'a'.repeat(1e6); const m = new Map(); for (;;) m.delete(k);",
    ],
    [
      'Set.has with a huge key',
      "const k = 'a'.repeat(1e6); const s = new Set([k]); const k2 = 'a'.repeat(1e6); for (;;) s.has(k2);",
    ],
    [
      'Set.add with a huge key',
      "const k = 'a'.repeat(1e6); const s = new Set(); for (;;) s.add(k);",
    ],
    [
      'Object.is on two equal huge strings',
      "const s = 'a'.repeat(1e6), t = 'a'.repeat(1e6); for (;;) Object.is(s, t);",
    ],
    [
      'Set.difference',
      'const a = new Set(Array.from({ length: 4e5 }, (_, i) => i)); const b = new Set(); for (;;) a.difference(b);',
    ],
    [
      'Set.union',
      'const a = new Set(Array.from({ length: 2e5 }, (_, i) => i)); for (;;) a.union(a);',
    ],
    [
      'Set.isSubsetOf',
      'const a = new Set(Array.from({ length: 2e5 }, (_, i) => i)); for (;;) a.isSubsetOf(a);',
    ],
    [
      'Set spread',
      'const a = new Set(Array.from({ length: 2e5 }, (_, i) => i)); for (;;) { const b = [...a]; }',
    ],
    [
      'Set from a Set',
      'const a = new Set(Array.from({ length: 2e5 }, (_, i) => i)); for (;;) new Set(a);',
    ],
    [
      'Map from a Map',
      'const m = new Map(Array.from({ length: 2e5 }, (_, i) => [i, i])); for (;;) new Map(m);',
    ],
    ['new ArrayBuffer', 'for (;;) new ArrayBuffer(32e6);'],
    ['ArrayBuffer transfer', 'let b = new ArrayBuffer(16e6); for (;;) b = b.transfer(16e6);'],
    ['new ArrayBuffer with a string length', "for (;;) new ArrayBuffer('32000000');"],
    [
      'Map.getOrInsert with a huge key',
      "const m = new Map(); const k = 'a'.repeat(1e6); for (;;) m.getOrInsert(k, 1);",
    ],
    [
      'Map.getOrInsertComputed with a huge key',
      "const m = new Map(); const k = 'a'.repeat(1e6); for (;;) m.getOrInsertComputed(k, () => 1);",
    ],
    [
      'one Map.groupBy over 100,000 elements with a huge key',
      "const k = 'a'.repeat(1e6); Map.groupBy(new Array(1e5).fill(0), () => k); for (;;) {}",
    ],
    [
      'Map.groupBy with a huge key',
      "const k = 'a'.repeat(1e6); const a = new Array(1000).fill(0); for (;;) Map.groupBy(a, () => k);",
    ],
    [
      'Object.groupBy with a huge key',
      "const k = 'a'.repeat(1e6); const a = new Array(1000).fill(0); for (;;) Object.groupBy(a, () => k);",
    ],
    [
      'Object.groupBy with an object key converting to a huge string',
      "const k = 'a'.repeat(1e6); const o = { toString: () => k }; const a = new Array(1000).fill(0); for (;;) Object.groupBy(a, () => o);",
    ],
    [
      'new Map from entries with a huge key',
      "const k = 'a'.repeat(1e6); const a = new Array(1000).fill([k, 1]); for (;;) new Map(a);",
    ],
    [
      'Set.union over huge keys',
      "const s = new Set(Array.from({ length: 40 }, (_, i) => String(i).padEnd(1e6, 'a'))); for (;;) s.union(s);",
    ],
    [
      'Set.union with a set-like yielding a huge key',
      "const k = 'a'.repeat(1e6); const o = { size: 1, has: () => false, keys: () => [k].values() }; const s = new Set([1]); for (;;) s.union(o);",
    ],
    [
      'Set.difference with a set-like yielding a huge key',
      "const k = 'a'.repeat(1e6); const o = { size: 1, has: () => false, keys: () => [k].values() }; const s = new Set([1]); for (;;) s.difference(o);",
    ],
    [
      'Set.symmetricDifference with a set-like yielding a huge key',
      "const k = 'a'.repeat(1e6); const o = { size: 1, has: () => false, keys: () => [k].values() }; const s = new Set([1]); for (;;) s.symmetricDifference(o);",
    ],
    [
      'Set.intersection with a set-like yielding a huge key',
      "const k = 'a'.repeat(1e6); const o = { size: 1, has: () => false, keys: () => [k].values() }; const s = new Set([1, 2, 3]); for (;;) s.intersection(o);",
    ],
    [
      'Set.isSupersetOf with a set-like yielding a huge key',
      "const k = 'a'.repeat(1e6); const o = { size: 1, has: () => false, keys: () => [k].values() }; const s = new Set([1]); for (;;) s.isSupersetOf(o);",
    ],
    [
      'Set.isDisjointFrom with a set-like yielding a huge key',
      "const k = 'a'.repeat(1e6); const o = { size: 1, has: () => false, keys: () => [k].values() }; const s = new Set([1, 2, 3]); for (;;) s.isDisjointFrom(o);",
    ],
    [
      'one Set.union with a set-like yielding a 4 MB key',
      "const k = 'a'.repeat(4e6); const o = { size: 1, has: () => false, keys: () => [k].values() }; new Set([1]).union(o); for (;;) {}",
    ],
    [
      'Set.union with a Set subclass overriding keys',
      "const k = 'a'.repeat(1e6); class S extends Set { keys() { return [k].values(); } } const o = new S([1]); const s = new Set([1]); for (;;) s.union(o);",
    ],
    [
      'Set.union after the Set iterator next is replaced',
      "const k = 'a'.repeat(1e6); const SI = Object.getPrototypeOf(new Set().values()); SI.next = function () { return { done: false, value: k }; }; const o = new Set([1]); const s = new Set([1]); for (;;) s.union(o);",
    ],
    [
      'one Set.union after the Set iterator next yields a 4 MB key 3000 times',
      "const k = 'a'.repeat(4e6); const SI = Object.getPrototypeOf(new Set().values()); let n = 0; SI.next = function () { return n++ < 3000 ? { done: false, value: k } : { done: true, value: undefined }; }; new Set([1]).union(new Set([1])); for (;;) {}",
    ],
    [
      'Map.groupBy after the Array iterator next is replaced',
      "const k = 'a'.repeat(1e6); const AI = Object.getPrototypeOf([].values()); let n = 0; AI.next = function () { return n++ % 1000 === 999 ? { done: true, value: undefined } : { done: false, value: k }; }; const a = [0]; for (;;) Map.groupBy(a, (v) => v);",
    ],
    [
      'new Set from an array after the Array iterator next is replaced',
      "const k = 'a'.repeat(1e6); const AI = Object.getPrototypeOf([].values()); let n = 0; AI.next = function () { return n++ % 1000 === 999 ? { done: true, value: undefined } : { done: false, value: k }; }; const a = [0]; for (;;) new Set(a);",
    ],
    [
      'new Map from an array after the Array iterator next is replaced',
      "const k = 'a'.repeat(1e6); const AI = Object.getPrototypeOf([].values()); let n = 0; AI.next = function () { return n++ % 1000 === 999 ? { done: true, value: undefined } : { done: false, value: [k, 1] }; }; const a = [0]; for (;;) new Map(a);",
    ],
    [
      'Array.from into a Set after the Array iterator next is replaced',
      "const k = 'a'.repeat(1e6); const AI = Object.getPrototypeOf([].values()); let n = 0; AI.next = function () { return n++ % 1000 === 999 ? { done: true, value: undefined } : { done: false, value: k }; }; const a = [0]; for (;;) new Set(Array.from(a));",
    ],
    [
      'spread into a Set after the Array iterator next is replaced',
      "const k = 'a'.repeat(1e6); const AI = Object.getPrototypeOf([].values()); let n = 0; AI.next = function () { return n++ % 1000 === 999 ? { done: true, value: undefined } : { done: false, value: k }; }; const a = [0]; for (;;) new Set([...a]);",
    ],
    [
      'Set.union after Set.prototype.keys is replaced',
      "const k = 'a'.repeat(1e6); Set.prototype.keys = function () { return [k].values(); }; const o = new Set([1]); const s = new Set([1]); for (;;) s.union(o);",
    ],
    [
      'set methods on the result of a set method over huge keys',
      "const s = new Set(Array.from({ length: 40 }, (_, i) => String(i).padEnd(1e6, 'a'))); const u = s.union(new Set()); for (;;) u.symmetricDifference(new Set());",
    ],
    [
      'Object.seal of a 100,000-key object',
      "const o = {}; for (let i = 0; i < 1e5; i++) o['k' + i] = i; for (;;) Object.seal(o);",
    ],
    [
      'Object.isFrozen of a 100,000-key object',
      "const o = {}; for (let i = 0; i < 1e5; i++) o['k' + i] = i; Object.freeze(o); for (;;) Object.isFrozen(o);",
    ],
    ['Object.seal of an array', 'for (;;) Object.seal(new Array(1e5).fill(0));'],
    [
      'Object.preventExtensions of an array',
      'for (;;) Object.preventExtensions(new Array(1e5).fill(0));',
    ],
    [
      'a typed array subclass from an array',
      'class V extends Float64Array {} const a = new Array(1e6).fill(1.5); for (;;) new V(a);',
    ],
    [
      'a typed array subclass from',
      'class V extends Float64Array {} const a = new Array(1e6).fill(1.5); for (;;) V.from(a);',
    ],
  ])('stops a loop of %s within one call of the limit', async (_name, body) => {
    const out = await (
      await instance({ limits: { timeMs: 300 } })
    ).run(js(`export function run() { ${body} }`));
    expect(out.ok ? 'ok' : out.error.code).toBe('timeout');
    expect(out.stats.ms).toBeLessThan(300 + TOLERANCE_MS);
  });

  it('keeps Map, Set, Object.is and ArrayBuffer working behind their guards', async () => {
    const out = await (
      await instance()
    ).run(
      js(`export function run() {
        const k = 'k'.repeat(300);
        const m = new Map();
        const chained = m.set(k, 1).set('b', 2) === m;
        const s = new Set([1, 2]).add(3);
        let called = 'no error';
        try { ArrayBuffer(8); } catch (e) { called = e instanceof TypeError; }
        class B extends ArrayBuffer {}
        const r = new ArrayBuffer(8, { maxByteLength: 16 });
        r.resize(16);
        const moved = new ArrayBuffer(8).transfer(4);
        return [chained, m.get(k), m.has(k), m.delete(k), m.size, s.has(3), s.delete(1), s.size,
          [...new Set([1, 2]).union(new Set([3]))], new Set([1, 2]).isSubsetOf(new Set([1, 2, 3])),
          Object.is(NaN, NaN), Object.is(0, -0), Object.is(k, 'k'.repeat(300)), Object.is.length,
          Map.prototype.set.length, Map.prototype.get.name, Set.prototype.add.name,
          new ArrayBuffer(8).byteLength, ArrayBuffer.isView(new Uint8Array(1)), called,
          new B(4) instanceof B, new B(4) instanceof ArrayBuffer, new ArrayBuffer(1).constructor === ArrayBuffer,
          ArrayBuffer[Symbol.species] === ArrayBuffer, new ArrayBuffer(8).slice(0, 4).byteLength,
          r.byteLength, moved.byteLength, ArrayBuffer.name, ArrayBuffer.length,
          new Uint8Array(new ArrayBuffer(4)).length, new ArrayBuffer('8').byteLength,
          m.getOrInsert('n', 5), m.getOrInsert('n', 6), m.getOrInsertComputed(k, (key) => key.length),
          Map.prototype.getOrInsert.name, [...Map.groupBy([1, 2, 3], (x) => (x % 2 ? k : 'even'))].map(([g, xs]) => [g.length, xs]),
          Object.groupBy([1, 2, 3], (x) => (x % 2 ? 'odd' : 'even')), Object.groupBy([1], () => ({ toString: () => 'o' })),
          Map.groupBy.name, Object.groupBy.length,
          [...new Set([k, 'a']).union(new Set(['b']))].length, [...new Set([k]).intersection(new Set([k]))][0] === k];
      }`),
    );
    expect(out.ok ? out.value : out.error).toEqual([
      true,
      1,
      true,
      true,
      1,
      true,
      true,
      2,
      [1, 2, 3],
      true,
      true,
      false,
      true,
      2,
      2,
      'get',
      'add',
      8,
      true,
      true,
      true,
      true,
      true,
      true,
      4,
      16,
      4,
      'ArrayBuffer',
      1,
      4,
      8,
      5,
      5,
      300,
      'getOrInsert',
      [
        [300, [1, 3]],
        [4, [2]],
      ],
      { odd: [1, 3], even: [2] },
      { o: [1] },
      'groupBy',
      2,
      3,
      true,
    ]);
  });

  it('keeps the set methods working with set-like arguments, reading each member once', async () => {
    const out = await (
      await instance()
    ).run(
      js(`export function run() {
        const reads = { size: 0, has: 0, keys: 0 };
        const like = (items) => ({
          get size() { reads.size++; return items.length; },
          get has() { reads.has++; return (x) => items.includes(x); },
          get keys() { reads.keys++; return () => items.values(); },
        });
        const s = new Set([1, 2, 3]);
        const out = [[...s.union(like([3, 4]))], [...s.intersection(like([2, 3, 9]))],
          [...s.difference(like([1]))], [...s.symmetricDifference(like([3, 4]))],
          s.isSubsetOf(like([1, 2, 3, 4])), s.isSupersetOf(like([1, 2])), s.isDisjointFrom(like([7]))];
        class S extends Set {}
        out.push([...s.union(new S([5]))]);
        const errors = [];
        for (const bad of [{ size: 1, keys: () => [].values() }, { size: 1, has: () => true }, { size: NaN, has: () => true, keys: () => [].values() }, { size: 1, has: () => true, keys: () => 1 }]) {
          try { s.union(bad); errors.push('no error'); } catch (e) { errors.push(e instanceof TypeError); }
        }
        return [out, errors, reads];
      }`),
    );
    expect(out.ok ? out.value : out.error).toEqual([
      [[1, 2, 3, 4], [2, 3], [2, 3], [1, 2, 4], true, true, true, [1, 2, 3, 5]],
      [true, true, true, true],
      { size: 7, has: 7, keys: 7 },
    ]);
  });

  // The same snippet in QuickJS behind the wrapper and in Node's native set methods.
  async function againstNode(body: string): Promise<void> {
    const native = (new Function(body) as () => unknown)();
    const out = await (await instance()).run(js(`export function run() { ${body} }`));
    expect(out.ok ? out.value : out.error).toEqual(native);
  }

  it('closes a set-like iterator when a set method stops early, as Node does', async () => {
    await againstNode(`
      const log = [];
      const like = (items) => ({
        size: 1,
        has: (x) => items.includes(x),
        keys: () => (function* () {
          try { for (const x of items) { log.push('yield ' + x); yield x; } } finally { log.push('closed'); }
        })(),
      });
      const s = new Set([1, 2, 3]);
      const r = [s.isDisjointFrom(like([9, 2, 8])), s.isSupersetOf(like([1, 7, 2])), s.isSupersetOf(like([1, 2]))];
      const noReturn = { size: 1, has: () => false, keys: () => ({ next: () => ({ done: false, value: 2 }) }) };
      r.push(s.isDisjointFrom(noReturn));
      return [r, log];`);
  });

  it('reads and checks a set-like size before has and keys, as Node does', async () => {
    await againstNode(`
      const out = [];
      for (const size of [NaN, -1, -0.5, '2', undefined, -Infinity, Infinity]) {
        const log = [];
        const like = {
          get size() { log.push('size'); return { valueOf() { log.push('valueOf'); return size; } }; },
          get has() { log.push('has'); return () => false; },
          get keys() { log.push('keys'); return () => [].values(); },
        };
        let result;
        try { result = [...new Set([1]).union(like)]; } catch (e) { result = e.constructor.name; }
        out.push([String(size), result, log]);
      }
      return out;`);
  });

  it('keeps Map and Set cheap on ordinary keys', async () => {
    // 200,000 Map operations on short keys: the lean wrappers read no clock.
    const out = await (
      await instance()
    ).run(
      js(`export function run() {
        const m = new Map(); const s = new Set();
        for (let i = 0; i < 5e4; i++) { m.set('k' + i, i); s.add(i); }
        let t = 0;
        for (let i = 0; i < 5e4; i++) { t += m.get('k' + i); if (s.has(i)) t++; }
        return t;
      }`),
    );
    expect(out.ok ? out.value : out.error).toBe(((5e4 - 1) * 5e4) / 2 + 5e4);
    expect(out.stats.ms).toBeLessThan(1500);
  });
});
