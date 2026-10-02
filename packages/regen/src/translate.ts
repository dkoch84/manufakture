// Core features to kernel `FeatureInput`s: expressions evaluated to millimetres and radians,
// sketch regions turned into profile loops, sketch lines into model-space axes, and references
// copied as names. Pure: everything the kernel must resolve against the body (faces, edges) stays
// a name and is resolved in the worker by `applyFeature`.

import {
  MAX_PATTERN_COUNT,
  type BooleanOperation,
  type EdgeRef as CoreEdgeRef,
  type FaceRef as CoreFaceRef,
  type Feature,
  type ImportFeature,
  type MirrorFeature,
  type PatternFeature,
  type RevolveFeature,
  type ThreadFeature,
} from '@manufakture/core';
import type {
  EdgeRef,
  FaceRef,
  FeatureBody,
  FeatureInput,
  HoleHead,
  HoleInput,
  InstanceSource,
  ResultMode,
  RevolveInput,
  ThreadFaceInput,
  TopoRef,
  ToolInput,
} from '@manufakture/kernel';
import { threadSize } from '@manufakture/kernel';
import { sketchDirectionToWorld, sketchToWorld } from '@manufakture/sketch';
import { profileOf, type SketchResult } from './sketches';
import type { RegenError } from './types';
import { pathKey } from './values';

export interface TranslateContext {
  /** Evaluated expressions of the feature, by `pathKey`. */
  values: ReadonlyMap<string, number>;
  /** Solved sketches available to it, by feature id. */
  sketches: ReadonlyMap<string, SketchResult>;
  /** Kernel inputs of the features built before it, by feature id (pattern and mirror sources). */
  inputs: ReadonlyMap<string, FeatureInput>;
  /** Reference bodies built before it (imports with operation `reference`), by feature id. */
  references?: ReadonlySet<string>;
  /**
   * Ids of the part's bodies at this point. When given, a `scope` entry that is not one of them
   * is a `reference-lost` error on `scope` (the body was merged away, or never made).
   */
  bodies?: ReadonlySet<string>;
  /**
   * The source bodies of derived features, by feature id: the bodies of the pinned source part
   * the feature derives, built in this kernel (`derived.ts`, the engine). A derived feature
   * without an entry fails with `source`.
   */
  sources?: ReadonlyMap<string, readonly FeatureBody[]>;
}

export type Translation = { ok: true; input: FeatureInput } | { ok: false; errors: RegenError[] };

const MODES: Record<BooleanOperation, ResultMode> = {
  new: 'new',
  add: 'add',
  cut: 'subtract',
  intersect: 'intersect',
};

export function faceRef(ref: CoreFaceRef): FaceRef {
  return { face: ref.face };
}

export function edgeRef(ref: CoreEdgeRef): EdgeRef {
  const out: EdgeRef = { faces: [...ref.faces] };
  if (ref.ends !== undefined) out.ends = [...ref.ends];
  if (ref.ordinal !== undefined) out.ordinal = ref.ordinal;
  return out;
}

export function topoRef(ref: CoreFaceRef | CoreEdgeRef): TopoRef {
  return 'face' in ref ? faceRef(ref) : edgeRef(ref);
}

class Failed extends Error {
  constructor(readonly errors: RegenError[]) {
    super(errors.map((e) => e.message).join('; '));
  }
}

function value(ctx: TranslateContext, ...path: (string | number)[]): number {
  const v = ctx.values.get(pathKey(path));
  // Every expression is evaluated before translation, and failures stop it; a missing value
  // is a programming error.
  if (v === undefined) throw new Error(`no value for ${path.join('.')}`);
  return v;
}

function sketchOf(ctx: TranslateContext, id: string): SketchResult {
  const s = ctx.sketches.get(id);
  // Dependencies that failed make the feature an upstream error before it gets here.
  if (!s) throw new Error(`no solved sketch ${id}`);
  return s;
}

function positive(v: number, field: string[], what: string): void {
  if (!(v > 0)) {
    throw new Failed([{ code: 'invalid', field, message: `${what} must be positive` }]);
  }
}

function revolveAxis(ctx: TranslateContext, f: RevolveFeature): RevolveInput['axis'] {
  if (f.axis.type === 'edge') {
    const axis: { edge: EdgeRef; flip?: boolean } = { edge: edgeRef(f.axis.edge.ref) };
    if (f.axis.flip !== undefined) axis.flip = f.axis.flip;
    return axis;
  }
  const sketch = sketchOf(ctx, f.profile.sketch);
  const line = sketch.entities.find((e) => e.id === (f.axis as { entity: string }).entity);
  if (!line) {
    throw new Failed([
      {
        code: 'reference-lost',
        referenceId: 'axis',
        missing: [f.axis.entity],
        message: `The axis line ${f.axis.entity} is no longer in ${f.profile.sketch}: re-pick the axis`,
      },
    ]);
  }
  if (line.kind !== 'line') {
    throw new Failed([
      {
        code: 'invalid',
        field: ['axis'],
        referenceId: 'axis',
        message: `The axis ${line.id} is a ${line.kind}, not a line`,
      },
    ]);
  }
  const origin = sketchToWorld(sketch.placement, line.start);
  let direction = sketchDirectionToWorld(sketch.placement, [
    line.end[0] - line.start[0],
    line.end[1] - line.start[1],
  ]);
  if (Math.hypot(...direction) < 1e-9) {
    throw new Failed([
      {
        code: 'invalid',
        field: ['axis'],
        referenceId: 'axis',
        message: `The axis ${line.id} has no length`,
      },
    ]);
  }
  // Core's flip turns the axis round (end to start), and with it the direction of the turn.
  if (f.axis.flip === true) direction = [-direction[0], -direction[1], -direction[2]];
  return { origin, direction };
}

function patternCount(ctx: TranslateContext): number {
  const count = value(ctx, 'layout', 'count');
  if (!Number.isInteger(count)) {
    throw new Failed([
      {
        code: 'invalid',
        field: ['layout', 'count'],
        message: `The count must be a whole number (it is ${count})`,
      },
    ]);
  }
  if (count < 1 || count > MAX_PATTERN_COUNT) {
    throw new Failed([
      {
        code: 'invalid',
        field: ['layout', 'count'],
        message: `The count must be 1 to ${MAX_PATTERN_COUNT}, the original included (it is ${count})`,
      },
    ]);
  }
  return count;
}

function instanceSource(ctx: TranslateContext, f: PatternFeature | MirrorFeature): InstanceSource {
  if (f.body === true)
    return f.mode === undefined ? { type: 'body' } : { type: 'body', mode: f.mode };
  const tools: ToolInput[] = [];
  const errors: RegenError[] = [];
  for (const id of f.features) {
    const input = ctx.inputs.get(id);
    if (!input && ctx.references?.has(id)) {
      errors.push({
        code: 'unsupported',
        field: ['features'],
        message: `${id} is a reference body, not part of the body: it cannot be repeated`,
      });
      continue;
    }
    if (!input) {
      // Not a single kernel feature: an extension (which may build several inputs) or a sketch.
      errors.push({
        code: 'unsupported',
        field: ['features'],
        message: `${id} is not a kernel feature of its own: only extrudes, revolves and holes can be repeated (or the whole body)`,
      });
      continue;
    }
    if (input.kind === 'extrude' || input.kind === 'revolve' || input.kind === 'hole') {
      tools.push(input);
    } else {
      errors.push({
        code: 'unsupported',
        field: ['features'],
        message: `${id} is a ${input.kind}: only extrudes, revolves and holes can be repeated (or the whole body)`,
      });
    }
  }
  if (errors.length > 0) throw new Failed(errors);
  return { type: 'features', features: tools };
}

function holeInput(ctx: TranslateContext, f: Extract<Feature, { kind: 'hole' }>): HoleInput {
  const sketch = sketchOf(ctx, f.sketch);
  const byId = new Map(sketch.entities.map((e) => [e.id, e]));
  const missing = f.points.filter((p) => !byId.has(p));
  if (missing.length > 0) {
    throw new Failed([
      {
        code: 'reference-lost',
        referenceId: 'points',
        missing,
        message: `The hole points ${missing.join(', ')} are no longer in ${f.sketch}: re-pick them`,
      },
    ]);
  }
  const points = f.points.map((id) => {
    const e = byId.get(id)!;
    if (e.kind !== 'point') {
      throw new Failed([
        {
          code: 'invalid',
          field: ['points'],
          message: `${id} is a ${e.kind}, not a point`,
        },
      ]);
    }
    return { id, at: e.position };
  });
  const diameter = value(ctx, 'diameter');
  positive(diameter, ['diameter'], 'The diameter');
  let head: HoleHead;
  switch (f.head.type) {
    case 'simple':
      head = { type: 'simple' };
      break;
    case 'counterbore':
      head = {
        type: 'counterbore',
        diameter: value(ctx, 'head', 'diameter'),
        depth: value(ctx, 'head', 'depth'),
      };
      break;
    case 'countersink':
      head = {
        type: 'countersink',
        diameter: value(ctx, 'head', 'diameter'),
        angle: value(ctx, 'head', 'angle'),
      };
      break;
  }
  const { placement } = sketch;
  return {
    kind: 'hole',
    id: f.id,
    frame: { origin: placement.origin, xDir: placement.xDir, normal: placement.normal },
    points,
    diameter,
    extent:
      f.extent.type === 'blind'
        ? { type: 'blind', depth: value(ctx, 'extent', 'depth') }
        : { type: 'throughAll' },
    head,
  };
}

/**
 * A thread on a face: the size from the kernel's table (an unknown one is `invalid` on
 * `standard.size`), the length and the clearance evaluated. Core's clearance is diametral, like
 * the fit variables; the kernel's is radial, so it gets half. Everything about the face (axis,
 * side, radius, the range of radii the size can be cut into, the ends) is the kernel's to
 * resolve, since only the kernel sees the body (`ThreadFaceInput`).
 */
function threadInput(ctx: TranslateContext, f: ThreadFeature): ThreadFaceInput {
  const size = threadSize(f.standard.system, f.standard.size);
  if (size === undefined) {
    const system = f.standard.system === 'unc' ? 'UNC' : 'ISO metric coarse';
    throw new Failed([
      {
        code: 'invalid',
        field: ['standard', 'size'],
        message: `${f.standard.size} is not an ${system} thread size this version knows`,
      },
    ]);
  }
  const clearance = value(ctx, 'clearance');
  if (!(clearance >= 0)) {
    throw new Failed([
      { code: 'invalid', field: ['clearance'], message: 'The clearance must not be negative' },
    ]);
  }
  let length: number | 'full' = 'full';
  if (f.length !== 'full') {
    length = value(ctx, 'length');
    positive(length, ['length'], 'The length');
  }
  const input: ThreadFaceInput = {
    kind: 'thread',
    id: f.id,
    face: { id: f.face.id, ref: faceRef(f.face.ref) },
    length,
    major: size.major,
    pitch: size.pitch,
    tapDrill: size.tapDrill,
    hand: f.hand,
    clearance: clearance / 2,
    representation: f.representation,
    label: size.size,
  };
  if (f.start !== undefined) input.start = { id: f.start.id, ref: edgeRef(f.start.ref) };
  return input;
}

/**
 * A STEP import that joins the body: the kernel reads the file (the document's base64 text, passed
 * as is) and names its faces `import#k:face:<n>`. A reference import, and every STL import (a
 * mesh, always a reference), is not part of the body: the engine keeps it out of the kernel.
 */
function importInput(f: ImportFeature): FeatureInput {
  if (f.operation === 'reference' || f.source.format !== 'step') {
    throw new Error('a reference import is not a kernel feature');
  }
  return { kind: 'import', id: f.id, step: f.source.data, mode: MODES[f.operation] };
}

/** A scope that names only bodies that exist here, or the `reference-lost` error on `scope`. */
function checkScope(f: Feature, ctx: TranslateContext): void {
  if (ctx.bodies === undefined || !('scope' in f) || f.scope === undefined) return;
  const missing = f.scope.filter((id) => !ctx.bodies!.has(id));
  if (missing.length === 0) return;
  throw new Failed([
    {
      code: 'reference-lost',
      referenceId: 'scope',
      missing,
      message: `${f.id} acts on ${missing.join(', ')}, which ${missing.length === 1 ? 'is not a body' : 'are not bodies'} at this point (merged into another, or never made): re-pick the bodies`,
    },
  ]);
}

/**
 * The scope and body id of a kernel input: `scope` as stored (absent: every body), and for a
 * feature that can make a body the id it makes it under, its own id (M2 plan, decision 1).
 */
function withBodies<T extends FeatureInput>(f: Feature, input: T): T {
  const out = input as T & { scope?: readonly string[]; body?: string };
  if ('scope' in f && f.scope !== undefined) out.scope = [...f.scope];
  if (
    (f.kind === 'extrude' || f.kind === 'revolve' || f.kind === 'import') &&
    (f.operation === 'new' || f.operation === 'add')
  ) {
    out.body = f.id;
  }
  return out;
}

function translateOrThrow(f: Feature, ctx: TranslateContext): FeatureInput {
  checkScope(f, ctx);
  return withBodies(f, translateInput(f, ctx));
}

function translateInput(f: Feature, ctx: TranslateContext): FeatureInput {
  switch (f.kind) {
    case 'extrude': {
      const p = profileOf(f.profile.sketch, sketchOf(ctx, f.profile.sketch), f.profile.entities);
      if (!p.ok) throw new Failed([p.error]);
      const input: FeatureInput = {
        kind: 'extrude',
        id: f.id,
        profile: p.profile,
        extent:
          f.extent.type === 'blind' || f.extent.type === 'symmetric'
            ? { type: f.extent.type, distance: value(ctx, 'extent', 'distance') }
            : f.extent.type === 'throughAll'
              ? { type: 'throughAll' }
              : { type: 'upToFace', face: faceRef(f.extent.face.ref) },
        mode: MODES[f.operation],
      };
      if (f.reverse) input.reverse = true;
      if (f.draft !== undefined) input.draft = value(ctx, 'draft');
      return input;
    }
    case 'revolve': {
      const p = profileOf(f.profile.sketch, sketchOf(ctx, f.profile.sketch), f.profile.entities);
      if (!p.ok) throw new Failed([p.error]);
      const input: RevolveInput = {
        kind: 'revolve',
        id: f.id,
        profile: p.profile,
        axis: revolveAxis(ctx, f),
        angle: value(ctx, 'angle'),
        mode: MODES[f.operation],
      };
      if (f.symmetric) input.symmetric = true;
      return input;
    }
    case 'fillet': {
      const radius = value(ctx, 'radius');
      return {
        kind: 'fillet',
        id: f.id,
        radius,
        edges: f.edges.map((e) => ({ id: e.id, ref: edgeRef(e.ref) })),
      };
    }
    case 'chamfer': {
      const distance = value(ctx, 'distance');
      return {
        kind: 'chamfer',
        id: f.id,
        size:
          f.secondDistance !== undefined
            ? { kind: 'distances', distance, distance2: value(ctx, 'secondDistance') }
            : f.angle !== undefined
              ? { kind: 'distance-angle', distance, angle: value(ctx, 'angle') }
              : { kind: 'distance', distance },
        edges: f.edges.map((e) => ({ id: e.id, ref: edgeRef(e.ref) })),
      };
    }
    case 'shell': {
      const input: FeatureInput = {
        kind: 'shell',
        id: f.id,
        thickness: value(ctx, 'thickness'),
        faces: f.faces.map((r) => ({ id: r.id, ref: faceRef(r.ref) })),
      };
      if (f.outward) input.outward = true;
      return input;
    }
    case 'hole':
      return holeInput(ctx, f);
    case 'pattern': {
      const count = patternCount(ctx);
      const source = instanceSource(ctx, f);
      if (f.layout.type === 'linear') {
        const direction: { ref: TopoRef; flip?: boolean } = {
          ref: topoRef(f.layout.direction.ref),
        };
        if (f.layout.flip !== undefined) direction.flip = f.layout.flip;
        return {
          kind: 'pattern',
          id: f.id,
          source,
          layout: { type: 'linear', direction, count, spacing: value(ctx, 'layout', 'spacing') },
        };
      }
      const axis: { ref: TopoRef; flip?: boolean } = { ref: topoRef(f.layout.axis.ref) };
      if (f.layout.flip !== undefined) axis.flip = f.layout.flip;
      return {
        kind: 'pattern',
        id: f.id,
        source,
        layout: { type: 'circular', axis, count, angle: value(ctx, 'layout', 'angle') },
      };
    }
    case 'mirror':
      return {
        kind: 'mirror',
        id: f.id,
        source: instanceSource(ctx, f),
        plane: faceRef(f.plane.ref),
      };
    case 'import':
      return importInput(f);
    case 'derived': {
      const sources = ctx.sources?.get(f.id);
      if (sources === undefined || sources.length === 0) {
        throw new Failed([
          { code: 'source', field: ['source'], message: `${f.id}: its source was not built` },
        ]);
      }
      const v = (field: 'translation' | 'rotation') =>
        [0, 1, 2].map((i) => value(ctx, 'placement', field, i)) as [number, number, number];
      return {
        kind: 'derive',
        id: f.id,
        sources: sources.map((b) => ({ id: b.id, shape: b.shape })),
        rotation: v('rotation'),
        translation: v('translation'),
        mode: MODES[f.operation],
      };
    }
    case 'thread':
      return threadInput(ctx, f);
    case 'sketch':
    case 'extension':
      throw new Error(`${f.kind} features are not kernel features`);
  }
}

/** The kernel input for a kernel feature (not sketches or extensions). */
export function translateFeature(feature: Feature, ctx: TranslateContext): Translation {
  try {
    return { ok: true, input: translateOrThrow(feature, ctx) };
  } catch (error) {
    if (error instanceof Failed) return { ok: false, errors: error.errors };
    throw error;
  }
}

/**
 * Kernel errors name a reference by its id, or by the field that holds it (`extent`, `axis`,
 * `direction`, `plane`). The core reference id of such a field, so the UI can offer a re-pick.
 */
export function referenceIdOf(feature: Feature, kernelRef: string): string {
  switch (feature.kind) {
    case 'extrude':
      if (kernelRef === 'extent' && feature.extent.type === 'upToFace')
        return feature.extent.face.id;
      break;
    case 'revolve':
      if (kernelRef === 'axis' && feature.axis.type === 'edge') return feature.axis.edge.id;
      break;
    case 'pattern':
      if (kernelRef === 'direction' && feature.layout.type === 'linear') {
        return feature.layout.direction.id;
      }
      if (kernelRef === 'axis' && feature.layout.type === 'circular') return feature.layout.axis.id;
      break;
    case 'mirror':
      if (kernelRef === 'plane') return feature.plane.id;
      break;
    default:
      break;
  }
  return kernelRef;
}
