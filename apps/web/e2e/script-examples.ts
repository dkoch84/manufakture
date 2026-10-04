// The example scripts of docs/user/scripting.md, plus scripts that lean on everything a browser
// could compute differently (transcendental functions, number formatting, the seeded random,
// sorting, JSON, string case mapping, TypeScript erasure and error positions, the stack and time
// limits), run against a host that records every call. scripting-cross-browser.spec.ts runs this
// in Node and in a module worker of each browser and compares the two bit for bit (T7.2e).
//
// Imported from Node (the spec) and bundled for the browser (script-harness.worker.ts), so it uses
// only `@manufakture/script`'s portable entry point.

import {
  ScriptHandle,
  kernelOp,
  resolveParams,
  type HostApi,
  type ScriptEngine,
  type ScriptLanguage,
  type ScriptValue,
} from '../../../packages/script/src/index';

export interface Example {
  name: string;
  language: ScriptLanguage;
  source: string;
  /** Stored parameter values (defaults fill the rest). */
  params?: Record<string, ScriptValue>;
  seed?: number;
  timeMs?: number;
}

const BOX = `// A box with rounded vertical edges. Lengths are in millimetres, angles in radians.
export const params = {
  width: { kind: 'length', default: 40, min: 1, label: 'Width' },
  depth: { kind: 'length', default: 30, min: 1, label: 'Depth' },
  height: { kind: 'length', default: 20, min: 1, label: 'Height' },
  radius: { kind: 'length', default: 2, min: 0, label: 'Corner radius' },
};

export function run(ctx, p) {
  const base = ctx.sketch('base', {
    plane: 'XY',
    loops: [
      [
        { kind: 'line', id: 'front', start: [0, 0], end: [p.width, 0] },
        { kind: 'line', id: 'right', start: [p.width, 0], end: [p.width, p.depth] },
        { kind: 'line', id: 'back', start: [p.width, p.depth], end: [0, p.depth] },
        { kind: 'line', id: 'left', start: [0, p.depth], end: [0, 0] },
      ],
    ],
  });
  const box = ctx.extrude('box', base, { distance: p.height });
  if (p.radius > 0) ctx.fillet('round', ctx.edges(box, { direction: [0, 0, 1] }), p.radius);
}
`;

const BOLT_CIRCLE = `export const params = {
  count: { kind: 'number', default: 6, min: 1, max: 64, integer: true, label: 'Holes' },
  pitch: { kind: 'length', default: 30, label: 'Pitch radius' },
  hole: { kind: 'length', default: 3, label: 'Hole radius' },
};

export function run(ctx, p) {
  const disk = ctx.sketch('disk', {
    loops: [[{ kind: 'circle', id: 'rim', center: [0, 0], radius: 50 }]],
  });
  ctx.extrude('plate', disk, { distance: 10 });
  const spot = ctx.sketch('spot', {
    plane: { origin: [0, 0, 10], normal: [0, 0, 1] },
    loops: [[{ kind: 'circle', id: 'c', center: [p.pitch, 0], radius: p.hole }]],
  });
  const drill = ctx.extrude('drill', spot, { through: true, reverse: true, mode: 'cut' });
  ctx.pattern('circle', drill, {
    circular: { axis: { origin: [0, 0, 0], direction: [0, 0, 1] }, count: p.count },
  });
}
`;

const SPIRAL = `export const params = {
  turns: { kind: 'number', default: 1.5 },
  holes: { kind: 'number', default: 9, integer: true, min: 1, max: 40 },
};

export function run(ctx: any, p: { turns: number; holes: number }): void {
  for (let i = 0; i < p.holes; i++) {
    const t = (i / p.holes) * p.turns * 2 * Math.PI;
    const r = 10 + 30 * (i / p.holes);
    const at = ctx.sketch('at' + i, {
      plane: { origin: [0, 0, 5], normal: [0, 0, 1] },
      loops: [[{ kind: 'circle', id: 'c', center: [r * Math.cos(t), r * Math.sin(t)], radius: 2 }]],
    });
    ctx.extrude('hole' + i, at, { through: true, reverse: true, mode: 'cut' });
  }
}
`;

/** Numerics a browser's own JavaScript engine would compute differently; here QuickJS does. */
const NUMERICS = `export function run(ctx) {
  const xs = [];
  for (let i = -40; i <= 40; i++) xs.push(i * 0.7853981633974483 + i / 7, 10 ** (i / 4), -(2 ** (i / 3)));
  const fns = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh',
    'atanh', 'exp', 'expm1', 'log', 'log1p', 'log2', 'log10', 'cbrt', 'sqrt', 'fround'];
  const out = {};
  for (const f of fns) out[f] = xs.map((x) => Math[f](x));
  out.pow = xs.map((x, i) => Math.pow(Math.abs(x), (i % 13) / 3 - 2));
  out.atan2 = xs.map((x, i) => Math.atan2(x, xs[(i * 7) % xs.length]));
  out.hypot = xs.map((x, i) => Math.hypot(x, i, xs[(i * 3) % xs.length]));
  out.text = xs.slice(0, 40).map((x) => [String(x), x.toFixed(7), x.toPrecision(12), x.toExponential(5),
    x.toString(36), Number(x.toFixed(3)), parseFloat(String(x / 3))].join(' '));
  out.random = Array.from({ length: 16 }, () => Math.random());
  const data = Array.from({ length: 200 }, (_, i) => ({ k: (i * 7919) % 17, i }));
  out.sorted = data.sort((a, b) => a.k - b.k).map((d) => d.i).slice(0, 60);
  out.json = JSON.parse(JSON.stringify({ a: 0.1 + 0.2, b: 1e21, c: 5e-324, d: -0, e: [1.5e300 * 10] }));
  out.strings = ['Straße', 'ǅemal', 'ﬁne', 'İstanbul', 'ΣΑΣ'].map((s) => [s.toUpperCase(), s.toLowerCase(),
    s.normalize('NFD').length, s.localeCompare('Strasse')]);
  out.calls = ctx.measure.volume(ctx.extrude('slab', ctx.sketch('s', { loops: [] }), { distance: Math.E }));
  return out;
}
`;

/** TypeScript whose error position goes through sucrase's source map. */
const TS_THROWS = `interface Size { width: number }
export const params = { width: { kind: 'length', default: 3 } };
export function run(ctx: unknown, p: Size): number {
  const scale: number = p.width as number;
  if (scale > 1) throw new RangeError('too wide: ' + scale.toFixed(2));
  return scale;
}
`;

const DEEP = `export function run() {
  const f = (n) => (n === 0 ? 0 : 1 + f(n - 1));
  return f(1e6);
}
`;

const LOOP = `export function run() {
  let n = 0;
  for (;;) n++;
}
`;

const HUGE = `export function run(ctx) {
  return ctx.echo('x'.repeat((1 << 20) + 1));
}
`;

export const EXAMPLES: readonly Example[] = [
  { name: 'box', language: 'js', source: BOX },
  { name: 'box, edited', language: 'js', source: BOX, params: { width: 52.5, radius: 0 } },
  { name: 'bolt circle', language: 'js', source: BOLT_CIRCLE, params: { count: 11 } },
  { name: 'spiral', language: 'ts', source: SPIRAL, params: { turns: 2.75, holes: 23 } },
  { name: 'numerics', language: 'js', source: NUMERICS, seed: 1095 },
  { name: 'numerics, other seed', language: 'js', source: NUMERICS, seed: -7 },
  { name: 'TypeScript error position', language: 'ts', source: TS_THROWS, params: { width: 4 } },
  { name: 'deep recursion', language: 'js', source: DEEP },
  { name: 'time limit', language: 'js', source: LOOP, timeMs: 150 },
  { name: 'value limit', language: 'js', source: HUGE },
];

/** Every double as its 16 hex digits, so equality is bit for bit (NaN, -0 included). */
export function bits(v: unknown): unknown {
  if (typeof v === 'number') {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, v);
    return `f64:${view.getBigUint64(0).toString(16).padStart(16, '0')}`;
  }
  if (v instanceof ScriptHandle) return { handle: v.kind, id: v.value as number };
  if (Array.isArray(v)) return v.map(bits);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bits(x)]));
  }
  return v === undefined ? '(undefined)' : v;
}

/** A host with the regen API's shape that records every call and hands out numbered handles. */
function recordingHost(log: unknown[]): HostApi {
  let next = 0;
  const handle = (kind: string) => new ScriptHandle(kind, next++);
  const op =
    (name: string, kind: string) =>
    (...args: ScriptValue[]) => {
      log.push([name, bits(args)]);
      return handle(kind);
    };
  return {
    sketch: op('sketch', 'sketch'),
    extrude: kernelOp(op('extrude', 'body')),
    fillet: kernelOp(op('fillet', 'body')),
    pattern: kernelOp(op('pattern', 'body')),
    edges: (...args) => {
      log.push(['edges', bits(args)]);
      return [handle('edge'), handle('edge'), handle('edge'), handle('edge')];
    },
    echo: (v) => v,
    measure: {
      volume: (...args) => {
        log.push(['measure.volume', bits(args)]);
        return Math.PI * 1000;
      },
    },
  };
}

/** Runs every example in a fresh instance; the result holds no timings, only data. */
export async function runExamples(engine: ScriptEngine): Promise<unknown> {
  const results: Record<string, unknown> = {};
  for (const example of EXAMPLES) {
    const inst = await engine.createInstance();
    const script = { source: example.source, language: example.language, apiVersion: 1 };
    const decl = await inst.readDeclarations(script);
    if (!decl.ok) {
      results[example.name] = { declarations: decl.error };
      continue;
    }
    const params = resolveParams(decl.value.params, example.params ?? {});
    if (!params.ok) {
      results[example.name] = { params: params.error };
      continue;
    }
    const log: unknown[] = [];
    const out = await inst.run({
      ...script,
      seed: example.seed ?? 0,
      params: params.value,
      host: recordingHost(log),
      ...(example.timeMs === undefined ? {} : { limits: { timeMs: example.timeMs } }),
    });
    results[example.name] = {
      params: bits(decl.value.params),
      log,
      outcome: out.ok
        ? { ok: true, value: bits(out.value) }
        : // Where a timeout lands in the loop depends on the clock; only that it happened is data.
          out.error.code === 'timeout'
          ? { ok: false, error: { code: out.error.code, message: out.error.message } }
          : { ok: false, error: out.error, hostCalls: out.stats.hostCalls },
      kernelOps: out.stats.kernelOps,
    };
    inst.dispose();
  }
  return results;
}
