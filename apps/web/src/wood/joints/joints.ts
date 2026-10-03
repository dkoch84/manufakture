// The joint tool's logic, free of React (M4 plan T4.2c): the form the Joint dialog edits, where a
// new joint starts, how a stored joint fills it, how a filled form becomes one core command, and
// the preview: the domain's own translator run on the main thread against the board frames regen
// last reported, giving the tools each board loses, the warnings, the hardware and any refusal
// before anything is applied.
//
// A joint is a `wood.joint` extension feature (ADR 0013 decision 2) naming the board that
// receives (`a`) and the board that enters it (`b`). Its depth is not a field: board B is drawn
// reaching into A, and the joint cuts the overlap, so moving or resizing B changes the depth.

import {
  findPart,
  isFeatureActive,
  previewIds,
  type Command,
  type ExtensionFeature,
  type Feature,
  type ManufaktureDocument,
  type Part,
  type StoredExpression,
} from '@manufakture/core';
import {
  JOINT_EXPRESSIONS,
  JOINT_SCHEMA_VERSION,
  JOINT_TYPE,
  KIND_EXPRESSIONS,
  readBoardMetadata,
  readJointParams,
  translateJoint,
  type DadoStop,
  type Json,
  type JointKind,
  type JointMetadata,
  type JointParams,
} from '@manufakture/domain-wood';
import type { ToolItem, Vec3 } from '@manufakture/kernel';
import type { ExtensionContext, FeatureResult, JsonValue } from '@manufakture/regen';
import { checkExpression } from '../../features/forms';
import { evaluateVariables } from '../../sketcher/values';
import { isBoard, JOINT_LABELS } from '../kinds';

/**
 * The kind of a joint expression, as the forms take it. Joints declare only lengths, angles and
 * counts; regen's `slope` kind (roof pitches) never occurs here, and would be an angle.
 */
export function jointExpressionKind(name: string): 'length' | 'angle' | 'number' {
  const kind = JOINT_EXPRESSIONS[name] ?? 'length';
  return kind === 'slope' ? 'angle' : kind;
}

export { JOINT_TYPE };
export { isJoint, JOINT_LABELS } from '../kinds';

// The form --------------------------------------------------------------------------------------

export interface JointForm {
  kind: JointKind;
  /** The board that receives (the dado's, the mortise's, the one a screw goes into). */
  a: string;
  /** The board that enters it (the shelf, the tenon's board, the pocket's board). */
  b: string;
  stopped: DadoStop;
  ends: 'square' | 'rounded';
  face: 'low' | 'high';
  start: 'a' | 'b';
  /** Expression sources by name, as typed; empty: the kind's default. */
  values: Record<string, string>;
}

/** The boards a joint at `before` may join: active boards before it, in tree order. */
export function jointBoards(part: Part, before: number): ExtensionFeature[] {
  return part.features
    .slice(0, before)
    .filter((f, i): f is ExtensionFeature => isBoard(f) && isFeatureActive(part, i));
}

const barOf = (part: Part) => part.rollbackIndex ?? part.features.length;

/** The board a selected item names: a board feature, or a face, edge or vertex of its body. */
function selectedBoard(
  item: { kind: string; id: string; bodyId?: string },
  boards: ReadonlySet<string>,
): string | null {
  if (item.kind === 'feature') return boards.has(item.id) ? item.id : null;
  if (typeof item.bodyId === 'string') {
    const id = item.bodyId.slice(item.bodyId.lastIndexOf('/') + 1);
    return boards.has(id) ? id : null;
  }
  return null;
}

/**
 * A new joint's form: a dado between the first two boards selected (in the tree, or by a face of
 * each in the view), else the last two boards before the rollback bar, the earlier one receiving.
 */
export function newJointForm(
  doc: ManufaktureDocument,
  partId: string,
  selected: readonly { kind: string; id: string; bodyId?: string }[] = [],
): JointForm {
  const part = findPart(doc, partId)!;
  const boards = jointBoards(part, barOf(part)).map((b) => b.id);
  const set = new Set(boards);
  const picked: string[] = [];
  for (const item of selected) {
    const id = selectedBoard(item, set);
    if (id !== null && !picked.includes(id)) picked.push(id);
  }
  const [a, b] = picked.length >= 2 ? picked : boards.slice(-2);
  return {
    kind: 'dado',
    a: a ?? '',
    b: b ?? '',
    stopped: 'none',
    ends: 'square',
    face: 'low',
    start: 'a',
    values: {},
  };
}

/**
 * The form of a stored joint, or the domain's message when its params cannot be read (a newer
 * schema version, or params this build refuses): such a joint has no edit dialog.
 */
export function jointFormOf(
  feature: ExtensionFeature,
): { ok: true; form: JointForm } | { ok: false; message: string } {
  const r = readJointParams(feature.params as Json, feature.schemaVersion);
  if (!r.ok) return { ok: false, message: r.message };
  const p: JointParams = r.value;
  const values: Record<string, string> = {};
  for (const [k, e] of Object.entries(feature.expressions)) values[k] = e.source;
  return {
    ok: true,
    form: {
      kind: p.kind,
      a: p.a,
      b: p.b,
      stopped: p.kind === 'dado' ? p.stopped : 'none',
      ends: p.kind === 'mortise-tenon' ? p.ends : 'square',
      face: p.kind === 'pocket-screw' ? p.face : 'low',
      start: p.kind === 'box-joint' ? p.start : 'a',
      values,
    },
  };
}

/** The form with A and B swapped: the other board receives. */
export function swapBoards(form: JointForm): JointForm {
  return { ...form, a: form.b, b: form.a, start: form.start === 'a' ? 'b' : 'a' };
}

// Building --------------------------------------------------------------------------------------

export type JointBuild =
  | { ok: true; feature: ExtensionFeature; command: Command; label: string }
  | { ok: false; errors: Record<string, string> };

/** The form field a domain error path points at (`['params', 'b']` is the B picker). */
export function fieldOf(path: readonly (string | number)[] | undefined): string {
  if (!path || path.length === 0) return 'form';
  const [head, name] = path;
  if ((head === 'params' || head === 'expressions') && typeof name === 'string') return name;
  return 'form';
}

/** A joint's default name: its kind and its id's number (`Dado 3`). */
function defaultName(kind: JointKind, id: string): string {
  return `${JOINT_LABELS[kind]} ${id.slice(id.indexOf('#') + 1)}`;
}

/**
 * Turn a filled form into the joint and the command that adds it at the rollback bar or replaces
 * `existing`. A joint whose name is still its kind's default is renamed with its new kind.
 */
export function buildJoint(
  form: JointForm,
  ctx: { doc: ManufaktureDocument; partId: string; existing?: ExtensionFeature },
): JointBuild {
  const part = findPart(ctx.doc, ctx.partId);
  if (!part) return { ok: false, errors: { form: `There is no part ${ctx.partId}.` } };
  const units = ctx.doc.units;
  const variables = evaluateVariables(ctx.doc);
  const errors: Record<string, string> = {};
  const existing = ctx.existing;
  const index = existing ? part.features.findIndex((f) => f.id === existing.id) : barOf(part);
  const boards = new Set(jointBoards(part, index).map((b) => b.id));
  const boardError = (id: string): string | null => {
    if (id === '') return 'Choose a board.';
    if (boards.has(id)) return null;
    const f = part.features.find((x) => x.id === id);
    if (!f) return `${id} is not in this part studio.`;
    if (!isBoard(f)) return `${f.name} is not a board.`;
    return `${f.name} comes after this joint or is suppressed.`;
  };
  const ea = boardError(form.a);
  if (ea) errors.a = ea;
  const eb = boardError(form.b);
  if (eb) errors.b = eb;
  else if (form.a === form.b) errors.b = 'Choose two different boards.';

  const expressions: Record<string, StoredExpression> = {};
  for (const name of KIND_EXPRESSIONS[form.kind]) {
    const source = (form.values[name] ?? '').trim();
    if (source === '') continue;
    const kind = jointExpressionKind(name);
    const r = checkExpression(source, kind, units, variables, {
      ...(kind === 'number' ? { integer: true, positive: true } : {}),
    });
    if (r.ok) expressions[name] = r.expression;
    else errors[name] = r.message;
  }
  if (form.kind === 'dado' && form.stopped !== 'none' && !expressions.stop && !errors.stop) {
    errors.stop = 'A stopped dado needs the stop: how far short of the end it stops.';
  }

  const params: Record<string, JsonValue> = { kind: form.kind, a: form.a, b: form.b };
  if (form.kind === 'dado' && form.stopped !== 'none') params.stopped = form.stopped;
  if (form.kind === 'mortise-tenon' && form.ends !== 'square') params.ends = form.ends;
  if (form.kind === 'pocket-screw' && form.face !== 'low') params.face = form.face;
  if (form.kind === 'box-joint' && form.start !== 'a') params.start = form.start;
  // A through dado has no stop; any typed one is dropped rather than refused.
  if (form.kind === 'dado' && form.stopped === 'none') {
    delete expressions.stop;
    delete errors.stop;
  }
  if (Object.keys(errors).length === 0) {
    const r = readJointParams(params as Json, JOINT_SCHEMA_VERSION);
    if (!r.ok) errors[fieldOf(r.field)] = r.message;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const id = existing?.id ?? previewIds(part.nextIds, 'extension')[0]!;
  const oldKind = existing ? jointFormOf(existing) : null;
  const keepName =
    existing &&
    !(
      oldKind?.ok &&
      oldKind.form.kind !== form.kind &&
      existing.name === defaultName(oldKind.form.kind, id)
    );
  const name = keepName ? existing.name : defaultName(form.kind, id);
  const feature: ExtensionFeature = {
    id,
    kind: 'extension',
    name,
    suppressed: existing?.suppressed ?? false,
    extension: JOINT_TYPE,
    schemaVersion: JOINT_SCHEMA_VERSION,
    dependsOn: [form.a, form.b],
    scope: [form.a, form.b],
    references: [],
    expressions,
    params,
  };
  const command: Command = existing
    ? { type: 'editFeature', partId: ctx.partId, feature }
    : { type: 'addFeature', partId: ctx.partId, feature };
  return { ok: true, feature, command, label: `${existing ? 'Edit' : 'Add'} ${name}` };
}

// The preview ------------------------------------------------------------------------------------

export type JointPreview =
  /** The boards are not built yet (or the form is not filled in): nothing to show. */
  | { state: 'waiting'; message: string }
  /** The domain refuses the joint: why, and the form field at fault. */
  | { state: 'refused'; message: string; field: string }
  | { state: 'ok'; items: ToolItem[]; metadata: JointMetadata };

/** The regen results of a part's features, by id, as the model store holds them. */
export type Results = ReadonlyMap<string, FeatureResult>;

/**
 * What the form would build, by the domain's own translator, from the board frames regen last
 * reported for the part. Refusals come back readable (board ids replaced by their names).
 */
export function previewJoint(
  form: JointForm,
  ctx: {
    doc: ManufaktureDocument;
    partId: string;
    results: Results;
    existing?: ExtensionFeature | undefined;
  },
): JointPreview {
  const part = findPart(ctx.doc, ctx.partId);
  if (!part) return { state: 'waiting', message: 'There is no part.' };
  const built = buildJoint(
    form,
    ctx.existing
      ? { doc: ctx.doc, partId: ctx.partId, existing: ctx.existing }
      : { doc: ctx.doc, partId: ctx.partId },
  );
  if (!built.ok) {
    return {
      state: 'waiting',
      message:
        'The joint is shown in the view once both boards are chosen and the fields are valid.',
    };
  }
  const feature = built.feature;
  const index = ctx.existing
    ? part.features.findIndex((f) => f.id === ctx.existing!.id)
    : barOf(part);
  const upstream = new Map<string, { type: string; inputs: []; metadata?: JsonValue }>();
  const bodies: string[] = [];
  for (const board of jointBoards(part, index)) {
    const r = ctx.results.get(board.id);
    if (r?.status !== 'ok' || readBoardMetadata(r.metadata) === undefined) continue;
    bodies.push(board.id);
    upstream.set(board.id, {
      type: board.extension,
      inputs: [],
      metadata: r.metadata as JsonValue,
    });
  }
  for (const id of [form.a, form.b]) {
    if (!upstream.has(id)) {
      const name = part.features.find((f) => f.id === id)?.name ?? id;
      return {
        state: 'waiting',
        message: `${name} is not built yet: the joint is shown once it is.`,
      };
    }
  }
  const params = readJointParams(feature.params as Json, JOINT_SCHEMA_VERSION);
  if (!params.ok)
    return { state: 'refused', message: params.message, field: fieldOf(params.field) };
  const variables = evaluateVariables(ctx.doc);
  const values: Record<string, number> = {};
  for (const [k, e] of Object.entries(feature.expressions)) {
    const r = checkExpression(e.source, jointExpressionKind(k), ctx.doc.units, variables);
    if (!r.ok) return { state: 'waiting', message: r.message };
    values[k] = r.value;
  }
  const context = {
    feature,
    params: params.value,
    values,
    references: {},
    data: {},
    sketches: new Map(),
    upstream,
    bodies,
    profile: () => ({ ok: false, message: 'a joint reads no sketch' }),
  } as unknown as ExtensionContext<JointParams>;
  let out: ReturnType<typeof translateJoint>;
  try {
    out = translateJoint(context);
  } catch (e) {
    return { state: 'refused', message: readable(String(e), form, part.features), field: 'form' };
  }
  if ('error' in out) {
    return {
      state: 'refused',
      message: readable(out.error, form, part.features),
      field: fieldOf(out.field),
    };
  }
  const input = out.inputs[0];
  const metadata = out.metadata as unknown as JointMetadata;
  return {
    state: 'ok',
    items: input && input.kind === 'tools' ? [...input.items] : [],
    metadata: {
      ...metadata,
      warnings: metadata.warnings.map((w) => ({
        ...w,
        message: readable(w.message, form, part.features),
      })),
    },
  };
}

/** A board's name with its role in the joint (`Shelf (B)`), for messages. */
export function boardRole(
  id: string,
  form: Pick<JointForm, 'a' | 'b'>,
  features: readonly Feature[],
): string {
  const name = features.find((f) => f.id === id)?.name ?? id;
  return id === form.a ? `${name} (A)` : id === form.b ? `${name} (B)` : name;
}

/**
 * A domain message as the dialog shows it: board ids replaced by the boards' names and roles, the
 * first letter capitalised, ending in a full stop.
 */
export function readable(
  message: string,
  form: Pick<JointForm, 'a' | 'b'>,
  features: readonly Feature[],
): string {
  let text = message.replace(/\b[a-z][a-zA-Z0-9]*#\d+(?![0-9])/g, (id) =>
    features.some((f) => f.id === id) ? boardRole(id, form, features) : id,
  );
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** Which tools act on each board: names of the tools cut from (or added to) A and B. */
export function toolsByBoard(
  items: readonly ToolItem[],
  form: Pick<JointForm, 'a' | 'b'>,
): { a: { cut: string[]; added: string[] }; b: { cut: string[]; added: string[] } } {
  const out = {
    a: { cut: [] as string[], added: [] as string[] },
    b: { cut: [] as string[], added: [] as string[] },
  };
  for (const item of items) {
    const side = item.body === form.a ? out.a : item.body === form.b ? out.b : null;
    if (!side) continue;
    (item.mode === 'add' ? side.added : side.cut).push(item.id);
  }
  return out;
}

const TOOL_NAMES: [RegExp, string][] = [
  [/^groove$/, 'groove'],
  [/^notch-/, 'notch at a stop'],
  [/^cheek-/, 'tenon cheek'],
  [/^shoulder-/, 'tenon shoulder'],
  [/^mortise-end-/, 'rounded mortise end'],
  [/^mortise$/, 'mortise'],
  [/^round-/, 'rounded tenon edge'],
  [/^[ab]-hole-/, 'dowel hole'],
  [/^pocket-/, 'pocket hole'],
  [/^[ab]-slot-/, 'finger slot'],
];

/** Tool ids as a list of what they are, counted (`groove`, `4 dowel holes`). */
export function toolSummary(ids: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const id of ids) {
    const name = TOOL_NAMES.find(([re]) => re.test(id))?.[1] ?? id;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, n]) => (n === 1 ? `a ${name}` : `${n} ${name}s`))
    .join(', ')
    .replace(/^a ([aeiou])/, 'an $1');
}

// Lines to draw -----------------------------------------------------------------------------------

type V = readonly number[];
const add = (a: V, b: V): Vec3 => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
const sub = (a: V, b: V): Vec3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const scale = (a: V, s: number): Vec3 => [a[0]! * s, a[1]! * s, a[2]! * s];
const dot = (a: V, b: V) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: V, b: V): Vec3 => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
const unit = (a: V): Vec3 => {
  const n = Math.hypot(a[0]!, a[1]!, a[2]!);
  return n > 0 ? scale(a, 1 / n) : [0, 0, 0];
};

/** Two unit vectors square to `d` and to each other. */
function perpendiculars(d: Vec3): [Vec3, Vec3] {
  const helper: Vec3 = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(cross(d, helper));
  return [u, cross(d, u)];
}

const SEGMENTS = 24;

function circle(centre: Vec3, u: Vec3, v: Vec3, r: number): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    const t = (2 * Math.PI * i) / SEGMENTS;
    pts.push(add(centre, add(scale(u, r * Math.cos(t)), scale(v, r * Math.sin(t)))));
  }
  return pts;
}

/** The edges of one tool primitive, as polylines in world coordinates. */
export function primitiveEdges(item: ToolItem): Vec3[][] {
  const p = item.primitive;
  if (p.type === 'box') {
    const z = unit(p.frame.normal);
    const x = unit(sub(p.frame.xDir, scale(z, dot(p.frame.xDir, z))));
    const y = cross(z, x);
    const [sx, sy, sz] = p.size;
    const c = (i: number, j: number, k: number) =>
      add(p.frame.origin, add(scale(x, i * sx), add(scale(y, j * sy), scale(z, k * sz))));
    const ring = (k: number) => [c(0, 0, k), c(1, 0, k), c(1, 1, k), c(0, 1, k), c(0, 0, k)];
    return [
      ring(0),
      ring(1),
      [c(0, 0, 0), c(0, 0, 1)],
      [c(1, 0, 0), c(1, 0, 1)],
      [c(1, 1, 0), c(1, 1, 1)],
      [c(0, 1, 0), c(0, 1, 1)],
    ];
  }
  const d = unit(p.axis.direction);
  const [u, v] = perpendiculars(d);
  const o = p.axis.origin;
  const at = (s: number) => add(o, scale(d, s));
  const out: Vec3[][] = [];
  let from = 0;
  if (p.step) {
    const sl = p.step.length;
    out.push(circle(o, u, v, p.step.radius), circle(at(sl), u, v, p.step.radius));
    for (const w of [u, v, scale(u, -1), scale(v, -1)]) {
      out.push([add(o, scale(w, p.step.radius)), add(at(sl), scale(w, p.step.radius))]);
    }
    from = sl;
  }
  out.push(circle(at(from), u, v, p.radius), circle(at(p.length), u, v, p.radius));
  for (const w of [u, v, scale(u, -1), scale(v, -1)]) {
    out.push([add(at(from), scale(w, p.radius)), add(at(p.length), scale(w, p.radius))]);
  }
  if (p.tip) {
    const apex = at(p.length + p.radius / Math.tan(p.tip.angle / 2));
    for (const w of [u, v, scale(u, -1), scale(v, -1)]) {
      out.push([add(at(p.length), scale(w, p.radius)), apex]);
    }
  }
  return out;
}

/** A polyline broken into dashes (each a polyline of its own), about `dash` long with equal gaps. */
export function dashed(line: readonly Vec3[], dash: number): Vec3[][] {
  const out: Vec3[][] = [];
  let current: Vec3[] = [];
  let on = true;
  let left = dash;
  for (let i = 1; i < line.length; i++) {
    let p = line[i - 1]!;
    const q = line[i]!;
    let seg = Math.hypot(...sub(q, p));
    if (on && current.length === 0) current.push(p);
    while (seg > left) {
      const m = add(p, scale(sub(q, p), left / seg));
      if (on) {
        current.push(m);
        out.push(current);
        current = [];
      } else current = [m];
      on = !on;
      seg -= left;
      p = m;
      left = dash;
    }
    left -= seg;
    if (on) current.push(q);
  }
  if (on && current.length > 1) out.push(current);
  return out;
}

/**
 * The preview lines of a joint's tools: solid outlines for the tools on A (what is cut from the
 * receiving board), dashed ones for the tools on B (what is cut from, or added to, the entering
 * board), so the view shows which board is cut where.
 */
export function jointPreviewLines(
  items: readonly ToolItem[],
  form: Pick<JointForm, 'a' | 'b'>,
): Vec3[][] {
  const out: Vec3[][] = [];
  for (const item of items) {
    const edges = primitiveEdges(item);
    if (item.body === form.a) out.push(...edges);
    else {
      const p = item.primitive;
      const size = p.type === 'box' ? Math.min(...p.size.filter((s) => s > 0)) : p.radius * 2;
      // About four dashes across the tool's smallest size, never under half a millimetre.
      const dash = Math.max(0.5, size / 8);
      for (const e of edges) out.push(...dashed(e, dash));
    }
  }
  return out;
}
