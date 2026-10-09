// The board feature, `wood.board` (M4 plan decision 4, T4.1c): a body cut from a catalog stock,
// with a grain. Two forms, both one kernel `extrude` making a `new` body, so the kernel needs no
// board feature:
//
// - **panel**: a closed sketch region extruded by the stock's actual thickness, along the sketch
//   normal (or against it with `flip`). The grain runs in the sketch plane: along the region's
//   longest straight side by default, along a chosen sketch line, or at an angle from the sketch
//   x axis (the `grainAngle` expression).
// - **stick**: the stock's actual section (thickness by width) swept along a sketch line, from its
//   start for its length (or the `length` expression). At no `rotation` the thickness lies in the
//   sketch plane, to the left of the line, and the width along the sketch normal; `rotation` turns
//   the section right-handed about the line. `justify` places the section on the line, per axis:
//   centred on it, or on its negative or positive side (`positive`: the board lies on the positive
//   side of the line, so the line runs along the board's negative face). `justify.width` is
//   measured along the section's width axis (the sketch normal before rotation), which points
//   opposite to the reported `frame.axes.width`. A stick is cut from lumber: sheet stock is
//   refused.
//
// A panel may be cut from either kind: from lumber it takes the stock's thickness only, and the
// region's width is not checked against the board's (a glued-up panel is wider than one board).
//
// The stock's sizes come from the catalog with the document's override (`domains.stock`), read by
// regen through the domain's data reader; the numbers end up in the kernel input, so regen's cache
// key covers them (ADR 0013 decision 5). The translator also reports the board's frame (origin,
// length along the grain, width and thickness axes and sizes) as metadata, for the cut list.
//
// Face names come from the extrude rules with the extension's id. One rule throughout: `x0` is the
// face at the low end of the reported frame's axis, `x1` at the high end. A stick's sides are
// `extension#n:side:t0`, `t1` (thickness axis) and `w0`, `w1` (the frame's width axis, which is
// the section's width axis reversed); its caps `extension#n:cap:start` and `cap:end` are the low
// and high ends of the length axis. A panel's caps follow the thickness axis the same way (start
// on the sketch plane, end a thickness along the extrusion, which is the frame's thickness axis
// with or without `flip`); its sides are `extension#n:side:<sketch edge id>`, named by the sketch,
// not by the frame.

import type { ExtensionFeature } from '@manufakture/core';
import type { ExtrudeInput, ProfileEntity, SketchProfile, Vec3 } from '@manufakture/kernel';
import type {
  ExpressionKind,
  ExtensionContext,
  ExtensionOutput,
  ExtensionType,
  JsonValue,
} from '@manufakture/regen';
import { findStock } from './catalog';
import { currentVersion, migrate, type Json, type Versioned } from './migrations';
import { fail, isObject, ok, onlyKeys, own, readEnum, readId, type Path, type Read } from './read';
import { EMPTY_STOCK_DATA, STOCK_NAMESPACE, resolveStock, type StockData } from './stock-data';

export const BOARD_TYPE = 'wood.board';

/** Where a stick's line lies in its section, per axis. */
export type Justify = 'centre' | 'negative' | 'positive';
export const JUSTIFY: readonly Justify[] = ['centre', 'negative', 'positive'];

/** How a panel's grain direction is chosen in the sketch plane. */
export type GrainSpec =
  /** Along the region's longest straight side (the default). */
  | { type: 'longest' }
  /** Along a sketch line, from its start to its end. */
  | { type: 'line'; entity: string }
  /** At the `grainAngle` expression from the sketch's x axis, counter-clockwise. */
  | { type: 'angle' };

export interface PanelParams {
  form: 'panel';
  /** A catalog stock id. */
  stock: string;
  /** The sketch feature (also in `dependsOn`). */
  sketch: string;
  /** The entities bounding the region; absent: the sketch's only region. */
  entities?: string[];
  grain: GrainSpec;
  /** Extrude against the sketch normal. */
  flip: boolean;
}

export interface StickParams {
  form: 'stick';
  stock: string;
  sketch: string;
  /** The sketch line the stick runs along, from its start. */
  line: string;
  justify: { thickness: Justify; width: Justify };
}

export type BoardParams = PanelParams | StickParams;

/** The kind of every expression a board may have, and which form reads it. */
export const BOARD_EXPRESSIONS: Readonly<Record<string, ExpressionKind>> = {
  grainAngle: 'angle',
  rotation: 'angle',
  length: 'length',
  width: 'length',
};
const FORM_EXPRESSIONS: Readonly<Record<BoardParams['form'], readonly string[]>> = {
  panel: ['grainAngle'],
  stick: ['rotation', 'length', 'width'],
};

/** The params migrations of `wood.board` (none yet: version 1 is current). */
export const BOARD_PARAMS: Versioned = { what: '"wood.board" params', migrations: [] };
export const BOARD_SCHEMA_VERSION = currentVersion(BOARD_PARAMS);

/** The most entities a panel's region selection may list. */
export const MAX_REGION_ENTITIES = 10_000;

const FEATURE_ID = /^[a-z][a-zA-Z0-9]*#[1-9][0-9]*$/;

function readSketchId(v: unknown, at: Path): Read<string> {
  return typeof v === 'string' && FEATURE_ID.test(v)
    ? ok(v)
    : fail('expected a sketch feature id like "sketch#1"', at);
}

function readGrain(v: unknown): Read<GrainSpec> {
  if (v === undefined) return ok({ type: 'longest' });
  if (!isObject(v)) return fail('expected a grain direction { type }', ['grain']);
  const type = readEnum(own(v, 'type'), ['longest', 'line', 'angle'] as const, ['grain', 'type']);
  if (!type.ok) return type;
  if (type.value === 'line') {
    const keys = onlyKeys(v, ['type', 'entity'], ['grain']);
    if (!keys.ok) return keys;
    const entity = readId(own(v, 'entity'), ['grain', 'entity'], 'a sketch line id');
    return entity.ok ? ok({ type: 'line', entity: entity.value }) : entity;
  }
  const keys = onlyKeys(v, ['type'], ['grain']);
  return keys.ok ? ok({ type: type.value }) : keys;
}

function readCurrent(params: Json): Read<BoardParams> {
  if (!isObject(params)) return fail('expected the board params object');
  const form = readEnum(own(params, 'form'), ['panel', 'stick'] as const, ['form']);
  if (!form.ok) return form;
  const stock = readId(own(params, 'stock'), ['stock'], 'a stock id');
  if (!stock.ok) return stock;
  if (findStock(stock.value) === undefined) {
    return fail(`"${stock.value}" is not a stock this build knows`, ['stock']);
  }
  if (form.value === 'stick' && findStock(stock.value)!.kind === 'sheet') {
    return fail(
      `"${stock.value}" is sheet stock: a stick is cut from lumber (draw a panel instead)`,
      ['stock'],
    );
  }
  const sketch = readSketchId(own(params, 'sketch'), ['sketch']);
  if (!sketch.ok) return sketch;
  if (form.value === 'panel') {
    const keys = onlyKeys(params, ['form', 'stock', 'sketch', 'entities', 'grain', 'flip'], []);
    if (!keys.ok) return keys;
    const out: PanelParams = {
      form: 'panel',
      stock: stock.value,
      sketch: sketch.value,
      grain: { type: 'longest' },
      flip: false,
    };
    const entities = own(params, 'entities');
    if (entities !== undefined) {
      if (
        !Array.isArray(entities) ||
        entities.length === 0 ||
        entities.length > MAX_REGION_ENTITIES ||
        !entities.every((e) => typeof e === 'string' && e.length > 0 && e.length <= 256)
      ) {
        return fail('expected a non-empty list of sketch entity ids', ['entities']);
      }
      out.entities = [...(entities as string[])];
    }
    const grain = readGrain(own(params, 'grain'));
    if (!grain.ok) return grain;
    out.grain = grain.value;
    const flip = own(params, 'flip');
    if (flip !== undefined && typeof flip !== 'boolean')
      return fail('expected true or false', ['flip']);
    out.flip = flip === true;
    return ok(out);
  }
  const keys = onlyKeys(params, ['form', 'stock', 'sketch', 'line', 'justify'], []);
  if (!keys.ok) return keys;
  const line = readId(own(params, 'line'), ['line'], 'a sketch line id');
  if (!line.ok) return line;
  const justify: StickParams['justify'] = { thickness: 'centre', width: 'centre' };
  const j = own(params, 'justify');
  if (j !== undefined) {
    if (!isObject(j)) return fail('expected { thickness, width }', ['justify']);
    const jk = onlyKeys(j, ['thickness', 'width'], ['justify']);
    if (!jk.ok) return jk;
    for (const axis of ['thickness', 'width'] as const) {
      const v = own(j, axis);
      if (v === undefined) continue;
      const r = readEnum(v, JUSTIFY, ['justify', axis]);
      if (!r.ok) return r;
      justify[axis] = r.value;
    }
  }
  return ok({ form: 'stick', stock: stock.value, sketch: sketch.value, line: line.value, justify });
}

/**
 * A board's params stored at `schemaVersion`, migrated in memory and validated: regen's params
 * check, and what the board dialog reads.
 */
export function readBoardParams(params: Json, schemaVersion: number): Read<BoardParams> {
  const migrated = migrate(BOARD_PARAMS, params, schemaVersion);
  if (!migrated.ok) return migrated;
  return readCurrent(migrated.value);
}

// The board frame --------------------------------------------------------------------------------

/**
 * Where a board's blank lies: the box `origin + [0, size.length] * axes.length + [0, size.width] *
 * axes.width + [0, size.thickness] * axes.thickness`, in the part's coordinates. Axes are unit
 * vectors and right-handed (length x width = thickness). `length` runs along the grain.
 */
export type BoardFrame = {
  origin: number[];
  axes: { length: number[]; width: number[]; thickness: number[] };
  size: { length: number; width: number; thickness: number };
};

/** What a board reports in its feature result (`FeatureResult.metadata`), for the cut list. */
export type BoardMetadata = {
  form: BoardParams['form'];
  stock: string;
  material: string;
  /** Whether the stock has a grain direction (false for MDF and OSB). */
  grain: boolean;
  frame: BoardFrame;
  /** Which sizes came from the document's stock override (or, for width, the `width` expression). */
  overridden: { thickness: boolean; width: boolean };
};

const isVec = (v: unknown): v is number[] =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
const isSize = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** A board's metadata from a feature result, or undefined when it is not one. */
export function readBoardMetadata(v: unknown): BoardMetadata | undefined {
  if (!isObject(v)) return undefined;
  const frame = own(v, 'frame');
  const overridden = own(v, 'overridden');
  if (
    (own(v, 'form') !== 'panel' && own(v, 'form') !== 'stick') ||
    typeof own(v, 'stock') !== 'string' ||
    typeof own(v, 'material') !== 'string' ||
    typeof own(v, 'grain') !== 'boolean' ||
    !isObject(frame) ||
    !isObject(overridden)
  ) {
    return undefined;
  }
  const axes = own(frame, 'axes');
  const size = own(frame, 'size');
  if (
    !isVec(own(frame, 'origin')) ||
    !isObject(axes) ||
    !isObject(size) ||
    !['length', 'width', 'thickness'].every((k) => isVec(own(axes, k)) && isSize(own(size, k))) ||
    typeof own(overridden, 'thickness') !== 'boolean' ||
    typeof own(overridden, 'width') !== 'boolean'
  ) {
    return undefined;
  }
  return structuredClone(v) as BoardMetadata;
}

// Geometry ---------------------------------------------------------------------------------------

type V2 = readonly [number, number];
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const neg3 = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]];
/** Exact zeros instead of -0, so metadata compares and hashes the same either way. */
const clean = (a: Vec3): number[] => a.map((x) => (x === 0 ? 0 : x));

/** A sketch-plane point or direction in model space, through the placement's x and y axes. */
function inPlane(o: Vec3, x: Vec3, y: Vec3, p: V2): Vec3 {
  return add3(o, add3(scale3(x, p[0]), scale3(y, p[1])));
}

const dot2 = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
const TAU = 2 * Math.PI;

/** Whether the angle `a` lies on the arc from `start` counter-clockwise to `end`. */
function onArc(a: number, start: number, end: number): boolean {
  const sweep = (((end - start) % TAU) + TAU) % TAU || TAU;
  const at = (((a - start) % TAU) + TAU) % TAU;
  return at <= sweep;
}

/** The smallest and largest of `dot(p, dir)` over a loop's entities (exact for lines and arcs). */
function extentAlong(entities: readonly ProfileEntity[], dir: V2): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  const take = (p: V2) => {
    const s = dot2(p, dir);
    if (s < lo) lo = s;
    if (s > hi) hi = s;
  };
  for (const e of entities) {
    switch (e.kind) {
      case 'line':
        take(e.start);
        take(e.end);
        break;
      case 'circle':
        take([e.center[0] + e.radius * dir[0], e.center[1] + e.radius * dir[1]]);
        take([e.center[0] - e.radius * dir[0], e.center[1] - e.radius * dir[1]]);
        break;
      case 'arc': {
        take(e.start);
        take(e.end);
        const [cx, cy] = e.center;
        const r = Math.hypot(e.start[0] - cx, e.start[1] - cy);
        let a0 = Math.atan2(e.start[1] - cy, e.start[0] - cx);
        let a1 = Math.atan2(e.end[1] - cy, e.end[0] - cx);
        if (e.clockwise === true) [a0, a1] = [a1, a0];
        const toward = Math.atan2(dir[1], dir[0]);
        for (const a of [toward, toward + Math.PI]) {
          if (onArc(a, a0, a1)) take([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
        }
        break;
      }
      case 'bezier': {
        // Sampled: a Bezier's extremes lie between its control points' (an estimate).
        const pts = e.points;
        const n = pts.length - 1;
        for (let i = 0; i <= 64; i++) {
          const t = i / 64;
          // de Casteljau
          const work = pts.map((p) => [p[0], p[1]] as [number, number]);
          for (let k = 1; k <= n; k++) {
            for (let j = 0; j <= n - k; j++) {
              work[j]![0] = (1 - t) * work[j]![0] + t * work[j + 1]![0];
              work[j]![1] = (1 - t) * work[j]![1] + t * work[j + 1]![1];
            }
          }
          take(work[0]!);
        }
        break;
      }
    }
  }
  return [lo, hi];
}

/** The direction of the longest straight side of a loop, canonical in sign; null when none. */
function longestSide(entities: readonly ProfileEntity[]): V2 | null {
  let best: V2 | null = null;
  let bestLength = 0;
  for (const e of entities) {
    if (e.kind !== 'line') continue;
    const dx = e.end[0] - e.start[0];
    const dy = e.end[1] - e.start[1];
    const length = Math.hypot(dx, dy);
    // Ties go to the first side in loop order, so the choice is deterministic.
    if (length > bestLength * (1 + 1e-9)) {
      best = [dx / length, dy / length];
      bestLength = length;
    }
  }
  if (best === null) return null;
  // The grain has no sign: point it along +x, or +y when it is vertical.
  const flip = best[0] < -1e-12 || (Math.abs(best[0]) <= 1e-12 && best[1] < 0);
  return flip ? [-best[0], -best[1]] : best;
}

type Lines = Map<string, { start: V2; end: V2 }>;

function sketchLines(ctx: ExtensionContext<BoardParams>, sketchId: string): Lines {
  const out: Lines = new Map();
  for (const e of ctx.sketches.get(sketchId)?.entities ?? []) {
    if (e.kind === 'line') out.set(e.id, { start: e.start, end: e.end });
  }
  return out;
}

// The translator -------------------------------------------------------------------------------

type Failure = Extract<ExtensionOutput, { error: string }>;
const refuse = (error: string, field: Path): Failure => ({ error, field });

/** The kernel inputs and frame of a board, or why it cannot be built. */
export function translateBoard(ctx: ExtensionContext<BoardParams>): ExtensionOutput {
  const f: ExtensionFeature = ctx.feature;
  const p = ctx.params;
  if (f.operation !== 'new') {
    return refuse('a board makes a body of its own: its operation must be "new"', ['operation']);
  }
  for (const name of Object.keys(f.expressions).sort()) {
    if (!FORM_EXPRESSIONS[p.form].includes(name)) {
      return refuse(`a ${p.form} board has no "${name}" value`, ['expressions', name]);
    }
  }
  const data = Object.hasOwn(ctx.data, STOCK_NAMESPACE)
    ? (ctx.data[STOCK_NAMESPACE] as StockData)
    : EMPTY_STOCK_DATA;
  const stock = resolveStock(p.stock, data);
  if (stock === undefined)
    return refuse(`"${p.stock}" is not a stock this build knows`, ['params', 'stock']);
  const sketch = ctx.sketches.get(p.sketch);
  if (sketch === undefined) {
    return refuse(`${p.sketch} is not a solved sketch the board depends on`, ['dependsOn']);
  }
  const o = sketch.placement.origin;
  const x = sketch.placement.xDir;
  const n = sketch.placement.normal;
  const y = cross3(n, x);
  const t = stock.thickness;

  if (p.form === 'panel') {
    const profile = ctx.profile(p.sketch, p.entities);
    if (!profile.ok) return refuse(profile.message, ['params', p.entities ? 'entities' : 'sketch']);
    const prof: SketchProfile = profile.value;
    const regions = 'regions' in prof ? prof.regions.map((r) => r.loops) : [prof.loops];
    if (regions.length !== 1) {
      return refuse(
        `a panel is one region, and the selection has ${regions.length}: pick the entities of one`,
        ['params', p.entities ? 'entities' : 'sketch'],
      );
    }
    const outer = regions[0]![0]!.entities;
    let g: V2;
    if (p.grain.type === 'longest') {
      g = longestSide(outer) ?? [1, 0];
    } else if (p.grain.type === 'line') {
      const line = sketchLines(ctx, p.sketch).get(p.grain.entity);
      if (line === undefined) {
        return refuse(`${p.sketch} has no line "${p.grain.entity}"`, ['params', 'grain', 'entity']);
      }
      const dx = line.end[0] - line.start[0];
      const dy = line.end[1] - line.start[1];
      const len = Math.hypot(dx, dy);
      if (!(len > 0)) return refuse('the grain line has no length', ['params', 'grain', 'entity']);
      g = [dx / len, dy / len];
    } else {
      const a = ctx.values.grainAngle;
      if (a === undefined) {
        return refuse('the grain angle is missing', ['expressions', 'grainAngle']);
      }
      g = [Math.cos(a), Math.sin(a)];
    }
    // Thickness axis: the extrusion direction. Width: thickness x grain, so the frame is
    // right-handed (length x width = thickness).
    const thicknessAxis = p.flip ? neg3(n) : n;
    const w: V2 = p.flip ? [g[1], -g[0]] : [-g[1], g[0]];
    const [s0, s1] = extentAlong(outer, g);
    const [w0, w1] = extentAlong(outer, w);
    const corner: V2 = [s0 * g[0] + w0 * w[0], s0 * g[1] + w0 * w[1]];
    const input: ExtrudeInput = {
      kind: 'extrude',
      id: f.id,
      profile: prof,
      extent: { type: 'blind', distance: t },
      mode: 'new',
    };
    if (p.flip) input.reverse = true;
    const metadata: BoardMetadata = {
      form: 'panel',
      stock: stock.entry.id,
      material: stock.entry.material,
      grain: stock.entry.grain,
      frame: {
        origin: clean(inPlane(o, x, y, corner)),
        axes: {
          length: clean(inPlane([0, 0, 0], x, y, g)),
          width: clean(inPlane([0, 0, 0], x, y, w)),
          thickness: clean(thicknessAxis),
        },
        size: { length: s1 - s0, width: w1 - w0, thickness: t },
      },
      overridden: { thickness: stock.overridden.thickness, width: false },
    };
    return { inputs: [input], metadata: metadata as unknown as JsonValue };
  }

  // Stick.
  if (stock.entry.kind === 'sheet') {
    return refuse(
      `${stock.entry.name} is sheet stock: a stick is cut from lumber (draw a panel instead)`,
      ['params', 'stock'],
    );
  }
  const line = sketchLines(ctx, p.sketch).get(p.line);
  if (line === undefined) return refuse(`${p.sketch} has no line "${p.line}"`, ['params', 'line']);
  const d2: V2 = [line.end[0] - line.start[0], line.end[1] - line.start[1]];
  const lineLength = Math.hypot(d2[0], d2[1]);
  if (!(lineLength > 0)) return refuse('the line has no length', ['params', 'line']);
  const length = ctx.values.length ?? lineLength;
  if (!(length > 0)) return refuse('the length must be above zero', ['expressions', 'length']);
  const width = ctx.values.width ?? stock.width;
  if (width === undefined) {
    return refuse(`${stock.entry.name} is sold in random widths: give the stick a width`, [
      'expressions',
      'width',
    ]);
  }
  if (!(width > 0)) return refuse('the width must be above zero', ['expressions', 'width']);
  const d = inPlane([0, 0, 0], x, y, [d2[0] / lineLength, d2[1] / lineLength]);
  const start = inPlane(o, x, y, line.start);
  // At no rotation: thickness in the sketch plane to the left of the line, width along the
  // normal; (line, thickness, width) is right-handed, and the rotation keeps it so. The reported
  // frame's width axis is therefore -wAxis, so that length x width = thickness.
  const r = ctx.values.rotation ?? 0;
  const t0 = cross3(n, d);
  const tAxis = add3(scale3(t0, Math.cos(r)), scale3(n, Math.sin(r)));
  const wAxis = add3(scale3(t0, -Math.sin(r)), scale3(n, Math.cos(r)));
  const low = (j: Justify, size: number) =>
    j === 'centre' ? -size / 2 : j === 'positive' ? 0 : -size;
  const a0 = low(p.justify.thickness, t);
  const b0 = low(p.justify.width, width);
  const a1 = a0 + t;
  const b1 = b0 + width;
  // In the section frame x runs along the thickness axis and y = line x thickness = wAxis, which
  // is the reported frame's width axis reversed. The face ids follow the reported frame, low to
  // high on each axis: t0 at a0, t1 at a1, and w0 at b1 (the low end of the frame's width axis),
  // w1 at b0.
  const entities: ProfileEntity[] = [
    { id: 'w1', kind: 'line', start: [a0, b0], end: [a1, b0] },
    { id: 't1', kind: 'line', start: [a1, b0], end: [a1, b1] },
    { id: 'w0', kind: 'line', start: [a1, b1], end: [a0, b1] },
    { id: 't0', kind: 'line', start: [a0, b1], end: [a0, b0] },
  ];
  const input: ExtrudeInput = {
    kind: 'extrude',
    id: f.id,
    profile: { frame: { origin: start, xDir: tAxis, normal: d }, loops: [{ entities }] },
    extent: { type: 'blind', distance: length },
    mode: 'new',
  };
  const metadata: BoardMetadata = {
    form: 'stick',
    stock: stock.entry.id,
    material: stock.entry.material,
    grain: stock.entry.grain,
    frame: {
      // The min corner in the right-handed frame (length, -wAxis, tAxis): the section's low
      // thickness face and high wAxis face.
      origin: clean(add3(start, add3(scale3(tAxis, a0), scale3(wAxis, b1)))),
      axes: { length: clean(d), width: clean(neg3(wAxis)), thickness: clean(tAxis) },
      size: { length, width, thickness: t },
    },
    overridden: {
      thickness: stock.overridden.thickness,
      width: ctx.values.width !== undefined || stock.overridden.width,
    },
  };
  return { inputs: [input], metadata: metadata as unknown as JsonValue };
}

/** The `wood.board` extension type, as regen's registry takes it. */
export const boardType: ExtensionType<BoardParams> = {
  schemaVersion: BOARD_SCHEMA_VERSION,
  expressions: BOARD_EXPRESSIONS,
  // The sketch, and its entities a panel's region or a stick's line names.
  idFields: [
    { path: ['sketch'], kind: 'feature' },
    { path: ['entities', '*'], kind: 'entity' },
    { path: ['grain', 'entity'], kind: 'entity' },
    { path: ['line'], kind: 'entity' },
  ],
  params(params, schemaVersion) {
    return readBoardParams(params as Json, schemaVersion);
  },
  translate(ctx) {
    return translateBoard(ctx);
  },
};
