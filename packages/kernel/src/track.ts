// Leak-check instrumentation for tests (from the T0.2 spike). Wraps every
// embind class on an instance so that each object handed to JS (from `new`,
// a static call or a method call, including multi-value returns) is recorded.
// After an operation, any recorded object that is not deleted is a leaked C++
// allocation, apart from the shapes the kernel's arena holds on purpose.
// Mutates the instance, so use a dedicated one.

import type { Oc } from './occt';

interface EmbindHandle {
  delete(): void;
  isDeleted(): boolean;
}

type AnyFn = (...args: unknown[]) => unknown;
type AnyClass = AnyFn & { prototype: Record<string, unknown> } & Record<string, unknown>;

const WRAPPED = Symbol('tracked');
const SKIP = new Set(['constructor', 'delete', 'isDeleted', 'clone', 'isAliasOf', 'deleteLater']);

function isHandle(value: unknown): value is EmbindHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as EmbindHandle).delete === 'function' &&
    typeof (value as EmbindHandle).isDeleted === 'function'
  );
}

function isEmbindClass(value: unknown): value is AnyClass {
  return (
    typeof value === 'function' &&
    typeof (value as AnyClass).prototype === 'object' &&
    typeof (value as AnyClass).prototype.delete === 'function'
  );
}

export interface Tracker {
  oc: Oc;
  /** Handles recorded since the last reset. */
  created(): number;
  /** Recorded handles that have not been deleted. */
  live(): number;
  /** Class names of live handles, for diagnosis. */
  liveNames(): string[];
  /** Distinct class names of every handle recorded since the last reset. */
  createdNames(): string[];
  reset(): void;
}

export function track(oc: Oc): Tracker {
  let seen: EmbindHandle[] = [];
  const record = (value: unknown): void => {
    if (isHandle(value)) {
      seen.push(value);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // Multi-output calls return a plain object that may hold handles.
      for (const v of Object.values(value)) if (isHandle(v)) seen.push(v);
    }
  };
  const wrap = (fn: AnyFn): AnyFn => {
    if ((fn as unknown as Record<symbol, boolean>)[WRAPPED]) return fn;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const result = fn.apply(this, args);
      record(result);
      return result;
    };
    // Embind overload dispatchers look up their overload table as a property of
    // the function stored on the prototype, so the wrapper must carry it too.
    Object.assign(wrapped, fn);
    (wrapped as unknown as Record<symbol, boolean>)[WRAPPED] = true;
    return wrapped;
  };

  const registry = oc as unknown as Record<string, unknown>;
  for (const name of Object.keys(registry)) {
    const cls = registry[name];
    if (!isEmbindClass(cls)) continue;
    for (const key of Object.getOwnPropertyNames(cls.prototype)) {
      if (SKIP.has(key)) continue;
      const desc = Object.getOwnPropertyDescriptor(cls.prototype, key);
      if (desc && typeof desc.value === 'function') cls.prototype[key] = wrap(desc.value as AnyFn);
    }
    for (const key of Object.getOwnPropertyNames(cls)) {
      if (key === 'prototype' || key === 'length' || key === 'name') continue;
      const desc = Object.getOwnPropertyDescriptor(cls, key);
      if (desc && desc.writable && typeof desc.value === 'function') {
        cls[key] = wrap(desc.value as AnyFn);
      }
    }
    registry[name] = new Proxy(cls, {
      construct(target, args, newTarget) {
        const instance: unknown = Reflect.construct(target, args, newTarget);
        record(instance);
        return instance as object;
      },
    });
  }

  const liveHandles = () => seen.filter((h) => !h.isDeleted());
  return {
    oc,
    created: () => seen.length,
    live: () => liveHandles().length,
    liveNames: () => liveHandles().map((h) => (h as object).constructor.name),
    createdNames: () => [...new Set(seen.map((h) => (h as object).constructor.name))].sort(),
    reset: () => {
      seen = [];
    },
  };
}

export { heapInUse, occtAllocator, type WasmAllocator } from './heap-probe';
