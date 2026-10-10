// The variables table's logic, free of React: every variable with its value, type and uses; a
// draft (add or edit, rename included) checked and turned into one command; and deleting, which
// is refused while the variable is in use unless its uses take its value instead.
//
// A variable's type is not stored: it is the dimension of its value (ADR 0004 keeps variables as
// a name and an expression). Choosing "length" or "angle" for an expression without units writes
// the unit into it (`40` becomes `40 mm`), so the variable means the same in every field. Without
// that, a bare `40` stays a plain number, and each field reading it would take it in the units
// that field was typed under.

import {
  bareUnits,
  camVariableUses,
  configurationRow,
  configuredVariables,
  drawingVariableUses,
  findPart,
  inlineVariable,
  measurementLookup,
  renameVariable,
  variableOrder,
  variableParameters,
  variableUses,
  type Command,
  type DisplayUnits,
  type ManufaktureDocument,
  type Measurement,
  type StoredExpression,
  type CamVariableUse,
  type DrawingVariableUse,
  type Variable,
  type VariableUse,
} from '@manufakture/core';
import {
  describeDimension,
  evaluateQuantity,
  findReferences,
  fromMillimetres,
  fromRadians,
  isValidVariableName,
  type MeasureLookup,
  type Quantity,
} from '@manufakture/units';
import { formatQuantity, kindOfQuantity } from '../components/expression';
import { latestMeasurements } from '../model/measurements';
import { isPlainNumber, type Variables } from '../sketcher/values';

export type VariableType = 'length' | 'angle' | 'number' | 'any';

export const VARIABLE_TYPES: readonly (readonly [VariableType, string])[] = [
  ['length', 'Length'],
  ['angle', 'Angle'],
  ['number', 'Number'],
  ['any', 'Any'],
];

export type Evaluated = { ok: true; value: Quantity } | { ok: false; message: string };

/** What a variable measuring the model shows before a regen has measured it. */
export const NOT_MEASURED = 'Measured from the model at the next rebuild.';

/**
 * Every variable evaluated in dependency order, each in the units it was stored with. A variable
 * that fails says why; one that reads a failing variable says which. A variable measuring the
 * model (`distance(...)`, `angle(...)`) reads `measurements` (default: what the shown regen
 * measured, `latestMeasurements`); one not measured yet says so, or with `provisional` takes 1 mm (or 1 rad), so a draft's
 * type can still be checked before it is saved.
 */
export function evaluateTable(
  variables: readonly Variable[],
  measurements: readonly Measurement[] = latestMeasurements(),
  options: { provisional?: boolean } = {},
): Map<string, Evaluated> {
  const known = measurementLookup(measurements);
  const measure: MeasureLookup = (request) =>
    known(request) ?? (options.provisional === true ? { ok: true, value: 1 } : undefined);
  const out = new Map<string, Evaluated>();
  const order = variableOrder(variables);
  if (!order.ok) {
    for (const v of variables) out.set(v.name, { ok: false, message: order.error.message });
    return out;
  }
  const byName = new Map(variables.map((v) => [v.name, v]));
  for (const name of order.value) {
    const v = byName.get(name)!;
    const r = evaluateQuantity(v.expression.source, {
      lengthUnit: v.expression.lengthUnit,
      angleUnit: v.expression.angleUnit,
      variables: (n) => {
        const e = out.get(n);
        return e?.ok ? e.value : undefined;
      },
      measure,
    });
    if (r.ok) {
      out.set(name, r);
      continue;
    }
    const failed = r.error.code === 'unknown-variable' ? r.error : null;
    const dep = failed ? v.expression.source.slice(failed.start, failed.end).replace(/^#/, '') : '';
    const unmeasured = r.error.code === 'not-measured';
    out.set(name, {
      ok: false,
      message:
        failed && out.has(dep)
          ? `#${dep} does not evaluate, so neither does this.`
          : unmeasured
            ? NOT_MEASURED
            : r.error.message,
    });
  }
  return out;
}

/** The values of the evaluated variables, for expression fields. */
export function tableValues(table: ReadonlyMap<string, Evaluated>, except?: string): Variables {
  const out: Record<string, Quantity> = {};
  for (const [name, e] of table) if (e.ok && name !== except) out[name] = e.value;
  return out;
}

/** The type of a value: its kind, or `any` for other dimensions (an area). */
export function typeOf(q: Quantity): VariableType {
  return kindOfQuantity(q) ?? 'any';
}

/** Where a variable is used, for the table. */
export interface UseRow {
  key: string;
  /** "Extrude 1: Depth", "Sketch 1: dimension k3", "#height". */
  label: string;
  featureId: string | null;
}

export interface VariableRow {
  name: string;
  source: string;
  type: VariableType | null;
  /** The value in the display units, or null when it does not evaluate. */
  value: string | null;
  error: string | null;
  uses: UseRow[];
}

const FIELD_LABELS: Record<string, string> = {
  'extent.distance': 'Depth',
  draft: 'Draft angle',
  angle: 'Angle',
  radius: 'Radius',
  distance: 'Distance',
  secondDistance: 'Second distance',
  thickness: 'Thickness',
  diameter: 'Diameter',
  'extent.depth': 'Depth',
  'extent.tipAngle': 'Tip angle',
  'head.diameter': 'Head diameter',
  'head.depth': 'Head depth',
  'head.angle': 'Countersink angle',
  'layout.count': 'Instances',
  'layout.spacing': 'Spacing',
  'layout.angle': 'Total angle',
};

/** Mate fields by path: connector offsets (on either connector) and limits. */
const MATE_FIELD_LABELS: Record<string, string> = Object.fromEntries([
  ['limits.min', 'Minimum'],
  ['limits.max', 'Maximum'],
  ...(['a', 'b'] as const).flatMap((side) => {
    const which = side === 'a' ? 'first' : 'second';
    return ['X', 'Y', 'Z'].flatMap((axis, i) => [
      [`${side}.offset.translation.${i}`, `Offset ${axis} of the ${which} connector`],
      [`${side}.offset.rotation.${i}`, `Rotation about ${axis} of the ${which} connector`],
    ]);
  }),
]);

/** Print setup fields, by path from the setup (thresholds) or from the item (orientation). */
const PRINT_FIELD_LABELS: Record<string, string> = {
  'thresholds.overhang': 'Overhang angle',
  'thresholds.minWall': 'Minimum wall',
  'thresholds.minGap': 'Minimum gap',
  'thresholds.minHole': 'Minimum hole',
  'thresholds.teardrop': 'Teardrop above',
  'orientation.turn': 'Turn',
  'orientation.x': 'Rotation about X',
  'orientation.y': 'Rotation about Y',
  'orientation.z': 'Rotation about Z',
};

/** What a use is called in the table. */
export function labelOfUse(doc: ManufaktureDocument, use: VariableUse): string {
  if (use.kind === 'variable') return `#${use.name}`;
  if (use.kind === 'parameter') {
    const p = doc.configurations?.parameters.find((x) => x.id === use.parameterId);
    return `Configuration: ${p?.name ?? use.parameterId}`;
  }
  if (use.kind === 'row') {
    const row = doc.configurations?.rows.find((x) => x.id === use.rowId);
    return `Configuration ${row?.name ?? use.rowId}`;
  }
  if (use.kind === 'mate') {
    const assembly = doc.assemblies.find((a) => a.id === use.assemblyId);
    const mate = assembly?.mates.find((m) => m.id === use.mateId);
    const where = `${assembly?.name ?? use.assemblyId}: ${mate?.name ?? use.mateId}`;
    return `${where}: ${MATE_FIELD_LABELS[use.path.join('.')] ?? use.path.join('.')}`;
  }
  if (use.kind === 'print') {
    const setup = doc.print.setups.find((x) => x.id === use.setupId);
    const where = setup?.name ?? use.setupId;
    const field =
      PRINT_FIELD_LABELS[use.path.slice(use.itemId ? 2 : 0).join('.')] ?? use.path.join('.');
    return use.itemId ? `${where}: ${use.itemId}: ${field}` : `${where}: ${field}`;
  }
  const feature = findPart(doc, use.partId)?.features.find((f) => f.id === use.featureId);
  const name = feature?.name ?? use.featureId;
  if (use.constraintId) return `${name}: dimension ${use.constraintId}`;
  const field = FIELD_LABELS[use.path.join('.')] ?? use.path.join('.');
  return `${name}: ${field}`;
}

/** Drawing fields by path from the sheet (size) or from the view (scale, section offset). */
const DRAWING_FIELD_LABELS: Record<string, string> = {
  'size.width': 'Sheet width',
  'size.height': 'Sheet height',
  'scale.paper': 'Scale (paper side)',
  'scale.model': 'Scale (model side)',
  'options.section.offset': 'Section offset',
};

/** What a use in an exploded view or a drawing is called in the table. */
export function labelOfDrawingUse(doc: ManufaktureDocument, use: DrawingVariableUse): string {
  if (use.kind === 'explodedView') {
    const assembly = doc.assemblies.find((a) => a.id === use.assemblyId);
    const view = assembly?.explodedViews?.find((v) => v.id === use.explodedViewId);
    const step = view ? view.steps.findIndex((s) => s.id === use.stepId) + 1 : 0;
    const where = `${assembly?.name ?? use.assemblyId}: ${view?.name ?? use.explodedViewId}`;
    return `${where}: step ${step > 0 ? step : use.stepId} distance`;
  }
  const drawing = doc.drawings?.find((d) => d.id === use.drawingId);
  const sheet = drawing?.sheets.find((s) => s.id === use.sheetId);
  const where = `${drawing?.name ?? use.drawingId}: ${sheet?.name ?? use.sheetId}`;
  // The path is from the drawing: `sheets, i, ...` for the size, `sheets, i, views, j, ...`.
  const rest = use.viewId === undefined ? use.path.slice(2) : use.path.slice(4);
  const field = DRAWING_FIELD_LABELS[rest.join('.')] ?? rest.join('.');
  return use.viewId === undefined ? `${where}: ${field}` : `${where}: ${use.viewId}: ${field}`;
}

function usesOf(doc: ManufaktureDocument, name: string): UseRow[] {
  return [...modelUsesOf(doc, name), ...drawingUsesOf(doc, name), ...camUsesOf(doc, name)];
}

/** CAM fields by path from the tool, the setup or the operation. */
const CAM_FIELD_LABELS: Record<string, string> = {
  diameter: 'Diameter',
  fluteLength: 'Flute length',
  cornerRadius: 'Corner radius',
  angle: 'Angle',
  tipDiameter: 'Tip diameter',
  'stock.margins.xMin': 'Stock margin left',
  'stock.margins.xMax': 'Stock margin right',
  'stock.margins.yMin': 'Stock margin front',
  'stock.margins.yMax': 'Stock margin back',
  'stock.margins.top': 'Stock margin above',
  'stock.margins.bottom': 'Stock margin below',
  'stock.size.x': 'Stock X',
  'stock.size.y': 'Stock Y',
  'stock.size.z': 'Stock thickness',
  'stock.offset.x': 'Stock offset X',
  'stock.offset.y': 'Stock offset Y',
  'stock.offset.z': 'Stock offset Z',
  'heights.clearance': 'Clearance height',
  'heights.retract': 'Retract height',
  depth: 'Depth',
  'depth.depth': 'Depth',
  'depth.extra': 'Below the stock bottom',
  stepdown: 'Stepdown',
  stepover: 'Stepover',
  finishAllowance: 'Finish allowance',
  'tabs.count': 'Tabs per loop',
  'tabs.width': 'Tab width',
  'tabs.height': 'Tab height',
  'entry.angle': 'Entry angle',
  'entry.radius': 'Helix radius',
  'leadIn.length': 'Lead-in length',
  'leadIn.radius': 'Lead-in radius',
  'leadOut.length': 'Lead-out length',
  'leadOut.radius': 'Lead-out radius',
  peck: 'Peck depth',
  dwell: 'Dwell',
  maxDepth: 'Maximum depth',
  allowance: 'Allowance',
  'feeds.spindle': 'Spindle speed',
  'feeds.cut': 'Cutting feed',
  'feeds.plunge': 'Plunge feed',
  'feeds.ramp': 'Ramp feed',
  'feeds.lead': 'Lead feed',
};

/** A CAM field path's label, by an own-property lookup (paths come from document data). */
function camFieldLabel(path: string): string {
  return Object.hasOwn(CAM_FIELD_LABELS, path) ? CAM_FIELD_LABELS[path]! : path;
}

/** What a use in the CAM section is called in the table (ADR 0014: always says it is CAM). */
export function labelOfCamUse(doc: ManufaktureDocument, use: CamVariableUse): string {
  if (use.kind === 'camTool') {
    const tool = doc.cam.tools.find((t) => t.id === use.toolId);
    const where = `CAM tool ${tool?.name ?? use.toolId}`;
    if (use.path[0] === 'presets') {
      const preset = tool?.presets[use.path[1] as number];
      const field = String(use.path[2]);
      return `${where}: ${preset?.material ?? use.path[1]} ${field}`;
    }
    return `${where}: ${camFieldLabel(use.path.join('.'))}`;
  }
  const setup = doc.cam.setups.find((s) => s.id === use.setupId);
  const where = `CAM ${setup?.name ?? use.setupId}`;
  if (use.operationId === undefined) {
    return `${where}: ${camFieldLabel(use.path.join('.'))}`;
  }
  const op = setup?.operations.find((o) => o.id === use.operationId);
  // The path is from the setup: `operations, i, ...` for an operation's field.
  const rest = use.path.slice(2).join('.');
  return `${where} / ${op?.name ?? use.operationId}: ${camFieldLabel(rest)}`;
}

/** Uses in CAM tools, setups and operations (`camVariableUses`), which also block a delete. */
function camUsesOf(doc: ManufaktureDocument, name: string): UseRow[] {
  return camVariableUses(doc, name).map((u) => ({
    key:
      u.kind === 'camTool'
        ? `c:${u.toolId}:${u.path.join('.')}`
        : `c:${u.setupId}:${u.path.join('.')}`,
    label: labelOfCamUse(doc, u),
    featureId: null,
  }));
}

/** Uses in exploded views and drawings (`drawingVariableUses`), which also block a delete. */
function drawingUsesOf(doc: ManufaktureDocument, name: string): UseRow[] {
  return drawingVariableUses(doc, name).map((u) => ({
    key:
      u.kind === 'explodedView'
        ? `e:${u.assemblyId}/${u.explodedViewId}:${u.path.join('.')}`
        : `d:${u.drawingId}:${u.path.join('.')}`,
    label: labelOfDrawingUse(doc, u),
    featureId: null,
  }));
}

function modelUsesOf(doc: ManufaktureDocument, name: string): UseRow[] {
  return variableUses(doc, name).map((u) => ({
    key:
      u.kind === 'variable'
        ? `v:${u.name}`
        : u.kind === 'parameter'
          ? `p:${u.parameterId}`
          : u.kind === 'row'
            ? `r:${u.rowId}:${u.parameterId}`
            : u.kind === 'mate'
              ? `m:${u.assemblyId}/${u.mateId}:${u.path.join('.')}`
              : u.kind === 'print'
                ? `s:${u.setupId}:${u.path.join('.')}`
                : `f:${u.featureId}:${u.path.join('.')}`,
    label: labelOfUse(doc, u),
    featureId: u.kind === 'feature' ? u.featureId : null,
  }));
}

/** The table's rows, in table order. */
export function variableRows(
  doc: ManufaktureDocument,
  table: ReadonlyMap<string, Evaluated> = evaluateTable(doc.variables),
): VariableRow[] {
  return doc.variables.map((v) => {
    const e = table.get(v.name);
    return {
      name: v.name,
      source: v.expression.source,
      type: e?.ok ? typeOf(e.value) : null,
      value: e?.ok ? formatQuantity(e.value, doc.units) : null,
      error: e && !e.ok ? e.message : null,
      uses: usesOf(doc, v.name),
    };
  });
}

// Drafts ---------------------------------------------------------------------------------------

export interface VariableDraft {
  name: string;
  source: string;
  type: VariableType;
}

export type DraftCheck =
  | { ok: true; command: Command | null; label: string; value: Quantity }
  | {
      ok: false;
      errors: { name?: string; expression?: string };
      /** The expression would make variables read each other. */
      cycle: boolean;
    };

/** The unit a bare value of `type` is written with under `units`. */
export function unitFor(type: 'length' | 'angle', units: DisplayUnits): string {
  const bare = bareUnits(units);
  return type === 'length' ? bare.lengthUnit : bare.angleUnit;
}

/** `source` with its unit written in: `40` as `40 mm`, `2*#n` as `(2*#n) mm`. */
export function withUnit(source: string, type: 'length' | 'angle', units: DisplayUnits): string {
  const s = source.trim();
  const unit = unitFor(type, units);
  return isPlainNumber(s) ? `${s} ${unit}` : `(${s}) ${unit}`;
}

/** The draft for a new variable, or for editing `name`. */
export function draftOf(
  doc: ManufaktureDocument,
  name: string | null,
  measurements?: readonly Measurement[],
): VariableDraft {
  const v = name === null ? undefined : doc.variables.find((x) => x.name === name);
  if (!v) return { name: '', source: '', type: 'length' };
  const e = evaluateTable(doc.variables, measurements, { provisional: true }).get(v.name);
  return { name: v.name, source: v.expression.source, type: e?.ok ? typeOf(e.value) : 'any' };
}

/**
 * Check a draft that adds a variable (`original` null) or edits `original`, which may rename
 * it, and give the one command that applies it (null when nothing changes).
 */
export function checkDraft(
  doc: ManufaktureDocument,
  draft: VariableDraft,
  original: string | null,
  measurements?: readonly Measurement[],
): DraftCheck {
  const errors: { name?: string; expression?: string } = {};
  const name = draft.name.trim().replace(/^#/, '');
  const old = original === null ? undefined : doc.variables.find((v) => v.name === original);
  if (name === '') errors.name = 'Enter a name.';
  else if (!isValidVariableName(name)) {
    errors.name =
      'Use letters, digits and _, starting with a letter or _, and not a function or constant name (sin, pi).';
  } else if (name !== original && doc.variables.some((v) => v.name === name)) {
    errors.name = `There is already a variable #${name}.`;
  }
  const typed = draft.source.trim();
  const fail = (expression: string, cycle = false): DraftCheck => ({
    ok: false,
    errors: { ...errors, expression },
    cycle,
  });
  if (typed === '') return fail('Enter a value.');
  const refs = findReferences(typed);
  if (!refs.ok) return fail(refs.error.message);
  const known = new Set(doc.variables.map((v) => v.name));
  // Reading itself (under the new name too) is a cycle, found below, not an unknown name.
  const unknown = refs.value.find((r) => !known.has(r.name) && r.name !== name);
  if (unknown) return fail(`Unknown variable "${unknown.name}"`);

  // The table as it would be, with the old name's readers following a rename.
  const selfName = errors.name ? (original ?? name) : name;
  const probe = (source: string): Variable[] => {
    const renamed = original !== null && selfName !== original;
    const own = renamed ? rename(source, original, selfName) : source;
    const expression: StoredExpression = { source: own, ...bareUnits(doc.units) };
    const others = doc.variables.map((v) => {
      if (v.name === original) return { name: selfName, expression };
      if (!renamed) return v;
      const s = rename(v.expression.source, original, selfName);
      return { ...v, expression: { ...v.expression, source: s } };
    });
    return original === null ? [...others, { name: selfName, expression }] : others;
  };
  const order = variableOrder(probe(typed));
  if (!order.ok) {
    const loop = order.error.blockers ?? [];
    return fail(
      `Variables cannot read each other in a loop: ${[...loop, loop[0]].map((n) => `#${n}`).join(' -> ')}.`,
      true,
    );
  }

  // A measurement not made yet counts as 1 mm (or 1 rad) here: saved, it is measured at regen.
  const evaluate = (source: string) =>
    evaluateTable(probe(source), measurements, { provisional: true }).get(selfName);
  const evaluated = evaluate(typed);
  if (!evaluated) return fail('This does not evaluate.');
  if (!evaluated.ok) return fail(evaluated.message);
  let source = typed;
  let value = evaluated.value;
  const kind = kindOfQuantity(value);
  if (draft.type !== 'any' && kind !== draft.type) {
    if ((draft.type === 'length' || draft.type === 'angle') && kind === 'number') {
      source = withUnit(typed, draft.type, doc.units);
      const again = evaluate(source);
      if (!again?.ok) return fail(again?.message ?? 'This does not evaluate.');
      value = again.value;
    } else {
      return fail(
        `This is ${describeDimension(value.dimension)}, not ${article(draft.type)}: change the type or the value.`,
      );
    }
  }
  if (errors.name) return { ok: false, errors, cycle: false };

  // Unchanged text keeps the units it was entered under.
  const expression: StoredExpression =
    old && old.expression.source === source ? old.expression : { source, ...bareUnits(doc.units) };
  if (old === undefined) {
    return {
      ok: true,
      command: { type: 'setVariable', name, expression },
      label: `Add variable #${name}`,
      value,
    };
  }
  if (name === old.name && expression === old.expression) {
    return { ok: true, command: null, label: '', value };
  }
  const command = renameVariable(doc, old.name, name, expression);
  if (!command.ok) return { ok: false, errors: { name: command.error.message }, cycle: false };
  return {
    ok: true,
    command: command.value,
    label:
      name === old.name ? `Edit variable #${name}` : `Rename variable #${old.name} to #${name}`,
    value,
  };
}

function article(type: 'length' | 'angle' | 'number'): string {
  return type === 'angle' ? 'an angle' : `a ${type}`;
}

function rename(source: string, from: string, to: string): string {
  const r = findReferences(source);
  if (!r.ok) return source;
  let out = source;
  for (const ref of [...r.value].reverse()) {
    if (ref.name === from) out = `${out.slice(0, ref.start)}#${to}${out.slice(ref.end)}`;
  }
  return out;
}

// Deleting ---------------------------------------------------------------------------------------

/**
 * A value as an expression with explicit units, in the document's bare-number units where it is
 * a length or an angle: `40mm`, `1.5in`, `30deg`, `3`. Rounded to 12 significant digits.
 */
export function quantityLiteral(q: Quantity, units: DisplayUnits): string {
  const n = (x: number) => String(Number(x.toPrecision(12)));
  const bare = bareUnits(units);
  const kind = kindOfQuantity(q);
  if (kind === 'number') return n(q.value);
  if (kind === 'length') return `${n(fromMillimetres(q.value, bare.lengthUnit))}${bare.lengthUnit}`;
  if (kind === 'angle') return `${n(fromRadians(q.value, bare.angleUnit))}${bare.angleUnit}`;
  const { length, angle } = q.dimension;
  const parts = [n(q.value)];
  if (length !== 0) parts.push(`(1mm)^${length}`);
  if (angle !== 0) parts.push(`(1rad)^${angle}`);
  return parts.join('*');
}

export type DeleteCheck =
  { ok: true; command: Command; label: string } | { ok: false; message: string; uses: UseRow[] };

/** Delete `name`: refused, with its uses, while anything reads it. */
export function deleteCommand(doc: ManufaktureDocument, name: string): DeleteCheck {
  const uses = usesOf(doc, name);
  if (uses.length > 0) {
    const n = uses.length;
    return {
      ok: false,
      message: `#${name} is used in ${n} ${n === 1 ? 'place' : 'places'}, so it cannot be deleted as it is.`,
      uses,
    };
  }
  return { ok: true, command: { type: 'deleteVariable', name }, label: `Delete variable #${name}` };
}

/** Write the current value of `name` into each of its uses, then delete it: one undo step. */
export function replaceWithValueCommand(
  doc: ManufaktureDocument,
  name: string,
  measurements?: readonly Measurement[],
): { ok: true; command: Command; label: string; literal: string } | { ok: false; message: string } {
  const e = evaluateTable(doc.variables, measurements).get(name);
  if (!e) return { ok: false, message: `There is no variable #${name}.` };
  if (!e.ok) return { ok: false, message: `#${name} has no value to use: ${e.message}` };
  const literal = quantityLiteral(e.value, doc.units);
  const r = inlineVariable(doc, name, literal);
  if (!r.ok) return { ok: false, message: r.error.message };
  return { ok: true, command: r.value, label: `Replace #${name} with ${literal}`, literal };
}

/**
 * The warning to give before `name` is replaced with its value, when the configuration table
 * configures it: inlining deletes the parameter and every row's value for it, so all
 * configurations get the document's own value. Null when no parameter configures it.
 */
export function inlineWarning(doc: ManufaktureDocument, name: string): string | null {
  const params = variableParameters(doc, name);
  if (params.length === 0) return null;
  const ids = new Set(params.map((p) => p.id));
  const rows = (doc.configurations?.rows ?? []).filter((r) =>
    Object.keys(r.values).some((id) => ids.has(id)),
  );
  const names = params.map((p) => p.name).join(', ');
  const values =
    rows.length === 0
      ? ''
      : `, and its value in ${rows.length === 1 ? 'configuration' : 'configurations'} ${rows.map((r) => r.name).join(', ')}`;
  return (
    `#${name} is set by the configuration table (parameter ${names}). Replacing it with its ` +
    `value deletes that parameter${values}: every configuration then gets the document's own ` +
    `value.`
  );
}

/** How the configuration table sets a variable, for the Variables panel. */
export interface ConfiguredVariable {
  /** The parameter that configures it. */
  parameter: string;
  /** The active row, when it has a value of its own for the variable. */
  row: string | null;
  /** The variable's value in the active row, when that row sets it (or reads one it sets). */
  value: string | null;
}

/**
 * The variables the configuration table configures, or whose value the active row changes
 * (it reads a configured one), by name.
 */
export function configuredVariablesInfo(doc: ManufaktureDocument): Map<string, ConfiguredVariable> {
  const out = new Map<string, ConfiguredVariable>();
  const table = doc.configurations;
  if (!table) return out;
  const row = configurationRow(doc) ?? null;
  const shown = row ? evaluateTable(configuredVariables(doc.variables, table, row)) : null;
  const base = shown ? evaluateTable(doc.variables) : null;
  for (const v of doc.variables) {
    const p = table.parameters.find((x) => x.kind === 'variable' && x.variable === v.name);
    const e = shown?.get(v.name);
    const b = base?.get(v.name);
    const changed =
      e !== undefined && (e.ok !== b?.ok || (e.ok && b?.ok && e.value.value !== b.value.value));
    if (!p && !changed) continue;
    out.set(v.name, {
      parameter: p?.name ?? '',
      row: row && changed ? row.name : null,
      value: changed ? (e.ok ? formatQuantity(e.value, doc.units) : 'no value') : null,
    });
  }
  return out;
}
