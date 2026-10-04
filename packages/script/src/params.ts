// Parameter declarations (ADR 0010 decision 6). A script declares its parameters as data:
//
//   export const params = {
//     width: { kind: 'length', default: 40, min: 1, label: 'Width' },
//     count: { kind: 'number', default: 6, min: 1, max: 64, integer: true },
//     tilt: { kind: 'angle', default: 0 },
//     rounded: { kind: 'boolean', default: true },
//     style: { kind: 'choice', options: ['round', 'square'], default: 'round' },
//     face: { kind: 'reference', select: 'face' },
//   };
//
// The host reads them with a cheap first run (`ScriptInstance.readDeclarations`), which evaluates
// the module without calling `run`. The scripted feature stores one value per name (T7.2a: a
// StoredExpression for the numeric kinds, so variables and units work; a reference for
// `reference`); regen evaluates them and calls `resolveParams` before `run`. Lengths are in
// millimetres and angles in radians, the internal units of ADR 0005; the dialog formats them.

import { scriptError, type ScriptError } from './errors';
import { ScriptHandle, type ScriptValue } from './host';

export type ParamKind = 'number' | 'length' | 'angle' | 'boolean' | 'choice' | 'reference';

interface ParamCommon {
  /** Shown in the feature dialog instead of the name. */
  label?: string;
  /** A sentence of help. */
  description?: string;
}

export interface NumericParam extends ParamCommon {
  kind: 'number' | 'length' | 'angle';
  /** In internal units: millimetres for `length`, radians for `angle`. */
  default: number;
  min?: number;
  max?: number;
  /** Only whole numbers (kind `number` only). */
  integer?: boolean;
}

export interface BooleanParam extends ParamCommon {
  kind: 'boolean';
  default: boolean;
}

export interface ChoiceParam extends ParamCommon {
  kind: 'choice';
  options: string[];
  default: string;
}

export type ReferenceSelect = 'face' | 'edge' | 'vertex' | 'body';

export interface ReferenceParam extends ParamCommon {
  kind: 'reference';
  select: ReferenceSelect;
  /** Several entities (the value is an array of handles). */
  multiple?: boolean;
  /** May be left empty (the value is null, or an empty array when `multiple`). */
  optional?: boolean;
}

export type ParamDeclaration = NumericParam | BooleanParam | ChoiceParam | ReferenceParam;

/** A declaration with its name, in the order the script declares them. */
export type ParamSpec = ParamDeclaration & { name: string };

/** What the declaration run reads. */
export interface ScriptDeclarations {
  /** The version the script declares with `export const apiVersion`, or null when it does not. */
  declaredApiVersion: number | null;
  params: ParamSpec[];
}

export const MAX_PARAMS = 64;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const KINDS: readonly ParamKind[] = ['number', 'length', 'angle', 'boolean', 'choice', 'reference'];
const SELECTS: readonly ReferenceSelect[] = ['face', 'edge', 'vertex', 'body'];
const ALLOWED_KEYS: Record<ParamKind, readonly string[]> = {
  number: ['kind', 'label', 'description', 'default', 'min', 'max', 'integer'],
  length: ['kind', 'label', 'description', 'default', 'min', 'max'],
  angle: ['kind', 'label', 'description', 'default', 'min', 'max'],
  boolean: ['kind', 'label', 'description', 'default'],
  choice: ['kind', 'label', 'description', 'options', 'default'],
  reference: ['kind', 'label', 'description', 'select', 'multiple', 'optional'],
};

type Result<T> = { ok: true; value: T } | { ok: false; error: ScriptError };

const bad = (message: string): { ok: false; error: ScriptError } => ({
  ok: false,
  error: scriptError('bad-declaration', message),
});

const isRecord = (v: unknown): v is Record<string, ScriptValue> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof ScriptHandle);

const optionalText = (v: unknown): boolean =>
  v === undefined || (typeof v === 'string' && v.length <= 500);

/** Validates the `params` export. Unknown keys are refused, so a script cannot rely on a field
 * a later API version adds without declaring that version. */
export function parseParamDeclarations(value: ScriptValue): Result<ParamSpec[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!isRecord(value)) return bad('`params` must be an object of parameter declarations.');
  const names = Object.keys(value);
  if (names.length > MAX_PARAMS)
    return bad(`A script can declare at most ${MAX_PARAMS} parameters.`);
  const specs: ParamSpec[] = [];
  for (const name of names) {
    const d = value[name];
    const where = `Parameter "${name}"`;
    if (!NAME.test(name)) return bad(`${where}: a parameter name must be an identifier.`);
    if (!isRecord(d)) return bad(`${where} must be an object with a kind.`);
    const kind = d.kind;
    if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) {
      return bad(`${where}: kind must be one of ${KINDS.join(', ')}.`);
    }
    const k = kind as ParamKind;
    const unknown = Object.keys(d).filter((key) => !ALLOWED_KEYS[k].includes(key));
    if (unknown.length > 0) return bad(`${where}: unknown field ${unknown[0]}.`);
    if (!optionalText(d.label) || !optionalText(d.description)) {
      return bad(`${where}: label and description must be short strings.`);
    }
    const common: ParamCommon = {};
    if (typeof d.label === 'string') common.label = d.label;
    if (typeof d.description === 'string') common.description = d.description;
    switch (k) {
      case 'number':
      case 'length':
      case 'angle': {
        const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
        if (!finite(d.default)) return bad(`${where}: default must be a finite number.`);
        if (d.min !== undefined && !finite(d.min))
          return bad(`${where}: min must be a finite number.`);
        if (d.max !== undefined && !finite(d.max))
          return bad(`${where}: max must be a finite number.`);
        if (d.integer !== undefined && typeof d.integer !== 'boolean') {
          return bad(`${where}: integer must be true or false.`);
        }
        const spec: ParamSpec = { name, kind: k, default: d.default as number, ...common };
        if (d.min !== undefined) spec.min = d.min as number;
        if (d.max !== undefined) spec.max = d.max as number;
        if (d.integer === true) spec.integer = true;
        if (spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) {
          return bad(`${where}: min is greater than max.`);
        }
        const fits = checkValue(spec, spec.default);
        if (fits !== null) return bad(`${where}: the default does not fit (${fits}).`);
        specs.push(spec);
        break;
      }
      case 'boolean':
        if (typeof d.default !== 'boolean') return bad(`${where}: default must be true or false.`);
        specs.push({ name, kind: k, default: d.default, ...common });
        break;
      case 'choice': {
        const options = d.options;
        if (
          !Array.isArray(options) ||
          options.length === 0 ||
          options.length > 100 ||
          !options.every((o) => typeof o === 'string' && o.length > 0 && o.length <= 100)
        ) {
          return bad(`${where}: options must be a list of 1 to 100 non-empty strings.`);
        }
        const list = options as string[];
        if (new Set(list).size !== list.length) return bad(`${where}: options must be distinct.`);
        if (typeof d.default !== 'string' || !list.includes(d.default)) {
          return bad(`${where}: default must be one of the options.`);
        }
        specs.push({ name, kind: k, options: [...list], default: d.default, ...common });
        break;
      }
      case 'reference': {
        if (typeof d.select !== 'string' || !(SELECTS as readonly string[]).includes(d.select)) {
          return bad(`${where}: select must be one of ${SELECTS.join(', ')}.`);
        }
        if (d.multiple !== undefined && typeof d.multiple !== 'boolean') {
          return bad(`${where}: multiple must be true or false.`);
        }
        if (d.optional !== undefined && typeof d.optional !== 'boolean') {
          return bad(`${where}: optional must be true or false.`);
        }
        const spec: ParamSpec = { name, kind: k, select: d.select as ReferenceSelect, ...common };
        if (d.multiple === true) spec.multiple = true;
        if (d.optional === true) spec.optional = true;
        specs.push(spec);
        break;
      }
    }
  }
  return { ok: true, value: specs };
}

/** Null when `value` fits `spec`, else why not. */
function checkValue(spec: ParamSpec, value: ScriptValue): string | null {
  switch (spec.kind) {
    case 'number':
    case 'length':
    case 'angle':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'not a finite number';
      if (spec.integer === true && !Number.isInteger(value)) return 'not a whole number';
      if (spec.min !== undefined && value < spec.min) return `less than ${spec.min}`;
      if (spec.max !== undefined && value > spec.max) return `greater than ${spec.max}`;
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : 'not true or false';
    case 'choice':
      return typeof value === 'string' && spec.options.includes(value)
        ? null
        : 'not one of the options';
    case 'reference':
      if (spec.multiple === true) {
        if (!Array.isArray(value) || !value.every((v) => v instanceof ScriptHandle)) {
          return 'not a list of references';
        }
        return value.length === 0 && spec.optional !== true ? 'empty' : null;
      }
      if (value === null) return spec.optional === true ? null : 'empty';
      return value instanceof ScriptHandle ? null : 'not a reference';
  }
}

/**
 * The `params` object `run` receives: every declared name, with the stored value or the default
 * (references have no default: a missing one is null, or an empty list). Values for names the
 * script no longer declares are dropped, so removing a parameter does not break old features.
 */
export function resolveParams(
  specs: readonly ParamSpec[],
  values: Readonly<Record<string, ScriptValue>>,
): Result<Record<string, ScriptValue>> {
  const out: Record<string, ScriptValue> = {};
  for (const spec of specs) {
    const given = Object.prototype.hasOwnProperty.call(values, spec.name)
      ? values[spec.name]
      : undefined;
    const value =
      given !== undefined
        ? given
        : spec.kind === 'reference'
          ? spec.multiple === true
            ? []
            : null
          : spec.default;
    const why = checkValue(spec, value);
    if (why !== null) {
      return {
        ok: false,
        error: scriptError('bad-param', `Parameter "${spec.label ?? spec.name}" is ${why}.`),
      };
    }
    out[spec.name] = value;
  }
  return { ok: true, value: out };
}
