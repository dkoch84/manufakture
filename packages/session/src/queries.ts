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
  takeoffModel,
  type ConstructionTakeoff,
} from '@manufakture/domain-construction';
import { documentCutList, type CutList } from '@manufakture/domain-wood';
import type {
  BodyMeasure,
  MeasureResult,
  MeasureTarget,
  Placement,
  ShapeId,
  Vec3,
} from '@manufakture/kernel';
import { evaluateVariables, type RegenResult } from '@manufakture/regen';
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
  const values = evaluateVariables(document.variables);
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
          status: solved?.instances.find((x) => x.instanceId === i.id)?.status ?? null,
        })),
        mates: a.mates.map((m) => ({
          id: m.id,
          name: m.name,
          kind: m.kind,
          suppressed: m.suppressed,
          status: solved?.mates.find((x) => x.mateId === m.id)?.status ?? null,
        })),
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
  /** Faces, edges or vertices of one body; with exactly two, their distance and angle. */
  | { kind: 'targets'; partId: string; bodyId: string; targets: MeasureTarget[] }
  /**
   * Overlap between bodies, each at an optional placement (its own coordinates by default): the
   * overlapping volume per pair, and the gap between their bounding boxes when apart.
   */
  | { kind: 'clearance'; bodies: (BodyRef & { placement?: Placement })[] }
  /** Interference of an assembly's instances: at their solved poses, or at `poses` by instance. */
  | { kind: 'interference'; assemblyId: string; poses?: Record<string, Placement> };

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
          `targets: 1 to ${MAX_MEASURE_ITEMS} of { kind: face | edge | vertex, name } or { kind, index }.`,
        );
      }
      const r = await runOne<MeasureResult>(ctx, {
        op: 'measure',
        shape: body.shape,
        targets,
      });
      if (!r.ok) return r;
      const { angle } = r.value;
      return done({
        items: r.value.items,
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
    case 'interference': {
      if (!isString(q.assemblyId)) return sessionError('invalid-input', 'assemblyId is a string.');
      const poses = (q.poses ?? {}) as Record<string, unknown>;
      if (typeof poses !== 'object' || poses === null) {
        return sessionError('invalid-input', 'poses maps instance ids to placements.');
      }
      const solved = ctx.model.last?.assemblies.find((a) => a.assemblyId === q.assemblyId);
      if (solved === undefined) return sessionError('not-found', 'There is no such assembly.');
      const items: { shapes: ShapeId[]; transform?: Placement; instance: string }[] = [];
      for (const inst of solved.instances) {
        if (inst.status !== 'ok' || !('part' in inst.source)) continue;
        const partId = inst.source.part;
        const built = ctx.model.last!.parts.find((p) => p.partId === partId);
        const shapes = inst.bodies
          .map((b) => built?.bodies.find((x) => x.bodyId === b)?.shape)
          .filter((s): s is ShapeId => s !== undefined);
        if (shapes.length === 0) continue;
        const given = Object.hasOwn(poses, inst.instanceId) ? poses[inst.instanceId] : undefined;
        if (given !== undefined && !checkPlacement(given)) {
          return sessionError(
            'invalid-input',
            'A pose is { translation: [x, y, z], rotation: [x, y, z, w] }.',
          );
        }
        items.push({ shapes, transform: given ?? inst.transform, instance: inst.instanceId });
      }
      const r = await interference(
        ctx,
        items.map(({ shapes, transform }) => ({ shapes, ...(transform ? { transform } : {}) })),
      );
      if (!r.ok) return r;
      const v = r.value;
      return done({
        instances: items.map((i) => i.instance),
        pairs: v.pairs.map((p) => ({ ...p, a: items[p.a]!.instance, b: items[p.b]!.instance })),
        failures: v.failures.map((f) => ({
          ...f,
          a: items[f.a]!.instance,
          b: items[f.b]!.instance,
        })),
      });
    }
    default:
      return sessionError('invalid-input', 'kind is body, targets, clearance or interference.');
  }
}

function isTarget(t: unknown): t is MeasureTarget {
  const x = t as Record<string, unknown> | null;
  if (x === null || typeof x !== 'object') return false;
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
  /** The woodworking cut list (boards and wood shapes), or null when it could not be made. */
  cutList: CutList | null;
  /** Hardware from joints (dowels, pocket screws): the cut list's hardware lines. */
  hardware: CutList['hardware'];
  /** One construction takeoff per part studio with framing members. */
  takeoffs: { partId: string; takeoff: ConstructionTakeoff; notes: string[] }[];
  /** What could not be counted, for people. */
  notes: string[];
}

/** Cut list, hardware and takeoffs of the last regen, as data (T8.1b's builders). */
export function quantities(ctx: QueryContext): Quantities {
  const document = ctx.document;
  const result = ctx.model.last;
  const notes: string[] = [];
  let cutList: CutList | null = null;
  const takeoffs: Quantities['takeoffs'] = [];
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
        takeoffs.push({
          partId: part.partId,
          takeoff: constructionTakeoff(model.input),
          notes: model.notes,
        });
      } catch (e) {
        notes.push(
          `The takeoff of ${part.partId} could not be made: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
  return { reviewed: false, cutList, hardware: cutList?.hardware ?? [], takeoffs, notes };
}

// ---------------------------------------------------------------------------------------------
// Errors

export interface ErrorLine {
  where: 'feature' | 'instance' | 'mate' | 'reference-import';
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
