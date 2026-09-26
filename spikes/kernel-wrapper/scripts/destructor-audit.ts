// Which destructor does embind call on obj.delete(), for every class a build
// binds? The T0.2 audit, generalised to the three OCCT builds in this spike.
//
// embind registers each class through one JS import (_embind_register_class)
// that receives the class name and a function-table index for its raw
// destructor. We wrap that import at instantiation time, resolve each
// destructor to its wasm function, and read the function body from the code
// section. A body of 00 0b (no locals, `end`) is an empty function: delete()
// then frees nothing.
//
//   node scripts/destructor-audit.ts <libcascade|replicad-opencascadejs|occt-wasm>
// prints JSON on the last line.

import { readFileSync } from 'node:fs';
import {
  loadLibcascade,
  loadOcctWasm,
  loadReplicadOc,
  type BuildName,
  type Loaded,
} from '../src/loaders.ts';

type Imports = Record<string, Record<string, unknown>>;

const build = (process.argv[2] ?? 'libcascade') as BuildName;

/** Classes whose status matters for the candidates (created per operation). */
const KEY_CLASSES = [
  'TopoDS_Shape',
  'TopoDS_Face',
  'TopoDS_Edge',
  'TopLoc_Location',
  'gp_Pnt',
  'gp_Dir',
  'gp_Ax2',
  'gp_Vec',
  'BRepPrimAPI_MakeBox',
  'BRepPrimAPI_MakeCylinder',
  'BRepPrimAPI_MakePrism',
  'BRepBuilderAPI_MakePolygon',
  'BRepBuilderAPI_MakeFace',
  'BRepBuilderAPI_MakeWire',
  'BRepBuilderAPI_Transform',
  'BRepAlgoAPI_Fuse',
  'BRepAlgoAPI_Cut',
  'BRepFilletAPI_MakeFillet',
  'BRepMesh_IncrementalMesh',
  'TopExp_Explorer',
  'GProp_GProps',
  'NCollection_List_TopoDS_Shape',
  'ReplicadMeshExtractor',
  'ReplicadMeshData',
  'OcctKernel',
];

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
        // Not `p += leb()`: that reads p before leb() advances it.
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
const wrapImports = (imports: Imports) => {
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
};

const loaders: Record<BuildName, (w: typeof wrapImports) => Promise<Loaded<unknown>>> = {
  libcascade: loadLibcascade,
  'replicad-opencascadejs': loadReplicadOc,
  'occt-wasm': loadOcctWasm,
};
const loaded = await loaders[build](wrapImports);
const wasm = readFileSync(loaded.wasmPath);

const table = Object.values(loaded.instance.exports).find(
  (v): v is WebAssembly.Table => v instanceof WebAssembly.Table,
);
if (!table) throw new Error('no function table exported');

const heap = new Uint8Array(loaded.heap.memory.buffer);
const cString = (ptr: number) => {
  let end = ptr;
  while (heap[end]) end++;
  return Buffer.from(heap.subarray(ptr, end)).toString();
};
const body = functionBodies(wasm);

const status = new Map<string, boolean>();
for (const { namePtr, destructor } of registrations) {
  const fnIndex = Number((table.get(destructor) as { name: string }).name);
  const code = body(fnIndex);
  status.set(cString(namePtr), code.length === 2 && code[0] === 0x00 && code[1] === 0x0b);
}

const emptyClasses = [...status]
  .filter(([, empty]) => empty)
  .map(([n]) => n)
  .sort();
console.log(
  JSON.stringify({
    build,
    classes: status.size,
    emptyDestructorClasses: emptyClasses.length,
    keyClasses: KEY_CLASSES.filter((c) => status.has(c)).map((c) => ({
      class: c,
      deleteFrees: !status.get(c),
    })),
    emptyClasses,
  }),
);
process.exit(0);
