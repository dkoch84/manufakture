// The scripted feature's dialog logic, free of React (ADR 0010 decisions 3, 6 and 8): the form
// generated from the parameters the script declares, where it starts (the stored values, else the
// script's defaults), and how a filled form becomes one core command. Numeric parameters are
// expressions like every other field, stored with the units they were typed under; `length` is in
// millimetres and `angle` in radians inside, as the script receives them. Reference parameters
// are faces or edges picked in the viewport (a `body` parameter takes any face of the body).

import {
  bareUnits,
  defaultFeatureName,
  featureDependencies,
  findPart,
  MAX_SCRIPT_SEED,
  previewIds,
  type Command,
  type DisplayUnits,
  type EdgeRef,
  type FaceRef,
  type ManufaktureDocument,
  type ScriptedFeature,
  type ScriptParamValue,
} from '@manufakture/core';
import type { ScriptDeclarationsReply } from '@manufakture/regen';
import { fromMillimetres, fromRadians } from '@manufakture/units';
import { evaluateVariables } from '../sketcher/values';
import {
  checkExpression,
  refItems,
  refKey,
  type RefField,
  type RefItem,
  type ValueKind,
} from './forms';

/** A parameter the script declares (`ParamSpec` of `@manufakture/script`). */
export type ParamSpec = Extract<ScriptDeclarationsReply, { ok: true }>['params'][number];

/** One parameter's field as the dialog edits it. */
export type ParamField =
  | { kind: 'expression'; text: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'choice'; value: string }
  | { kind: 'reference'; refs: RefItem[] };

export interface ScriptedForm {
  /** The script of the document's library it runs. */
  script: string;
  /** Per parameter name. */
  values: Record<string, ParamField>;
  /** The seed of the script's `Math.random`, as typed. */
  seed: string;
}

/** `o[name]` when `name` is `o`'s own property: a parameter may be called `constructor`. */
export function ownValue<T>(
  o: Readonly<Record<string, T>> | undefined,
  name: string,
): T | undefined {
  return o !== undefined && Object.prototype.hasOwnProperty.call(o, name) ? o[name] : undefined;
}

/** Set `o[name]` as an own data property, even for `__proto__` (a valid parameter name). */
function setOwn<T>(o: Record<string, T>, name: string, value: T): void {
  Object.defineProperty(o, name, { value, enumerable: true, writable: true, configurable: true });
}

/** `values` with `name` set to `value`, as a new object (`name` may be `__proto__`). */
export function withValue(
  values: Readonly<Record<string, ParamField>>,
  name: string,
  value: ParamField,
): Record<string, ParamField> {
  const out: Record<string, ParamField> = {};
  for (const key of Object.keys(values)) setOwn(out, key, values[key]!);
  setOwn(out, name, value);
  return out;
}

/** The key a reference parameter's field is known by (the dialog's active field). */
export const paramKey = (name: string): string => `param:${name}`;

function trim(n: number): string {
  return String(Math.round(n * 1e6) / 1e6);
}

/** A value in internal units (mm, radians) as text in the document's display units. */
export function valueText(kind: ValueKind, value: number, units: DisplayUnits): string {
  const bare = bareUnits(units);
  if (kind === 'length') return trim(fromMillimetres(value, bare.lengthUnit));
  if (kind === 'angle') return trim(fromRadians(value, bare.angleUnit));
  return trim(value);
}

/** A parameter's default as its field. */
export function defaultField(spec: ParamSpec, units: DisplayUnits): ParamField {
  switch (spec.kind) {
    case 'number':
    case 'length':
    case 'angle':
      return { kind: 'expression', text: valueText(spec.kind, spec.default, units) };
    case 'boolean':
      return { kind: 'boolean', value: spec.default };
    case 'choice':
      return { kind: 'choice', value: spec.default };
    case 'reference':
      return { kind: 'reference', refs: [] };
  }
}

/** A stored value as the field of `spec`, or null when it does not fit the declared kind. */
function storedField(
  spec: ParamSpec,
  value: ScriptParamValue,
  lost: ReadonlySet<string>,
): ParamField | null {
  switch (spec.kind) {
    case 'number':
    case 'length':
    case 'angle':
      return value.kind === 'expression'
        ? { kind: 'expression', text: value.expression.source }
        : null;
    case 'boolean':
      return value.kind === 'boolean' ? { kind: 'boolean', value: value.value } : null;
    case 'choice':
      return value.kind === 'choice' && spec.options.includes(value.value)
        ? { kind: 'choice', value: value.value }
        : null;
    case 'reference':
      return value.kind === 'reference'
        ? { kind: 'reference', refs: refItems(value.references, lost) }
        : null;
  }
}

/**
 * The fields for `specs`: each parameter's stored value where it has one that fits its kind
 * (`stored`, the feature's), its value in `keep` (what the dialog held before the declarations
 * changed), else its default.
 */
export function fieldsFor(
  specs: readonly ParamSpec[],
  units: DisplayUnits,
  options: {
    stored?: Readonly<Record<string, ScriptParamValue>>;
    lost?: ReadonlySet<string>;
    keep?: Readonly<Record<string, ParamField>>;
  } = {},
): Record<string, ParamField> {
  const out: Record<string, ParamField> = {};
  for (const spec of specs) {
    const kept = ownValue(options.keep, spec.name);
    const fresh = defaultField(spec, units);
    if (kept !== undefined && kept.kind === fresh.kind) {
      setOwn(out, spec.name, kept);
      continue;
    }
    const stored = ownValue(options.stored, spec.name);
    setOwn(
      out,
      spec.name,
      (stored !== undefined ? storedField(spec, stored, options.lost ?? new Set()) : null) ?? fresh,
    );
  }
  return out;
}

/** The form of an existing scripted feature (fields filled once the declarations are known). */
export function scriptedFormOf(feature: ScriptedFeature): ScriptedForm {
  return { script: feature.script, values: {}, seed: String(feature.seed) };
}

/** The form of a new scripted feature running `script` (the first of the library by default). */
export function newScriptedForm(doc: ManufaktureDocument, script?: string): ScriptedForm {
  return { script: script ?? doc.scripts?.[0]?.id ?? '', values: {}, seed: '0' };
}

/** The reference field of a reference parameter: what it accepts, how many, and whether needed. */
export function paramRefField(spec: ParamSpec): RefField | null {
  if (spec.kind !== 'reference') return null;
  const label = spec.label ?? spec.name;
  return {
    key: paramKey(spec.name),
    label: spec.select === 'body' ? `${label} (pick a face of the body)` : label,
    accepts: spec.select === 'edge' ? ['edge'] : ['face'],
    max: spec.multiple === true ? Infinity : 1,
    required: spec.optional !== true,
  };
}

/**
 * A picked face or edge added to a reference parameter's list, as the other dialogs add picks: a
 * repeat is ignored, a lost reference is replaced first (keeping its id), a field of one is
 * replaced, and a full field takes no more.
 */
export function addParamRef(refs: readonly RefItem[], field: RefField, item: RefItem): RefItem[] {
  const key = refKey(item.ref);
  if (refs.some((r) => refKey(r.ref) === key)) return [...refs];
  const lost = refs.findIndex((r) => r.lost);
  if (lost >= 0) {
    const next = refs.slice();
    next[lost] = { ...item, id: refs[lost]!.id };
    return next;
  }
  if (field.max === 1) return [item];
  if (refs.length >= field.max) return [...refs];
  return [...refs, item];
}

export type ScriptedBuild =
  | { ok: true; feature: ScriptedFeature; command: Command; label: string }
  | { ok: false; errors: Record<string, string> };

/** Error keys: a parameter's field is `param:<name>`, like its reference field. */
function bound(spec: ParamSpec, value: number, units: DisplayUnits): string | null {
  if (spec.kind !== 'number' && spec.kind !== 'length' && spec.kind !== 'angle') return null;
  const shown = (v: number) =>
    `${valueText(spec.kind, v, units)}${spec.kind === 'length' ? ` ${bareUnits(units).lengthUnit}` : spec.kind === 'angle' ? ` ${bareUnits(units).angleUnit}` : ''}`;
  if (spec.min !== undefined && value < spec.min) return `Must be at least ${shown(spec.min)}.`;
  if (spec.max !== undefined && value > spec.max) return `Must be at most ${shown(spec.max)}.`;
  if (spec.kind === 'number' && spec.integer === true && !Number.isInteger(value)) {
    return 'Must be a whole number.';
  }
  return null;
}

/**
 * Turn a filled form into the scripted feature and the command that adds it (at the rollback
 * bar) or edits `existing`. `specs`: the script's declarations; null when they could not be read
 * (the document's scripts may not run, or the script fails), in which case an existing feature
 * keeps its stored parameter values and only the script and seed change.
 */
export function buildScripted(
  form: ScriptedForm,
  specs: readonly ParamSpec[] | null,
  ctx: { doc: ManufaktureDocument; partId: string; existing?: ScriptedFeature },
): ScriptedBuild {
  const part = findPart(ctx.doc, ctx.partId);
  if (!part) return { ok: false, errors: { form: `There is no part ${ctx.partId}.` } };
  const errors: Record<string, string> = {};
  const units = ctx.doc.units;
  const variables = evaluateVariables(ctx.doc);
  if (!ctx.doc.scripts?.some((s) => s.id === form.script)) errors.script = 'Choose a script.';

  const seedText = form.seed.trim();
  const seed = seedText === '' ? 0 : Number(seedText);
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SCRIPT_SEED) {
    errors.seed = `A whole number from 0 to ${MAX_SCRIPT_SEED}.`;
  }

  const existing = ctx.existing;
  const id = existing?.id ?? previewIds(part.nextIds, 'scripted')[0]!;
  const name = existing?.name ?? defaultFeatureName('scripted', id);
  const fresh = [...previewIds(part.nextIds, 'r', 1000)];
  const taken = new Set<string>();
  const reference = (item: RefItem) => {
    const refId = item.id !== null && !taken.has(item.id) ? item.id : fresh.shift()!;
    taken.add(refId);
    return { id: refId, ref: item.ref as FaceRef | EdgeRef };
  };

  let params: Record<string, ScriptParamValue>;
  if (specs === null) {
    params = existing && existing.script === form.script ? { ...existing.params } : {};
  } else {
    params = {};
    for (const spec of specs) {
      const key = paramKey(spec.name);
      const field = ownValue(form.values, spec.name) ?? defaultField(spec, units);
      switch (spec.kind) {
        case 'number':
        case 'length':
        case 'angle': {
          const text = field.kind === 'expression' ? field.text : '';
          const r = checkExpression(text, spec.kind, units, variables);
          if (!r.ok) {
            errors[key] = r.message;
            break;
          }
          const out = bound(spec, r.value, units);
          if (out !== null) errors[key] = out;
          setOwn(params, spec.name, { kind: 'expression', expression: r.expression });
          break;
        }
        case 'boolean':
          setOwn(params, spec.name, {
            kind: 'boolean',
            value: field.kind === 'boolean' ? field.value : spec.default,
          });
          break;
        case 'choice': {
          const value = field.kind === 'choice' ? field.value : spec.default;
          if (!spec.options.includes(value)) errors[key] = 'Choose one of the options.';
          setOwn(params, spec.name, { kind: 'choice', value });
          break;
        }
        case 'reference': {
          const refs = field.kind === 'reference' ? field.refs : [];
          if (refs.length === 0 && spec.optional !== true) {
            errors[key] = 'Pick one in the viewport.';
          }
          if (refs.length > 1 && spec.multiple !== true) errors[key] = 'Pick only one.';
          if (refs.some((r) => r.lost)) errors[key] = 'Pick the lost one again, or remove it.';
          setOwn(params, spec.name, { kind: 'reference', references: refs.map(reference) });
          break;
        }
      }
    }
  }

  const feature: ScriptedFeature = {
    id,
    kind: 'scripted',
    name,
    suppressed: existing?.suppressed ?? false,
    script: form.script,
    params,
    seed: Number.isInteger(seed) ? seed : 0,
    dependsOn: existing?.dependsOn ?? [],
  };

  // Faces and edges must come from features before this one.
  const index = existing
    ? part.features.findIndex((f) => f.id === existing.id)
    : (part.rollbackIndex ?? part.features.length);
  const before = new Set(part.features.slice(0, index).map((f) => f.id));
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
