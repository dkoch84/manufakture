// The `ctx` a scripted feature's `run(ctx, params)` receives (ADR 0010 decision 6), per script API
// version. The functions here are host functions: the sandbox (`@manufakture/script`) hands them
// the script's arguments as plain data and handles, and every one of them reaches the kernel, so
// every argument is validated as untrusted input before anything is built: counts are bounded,
// numbers finite and in range, ids well formed and unique, and handles of the expected kind and
// still live (known body ids only). A malformed call throws `ScriptHostError`, which the script
// sees as an ordinary, catchable `Error`; so does a kernel operation that fails.
//
// A script run is one `ScriptRun`: the part's bodies as they were before the feature, changed
// operation by operation through the kernel's own part features (`applyFeature`), so every face
// is named by the same rules as the GUI features. Each operation is applied under a temporary
// feature id (`scriptop#1000001`, unique in the run) and its names are then rewritten to the
// operation's prefix, `<feature id>:<operation id>/` (`scripted#2:boss/cap:end`), before the next
// operation sees them; a face born in the script thus carries only a role and the script's own
// local id, and faces of earlier features keep their names.
//
// API versions are a promise (ADR 0010 amendment, item 12): a script written against a version
// runs unchanged, with the same results, forever. Within a version only additions that cannot
// change what an existing script sees are allowed; anything else is a new version, and the old
// one stays in `SCRIPT_APIS`.

import { SCRIPT_OPERATION_ID_PATTERN, scriptOperationPrefix } from '@manufakture/core';
import {
  MAX_PATTERN_COUNT,
  applyFeature,
  nameShape,
  resolveReferences,
  sketchFrame,
  type EdgeRef,
  type FaceName,
  type FaceRef,
  type FeatureBody,
  type FeatureInput,
  type FeatureOutcome,
  type FeatureWarning,
  type Frame,
  type Kernel,
  type Names,
  type ProfileEntity,
  type ProfileLoop,
  type ShapeId,
  type SketchProfile,
  type ToolInput,
  type Transform,
  type Vec2,
  type Vec3,
} from '@manufakture/kernel';
import {
  ScriptHandle,
  ScriptHostError,
  kernelOp,
  type HostApi,
  type ScriptValue,
} from '@manufakture/script';
import { XY_PLANE, XZ_PLANE, YZ_PLANE, placementFromNormal } from '@manufakture/sketch';
import type { ReferenceResolution, RegenWarning } from './types';

/** Coordinates and sizes a script may pass, in mm: a kilometre either way. */
export const MAX_COORDINATE = 1e6;
/** Entities in one sketch, over all its loops. */
export const MAX_SKETCH_ENTITIES = 10_000;
/** Loops in one sketch, over all its regions. */
export const MAX_SKETCH_LOOPS = 2_000;
/** Edges, faces or bodies one call may name. */
export const MAX_HANDLES_PER_CALL = 1_000;
/** Control points of one Bezier. */
const MAX_BEZIER_POINTS = 4;
/** A script's local ids (sketch entity ids): the same rule as operation ids. */
export const SCRIPT_LOCAL_ID_PATTERN = SCRIPT_OPERATION_ID_PATTERN;
/** The temporary feature kind script operations run under before their names are rewritten. */
const TEMP_KIND = 'scriptop';
/** Temporary ids are 7 digits wide, so their order is their run order. */
const TEMP_BASE = 1_000_000;

/** What an operation handle holds. */
interface OpRecord {
  id: string;
  kind: string;
  prefix: string;
  temp: string;
  /** Bodies it made or changed, as they are after it. */
  bodies: string[];
  /** The kernel input, for extrudes and revolves (what a pattern of features rebuilds). */
  tool?: ToolInput;
}

interface FaceValue {
  body: string;
  name: string;
}

interface EdgeValue {
  body: string;
  ref: EdgeRef;
}

/** The outcome of a whole script run, as one feature outcome of the part. */
export interface ScriptRunOutcome {
  outcome: FeatureOutcome;
  /** Shapes the run made that the caller owns from now on (created and changed bodies). */
  keep: ShapeId[];
  warnings: RegenWarning[];
}

/** A plain object (not an array, not a handle). */
function isRecord(v: ScriptValue | undefined): v is { [key: string]: ScriptValue } {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof ScriptHandle);
}

function fail(message: string): never {
  throw new ScriptHostError(message);
}

/** One script run against the part's bodies (see the module comment). */
export class ScriptRun {
  readonly kernel: Kernel;
  readonly featureId: string;
  /** The body set now, in creator order. */
  bodies: FeatureBody[];
  readonly #initial: ReadonlyMap<string, ShapeId>;
  readonly #ops = new Map<string, OpRecord>();
  readonly #temps = new Map<string, string>();
  readonly #warnings: RegenWarning[] = [];
  #nextTemp = TEMP_BASE + 1;

  constructor(kernel: Kernel, featureId: string, bodies: readonly FeatureBody[]) {
    this.kernel = kernel;
    this.featureId = featureId;
    this.bodies = bodies.map((b) => ({ id: b.id, shape: b.shape }));
    this.#initial = new Map(this.bodies.map((b) => [b.id, b.shape]));
  }

  // Parameters ---------------------------------------------------------------------------------

  /**
   * A stored reference of a `reference` parameter as a handle, resolved on the bodies before the
   * feature: a face, an edge, or the body owning a face (`select: 'body'`). Null when it does
   * not resolve; `resolution` says how it did.
   */
  referenceHandle(
    ref: FaceRef | EdgeRef,
    select: 'face' | 'edge' | 'vertex' | 'body',
  ):
    | {
        ok: true;
        handle: ScriptHandle;
        target: string;
        via: ReferenceResolution['via'];
        fragile: boolean;
      }
    | { ok: false; message: string; missing: string[]; candidates: string[] } {
    const isFace = 'face' in ref;
    if (select === 'vertex' || (select === 'edge' && isFace) || (select !== 'edge' && !isFace)) {
      return {
        ok: false,
        message: `a ${isFace ? 'face' : 'edge'} cannot be passed as a ${select}`,
        missing: [],
        candidates: [],
      };
    }
    let missing: string[] = [];
    let candidates: string[] = [];
    for (const b of this.bodies) {
      const [report] = resolveReferences(this.kernel, b.shape, [ref]);
      if (report === undefined) continue;
      if (!report.ok) {
        if (report.status === 'lost') missing = report.missing;
        if (report.status === 'ambiguous') candidates = report.candidates;
        continue;
      }
      const names = this.#names(b.shape);
      const via = report.via;
      const fragile = report.fragile;
      if (isFace) {
        const name = names.faces[report.index - 1]!.name;
        const handle =
          select === 'body'
            ? new ScriptHandle('body', b.id)
            : new ScriptHandle<FaceValue>('face', { body: b.id, name });
        return { ok: true, handle, target: name, via, fragile };
      }
      const e = names.edges[report.index - 1]!;
      const value: EdgeValue = { body: b.id, ref: edgeRefOf(e) };
      return { ok: true, handle: new ScriptHandle('edge', value), target: e.name, via, fragile };
    }
    return { ok: false, message: 'it no longer resolves', missing, candidates };
  }

  // Results ------------------------------------------------------------------------------------

  /** What the run did to the part's bodies, as one feature outcome. */
  finish(): ScriptRunOutcome {
    const after = new Set(this.bodies.map((b) => b.id));
    const created = this.bodies.filter((b) => !this.#initial.has(b.id)).map((b) => b.id);
    const changed = this.bodies
      .filter((b) => this.#initial.has(b.id) && this.#initial.get(b.id) !== b.shape)
      .map((b) => b.id);
    const consumed = [...this.#initial.keys()].filter((id) => !after.has(id));
    const made = new Set([...created, ...changed]);
    const outcome: FeatureOutcome = {
      featureId: this.featureId,
      kind: 'scripted',
      ok: true,
      bodies: this.bodies.map((b) => ({
        id: b.id,
        shape: b.shape,
        names: this.kernel.named(b.shape)?.names ?? null,
        solids: this.kernel.solids(b.shape),
      })),
      created,
      changed,
      consumed,
      errors: [],
      warnings: [],
      resolved: [],
    };
    return {
      outcome,
      keep: this.bodies.filter((b) => made.has(b.id)).map((b) => b.shape),
      warnings: [...this.#warnings],
    };
  }

  // Operations ---------------------------------------------------------------------------------

  /** Claim an operation id: well formed and not used before in this run. */
  #claim(id: ScriptValue | undefined, kind: string): OpRecord {
    if (typeof id !== 'string' || !SCRIPT_OPERATION_ID_PATTERN.test(id)) {
      fail(
        `${kind}: the operation id must be a lower-case letter followed by letters, digits or _, at most 64 characters (got ${describe(id)})`,
      );
    }
    if (this.#ops.has(id)) fail(`${kind}: the operation id '${id}' is used twice`);
    const temp = `${TEMP_KIND}#${this.#nextTemp++}`;
    const record: OpRecord = {
      id,
      kind,
      prefix: scriptOperationPrefix(this.featureId, id),
      temp,
      bodies: [],
    };
    this.#ops.set(id, record);
    this.#temps.set(temp, record.prefix);
    return record;
  }

  /** A sketch: plain data, no kernel work (the profile is swept by the operation that uses it). */
  sketch(id: ScriptValue | undefined, spec: ScriptValue | undefined): ScriptHandle {
    const op = this.#claim(id, 'sketch');
    if (!isRecord(spec)) fail(`sketch ${op.id}: expected { plane, loops } or { plane, regions }`);
    known(spec, ['plane', 'loops', 'regions'], `sketch ${op.id}`);
    const frame = this.#plane(spec.plane, `sketch ${op.id}`);
    let regions: ScriptValue[];
    if (spec.regions !== undefined) {
      if (spec.loops !== undefined) fail(`sketch ${op.id}: give loops or regions, not both`);
      regions = list(spec.regions, `sketch ${op.id}: regions`, 1, MAX_SKETCH_LOOPS);
    } else {
      regions = [spec.loops ?? null];
    }
    let entities = 0;
    let loopCount = 0;
    const out: { loops: ProfileLoop[] }[] = regions.map((region, ri) => {
      const where = `sketch ${op.id}: ${spec.regions !== undefined ? `regions[${ri}]` : 'loops'}`;
      const loops = list(region, where, 1, MAX_SKETCH_LOOPS);
      const ids = new Set<string>();
      return {
        loops: loops.map((loop, li) => {
          loopCount++;
          if (loopCount > MAX_SKETCH_LOOPS)
            fail(`sketch ${op.id}: more than ${MAX_SKETCH_LOOPS} loops`);
          const items = list(loop, `${where}[${li}]`, 1, MAX_SKETCH_ENTITIES);
          entities += items.length;
          if (entities > MAX_SKETCH_ENTITIES) {
            fail(`sketch ${op.id}: more than ${MAX_SKETCH_ENTITIES} entities`);
          }
          return {
            entities: items.map((item, ei) => {
              const e = entity(item, `${where}[${li}][${ei}]`);
              if (ids.has(e.id!)) fail(`${where}: the entity id '${e.id}' is used twice`);
              ids.add(e.id!);
              return e;
            }),
          };
        }),
      };
    });
    const profile: SketchProfile =
      out.length === 1 ? { frame, loops: out[0]!.loops } : { frame, regions: out };
    return new ScriptHandle('sketch', profile);
  }

  extrude(
    id: ScriptValue | undefined,
    sketch: ScriptValue | undefined,
    options: ScriptValue | undefined,
  ): ScriptHandle {
    const op = this.#claim(id, 'extrude');
    const where = `extrude ${op.id}`;
    const profile = handleOf<SketchProfile>(sketch, 'sketch', `${where}: the sketch`);
    const o =
      options === undefined
        ? {}
        : isRecord(options)
          ? options
          : fail(`${where}: options must be an object`);
    known(o, ['distance', 'symmetric', 'through', 'reverse', 'draft', 'mode', 'bodies'], where);
    const mode = modeOf(o.mode, where);
    const symmetric = flag(o.symmetric, `${where}: symmetric`);
    const through = flag(o.through, `${where}: through`);
    if (through && symmetric) fail(`${where}: through and symmetric cannot be combined`);
    if (through && mode === 'new') fail(`${where}: a new body cannot go through all`);
    const extent = through
      ? ({ type: 'throughAll' } as const)
      : ({
          type: symmetric ? 'symmetric' : 'blind',
          distance: positive(o.distance, `${where}: distance`),
        } as const);
    const draft =
      o.draft === undefined ? undefined : angleIn(o.draft, `${where}: draft`, Math.PI / 2, true);
    const input: ToolInput = {
      kind: 'extrude',
      id: op.temp,
      profile,
      extent,
      mode,
      ...(flag(o.reverse, `${where}: reverse`) ? { reverse: true } : {}),
      ...(draft === undefined || draft === 0 ? {} : { draft }),
      ...this.#scope(o.bodies, where, mode),
      ...(mode === 'new' || mode === 'add' ? { body: this.#bodyId(op) } : {}),
    };
    op.tool = input;
    return this.#apply(op, input);
  }

  revolve(
    id: ScriptValue | undefined,
    sketch: ScriptValue | undefined,
    options: ScriptValue | undefined,
  ): ScriptHandle {
    const op = this.#claim(id, 'revolve');
    const where = `revolve ${op.id}`;
    const profile = handleOf<SketchProfile>(sketch, 'sketch', `${where}: the sketch`);
    if (!isRecord(options)) fail(`${where}: options must be an object with an axis`);
    known(options, ['axis', 'angle', 'symmetric', 'mode', 'bodies'], where);
    const mode = modeOf(options.mode, where);
    const input: ToolInput = {
      kind: 'revolve',
      id: op.temp,
      profile,
      axis: axisOf(options.axis, `${where}: axis`),
      angle:
        options.angle === undefined
          ? 2 * Math.PI
          : angleIn(options.angle, `${where}: angle`, 2 * Math.PI),
      mode,
      ...(flag(options.symmetric, `${where}: symmetric`) ? { symmetric: true } : {}),
      ...this.#scope(options.bodies, where, mode),
      ...(mode === 'new' || mode === 'add' ? { body: this.#bodyId(op) } : {}),
    };
    op.tool = input;
    return this.#apply(op, input);
  }

  fillet(
    id: ScriptValue | undefined,
    edges: ScriptValue | undefined,
    radius: ScriptValue | undefined,
  ): ScriptHandle {
    const op = this.#claim(id, 'fillet');
    const where = `fillet ${op.id}`;
    return this.#apply(op, {
      kind: 'fillet',
      id: op.temp,
      radius: positive(radius, `${where}: radius`),
      edges: this.#edges(edges, where),
      nameByFaces: true,
    });
  }

  chamfer(
    id: ScriptValue | undefined,
    edges: ScriptValue | undefined,
    distance: ScriptValue | undefined,
  ): ScriptHandle {
    const op = this.#claim(id, 'chamfer');
    const where = `chamfer ${op.id}`;
    return this.#apply(op, {
      kind: 'chamfer',
      id: op.temp,
      size: { kind: 'distance', distance: positive(distance, `${where}: distance`) },
      edges: this.#edges(edges, where),
      nameByFaces: true,
    });
  }

  shell(
    id: ScriptValue | undefined,
    faces: ScriptValue | undefined,
    thickness: ScriptValue | undefined,
    options: ScriptValue | undefined,
  ): ScriptHandle {
    const op = this.#claim(id, 'shell');
    const where = `shell ${op.id}`;
    const o =
      options === undefined
        ? {}
        : isRecord(options)
          ? options
          : fail(`${where}: options must be an object`);
    known(o, ['outward'], where);
    const list =
      faces === undefined || faces === null
        ? []
        : handles<FaceValue>(faces, 'face', `${where}: faces`, 0);
    return this.#apply(op, {
      kind: 'shell',
      id: op.temp,
      thickness: positive(thickness, `${where}: thickness`),
      faces: list.map((f, i) => ({
        id: `f${i + 1}`,
        ref: { face: this.#liveFace(f, where).name },
      })),
      ...(flag(o.outward, `${where}: outward`) ? { outward: true } : {}),
    });
  }

  boolean(
    id: ScriptValue | undefined,
    kind: ScriptValue | undefined,
    targets: ScriptValue | undefined,
    tools: ScriptValue | undefined,
  ): ScriptHandle {
    const op = this.#claim(id, 'boolean');
    const where = `boolean ${op.id}`;
    const mode =
      kind === 'union'
        ? 'add'
        : kind === 'subtract'
          ? 'subtract'
          : kind === 'intersect'
            ? 'intersect'
            : null;
    if (mode === null) fail(`${where}: the kind must be 'union', 'subtract' or 'intersect'`);
    const scope = this.#bodyList(targets, `${where}: targets`, 1);
    const toolIds = this.#bodyList(tools, `${where}: tools`, 1);
    if (toolIds.some((t) => scope.includes(t)))
      fail(`${where}: a body cannot be a target and a tool`);
    return this.#apply(op, { kind: 'combine', id: op.temp, tools: toolIds, scope, mode });
  }

  pattern(
    id: ScriptValue | undefined,
    source: ScriptValue | undefined,
    layout: ScriptValue | undefined,
  ): ScriptHandle {
    const op = this.#claim(id, 'pattern');
    const where = `pattern ${op.id}`;
    if (!isRecord(layout)) fail(`${where}: the layout must be { linear } or { circular }`);
    known(layout, ['linear', 'circular', 'mode'], where);
    let input: FeatureInput;
    const src = this.#instanceSource(source, layout.mode, where);
    if (layout.linear !== undefined) {
      if (layout.circular !== undefined) fail(`${where}: give linear or circular, not both`);
      const l = isRecord(layout.linear)
        ? layout.linear
        : fail(`${where}: linear must be an object`);
      known(l, ['direction', 'count', 'spacing'], `${where}: linear`);
      input = {
        kind: 'pattern',
        id: op.temp,
        ...src,
        layout: {
          type: 'linear',
          direction: direction(l.direction, `${where}: linear.direction`),
          count: count(l.count, `${where}: linear.count`),
          spacing: finiteIn(l.spacing, `${where}: linear.spacing`, MAX_COORDINATE),
        },
      };
    } else {
      const c = isRecord(layout.circular)
        ? layout.circular
        : fail(`${where}: circular must be an object`);
      known(c, ['axis', 'count', 'angle'], `${where}: circular`);
      input = {
        kind: 'pattern',
        id: op.temp,
        ...src,
        layout: {
          type: 'circular',
          axis: axisOf(c.axis, `${where}: circular.axis`),
          count: count(c.count, `${where}: circular.count`),
          angle:
            c.angle === undefined
              ? 2 * Math.PI
              : angleIn(c.angle, `${where}: circular.angle`, 2 * Math.PI),
        },
      };
    }
    return this.#apply(op, input);
  }

  mirror(
    id: ScriptValue | undefined,
    source: ScriptValue | undefined,
    plane: ScriptValue | undefined,
    options: ScriptValue | undefined,
  ): ScriptHandle {
    const op = this.#claim(id, 'mirror');
    const where = `mirror ${op.id}`;
    const o =
      options === undefined
        ? {}
        : isRecord(options)
          ? options
          : fail(`${where}: options must be an object`);
    known(o, ['mode'], where);
    const p = this.#mirrorPlane(plane, where);
    return this.#apply(op, {
      kind: 'mirror',
      id: op.temp,
      ...this.#instanceSource(source, o.mode, where),
      plane: p,
    });
  }

  transform(
    id: ScriptValue | undefined,
    bodies: ScriptValue | undefined,
    motion: ScriptValue | undefined,
  ): ScriptHandle {
    const op = this.#claim(id, 'transform');
    const where = `transform ${op.id}`;
    const ids = this.#bodyList(bodies, `${where}: bodies`, 1);
    if (!isRecord(motion))
      fail(`${where}: the motion must be { translate }, { rotate } or { mirror }`);
    known(motion, ['translate', 'rotate', 'mirror'], where);
    const given = ['translate', 'rotate', 'mirror'].filter((k) => motion[k] !== undefined);
    if (given.length !== 1) fail(`${where}: give exactly one of translate, rotate or mirror`);
    let m: Transform;
    if (motion.translate !== undefined) {
      m = { kind: 'translate', vector: vec3(motion.translate, `${where}: translate`) };
    } else if (motion.rotate !== undefined) {
      const r = isRecord(motion.rotate)
        ? motion.rotate
        : fail(`${where}: rotate must be { axis, angle }`);
      known(r, ['axis', 'angle'], `${where}: rotate`);
      m = {
        kind: 'rotate',
        axis: axisOf(r.axis, `${where}: rotate.axis`),
        angle: finiteIn(r.angle, `${where}: rotate.angle`, 1e3),
      };
    } else {
      m = { kind: 'mirror', plane: planeOf(motion.mirror, `${where}: mirror`) };
    }
    return this.#apply(op, { kind: 'move', id: op.temp, bodies: ids, motion: m });
  }

  // Queries ------------------------------------------------------------------------------------

  /** Bodies: all of them now, or those an operation made or changed that are still there. */
  bodiesOf(target: ScriptValue | undefined): ScriptHandle[] {
    if (target === undefined || target === null)
      return this.bodies.map((b) => new ScriptHandle('body', b.id));
    const op = handleOf<OpRecord>(target, 'op', 'bodies: the target');
    return this.bodies
      .filter((b) => op.bodies.includes(b.id))
      .map((b) => new ScriptHandle('body', b.id));
  }

  /** Faces of an operation (born in it), a body, or every body; filtered, sorted by name. */
  faces(target: ScriptValue | undefined, filter: ScriptValue | undefined): ScriptHandle[] {
    const f =
      filter === undefined
        ? {}
        : isRecord(filter)
          ? filter
          : fail('faces: the filter must be an object');
    known(f, ['surface', 'normal', 'role'], 'faces');
    const surface = f.surface === undefined ? undefined : word(f.surface, 'faces: surface');
    const role = f.role === undefined ? undefined : word(f.role, 'faces: role');
    const normal = f.normal === undefined ? undefined : unit(direction(f.normal, 'faces: normal'));
    const { bodies, prefix } = this.#target(target, 'faces');
    const out: { name: string; body: string }[] = [];
    for (const b of bodies) {
      const named = this.kernel.named(b.shape);
      if (named === null) continue;
      named.names.faces.forEach((face, i) => {
        if (prefix !== null && !face.name.startsWith(prefix)) return;
        if (role !== undefined && roleOf(face.name, prefix) !== role) return;
        const info = named.topology.faces[i]!;
        if (surface !== undefined && info.surface !== surface) return;
        if (normal !== undefined) {
          if (info.normal === null) return;
          const n = unit(info.normal);
          if (
            Math.abs(n[0] - normal[0]) + Math.abs(n[1] - normal[1]) + Math.abs(n[2] - normal[2]) >
            1e-6
          )
            return;
        }
        out.push({ name: face.name, body: b.id });
      });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out.map((v) => new ScriptHandle<FaceValue>('face', v));
  }

  /**
   * Edges of an operation (a face of theirs born in it), of a face, of a body, or of every body;
   * filtered, sorted by name.
   */
  edges(target: ScriptValue | undefined, filter: ScriptValue | undefined): ScriptHandle[] {
    const f =
      filter === undefined
        ? {}
        : isRecord(filter)
          ? filter
          : fail('edges: the filter must be an object');
    known(f, ['curve', 'direction'], 'edges');
    const curve = f.curve === undefined ? undefined : word(f.curve, 'edges: curve');
    const dir =
      f.direction === undefined ? undefined : unit(direction(f.direction, 'edges: direction'));
    let bodies: FeatureBody[];
    let keep: (faces: readonly string[]) => boolean;
    if (target instanceof ScriptHandle && target.kind === 'face') {
      const face = this.#liveFace(target.value as FaceValue, 'edges');
      bodies = this.bodies.filter((b) => b.id === face.body);
      keep = (faces) => faces.includes(face.name);
    } else {
      const t = this.#target(target, 'edges');
      bodies = t.bodies;
      const prefix = t.prefix;
      keep = (faces) => prefix === null || faces.some((n) => n.startsWith(prefix));
    }
    const out: { name: string; value: EdgeValue }[] = [];
    for (const b of bodies) {
      const named = this.kernel.named(b.shape);
      if (named === null) continue;
      named.names.edges.forEach((e, i) => {
        if (!keep(e.faces)) return;
        const info = named.topology.edges[i]!;
        if (curve !== undefined && info.curve !== curve) return;
        if (dir !== undefined) {
          if (info.curve !== 'line') return;
          const g = this.kernel.geometry(b.shape, { kind: 'edge', index: i + 1 });
          if (g === null) return;
          const d = unit(g.direction);
          if (Math.abs(Math.abs(d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2]) - 1) > 1e-9) return;
        }
        out.push({ name: e.name, value: { body: b.id, ref: edgeRefOf(e) } });
      });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out.map((e) => new ScriptHandle<EdgeValue>('edge', e.value));
  }

  /** The face's name, as references to it are stored. */
  nameOf(target: ScriptValue | undefined): string {
    if (target instanceof ScriptHandle && target.kind === 'face')
      return this.#liveFace(target.value as FaceValue, 'name').name;
    if (target instanceof ScriptHandle && target.kind === 'body')
      return this.#liveBody(target.value as string, 'name').id;
    return fail('name: expected a face or a body');
  }

  // Measurements -------------------------------------------------------------------------------

  volume(target: ScriptValue | undefined): number {
    return this.#measureBodies(target, 'measure.volume').reduce(
      (s, b) => s + this.kernel.properties(b.shape).volume,
      0,
    );
  }

  area(target: ScriptValue | undefined): number {
    if (target instanceof ScriptHandle && target.kind === 'face') {
      const { info } = this.#faceInfo(target, 'measure.area');
      return info.area;
    }
    return this.#measureBodies(target, 'measure.area').reduce(
      (s, b) => s + this.kernel.properties(b.shape).area,
      0,
    );
  }

  bounds(target: ScriptValue | undefined): ScriptValue {
    let min: Vec3 | null = null;
    let max: Vec3 | null = null;
    for (const b of this.#measureBodies(target, 'measure.bounds')) {
      const box = this.kernel.properties(b.shape).boundingBox;
      if (box === null) continue;
      min =
        min === null
          ? [...box.min]
          : [
              Math.min(min[0], box.min[0]),
              Math.min(min[1], box.min[1]),
              Math.min(min[2], box.min[2]),
            ];
      max =
        max === null
          ? [...box.max]
          : [
              Math.max(max[0], box.max[0]),
              Math.max(max[1], box.max[1]),
              Math.max(max[2], box.max[2]),
            ];
    }
    return min === null || max === null ? null : { min: [...min], max: [...max] };
  }

  face(target: ScriptValue | undefined): ScriptValue {
    const { name, info } = this.#faceInfo(target, 'measure.face');
    return {
      name,
      surface: info.surface,
      area: info.area,
      centroid: [...info.centroid],
      normal: info.normal === null ? null : [...info.normal],
      radius: info.radius,
    };
  }

  edge(target: ScriptValue | undefined): ScriptValue {
    const e = handleOf<EdgeValue>(target, 'edge', 'measure.edge');
    const body = this.#liveBody(e.body, 'measure.edge');
    const [report] = resolveReferences(this.kernel, body.shape, [e.ref]);
    if (report === undefined || !report.ok)
      fail(`measure.edge: the edge ${describeEdge(e.ref)} no longer exists`);
    const info = this.#named(body.shape).topology.edges[report.index - 1]!;
    return { curve: info.curve, length: info.length, midpoint: [...info.midpoint] };
  }

  // Internals ----------------------------------------------------------------------------------

  #names(shape: ShapeId): Names {
    return this.#named(shape).names;
  }

  #named(shape: ShapeId) {
    const named = this.kernel.named(shape);
    if (named === null) throw new Error(`shape ${shape} has no names`);
    return named;
  }

  #bodyId(op: OpRecord): string {
    return `${this.featureId}:${op.id}`;
  }

  #liveBody(id: string, where: string): FeatureBody {
    const b = this.bodies.find((x) => x.id === id);
    if (b === undefined)
      fail(`${where}: the body ${id} is not there any more (merged into another, or cut away)`);
    return b;
  }

  #liveFace(face: FaceValue, where: string): FaceValue {
    // The face may have moved to another body (merged); look for its name everywhere.
    for (const b of this.bodies) {
      const named = this.kernel.named(b.shape);
      if (named?.names.faces.some((f) => f.name === face.name))
        return { body: b.id, name: face.name };
    }
    return fail(`${where}: the face ${face.name} no longer exists`);
  }

  #faceInfo(target: ScriptValue | undefined, where: string) {
    const f = this.#liveFace(handleOf<FaceValue>(target, 'face', where), where);
    const named = this.#named(this.#liveBody(f.body, where).shape);
    const i = named.names.faces.findIndex((x) => x.name === f.name);
    return { name: f.name, info: named.topology.faces[i]! };
  }

  #target(
    target: ScriptValue | undefined,
    where: string,
  ): { bodies: FeatureBody[]; prefix: string | null } {
    if (target === undefined || target === null) return { bodies: this.bodies, prefix: null };
    if (target instanceof ScriptHandle && target.kind === 'op') {
      return { bodies: this.bodies, prefix: (target.value as OpRecord).prefix };
    }
    if (target instanceof ScriptHandle && target.kind === 'body') {
      return { bodies: [this.#liveBody(target.value as string, where)], prefix: null };
    }
    return fail(
      `${where}: the target must be an operation, a body${where === 'edges' ? ', a face' : ''} or nothing`,
    );
  }

  #measureBodies(target: ScriptValue | undefined, where: string): FeatureBody[] {
    if (target === undefined || target === null) return this.bodies;
    if (target instanceof ScriptHandle && target.kind === 'op') {
      const op = target.value as OpRecord;
      return this.bodies.filter((b) => op.bodies.includes(b.id));
    }
    const ids = this.#bodyList(target, where, 1);
    return this.bodies.filter((b) => ids.includes(b.id));
  }

  /** Body handles (one, or a list) to live body ids, in the order given, without repeats. */
  #bodyList(v: ScriptValue | undefined, where: string, min: number): string[] {
    const items = handles<string>(v, 'body', where, min);
    const out: string[] = [];
    for (const id of items) {
      this.#liveBody(id, where);
      if (out.includes(id)) fail(`${where}: the body ${id} is listed twice`);
      out.push(id);
    }
    return out;
  }

  #scope(v: ScriptValue | undefined, where: string, mode: string): { scope?: string[] } {
    if (v === undefined || v === null) return {};
    if (mode === 'new') fail(`${where}: a new body takes no bodies to act on`);
    return { scope: this.#bodyList(v, `${where}: bodies`, 1) };
  }

  #edges(v: ScriptValue | undefined, where: string) {
    const list = handles<EdgeValue>(v, 'edge', `${where}: edges`, 1);
    const seen = new Set<string>();
    return list.map((e, i) => {
      const key = JSON.stringify(e.ref);
      if (seen.has(key)) fail(`${where}: the edge ${describeEdge(e.ref)} is listed twice`);
      seen.add(key);
      return { id: `r${i + 1}`, ref: e.ref };
    });
  }

  #instanceSource(
    source: ScriptValue | undefined,
    modeValue: ScriptValue | undefined,
    where: string,
  ): {
    source: { type: 'features'; features: ToolInput[] } | { type: 'body'; mode: 'new' | 'add' };
    scope?: string[];
  } {
    const items = Array.isArray(source) ? source : [source];
    if (items.length === 0 || items.length > MAX_HANDLES_PER_CALL)
      fail(`${where}: give 1 to ${MAX_HANDLES_PER_CALL} sources`);
    if (items.every((h) => h instanceof ScriptHandle && h.kind === 'op')) {
      if (modeValue !== undefined)
        fail(`${where}: mode is for bodies; a repeated operation keeps its own`);
      const features = items.map((h) => {
        const op = (h as ScriptHandle<OpRecord>).value;
        if (op.tool === undefined)
          fail(`${where}: only extrudes and revolves can be repeated, not ${op.kind} ${op.id}`);
        return op.tool;
      });
      return { source: { type: 'features', features } };
    }
    const mode =
      modeValue === undefined
        ? 'add'
        : modeValue === 'new' || modeValue === 'add'
          ? modeValue
          : fail(`${where}: mode must be 'new' or 'add'`);
    return {
      source: { type: 'body', mode },
      scope: this.#bodyList(source, `${where}: the source`, 1),
    };
  }

  #mirrorPlane(v: ScriptValue | undefined, where: string) {
    if (v instanceof ScriptHandle && v.kind === 'face')
      return { face: this.#liveFace(v.value as FaceValue, where).name };
    return planeOf(v, `${where}: the plane`);
  }

  #plane(v: ScriptValue | undefined, where: string): Frame {
    if (v === undefined || v === 'XY') return { ...XY_PLANE };
    if (v === 'XZ') return { ...XZ_PLANE };
    if (v === 'YZ') return { ...YZ_PLANE };
    if (v instanceof ScriptHandle && v.kind === 'face') {
      const face = this.#liveFace(v.value as FaceValue, where);
      const body = this.#liveBody(face.body, where);
      const got = sketchFrame(this.kernel, body.shape, { face: face.name });
      if (!got.ok) fail(`${where}: the face ${face.name} is not a plane to sketch on`);
      return got.frame;
    }
    if (!isRecord(v))
      fail(
        `${where}: the plane must be 'XY', 'XZ', 'YZ', a planar face or { origin, normal, xDir? }`,
      );
    known(v, ['origin', 'normal', 'xDir'], `${where}: plane`);
    const origin =
      v.origin === undefined ? ([0, 0, 0] as Vec3) : vec3(v.origin, `${where}: plane.origin`);
    const normal = direction(v.normal, `${where}: plane.normal`);
    const xDir = v.xDir === undefined ? undefined : direction(v.xDir, `${where}: plane.xDir`);
    const p = placementFromNormal(origin, normal, xDir);
    return { origin: p.origin, xDir: p.xDir, normal: p.normal };
  }

  /** Apply one operation and rewrite its names to the operation's prefix. */
  #apply(op: OpRecord, input: FeatureInput): ScriptHandle {
    const out = applyFeature(this.kernel, this.bodies, input);
    if (!out.ok) {
      const why = out.errors.map((e) => this.#rename(e.message)).join('; ');
      fail(`${op.kind} ${op.id} failed: ${why}`);
    }
    const made = new Set([...out.created, ...out.changed]);
    for (const b of out.bodies) {
      if (!made.has(b.id)) continue;
      const named = this.kernel.named(b.shape);
      if (named === null) continue;
      const faces: FaceName[] = named.names.faces.map((f) => ({
        name: this.#rename(f.name),
        lineage: f.lineage.map((n) => this.#rename(n)),
        fragile: f.fragile,
      }));
      this.kernel.setNames(b.shape, {
        names: nameShape(faces, named.topology),
        topology: named.topology,
      });
    }
    this.bodies = out.bodies.map((b) => ({ id: this.#rename(b.id), shape: b.shape }));
    op.bodies = [...made].map((id) => this.#rename(id));
    for (const w of out.warnings) this.#warnings.push(this.#warning(op, w));
    return new ScriptHandle<OpRecord>('op', op);
  }

  /** A name, body id or message with every temporary feature id rewritten to its prefix. */
  #rename(text: string): string {
    if (!text.includes(TEMP_KIND)) return text;
    return text.replace(
      /(?<![A-Za-z0-9#])scriptop#(\d{7})(:?)/g,
      (m, digits: string, colon: string) => {
        const prefix = this.#temps.get(`${TEMP_KIND}#${digits}`);
        if (prefix === undefined) return m;
        // `T:` starts a name (`T:cap:end` becomes `<id>:<op>/cap:end`); a bare `T` is a body id.
        return colon === ':' ? prefix : prefix.slice(0, -1);
      },
    );
  }

  #warning(op: OpRecord, w: FeatureWarning): RegenWarning {
    const message = `${op.kind} ${op.id}: ${this.#rename(w.message)}`;
    switch (w.code) {
      case 'reference':
        return {
          code: 'reference',
          message,
          referenceId: `${op.id}.${w.ref}`,
          target: this.#rename(w.target),
          via: w.via,
          fragile: w.fragile,
        };
      case 'missed':
        return { code: 'missed', message, instances: w.instances.map((n) => this.#rename(n)) };
      case 'detached':
        return { code: 'detached', message, bodies: w.bodies.map((n) => this.#rename(n)) };
      case 'direction':
        return {
          code: 'direction',
          message,
          referenceId: `${op.id}.${w.ref}`,
          target: this.#rename(w.target),
        };
    }
  }
}

// Argument checks -------------------------------------------------------------------------------

function describe(v: ScriptValue | undefined): string {
  if (v instanceof ScriptHandle) return `a ${v.kind}`;
  if (typeof v === 'string') return JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}...` : v);
  if (Array.isArray(v)) return 'a list';
  return v === null ? 'null' : typeof v === 'object' ? 'an object' : String(v);
}

function describeEdge(ref: EdgeRef): string {
  return ref.faces.join('|');
}

/** Refuses fields a call does not know, so a script cannot rely on one a later version adds. */
function known(o: { [key: string]: ScriptValue }, keys: readonly string[], where: string): void {
  for (const key of Object.keys(o)) {
    if (!keys.includes(key)) fail(`${where}: unknown option ${JSON.stringify(key.slice(0, 40))}`);
  }
}

function list(v: ScriptValue | undefined, where: string, min: number, max: number): ScriptValue[] {
  if (!Array.isArray(v)) fail(`${where} must be a list`);
  if (v.length < min || v.length > max)
    fail(`${where} must hold ${min} to ${max} items, not ${v.length}`);
  return v;
}

function finiteIn(v: ScriptValue | undefined, where: string, bound: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v))
    fail(`${where} must be a finite number (got ${describe(v)})`);
  if (Math.abs(v) > bound) fail(`${where} must be within ${bound} (got ${v})`);
  return v === 0 ? 0 : v; // no -0
}

function positive(v: ScriptValue | undefined, where: string): number {
  const n = finiteIn(v, where, MAX_COORDINATE);
  if (!(n > 0)) fail(`${where} must be above 0 (got ${n})`);
  return n;
}

/** An angle in radians, above 0 (or 0 and up with `zero`, signed with `signed`) and up to `max`. */
function angleIn(v: ScriptValue | undefined, where: string, max: number, signed = false): number {
  const n = finiteIn(v, where, max);
  if (!signed && !(n > 0)) fail(`${where} must be above 0 (got ${n})`);
  return n;
}

function flag(v: ScriptValue | undefined, where: string): boolean {
  if (v === undefined) return false;
  if (typeof v !== 'boolean') fail(`${where} must be true or false`);
  return v;
}

function count(v: ScriptValue | undefined, where: string): number {
  const n = finiteIn(v, where, MAX_PATTERN_COUNT);
  if (!Number.isInteger(n) || n < 1)
    fail(`${where} must be a whole number from 1 to ${MAX_PATTERN_COUNT}`);
  return n;
}

function word(v: ScriptValue | undefined, where: string): string {
  if (typeof v !== 'string' || !/^[a-z][a-z0-9.-]{0,63}$/.test(v))
    fail(`${where} must be a short lower-case word`);
  return v;
}

function vec2(v: ScriptValue | undefined, where: string): Vec2 {
  if (!Array.isArray(v) || v.length !== 2) fail(`${where} must be [x, y]`);
  return [
    finiteIn(v[0], `${where}[0]`, MAX_COORDINATE),
    finiteIn(v[1], `${where}[1]`, MAX_COORDINATE),
  ];
}

function vec3(v: ScriptValue | undefined, where: string): Vec3 {
  if (!Array.isArray(v) || v.length !== 3) fail(`${where} must be [x, y, z]`);
  return [
    finiteIn(v[0], `${where}[0]`, MAX_COORDINATE),
    finiteIn(v[1], `${where}[1]`, MAX_COORDINATE),
    finiteIn(v[2], `${where}[2]`, MAX_COORDINATE),
  ];
}

function direction(v: ScriptValue | undefined, where: string): Vec3 {
  const d = vec3(v, where);
  if (Math.hypot(d[0], d[1], d[2]) < 1e-9) fail(`${where} must not be a zero vector`);
  return d;
}

function unit(d: readonly number[]): Vec3 {
  const l = Math.hypot(d[0]!, d[1]!, d[2]!);
  return [d[0]! / l, d[1]! / l, d[2]! / l];
}

function axisOf(v: ScriptValue | undefined, where: string) {
  if (!isRecord(v)) fail(`${where} must be { origin, direction }`);
  known(v, ['origin', 'direction'], where);
  return {
    origin: vec3(v.origin, `${where}.origin`),
    direction: direction(v.direction, `${where}.direction`),
  };
}

function planeOf(v: ScriptValue | undefined, where: string) {
  if (!isRecord(v)) fail(`${where} must be { origin, normal }`);
  known(v, ['origin', 'normal'], where);
  return {
    origin: vec3(v.origin, `${where}.origin`),
    normal: direction(v.normal, `${where}.normal`),
  };
}

function modeOf(
  v: ScriptValue | undefined,
  where: string,
): 'new' | 'add' | 'subtract' | 'intersect' {
  if (v === undefined || v === 'new') return 'new';
  if (v === 'add') return 'add';
  if (v === 'cut') return 'subtract';
  if (v === 'intersect') return 'intersect';
  return fail(`${where}: mode must be 'new', 'add', 'cut' or 'intersect'`);
}

/** One handle of `kind`, or a list of 1 to `MAX_HANDLES_PER_CALL` of them (at least `min`). */
function handles<T>(v: ScriptValue | undefined, kind: string, where: string, min: number): T[] {
  const items = Array.isArray(v) ? v : [v];
  if (items.length < min || items.length > MAX_HANDLES_PER_CALL) {
    fail(`${where}: give ${min} to ${MAX_HANDLES_PER_CALL} ${kind}s, not ${items.length}`);
  }
  return items.map((h, i) => handleOf<T>(h, kind, `${where}[${i}]`));
}

function handleOf<T>(v: ScriptValue | undefined, kind: string, where: string): T {
  if (!(v instanceof ScriptHandle) || v.kind !== kind)
    fail(`${where} must be a ${kind} (got ${describe(v)})`);
  return v.value as T;
}

function entity(v: ScriptValue, where: string): ProfileEntity {
  if (!isRecord(v)) fail(`${where} must be an entity object`);
  const id = v.id;
  if (typeof id !== 'string' || !SCRIPT_LOCAL_ID_PATTERN.test(id)) {
    fail(
      `${where}: the id must be a lower-case letter followed by letters, digits or _ (got ${describe(id)})`,
    );
  }
  switch (v.kind) {
    case 'line':
      known(v, ['kind', 'id', 'start', 'end'], where);
      return {
        kind: 'line',
        id,
        start: vec2(v.start, `${where}.start`),
        end: vec2(v.end, `${where}.end`),
      };
    case 'arc':
      known(v, ['kind', 'id', 'center', 'start', 'end', 'clockwise'], where);
      return {
        kind: 'arc',
        id,
        center: vec2(v.center, `${where}.center`),
        start: vec2(v.start, `${where}.start`),
        end: vec2(v.end, `${where}.end`),
        ...(flag(v.clockwise, `${where}.clockwise`) ? { clockwise: true } : {}),
      };
    case 'circle':
      known(v, ['kind', 'id', 'center', 'radius'], where);
      return {
        kind: 'circle',
        id,
        center: vec2(v.center, `${where}.center`),
        radius: positive(v.radius, `${where}.radius`),
      };
    case 'bezier': {
      known(v, ['kind', 'id', 'points'], where);
      const pts = list(v.points, `${where}.points`, 2, MAX_BEZIER_POINTS);
      return { kind: 'bezier', id, points: pts.map((p, i) => vec2(p, `${where}.points[${i}]`)) };
    }
    default:
      return fail(`${where}: kind must be 'line', 'arc', 'circle' or 'bezier'`);
  }
}

/** The role of a face born in an operation: what follows the prefix, up to the next `:`. */
function roleOf(name: string, prefix: string | null): string {
  const rest = prefix !== null && name.startsWith(prefix) ? name.slice(prefix.length) : name;
  const colon = rest.indexOf(':');
  return colon < 0 ? rest : rest.slice(0, colon);
}

function edgeRefOf(e: { faces: string[]; ends: string[]; ordinal: number }): EdgeRef {
  const ref: EdgeRef = { faces: [...e.faces] };
  if (e.ends.length > 0) ref.ends = [...e.ends];
  if (e.ordinal > 0) ref.ordinal = e.ordinal;
  return ref;
}

// The API versions -------------------------------------------------------------------------------

/**
 * Script API version 1: what `ctx` holds. Every entry is a promise kept forever (see the module
 * comment); `SCRIPT_API_V1_SURFACE` pins the list and a test checks it.
 */
function apiV1(run: ScriptRun): HostApi {
  return {
    sketch: (id, spec) => run.sketch(id, spec),
    extrude: kernelOp((id, sketch, options) => run.extrude(id, sketch, options)),
    revolve: kernelOp((id, sketch, options) => run.revolve(id, sketch, options)),
    fillet: kernelOp((id, edges, radius) => run.fillet(id, edges, radius)),
    chamfer: kernelOp((id, edges, distance) => run.chamfer(id, edges, distance)),
    shell: kernelOp((id, faces, thickness, options) => run.shell(id, faces, thickness, options)),
    boolean: kernelOp((id, kind, targets, tools) => run.boolean(id, kind, targets, tools)),
    pattern: kernelOp((id, source, layout) => run.pattern(id, source, layout)),
    mirror: kernelOp((id, source, plane, options) => run.mirror(id, source, plane, options)),
    transform: kernelOp((id, bodies, motion) => run.transform(id, bodies, motion)),
    bodies: (target) => run.bodiesOf(target),
    faces: (target, filter) => run.faces(target, filter),
    edges: (target, filter) => run.edges(target, filter),
    name: (target) => run.nameOf(target),
    measure: {
      volume: (target) => run.volume(target),
      area: (target) => run.area(target),
      bounds: (target) => run.bounds(target),
      face: (target) => run.face(target),
      edge: (target) => run.edge(target),
    },
  };
}

/** The `ctx` of every script API version this build runs. Never remove one. */
export const SCRIPT_APIS: ReadonlyMap<number, (run: ScriptRun) => HostApi> = new Map([[1, apiV1]]);

/** Script API version 1's members, as `ctx` paths: additions only, never a change. */
export const SCRIPT_API_V1_SURFACE: readonly string[] = Object.freeze([
  'bodies',
  'boolean',
  'chamfer',
  'edges',
  'extrude',
  'faces',
  'fillet',
  'measure.area',
  'measure.bounds',
  'measure.edge',
  'measure.face',
  'measure.volume',
  'mirror',
  'name',
  'pattern',
  'revolve',
  'shell',
  'sketch',
  'transform',
]);
