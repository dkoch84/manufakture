// Does `delete()` free anything, per embind class? The T0.2 / kernel-wrapper destructor audit
// (spikes/kernel-wrapper/scripts/destructor-audit.ts), reduced to libcascade's single build.
//
// embind registers each class through one import (_embind_register_class, 13 parameters) that
// receives the class name and a function-table index for its raw destructor. The import is
// wrapped at instantiation, each destructor resolved to its wasm function, and the function body
// read from the code section: a body of 00 0b (no locals, `end`) is empty, so delete() frees
// nothing.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

type Imports = Record<string, Record<string, unknown>>;

const kernelRequire = createRequire(
  new URL('../../../packages/kernel/src/node.ts', import.meta.url),
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

/** For every class libcascade registers: true when its delete() frees memory. */
export async function auditDestructors(): Promise<Map<string, boolean>> {
  const wasmPath = kernelRequire.resolve('libcascade/single/wasm');
  const initPath = kernelRequire.resolve('libcascade/single/init');
  const bytes = readFileSync(wasmPath);
  const { createInstance } = (await import(initPath)) as {
    createInstance(options: object): Promise<{ wasmMemory?: WebAssembly.Memory }>;
  };
  const registrations: Array<{ namePtr: number; destructor: number }> = [];
  let instance: WebAssembly.Instance | null = null;
  const instantiateWasm = (
    imports: Imports,
    receive: (i: WebAssembly.Instance, m: WebAssembly.Module) => void,
  ) => {
    for (const mod of Object.values(imports)) {
      for (const [key, fn] of Object.entries(mod)) {
        if (
          typeof fn === 'function' &&
          fn.length === 13 &&
          fn.toString().includes('to construct')
        ) {
          mod[key] = (...a: number[]) => {
            registrations.push({ namePtr: a[10]! >>> 0, destructor: a[12]! >>> 0 });
            return (fn as (...x: number[]) => unknown)(...a);
          };
        }
      }
    }
    WebAssembly.instantiate(bytes, imports as WebAssembly.Imports).then(
      ({ instance: i, module }) => {
        instance = i;
        receive(i, module);
      },
    );
    return {};
  };
  await createInstance({ instantiateWasm });
  const exports = (instance as WebAssembly.Instance | null)!.exports;
  const table = Object.values(exports).find(
    (v): v is WebAssembly.Table => v instanceof WebAssembly.Table,
  )!;
  const memory = Object.values(exports).find(
    (v): v is WebAssembly.Memory => v instanceof WebAssembly.Memory,
  )!;
  const heap = new Uint8Array(memory.buffer);
  const cString = (ptr: number) => {
    let end = ptr;
    while (heap[end]) end++;
    return Buffer.from(heap.subarray(ptr, end)).toString();
  };
  const body = functionBodies(bytes);
  const out = new Map<string, boolean>();
  for (const { namePtr, destructor } of registrations) {
    const code = body(Number((table.get(destructor) as { name: string }).name));
    out.set(cString(namePtr), !(code.length === 2 && code[0] === 0x00 && code[1] === 0x0b));
  }
  return out;
}
