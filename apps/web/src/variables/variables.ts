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
  configurationRow,
  configuredVariables,
  findPart,
  inlineVariable,
  renameVariable,
  variableOrder,
  variableParameters,
  variableUses,
  type Command,
  type DisplayUnits,
  type ManufaktureDocument,
  type StoredExpression,
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
  type Quantity,
} from '@manufakture/units';
import { formatQuantity, kindOfQuantity } from '../components/expression';
import { isPlainNumber, type Variables } from '../sketcher/values';

export type VariableType = 'length' | 'angle' | 'number' | 'any';

export const VARIABLE_TYPES: readonly (readonly [VariableType, string])[] = [
  ['length', 'Length'],
  ['angle', 'Angle'],
  ['number', 'Number'],
  ['any', 'Any'],
];

export type Evaluated = { ok: true; value: Quantity } | { ok: false; message: string };

/**
 * Every variable evaluated in dependency order, each in the units it was stored with. A variable
 * that fails says why; one that reads a failing variable says which.
 */
export function evaluateTable(variables: readonly Variable[]): Map<string, Evaluated> {
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
    });
    if (r.ok) {
      out.set(name, r);
      continue;
    }
    const failed = r.error.code === 'unknown-variable' ? r.error : null;
    const dep = failed ? v.expression.source.slice(failed.start, failed.end).replace(/^#/, '') : '';
    out.set(name, {
      ok: false,
      message:
        failed && out.has(dep)
          ? `#${dep} does not evaluate, so neither does this.`
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
  'head.diameter': 'Head diameter',
  'head.depth': 'Head depth',
  'head.angle': 'Countersink angle',
  'layout.count': 'Instances',
  'layout.spacing': 'Spacing',
  'layout.angle': 'Total angle',
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
  const feature = findPart(doc, use.partId)?.features.find((f) => f.id === use.featureId);
  const name = feature?.name ?? use.featureId;
  if (use.constraintId) return `${name}: dimension ${use.constraintId}`;
  const field = FIELD_LABELS[use.path.join('.')] ?? use.path.join('.');
  return `${name}: ${field}`;
}

function usesOf(doc: ManufaktureDocument, name: string): UseRow[] {
  return variableUses(doc, name).map((u) => ({
    key:
      u.kind === 'variable'
        ? `v:${u.name}`
        : u.kind === 'parameter'
          ? `p:${u.parameterId}`
          : u.kind === 'row'
            ? `r:${u.rowId}:${u.parameterId}`
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
export function draftOf(doc: ManufaktureDocument, name: string | null): VariableDraft {
  const v = name === null ? undefined : doc.variables.find((x) => x.name === name);
  if (!v) return { name: '', source: '', type: 'length' };
  const e = evaluateTable(doc.variables).get(v.name);
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

  const evaluated = evaluateTable(probe(typed)).get(selfName);
  if (!evaluated) return fail('This does not evaluate.');
  if (!evaluated.ok) return fail(evaluated.message);
  let source = typed;
  let value = evaluated.value;
  const kind = kindOfQuantity(value);
  if (draft.type !== 'any' && kind !== draft.type) {
    if ((draft.type === 'length' || draft.type === 'angle') && kind === 'number') {
      source = withUnit(typed, draft.type, doc.units);
      const again = evaluateTable(probe(source)).get(selfName);
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
): { ok: true; command: Command; label: string; literal: string } | { ok: false; message: string } {
  const e = evaluateTable(doc.variables).get(name);
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
