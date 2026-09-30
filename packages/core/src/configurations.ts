// The configuration table (format version 5): variants of one document as rows of a parameter
// table. A row overrides variable expressions and feature suppression; applying it gives an
// ordinary document that regen builds unchanged (M2 plan, T2.4a).

import { fail, ok, type CoreResult } from './result';
import type { ConfigRow, Configurations, ManufaktureDocument, Part } from './schema';
import { checkDocument, configuredVariables } from './validate';

export { configuredVariables };

/** A table with no parameters, no rows and no active row. */
export function emptyConfigurations(): Configurations {
  return { parameters: [], rows: [], active: null };
}

/** The row `rowId` names, or the active row when it is absent; `undefined` when there is none. */
export function configurationRow(
  doc: ManufaktureDocument,
  rowId?: string | null,
): ConfigRow | undefined {
  const table = doc.configurations;
  const id = rowId === undefined ? table?.active : rowId;
  if (!table || id === null || id === undefined) return undefined;
  return table.rows.find((r) => r.id === id);
}

/**
 * `doc` with `row` applied and `active` set to it, without validation. Parts and features that
 * the row does not change are the same objects as in `doc`.
 */
export function applyConfigurationRow(
  doc: ManufaktureDocument,
  row: ConfigRow,
): ManufaktureDocument {
  const table = doc.configurations ?? emptyConfigurations();
  const suppressed = new Map<string, Map<string, boolean>>();
  for (const p of table.parameters) {
    const value = row.values[p.id];
    if (p.kind !== 'suppression' || typeof value !== 'boolean') continue;
    let byFeature = suppressed.get(p.partId);
    if (!byFeature) suppressed.set(p.partId, (byFeature = new Map()));
    byFeature.set(p.featureId, value);
  }
  const parts = doc.parts.map((part): Part => {
    const byFeature = suppressed.get(part.id);
    if (!byFeature) return part;
    let changed = false;
    const features = part.features.map((f) => {
      const s = byFeature.get(f.id);
      if (s === undefined || s === f.suppressed) return f;
      changed = true;
      return { ...f, suppressed: s };
    });
    return changed ? { ...part, features } : part;
  });
  return {
    ...doc,
    variables: configuredVariables(doc.variables, table, row),
    parts,
    configurations: { ...table, active: row.id },
  };
}

/**
 * The document as configuration row `rowId` gives it (the active row by default): every
 * variable a parameter names takes the row's expression, and every feature a suppression
 * parameter names takes the row's flag. A parameter the row has no value for keeps the
 * document's own value. The result has `active` set to the row and is checked like any
 * document. With no row to apply (no table, or no active row and no `rowId`), it is `doc`.
 */
export function configured(
  doc: ManufaktureDocument,
  rowId?: string | null,
): CoreResult<ManufaktureDocument> {
  const id = rowId === undefined ? (doc.configurations?.active ?? null) : rowId;
  if (id === null) return ok(doc);
  const row = configurationRow(doc, id);
  if (!row) return fail('not-found', `No configuration row "${id}"`, ['rowId']);
  return checkDocument(applyConfigurationRow(doc, row));
}
