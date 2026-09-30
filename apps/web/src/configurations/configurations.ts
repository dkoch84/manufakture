// The configuration table's logic, free of React: the table as the panel shows it, what can
// become a parameter, and the commands that edit it (one undo step each). Core keeps the table
// (`Configurations`, T2.4a); a row gives the document with its variable expressions and feature
// suppressions overridden, and the active row is the one the app builds and shows.

import {
  bareUnits,
  CONFIG_PARAMETER_COUNTER,
  CONFIG_ROW_COUNTER,
  configuredVariables,
  findPart,
  previewIds,
  type Command,
  type ConfigParameter,
  type ConfigRow,
  type ConfigValue,
  type DisplayUnits,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';
import { evaluateQuantity } from '@manufakture/units';
import { kindOfQuantity, type FieldKind } from '../components/expression';
import type { Variables } from '../sketcher/values';
import { evaluateTable, tableValues, typeOf, withUnit } from '../variables/variables';

/** The longest name core takes for a parameter or a row. */
export const MAX_CONFIG_NAME = 200;

/** A command and the label of its undo step. */
export interface Edit {
  command: Command;
  label: string;
}

/** One column of the table, as the panel shows it. */
export interface ParameterColumn {
  parameter: ConfigParameter;
  /** What it configures: `#width`, or `Fillet 1 (Part 1)`. */
  target: string;
  /** The value a row without its own takes: the variable's expression, or the feature's flag. */
  base: string | boolean;
  /** For a variable: the kind of value it holds, which its cells must match. */
  kind: FieldKind;
  /** What it names is gone (never after validation; kept for safety). */
  missing: boolean;
}

/** The table's columns, in table order. */
export function parameterColumns(doc: ManufaktureDocument): ParameterColumn[] {
  const table = evaluateTable(doc.variables);
  return (doc.configurations?.parameters ?? []).map((p): ParameterColumn => {
    if (p.kind === 'variable') {
      const v = doc.variables.find((x) => x.name === p.variable);
      const e = table.get(p.variable);
      const type = e?.ok ? typeOf(e.value) : 'any';
      return {
        parameter: p,
        target: `#${p.variable}`,
        base: v?.expression.source ?? '',
        kind: type,
        missing: v === undefined,
      };
    }
    const part = findPart(doc, p.partId);
    const feature = part?.features.find((f) => f.id === p.featureId);
    const several = doc.parts.length > 1;
    return {
      parameter: p,
      target: `${feature?.name ?? p.featureId}${several && part ? ` (${part.name})` : ''}`,
      base: feature?.suppressed ?? false,
      kind: 'any',
      missing: feature === undefined,
    };
  });
}

/** Something that can become a parameter: a variable, or a feature to suppress. */
export type Candidate =
  | { kind: 'variable'; key: string; label: string; variable: string }
  | { kind: 'suppression'; key: string; label: string; partId: string; featureId: string };

/**
 * What can still become a parameter: every variable no parameter configures, then every
 * feature of part `partId` no parameter suppresses.
 */
export function parameterCandidates(doc: ManufaktureDocument, partId: string): Candidate[] {
  const params = doc.configurations?.parameters ?? [];
  const out: Candidate[] = [];
  for (const v of doc.variables) {
    if (params.some((p) => p.kind === 'variable' && p.variable === v.name)) continue;
    out.push({ kind: 'variable', key: `v:${v.name}`, label: `#${v.name}`, variable: v.name });
  }
  for (const f of findPart(doc, partId)?.features ?? []) {
    if (
      params.some((p) => p.kind === 'suppression' && p.partId === partId && p.featureId === f.id)
    ) {
      continue;
    }
    out.push({
      kind: 'suppression',
      key: `f:${partId}:${f.id}`,
      label: `Suppress ${f.name}`,
      partId,
      featureId: f.id,
    });
  }
  return out;
}

/** `wanted`, or `wanted 2`, `wanted 3`... : the first that is not in `taken`. */
function unique(wanted: string, taken: ReadonlySet<string>): string {
  const base = wanted.trim().slice(0, MAX_CONFIG_NAME - 4) || 'Parameter';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** Add a parameter for `candidate`, named after what it configures. */
export function addParameter(doc: ManufaktureDocument, candidate: Candidate): Edit {
  const [id] = previewIds(doc.nextIds, CONFIG_PARAMETER_COUNTER);
  const taken = new Set((doc.configurations?.parameters ?? []).map((p) => p.name));
  let parameter: ConfigParameter;
  if (candidate.kind === 'variable') {
    parameter = {
      id: id!,
      name: unique(candidate.variable, taken),
      kind: 'variable',
      variable: candidate.variable,
    };
  } else {
    const feature = findPart(doc, candidate.partId)?.features.find(
      (f) => f.id === candidate.featureId,
    );
    parameter = {
      id: id!,
      name: unique(`${feature?.name ?? candidate.featureId} suppressed`, taken),
      kind: 'suppression',
      partId: candidate.partId,
      featureId: candidate.featureId,
    };
  }
  return {
    command: { type: 'setConfigParameter', parameter },
    label: `Add configuration parameter ${parameter.name}`,
  };
}

/** Add a row with no values of its own (every parameter keeps the document's value). */
export function addRow(doc: ManufaktureDocument, name?: string): Edit {
  const [id] = previewIds(doc.nextIds, CONFIG_ROW_COUNTER);
  const rows = doc.configurations?.rows ?? [];
  const taken = new Set(rows.map((r) => r.name));
  const row: ConfigRow = {
    id: id!,
    name: unique(name ?? `Configuration ${rows.length + 1}`, taken),
    values: {},
  };
  return { command: { type: 'setConfigRow', row }, label: `Add configuration ${row.name}` };
}

/** Why `name` cannot name a row (or a parameter, with `what`), or null when it can. */
export function nameProblem(
  doc: ManufaktureDocument,
  name: string,
  what: 'row' | 'parameter',
  except: string,
): string | null {
  const n = name.trim();
  if (n === '') return 'Enter a name.';
  if (n.length > MAX_CONFIG_NAME) return `Use at most ${MAX_CONFIG_NAME} characters.`;
  const table = doc.configurations;
  const others =
    what === 'row'
      ? (table?.rows ?? []).filter((r) => r.id !== except)
      : (table?.parameters ?? []).filter((p) => p.id !== except);
  if (others.some((x) => x.name === n)) {
    return `There is already a ${what === 'row' ? 'configuration' : 'parameter'} named "${n}".`;
  }
  return null;
}

/** Rename row `rowId`; null when the name is unchanged. */
export function renameRow(doc: ManufaktureDocument, rowId: string, name: string): Edit | null {
  const row = doc.configurations?.rows.find((r) => r.id === rowId);
  const n = name.trim();
  if (!row || row.name === n) return null;
  return {
    command: { type: 'setConfigRow', row: { ...row, name: n } },
    label: `Rename configuration ${row.name} to ${n}`,
  };
}

/** Rename parameter `parameterId`; null when the name is unchanged. */
export function renameParameter(
  doc: ManufaktureDocument,
  parameterId: string,
  name: string,
): Edit | null {
  const p = doc.configurations?.parameters.find((x) => x.id === parameterId);
  const n = name.trim();
  if (!p || p.name === n) return null;
  return {
    command: { type: 'setConfigParameter', parameter: { ...p, name: n } },
    label: `Rename configuration parameter ${p.name} to ${n}`,
  };
}

/**
 * Set row `rowId`'s value for `parameterId` (null: none, so the row takes the document's own
 * value); null when nothing changes.
 */
export function setCell(
  doc: ManufaktureDocument,
  rowId: string,
  parameterId: string,
  value: ConfigValue | null,
): Edit | null {
  const table = doc.configurations;
  const row = table?.rows.find((r) => r.id === rowId);
  const p = table?.parameters.find((x) => x.id === parameterId);
  if (!row || !p) return null;
  const old = row.values[parameterId];
  if (value === null ? old === undefined : sameValue(old, value)) return null;
  const values = { ...row.values };
  if (value === null) delete values[parameterId];
  else values[parameterId] = value;
  return {
    command: { type: 'setConfigRow', row: { ...row, values } },
    label: `Set ${p.name} in configuration ${row.name}`,
  };
}

function sameValue(a: ConfigValue | undefined, b: ConfigValue): boolean {
  if (a === undefined) return false;
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  return a.source === b.source && a.lengthUnit === b.lengthUnit && a.angleUnit === b.angleUnit;
}

export function deleteRow(doc: ManufaktureDocument, rowId: string): Edit | null {
  const row = doc.configurations?.rows.find((r) => r.id === rowId);
  if (!row) return null;
  return {
    command: { type: 'deleteConfigRow', rowId },
    label: `Delete configuration ${row.name}`,
  };
}

export function deleteParameter(doc: ManufaktureDocument, parameterId: string): Edit | null {
  const p = doc.configurations?.parameters.find((x) => x.id === parameterId);
  if (!p) return null;
  return {
    command: { type: 'deleteConfigParameter', parameterId },
    label: `Delete configuration parameter ${p.name}`,
  };
}

/** Make `rowId` the active row (null: none, the document as it is); null when it already is. */
export function setActive(doc: ManufaktureDocument, rowId: string | null): Edit | null {
  const table = doc.configurations;
  if ((table?.active ?? null) === rowId) return null;
  if (rowId === null)
    return { command: { type: 'setActiveConfiguration', rowId }, label: 'Show no configuration' };
  const row = table?.rows.find((r) => r.id === rowId);
  if (!row) return null;
  return {
    command: { type: 'setActiveConfiguration', rowId },
    label: `Show configuration ${row.name}`,
  };
}

/**
 * The variables a cell of row `rowId` can read, evaluated as that row gives them, without the
 * variable `except` (the one the cell configures: it cannot read itself).
 */
export function rowVariables(doc: ManufaktureDocument, rowId: string, except?: string): Variables {
  const table = doc.configurations;
  const row = table?.rows.find((r) => r.id === rowId);
  const variables = table && row ? configuredVariables(doc.variables, table, row) : doc.variables;
  return tableValues(evaluateTable(variables), except);
}

/** A row's value for a variable parameter as the cell shows it: its source, or '' for none. */
export function cellSource(row: ConfigRow, parameterId: string): string {
  const v = row.values[parameterId];
  return typeof v === 'object' ? v.source : '';
}

/** A row's flag for a suppression parameter, or undefined when it keeps the document's. */
export function cellFlag(row: ConfigRow, parameterId: string): boolean | undefined {
  const v = row.values[parameterId];
  return typeof v === 'boolean' ? v : undefined;
}

/** A stored expression's value, unchanged when its text is (so its units stay as entered). */
export function keepUnits(old: ConfigValue | undefined, next: StoredExpression): StoredExpression {
  return typeof old === 'object' && old.source === next.source ? old : next;
}

/** The names of the variables the configuration table configures, with their parameters. */
export function configuredVariableNames(doc: ManufaktureDocument): Map<string, ConfigParameter> {
  const out = new Map<string, ConfigParameter>();
  for (const p of doc.configurations?.parameters ?? []) {
    if (p.kind === 'variable') out.set(p.variable, p);
  }
  return out;
}

/**
 * What a cell stores for `source`, typed for a variable of `kind`: a bare number for a length or
 * angle gets its unit written in (`800` becomes `800 mm`), as the Variables panel does, so the
 * variable means the same in every field that reads it in every row.
 */
export function cellExpression(
  source: string,
  kind: FieldKind,
  units: DisplayUnits,
  variables: Variables,
): StoredExpression {
  const typed = source.trim();
  const plain: StoredExpression = { source: typed, ...bareUnits(units) };
  if (kind !== 'length' && kind !== 'angle') return plain;
  const r = evaluateQuantity(typed, { ...bareUnits(units), variables: (n) => variables[n] });
  if (!r.ok || kindOfQuantity(r.value) !== 'number') return plain;
  return { source: withUnit(typed, kind, units), ...bareUnits(units) };
}
