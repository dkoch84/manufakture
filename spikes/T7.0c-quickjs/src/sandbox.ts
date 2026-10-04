// A minimal script host in the shape ADR 0010 decision 3 describes, enough to measure it:
// ECMAScript built-ins minus `Date` (the intrinsic is not created at all), `Math.random`
// replaced by a seeded generator, and a `host` object holding only the functions the caller
// installs. Values cross as plain data: numbers, strings, booleans, null, arrays and objects of
// those. T7.2b writes the real binding; this one exists to measure the costs.

import type { QuickJSContext, QuickJSHandle, QuickJSRuntime } from 'quickjs-emscripten-core';

export type Plain = number | string | boolean | null | Plain[] | { [key: string]: Plain };

export const INTRINSICS_WITHOUT_DATE = {
  BaseObjects: true,
  Date: false,
  Eval: true,
  StringNormalize: true,
  RegExp: true,
  JSON: true,
  Proxy: true,
  MapSet: true,
  TypedArrays: true,
  Promise: true,
} as const;

/**
 * Prelude run in every context: a deterministic `Math.random` (mulberry32 over a 32-bit seed;
 * the real seed is the script hash plus the feature's `seed`, ADR 0010 decision 3).
 */
export function prelude(seed: number): string {
  return `(() => {
  let s = ${seed >>> 0};
  Math.random = function random() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();`;
}

/** Plain data into the context. NaN becomes a canonical NaN; nothing else is accepted. */
export function toHandle(ctx: QuickJSContext, value: Plain): QuickJSHandle {
  if (typeof value === 'number') return ctx.newNumber(Number.isNaN(value) ? NaN : value);
  if (typeof value === 'string') return ctx.newString(value);
  if (typeof value === 'boolean') return value ? ctx.true : ctx.false;
  if (value === null) return ctx.null;
  if (Array.isArray(value)) {
    const array = ctx.newArray();
    value.forEach((item, i) => {
      const h = toHandle(ctx, item);
      ctx.setProp(array, i, h);
      h.dispose();
    });
    return array;
  }
  const object = ctx.newObject();
  for (const [key, item] of Object.entries(value)) {
    const h = toHandle(ctx, item);
    ctx.setProp(object, key, h);
    h.dispose();
  }
  return object;
}

/** Plain data out of the context (`dump` goes through JSON for objects). */
export function fromHandle(ctx: QuickJSContext, handle: QuickJSHandle): unknown {
  return ctx.dump(handle);
}

/** Install `host.<name>` functions on the context's global object. */
export function installHost(
  ctx: QuickJSContext,
  functions: Record<string, (...args: QuickJSHandle[]) => QuickJSHandle | undefined>,
): void {
  const host = ctx.newObject();
  for (const [name, fn] of Object.entries(functions)) {
    const f = ctx.newFunction(name, fn);
    ctx.setProp(host, name, f);
    f.dispose();
  }
  ctx.setProp(ctx.global, 'host', host);
  host.dispose();
}

/** A fresh context with the ADR 0010 globals. */
export function newScriptContext(rt: QuickJSRuntime, seed = 0): QuickJSContext {
  const ctx = rt.newContext({ intrinsics: INTRINSICS_WITHOUT_DATE });
  ctx.unwrapResult(ctx.evalCode(prelude(seed))).dispose();
  return ctx;
}

export type EvalOutcome =
  { ok: true; value: unknown } | { ok: false; name: string; message: string };

/** Evaluate and dump the result, or the error's name and message. Disposes every handle. */
export function evalPlain(ctx: QuickJSContext, code: string): EvalOutcome {
  const result = ctx.evalCode(code, 'script.js');
  if (result.error) {
    const error = ctx.dump(result.error) as { name?: string; message?: string } | string;
    result.error.dispose();
    if (typeof error === 'object' && error !== null) {
      return { ok: false, name: String(error.name), message: String(error.message) };
    }
    return { ok: false, name: 'thrown', message: String(error) };
  }
  const value = ctx.dump(result.value);
  result.value.dispose();
  return { ok: true, value };
}
