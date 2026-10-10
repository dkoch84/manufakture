// The bill of materials lines of purchased parts (ADR 0017 decision 7): one `@manufakture/takeoff`
// row per catalog entry used, with the ratings the design relies on and the alternates, and the
// CSV writer that adds them to `bom-csv`.
//
// Counting: a use whose `part` holds its geometry counts the part's instances in the assembly the
// BOM is counted through (suppressed ones left out), or the part once when no assembly is given,
// as the cut list counts part studios. A use with no part counts its `quantity` (a number
// expression; 1 when absent), for parts not modelled (screws, ferrules). A use with both counts
// the instances and flags the quantity as not used.
//
// Drift: a placeholder whose sizes no longer match its entry (the entry or the feature was edited
// after placing) flags its line `placeholder-drift`, with the sizes that differ as a warning.
//
// Ratings: until the checks (T9.5) say what each part must carry, a line relies on the entry's own
// values for the fields its family marks for the BOM, so a substitute must at least match the part
// chosen ("C at least 5400 N"). Nothing here calls a part adequate or safe: the line states
// numbers a buyer compares, and an unverified entry says so.

import {
  lengthFormat,
  mechItems,
  variableOrder,
  type CatalogRef,
  type CatalogEntry,
  type DisplayUnits,
  type ExtensionFeature,
  type ManufaktureDocument,
  type PurchasedUse,
  type Rated,
} from '@manufakture/core';
import {
  csvField,
  csvTextField,
  formatMeasure,
  formatRating,
  type TakeoffRating,
  type TakeoffRow,
} from '@manufakture/takeoff';
import {
  evaluate,
  evaluateQuantity,
  fromMillimetres,
  resolveDisplayUnit,
  toDisplayUnit,
  type Quantity,
} from '@manufakture/units';
import { refText, resolveEntry, type BuiltinEntry } from './catalog';
import { familySchema } from './families';
import { bareLengthUnit } from './input';
import { parseCsv } from './csv';
import { PLACEHOLDER_TYPE, placeholderDrift } from './placeholder';

/** The category of purchased part rows. */
export const PURCHASED_CATEGORY = 'purchased';

/** What the flags of a purchased row mean, in words. */
export const PURCHASED_FLAGS: Readonly<Record<string, string>> = {
  unverified: 'catalog data not verified against the maker',
  'unknown-entry': 'catalog entry not found in this build',
  'newer-version': 'a newer revision of the entry exists',
  deprecated: 'entry withdrawn',
  'part-missing': 'the part it names is gone',
  'quantity-ignored': 'quantity not used: the instances are counted',
  'quantity-unknown': 'quantity does not evaluate',
  estimated: 'a rating is estimated',
  'placeholder-drift': 'placeholder sizes differ from the catalog entry',
};

/** The entry's item text: `Bearing SKF 6001-2RSH`. */
export function entryItem(entry: CatalogEntry | BuiltinEntry): string {
  return `${familySchema(entry.family).label} ${entry.maker} ${entry.partNumber}`.trim();
}

/** Whether placeholder params name `ref` (they are read in full by `placeholderDrift`). */
function refMatches(params: unknown, ref: CatalogRef): boolean {
  const entry = (params as { entry?: unknown } | null)?.entry;
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Partial<Record<'source' | 'id' | 'version', unknown>>;
  return (
    e.source === ref.source &&
    e.id === ref.id &&
    (ref.source !== 'builtin' || e.version === ref.version)
  );
}

/** A reference as a merge key. */
function refKey(ref: CatalogRef): string {
  return ref.source === 'builtin' ? `builtin|${ref.id}|${ref.version}` : `document|${ref.id}`;
}

/**
 * The ratings a BOM line shows for an entry: each field its family marks for the BOM, with the
 * comparison a substitute must meet, in the document's display units. A value the datasheet does
 * not give shows as `unknown`.
 */
export function bomRatings(
  entry: CatalogEntry | BuiltinEntry,
  units: DisplayUnits,
): TakeoffRating[] {
  const schema = familySchema(entry.family);
  const out: TakeoffRating[] = [];
  for (const d of schema.dimensions) {
    if (d.bom !== true) continue;
    const rated = entry.dimensions?.[d.name];
    if (rated === undefined) continue;
    const unit = bareLengthUnit(units);
    out.push({
      name: d.label,
      comparison: 'equals',
      value: 'value' in rated ? fromMillimetres(rated.value, unit) : 'unknown',
      unit: 'value' in rated ? unit : '',
    });
  }
  for (const f of schema.fields) {
    if (f.bom === undefined) continue;
    const rated: Rated | undefined = entry.ratings[f.name];
    if (rated === undefined) continue;
    const name = f.symbol ?? f.label;
    if ('unknown' in rated) {
      out.push({ name, comparison: 'equals', value: 'unknown', unit: '' });
    } else if ('text' in rated) {
      out.push({ name, comparison: 'equals', value: rated.text, unit: '' });
    } else if (f.kind === 'number' || f.kind === 'count' || f.kind === 'text') {
      out.push({ name, comparison: f.bom, value: rated.value, unit: f.unit ?? '' });
    } else {
      const unit = resolveDisplayUnit(f.kind, units.quantities, units.length.unit);
      out.push({
        name,
        comparison: f.bom,
        value: toDisplayUnit(rated.value, f.kind, unit),
        unit,
      });
    }
  }
  return out;
}

/** The document's variables evaluated in order (those that measure the model fail). */
function variableValues(doc: ManufaktureDocument): Map<string, Quantity> {
  const values = new Map<string, Quantity>();
  const order = variableOrder(doc.variables);
  if (!order.ok) return values;
  const byName = new Map(doc.variables.map((v) => [v.name, v]));
  for (const name of order.value) {
    const v = byName.get(name);
    if (v === undefined) continue;
    const r = evaluateQuantity(v.expression.source, {
      lengthUnit: v.expression.lengthUnit,
      angleUnit: v.expression.angleUnit,
      variables: (n) => values.get(n),
    });
    if (r.ok) values.set(name, r.value);
  }
  return values;
}

export interface PurchasedBomOptions {
  /** Count part instances through this assembly; absent: each part once. */
  assemblyId?: string;
}

export interface PurchasedBom {
  rows: TakeoffRow[];
  /** Lines for people: uses that could not be counted or resolved. */
  warnings: string[];
}

/** One row per use, before merging (`purchasedBom` merges them). */
function useRow(
  doc: ManufaktureDocument,
  use: PurchasedUse,
  options: PurchasedBomOptions,
  variables: () => Map<string, Quantity>,
  warnings: string[],
): TakeoffRow {
  const flags: string[] = [];
  const label = use.name ?? refText(use.entry);
  let quantity = 1;
  if (use.part !== undefined) {
    if (!doc.parts.some((p) => p.id === use.part)) {
      flags.push('part-missing');
      warnings.push(`${use.id} (${label}): its part ${use.part} is gone; not counted`);
      quantity = 0;
    } else if (options.assemblyId !== undefined) {
      const assembly = doc.assemblies.find((a) => a.id === options.assemblyId);
      quantity =
        assembly?.instances.filter(
          (i) => !i.suppressed && 'part' in i.source && i.source.part === use.part,
        ).length ?? 0;
    }
    if (use.quantity !== undefined) flags.push('quantity-ignored');
  } else if (use.quantity !== undefined) {
    const r = evaluate(use.quantity.source, {
      expected: 'number',
      lengthUnit: use.quantity.lengthUnit,
      angleUnit: use.quantity.angleUnit,
      variables: (n) => variables().get(n),
    });
    if (r.ok && r.value >= 0 && Number.isFinite(r.value)) quantity = r.value;
    else {
      flags.push('quantity-unknown');
      warnings.push(`${use.id} (${label}): its quantity does not evaluate; not counted`);
      quantity = 0;
    }
  }
  const resolved = resolveEntry(doc, use.entry);
  const alternates = use.alternates.map((ref) => {
    const r = resolveEntry(doc, ref);
    return r.ok ? `${r.entry.maker} ${r.entry.partNumber}`.trim() : `${refText(ref)} (not found)`;
  });
  const source = {
    id: use.id,
    ...(use.part !== undefined ? { part: use.part } : {}),
    quantity,
  };
  if (!resolved.ok) {
    flags.push('unknown-entry');
    warnings.push(`${use.id} (${label}): ${resolved.message}`);
    return {
      key: `${PURCHASED_CATEGORY}|${refKey(use.entry)}`,
      item: label,
      category: PURCHASED_CATEGORY,
      quantity,
      unit: 'each',
      extended: quantity,
      measures: [],
      sources: [source],
      flags: flags.sort(),
      ratings: [],
      ...(alternates.length > 0 ? { alternates } : {}),
    };
  }
  const entry = resolved.entry;
  if (!entry.verified) flags.push('unverified');
  if (resolved.newer !== undefined) flags.push('newer-version');
  if (resolved.deprecated !== undefined) flags.push('deprecated');
  const part = use.part === undefined ? undefined : doc.parts.find((p) => p.id === use.part);
  const drift = (part?.features ?? [])
    .filter(
      (f): f is ExtensionFeature =>
        f.kind === 'extension' &&
        f.extension === PLACEHOLDER_TYPE &&
        !f.suppressed &&
        refMatches(f.params, use.entry),
    )
    .flatMap((f) => placeholderDrift(doc, f));
  if (drift.length > 0) {
    flags.push('placeholder-drift');
    warnings.push(`${use.id} (${label}): placeholder sizes differ: ${drift.join('; ')}`);
  }
  const ratings = bomRatings(entry, doc.units);
  const estimated = Object.values(entry.ratings).some((r) => 'value' in r && r.estimated === true);
  if (estimated) flags.push('estimated');
  const mass = entry.mass !== undefined && 'value' in entry.mass ? entry.mass.value : undefined;
  return {
    key: `${PURCHASED_CATEGORY}|${refKey(use.entry)}`,
    item: entryItem(entry),
    category: PURCHASED_CATEGORY,
    quantity,
    unit: 'each',
    extended: quantity,
    measures: mass === undefined ? [] : [{ unit: 'mass', value: mass * quantity }],
    sources: [source],
    flags: flags.sort(),
    ratings,
    ...(alternates.length > 0 ? { alternates } : {}),
  };
}

/** The purchased part rows of a document, merged per entry, with warnings. */
export function purchasedBom(
  doc: ManufaktureDocument,
  options: PurchasedBomOptions = {},
): PurchasedBom {
  const warnings: string[] = [];
  let vars: Map<string, Quantity> | undefined;
  const variables = () => (vars ??= variableValues(doc));
  const merged = new Map<string, TakeoffRow>();
  for (const use of mechItems(doc.mech, 'purchased')) {
    const row = useRow(doc, use, options, variables, warnings);
    const seen = merged.get(row.key);
    if (seen === undefined) {
      merged.set(row.key, row);
      continue;
    }
    seen.quantity += row.quantity;
    seen.extended += row.extended;
    for (const m of row.measures) {
      const s = seen.measures.find((x) => x.unit === m.unit);
      if (s === undefined) seen.measures.push({ ...m });
      else s.value += m.value;
    }
    seen.sources.push(...row.sources);
    for (const f of row.flags) if (!seen.flags.includes(f)) seen.flags.push(f);
    seen.flags.sort();
    for (const a of row.alternates ?? []) {
      const list = (seen.alternates ??= []);
      if (!list.includes(a)) list.push(a);
    }
  }
  return { rows: [...merged.values()], warnings };
}

/** The columns of a BOM with purchased parts: the cut list BOM's four, then the purchased ones. */
export const BOM_COLUMNS = ['Item', 'Size', 'Quantity', 'Total', 'Ratings', 'Alternates', 'Notes'];

/** A purchased row's cells, as `BOM_COLUMNS` lists them; text cells guarded against formulas. */
function rowCells(row: TakeoffRow, units: DisplayUnits): string[] {
  const mass = row.measures.find((m) => m.unit === 'mass');
  return [
    csvTextField(row.item),
    '',
    csvField(Number(row.quantity.toPrecision(12))),
    mass === undefined
      ? ''
      : csvTextField(formatMeasure(mass, lengthFormat(units), units.quantities)),
    csvTextField((row.ratings ?? []).map(formatRating).join('; ')),
    csvTextField((row.alternates ?? []).join('; ')),
    csvTextField(row.flags.map((f) => PURCHASED_FLAGS[f] ?? f).join('; ')),
  ];
}

/** The purchased part rows as CSV lines (no header), CRLF line ends like the cut list's files. */
export function purchasedCsvLines(rows: readonly TakeoffRow[], units: DisplayUnits): string[] {
  return rows.map((r) => rowCells(r, units).join(','));
}

/** The purchased parts alone as a BOM CSV: the header, then one line per row. */
export function purchasedBomCsv(rows: readonly TakeoffRow[], units: DisplayUnits): string {
  return (
    [BOM_COLUMNS.map(csvField).join(','), ...purchasedCsvLines(rows, units)].join('\r\n') + '\r\n'
  );
}

/**
 * A cut list BOM CSV (`Item,Size,Quantity,Total` and its lines) with the purchased rows added:
 * every existing line padded with empty cells to `BOM_COLUMNS`, the purchased lines after them.
 * The existing cells are written back as they were read (already guarded by their writer), with
 * whatever document text they hold, control characters included: the file is this program's own,
 * so it is read with `keepControls` rather than as untrusted input. The file unchanged when there
 * are no purchased rows.
 */
export function withPurchasedRows(
  bomCsv: string,
  rows: readonly TakeoffRow[],
  units: DisplayUnits,
): string {
  if (rows.length === 0) return bomCsv;
  const records = parseCsv(bomCsv, {
    chars: 64 * 1024 * 1024,
    rows: 1_000_000,
    columns: BOM_COLUMNS.length,
    field: 1_000_000,
    keepControls: true,
  });
  const lines = records.map((r, i) => {
    const cells = i === 0 ? [...BOM_COLUMNS] : [...r.fields];
    while (cells.length < BOM_COLUMNS.length) cells.push('');
    return cells.map(csvField).join(',');
  });
  if (lines.length === 0) lines.push(BOM_COLUMNS.map(csvField).join(','));
  return [...lines, ...purchasedCsvLines(rows, units)].join('\r\n') + '\r\n';
}
