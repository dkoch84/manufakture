// Loading gmsh (our build, wasm/gmsh.mjs + gmsh.wasm) and the few calls of its C API that FEA
// makes. The module is imported lazily on the first analysis, like Manifold's (ADR 0002 decision
// 4: the .wasm is its own file, never inlined); its compiled `WebAssembly.Module` is kept, and
// every analysis gets a fresh instance in a fresh memory whose maximum is the memory budget, so
// gmsh cannot grow past it and its memory is freed with the instance.
//
// Nothing gmsh prints reaches stdout: `print` and `printErr` go to a bounded log, since a Node host
// may carry a protocol on stdout (the MCP server).

import type { GmshModule } from '../wasm/gmsh.mjs';

/** A failed gmsh call: gmsh's last error and the tail of its log. */
export class GmshError extends Error {
  readonly log: string;
  constructor(message: string, log: string) {
    super(message);
    this.log = log;
  }
}

/** The mesher is not built or cannot be loaded. */
export class MesherUnavailable extends Error {}

const PAGE = 65536;
const INITIAL_BYTES = 64 * 1024 * 1024;
const LOG_LINES = 40;

let compiled: Promise<WebAssembly.Module> | null = null;
let glue: Promise<typeof import('../wasm/gmsh.mjs')> | null = null;

const isNode = (): boolean =>
  typeof process !== 'undefined' && typeof process.versions === 'object' && !!process.versions.node;

/** Reads and compiles gmsh.wasm once per worker. */
function compileGmsh(): Promise<WebAssembly.Module> {
  compiled ??= (async () => {
    const url = new URL('../wasm/gmsh.wasm', import.meta.url);
    if (isNode()) {
      const { readFile } = await import('node:fs/promises');
      const { fileURLToPath } = await import('node:url');
      const bytes = await readFile(fileURLToPath(url));
      return WebAssembly.compile(bytes);
    }
    return WebAssembly.compileStreaming(fetch(url));
  })();
  compiled.catch(() => (compiled = null));
  return compiled;
}

function loadGlue(): Promise<typeof import('../wasm/gmsh.mjs')> {
  glue ??= import('../wasm/gmsh.mjs');
  glue.catch(() => (glue = null));
  return glue;
}

/** Downloads (or reads) and compiles the mesher; later calls reuse it. */
export async function prepareGmsh(): Promise<void> {
  try {
    await Promise.all([loadGlue(), compileGmsh()]);
  } catch (error) {
    throw new MesherUnavailable(
      `The mesher could not be loaded (packages/fea/wasm is built by packages/fea/build/build-gmsh.sh): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** A gmsh instance with its own memory. */
export async function instantiateGmsh(memoryBytes: number): Promise<Gmsh> {
  await prepareGmsh();
  const [{ default: createGmsh }, module] = await Promise.all([loadGlue(), compileGmsh()]);
  const maxPages = Math.max(INITIAL_BYTES / PAGE, Math.min(65536, Math.floor(memoryBytes / PAGE)));
  const memory = new WebAssembly.Memory({ initial: INITIAL_BYTES / PAGE, maximum: maxPages });
  const log: string[] = [];
  const keep = (text: string) => {
    log.push(text);
    if (log.length > LOG_LINES) log.shift();
  };
  // The glue's own promise never settles if instantiation fails or the runtime aborts during
  // start-up, so those end the wait here instead.
  let fail: (error: unknown) => void = () => undefined;
  const failed = new Promise<never>((_, reject) => (fail = reject));
  const mod = await Promise.race([
    createGmsh({
      wasmMemory: memory,
      print: keep,
      printErr: keep,
      onAbort: (what) => fail(new GmshError(`gmsh aborted: ${String(what)}`, log.join('\n'))),
      instantiateWasm(imports, receive) {
        WebAssembly.instantiate(module, imports).then(
          (instance) => receive(instance, module),
          fail,
        );
        return {};
      },
    }),
    failed,
  ]);
  return new Gmsh(mod, memory, maxPages * PAGE, log);
}

/** The calls FEA makes, with gmsh's `ierr` turned into `GmshError`. */
export class Gmsh {
  readonly memory: WebAssembly.Memory;
  readonly maxBytes: number;
  private readonly m: GmshModule;
  private readonly log: string[];
  private readonly scratch: number;

  constructor(m: GmshModule, memory: WebAssembly.Memory, maxBytes: number, log: string[]) {
    this.m = m;
    this.memory = memory;
    this.maxBytes = maxBytes;
    this.log = log;
    this.scratch = m._malloc(128);
  }

  /** Bytes of gmsh's memory now (wasm memory never shrinks, so also its high-water mark). */
  bytes(): number {
    return this.memory.buffer.byteLength;
  }

  logTail(): string {
    return this.log.join('\n');
  }

  private u32(): Uint32Array {
    return new Uint32Array(this.memory.buffer);
  }
  private i32(): Int32Array {
    return new Int32Array(this.memory.buffer);
  }
  private f64(): Float64Array {
    return new Float64Array(this.memory.buffer);
  }

  /** Scratch slot k (4-byte words; slots 0 to 15 hold out-pointers and counts, 16+ doubles). */
  private slot(k: number): number {
    return this.scratch + 4 * k;
  }

  private ierr(): number {
    return this.slot(31);
  }

  private check(what: string): void {
    const code = this.i32()[this.ierr() >> 2]!;
    if (code === 0) return;
    let message = '';
    try {
      this.m._gmshLoggerGetLastError(this.slot(30), this.slot(29));
      const p = this.u32()[this.slot(30) >> 2]!;
      if (p) {
        message = this.m.UTF8ToString(p);
        this.m._gmshFree(p);
      }
    } catch {
      // the logger itself failed; keep the code
    }
    throw new GmshError(`${what}: ${message || `gmsh error ${code}`}`, this.logTail());
  }

  private withString<T>(text: string, f: (ptr: number) => T): T {
    const len = this.m.lengthBytesUTF8(text) + 1;
    const p = this.m._malloc(len);
    try {
      this.m.stringToUTF8(text, p, len);
      return f(p);
    } finally {
      this.m._free(p);
    }
  }

  private withInts<T>(values: ArrayLike<number>, f: (ptr: number, n: number) => T): T {
    const p = this.m._malloc(Math.max(1, values.length) * 4);
    try {
      const h = this.i32();
      for (let i = 0; i < values.length; i++) h[(p >> 2) + i] = values[i]!;
      return f(p, values.length);
    } finally {
      this.m._free(p);
    }
  }

  /** Read and free an int array whose pointer and count gmsh wrote into slots a and b. */
  private takeInts(a: number, b: number): Int32Array {
    const u = this.u32();
    const p = u[this.slot(a) >> 2]!;
    const n = u[this.slot(b) >> 2]!;
    const out = n > 0 ? this.i32().slice(p >> 2, (p >> 2) + n) : new Int32Array(0);
    if (p) this.m._gmshFree(p);
    return out;
  }

  private takeSizes(a: number, b: number): Uint32Array {
    const u = this.u32();
    const p = u[this.slot(a) >> 2]!;
    const n = u[this.slot(b) >> 2]!;
    const out = n > 0 ? u.slice(p >> 2, (p >> 2) + n) : new Uint32Array(0);
    if (p) this.m._gmshFree(p);
    return out;
  }

  private takeDoubles(a: number, b: number): Float64Array {
    const u = this.u32();
    const p = u[this.slot(a) >> 2]!;
    const n = u[this.slot(b) >> 2]!;
    const out = n > 0 ? this.f64().slice(p >> 3, (p >> 3) + n) : new Float64Array(0);
    if (p) this.m._gmshFree(p);
    return out;
  }

  initialize(): void {
    this.m._gmshInitialize(0, 0, 0, 0, this.ierr());
    this.check('initialize');
  }

  finalize(): void {
    try {
      this.m._gmshFinalize(this.ierr());
    } catch {
      // the instance is dropped anyway
    }
  }

  setNumber(name: string, value: number): void {
    this.withString(name, (p) => this.m._gmshOptionSetNumber(p, value, this.ierr()));
    this.check(`option ${name}`);
  }

  addModel(name: string): void {
    this.withString(name, (p) => this.m._gmshModelAdd(p, this.ierr()));
    this.check('model.add');
  }

  /** Import a STEP file's shapes; returns the volumes' (dim, tag) pairs. */
  importStep(bytes: Uint8Array, name: string): Int32Array {
    const path = `/${name}.step`;
    this.m.FS.writeFile(path, bytes);
    try {
      this.withString(path, (p) =>
        this.withString('', (fmt) =>
          this.m._gmshModelOccImportShapes(p, this.slot(0), this.slot(1), 1, fmt, this.ierr()),
        ),
      );
      this.check('importShapes');
      return this.takeInts(0, 1);
    } finally {
      this.m.FS.unlink(path);
    }
  }

  synchronize(): void {
    this.m._gmshModelOccSynchronize(this.ierr());
    this.check('occ.synchronize');
  }

  /** (dim, tag) pairs of the model's entities of a dimension (-1: all). */
  entities(dim: number): Int32Array {
    this.m._gmshModelGetEntities(this.slot(0), this.slot(1), dim, this.ierr());
    this.check('getEntities');
    return this.takeInts(0, 1);
  }

  /** The boundary of entities: oriented false, combined false, recursive as given. */
  boundary(dimTags: ArrayLike<number>, recursive: boolean): Int32Array {
    this.withInts(dimTags, (p, n) =>
      this.m._gmshModelGetBoundary(
        p,
        n,
        this.slot(0),
        this.slot(1),
        0,
        0,
        recursive ? 1 : 0,
        this.ierr(),
      ),
    );
    this.check('getBoundary');
    return this.takeInts(0, 1);
  }

  /** Volume (dim 3) or area (dim 2) of an OCC entity. */
  mass(dim: number, tag: number): number {
    this.m._gmshModelOccGetMass(dim, tag, this.slot(16), this.ierr());
    this.check('occ.getMass');
    return this.f64()[this.slot(16) >> 3]!;
  }

  /**
   * Boolean fragment of all the objects: shared faces become one, so bonded bodies mesh
   * conformally. Returns, for each input entity, the entities it became.
   */
  fragment(objects: ArrayLike<number>): { out: Int32Array; map: Int32Array[] } {
    this.withInts(objects, (p, n) =>
      this.withInts([], (tp) =>
        this.m._gmshModelOccFragment(
          p,
          n,
          tp,
          0,
          this.slot(0),
          this.slot(1),
          this.slot(2),
          this.slot(3),
          this.slot(4),
          -1,
          1,
          1,
          this.ierr(),
        ),
      ),
    );
    this.check('occ.fragment');
    const out = this.takeInts(0, 1);
    // outDimTagsMap: int** of length nn, with per-entry lengths in a size_t* array.
    const u = this.u32();
    const mapPtr = u[this.slot(2) >> 2]!;
    const lenPtr = u[this.slot(3) >> 2]!;
    const nn = u[this.slot(4) >> 2]!;
    const map: Int32Array[] = [];
    for (let k = 0; k < nn; k++) {
      const p = this.u32()[(mapPtr >> 2) + k]!;
      const len = this.u32()[(lenPtr >> 2) + k]!;
      map.push(len > 0 ? this.i32().slice(p >> 2, (p >> 2) + len) : new Int32Array(0));
      if (p) this.m._gmshFree(p);
    }
    if (mapPtr) this.m._gmshFree(mapPtr);
    if (lenPtr) this.m._gmshFree(lenPtr);
    return { out, map };
  }

  generate(dim: number): void {
    this.m._gmshModelMeshGenerate(dim, this.ierr());
    this.check('mesh.generate');
  }

  setSize(dimTags: ArrayLike<number>, size: number): void {
    this.withInts(dimTags, (p, n) => this.m._gmshModelMeshSetSize(p, n, size, this.ierr()));
    this.check('mesh.setSize');
  }

  /** Nodes of an entity (dim -1: all), with or without its boundary's. */
  nodes(
    dim: number,
    tag: number,
    includeBoundary: boolean,
  ): { tags: Uint32Array; coords: Float64Array } {
    this.m._gmshModelMeshGetNodes(
      this.slot(0),
      this.slot(1),
      this.slot(2),
      this.slot(3),
      this.slot(4),
      this.slot(5),
      dim,
      tag,
      includeBoundary ? 1 : 0,
      0,
      this.ierr(),
    );
    this.check('mesh.getNodes');
    const tags = this.takeSizes(0, 1);
    const coords = this.takeDoubles(2, 3);
    const u = this.u32();
    const pp = u[this.slot(4) >> 2]!;
    if (pp) this.m._gmshFree(pp);
    return { tags, coords };
  }

  /** Elements of a type on an entity (tag -1: all): their node tags, flat. */
  elementsByType(type: number, tag: number): Uint32Array {
    this.m._gmshModelMeshGetElementsByType(
      type,
      this.slot(0),
      this.slot(1),
      this.slot(2),
      this.slot(3),
      tag,
      0,
      1,
      this.ierr(),
    );
    this.check('mesh.getElementsByType');
    const u = this.u32();
    const ep = u[this.slot(0) >> 2]!;
    if (ep) this.m._gmshFree(ep);
    return this.takeSizes(2, 3);
  }

  addField(type: string): number {
    const tag = this.withString(type, (p) => this.m._gmshModelMeshFieldAdd(p, -1, this.ierr()));
    this.check(`field.add ${type}`);
    return tag;
  }

  fieldNumber(tag: number, option: string, value: number): void {
    this.withString(option, (p) => this.m._gmshModelMeshFieldSetNumber(tag, p, value, this.ierr()));
    this.check(`field ${option}`);
  }

  fieldNumbers(tag: number, option: string, values: ArrayLike<number>): void {
    const p = this.m._malloc(Math.max(1, values.length) * 8);
    try {
      const h = this.f64();
      for (let i = 0; i < values.length; i++) h[(p >> 3) + i] = values[i]!;
      this.withString(option, (o) =>
        this.m._gmshModelMeshFieldSetNumbers(tag, o, p, values.length, this.ierr()),
      );
    } finally {
      this.m._free(p);
    }
    this.check(`field ${option}`);
  }

  backgroundField(tag: number): void {
    this.m._gmshModelMeshFieldSetAsBackgroundMesh(tag, this.ierr());
    this.check('field.setAsBackgroundMesh');
  }
}
