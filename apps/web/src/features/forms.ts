// The feature dialogs' logic, free of React: the form each dialog edits, where a new one starts,
// how an existing feature fills it, and how a filled form becomes one core command. Numbers are
// typed as expressions and stored with the units they were typed under (ADR 0004 decision 7);
// faces and edges are core references with names from the naming layer, never placeholders.

import {
  bareUnits,
  bodyCreator,
  defaultFeatureName,
  featureDependencies,
  findPart,
  isFeatureActive,
  previewIds,
  type ChamferFeature,
  type Command,
  type DisplayUnits,
  type EdgeRef,
  type ExtrudeFeature,
  type FaceRef,
  type Feature,
  type FilletFeature,
  type HoleFeature,
  type ManufaktureDocument,
  type MirrorFeature,
  type Part,
  type PatternFeature,
  type Reference,
  type RevolveFeature,
  type ShellFeature,
  type SketchFeature,
  type StoredExpression,
} from '@manufakture/core';
import { HOLE_SIZES, holeSize, type HoleFit } from '@manufakture/kernel';
import { evaluate, fromMillimetres, fromRadians } from '@manufakture/units';
import { evaluateVariables, type Variables } from '../sketcher/values';

export { DIALOG_KINDS, isDialogKind, type DialogKind } from './kinds';
import type { DialogKind } from './kinds';

export type Operation = ExtrudeFeature['operation'];

/** How a pattern or mirror of bodies places its copies (core's `mode`). */
export type BodyCopyMode = NonNullable<PatternFeature['mode']>;

/** A face or edge in a reference field: the reference to store, and what to show for it. */
export interface RefItem {
  /** The core reference id when it was stored before (kept on edit), else null. */
  id: string | null;
  ref: FaceRef | EdgeRef;
  label: string;
  /** The last regen could not resolve it: the user should pick it again. */
  lost?: boolean;
}

export type RefKind = 'face' | 'edge';

export interface ExtrudeForm {
  kind: 'extrude';
  sketch: string;
  /** Profile entities of an existing feature, kept as they were (every region when absent). */
  entities?: string[];
  operation: Operation;
  extent: 'blind' | 'symmetric' | 'throughAll' | 'upToFace';
  distance: string;
  upToFace: RefItem[];
  reverse: boolean;
  /** Draft angle; empty for none. */
  draft: string;
  /** The bodies it acts on (not for a new body); absent: every body. */
  scope?: string[];
}

export interface RevolveForm {
  kind: 'revolve';
  sketch: string;
  entities?: string[];
  operation: Operation;
  axisType: 'sketchLine' | 'edge';
  axisLine: string;
  axisEdge: RefItem[];
  flip: boolean;
  angle: string;
  symmetric: boolean;
  /** The bodies it acts on (not for a new body); absent: every body. */
  scope?: string[];
}

export interface FilletForm {
  kind: 'fillet';
  edges: RefItem[];
  radius: string;
}

export interface ChamferForm {
  kind: 'chamfer';
  edges: RefItem[];
  mode: 'equal' | 'two' | 'angle';
  distance: string;
  secondDistance: string;
  angle: string;
}

export interface ShellForm {
  kind: 'shell';
  faces: RefItem[];
  thickness: string;
  outward: boolean;
}

export interface HoleForm {
  kind: 'hole';
  sketch: string;
  points: string[];
  /** A size of `HOLE_SIZES`, or empty for a custom diameter. */
  standard: string;
  fit: HoleFit;
  diameter: string;
  extent: 'blind' | 'throughAll';
  depth: string;
  head: 'simple' | 'counterbore' | 'countersink';
  headDiameter: string;
  headDepth: string;
  headAngle: string;
  /** The bodies it cuts; absent: every body. */
  scope?: string[];
}

export interface PatternForm {
  kind: 'pattern';
  source: 'features' | 'body';
  features: string[];
  layout: 'linear' | 'circular';
  /** The direction (linear) or axis (circular). */
  direction: RefItem[];
  flip: boolean;
  count: string;
  spacing: string;
  angle: string;
  /** With `source: 'body'`, the bodies to copy; absent: every body. */
  scope?: string[];
  /** With `source: 'body'`: copies as new bodies, or fused; absent: core's default. */
  mode?: BodyCopyMode;
}

export interface MirrorForm {
  kind: 'mirror';
  source: 'features' | 'body';
  features: string[];
  plane: RefItem[];
  /** With `source: 'body'`, the bodies to mirror; absent: every body. */
  scope?: string[];
  /** With `source: 'body'`: the image as a new body, or fused; absent: core's default. */
  mode?: BodyCopyMode;
}

export type FeatureForm =
  | ExtrudeForm
  | RevolveForm
  | FilletForm
  | ChamferForm
  | ShellForm
  | HoleForm
  | PatternForm
  | MirrorForm;

/** A reference field of a form: which key holds it and what it takes. */
export interface RefField {
  key: string;
  label: string;
  accepts: readonly RefKind[];
  /** At most this many (one for a plane, an axis, an up-to face). */
  max: number;
  /** At least one is needed. */
  required: boolean;
}

/** The reference fields a form shows now (some depend on choices in it). */
export function refFields(form: FeatureForm): RefField[] {
  switch (form.kind) {
    case 'extrude':
      return form.extent === 'upToFace'
        ? [{ key: 'upToFace', label: 'Up to face', accepts: ['face'], max: 1, required: true }]
        : [];
    case 'revolve':
      return form.axisType === 'edge'
        ? [{ key: 'axisEdge', label: 'Axis edge', accepts: ['edge'], max: 1, required: true }]
        : [];
    case 'fillet':
    case 'chamfer':
      return [{ key: 'edges', label: 'Edges', accepts: ['edge'], max: Infinity, required: true }];
    case 'shell':
      return [
        {
          key: 'faces',
          label: 'Faces to remove',
          accepts: ['face'],
          max: Infinity,
          required: false,
        },
      ];
    case 'hole':
      return [];
    case 'pattern':
      return [
        {
          key: 'direction',
          label: form.layout === 'linear' ? 'Direction' : 'Axis',
          accepts: ['edge', 'face'],
          max: 1,
          required: true,
        },
      ];
    case 'mirror':
      return [{ key: 'plane', label: 'Mirror plane', accepts: ['face'], max: 1, required: true }];
  }
}

/**
 * Whether the form, as filled now, acts on existing bodies and so has a scope: an operation other
 * than a new body, a hole, or a pattern or mirror of bodies.
 */
export function takesScope(form: FeatureForm): boolean {
  switch (form.kind) {
    case 'extrude':
    case 'revolve':
      return form.operation !== 'new';
    case 'hole':
      return true;
    case 'pattern':
    case 'mirror':
      return form.source === 'body';
    default:
      return false;
  }
}

/** A body a scope can name, with the name the Bodies section shows for it. */
export interface ScopeBody {
  bodyId: string;
  name: string;
}

/**
 * The bodies a feature at `index` can act on: the part's bodies (`bodies`, as the last regen
 * made them) whose creating feature comes before it, plus any its scope already names (a body
 * regen no longer makes is kept, so the user can see and remove it).
 */
export function scopeBodies(
  part: Part,
  index: number,
  bodies: readonly ScopeBody[],
  scope: readonly string[] = [],
): ScopeBody[] {
  const before = new Set(part.features.slice(0, index).map((f) => f.id));
  const out = bodies.filter((b) => before.has(bodyCreator(b.bodyId) ?? ''));
  for (const id of scope) {
    if (!out.some((b) => b.bodyId === id)) out.push({ bodyId: id, name: id });
  }
  return out;
}

/** The form's scope (absent: every body); `undefined` for kinds that have none. */
export function scopeOf(form: FeatureForm): readonly string[] | undefined {
  return 'scope' in form ? form.scope : undefined;
}

/** The form with its scope set (`undefined`: every body). */
export function withScope(form: FeatureForm, scope: readonly string[] | undefined): FeatureForm {
  const { scope: _old, ...rest } = form as FeatureForm & { scope?: string[] };
  void _old;
  return (scope === undefined ? rest : { ...rest, scope: [...scope] }) as FeatureForm;
}

export function refsOf(form: FeatureForm, key: string): RefItem[] {
  const v = (form as unknown as Record<string, unknown>)[key];
  return Array.isArray(v) ? (v as RefItem[]) : [];
}

export function withRefs(form: FeatureForm, key: string, refs: RefItem[]): FeatureForm {
  return { ...form, [key]: refs } as FeatureForm;
}

/** Add a picked reference to a field (replacing a lost one first, or the only one of a max-1 field). */
export function addRef(form: FeatureForm, field: RefField, item: RefItem): FeatureForm {
  const refs = refsOf(form, field.key);
  const key = refKey(item.ref);
  if (refs.some((r) => refKey(r.ref) === key)) return form;
  const lost = refs.findIndex((r) => r.lost);
  if (lost >= 0) {
    // The replacement keeps the lost reference's id, so nothing else changes.
    const next = refs.slice();
    next[lost] = { ...item, id: refs[lost]!.id };
    return withRefs(form, field.key, next);
  }
  if (field.max === 1) return withRefs(form, field.key, [item]);
  if (refs.length >= field.max) return form;
  return withRefs(form, field.key, [...refs, item]);
}

export function removeRef(form: FeatureForm, key: string, index: number): FeatureForm {
  return withRefs(
    form,
    key,
    refsOf(form, key).filter((_, i) => i !== index),
  );
}

export function refKey(ref: FaceRef | EdgeRef): string {
  return JSON.stringify(ref);
}

/** What a reference is shown as in a field. */
export function refLabel(ref: FaceRef | EdgeRef): string {
  if ('face' in ref) return ref.face;
  return ref.faces.join(' | ') + (ref.ordinal !== undefined ? ` #${ref.ordinal}` : '');
}

// Starting points -------------------------------------------------------------------------

export interface FormContext {
  doc: ManufaktureDocument;
  partId: string;
  /** Feature ids selected in the tree, in selection order (a sketch to extrude, a feature to pattern). */
  selectedFeatures?: readonly string[];
}

/** The sketches a new feature can use: active sketches before the rollback bar. */
export function availableSketches(part: Part, before: number = barOf(part)): SketchFeature[] {
  return part.features
    .slice(0, before)
    .filter((f, i): f is SketchFeature => f.kind === 'sketch' && isFeatureActive(part, i));
}

/** Features a pattern or mirror can repeat: extrusions, revolves and holes before it. */
export function repeatableFeatures(part: Part, before: number = barOf(part)): Feature[] {
  return part.features
    .slice(0, before)
    .filter((f) => f.kind === 'extrude' || f.kind === 'revolve' || f.kind === 'hole');
}

function barOf(part: Part): number {
  return part.rollbackIndex ?? part.features.length;
}

/** Whether a body exists before position `before`: an active feature that makes solids. */
function hasBody(part: Part, before: number): boolean {
  return part.features
    .slice(0, before)
    .some(
      (f, i) =>
        isFeatureActive(part, i) &&
        (f.kind === 'extrude' ||
          f.kind === 'revolve' ||
          (f.kind === 'import' && f.operation !== 'reference')),
    );
}

function lengthText(mm: number, units: DisplayUnits): string {
  const v = fromMillimetres(mm, bareUnits(units).lengthUnit);
  return String(Math.round(v * 1000) / 1000);
}

function angleText(rad: number, units: DisplayUnits): string {
  const v = fromRadians(rad, bareUnits(units).angleUnit);
  return String(Math.round(v * 1000) / 1000);
}

/** A new feature's form, filled from the selection where it helps. */
export function newForm(kind: DialogKind, ctx: FormContext): FeatureForm {
  const part = findPart(ctx.doc, ctx.partId)!;
  const units = ctx.doc.units;
  const bar = barOf(part);
  const sketches = availableSketches(part, bar);
  const selected = ctx.selectedFeatures ?? [];
  const selectedSketch =
    [...selected].reverse().find((id) => sketches.some((s) => s.id === id)) ??
    sketches.at(-1)?.id ??
    '';
  const operation: Operation = hasBody(part, bar) ? 'add' : 'new';
  const len = (mm: number) => lengthText(mm, units);
  switch (kind) {
    case 'extrude':
      return {
        kind,
        sketch: selectedSketch,
        operation,
        extent: 'blind',
        distance: len(10),
        upToFace: [],
        reverse: false,
        draft: '',
      };
    case 'revolve': {
      const sketch = sketches.find((s) => s.id === selectedSketch);
      const line = sketch?.entities.find((e) => e.kind === 'line');
      return {
        kind,
        sketch: selectedSketch,
        operation,
        axisType: 'sketchLine',
        axisLine: line?.id ?? '',
        axisEdge: [],
        flip: false,
        angle: angleText(2 * Math.PI, units),
        symmetric: false,
      };
    }
    case 'fillet':
      return { kind, edges: [], radius: len(2) };
    case 'chamfer':
      return {
        kind,
        edges: [],
        mode: 'equal',
        distance: len(1),
        secondDistance: len(2),
        angle: angleText(Math.PI / 4, units),
      };
    case 'shell':
      return { kind, faces: [], thickness: len(2), outward: false };
    case 'hole': {
      const sketch = sketches.find((s) => s.id === selectedSketch);
      const size = HOLE_SIZES.find((s) => s.size === 'M5')!;
      return {
        kind,
        sketch: selectedSketch,
        points: (sketch?.entities ?? []).filter((e) => e.kind === 'point').map((e) => e.id),
        ...standardFields(size.size, 'normal', units),
        fit: 'normal',
        extent: 'throughAll',
        depth: len(10),
        head: 'simple',
      };
    }
    case 'pattern':
    case 'mirror': {
      const repeatable = repeatableFeatures(part, bar).map((f) => f.id);
      const features = selected.filter((id) => repeatable.includes(id));
      const source = features.length > 0 || repeatable.length > 0 ? 'features' : 'body';
      const chosen = features.length > 0 ? features : repeatable.slice(-1);
      if (kind === 'mirror') {
        return { kind, source, features: source === 'body' ? [] : chosen, plane: [] };
      }
      return {
        kind,
        source,
        features: source === 'body' ? [] : chosen,
        layout: 'linear',
        direction: [],
        flip: false,
        count: '3',
        spacing: len(20),
        angle: angleText(2 * Math.PI, units),
      };
    }
  }
}

/** The fields a standard hole size sets: its diameter and head sizes, in the display units. */
export function standardFields(
  size: string,
  fit: HoleFit,
  units: DisplayUnits,
): Pick<HoleForm, 'standard' | 'diameter' | 'headDiameter' | 'headDepth' | 'headAngle'> {
  const s = holeSize(size);
  if (!s) {
    return { standard: '', diameter: '', headDiameter: '', headDepth: '', headAngle: '' };
  }
  return {
    standard: s.size,
    diameter: lengthText(s.clearance[fit], units),
    headDiameter: lengthText(s.counterbore.diameter, units),
    headDepth: lengthText(s.counterbore.depth, units),
    headAngle: angleText(s.countersink.angle, units),
  };
}

/** A hole form after choosing a standard size, a fit or a head: the sizes follow the standard. */
export function applyStandard(form: HoleForm, units: DisplayUnits): HoleForm {
  if (form.standard === '') return form;
  const s = holeSize(form.standard);
  if (!s) return { ...form, standard: '' };
  const f = standardFields(form.standard, form.fit, units);
  return {
    ...form,
    ...f,
    headDiameter: lengthText(
      form.head === 'countersink' ? s.countersink.diameter : s.counterbore.diameter,
      units,
    ),
  };
}

const text = (e: StoredExpression | undefined) => e?.source ?? '';

function refItems(refs: readonly Reference[], lost: ReadonlySet<string>): RefItem[] {
  return refs.map((r) => ({
    id: r.id,
    ref: r.ref,
    label: refLabel(r.ref),
    ...(lost.has(r.id) ? { lost: true } : {}),
  }));
}

/**
 * The form of an existing feature, or null for kinds without a dialog. `lost` lists reference
 * ids regen could not resolve, so the dialog asks for them again.
 */
export function formOf(
  feature: Feature,
  lost: ReadonlySet<string> = new Set(),
): FeatureForm | null {
  const items = (refs: readonly Reference[]) => refItems(refs, lost);
  switch (feature.kind) {
    case 'extrude': {
      const e = feature.extent;
      return {
        kind: 'extrude',
        sketch: feature.profile.sketch,
        ...(feature.profile.entities ? { entities: [...feature.profile.entities] } : {}),
        operation: feature.operation,
        extent: e.type,
        distance: e.type === 'blind' || e.type === 'symmetric' ? e.distance.source : '10',
        upToFace: e.type === 'upToFace' ? items([e.face]) : [],
        reverse: feature.reverse,
        draft: text(feature.draft),
        ...scopeField(feature.scope),
      };
    }
    case 'revolve':
      return {
        kind: 'revolve',
        sketch: feature.profile.sketch,
        ...(feature.profile.entities ? { entities: [...feature.profile.entities] } : {}),
        operation: feature.operation,
        axisType: feature.axis.type,
        axisLine: feature.axis.type === 'sketchLine' ? feature.axis.entity : '',
        axisEdge: feature.axis.type === 'edge' ? items([feature.axis.edge]) : [],
        flip: feature.axis.flip ?? false,
        angle: feature.angle.source,
        symmetric: feature.symmetric,
        ...scopeField(feature.scope),
      };
    case 'fillet':
      return { kind: 'fillet', edges: items(feature.edges), radius: feature.radius.source };
    case 'chamfer':
      return {
        kind: 'chamfer',
        edges: items(feature.edges),
        mode: feature.secondDistance ? 'two' : feature.angle ? 'angle' : 'equal',
        distance: feature.distance.source,
        secondDistance: feature.secondDistance?.source ?? feature.distance.source,
        angle: feature.angle?.source ?? '45',
      };
    case 'shell':
      return {
        kind: 'shell',
        faces: items(feature.faces),
        thickness: feature.thickness.source,
        outward: feature.outward,
      };
    case 'hole': {
      const h = feature.head;
      return {
        kind: 'hole',
        sketch: feature.sketch,
        points: [...feature.points],
        standard: feature.standard?.size ?? '',
        fit: feature.standard?.fit ?? 'normal',
        diameter: feature.diameter.source,
        extent: feature.extent.type,
        depth: feature.extent.type === 'blind' ? feature.extent.depth.source : '10',
        head: h.type,
        headDiameter: h.type === 'simple' ? '' : h.diameter.source,
        headDepth: h.type === 'counterbore' ? h.depth.source : '',
        headAngle: h.type === 'countersink' ? h.angle.source : '90',
        ...scopeField(feature.scope),
      };
    }
    case 'pattern': {
      const l = feature.layout;
      return {
        kind: 'pattern',
        source: feature.body ? 'body' : 'features',
        features: [...feature.features],
        layout: l.type,
        direction: items([l.type === 'linear' ? l.direction : l.axis]),
        flip: l.flip ?? false,
        count: l.count.source,
        spacing: l.type === 'linear' ? l.spacing.source : '20',
        angle: l.type === 'circular' ? l.angle.source : '360',
        ...scopeField(feature.scope),
        ...(feature.mode !== undefined ? { mode: feature.mode } : {}),
      };
    }
    case 'mirror':
      return {
        kind: 'mirror',
        source: feature.body ? 'body' : 'features',
        features: [...feature.features],
        plane: items([feature.plane]),
        ...scopeField(feature.scope),
        ...(feature.mode !== undefined ? { mode: feature.mode } : {}),
      };
    default:
      return null;
  }
}

function scopeField(scope: readonly string[] | undefined): { scope?: string[] } {
  return scope === undefined ? {} : { scope: [...scope] };
}

// Building -------------------------------------------------------------------------------

export type ValueKind = 'length' | 'angle' | 'number';

export type ExpressionCheck =
  { ok: true; value: number; expression: StoredExpression } | { ok: false; message: string };

/**
 * Check text typed into a numeric field: it must evaluate, with the document's variables, to
 * the kind the field holds. `positive` refuses zero and less; `integer` refuses fractions.
 */
export function checkExpression(
  source: string,
  kind: ValueKind,
  units: DisplayUnits,
  variables: Variables,
  options: { positive?: boolean; nonNegative?: boolean; integer?: boolean } = {},
): ExpressionCheck {
  const expression: StoredExpression = { source: source.trim(), ...bareUnits(units) };
  if (expression.source === '') return { ok: false, message: 'Enter a value.' };
  const r = evaluate(expression.source, {
    expected: kind,
    lengthUnit: expression.lengthUnit,
    angleUnit: expression.angleUnit,
    variables: (n) => variables[n],
  });
  if (!r.ok) return { ok: false, message: r.error.message };
  if (options.positive && !(r.value > 0)) return { ok: false, message: 'Must be more than zero.' };
  if (options.nonNegative && !(r.value >= 0))
    return { ok: false, message: 'Must not be negative.' };
  if (options.integer && !Number.isInteger(r.value)) {
    return { ok: false, message: 'Must be a whole number.' };
  }
  return { ok: true, value: r.value, expression };
}

export type BuildResult =
  | { ok: true; feature: Feature; command: Command; label: string }
  | { ok: false; errors: Record<string, string> };

/**
 * Turn a filled form into the feature and the command that adds it (at the rollback bar) or
 * edits `existing`. Field errors are keyed by form field.
 */
export function buildFeature(
  form: FeatureForm,
  ctx: { doc: ManufaktureDocument; partId: string; existing?: Feature },
): BuildResult {
  const part = findPart(ctx.doc, ctx.partId);
  if (!part) return { ok: false, errors: { form: `There is no part ${ctx.partId}.` } };
  const units = ctx.doc.units;
  const variables = evaluateVariables(ctx.doc);
  const errors: Record<string, string> = {};
  const expr = (
    field: string,
    source: string,
    kind: ValueKind,
    options: Parameters<typeof checkExpression>[4] = {},
  ): StoredExpression => {
    const r = checkExpression(source, kind, units, variables, options);
    if (r.ok) return r.expression;
    errors[field] = r.message;
    return { source, ...bareUnits(units) };
  };

  const existing = ctx.existing;
  const id = existing?.id ?? previewIds(part.nextIds, form.kind)[0]!;
  const name = existing?.name ?? defaultFeatureName(form.kind, id);
  // Reference ids: kept for references stored before, fresh ones (never reused) for the rest.
  const fresh = [...previewIds(part.nextIds, 'r', 64)];
  const taken = new Set<string>();
  const reference = <R extends FaceRef | EdgeRef>(item: RefItem) => {
    const refId = item.id !== null && !taken.has(item.id) ? item.id : fresh.shift()!;
    taken.add(refId);
    return { id: refId, ref: item.ref as R };
  };
  const refs = <R extends FaceRef | EdgeRef>(field: string, items: RefItem[], min = 1) => {
    if (items.length < min)
      errors[field] = min === 1 ? 'Pick one in the viewport.' : `Pick ${min}.`;
    return items.map((i) => reference<R>(i));
  };
  const isFace = (i: RefItem) => 'face' in i.ref;
  // Stands in for a missing pick while the errors are collected; never returned.
  const missingFace = { id: 'r1', ref: { face: 'none' } };
  const missingEdge = { id: 'r1', ref: { faces: ['none'] } };
  const base = { id, kind: form.kind, name, suppressed: existing?.suppressed ?? false };
  // Everything a new feature uses must come before where it goes.
  const index = existing ? part.features.findIndex((f) => f.id === existing.id) : barOf(part);
  const before = new Set(part.features.slice(0, index).map((f) => f.id));
  const needSketch = (field: string, sketchId: string): SketchFeature | undefined => {
    const s = part.features.find((f) => f.id === sketchId);
    if (!sketchId || !s || s.kind !== 'sketch') {
      errors[field] = 'Choose a sketch.';
      return undefined;
    }
    if (!before.has(sketchId)) errors[field] = `${s.name} comes after this feature.`;
    return s;
  };

  let feature: Feature;
  switch (form.kind) {
    case 'extrude': {
      needSketch('sketch', form.sketch);
      const extent: ExtrudeFeature['extent'] =
        form.extent === 'throughAll'
          ? { type: 'throughAll' }
          : form.extent === 'upToFace'
            ? {
                type: 'upToFace',
                face: refs<FaceRef>('upToFace', form.upToFace)[0] ?? missingFace,
              }
            : {
                type: form.extent,
                distance: expr('distance', form.distance, 'length', { positive: true }),
              };
      if (form.extent === 'upToFace' && form.upToFace.length === 0) {
        errors.upToFace = 'Pick the face to extrude up to.';
      }
      const f: ExtrudeFeature = {
        ...base,
        kind: 'extrude',
        profile: {
          sketch: form.sketch,
          ...(form.entities && form.entities.length > 0 ? { entities: form.entities } : {}),
        },
        operation: form.operation,
        extent,
        reverse: form.reverse,
      };
      if (form.draft.trim() !== '') f.draft = expr('draft', form.draft, 'angle');
      feature = f;
      break;
    }
    case 'revolve': {
      const sketch = needSketch('sketch', form.sketch);
      let axis: RevolveFeature['axis'];
      if (form.axisType === 'sketchLine') {
        const line = sketch?.entities.find((e) => e.id === form.axisLine);
        if (!line || line.kind !== 'line') errors.axisLine = 'Choose a line of the sketch.';
        axis = { type: 'sketchLine', entity: form.axisLine || 'e1' };
      } else {
        axis = { type: 'edge', edge: refs<EdgeRef>('axisEdge', form.axisEdge)[0] ?? missingEdge };
        if (form.axisEdge.length === 0) errors.axisEdge = 'Pick a straight edge as the axis.';
      }
      if (form.flip) axis.flip = true;
      feature = {
        ...base,
        kind: 'revolve',
        profile: {
          sketch: form.sketch,
          ...(form.entities && form.entities.length > 0 ? { entities: form.entities } : {}),
        },
        axis,
        angle: expr('angle', form.angle, 'angle', { positive: true }),
        symmetric: form.symmetric,
        operation: form.operation,
      } satisfies RevolveFeature;
      break;
    }
    case 'fillet':
      feature = {
        ...base,
        kind: 'fillet',
        edges: refs<EdgeRef>('edges', form.edges),
        radius: expr('radius', form.radius, 'length', { positive: true }),
      } satisfies FilletFeature;
      break;
    case 'chamfer': {
      const f: ChamferFeature = {
        ...base,
        kind: 'chamfer',
        edges: refs<EdgeRef>('edges', form.edges),
        distance: expr('distance', form.distance, 'length', { positive: true }),
      };
      if (form.mode === 'two') {
        f.secondDistance = expr('secondDistance', form.secondDistance, 'length', {
          positive: true,
        });
      }
      if (form.mode === 'angle') f.angle = expr('angle', form.angle, 'angle', { positive: true });
      feature = f;
      break;
    }
    case 'shell':
      feature = {
        ...base,
        kind: 'shell',
        faces: refs<FaceRef>('faces', form.faces, 0),
        thickness: expr('thickness', form.thickness, 'length', { positive: true }),
        outward: form.outward,
      } satisfies ShellFeature;
      break;
    case 'hole': {
      const sketch = needSketch('sketch', form.sketch);
      const points = form.points.filter((p) =>
        sketch?.entities.some((e) => e.id === p && e.kind === 'point'),
      );
      if (sketch && points.length === 0) {
        errors.points = sketch.entities.some((e) => e.kind === 'point')
          ? 'Choose at least one point.'
          : `${sketch.name} has no points: add a point (the Point tool) where each hole goes.`;
      }
      const head: HoleFeature['head'] =
        form.head === 'counterbore'
          ? {
              type: 'counterbore',
              diameter: expr('headDiameter', form.headDiameter, 'length', { positive: true }),
              depth: expr('headDepth', form.headDepth, 'length', { positive: true }),
            }
          : form.head === 'countersink'
            ? {
                type: 'countersink',
                diameter: expr('headDiameter', form.headDiameter, 'length', { positive: true }),
                angle: expr('headAngle', form.headAngle, 'angle', { positive: true }),
              }
            : { type: 'simple' };
      const f: HoleFeature = {
        ...base,
        kind: 'hole',
        sketch: form.sketch,
        points: points.length > 0 ? points : ['e1'],
        diameter: expr('diameter', form.diameter, 'length', { positive: true }),
        extent:
          form.extent === 'blind'
            ? { type: 'blind', depth: expr('depth', form.depth, 'length', { positive: true }) }
            : { type: 'throughAll' },
        head,
      };
      if (form.standard !== '' && holeSize(form.standard)) {
        f.standard = { size: form.standard, fit: form.fit };
      }
      feature = f;
      break;
    }
    case 'pattern': {
      const layoutRef = refs<FaceRef | EdgeRef>('direction', form.direction)[0];
      if (form.direction.length === 0) {
        errors.direction =
          form.layout === 'linear'
            ? 'Pick an edge or a flat face for the direction.'
            : 'Pick an edge or a round face for the axis.';
      }
      const ref: Reference = layoutRef ?? missingFace;
      const count = expr('count', form.count, 'number', { positive: true, integer: true });
      const layout: PatternFeature['layout'] =
        form.layout === 'linear'
          ? {
              type: 'linear',
              direction: ref,
              count,
              spacing: expr('spacing', form.spacing, 'length', { positive: true }),
            }
          : {
              type: 'circular',
              axis: ref,
              count,
              angle: expr('angle', form.angle, 'angle', { positive: true }),
            };
      if (form.flip) layout.flip = true;
      const f: PatternFeature = {
        ...base,
        kind: 'pattern',
        features: form.source === 'body' ? [] : sources(form.features, before, errors),
        layout,
      };
      if (form.source === 'body') f.body = true;
      if (form.source === 'body' && form.mode !== undefined) f.mode = form.mode;
      feature = f;
      break;
    }
    case 'mirror': {
      const plane = refs<FaceRef>('plane', form.plane)[0];
      if (form.plane.some((p) => !isFace(p)))
        errors.plane = 'The mirror plane must be a flat face.';
      const f: MirrorFeature = {
        ...base,
        kind: 'mirror',
        features: form.source === 'body' ? [] : sources(form.features, before, errors),
        plane: plane ?? missingFace,
      };
      if (form.source === 'body') f.body = true;
      if (form.source === 'body' && form.mode !== undefined) f.mode = form.mode;
      feature = f;
      break;
    }
  }

  // The bodies it acts on: only where the feature acts on existing bodies at all.
  const scope = scopeOf(form);
  if (scope !== undefined && takesScope(form)) {
    if (scope.length === 0) errors.scope = 'Choose at least one body.';
    else (feature as Feature & { scope?: string[] }).scope = [...scope];
  }

  // Faces and edges must come from features before this one.
  for (const dep of featureDependencies(feature)) {
    if (dep !== feature.id && !before.has(dep) && !errors.form) {
      const f = part.features.find((x) => x.id === dep);
      errors.form = f
        ? `It refers to ${f.name}, which comes after it. Pick faces and edges of features above it.`
        : `It refers to ${dep}, which is not in the part.`;
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const command: Command = existing
    ? { type: 'editFeature', partId: ctx.partId, feature }
    : { type: 'addFeature', partId: ctx.partId, feature };
  return { ok: true, feature, command, label: `${existing ? 'Edit' : 'Add'} ${name}` };
}

function sources(
  ids: readonly string[],
  before: ReadonlySet<string>,
  errors: Record<string, string>,
) {
  const kept = ids.filter((i) => before.has(i));
  if (kept.length === 0) errors.features = 'Choose the features to repeat, or the whole body.';
  return kept;
}

/** The lost and ambiguous reference ids of a feature's last regen. */
export function lostReferences(
  errors: readonly { code: string; referenceId?: string }[],
): Set<string> {
  return new Set(
    errors.flatMap((e) =>
      (e.code === 'reference-lost' || e.code === 'reference-ambiguous') && e.referenceId
        ? [e.referenceId]
        : [],
    ),
  );
}
