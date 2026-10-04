// `.mfkview`: a published view of a model, to look at without the kernel (M7 plan, T7.3a). A zip
// holding:
//
// - `manifest.json`: the format and its version, the document's name, units, what was published
//   (a part studio or an assembly), every body (name, colour, material, volume and mass as the
//   app computed them, and its face, edge and triangle counts), the parts (each a list of bodies)
//   and the instances (each a part placed by a rigid 3 x 4 matrix, `Matrix3x4` of placement.ts).
//   A part studio is one part with one instance at the identity.
// - `bodies/<n>.glb`: body n's mesh as binary glTF 2.0, in its part's coordinates, millimetres,
//   written by three's `GLTFExporter`: a node `faces` (one triangle primitive: POSITION, NORMAL,
//   indices, triangles grouped by B-rep face) whose `extras.manufakture` holds the face ranges and
//   names and the edge ranges and names, and, when the body has edges, a node `edges` (one LINES
//   primitive over the edge polylines' points). Any glTF viewer shows it; this reader needs none.
// - `source.mfk`: the document itself, when the author ticked Include source (stored, not
//   recompressed: a `.mfk` is a zip already). Not read here: the app opens it as any `.mfk`.
//
// A bundle from elsewhere is untrusted (the viewer opens links). `readMfkview` reads the zip
// within limits with the bounded inflate (zip.ts), reads only the entries the format names,
// checks the manifest field by field against a schema (unknown fields are dropped, every number
// checked finite and in range, every count capped, names plain strings of bounded length), and
// parses each `.glb` itself, accepting only the subset written here, every accessor checked to
// lie inside its buffer and every index inside its vertices. Nothing of a file is passed on that
// was not checked.

import { zipSync, type Zippable } from 'fflate';
import { ZipReadError, formatByteCount, listZip, readZip, type ZipReadLimits } from './zip';

export const MFKVIEW_FORMAT = 'manufakture-view';
export const MFKVIEW_VERSION = 1;
export const MFKVIEW_MANIFEST = 'manifest.json';
export const MFKVIEW_SOURCE = 'source.mfk';
/** The file extension and the MIME type a bundle is offered under. */
export const MFKVIEW_EXTENSION = 'mfkview';
export const MFKVIEW_MIME = 'application/vnd.manufakture.view+zip';

/** The entry of body `index`'s mesh. */
export const mfkviewBodyEntry = (index: number): string => `bodies/${index}.glb`;

/** One body's mesh as the viewport draws it: the kernel's `MeshData`, names as strings. */
export interface MfkviewMesh {
  /** xyz per vertex, mm, in the body's part coordinates. */
  positions: Float32Array;
  /** Unit normal per vertex. */
  normals: Float32Array;
  /** Three vertex indices per triangle. */
  indices: Uint32Array;
  /** Per face: [first index, index count] into `indices`. */
  faceRanges: Uint32Array;
  /** xyz per edge polyline point, all edges concatenated. */
  edgePositions: Float32Array;
  /** Per edge: [first point, point count] into `edgePositions` (points, not floats). */
  edgeRanges: Uint32Array;
  /** Per face: its name, null when it has none. */
  faceNames: (string | null)[];
  /** Per edge: its name, null when it has none. */
  edgeNames: (string | null)[];
}

export interface MfkviewMaterial {
  id: string;
  name: string;
  /** kg/m3. */
  density: number;
}

/** What the manifest says of a body. */
export interface MfkviewBodyInfo {
  name: string;
  /** `#rrggbb`, or null for the viewer's default. */
  color: string | null;
  material: MfkviewMaterial | null;
  /** mm3, as the app computed it; null when unknown. */
  volume: number | null;
  /** Grams (volume times the material's density); null without a volume and a material. */
  mass: number | null;
  faces: number;
  edges: number;
  triangles: number;
}

export interface MfkviewPart {
  name: string;
  /** Its bodies, by index into `bodies`. */
  bodies: number[];
}

export interface MfkviewInstance {
  name: string;
  /** Index into `parts`. */
  part: number;
  /** Part to world: a rigid `Matrix3x4` (placement.ts), translation in mm. */
  transform: number[];
}

export interface MfkviewManifest {
  format: typeof MFKVIEW_FORMAT;
  version: number;
  /** What wrote it (`manufakture`). */
  generator: string;
  /** The document's name. */
  name: string;
  /** A part studio's bodies, or an assembly's parts placed. */
  kind: 'part' | 'assembly';
  /** `length` is the unit of every coordinate (always mm); `display`, the document's own unit. */
  units: { length: 'mm'; display: string };
  bodies: MfkviewBodyInfo[];
  parts: MfkviewPart[];
  instances: MfkviewInstance[];
  /** The bundle holds `source.mfk`. */
  source: boolean;
}

/** A bundle read back: the manifest, body n's mesh at `meshes[n]`, and its source on demand. */
export interface Mfkview {
  manifest: MfkviewManifest;
  meshes: MfkviewMesh[];
  /**
   * The `.mfk` inside, read (inflated, within the limits' `maxSourceBytes`) only when called;
   * null when the bundle holds none. Throws an `MfkviewError` when it cannot be read.
   */
  readSource(): Uint8Array | null;
}

/** What `writeMfkview` takes: the manifest's fields, each body with its mesh. */
export interface MfkviewInput {
  name: string;
  kind: 'part' | 'assembly';
  /** The document's display unit (`mm`, `in`, `ft-in`, ...); default `mm`. */
  displayUnits?: string;
  generator?: string;
  bodies: readonly (Omit<MfkviewBodyInfo, 'faces' | 'edges' | 'triangles'> & {
    mesh: MfkviewMesh;
  })[];
  parts: readonly MfkviewPart[];
  instances: readonly MfkviewInstance[];
  /** The document as a `.mfk`, to include; absent or null: none. */
  source?: Uint8Array | null;
}

export interface MfkviewLimits extends ZipReadLimits {
  /** `manifest.json`, and each `.glb`'s JSON chunk. */
  maxManifestBytes: number;
  /** One `.glb`. */
  maxMeshBytes: number;
  /** `source.mfk` (the app's own `.mfk` limits apply when it is opened). */
  maxSourceBytes: number;
  maxBodies: number;
  maxParts: number;
  maxInstances: number;
  /** Per body. */
  maxTriangles: number;
  maxVertices: number;
  maxFaces: number;
  maxEdges: number;
  maxEdgePoints: number;
  /** Every body together. */
  maxTotalTriangles: number;
  /** Any name, in UTF-16 code units. */
  maxNameLength: number;
  /** The largest coordinate or translation, in mm. */
  maxCoordinate: number;
}

const MiB = 1024 * 1024;

export const MFKVIEW_LIMITS: MfkviewLimits = {
  maxFileBytes: 256 * MiB,
  maxEntries: 2100,
  maxTotalBytes: 768 * MiB,
  maxManifestBytes: 8 * MiB,
  maxMeshBytes: 128 * MiB,
  maxSourceBytes: 256 * MiB,
  maxBodies: 2000,
  maxParts: 2000,
  maxInstances: 10_000,
  maxTriangles: 4_000_000,
  maxVertices: 4_000_000,
  maxFaces: 200_000,
  maxEdges: 400_000,
  maxEdgePoints: 4_000_000,
  maxTotalTriangles: 20_000_000,
  maxNameLength: 1000,
  maxCoordinate: 1e7,
};

/**
 * Lower limits for bundles from elsewhere (a dropped file, a link): what the viewer passes to
 * `readMfkview`, so a bundle cannot make it allocate more than about 192 MiB of data.
 */
export const MFKVIEW_VIEWER_LIMITS: MfkviewLimits = {
  maxFileBytes: 64 * MiB,
  maxEntries: 520,
  maxTotalBytes: 128 * MiB,
  maxManifestBytes: 2 * MiB,
  maxMeshBytes: 64 * MiB,
  maxSourceBytes: 64 * MiB,
  maxBodies: 500,
  maxParts: 500,
  maxInstances: 5000,
  maxTriangles: 2_000_000,
  maxVertices: 2_000_000,
  maxFaces: 50_000,
  maxEdges: 100_000,
  maxEdgePoints: 2_000_000,
  maxTotalTriangles: 4_000_000,
  maxNameLength: 1000,
  maxCoordinate: 1e7,
};

/** A bundle that cannot be written or read, worded for the person who opened it. */
export class MfkviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MfkviewError';
  }
}

const WHAT = 'a manufakture view (.mfkview)';
const COLOR = /^#[0-9a-fA-F]{6}$/;
const MATERIAL_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DISPLAY_UNIT = /^[a-z][a-z0-9-]{0,15}$/;
const DEFAULT_COLOR = '#c2cad3';
/** How far a transform's rotation may be from orthonormal. */
const RIGID_TOLERANCE = 1e-6;

// The schema -----------------------------------------------------------------------------------

const fail = (message: string): never => {
  throw new MfkviewError(`The view is damaged: ${message}.`);
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function object(v: unknown, what: string): Record<string, unknown> {
  return isObject(v) ? v : fail(`${what} is not an object`);
}

function array(v: unknown, what: string, max: number): unknown[] {
  if (!Array.isArray(v)) return fail(`${what} is not a list`);
  if (v.length > max) return fail(`${what} has more than ${max} items`);
  return v;
}

function text(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string') return fail(`${what} is not text`);
  if (v.length > max) return fail(`${what} is longer than ${max} characters`);
  return v;
}

function integer(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    return fail(`${what} is not a whole number from ${min} to ${max}`);
  }
  return v;
}

function finite(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    return fail(`${what} is not a number from ${min} to ${max}`);
  }
  return v;
}

function orNull<T>(v: unknown, read: (v: unknown) => T): T | null {
  return v === null || v === undefined ? null : read(v);
}

/** Whether a 3 x 4 matrix's rotation rows are orthonormal and right-handed. */
export function isRigidMatrix(m: readonly number[]): boolean {
  if (m.length !== 12 || !m.every(Number.isFinite)) return false;
  const row = (i: number) => [m[i * 3]!, m[i * 3 + 1]!, m[i * 3 + 2]!] as const;
  const dot = (a: readonly number[], b: readonly number[]) =>
    a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const [x, y, z] = [row(0), row(1), row(2)];
  for (const [a, b, want] of [
    [x, x, 1],
    [y, y, 1],
    [z, z, 1],
    [x, y, 0],
    [y, z, 0],
    [x, z, 0],
  ] as const) {
    if (Math.abs(dot(a, b) - want) > RIGID_TOLERANCE) return false;
  }
  const cross = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  return dot(cross, z) > 0;
}

/**
 * A manifest checked against the schema and `limits`: a fresh object holding only the fields the
 * format defines. Throws an `MfkviewError` naming the first problem.
 */
export function parseMfkviewManifest(
  value: unknown,
  limits: MfkviewLimits = MFKVIEW_LIMITS,
): MfkviewManifest {
  const m = object(value, 'the manifest');
  if (m.format !== MFKVIEW_FORMAT) {
    throw new MfkviewError(`This is not ${WHAT}: its manifest names another format.`);
  }
  const version = integer(m.version, 'the format version', 1, Number.MAX_SAFE_INTEGER);
  if (version > MFKVIEW_VERSION) {
    throw new MfkviewError(
      `This view was published by a newer manufakture (format version ${version}; this one reads ${MFKVIEW_VERSION}).`,
    );
  }
  const name = text(m.name, 'the name', limits.maxNameLength);
  const generator = text(m.generator, 'the generator', limits.maxNameLength);
  if (m.kind !== 'part' && m.kind !== 'assembly') fail('the kind is not part or assembly');
  const units = object(m.units, 'the units');
  if (units.length !== 'mm') fail('the length unit is not mm');
  const display = text(units.display, 'the display unit', 16);
  if (!DISPLAY_UNIT.test(display)) fail('the display unit is not a unit name');
  const N = limits.maxNameLength;

  const bodies = array(m.bodies, 'the body list', limits.maxBodies).map((v, i): MfkviewBodyInfo => {
    const what = `body ${i}`;
    const b = object(v, what);
    const color = orNull(b.color, (c) => {
      const s = text(c, `the colour of ${what}`, 7);
      return COLOR.test(s) ? s : fail(`the colour of ${what} is not #rrggbb`);
    });
    const material = orNull(b.material, (x): MfkviewMaterial => {
      const o = object(x, `the material of ${what}`);
      const id = text(o.id, `the material id of ${what}`, 64);
      if (!MATERIAL_ID.test(id)) fail(`the material id of ${what} is not an id`);
      return {
        id,
        name: text(o.name, `the material name of ${what}`, N),
        density: finite(o.density, `the density of ${what}`, Number.MIN_VALUE, 1e6),
      };
    });
    return {
      name: text(b.name, `the name of ${what}`, N),
      color,
      material,
      volume: orNull(b.volume, (x) => finite(x, `the volume of ${what}`, 0, 1e30)),
      mass: orNull(b.mass, (x) => finite(x, `the mass of ${what}`, 0, 1e30)),
      faces: integer(b.faces, `the face count of ${what}`, 0, limits.maxFaces),
      edges: integer(b.edges, `the edge count of ${what}`, 0, limits.maxEdges),
      triangles: integer(b.triangles, `the triangle count of ${what}`, 1, limits.maxTriangles),
    };
  });
  if (bodies.length === 0) fail('it has no bodies');

  const owner = new Array<number>(bodies.length).fill(-1);
  const parts = array(m.parts, 'the part list', limits.maxParts).map((v, i): MfkviewPart => {
    const p = object(v, `part ${i}`);
    const list = array(p.bodies, `the bodies of part ${i}`, bodies.length).map((x) => {
      const b = integer(x, `a body of part ${i}`, 0, bodies.length - 1);
      if (owner[b] !== -1) fail(`body ${b} belongs to two parts`);
      owner[b] = i;
      return b;
    });
    if (list.length === 0) fail(`part ${i} has no bodies`);
    return { name: text(p.name, `the name of part ${i}`, N), bodies: list };
  });
  const orphan = owner.indexOf(-1);
  if (orphan >= 0) fail(`body ${orphan} belongs to no part`);

  const placed = new Set<number>();
  const instances = array(m.instances, 'the instance list', limits.maxInstances).map(
    (v, i): MfkviewInstance => {
      const o = object(v, `instance ${i}`);
      const part = integer(o.part, `the part of instance ${i}`, 0, parts.length - 1);
      placed.add(part);
      const t = array(o.transform, `the transform of instance ${i}`, 12);
      if (t.length !== 12) fail(`the transform of instance ${i} does not have 12 numbers`);
      const C = limits.maxCoordinate;
      const transform = t.map((x) => finite(x, `the transform of instance ${i}`, -C, C));
      if (!isRigidMatrix(transform)) fail(`the transform of instance ${i} is not rigid`);
      return { name: text(o.name, `the name of instance ${i}`, N), part, transform };
    },
  );
  for (let p = 0; p < parts.length; p++) if (!placed.has(p)) fail(`part ${p} has no instance`);
  if (typeof m.source !== 'boolean') fail('whether it holds the source is not true or false');

  return {
    format: MFKVIEW_FORMAT,
    version,
    generator,
    name,
    kind: m.kind as 'part' | 'assembly',
    units: { length: 'mm', display },
    bodies,
    parts,
    instances,
    source: m.source as boolean,
  };
}

// Writing --------------------------------------------------------------------------------------

/** Checks a mesh before it is written, so nothing is written that the reader would refuse. */
function checkMesh(mesh: MfkviewMesh, what: string, limits: MfkviewLimits): void {
  const vertices = mesh.positions.length / 3;
  const faces = mesh.faceRanges.length / 2;
  const edges = mesh.edgeRanges.length / 2;
  const points = mesh.edgePositions.length / 3;
  const bad = (why: string) => {
    throw new MfkviewError(`${what} cannot be published: ${why}.`);
  };
  if (!Number.isInteger(vertices) || mesh.normals.length !== mesh.positions.length) {
    bad('its positions and normals do not match');
  }
  if (mesh.indices.length === 0 || mesh.indices.length % 3 !== 0) bad('it has no triangles');
  if (mesh.indices.length / 3 > limits.maxTriangles) bad('it has too many triangles');
  if (vertices > limits.maxVertices) bad('it has too many vertices');
  if (!Number.isInteger(faces) || faces > limits.maxFaces) bad('its face table is wrong');
  if (!Number.isInteger(edges) || edges > limits.maxEdges) bad('its edge table is wrong');
  if (!Number.isInteger(points) || points > limits.maxEdgePoints) bad('its edges are wrong');
  if (mesh.faceNames.length !== faces || mesh.edgeNames.length !== edges) {
    bad('its name tables do not match its faces and edges');
  }
  for (const n of [...mesh.faceNames, ...mesh.edgeNames]) {
    if (n !== null && n.length > limits.maxNameLength) bad('a face or edge name is too long');
  }
  for (let e = 0; e < edges; e++) {
    if (mesh.edgeRanges[e * 2 + 1] === 1) bad(`edge ${e + 1} has a single point`);
  }
}

/** The edge polylines as line segment pairs over their points. */
function edgeSegments(mesh: MfkviewMesh): Uint32Array {
  const out: number[] = [];
  for (let e = 0; e < mesh.edgeRanges.length / 2; e++) {
    const first = mesh.edgeRanges[e * 2]!;
    const count = mesh.edgeRanges[e * 2 + 1]!;
    for (let k = 0; k + 1 < count; k++) out.push(first + k, first + k + 1);
  }
  return Uint32Array.from(out);
}

/**
 * GLTFExporter turns its buffers into bytes with `FileReader`, which Node lacks. Where it is
 * missing, a minimal one (the one method the exporter calls, on `Blob.arrayBuffer`) is installed
 * for the length of the export and removed afterwards, unless something else has replaced it
 * meanwhile. A read that fails rejects the exports in flight (calling `onerror`, not `onloadend`:
 * the exporter's `onloadend` would read a null result and throw where nothing catches it, leaving
 * the export pending for ever).
 */
let readerShimUsers = 0;
const shimFailures = new Set<(e: unknown) => void>();

class BlobArrayBufferReader {
  result: ArrayBuffer | null = null;
  error: unknown = null;
  onloadend: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  readAsArrayBuffer(blob: Pick<Blob, 'arrayBuffer'>): void {
    blob.arrayBuffer().then(
      (buffer) => {
        this.result = buffer;
        this.onloadend?.();
      },
      (e: unknown) => {
        this.error = e;
        this.onerror?.(e);
        for (const fail of [...shimFailures]) fail(e);
      },
    );
  }
}

/** Run `run` with a `FileReader` available (exported for tests only). */
export async function withFileReaderShim<T>(run: () => Promise<T>): Promise<T> {
  const g = globalThis as { FileReader?: unknown };
  const shim = g.FileReader === undefined || readerShimUsers > 0;
  let fail: (e: unknown) => void = () => {};
  const failed = new Promise<never>((_, reject) => (fail = reject));
  if (shim) {
    if (g.FileReader === undefined) g.FileReader = BlobArrayBufferReader;
    readerShimUsers++;
    shimFailures.add(fail);
  }
  try {
    return await Promise.race([run(), failed]);
  } finally {
    shimFailures.delete(fail);
    if (shim && --readerShimUsers === 0 && g.FileReader === BlobArrayBufferReader) {
      delete g.FileReader;
    }
  }
}

/** One body's mesh as a binary glTF, through three's GLTFExporter. */
async function bodyGlb(mesh: MfkviewMesh, name: string, color: string | null): Promise<Uint8Array> {
  const THREE = await import('three');
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  const scene = new THREE.Scene();
  scene.name = name;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  const material = new THREE.MeshStandardMaterial({
    color: color ?? DEFAULT_COLOR,
    metalness: 0,
    roughness: 0.7,
  });
  const faces = new THREE.Mesh(geometry, material);
  faces.name = 'faces';
  faces.userData = {
    manufakture: {
      faceRanges: Array.from(mesh.faceRanges),
      faceNames: mesh.faceNames,
      edgeRanges: Array.from(mesh.edgeRanges),
      edgeNames: mesh.edgeNames,
    },
  };
  scene.add(faces);
  const disposables: { dispose(): void }[] = [geometry, material];
  if (mesh.edgePositions.length > 0) {
    const lines = new THREE.BufferGeometry();
    lines.setAttribute('position', new THREE.BufferAttribute(mesh.edgePositions, 3));
    lines.setIndex(new THREE.BufferAttribute(edgeSegments(mesh), 1));
    // GLTFExporter writes mesh materials only (a basic one becomes KHR_materials_unlit), and the
    // edges are drawn unlit anyway.
    const ink = new THREE.MeshBasicMaterial({ color: '#1f2328' });
    const edges = new THREE.LineSegments(lines, ink);
    edges.name = 'edges';
    scene.add(edges);
    disposables.push(lines, ink);
  }
  try {
    const out = await withFileReaderShim(() =>
      new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: false }),
    );
    if (!(out instanceof ArrayBuffer)) throw new MfkviewError('The glTF exporter wrote no binary.');
    return new Uint8Array(out);
  } finally {
    for (const d of disposables) d.dispose();
  }
}

/**
 * Write a `.mfkview` bundle. Every body's mesh becomes `bodies/<n>.glb`; the manifest is checked
 * with the reader's own schema first, so a bundle the reader would refuse is never written.
 */
export async function writeMfkview(
  input: MfkviewInput,
  limits: MfkviewLimits = MFKVIEW_LIMITS,
): Promise<Uint8Array> {
  const bodies: MfkviewBodyInfo[] = input.bodies.map((b, i) => {
    checkMesh(b.mesh, b.name || `Body ${i + 1}`, limits);
    return {
      name: b.name,
      color: b.color,
      material: b.material,
      volume: b.volume,
      mass: b.mass,
      faces: b.mesh.faceRanges.length / 2,
      edges: b.mesh.edgeRanges.length / 2,
      triangles: b.mesh.indices.length / 3,
    };
  });
  const source = input.source ?? null;
  const manifest: MfkviewManifest = {
    format: MFKVIEW_FORMAT,
    version: MFKVIEW_VERSION,
    generator: input.generator ?? 'manufakture',
    name: input.name,
    kind: input.kind,
    units: { length: 'mm', display: input.displayUnits ?? 'mm' },
    bodies,
    parts: input.parts.map((p) => ({ name: p.name, bodies: [...p.bodies] })),
    instances: input.instances.map((x) => ({
      name: x.name,
      part: x.part,
      transform: [...x.transform],
    })),
    source: source !== null,
  };
  try {
    parseMfkviewManifest(manifest, limits);
  } catch (e) {
    if (e instanceof MfkviewError) {
      throw new MfkviewError(`The view cannot be published: ${e.message.replace(/^.*?: /, '')}`);
    }
    throw e;
  }
  const total = bodies.reduce((n, b) => n + b.triangles, 0);
  if (total > limits.maxTotalTriangles) {
    throw new MfkviewError(
      `The view cannot be published: it has more than ${limits.maxTotalTriangles} triangles.`,
    );
  }
  if (source !== null && source.length > limits.maxSourceBytes) {
    throw new MfkviewError(
      `The source is larger than ${formatByteCount(limits.maxSourceBytes)}: publish without it.`,
    );
  }
  const files: Zippable = {
    [MFKVIEW_MANIFEST]: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
  };
  for (let i = 0; i < input.bodies.length; i++) {
    const b = input.bodies[i]!;
    const glb = await bodyGlb(b.mesh, b.name, b.color);
    if (glb.length > limits.maxMeshBytes) {
      throw new MfkviewError(`${b.name} cannot be published: its mesh is too large.`);
    }
    files[mfkviewBodyEntry(i)] = glb;
  }
  // A `.mfk` is a zip already: stored, not deflated again.
  if (source !== null) files[MFKVIEW_SOURCE] = [source, { level: 0 }];
  return zipSync(files, { level: 6 });
}

// Reading glTF ---------------------------------------------------------------------------------

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const FLOAT = 5126;
const UNSIGNED_BYTE = 5121;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const TRIANGLES = 4;
const LINES = 1;
const COMPONENT_BYTES: Record<number, number> = {
  [FLOAT]: 4,
  [UNSIGNED_BYTE]: 1,
  [UNSIGNED_SHORT]: 2,
  [UNSIGNED_INT]: 4,
};

interface GlbParts {
  json: Record<string, unknown>;
  bin: Uint8Array;
}

function splitGlb(bytes: Uint8Array, what: string, limits: MfkviewLimits): GlbParts {
  const bad = (why: string) => fail(`the mesh of ${what} ${why}`);
  if (bytes.length < 20) return bad('is too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) return bad('is not binary glTF');
  if (view.getUint32(4, true) !== 2) return bad('is not glTF 2.0');
  if (view.getUint32(8, true) !== bytes.length) return bad('has the wrong length');
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== CHUNK_JSON) return bad('does not start with its JSON');
  if (jsonLength > limits.maxManifestBytes) return bad('has too much JSON');
  const jsonEnd = 20 + jsonLength;
  if (jsonEnd > bytes.length) return bad('is cut short');
  let json: unknown;
  try {
    json = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(20, jsonEnd)),
    );
  } catch {
    return bad('has JSON that cannot be read');
  }
  let bin: Uint8Array = new Uint8Array(0);
  if (jsonEnd + 8 <= bytes.length) {
    const binLength = view.getUint32(jsonEnd, true);
    if (view.getUint32(jsonEnd + 4, true) !== CHUNK_BIN) return bad('has no binary chunk');
    if (jsonEnd + 8 + binLength > bytes.length) return bad('is cut short');
    bin = bytes.subarray(jsonEnd + 8, jsonEnd + 8 + binLength);
  }
  return { json: object(json, `the glTF of ${what}`), bin };
}

/** An accessor's data, copied out of the binary chunk after every bound is checked. */
function readAccessor(
  glb: GlbParts,
  index: unknown,
  type: 'VEC3' | 'SCALAR',
  componentTypes: readonly number[],
  maxCount: number,
  what: string,
): Float32Array | Uint32Array {
  const accessors = array(glb.json.accessors, `the accessors of ${what}`, 64);
  const a = object(
    accessors[integer(index, `an accessor of ${what}`, 0, accessors.length - 1)],
    `an accessor of ${what}`,
  );
  if (a.type !== type) fail(`an accessor of ${what} is not ${type}`);
  if (a.sparse !== undefined) fail(`an accessor of ${what} is sparse`);
  if (a.normalized === true) fail(`an accessor of ${what} is normalized`);
  const componentType = integer(a.componentType, `an accessor of ${what}`, 0, 0xffff);
  if (!componentTypes.includes(componentType)) fail(`an accessor of ${what} has the wrong type`);
  const width = type === 'VEC3' ? 3 : 1;
  const count = integer(a.count, `an accessor count of ${what}`, 0, maxCount);
  const element = COMPONENT_BYTES[componentType]! * width;
  const views = array(glb.json.bufferViews, `the buffer views of ${what}`, 64);
  const v = object(
    views[integer(a.bufferView, `a buffer view of ${what}`, 0, views.length - 1)],
    `a buffer view of ${what}`,
  );
  if (v.buffer !== 0) fail(`a buffer view of ${what} is outside the binary chunk`);
  const viewOffset = integer(v.byteOffset ?? 0, `a buffer view of ${what}`, 0, glb.bin.length);
  const viewLength = integer(v.byteLength, `a buffer view of ${what}`, 0, glb.bin.length);
  if (v.byteStride !== undefined && v.byteStride !== element) {
    fail(`a buffer view of ${what} is interleaved`);
  }
  const offset = integer(a.byteOffset ?? 0, `an accessor of ${what}`, 0, viewLength);
  if (offset + count * element > viewLength || viewOffset + viewLength > glb.bin.length) {
    fail(`an accessor of ${what} lies outside its buffer`);
  }
  const start = viewOffset + offset;
  const n = count * width;
  const dv = new DataView(glb.bin.buffer, glb.bin.byteOffset + start, count * element);
  if (componentType === FLOAT) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, true);
    return out;
  }
  const out = new Uint32Array(n);
  const size = COMPONENT_BYTES[componentType]!;
  for (let i = 0; i < n; i++) {
    out[i] =
      size === 4
        ? dv.getUint32(i * 4, true)
        : size === 2
          ? dv.getUint16(i * 2, true)
          : dv.getUint8(i);
  }
  return out;
}

function checkCoordinates(values: Float32Array, what: string, limits: MfkviewLimits): void {
  const C = limits.maxCoordinate;
  for (let i = 0; i < values.length; i++) {
    const x = values[i]!;
    if (!(x >= -C && x <= C)) fail(`${what} has a coordinate that is not a number in range`);
  }
}

function checkIndices(indices: Uint32Array, vertices: number, what: string): void {
  for (let i = 0; i < indices.length; i++) {
    if (indices[i]! >= vertices) fail(`${what} has an index past its vertices`);
  }
}

/** The one node named `name`, or null; a second one is refused. */
function nodeNamed(glb: GlbParts, name: string, what: string): Record<string, unknown> | null {
  const nodes = array(glb.json.nodes, `the nodes of ${what}`, 16);
  let found: Record<string, unknown> | null = null;
  for (const n of nodes) {
    if (isObject(n) && n.name === name) {
      if (found) fail(`${what} has two ${name} nodes`);
      found = n;
    }
  }
  return found;
}

function primitiveOf(glb: GlbParts, node: Record<string, unknown>, what: string) {
  const meshes = array(glb.json.meshes, `the meshes of ${what}`, 16);
  const mesh = object(
    meshes[integer(node.mesh, `the mesh of ${what}`, 0, meshes.length - 1)],
    `the mesh of ${what}`,
  );
  const primitives = array(mesh.primitives, `the primitives of ${what}`, 1);
  if (primitives.length !== 1) fail(`${what} does not have one primitive`);
  const p = object(primitives[0], `the primitive of ${what}`);
  return { primitive: p, attributes: object(p.attributes, `the attributes of ${what}`) };
}

function rangeTable(
  v: unknown,
  count: number,
  total: number,
  what: string,
  multiple: number,
): Uint32Array {
  const list = array(v, what, count * 2);
  if (list.length !== count * 2) fail(`${what} does not match the count`);
  const out = new Uint32Array(list.length);
  for (let i = 0; i < count; i++) {
    const first = integer(list[i * 2], what, 0, total);
    const n = integer(list[i * 2 + 1], what, 0, total - first);
    if (first % multiple !== 0 || n % multiple !== 0) fail(`${what} splits a triangle`);
    out[i * 2] = first;
    out[i * 2 + 1] = n;
  }
  return out;
}

function nameTable(v: unknown, count: number, what: string, limits: MfkviewLimits) {
  const list = array(v, what, count);
  if (list.length !== count) fail(`${what} does not match the count`);
  return list.map((n) => (n === null ? null : text(n, `a name in ${what}`, limits.maxNameLength)));
}

/** Body `index`'s `.glb`, as written by `writeMfkview`, checked against its manifest entry. */
function parseBodyGlb(
  bytes: Uint8Array,
  index: number,
  info: MfkviewBodyInfo,
  limits: MfkviewLimits,
): MfkviewMesh {
  const what = `body ${index}`;
  const glb = splitGlb(bytes, what, limits);
  const facesNode = nodeNamed(glb, 'faces', what) ?? fail(`${what} has no faces`);
  const { primitive, attributes } = primitiveOf(glb, facesNode, what);
  if ((primitive.mode ?? TRIANGLES) !== TRIANGLES) fail(`the faces of ${what} are not triangles`);
  const positions = readAccessor(
    glb,
    attributes.POSITION,
    'VEC3',
    [FLOAT],
    limits.maxVertices,
    what,
  ) as Float32Array;
  const normals = readAccessor(
    glb,
    attributes.NORMAL,
    'VEC3',
    [FLOAT],
    limits.maxVertices,
    what,
  ) as Float32Array;
  if (normals.length !== positions.length) fail(`the normals of ${what} do not match its vertices`);
  const indices = readAccessor(
    glb,
    primitive.indices,
    'SCALAR',
    [UNSIGNED_BYTE, UNSIGNED_SHORT, UNSIGNED_INT],
    limits.maxTriangles * 3,
    what,
  ) as Uint32Array;
  if (indices.length !== info.triangles * 3) fail(`${what} does not have the triangles it lists`);
  checkCoordinates(positions, what, limits);
  for (let i = 0; i < normals.length; i++) {
    if (!(Math.abs(normals[i]!) <= 1.001)) fail(`${what} has a normal that is not a unit vector`);
  }
  checkIndices(indices, positions.length / 3, what);

  const extras = object(
    object(facesNode.extras, `the extras of ${what}`).manufakture,
    `the name table of ${what}`,
  );
  const faceRanges = rangeTable(
    extras.faceRanges,
    info.faces,
    indices.length,
    `the face ranges of ${what}`,
    3,
  );
  const faceNames = nameTable(extras.faceNames, info.faces, `the face names of ${what}`, limits);

  let edgePositions: Float32Array = new Float32Array(0);
  const edgesNode = nodeNamed(glb, 'edges', what);
  if (edgesNode) {
    const edges = primitiveOf(glb, edgesNode, `the edges of ${what}`);
    if (edges.primitive.mode !== LINES) fail(`the edges of ${what} are not lines`);
    edgePositions = readAccessor(
      glb,
      edges.attributes.POSITION,
      'VEC3',
      [FLOAT],
      limits.maxEdgePoints,
      what,
    ) as Float32Array;
    checkCoordinates(edgePositions, what, limits);
    const segments = readAccessor(
      glb,
      edges.primitive.indices,
      'SCALAR',
      [UNSIGNED_BYTE, UNSIGNED_SHORT, UNSIGNED_INT],
      limits.maxEdgePoints * 2,
      what,
    ) as Uint32Array;
    checkIndices(segments, edgePositions.length / 3, `the edges of ${what}`);
  }
  const edgeRanges = rangeTable(
    extras.edgeRanges,
    info.edges,
    edgePositions.length / 3,
    `the edge ranges of ${what}`,
    1,
  );
  const edgeNames = nameTable(extras.edgeNames, info.edges, `the edge names of ${what}`, limits);
  return {
    positions,
    normals,
    indices,
    faceRanges,
    edgePositions,
    edgeRanges,
    faceNames,
    edgeNames,
  };
}

// Reading the bundle ---------------------------------------------------------------------------

function utf8(bytes: Uint8Array, name: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new MfkviewError(`The view is damaged: ${name} is not UTF-8 text.`);
  }
}

function zipEntries(
  bytes: Uint8Array,
  limits: MfkviewLimits,
  wanted: (name: string) => number | null,
): Map<string, Uint8Array> {
  try {
    return readZip(bytes, limits, wanted, WHAT);
  } catch (e) {
    if (e instanceof ZipReadError) throw new MfkviewError(e.message);
    throw e;
  }
}

/**
 * Read a `.mfkview` within `limits`, treating every byte as hostile. The viewer passes
 * `MFKVIEW_VIEWER_LIMITS`; the default, `MFKVIEW_LIMITS`, is what the writer allows. Throws an `MfkviewError`
 * saying what is wrong.
 */
export function readMfkview(bytes: Uint8Array, limits: MfkviewLimits = MFKVIEW_LIMITS): Mfkview {
  // The manifest first, so the meshes read are exactly the ones it lists.
  const first = zipEntries(bytes, limits, (n) =>
    n === MFKVIEW_MANIFEST ? limits.maxManifestBytes : null,
  );
  const manifestBytes = first.get(MFKVIEW_MANIFEST);
  if (!manifestBytes) throw new MfkviewError(`This is not ${WHAT}: it has no ${MFKVIEW_MANIFEST}.`);
  let value: unknown;
  try {
    value = JSON.parse(utf8(manifestBytes, MFKVIEW_MANIFEST));
  } catch (e) {
    if (e instanceof MfkviewError) throw e;
    throw new MfkviewError(`The view is damaged: ${MFKVIEW_MANIFEST} is not JSON.`);
  }
  const manifest = parseMfkviewManifest(value, limits);
  const total = manifest.bodies.reduce((n, b) => n + b.triangles, 0);
  if (total > limits.maxTotalTriangles) {
    throw new MfkviewError(`The view has more than ${limits.maxTotalTriangles} triangles.`);
  }
  const wanted = new Map<string, number>();
  manifest.bodies.forEach((_, i) => wanted.set(mfkviewBodyEntry(i), limits.maxMeshBytes));
  // The source is not inflated here: only checked to be there (its directory entry placed and
  // sized like any other), and read when asked for.
  const entries = zipEntries(bytes, limits, (n) => wanted.get(n) ?? null);
  const meshes = manifest.bodies.map((info, i) => {
    const glb = entries.get(mfkviewBodyEntry(i));
    if (!glb) throw new MfkviewError(`The view is damaged: the mesh of body ${i} is missing.`);
    return parseBodyGlb(glb, i, info, limits);
  });
  if (manifest.source && !zipNames(bytes, limits).includes(MFKVIEW_SOURCE)) {
    throw new MfkviewError('The view is damaged: its source is missing.');
  }
  let source: Uint8Array | null | undefined;
  const readSource = (): Uint8Array | null => {
    if (!manifest.source) return null;
    if (source === undefined) {
      const read = zipEntries(bytes, { ...limits, maxTotalBytes: limits.maxSourceBytes }, (n) =>
        n === MFKVIEW_SOURCE ? limits.maxSourceBytes : null,
      );
      source = read.get(MFKVIEW_SOURCE) ?? null;
      if (source === null) throw new MfkviewError('The view is damaged: its source is missing.');
    }
    return source;
  };
  return { manifest, meshes, readSource };
}

function zipNames(bytes: Uint8Array, limits: MfkviewLimits): string[] {
  try {
    return listZip(bytes, limits, WHAT);
  } catch (e) {
    if (e instanceof ZipReadError) throw new MfkviewError(e.message);
    throw e;
  }
}
