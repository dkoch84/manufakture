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
  type MirrorFeature,
  type PatternFeature,
  type RevolveFeature,
} from '@manufakture/core';
import type {
  EdgeRef,
  FaceRef,
  FeatureInput,
  HoleHead,
  HoleInput,
  InstanceSource,
  ResultMode,
  RevolveInput,
  TopoRef,
  ToolInput,
} from '@manufakture/kernel';
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
  if (f.body === true) return { type: 'body' };
  const tools: ToolInput[] = [];
  const errors: RegenError[] = [];
  for (const id of f.features) {
    const input = ctx.inputs.get(id);
    if (!input) throw new Error(`no kernel input for ${id}`);
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

function translateOrThrow(f: Feature, ctx: TranslateContext): FeatureInput {
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
