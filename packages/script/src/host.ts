// What the host hands a script: functions over plain data and opaque handles (ADR 0010 decisions
// 3 and 6). The regen worker builds the actual API (T7.2c); this package defines how it crosses.

/**
 * A value that crosses the script boundary: numbers (NaN, the infinities and -0 included; a
 * host function decides what it accepts), strings, booleans, null, arrays, plain objects of those,
 * and handles. `undefined` stands for "no value" at the top level (a function that returns
 * nothing); inside arrays it becomes null and inside objects its key is dropped, as in JSON.
 */
export type ScriptValue =
  | number
  | string
  | boolean
  | null
  | undefined
  | ScriptHandle
  | ScriptValue[]
  | { [key: string]: ScriptValue };

/**
 * An opaque reference to a host object (a shape, a sketch, a query result). The script sees a
 * frozen object with only a `kind` string; when it passes it back, the host function receives
 * this same `ScriptHandle`. Handles live for one run: the table behind them is dropped when the
 * run ends, so nothing the host keeps is reachable from a later run.
 */
export class ScriptHandle<T = unknown> {
  readonly kind: string;
  readonly value: T;

  constructor(kind: string, value: T) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(kind)) {
      throw new TypeError(
        `handle kind must be a short lowercase word, got ${JSON.stringify(kind)}`,
      );
    }
    this.kind = kind;
    this.value = value;
  }
}

/** A host function: receives the script's arguments, returns a value (or nothing). */
export type HostFunction = (...args: ScriptValue[]) => ScriptValue | void;

/** A host function that changes geometry: counted against `limits.kernelOps`. */
export class KernelOp {
  readonly fn: HostFunction;

  constructor(fn: HostFunction) {
    this.fn = fn;
  }
}

/** Marks a host function as a kernel operation. */
export function kernelOp(fn: HostFunction): KernelOp {
  return new KernelOp(fn);
}

/**
 * The API a script's `run(ctx, params)` receives as `ctx`: functions, kernel operations and
 * nested namespaces (`{ sketch: { line, arc }, extrude: kernelOp(...) }`). Names are JavaScript
 * identifiers. The script sees a frozen object with the same shape; nothing else is reachable.
 */
export interface HostApi {
  [name: string]: HostFunction | KernelOp | HostApi;
}

export interface FlatHostFunction {
  fn: HostFunction;
  kernelOp: boolean;
}

const NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

/** The API flattened to `a.b.c` paths, and its shape for the prelude. */
export function flattenHostApi(api: HostApi): {
  functions: Map<string, FlatHostFunction>;
  shape: Record<string, unknown>;
} {
  const functions = new Map<string, FlatHostFunction>();
  const walk = (node: HostApi, prefix: string, depth: number): Record<string, unknown> => {
    if (depth > 8) throw new TypeError('host API is nested too deeply');
    const shape: Record<string, unknown> = {};
    for (const [name, member] of Object.entries(node)) {
      if (!NAME.test(name) || name === '__proto__') {
        throw new TypeError(`host API member name ${JSON.stringify(name)} is not an identifier`);
      }
      const path = prefix === '' ? name : `${prefix}.${name}`;
      if (typeof member === 'function') {
        functions.set(path, { fn: member, kernelOp: false });
        shape[name] = 1;
      } else if (member instanceof KernelOp) {
        functions.set(path, { fn: member.fn, kernelOp: true });
        shape[name] = 1;
      } else if (member !== null && typeof member === 'object') {
        shape[name] = walk(member, path, depth + 1);
      } else {
        throw new TypeError(`host API member ${path} is not a function or namespace`);
      }
    }
    return shape;
  };
  return { functions, shape: walk(api, '', 0) };
}
