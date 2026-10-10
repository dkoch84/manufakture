// The read queries behind the MCP read tools (ADR 0016 decision 6): `tree`, `object`,
// `findGeometry`, `measure`, `quantities` and `errors`. Everything returned is plain JSON data:
// text from the document (names, notes, labels) travels only inside data fields (decision 13).
// Lengths are millimetres, areas mm², volumes mm³, masses grams, angles degrees.

import {
  findMaterial,
  massGrams,
  parseName,
  type ManufaktureDocument,
  type Part,
} from '@manufakture/core';
import {
  constructionTakeoff,
  documentConstruction,
  memberListing,
  takeoffModel,
  type ConstructionTakeoff,
  type ConstructionTakeoffInput,
  type MemberListing,
} from '@manufakture/domain-construction';
import { documentCutList, type CutList } from '@manufakture/domain-wood';
import type {
  BodyMeasure,
  MeasureOpTarget,
  MeasureResult,
  MeasureTarget,
  Placement,
  ShapeId,
  Vec3,
} from '@manufakture/kernel';
import {
  MAX_SWEEP_VALUES,
  connectorFrames,
  evaluateVariables,
  namedCoordinates,
  posedMates,
  posesDiffer,
  resultSolverInput,
  sweepPoses,
  sweepValues,
  type InstanceResult,
  type RegenResult,
} from '@manufakture/regen';
import { documentStock } from '@manufakture/stock';
import type { EngineApi } from './engine';
import { done, sessionError, type SessionResult } from './errors';
import type { References } from './imports';
import type { ModelState, NamedEdge, NamedFace } from './model';

export interface QueryContext {
  document: ManufaktureDocument;
  model: ModelState;
  api: EngineApi;
  /** The generation of the last regen: kernel batches at it are never stale. */
  generation: number;
  references: References;
  /**
   * The time budget of one kernel call, ms (`SessionLimits.kernelMsPerCall`): a read made of many
   * calls (a sweep over a mate's travel) stops past it and answers what it checked.
   */
  kernelMsPerCall?: number;
}

const DEG = 180 / Math.PI;
/** Most results `findGeometry` returns. */
export const MAX_GEOMETRY_RESULTS = 200;
/** Most targets or bodies one `measure` call takes. */
export const MAX_MEASURE_ITEMS = 64;

const isString = (v: unknown): v is string => typeof v === 'string' && v.length <= 512;
const isVec3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

// ---------------------------------------------------------------------------------------------
// Tree

export interface TreeFeature {
  id: string;
  kind: string;
  name: string;
  suppressed: boolean;
  status: string | null;
  errors: number;
  warnings: number;
}

export interface TreeBody {
  bodyId: string;
  creator: string;
  name: string | null;
  solids: number;
  material: string | null;
}

/** The outline of the document and its last regen. */
export function tree(document: ManufaktureDocument, result: RegenResult | null) {
  // A variable measuring the model (`distance(...)`) reads what the last regen measured.
  const values = evaluateVariables(document.variables, result?.measurements);
  const parts = document.parts.map((part) => {
    const built = result?.parts.find((p) => p.partId === part.id);
    const status = new Map(built?.features.map((f) => [f.featureId, f]) ?? []);
    return {
      id: part.id,
      name: part.name,
      material: part.material ?? null,
      rollbackIndex: part.rollbackIndex,
      features: part.features.map((f): TreeFeature => {
        const r = status.get(f.id);
        return {
          id: f.id,
          kind: f.kind === 'extension' ? `extension:${f.extension}` : f.kind,
          name: f.name,
          suppressed: f.suppressed,
          status: r?.status ?? null,
          errors: r?.errors.length ?? 0,
          warnings: r?.warnings.length ?? 0,
        };
      }),
      bodies: (built?.bodies ?? []).map((b): TreeBody => ({
        bodyId: b.bodyId,
        creator: b.creator,
        name: part.bodies.find((x) => x.id === b.bodyId)?.name ?? b.inherited?.name ?? null,
        solids: b.solids,
        material: bodyMaterial(part, b.bodyId, b.inherited?.material) ?? null,
      })),
      memberSets: (built?.members ?? []).map((s) => ({
        group: s.group,
        namespace: s.namespace,
        count: s.count,
      })),
    };
  });
  return {
    id: document.id,
    name: document.name,
    units: document.units,
    variables: document.variables.map((v) => {
      const q = values.values.get(v.name);
      const error = values.errors.get(v.name);
      return {
        name: v.name,
        expression: v.expression.source,
        value: q === undefined ? null : wireValue(q.value, q.dimension),
        ...(error === undefined ? {} : { error: error.message }),
      };
    }),
    parts,
    assemblies: document.assemblies.map((a) => {
      const solved = result?.assemblies.find((r) => r.assemblyId === a.id);
      return {
        id: a.id,
        name: a.name,
        dof: solved?.dof ?? null,
        instances: a.instances.map((i) => ({
          id: i.id,
          name: i.name,
          source: 'part' in i.source ? { part: i.source.part } : { pinned: true },
          fixed: i.fixed,
          suppressed: i.suppressed,
          ...solvedInstance(solved?.instances.find((x) => x.instanceId === i.id)),
        })),
        mates: a.mates.map((m) => {
          const r = solved?.mates.find((x) => x.mateId === m.id);
          return {
            id: m.id,
            name: m.name,
            kind: m.kind,
            suppressed: m.suppressed,
            status: r?.status ?? null,
            // The solved coordinates (a slider's distance, a revolute's angle): after any clamp.
            coordinates: namedCoordinates(m.kind, r?.coordinates ?? []).map((c) => ({
              name: c.name,
              value: c.angular ? c.value * DEG : c.value,
              unit: c.angular ? 'deg' : 'mm',
            })),
            warnings: r?.warnings.length ?? 0,
          };
        }),
      };
    }),
    configurations:
      document.configurations === undefined
        ? null
        : {
            active: document.configurations.active,
            parameters: document.configurations.parameters.map((p) => ({
              id: p.id,
              name: p.name,
              kind: p.kind,
            })),
            rows: document.configurations.rows.map((r) => ({ id: r.id, name: r.name })),
          },
    drawings: (document.drawings ?? []).map((d) => ({
      id: d.id,
      name: d.name,
      sheets: d.sheets.length,
    })),
    camSetups: document.cam.setups.map((s) => ({
      id: s.id,
      name: s.name,
      part: s.part,
      operations: s.operations.length,
    })),
    domains: Object.entries(document.domains ?? {}).map(([namespace, entry]) => ({
      namespace,
      bytes: JSON.stringify(entry).length,
    })),
  };
}

/**
 * An instance's solved state: its status, the solved pose (instance coordinates to world, mm and
 * a unit quaternion [x, y, z, w]) and whether that differs from the stored pose (a mate moved it,
 * or a limit clamped it). Nulls before a regen.
 */
function solvedInstance(r: InstanceResult | undefined) {
  return {
    status: r?.status ?? null,
    transform: r === undefined ? null : r.transform,
    moved: r?.moved ?? null,
  };
}

/** A value in wire units: lengths mm, angles degrees, anything else as it is. */
function wireValue(value: number, dimension: { length: number; angle: number }) {
  if (dimension.length === 0 && dimension.angle === 1) return { value: value * DEG, unit: 'deg' };
  if (dimension.length === 1 && dimension.angle === 0) return { value, unit: 'mm' };
  if (dimension.length === 0 && dimension.angle === 0) return { value, unit: '' };
  return { value, dimension };
}

function bodyMaterial(part: Part, bodyId: string, inherited?: string): string | undefined {
  return part.bodies.find((b) => b.id === bodyId)?.material ?? inherited ?? part.material;
}

// ---------------------------------------------------------------------------------------------
// Objects

export type ObjectQuery =
  | { kind: 'document' }
  | { kind: 'part'; partId: string }
  | { kind: 'feature'; partId: string; featureId: string }
  | { kind: 'variable'; name: string }
  | { kind: 'assembly'; assemblyId: string }
  | { kind: 'instance'; assemblyId: string; instanceId: string }
  | { kind: 'mate'; assemblyId: string; mateId: string }
  | { kind: 'camSetup'; setupId: string }
  | { kind: 'drawing'; drawingId: string }
  | { kind: 'configurations' }
  | { kind: 'domain'; namespace: string }
  | { kind: 'script'; scriptId: string };

/** The full JSON of one item of the document. */
export function objectOf(document: ManufaktureDocument, query: unknown): SessionResult<unknown> {
  const q = (query ?? {}) as Record<string, unknown>;
  const missing = () => sessionError('not-found', `There is no such ${String(q.kind)}.`);
  const field = (name: string): string | null => (isString(q[name]) ? (q[name] as string) : null);
  switch (q.kind) {
    case 'document': {
      // Without the bulky parts: ask for each part, assembly, drawing, ... on its own.
      const { parts, assemblies, drawings, cam, ...rest } = document;
      return done({
        ...rest,
        parts: parts.map((p) => p.id),
        assemblies: assemblies.map((a) => a.id),
        drawings: (drawings ?? []).map((d) => d.id),
        cam: { setups: cam.setups.map((s) => s.id), tools: cam.tools.length },
      });
    }
    case 'part': {
      const part = document.parts.find((p) => p.id === field('partId'));
      return part ? done(part) : missing();
    }
    case 'feature': {
      const part = document.parts.find((p) => p.id === field('partId'));
      const f = part?.features.find((x) => x.id === field('featureId'));
      return f ? done(f) : missing();
    }
    case 'variable': {
      const v = document.variables.find((x) => x.name === field('name'));
      return v ? done(v) : missing();
    }
    case 'assembly': {
      const a = document.assemblies.find((x) => x.id === field('assemblyId'));
      return a ? done(a) : missing();
    }
    case 'instance': {
      const a = document.assemblies.find((x) => x.id === field('assemblyId'));
      const i = a?.instances.find((x) => x.id === field('instanceId'));
      return i ? done(i) : missing();
    }
    case 'mate': {
      const a = document.assemblies.find((x) => x.id === field('assemblyId'));
      const m = a?.mates.find((x) => x.id === field('mateId'));
      return m ? done(m) : missing();
    }
    case 'camSetup': {
      const s = document.cam.setups.find((x) => x.id === field('setupId'));
      return s ? done(s) : missing();
    }
    case 'drawing': {
      const d = (document.drawings ?? []).find((x) => x.id === field('drawingId'));
      return d ? done(d) : missing();
    }
    case 'configurations':
      return document.configurations ? done(document.configurations) : missing();
    case 'domain': {
      const ns = field('namespace');
      const domains = document.domains ?? {};
      return ns !== null && Object.hasOwn(domains, ns) ? done(domains[ns]) : missing();
    }
    case 'script': {
      const s = (document.scripts ?? []).find((x) => x.id === field('scriptId'));
      return s ? done(s) : missing();
    }
    default:
      return sessionError(
        'invalid-input',
        'Ask for a document, part, feature, variable, assembly, instance, mate, camSetup, drawing, configurations, domain or script.',
      );
  }
}

/** A mate's connector frames as the last regen resolved them (`connectorFrames`). */
export type MateFrames = NonNullable<ReturnType<typeof connectorFrames>>;

/**
 * Where a mate's connectors resolved in the last regen: each one's origin and unit axes in world
 * coordinates (mm) at the solved poses, after flip, rotate and offset, and the axis of connector
 * a's frame each free coordinate runs along. What a connector offset is worked out against,
 * without trial regens. Null before a regen has the mate; undefined for any other query (the
 * query itself is `objectOf`'s to check).
 */
export function mateFramesOf(
  document: ManufaktureDocument,
  result: RegenResult | null,
  query: unknown,
): MateFrames | null | undefined {
  const q = (query ?? {}) as Record<string, unknown>;
  if (q.kind !== 'mate') return undefined;
  const a = document.assemblies.find((x) => x.id === q.assemblyId);
  const m = a?.mates.find((x) => x.id === q.mateId);
  if (a === undefined || m === undefined) return undefined;
  const solved = result?.assemblies.find((r) => r.assemblyId === a.id);
  return (solved && connectorFrames(solved, m.id, m.kind)) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Members

/** Most members one `membersOf` answer lists; past it, `omitted` counts the rest. */
export const MAX_MEMBER_RESULTS = 500;

export interface MembersQuery {
  kind: 'members';
  partId: string;
  /** A construction wall, opening, floor or roof: the feature that owns the members. */
  owner: string;
}

/** `memberListing` with the members past `MAX_MEMBER_RESULTS` left out and counted. */
export type MembersAnswer = MemberListing & { omitted: number };

/**
 * The framing members a feature owns in the last regen, and the status of each override its
 * params hold (`memberListing`): what an agent reads instead of the takeoff's row sources.
 */
export function membersOf(
  document: ManufaktureDocument,
  model: ModelState,
  query: unknown,
): SessionResult<MembersAnswer> {
  const q = (query ?? {}) as Record<string, unknown>;
  if (!isString(q.partId) || !isString(q.owner)) {
    return sessionError('invalid-input', 'Give the partId and the owner feature id.');
  }
  const part = document.parts.find((p) => p.id === q.partId);
  if (part === undefined) return sessionError('not-found', 'There is no such part.');
  if (!part.features.some((f) => f.id === q.owner)) {
    return sessionError('not-found', 'The part has no such feature.');
  }
  const built = model.last?.parts.find((p) => p.partId === part.id);
  if (built === undefined) return sessionError('not-found', 'The part has not been regenerated.');
  const listing = memberListing({
    owner: q.owner,
    features: built.features,
    sets: model.sets(part.id).filter((s) => s.namespace === 'construction'),
  });
  if (listing === undefined) {
    return sessionError(
      'invalid-input',
      'That feature owns no framing members: ask for a built construction wall, opening, floor or roof.',
    );
  }
  const omitted = Math.max(0, listing.members.length - MAX_MEMBER_RESULTS);
  return done({
    ...listing,
    members: omitted === 0 ? listing.members : listing.members.slice(0, MAX_MEMBER_RESULTS),
    omitted,
  });
}

// ---------------------------------------------------------------------------------------------
// Geometry

export interface GeometryQuery {
  /** Faces, edges or both (default both). */
  kind?: 'face' | 'edge';
  /** Only this part's bodies. */
  partId?: string;
  /** Only this body. */
  bodyId?: string;
  /** A name exactly (`extrude#1:side:e3`). */
  name?: string;
  /** Faces and edges born by this feature (their name starts with it). */
  bornBy?: string;
  /** Planar faces whose outward normal is within `angleTolerance` degrees of this. */
  normal?: Vec3;
  /** Cylindrical faces (and circular edges) of this radius, within `tolerance` mm. */
  radius?: number;
  /**
   * Cylindrical faces coaxial with the named cylindrical face (itself included): their axis lines
   * coincide, within `tolerance` mm between the lines and `angleTolerance` degrees between the
   * directions (either sign). Looked up in each part searched, on any of its bodies.
   */
  coaxialWith?: string;
  /** Sorted by distance from this point (a face's centroid, an edge's midpoint). */
  nearest?: Vec3;
  /** mm, default 0.01. */
  tolerance?: number;
  /** Degrees, default 0.5. */
  angleTolerance?: number;
  /** Default 50, at most `MAX_GEOMETRY_RESULTS`. */
  limit?: number;
}

export interface GeometryHit {
  partId: string;
  bodyId: string;
  kind: 'face' | 'edge';
  /** The persistent name to store in a reference, or null when the item has none. */
  name: string | null;
  /** The name is positional and may move to another face on an edit. */
  fragile: boolean;
  /** 1-based index on the body: valid for this regen only. */
  index: number;
  surface?: string;
  curve?: string;
  area?: number;
  length?: number;
  centroid?: Vec3;
  midpoint?: Vec3;
  normal?: Vec3 | null;
  axis?: Vec3 | null;
  radius?: number | null;
  /** Cylinders: a point on the axis, so that coaxial faces can be told from parallel ones. */
  axisOrigin?: Vec3 | null;
  /** Cylinders: true for a hole (material outside), false for a boss or pin. */
  hole?: boolean | null;
  /** Edges: the 1-based indices of the faces it bounds. */
  faces?: number[];
  /** Distance from `nearest`, when asked. */
  distance?: number;
}

function checkGeometryQuery(q: Record<string, unknown>): string | null {
  for (const key of ['partId', 'bodyId', 'name', 'bornBy', 'coaxialWith']) {
    if (q[key] !== undefined && !isString(q[key])) return `${key} must be a string.`;
  }
  if (q.kind !== undefined && q.kind !== 'face' && q.kind !== 'edge') {
    return 'kind is face or edge.';
  }
  for (const key of ['normal', 'nearest']) {
    if (q[key] !== undefined && !isVec3(q[key])) return `${key} must be three numbers.`;
  }
  for (const key of ['radius', 'tolerance', 'angleTolerance', 'limit']) {
    const v = q[key];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
      return `${key} must be a number of at least 0.`;
    }
  }
  return null;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** A cylinder's axis line: a point on it and its unit direction. */
interface AxisLine {
  origin: Vec3;
  direction: Vec3;
}

function axisLine(f: NamedFace): AxisLine | null {
  return f.axis !== null && f.axisOrigin !== undefined && f.axisOrigin !== null
    ? { origin: f.axisOrigin, direction: f.axis }
    : null;
}

/** Distance of `p` from the line through `l.origin` along the unit `l.direction`. */
function lineDistance(p: Vec3, l: AxisLine): number {
  const d: Vec3 = [p[0] - l.origin[0], p[1] - l.origin[1], p[2] - l.origin[2]];
  const t = dot(d, l.direction);
  return Math.hypot(
    d[0] - t * l.direction[0],
    d[1] - t * l.direction[1],
    d[2] - t * l.direction[2],
  );
}

/**
 * The axis lines coincide: the directions agree in either sign within `cosTol`, and each origin
 * lies within `tol` of the other line (both ways, so a slight tilt cannot hide behind a near point).
 */
function coaxial(a: AxisLine, b: AxisLine, tol: number, cosTol: number): boolean {
  return (
    Math.abs(dot(a.direction, b.direction)) >= cosTol &&
    lineDistance(a.origin, b) <= tol &&
    lineDistance(b.origin, a) <= tol
  );
}

function bornBy(name: string | null, featureId: string): boolean {
  if (name === null) return false;
  const first = parseName(name)[0];
  return first?.kind === 'feature' && first.id === featureId;
}

/** Faces and edges of the last regen's bodies by name or query, with their geometry. */
export function findGeometry(ctx: QueryContext, query: unknown): SessionResult<GeometryHit[]> {
  const q = (query ?? {}) as Record<string, unknown>;
  const problem = checkGeometryQuery(q);
  if (problem !== null) return sessionError('invalid-input', problem);
  const g = q as GeometryQuery;
  const result = ctx.model.last;
  if (result === null) return done([]);
  const tol = g.tolerance ?? 0.01;
  const cosTol = Math.cos((g.angleTolerance ?? 0.5) / DEG);
  const limit = Math.min(g.limit ?? 50, MAX_GEOMETRY_RESULTS);
  let normal: Vec3 | null = null;
  if (g.normal !== undefined) {
    const n = Math.hypot(...g.normal);
    if (!(n > 0)) return sessionError('invalid-input', 'normal must not be zero.');
    normal = [g.normal[0] / n, g.normal[1] / n, g.normal[2] / n];
  }
  // The reference axis of `coaxialWith`, per part: names are a part's own, and so are coordinates.
  const references = new Map<string, AxisLine>();
  if (g.coaxialWith !== undefined) {
    let named = false;
    for (const part of result.parts) {
      if (g.partId !== undefined && part.partId !== g.partId) continue;
      for (const body of part.bodies) {
        const face = ctx.model.geometry(body.bodyKey)?.faces.find((f) => f.name === g.coaxialWith);
        if (face === undefined || references.has(part.partId)) continue;
        named = true;
        const line = axisLine(face);
        if (line !== null) references.set(part.partId, line);
      }
    }
    if (!named) {
      return sessionError('invalid-input', 'coaxialWith names no face of the last regen.');
    }
    if (references.size === 0) {
      return sessionError('invalid-input', 'coaxialWith must name a cylindrical face.');
    }
  }
  const hits: GeometryHit[] = [];
  for (const part of result.parts) {
    if (g.partId !== undefined && part.partId !== g.partId) continue;
    const reference = references.get(part.partId);
    if (g.coaxialWith !== undefined && reference === undefined) continue;
    for (const body of part.bodies) {
      if (g.bodyId !== undefined && body.bodyId !== g.bodyId) continue;
      const geometry = ctx.model.geometry(body.bodyKey);
      if (geometry === undefined) continue;
      const keep = (item: NamedFace | NamedEdge) =>
        (g.name === undefined || item.name === g.name) &&
        (g.bornBy === undefined || bornBy(item.name, g.bornBy));
      if (g.kind !== 'edge') {
        for (const f of geometry.faces) {
          if (!keep(f)) continue;
          if (normal !== null && (f.normal === null || dot(f.normal, normal) < cosTol)) continue;
          if (
            g.radius !== undefined &&
            (f.radius === null || Math.abs(f.radius - g.radius) > tol)
          ) {
            continue;
          }
          if (reference !== undefined) {
            const line = axisLine(f);
            if (line === null || !coaxial(line, reference, tol, cosTol)) continue;
          }
          hits.push({
            partId: part.partId,
            bodyId: body.bodyId,
            kind: 'face',
            name: f.name,
            fragile: f.fragile,
            index: f.index,
            surface: f.surface,
            area: f.area,
            centroid: f.centroid,
            normal: f.normal,
            axis: f.axis,
            radius: f.radius,
            axisOrigin: f.axisOrigin ?? null,
            hole: f.hole ?? null,
          });
        }
      }
      if (g.kind !== 'face' && normal === null && reference === undefined) {
        for (const e of geometry.edges) {
          if (!keep(e)) continue;
          // An edge has a radius only through a circle: measure it to know (not indexed here).
          if (g.radius !== undefined) continue;
          hits.push({
            partId: part.partId,
            bodyId: body.bodyId,
            kind: 'edge',
            name: e.name,
            fragile: e.fragile,
            index: e.index,
            curve: e.curve,
            length: e.length,
            midpoint: e.midpoint,
            faces: e.faces,
          });
        }
      }
    }
  }
  if (g.nearest !== undefined) {
    const p = g.nearest;
    for (const h of hits) h.distance = dist(p, (h.centroid ?? h.midpoint)!);
    hits.sort((a, b) => a.distance! - b.distance!);
  }
  return done(hits.slice(0, limit));
}

// ---------------------------------------------------------------------------------------------
// Measure

/** A body of a part: one regen made, or a reference import (`bodyId` is the import's id). */
export interface BodyRef {
  partId: string;
  bodyId: string;
}

export type MeasureQuery =
  /** Volume, area, centre of mass, bounding box, and mass when the body has a material. */
  | { kind: 'body'; partId: string; bodyId: string }
  /**
   * Faces, edges or vertices of a body; with exactly two, their distance and angle. A target with
   * a `bodyId` is on that body of the same part instead: two faces of two bodies.
   */
  | {
      kind: 'targets';
      partId: string;
      bodyId: string;
      targets: (MeasureTarget & { bodyId?: string })[];
    }
  /**
   * Overlap between bodies, each at an optional placement (its own coordinates by default): the
   * overlapping volume per pair, and the gap between their bounding boxes when apart.
   */
  | { kind: 'clearance'; bodies: (BodyRef & { placement?: Placement })[] }
  /**
   * Interference of an assembly's instances: at their solved poses, at `poses` by instance (each
   * checked against the mates: a warning for a pose past a limit or off a mate), or over `travel`,
   * a slider's or revolute's coordinate swept from `from` to `to` by `step` (mm or degrees; the
   * mate's limits and 20 steps by default), the other mates kept.
   */
  | {
      kind: 'interference';
      assemblyId: string;
      poses?: Record<string, Placement>;
      travel?: InterferenceTravel;
    };

/** A sweep over one mate's coordinate: mm for a slider, degrees for a revolute. */
export interface InterferenceTravel {
  mateId: string;
  from?: number;
  to?: number;
  step?: number;
}

/** Steps of a sweep over a mate's travel when no step is given. */
export const DEFAULT_SWEEP_STEPS = 20;
/** A sweep's time budget, ms, when the context gives none (`SessionLimits.kernelMsPerCall`'s default). */
const DEFAULT_SWEEP_MS = 30_000;

interface LiveBody {
  shape: ShapeId;
  material: string | undefined;
}

function liveBody(ctx: QueryContext, ref: unknown): LiveBody | { error: string } {
  const r = (ref ?? {}) as Record<string, unknown>;
  if (!isString(r.partId) || !isString(r.bodyId))
    return { error: 'partId and bodyId are strings.' };
  const part = ctx.document.parts.find((p) => p.id === r.partId);
  const built = ctx.model.last?.parts.find((p) => p.partId === r.partId);
  const body = built?.bodies.find((b) => b.bodyId === r.bodyId);
  if (part !== undefined && body !== undefined) {
    return {
      shape: body.shape,
      material: bodyMaterial(part, body.bodyId, body.inherited?.material),
    };
  }
  const reference = ctx.references.find(r.partId, r.bodyId);
  if (reference?.shape !== undefined) return { shape: reference.shape, material: part?.material };
  if (reference?.error !== undefined) return { error: reference.error };
  return { error: 'There is no such body in the last regen.' };
}

function withMass(body: BodyMeasure, material: string | undefined) {
  const m = material === undefined ? undefined : findMaterial(material);
  return {
    ...body,
    ...(m === undefined
      ? { mass: null }
      : { mass: massGrams(body.volume, m.density), material: m.id, density: m.density }),
  };
}

/** One kernel op on the session's engine; its value, or why not. */
async function runOne<T>(
  ctx: QueryContext,
  op: Record<string, unknown>,
): Promise<SessionResult<T>> {
  const reply = await ctx.api.run({ generation: ctx.generation, ops: [op as never] });
  const r = reply.results[0];
  if (reply.status !== 'done' || r === undefined) {
    return sessionError('kernel', 'The kernel was busy or replaced; ask again.');
  }
  if (!r.ok) return sessionError('kernel', r.error.message);
  return done(r.value as T);
}

function checkPlacement(p: unknown): p is Placement {
  const x = p as Placement | undefined;
  return (
    x !== undefined &&
    isVec3(x.translation) &&
    Array.isArray(x.rotation) &&
    x.rotation.length === 4 &&
    x.rotation.every((v) => typeof v === 'number' && Number.isFinite(v))
  );
}

/** Exact measurements on the kernel's B-rep (never the mesh). */
export async function measure(ctx: QueryContext, query: unknown): Promise<SessionResult<unknown>> {
  const q = (query ?? {}) as Record<string, unknown>;
  switch (q.kind) {
    case 'body': {
      const reference =
        isString(q.partId) && isString(q.bodyId)
          ? ctx.references.find(q.partId, q.bodyId)
          : undefined;
      if (reference?.mesh !== undefined) {
        const m = reference.mesh;
        return done({ ...m, mass: null, mesh: true });
      }
      const body = liveBody(ctx, q);
      if ('error' in body) return sessionError('not-found', body.error);
      const r = await runOne<MeasureResult>(ctx, {
        op: 'measure',
        shape: body.shape,
        targets: [],
        body: true,
      });
      if (!r.ok || r.value.body === null) return r.ok ? sessionError('kernel', 'No body.') : r;
      return done(withMass(r.value.body, body.material));
    }
    case 'targets': {
      const body = liveBody(ctx, q);
      if ('error' in body) return sessionError('not-found', body.error);
      const targets = q.targets;
      if (
        !Array.isArray(targets) ||
        targets.length === 0 ||
        targets.length > MAX_MEASURE_ITEMS ||
        !targets.every(isTarget)
      ) {
        return sessionError(
          'invalid-input',
          `targets: 1 to ${MAX_MEASURE_ITEMS} of { kind: face | edge | vertex, name } or { kind, index }, each with an optional bodyId.`,
        );
      }
      // A target on another body of the part: that body's shape, in the same coordinates.
      const shapes = new Map<string, ShapeId>([[q.bodyId as string, body.shape]]);
      const ops: MeasureOpTarget[] = [];
      for (const t of targets) {
        const { bodyId, ...target } = t;
        if (bodyId === undefined || bodyId === q.bodyId) {
          ops.push(target);
          continue;
        }
        let shape = shapes.get(bodyId);
        if (shape === undefined) {
          const other = liveBody(ctx, { partId: q.partId, bodyId });
          if ('error' in other) return sessionError('not-found', `${bodyId}: ${other.error}`);
          shape = other.shape;
          shapes.set(bodyId, shape);
        }
        ops.push({ ...target, shape });
      }
      const r = await runOne<MeasureResult>(ctx, {
        op: 'measure',
        shape: body.shape,
        targets: ops,
      });
      if (!r.ok) return r;
      const { angle } = r.value;
      return done({
        items: r.value.items.map((item, i) => ({
          ...item,
          bodyId: targets[i]!.bodyId ?? (q.bodyId as string),
        })),
        distance: r.value.distance,
        angle:
          angle === null
            ? null
            : {
                ...angle,
                value: angle.value * DEG,
                normals: angle.normals === null ? null : angle.normals * DEG,
              },
      });
    }
    case 'clearance': {
      const list = q.bodies;
      if (!Array.isArray(list) || list.length < 2 || list.length > MAX_MEASURE_ITEMS) {
        return sessionError('invalid-input', `bodies: 2 to ${MAX_MEASURE_ITEMS} bodies.`);
      }
      const items: { shapes: ShapeId[]; transform?: Placement }[] = [];
      for (const ref of list) {
        const body = liveBody(ctx, ref);
        if ('error' in body) return sessionError('not-found', body.error);
        const placement = (ref as { placement?: unknown }).placement;
        if (placement !== undefined && !checkPlacement(placement)) {
          return sessionError(
            'invalid-input',
            'A placement is { translation: [x, y, z], rotation: [x, y, z, w] }.',
          );
        }
        items.push({ shapes: [body.shape], ...(placement ? { transform: placement } : {}) });
      }
      return interference(ctx, items);
    }
    case 'interference':
      return assemblyInterference(ctx, q);
    default:
      return sessionError('invalid-input', 'kind is body, targets, clearance or interference.');
  }
}

/** An instance an interference check places: its bodies' shapes and its solved pose. */
interface PlacedInstance {
  instance: string;
  shapes: ShapeId[];
  transform: Placement;
}

/** A mate warning of an interference check, in mm and degrees. */
interface InterferenceWarning {
  code: 'outside-limits' | 'off-mate' | 'not-reached' | 'truncated';
  mateId: string;
  message: string;
  [key: string]: unknown;
}

async function assemblyInterference(
  ctx: QueryContext,
  q: Record<string, unknown>,
): Promise<SessionResult<unknown>> {
  if (!isString(q.assemblyId)) return sessionError('invalid-input', 'assemblyId is a string.');
  const poses = (q.poses ?? {}) as Record<string, unknown>;
  if (typeof poses !== 'object' || poses === null) {
    return sessionError('invalid-input', 'poses maps instance ids to placements.');
  }
  const solved = ctx.model.last?.assemblies.find((a) => a.assemblyId === q.assemblyId);
  const assembly = ctx.document.assemblies.find((a) => a.id === q.assemblyId);
  if (solved === undefined || assembly === undefined) {
    return sessionError('not-found', 'There is no such assembly.');
  }
  const placed: PlacedInstance[] = [];
  for (const inst of solved.instances) {
    if (inst.status !== 'ok' || !('part' in inst.source)) continue;
    const partId = inst.source.part;
    const built = ctx.model.last!.parts.find((p) => p.partId === partId);
    const shapes = inst.bodies
      .map((b) => built?.bodies.find((x) => x.bodyId === b)?.shape)
      .filter((s): s is ShapeId => s !== undefined);
    if (shapes.length === 0) continue;
    placed.push({ instance: inst.instanceId, shapes, transform: inst.transform });
  }
  const instances = placed.map((i) => i.instance);
  const input = resultSolverInput(
    assembly,
    solved,
    evaluateVariables(ctx.document.variables, ctx.model.last?.measurements),
  );
  if (q.travel !== undefined) {
    if (Object.keys(poses).length > 0) {
      return sessionError('invalid-input', 'Give poses or a travel, not both.');
    }
    if (solved.outcome !== 'solved') {
      return sessionError(
        'invalid-input',
        `The assembly's last solve is ${solved.outcome}${solved.message ? `: ${solved.message}` : ''}. Fix its mates (get_errors) before sweeping one.`,
      );
    }
    return travelInterference(ctx, q.travel, input, placed);
  }
  const given: Record<string, Placement> = {};
  for (const [id, pose] of Object.entries(poses)) {
    if (!checkPlacement(pose)) {
      return sessionError(
        'invalid-input',
        'A pose is { translation: [x, y, z], rotation: [x, y, z, w] }.',
      );
    }
    given[id] = pose;
  }
  const items = placed.map((i) => ({
    shapes: i.shapes,
    transform: Object.hasOwn(given, i.instance) ? given[i.instance]! : i.transform,
  }));
  const r = await interference(ctx, items);
  if (!r.ok) return r;
  const v = r.value;
  return done({
    instances,
    pairs: v.pairs.map((p) => ({ ...p, a: instances[p.a]!, b: instances[p.b]! })),
    failures: v.failures.map((f) => ({ ...f, a: instances[f.a]!, b: instances[f.b]! })),
    warnings: Object.keys(given).length === 0 ? [] : poseWarnings(input, given),
  });
}

/** Past this a pose is off its mate: mm, and degrees. */
const OFF_MATE_MM = 0.01;
const OFF_MATE_DEG = 0.01;

/** What the given poses do to the mates: a coordinate past a limit, a mate not kept. */
function poseWarnings(
  input: ReturnType<typeof resultSolverInput>,
  poses: Record<string, Placement>,
): InterferenceWarning[] {
  const moved = new Set(Object.keys(poses));
  const warnings: InterferenceWarning[] = [];
  for (const m of posedMates(input, poses)) {
    const mate = input.mates.find((x) => x.id === m.mateId)!;
    if (!moved.has(mate.a.instance) && !moved.has(mate.b.instance)) continue;
    const past = m.outsideLimits;
    if (past !== null) {
      const unit = m.kind === 'revolute' ? 'deg' : 'mm';
      const k = m.kind === 'revolute' ? DEG : 1;
      warnings.push({
        code: 'outside-limits',
        mateId: m.mateId,
        bound: past.bound,
        limit: past.limit * k,
        value: past.value * k,
        unit,
        message: `The poses put ${m.mateId} at ${fmt(past.value * k, unit)}, past its ${past.bound === 'max' ? 'maximum' : 'minimum'} of ${fmt(past.limit * k, unit)}: the mate cannot get there.`,
      });
    }
    const angle = m.residual.angle * DEG;
    if (m.residual.position > OFF_MATE_MM || angle > OFF_MATE_DEG) {
      warnings.push({
        code: 'off-mate',
        mateId: m.mateId,
        position: m.residual.position,
        angle,
        message: `The poses do not keep ${m.mateId} (a ${m.kind}): its connectors are ${fmt(m.residual.position, 'mm')} and ${fmt(angle, 'deg')} from where it holds them.`,
      });
    }
  }
  return warnings;
}

function fmt(v: number, unit: 'mm' | 'deg'): string {
  return unit === 'deg' ? `${v.toFixed(2)} deg` : `${v.toFixed(2)} mm`;
}

/** The interference check over a slider's or revolute's travel. */
async function travelInterference(
  ctx: QueryContext,
  travel: unknown,
  input: ReturnType<typeof resultSolverInput>,
  placed: PlacedInstance[],
): Promise<SessionResult<unknown>> {
  const t = (travel ?? {}) as Record<string, unknown>;
  const number = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v));
  if (typeof travel !== 'object' || travel === null || !isString(t.mateId)) {
    return sessionError('invalid-input', 'travel is { mateId, from?, to?, step? }.');
  }
  if (!number(t.from) || !number(t.to) || !number(t.step)) {
    return sessionError('invalid-input', 'travel from, to and step are numbers.');
  }
  const mate = input.mates.find((m) => m.id === t.mateId);
  if (mate === undefined) {
    return sessionError(
      'not-found',
      `There is no mate ${t.mateId} that solved in the last regen: see get_errors.`,
    );
  }
  if (mate.kind !== 'slider' && mate.kind !== 'revolute') {
    return sessionError(
      'invalid-input',
      `${mate.id} is a ${mate.kind} mate: only a slider's or a revolute's travel is swept.`,
    );
  }
  const unit = mate.kind === 'revolute' ? 'deg' : 'mm';
  const k = mate.kind === 'revolute' ? DEG : 1;
  const min = mate.limits?.min === undefined ? undefined : mate.limits.min * k;
  const max = mate.limits?.max === undefined ? undefined : mate.limits.max * k;
  const from = (t.from as number | undefined) ?? min;
  const to = (t.to as number | undefined) ?? max;
  if (from === undefined || to === undefined) {
    return sessionError(
      'invalid-input',
      `${mate.id} has no ${from === undefined ? 'minimum' : 'maximum'}: give travel ${from === undefined ? 'from' : 'to'} (${unit}).`,
    );
  }
  const span = Math.abs(to - from);
  const step = (t.step as number | undefined) ?? (span > 0 ? span / DEFAULT_SWEEP_STEPS : 1);
  const values = sweepValues(from, to, step);
  if (values === null) {
    return sessionError(
      'invalid-input',
      `A sweep checks at most ${MAX_SWEEP_VALUES} values: for ${fmt(span, unit)} the step is at least ${fmt(span / (MAX_SWEEP_VALUES - 1), unit)}, and positive.`,
    );
  }
  const warnings: InterferenceWarning[] = [];
  for (const bound of ['min', 'max'] as const) {
    const limit = bound === 'min' ? min : max;
    if (limit === undefined) continue;
    const past = values.filter((v) => (bound === 'min' ? v < limit - 1e-9 : v > limit + 1e-9));
    if (past.length === 0) continue;
    warnings.push({
      code: 'outside-limits',
      mateId: mate.id,
      bound,
      limit,
      values: past,
      unit,
      message: `${past.length === 1 ? 'A value' : `${past.length} values`} of the sweep (${fmt(past[0]!, unit)}${past.length > 1 ? ` to ${fmt(past.at(-1)!, unit)}` : ''}) ${past.length === 1 ? 'is' : 'are'} past ${mate.id}'s ${bound === 'max' ? 'maximum' : 'minimum'} of ${fmt(limit, unit)}: checked, though the mate cannot get there.`,
    });
  }
  const steps = sweepPoses(
    input,
    mate.id,
    values.map((v) => v / k),
  );
  const instances = placed.map((i) => i.instance);
  // Only pairs with an instance the sweep moves change from step to step; the pairs of instances
  // that stay put are checked once, at their solved poses, and answered apart (`staticPairs`).
  const moving = new Set<number>();
  placed.forEach((p, i) => {
    if (
      steps.some(
        (s) => s.poses !== null && posesDiffer(s.poses[p.instance] ?? p.transform, p.transform),
      )
    ) {
      moving.add(i);
    }
  });
  const sweptPairs: [number, number][] = [];
  const fixedPairs: [number, number][] = [];
  for (let a = 0; a < placed.length; a++) {
    for (let b = a + 1; b < placed.length; b++) {
      (moving.has(a) || moving.has(b) ? sweptPairs : fixedPairs).push([a, b]);
    }
  }
  type Kernel = {
    pairs: { a: number; b: number; volume: number }[];
    failures: { a: number; b: number; message: string }[];
  };
  const named = (p: { a: number; b: number; volume: number }) => ({
    ...p,
    a: instances[p.a]!,
    b: instances[p.b]!,
  });
  const colliding: number[] = [];
  const failures: { value: number | null; a: string; b: string; message: string }[] = [];
  const notReached: number[] = [];
  let staticPairs: { a: string; b: string; volume: number }[] = [];
  let first: { value: number; pairs: { a: string; b: string; volume: number }[] } | null = null;
  let checked = 0;
  // The whole sweep stays within one kernel call's budget: past it, what was checked is answered.
  const budget = ctx.kernelMsPerCall ?? DEFAULT_SWEEP_MS;
  const started = performance.now();
  const overBudget = () => performance.now() - started >= budget;
  let truncated = false;
  if (fixedPairs.length > 0) {
    const r = await runOne<Kernel>(ctx, {
      op: 'interference',
      items: placed.map((p) => ({ shapes: p.shapes, transform: p.transform })),
      pairs: fixedPairs,
    });
    if (!r.ok) return r;
    staticPairs = r.value.pairs.map(named);
    for (const f of r.value.failures) {
      failures.push({ value: null, a: instances[f.a]!, b: instances[f.b]!, message: f.message });
    }
  }
  for (let i = 0; i < steps.length; i++) {
    const value = values[i]!;
    const at = steps[i]!.poses;
    if (at === null) {
      notReached.push(value);
      continue;
    }
    if (sweptPairs.length === 0) {
      checked++;
      continue;
    }
    if (overBudget()) {
      truncated = true;
      break;
    }
    const r = await runOne<Kernel>(ctx, {
      op: 'interference',
      items: placed.map((p) => ({ shapes: p.shapes, transform: at[p.instance] ?? p.transform })),
      pairs: sweptPairs,
    });
    if (!r.ok) return r;
    checked++;
    for (const f of r.value.failures) {
      failures.push({ value, a: instances[f.a]!, b: instances[f.b]!, message: f.message });
    }
    if (r.value.pairs.length === 0) continue;
    colliding.push(value);
    first ??= { value, pairs: r.value.pairs.map(named) };
  }
  if (notReached.length > 0) {
    warnings.push({
      code: 'not-reached',
      mateId: mate.id,
      values: notReached,
      unit,
      message: `The solver could not hold ${mate.id} at ${notReached.length === 1 ? 'one value' : `${notReached.length} values`} (${fmt(notReached[0]!, unit)} first), as inside a loop of mates: not checked there.`,
    });
  }
  if (truncated) {
    warnings.push({
      code: 'truncated',
      mateId: mate.id,
      checked,
      values: values.length,
      ms: budget,
      message: `The sweep stopped after ${checked} of ${values.length} values: it ran past ${budget} ms. Sweep the rest (from the next value) or use a larger step.`,
    });
  }
  return done({
    instances,
    moving: [...moving].map((i) => instances[i]!),
    travel: { mateId: mate.id, kind: mate.kind, unit, from, to, step },
    values,
    checked,
    first,
    pairs: first?.pairs ?? [],
    colliding,
    staticPairs,
    failures,
    warnings,
  });
}

function isTarget(t: unknown): t is MeasureTarget & { bodyId?: string } {
  const x = t as Record<string, unknown> | null;
  if (x === null || typeof x !== 'object') return false;
  if (x.bodyId !== undefined && !isString(x.bodyId)) return false;
  if (x.kind !== 'face' && x.kind !== 'edge' && x.kind !== 'vertex') return false;
  if (isString(x.name)) return x.index === undefined;
  return Number.isSafeInteger(x.index) && (x.index as number) >= 1 && x.name === undefined;
}

interface Overlaps {
  pairs: { a: number; b: number; volume: number }[];
  gaps: { a: number; b: number; boxGap: number }[];
  failures: { a: number; b: number; message: string }[];
}

/** Overlap volumes of every pair of `items`, and the gap between the boxes of pairs apart. */
async function interference(
  ctx: QueryContext,
  items: { shapes: ShapeId[]; transform?: Placement }[],
): Promise<SessionResult<Overlaps>> {
  const r = await runOne<{
    pairs: { a: number; b: number; volume: number }[];
    failures: { a: number; b: number; message: string }[];
  }>(ctx, { op: 'interference', items });
  if (!r.ok) return r;
  // Box gaps, from each body's tight box placed (its eight corners moved).
  const boxes: ({ min: Vec3; max: Vec3 } | null)[] = [];
  for (const item of items) {
    let box: { min: Vec3; max: Vec3 } | null = null;
    for (const shape of item.shapes) {
      const m = await runOne<MeasureResult>(ctx, { op: 'measure', shape, targets: [], body: true });
      const b = m.ok ? m.value.body?.boundingBox : null;
      if (!b) continue;
      const placed = placeBox(b, item.transform);
      box =
        box === null
          ? placed
          : {
              min: [0, 1, 2].map((i) => Math.min(box!.min[i]!, placed.min[i]!)) as unknown as Vec3,
              max: [0, 1, 2].map((i) => Math.max(box!.max[i]!, placed.max[i]!)) as unknown as Vec3,
            };
    }
    boxes.push(box);
  }
  const overlapping = new Set(r.value.pairs.map((p) => `${p.a},${p.b}`));
  const gaps: Overlaps['gaps'] = [];
  for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
      const x = boxes[a];
      const y = boxes[b];
      if (overlapping.has(`${a},${b}`) || !x || !y) continue;
      const d = [0, 1, 2].map((i) => Math.max(0, x.min[i]! - y.max[i]!, y.min[i]! - x.max[i]!));
      gaps.push({ a, b, boxGap: Math.hypot(d[0]!, d[1]!, d[2]!) });
    }
  }
  return done({ pairs: r.value.pairs, gaps, failures: r.value.failures });
}

function placeBox(box: { min: Vec3; max: Vec3 }, t?: Placement): { min: Vec3; max: Vec3 } {
  if (t === undefined) return box;
  const [x, y, z, w] = t.rotation;
  const rotate = (v: Vec3): Vec3 => {
    // v + 2w (q x v) + 2 q x (q x v), q = (x, y, z)
    const cx = y * v[2] - z * v[1];
    const cy = z * v[0] - x * v[2];
    const cz = x * v[1] - y * v[0];
    return [
      v[0] + 2 * (w * cx + y * cz - z * cy),
      v[1] + 2 * (w * cy + z * cx - x * cz),
      v[2] + 2 * (w * cz + x * cy - y * cx),
    ];
  };
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const c: Vec3 = [
      i & 1 ? box.max[0] : box.min[0],
      i & 2 ? box.max[1] : box.min[1],
      i & 4 ? box.max[2] : box.min[2],
    ];
    const p = rotate(c);
    for (let k = 0; k < 3; k++) {
      const v = p[k]! + t.translation[k]!;
      min[k] = Math.min(min[k]!, v);
      max[k] = Math.max(max[k]!, v);
    }
  }
  return { min: min as unknown as Vec3, max: max as unknown as Vec3 };
}

// ---------------------------------------------------------------------------------------------
// Quantities

export interface Quantities {
  /** Always false on an agent's branch: nothing here was reviewed (ADR 0016 decision 6). */
  reviewed: false;
  /**
   * The woodworking cut list (boards and wood shapes), or null when it could not be made or the
   * scope leaves it out (`owners`).
   */
  cutList: CutList | null;
  /** Hardware from joints (dowels, pocket screws) and slides: the cut list's hardware lines. */
  hardware: CutList['hardware'];
  /** One construction takeoff per part studio with framing members (in the scope). */
  takeoffs: { partId: string; takeoff: ConstructionTakeoff; notes: string[] }[];
  /** What could not be counted, for people. */
  notes: string[];
}

/**
 * What the quantities count. Empty: everything, as the regen made it. A scope narrows what goes
 * into the takeoffs, so their purchase rows (`lumber`, `sheet`), layouts and totals are worked out
 * for what is counted alone, not cut out of the whole frame's.
 */
export interface QuantityScope {
  /**
   * Feature ids (walls, openings, floors, roofs): only the framing members and sheet faces these
   * features own are counted, and part studios with none are left out. The cut list and its
   * hardware are not counted (they have no owner). An opening's members are its own, not its
   * wall's.
   */
  owners?: readonly string[];
}

/**
 * What the quantities are made from, before any scope: the cut list and each part studio's
 * takeoff input. Plain data, so a host may keep it (the session keeps its base's).
 */
export interface QuantitySources {
  cutList: CutList | null;
  takeoffs: { partId: string; input: ConstructionTakeoffInput; notes: string[] }[];
  notes: string[];
}

/** Cut list and takeoff inputs of the last regen (T8.1b's builders). */
export function quantitySources(ctx: Pick<QueryContext, 'document' | 'model'>): QuantitySources {
  const document = ctx.document;
  const result = ctx.model.last;
  const notes: string[] = [];
  let cutList: CutList | null = null;
  const takeoffs: QuantitySources['takeoffs'] = [];
  if (result !== null) {
    try {
      cutList = documentCutList({ document, parts: result.parts, assemblies: result.assemblies });
    } catch (e) {
      notes.push(`The cut list could not be made: ${e instanceof Error ? e.message : String(e)}`);
    }
    const data = documentConstruction(document);
    const settings = data.ok ? data.data?.settings : undefined;
    const stock = documentStock(document);
    for (const part of result.parts) {
      const sets = ctx.model
        .sets(part.partId)
        .filter((s) => s.namespace === 'construction')
        .map((s) => ({ namespace: s.namespace, members: s.members }));
      if (sets.length === 0) continue;
      try {
        const model = takeoffModel({
          document,
          partId: part.partId,
          features: part.features,
          sets,
          settings,
          stock: stock.ok ? stock.data : undefined,
        });
        takeoffs.push({ partId: part.partId, input: model.input, notes: model.notes });
      } catch (e) {
        notes.push(
          `The takeoff of ${part.partId} could not be made: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
  return { cutList, takeoffs, notes };
}

/** The quantities of `sources` within `scope`. */
export function quantitiesOf(sources: QuantitySources, scope: QuantityScope = {}): Quantities {
  const notes = [...sources.notes];
  const owners = scope.owners === undefined ? null : new Set(scope.owners);
  const cutList = owners === null ? sources.cutList : null;
  const takeoffs: Quantities['takeoffs'] = [];
  for (const t of sources.takeoffs) {
    let input = t.input;
    if (owners !== null) {
      const members = input.members.filter((m) => owners.has(m.owner));
      const faces = (input.faces ?? []).filter((f) => owners.has(f.owner));
      if (members.length === 0 && faces.length === 0) continue;
      input = { ...input, members, faces };
    }
    try {
      takeoffs.push({ partId: t.partId, takeoff: constructionTakeoff(input), notes: t.notes });
    } catch (e) {
      notes.push(
        `The takeoff of ${t.partId} could not be made: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { reviewed: false, cutList, hardware: cutList?.hardware ?? [], takeoffs, notes };
}

/** Cut list, hardware and takeoffs of the last regen, as data, within `scope`. */
export function quantities(ctx: QueryContext, scope: QuantityScope = {}): Quantities {
  return quantitiesOf(quantitySources(ctx), scope);
}

// ---------------------------------------------------------------------------------------------
// Errors

export interface ErrorLine {
  where: 'feature' | 'instance' | 'mate' | 'reference-import' | 'variable';
  partId?: string;
  featureId?: string;
  assemblyId?: string;
  id?: string;
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

/** Every regen error and warning of the head, errors first. */
export function errorsOf(result: RegenResult | null, references: References): ErrorLine[] {
  const out: ErrorLine[] = [];
  // Variables that measure the model (or read one that does) and do not evaluate: a lost face,
  // a cycle. The features reading them carry their own errors below.
  for (const v of result?.variableErrors ?? []) {
    out.push({
      where: 'variable',
      id: v.name,
      severity: 'error',
      code: v.code,
      message: v.message,
    });
  }
  for (const part of result?.parts ?? []) {
    for (const f of part.features) {
      for (const e of f.errors) {
        out.push({
          where: 'feature',
          partId: part.partId,
          featureId: f.featureId,
          severity: 'error',
          code: e.code,
          message: e.message,
        });
      }
      for (const w of f.warnings) {
        out.push({
          where: 'feature',
          partId: part.partId,
          featureId: f.featureId,
          severity: 'warning',
          code: w.code,
          message: w.message,
        });
      }
    }
  }
  for (const a of result?.assemblies ?? []) {
    for (const i of a.instances) {
      for (const e of i.errors) {
        out.push({
          where: 'instance',
          assemblyId: a.assemblyId,
          id: i.instanceId,
          severity: 'error',
          code: e.code,
          message: e.message,
        });
      }
      for (const w of i.warnings) {
        out.push({
          where: 'instance',
          assemblyId: a.assemblyId,
          id: i.instanceId,
          severity: 'warning',
          code: w.code,
          message: w.message,
        });
      }
    }
    for (const m of a.mates) {
      for (const e of m.errors) {
        out.push({
          where: 'mate',
          assemblyId: a.assemblyId,
          id: m.mateId,
          severity: 'error',
          code: e.code,
          message: e.message,
        });
      }
      for (const w of m.warnings) {
        out.push({
          where: 'mate',
          assemblyId: a.assemblyId,
          id: m.mateId,
          severity: 'warning',
          code: w.code,
          message: w.message,
        });
      }
    }
  }
  for (const r of references.list()) {
    if (r.error !== undefined) {
      out.push({
        where: 'reference-import',
        partId: r.partId,
        featureId: r.featureId,
        severity: 'error',
        code: 'import',
        message: r.error,
      });
    }
  }
  return [
    ...out.filter((x) => x.severity === 'error'),
    ...out.filter((x) => x.severity === 'warning'),
  ];
}
