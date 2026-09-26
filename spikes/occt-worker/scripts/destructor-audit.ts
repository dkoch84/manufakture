// Audit which destructor embind calls when JS does obj.delete(), for every
// class libcascade binds.
//
// embind registers each class through one JS import that receives, among other
// things, the class name and a function-table index for its raw destructor. We
// wrap that import at instantiation time, resolve each destructor to its wasm
// function index, map that to a C++ name through the shipped .js.symbols file,
// and read the function body from the .wasm code section. A body of 00 0b (no
// locals, `end`) is an empty function: delete() then frees nothing at all.
//
//   node scripts/destructor-audit.ts <single|multi>
// prints JSON on the last line.

import { readFileSync } from 'node:fs';
import { CASES, type CaseName } from '../src/cases.ts';
import { runPipeline, type MemoryMode, type Oc } from '../src/pipeline.ts';
import type { Variant } from '../src/protocol.ts';
import { track } from '../src/track.ts';
import { LIBCASCADE_DIST } from './lib.ts';

type Instantiate = (
  imports: Record<string, Record<string, unknown>>,
  receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
) => object;

const variant = (process.argv[2] ?? 'single') as Variant;
const wasm = readFileSync(`${LIBCASCADE_DIST}opencascade_${variant}.wasm`);
const symbols = new Map<number, string>(
  readFileSync(`${LIBCASCADE_DIST}opencascade_${variant}.js.symbols`, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(':');
      return [Number(line.slice(0, i)), line.slice(i + 1)];
    }),
);

/** Function bodies by function index (imports counted), from the code section. */
function functionBodies(bytes: Uint8Array): (index: number) => Uint8Array {
  let p = 8;
  const leb = () => {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = bytes[p++]!;
      result |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return result >>> 0;
  };
  const skipLimits = () => {
    const flags = leb();
    leb();
    if (flags & 1) leb();
  };
  let importedFunctions = 0;
  let codeStart = -1;
  while (p < bytes.length) {
    const id = bytes[p++]!;
    const size = leb();
    const start = p;
    if (id === 2) {
      const count = leb();
      for (let i = 0; i < count; i++) {
        const moduleLen = leb();
        p += moduleLen;
        const fieldLen = leb();
        p += fieldLen;
        const kind = bytes[p++]!;
        if (kind === 0) {
          leb();
          importedFunctions++;
        } else if (kind === 1) {
          p++;
          skipLimits();
        } else if (kind === 2) {
          skipLimits();
        } else if (kind === 3) {
          p += 2;
        } else if (kind === 4) {
          p++;
          leb();
        }
      }
    }
    if (id === 10) codeStart = start;
    p = start + size;
  }
  const offsets: Array<[number, number]> = [];
  p = codeStart;
  const count = leb();
  for (let i = 0; i < count; i++) {
    const size = leb();
    offsets.push([p, size]);
    p += size;
  }
  return (index) => {
    const [start, size] = offsets[index - importedFunctions]!;
    return bytes.subarray(start, start + size);
  };
}

const registrations: Array<{ namePtr: number; destructor: number }> = [];
let instance: WebAssembly.Instance | null = null;
const instantiateWasm: Instantiate = (imports, receive) => {
  for (const mod of Object.values(imports)) {
    for (const [key, fn] of Object.entries(mod)) {
      // _embind_register_class: 13 parameters; its body builds the JS class.
      if (typeof fn === 'function' && fn.length === 13 && fn.toString().includes('to construct')) {
        mod[key] = (...a: number[]) => {
          registrations.push({ namePtr: a[10]! >>> 0, destructor: a[12]! >>> 0 });
          return (fn as (...x: number[]) => unknown)(...a);
        };
      }
    }
  }
  void (async () => {
    const module = await WebAssembly.compile(wasm);
    instance = await WebAssembly.instantiate(module, imports as WebAssembly.Imports);
    receive(instance, module);
  })();
  return {};
};

const createInstance =
  variant === 'multi'
    ? (await import('libcascade/multi/init')).createInstance
    : (await import('libcascade/single/init')).createInstance;
const oc: Oc = await createInstance({ instantiateWasm } as never);

const table = Object.values(instance!.exports).find(
  (v): v is WebAssembly.Table => v instanceof WebAssembly.Table,
)!;
const heap = new Uint8Array(oc.wasmMemory.buffer);
const cString = (ptr: number) => {
  let end = ptr;
  while (heap[end]) end++;
  return Buffer.from(heap.subarray(ptr, end)).toString();
};
const body = functionBodies(wasm);

const status = new Map<string, { empty: boolean; destructor: string }>();
for (const { namePtr, destructor } of registrations) {
  const fnIndex = Number((table.get(destructor) as { name: string }).name);
  const code = body(fnIndex);
  const empty = code.length === 2 && code[0] === 0x00 && code[1] === 0x0b;
  status.set(cString(namePtr), { empty, destructor: symbols.get(fnIndex) ?? String(fnIndex) });
}

// The classes the spike pipeline actually creates, found by running it tracked.
const tracker = track(oc);
for (const memory of ['strict', 'mitigated'] as MemoryMode[]) {
  for (const name of Object.keys(CASES) as CaseName[]) {
    runPipeline(tracker.oc, { ...CASES[name], parallel: false, memory });
  }
}
const used = tracker.createdNames();

const emptyClasses = [...status]
  .filter(([, s]) => s.empty)
  .map(([n]) => n)
  .sort();
console.log(
  JSON.stringify({
    variant,
    classes: status.size,
    emptyDestructorClasses: emptyClasses.length,
    usedBySpike: used.map((name) => ({
      class: name,
      deleteFrees: status.has(name) ? !status.get(name)!.empty : null,
    })),
    emptyClasses,
  }),
);
process.exit(0);
