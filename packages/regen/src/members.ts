// Member sets (ADR 0015 decisions 4 and 5, from the T6.5a spike): framing members are data, not
// bodies. A domain's member stage (`MemberStage`, an optional entry of `ExtensionDomain`) turns the
// metadata of a part's built extensions into members, one framing group at a time (a wall with
// its openings, a floor, a roof). Regen caches each group's members by its inputs, meshes every
// distinct member shape once (boxes in TypeScript, members with cuts through Manifold), and sends
// the main thread one transform per member. Nothing here enters the kernel's arena; B-reps of
// members are built only on request (`memberFeatureInputs`, used by `RegenEngine.memberBodies`).
//
// Regen imports no domain package: `MemberData` is a generic shape that the construction domain's
// `Member` (`packages/domain-construction/src/members.ts`) satisfies structurally.
//
// Memory (T6.5a recommendation 5): member sets are plain data; one Manifold module per regen
// worker, loaded on the first member with a cut; every Manifold object, intermediates included,
// deleted in a `finally` right after `getMesh`.

import type { FeatureInput, ToolItem } from '@manufakture/kernel';
import type { Manifold, ManifoldToplevel } from 'manifold-3d/manifold';
import type { ExtensionFailure, JsonValue } from './extensions';
import { hashValue, stableStringify } from './hash';
import type { RegenError } from './types';

// The member data shape -----------------------------------------------------------------------

export type MemberVec3 = readonly [number, number, number];

/** A half-space: every point with `dot(n, p) >= k`; `n` a unit vector into the removed side. */
export interface MemberPlane {
  readonly n: MemberVec3;
  readonly k: number;
}

/**
 * Material removed from a member, in its own frame: `plane` removes `dot(n, p) >= k`; `notch`
 * removes the intersection of two such half-spaces (a birdsmouth's heel and seat).
 */
export type MemberCut =
  | { readonly kind: 'plane'; readonly n: MemberVec3; readonly k: number }
  | { readonly kind: 'notch'; readonly a: MemberPlane; readonly b: MemberPlane };

/** The stock a member is cut from: `width` the thin face, `depth` the wide one, in mm. */
export interface MemberStock {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly depth: number;
}

/**
 * Where a member sits: its blank is `origin + a x + b y + c z` for `a` in [0, length], `b` in
 * [0, stock width], `c` in [0, stock depth], `z = x cross y`. Orthonormal and right-handed.
 */
export interface MemberPlacement {
  readonly origin: MemberVec3;
  readonly x: MemberVec3;
  readonly y: MemberVec3;
}

/** One framing member (ADR 0015 decision 4). Its full id is `<owner>:<id>`. */
export interface MemberData {
  /** Local to its owner: `s12`, `top1:2`, `king-l`. */
  readonly id: string;
  /** The feature that owns it: a wall, an opening, a floor or a roof. */
  readonly owner: string;
  readonly role: string;
  readonly stock: MemberStock;
  /** The blank length along local x, mm. */
  readonly length: number;
  readonly placement: MemberPlacement;
  readonly cuts: readonly MemberCut[];
}

/** `<owner>:<id>`: the one feature id at the front (ADR 0015 decision 6). */
export const memberFullId = (m: Pick<MemberData, 'owner' | 'id'>): string => `${m.owner}:${m.id}`;

// The member stage hook -------------------------------------------------------------------------

/** A built extension of the domain's namespace, as the member stage sees it. */
export interface MemberFeature {
  id: string;
  /** The extension type (`construction.wall`). */
  type: string;
  schemaVersion: number;
  dependsOn: readonly string[];
  /** What its translator returned as metadata (ADR 0013 decision 7); absent when none. */
  metadata?: JsonValue;
}

/** A framing group: the features framed together, the first the one it is named after. */
export interface MemberGroup {
  /** Unique in the part (a wall's feature id). */
  id: string;
  /** Ids of features given to `groups`, at least one. A feature may be in several groups. */
  features: readonly string[];
}

export interface MemberStageContext {
  partId: string;
  /** Every extension of the domain's namespace that built (`ok`) in the part, in feature order. */
  features: readonly MemberFeature[];
  /** The domain data the domain reads, as for a translator (`ExtensionContext.data`). */
  data: Readonly<Record<string, unknown>>;
}

export interface MemberGroupContext {
  partId: string;
  group: MemberGroup;
  /** The group's features, in the group's order. */
  features: readonly MemberFeature[];
  data: Readonly<Record<string, unknown>>;
}

/** A layout warning the stage reports on one feature of the group (shown in the tree). */
export interface MemberWarning {
  /** The feature it belongs on; one of the group's. */
  feature: string;
  message: string;
  /** The domain's own code (`no-header-rule`), passed through. */
  code?: string;
  /** A full member id it is about. */
  member?: string;
}

/** What a group frames to. */
export interface MemberOutput {
  members: readonly MemberData[];
  warnings?: readonly MemberWarning[];
  /** Derived data for the domain's own models (an opening's header source); never stored. */
  metadata?: JsonValue;
}

/**
 * A domain's member producer (ADR 0015 decision 5). Pure and deterministic: regen calls `groups`
 * after a part's features have regenerated, then `frame` for each group its cache does not hold.
 * A throw or a malformed result becomes an `extension` error on the group's features, never a
 * failed regen. Methods, so a domain's typed stage registers where this one is expected.
 */
export interface MemberStage {
  groups(context: MemberStageContext): readonly MemberGroup[];
  frame(context: MemberGroupContext): MemberOutput | ExtensionFailure;
}

// Results ---------------------------------------------------------------------------------------

/** A mesh in a member's own frame: indexed triangles, one normal per vertex. */
export interface MemberMeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/** A distinct member shape's mesh, sent once when its key is new to the main thread. */
export interface MemberMesh extends MemberMeshData {
  /** `memberShapeKey`. */
  key: string;
}

/** The members of one set that share a shape: what one `InstancedMesh` draws. */
export interface MemberInstances {
  /** The shape's key (`MemberMesh.key`). */
  shape: string;
  /** Full ids (`<owner>:<id>`), one per instance: the pick result. */
  ids: string[];
  roles: string[];
  /** A column-major 4x4 per instance (three.js `Matrix4.elements` order), member to world, mm. */
  matrices: Float32Array;
}

/** One framing group's members in a part's result, next to its bodies. */
export interface MemberSetResult {
  /** `MemberGroup.id`. */
  group: string;
  /** The domain that framed it. */
  namespace: string;
  features: string[];
  /** Cache key of the set; equal keys mean identical members. */
  setKey: string;
  /** Served from the member cache: the stage did not run for it in this regen. */
  cached: boolean;
  /** The set differs from the one the last completed regen reported for this group. */
  changed: boolean;
  /** Every member when `changed`; null otherwise (the main thread keeps the last one). */
  members: MemberData[] | null;
  /** The instance lists when `changed` (matrices transferred); null otherwise. */
  instances: MemberInstances[] | null;
  /** What `MemberOutput.metadata` held, when `changed`. */
  metadata?: JsonValue;
  /** How many members it has. */
  count: number;
  /** Milliseconds framing and meshing it took in this regen. */
  ms: number;
}

/** The member shape meshes a completed regen adds and drops, worker-wide. */
export interface MemberMeshUpdate {
  /** Shapes new to the main thread (their buffers transferred). */
  added: MemberMesh[];
  /** Keys no member uses any more. */
  removed: string[];
}

// Shape keys and transforms -------------------------------------------------------------------

const fixed = (v: number, digits: number): string => {
  const s = v.toFixed(digits);
  return s === `-${(0).toFixed(digits)}` ? (0).toFixed(digits) : s;
};

const planeKey = (p: MemberPlane): string =>
  `${fixed(p.n[0], 5)},${fixed(p.n[1], 5)},${fixed(p.n[2], 5)},${fixed(p.k, 3)}`;

/**
 * Members with equal keys have the same local geometry and share one mesh (T6.5a, "Mesh sharing
 * rules"): stock, blank length to 0.001 mm, sorted local cuts (normals to 1e-5, offsets to
 * 0.001 mm). Placement is never part of it. The same form as the construction domain's
 * `shapeKey`.
 */
export function memberShapeKey(m: Pick<MemberData, 'stock' | 'length' | 'cuts'>): string {
  const cuts = m.cuts
    .map((c) => (c.kind === 'plane' ? `p${planeKey(c)}` : `n${planeKey(c.a)};${planeKey(c.b)}`))
    .sort()
    .join('|');
  return `${m.stock.id}:${fixed(m.stock.width, 3)}x${fixed(m.stock.depth, 3)}:${fixed(m.length, 3)}:${cuts}`;
}

const cross = (a: MemberVec3, b: MemberVec3): MemberVec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: MemberVec3, b: MemberVec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: MemberVec3, b: MemberVec3): MemberVec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: MemberVec3, s: number): MemberVec3 => [a[0] * s, a[1] * s, a[2] * s];
const normalize = (a: MemberVec3): MemberVec3 => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));
/** A mutable copy, as the kernel's inputs take vectors. */
const v3 = (a: MemberVec3): [number, number, number] => [a[0], a[1], a[2]];

/** Write a placement's column-major 4x4 at `out[at..at+16]`. */
export function writePlacementMatrix(p: MemberPlacement, out: Float32Array, at: number): void {
  const z = cross(p.x, p.y);
  out.set([...p.x, 0, ...p.y, 0, ...z, 0, ...p.origin, 1], at);
}

/** A local direction in world coordinates. */
const toWorldDir = (p: MemberPlacement, v: MemberVec3): MemberVec3 => {
  const z = cross(p.x, p.y);
  return [
    v[0] * p.x[0] + v[1] * p.y[0] + v[2] * z[0],
    v[0] * p.x[1] + v[1] * p.y[1] + v[2] * z[1],
    v[0] * p.x[2] + v[1] * p.y[2] + v[2] * z[2],
  ];
};

/** A plane in the member's frame, in world coordinates. */
function worldPlane(p: MemberPlacement, plane: MemberPlane): MemberPlane {
  const n = toWorldDir(p, plane.n);
  return { n, k: plane.k + dot(n, p.origin) };
}

/** The instance lists of a set: members grouped by shape, in order of first appearance. */
export function memberInstances(members: readonly MemberData[]): MemberInstances[] {
  const by = new Map<string, MemberData[]>();
  for (const m of members) {
    const key = memberShapeKey(m);
    const list = by.get(key);
    if (list) list.push(m);
    else by.set(key, [m]);
  }
  return [...by].map(([shape, ms]) => {
    const matrices = new Float32Array(ms.length * 16);
    ms.forEach((m, i) => writePlacementMatrix(m.placement, matrices, i * 16));
    return { shape, ids: ms.map(memberFullId), roles: ms.map((m) => m.role), matrices };
  });
}

// Meshes ----------------------------------------------------------------------------------------

/** The 12-triangle box of a member with no cuts, computed in TypeScript (no geometry library). */
export function boxMesh(length: number, width: number, depth: number): MemberMeshData {
  const L = length;
  const W = width;
  const D = depth;
  // Per face a corner and two edges whose cross product points out of the box.
  const faces: [MemberVec3, MemberVec3, MemberVec3][] = [
    [
      [L, 0, 0],
      [0, W, 0],
      [0, 0, D],
    ],
    [
      [0, 0, 0],
      [0, 0, D],
      [0, W, 0],
    ],
    [
      [0, W, 0],
      [0, 0, D],
      [L, 0, 0],
    ],
    [
      [0, 0, 0],
      [L, 0, 0],
      [0, 0, D],
    ],
    [
      [0, 0, D],
      [L, 0, 0],
      [0, W, 0],
    ],
    [
      [0, 0, 0],
      [0, W, 0],
      [L, 0, 0],
    ],
  ];
  const positions = new Float32Array(72);
  const normals = new Float32Array(72);
  const indices = new Uint32Array(36);
  faces.forEach(([o, u, v], f) => {
    const n = normalize(cross(u, v));
    const corners = [o, add(o, u), add(add(o, u), v), add(o, v)];
    corners.forEach((c, i) => {
      positions.set(c, (f * 4 + i) * 3);
      normals.set(n, (f * 4 + i) * 3);
    });
    const b = f * 4;
    indices.set([b, b + 1, b + 2, b, b + 2, b + 3], f * 6);
  });
  return { positions, normals, indices };
}

/** Loads the Manifold module (one per regen worker). */
export type ManifoldLoader = () => Promise<ManifoldToplevel>;

/**
 * The default loader: `manifold-3d`'s own glue, which finds `manifold.wasm` next to itself (in
 * Node by path; in the browser as its own asset, emitted by the bundler from the glue's
 * `new URL('manifold.wasm', import.meta.url)`). Imported dynamically, so a document with no cut
 * members never loads it.
 */
export const loadManifold: ManifoldLoader = async () => {
  const { default: Module } = await import('manifold-3d/manifold');
  const wasm = await Module();
  wasm.setup();
  return wasm;
};

/** Counts of Manifold objects made and deleted, for tests and the stats. */
export interface ManifoldCounter {
  created: number;
  deleted: number;
}

/**
 * A member's mesh through Manifold: its box, `trimByPlane` per plane cut, minus each notch's
 * wedge. Every object, intermediates included, is deleted in a `finally` right after `getMesh`
 * (Manifold's destructors free memory; T6.5a measured a flat heap over 22,560 objects).
 */
export function manifoldMesh(
  wasm: ManifoldToplevel,
  m: Pick<MemberData, 'length' | 'stock' | 'cuts'>,
  count?: ManifoldCounter,
): MemberMeshData {
  const made: Manifold[] = [];
  const keep = (x: Manifold): Manifold => {
    made.push(x);
    if (count) count.created++;
    return x;
  };
  try {
    const box = keep(wasm.Manifold.cube([m.length, m.stock.width, m.stock.depth]));
    let body = box;
    for (const c of m.cuts) {
      // trimByPlane keeps dot(n, p) >= offset; a cut removes dot(n, p) >= k.
      if (c.kind === 'plane') body = keep(body.trimByPlane([-c.n[0], -c.n[1], -c.n[2]], -c.k));
    }
    for (const c of m.cuts) {
      if (c.kind !== 'notch') continue;
      const wedge = keep(keep(box.trimByPlane(v3(c.a.n), c.a.k)).trimByPlane(v3(c.b.n), c.b.k));
      body = keep(body.subtract(wedge));
    }
    const mesh = body.getMesh();
    return flatMesh(mesh.vertProperties, mesh.numProp, mesh.triVerts);
  } finally {
    for (const x of made) {
      x.delete();
      if (count) count.deleted++;
    }
  }
}

/** A flat-shaded copy of an indexed mesh: three vertices and one normal per triangle. */
export function flatMesh(props: Float32Array, numProp: number, tri: Uint32Array): MemberMeshData {
  const n = tri.length;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const indices = new Uint32Array(n);
  for (let t = 0; t < n; t += 3) {
    const at = (i: number): MemberVec3 => {
      const s = tri[t + i]! * numProp;
      return [props[s]!, props[s + 1]!, props[s + 2]!];
    };
    const a = at(0);
    const b = at(1);
    const c = at(2);
    const u: MemberVec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v: MemberVec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const raw = cross(u, v);
    const len = Math.hypot(raw[0], raw[1], raw[2]) || 1;
    const normal = scale(raw, 1 / len);
    [a, b, c].forEach((p, i) => {
      positions.set(p, (t + i) * 3);
      normals.set(normal, (t + i) * 3);
      indices[t + i] = t + i;
    });
  }
  return { positions, normals, indices };
}

/** The volume a closed mesh encloses (mm3), by the divergence theorem. */
export function meshVolume(mesh: MemberMeshData): number {
  const p = mesh.positions;
  const ix = mesh.indices;
  let six = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t]! * 3;
    const b = ix[t + 1]! * 3;
    const c = ix[t + 2]! * 3;
    six +=
      p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) -
      p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) +
      p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!);
  }
  return six / 6;
}

/**
 * The regen worker's one mesh cache (T6.5a recommendation 3): a mesh per distinct shape key,
 * shared by every group and kept across regens, pruned to the keys the last completed regen used.
 * Kernel recycles do not touch it: nothing in it is a kernel object.
 */
export class MemberMeshCache {
  readonly #meshes = new Map<string, MemberMeshData>();
  readonly #loader: ManifoldLoader;
  #manifold: Promise<ManifoldToplevel> | null = null;
  /** Manifold objects made and deleted so far. */
  readonly manifoldObjects: ManifoldCounter = { created: 0, deleted: 0 };
  /** Meshes made so far (boxes and cut members). */
  made = 0;

  constructor(loader: ManifoldLoader = loadManifold) {
    this.#loader = loader;
  }

  get size(): number {
    return this.#meshes.size;
  }

  /** Whether the Manifold module has been asked for. */
  get manifoldRequested(): boolean {
    return this.#manifold !== null;
  }

  get(key: string): MemberMeshData | undefined {
    return this.#meshes.get(key);
  }

  /**
   * Mesh every shape of `members` the cache lacks. Resolves to an error message per member shape
   * that could not be meshed (Manifold did not load, or the cuts left nothing).
   */
  async ensure(members: readonly MemberData[]): Promise<Map<string, string>> {
    const failed = new Map<string, string>();
    const cut: [string, MemberData][] = [];
    for (const m of members) {
      const key = memberShapeKey(m);
      if (this.#meshes.has(key)) continue;
      if (m.cuts.length === 0) {
        this.#meshes.set(key, boxMesh(m.length, m.stock.width, m.stock.depth));
        this.made++;
      } else if (!cut.some(([k]) => k === key)) {
        cut.push([key, m]);
      }
    }
    if (cut.length === 0) return failed;
    let wasm: ManifoldToplevel;
    try {
      this.#manifold ??= this.#loader();
      wasm = await this.#manifold;
    } catch (error) {
      // Asked again on the next regen that needs it.
      this.#manifold = null;
      const why = error instanceof Error ? error.message : String(error);
      for (const [key] of cut) failed.set(key, `Manifold did not load: ${why}`);
      return failed;
    }
    for (const [key, m] of cut) {
      try {
        const mesh = manifoldMesh(wasm, m, this.manifoldObjects);
        if (mesh.indices.length === 0) {
          failed.set(key, 'its cuts leave nothing of it');
          continue;
        }
        this.#meshes.set(key, mesh);
        this.made++;
      } catch (error) {
        failed.set(key, error instanceof Error ? error.message : String(error));
      }
    }
    return failed;
  }

  /** Keep only `keys`; returns the keys dropped. */
  retain(keys: ReadonlySet<string>): string[] {
    const dropped: string[] = [];
    for (const key of this.#meshes.keys()) {
      if (!keys.has(key)) {
        this.#meshes.delete(key);
        dropped.push(key);
      }
    }
    return dropped;
  }

  clear(): void {
    this.#meshes.clear();
  }
}

// Checking what a stage returns -----------------------------------------------------------------

const MEMBER_ERROR = (namespace: string, step: string, why: string): RegenError => ({
  code: 'extension',
  message: `The "${namespace}" member ${step} failed: ${why}`,
});

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function vec3Of(v: unknown, what: string): MemberVec3 {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(isFiniteNumber)) {
    throw new TypeError(`${what} is not three finite numbers`);
  }
  const [x, y, z] = v as [number, number, number];
  return [x, y, z];
}

const TOLERANCE = 1e-6;

function unitOf(v: unknown, what: string): MemberVec3 {
  const u = vec3Of(v, what);
  if (Math.abs(Math.hypot(u[0], u[1], u[2]) - 1) > TOLERANCE) {
    throw new TypeError(`${what} is not a unit vector`);
  }
  return u;
}

function planeOf(v: unknown, what: string): MemberPlane {
  const p = v as { n?: unknown; k?: unknown } | null;
  if (typeof p !== 'object' || p === null || !isFiniteNumber(p.k)) {
    throw new TypeError(`${what} is not a plane`);
  }
  return { n: unitOf(p.n, `${what}.n`), k: p.k };
}

/** One member checked and copied out as plain data; throws with what is wrong. */
function memberOf(raw: unknown, i: number, owners: ReadonlySet<string>): MemberData {
  const at = `member ${i}`;
  if (typeof raw !== 'object' || raw === null) throw new TypeError(`${at} is not an object`);
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || m.id === '') throw new TypeError(`${at} has no id`);
  const name = `member ${JSON.stringify(m.id)}`;
  if (typeof m.owner !== 'string' || !owners.has(m.owner)) {
    throw new TypeError(
      `${name} is owned by ${JSON.stringify(m.owner)}, not a feature of its group`,
    );
  }
  if (typeof m.role !== 'string') throw new TypeError(`${name} has no role`);
  const s = m.stock as Record<string, unknown> | null;
  if (
    typeof s !== 'object' ||
    s === null ||
    typeof s.id !== 'string' ||
    typeof s.name !== 'string' ||
    !isFiniteNumber(s.width) ||
    !isFiniteNumber(s.depth) ||
    s.width <= 0 ||
    s.depth <= 0
  ) {
    throw new TypeError(`${name} has no well-formed stock (id, name, width and depth over 0)`);
  }
  if (!isFiniteNumber(m.length) || m.length <= 0) {
    throw new TypeError(`${name} has a length that is not a number over 0`);
  }
  const p = m.placement as Record<string, unknown> | null;
  if (typeof p !== 'object' || p === null) throw new TypeError(`${name} has no placement`);
  const placement: MemberPlacement = {
    origin: vec3Of(p.origin, `${name} placement.origin`),
    x: unitOf(p.x, `${name} placement.x`),
    y: unitOf(p.y, `${name} placement.y`),
  };
  if (Math.abs(dot(placement.x, placement.y)) > TOLERANCE) {
    throw new TypeError(`${name} placement axes are not perpendicular`);
  }
  if (!Array.isArray(m.cuts)) throw new TypeError(`${name} has no list of cuts`);
  const cuts: MemberCut[] = m.cuts.map((c: unknown, j: number) => {
    const cut = c as Record<string, unknown> | null;
    const where = `${name} cut ${j}`;
    if (typeof cut !== 'object' || cut === null) throw new TypeError(`${where} is not an object`);
    if (cut.kind === 'plane') {
      const plane = planeOf(cut, where);
      return { kind: 'plane', n: plane.n, k: plane.k };
    }
    if (cut.kind === 'notch') {
      return { kind: 'notch', a: planeOf(cut.a, `${where}.a`), b: planeOf(cut.b, `${where}.b`) };
    }
    throw new TypeError(`${where} has the unknown kind ${JSON.stringify(cut.kind)}`);
  });
  return {
    id: m.id,
    owner: m.owner,
    role: m.role,
    stock: { id: s.id, name: s.name, width: s.width, depth: s.depth },
    length: m.length,
    placement,
    cuts,
  };
}

/** A group's output checked and copied out, frozen; or the errors for its features. */
export type CheckedMembers =
  | { ok: true; members: MemberData[]; warnings: MemberWarning[]; metadata?: JsonValue }
  | { ok: false; error: RegenError };

/**
 * What `frame` returned, checked: members well formed (unit, perpendicular placement axes; unit
 * cut normals; positive sizes), owned by a feature of the group, full ids unique; warnings on the
 * group's features. A failure value is an `invalid` error, anything malformed an `extension` one.
 */
export function checkMembers(namespace: string, group: MemberGroup, out: unknown): CheckedMembers {
  try {
    if (typeof out === 'object' && out !== null && 'error' in out) {
      const f = out as ExtensionFailure;
      return {
        ok: false,
        error: {
          code: 'invalid',
          message: typeof f.error === 'string' ? f.error : 'The group cannot be framed',
        },
      };
    }
    const o = out as { members?: unknown; warnings?: unknown; metadata?: unknown } | null;
    if (typeof o !== 'object' || o === null || !Array.isArray(o.members)) {
      throw new TypeError('expected { members } or { error }');
    }
    const owners = new Set(group.features);
    const seen = new Set<string>();
    const members = o.members.map((raw: unknown, i: number) => {
      const m = memberOf(raw, i, owners);
      const full = memberFullId(m);
      if (seen.has(full)) throw new TypeError(`two members are ${full}`);
      seen.add(full);
      return m;
    });
    const warnings: MemberWarning[] = [];
    if (o.warnings !== undefined) {
      if (!Array.isArray(o.warnings)) throw new TypeError('warnings is not a list');
      for (const [i, raw] of o.warnings.entries()) {
        const w = raw as Record<string, unknown> | null;
        if (
          typeof w !== 'object' ||
          w === null ||
          typeof w.feature !== 'string' ||
          !owners.has(w.feature) ||
          typeof w.message !== 'string'
        ) {
          throw new TypeError(`warning ${i} has no message on a feature of its group`);
        }
        const warning: MemberWarning = { feature: w.feature, message: w.message };
        if (typeof w.code === 'string') warning.code = w.code;
        if (typeof w.member === 'string') warning.member = w.member;
        warnings.push(warning);
      }
    }
    // Plain data only: hashed nowhere, but it crosses the worker boundary.
    const metadata = o.metadata as JsonValue | undefined;
    if (metadata !== undefined) stableStringify(metadata);
    const frozen = deepFreeze(
      metadata === undefined
        ? { members, warnings }
        : { members, warnings, metadata: structuredClone(metadata) },
    );
    return { ok: true, ...frozen };
  } catch (error) {
    return {
      ok: false,
      error: MEMBER_ERROR(
        namespace,
        `result check of group ${group.id}`,
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}

/** What `groups` returned, checked: unique ids, features among those given, at least one each. */
export function checkGroups(
  namespace: string,
  out: unknown,
  given: ReadonlySet<string>,
): { ok: true; groups: MemberGroup[] } | { ok: false; error: RegenError } {
  try {
    if (!Array.isArray(out)) throw new TypeError('expected a list of groups');
    const ids = new Set<string>();
    const groups = out.map((raw: unknown, i: number): MemberGroup => {
      const g = raw as { id?: unknown; features?: unknown } | null;
      if (typeof g !== 'object' || g === null || typeof g.id !== 'string' || g.id === '') {
        throw new TypeError(`group ${i} has no id`);
      }
      if (ids.has(g.id)) throw new TypeError(`two groups are ${g.id}`);
      ids.add(g.id);
      const features = g.features;
      if (
        !Array.isArray(features) ||
        features.length === 0 ||
        !features.every((f) => typeof f === 'string' && given.has(f))
      ) {
        throw new TypeError(`group ${g.id} does not list built features of the domain`);
      }
      return { id: g.id, features: [...(features as string[])] };
    });
    return { ok: true, groups };
  } catch (error) {
    return {
      ok: false,
      error: MEMBER_ERROR(
        namespace,
        'grouping',
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}

function deepFreeze<T>(value: T): T {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v !== 'object' || v === null || Object.isFrozen(v)) continue;
    Object.freeze(v);
    for (const x of Object.values(v)) stack.push(x);
  }
  return value;
}

// The per-group cache ---------------------------------------------------------------------------

/**
 * Bump with any change to how regen frames, checks or keys member sets, so sets made by older
 * code are never served (ADR 0004 decision 8).
 */
export const MEMBER_STAGE_VERSION = 1;

/** A group's framing, as cached: plain data, valid whatever the kernel instance. */
export interface FramedGroup {
  key: string;
  namespace: string;
  group: MemberGroup;
  result: CheckedMembers;
}

/** The key of a group (ADR 0015 decision 5): its features' metadata, the data, the versions. */
export function memberGroupKey(parts: {
  namespace: string;
  implementation: number;
  regen: number;
  group: MemberGroup;
  features: readonly MemberFeature[];
  data: Readonly<Record<string, unknown>>;
}): string {
  return hashValue({ ...parts, stage: MEMBER_STAGE_VERSION });
}

/** Framed groups by key, kept for the keys the last completed regen used. */
export class MemberGroupCache {
  readonly #entries = new Map<string, FramedGroup>();

  get(key: string): FramedGroup | undefined {
    return this.#entries.get(key);
  }

  set(entry: FramedGroup): void {
    this.#entries.set(entry.key, entry);
  }

  get size(): number {
    return this.#entries.size;
  }

  retain(keys: ReadonlySet<string>): void {
    for (const key of this.#entries.keys()) if (!keys.has(key)) this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }
}

// On-demand B-reps ------------------------------------------------------------------------------

/** Any unit vector perpendicular to `n`. */
function perpendicular(n: MemberVec3): MemberVec3 {
  const a: MemberVec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return normalize(cross(n, a));
}

/** A box tool filling the half-space `dot(n, p) >= k` around `near`. */
function halfSpaceTool(
  id: string,
  body: string,
  p: MemberPlane,
  size: number,
  near: MemberVec3,
): ToolItem {
  const x = perpendicular(p.n);
  const y = cross(p.n, x);
  const on = add(near, scale(p.n, p.k - dot(p.n, near)));
  const origin = add(on, add(scale(x, -size / 2), scale(y, -size / 2)));
  return {
    id,
    body,
    mode: 'subtract',
    primitive: {
      type: 'box',
      frame: { origin: v3(origin), xDir: v3(x), normal: v3(p.n) },
      size: [size, size, size],
    },
  };
}

/** A box tool filling the corner of two perpendicular half-spaces, around `near`. */
function cornerTool(
  id: string,
  body: string,
  a: MemberPlane,
  b: MemberPlane,
  size: number,
  near: MemberVec3,
): ToolItem {
  if (Math.abs(dot(a.n, b.n)) > TOLERANCE) {
    throw new TypeError('its notch planes are not perpendicular, which a B-rep notch needs');
  }
  const y = cross(a.n, b.n);
  // The point of the planes' common line nearest `near`.
  const line = add(scale(a.n, a.k), scale(b.n, b.k));
  const origin = add(add(line, scale(y, dot(y, near) - dot(y, line))), scale(y, -size / 2));
  return {
    id,
    body,
    mode: 'subtract',
    primitive: {
      type: 'box',
      frame: { origin: v3(origin), xDir: v3(b.n), normal: v3(a.n) },
      size: [size, size, size],
    },
  };
}

/**
 * The kernel feature inputs of a member's B-rep (on request only, never in a regen): its
 * cross-section extruded along its length as body `extrude#<n>`, then one `tools` feature with a
 * box per cut (a plane cut a large box on the removed side; a notch, whose planes must be
 * perpendicular, one box in their corner). Throws when a notch cannot be built.
 */
export function memberFeatureInputs(m: MemberData, n: number): FeatureInput[] {
  const p = m.placement;
  const w = m.stock.width;
  const d = m.stock.depth;
  const id = `extrude#${n}`;
  const extrude: FeatureInput = {
    kind: 'extrude',
    id,
    profile: {
      frame: { origin: v3(p.origin), xDir: v3(p.y), normal: v3(p.x) },
      loops: [
        {
          entities: [
            { kind: 'line', id: 'e1', start: [0, 0], end: [w, 0] },
            { kind: 'line', id: 'e2', start: [w, 0], end: [w, d] },
            { kind: 'line', id: 'e3', start: [w, d], end: [0, d] },
            { kind: 'line', id: 'e4', start: [0, d], end: [0, 0] },
          ],
        },
      ],
    },
    extent: { type: 'blind', distance: m.length },
    mode: 'new',
  };
  if (m.cuts.length === 0) return [extrude];
  const size = 2 * (m.length + w + d) + 500;
  const items = m.cuts.map((c, i) =>
    c.kind === 'plane'
      ? halfSpaceTool(`c${i + 1}`, id, worldPlane(p, c), size, p.origin)
      : cornerTool(`c${i + 1}`, id, worldPlane(p, c.a), worldPlane(p, c.b), size, p.origin),
  );
  return [extrude, { kind: 'tools', id: `tools#${n}`, items }];
}
