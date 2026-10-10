// CSV import of catalog entries (ADR 0017 decision 7: "a CSV import of many, refusing malformed
// rows with line numbers"). The file is untrusted, so the reader is bounded in every direction
// (characters, rows, columns, field length), runs in one linear pass that cannot hang, and names
// the line of every problem. Nothing is imported unless every row is good: the result is one
// batch of `setCatalogEntry` commands, or the list of problems.
//
// The columns (a header row first; names exact, order free):
//
// - `family`, `maker`, `partNumber` (required); `description`, `mass`, `verified` (yes or no,
//   default no), `notes`, `shape` (cylinder, ring or box) and `axis` (x, y or z) for the
//   placeholder, and one source: `sourceTitle`, `sourceUrl` (http or https only),
//   `sourceRevision`, `sourceRead` (a date, `2026-10-10`).
// - `dim.<name>` for a dimension (`dim.innerDiameter`), a length.
// - `<rating>` for a rating of the row's family (`dynamicLoad`), with `<rating>.convention`,
//   `<rating>.basis` and `<rating>.estimated` (yes or no) beside it. A file may mix families; a
//   cell for a rating the row's family does not have must be empty.
//
// Values are read as the editor reads them (`input.ts`): with a unit, or bare in the document's
// display unit; `unknown` for a value the datasheet does not give.

import {
  MAX_CATALOG_ENTRIES,
  MECH_COUNTERS,
  mechItems,
  type CatalogEntry,
  type Command,
  type DisplayUnits,
  type ManufaktureDocument,
} from '@manufakture/core';
import { columnProblem, readEntryFields } from './entry';

/** The most characters a CSV file may hold (about 2 MiB of ASCII). */
export const MAX_CSV_CHARS = 2 * 1024 * 1024;
/** The most data rows (the most user entries a document may hold). */
export const MAX_CSV_ROWS = MAX_CATALOG_ENTRIES;
/** The most columns of a row. */
export const MAX_CSV_COLUMNS = 256;
/** The longest field, in characters (a long note). */
export const MAX_CSV_FIELD = 10_000;
/** The most problems one import reports. */
export const MAX_CSV_PROBLEMS = 50;

/** A problem with a CSV file, at a line (1 for the header) and perhaps a column. */
export interface CsvProblem {
  line: number;
  column?: string;
  message: string;
}

export class CsvError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(`line ${line}: ${message}`);
  }
}

/** One record of a CSV file, with the line it starts on. */
export interface CsvRecord {
  line: number;
  fields: string[];
}

export interface CsvLimits {
  chars?: number;
  rows?: number;
  columns?: number;
  field?: number;
  /**
   * Keep control characters in fields instead of refusing the file. Only for text this program
   * wrote itself (the cut list's BOM, whose cells carry document text as it is); never for a file
   * a user gives.
   */
  keepControls?: boolean;
}

/**
 * The records of a CSV text (RFC 4180, with LF or CR line ends accepted too and a leading byte
 * order mark dropped), bounded by `limits`. Throws a `CsvError` naming the line of the first
 * problem: an unterminated quote, a quote inside an unquoted field, text after a closing quote, a
 * control character (unless `keepControls`), or a limit passed. An empty line is no record and
 * does not count against the row limit. One pass over the text; nothing backtracks.
 */
export function parseCsv(text: string, limits: CsvLimits = {}): CsvRecord[] {
  const maxChars = limits.chars ?? MAX_CSV_CHARS;
  // A data row limit plus the header.
  const maxRecords = (limits.rows ?? MAX_CSV_ROWS) + 1;
  const maxColumns = limits.columns ?? MAX_CSV_COLUMNS;
  const maxField = limits.field ?? MAX_CSV_FIELD;
  const keepControls = limits.keepControls === true;
  if (text.length > maxChars) {
    throw new CsvError(1, `the file has ${text.length} characters; at most ${maxChars} are read`);
  }
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let recordLine = 1;
  let field = '';
  // 0: at the start of a field; 1: in an unquoted field; 2: in a quoted field; 3: after the
  // closing quote of a quoted field.
  let state = 0;
  let quoteLine = 1;

  const pushField = () => {
    if (fields.length >= maxColumns) {
      throw new CsvError(recordLine, `more than ${maxColumns} columns`);
    }
    fields.push(field);
    field = '';
  };
  const pushRecord = () => {
    pushField();
    if (records.length >= maxRecords) {
      throw new CsvError(recordLine, `more than ${maxRecords - 1} rows`);
    }
    records.push({ line: recordLine, fields });
    fields = [];
    state = 0;
  };
  const add = (c: string) => {
    if (field.length >= maxField) {
      throw new CsvError(line, `a field longer than ${maxField} characters`);
    }
    field += c;
  };

  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    const code = c.charCodeAt(0);
    const isBreak = c === '\n' || c === '\r';
    if (!keepControls && !isBreak && c !== '\t' && (code < 0x20 || code === 0x7f)) {
      throw new CsvError(line, `a control character (U+${code.toString(16).padStart(4, '0')})`);
    }
    if (state === 2) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          add('"');
          i += 2;
          continue;
        }
        state = 3;
        i++;
        continue;
      }
      if (c === '\r' && text[i + 1] === '\n') {
        add('\r\n');
        line++;
        i += 2;
        continue;
      }
      if (isBreak) line++;
      add(c);
      i++;
      continue;
    }
    if (isBreak) {
      // An empty line (nothing on it, not even `""`) is skipped, so it costs no row.
      if (state !== 0 || field !== '' || fields.length > 0) pushRecord();
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      line++;
      recordLine = line;
      continue;
    }
    if (c === ',') {
      pushField();
      state = 0;
      i++;
      continue;
    }
    if (state === 3) throw new CsvError(line, 'text after a closing quote');
    if (c === '"') {
      if (state === 1) throw new CsvError(line, 'a quote inside an unquoted field');
      state = 2;
      quoteLine = line;
      i++;
      continue;
    }
    state = 1;
    add(c);
    i++;
  }
  if (state === 2) throw new CsvError(quoteLine, 'a quoted field is never closed');
  // The last record, unless the file ended with a line break.
  if (state !== 0 || field !== '' || fields.length > 0) pushRecord();
  return records;
}

export interface CsvImportOptions {
  /** The document's display units, which bare numbers are read in. */
  units: DisplayUnits;
}

export type CsvImport =
  { ok: true; entries: CatalogEntry[]; command: Command } | { ok: false; problems: CsvProblem[] };

/** The ids `count` new user entries get, in order. */
export function nextEntryIds(doc: ManufaktureDocument, count: number): string[] {
  const start = doc.mech?.nextIds[MECH_COUNTERS.entry] ?? 1;
  return Array.from({ length: count }, (_, i) => `${MECH_COUNTERS.entry}#${start + i}`);
}

/**
 * Catalog entries from a CSV text, as user entries of `doc` (fresh `entry#n` ids, version 1),
 * with the batch of commands that adds them; or every problem found (up to
 * `MAX_CSV_PROBLEMS`), each with its line. All or nothing.
 */
export function importCatalogCsv(
  doc: ManufaktureDocument,
  text: string,
  options: CsvImportOptions,
): CsvImport {
  const existing = mechItems(doc.mech, 'catalog').length;
  let records: CsvRecord[];
  try {
    records = parseCsv(text, { rows: Math.max(0, MAX_CATALOG_ENTRIES - existing) });
  } catch (e) {
    if (e instanceof CsvError)
      return {
        ok: false,
        problems: [{ line: e.line, message: e.message.replace(/^line [0-9]+: /, '') }],
      };
    throw e;
  }
  const problems: CsvProblem[] = [];
  const problem = (p: CsvProblem) => {
    if (problems.length < MAX_CSV_PROBLEMS) problems.push(p);
  };
  const header = records[0];
  if (header === undefined)
    return { ok: false, problems: [{ line: 1, message: 'the file is empty' }] };
  const columns: string[] = [];
  const seen = new Set<string>();
  header.fields.forEach((raw) => {
    const name = raw.trim();
    const why = columnProblem(name);
    if (why !== undefined) problem({ line: header.line, column: name.slice(0, 64), message: why });
    else if (seen.has(name)) {
      problem({ line: header.line, column: name, message: 'a column given twice' });
    }
    columns.push(name);
    seen.add(name);
  });
  for (const required of ['family', 'maker', 'partNumber']) {
    if (!seen.has(required)) problem({ line: header.line, message: `no "${required}" column` });
  }
  if (problems.length > 0) return { ok: false, problems };

  const rows = records
    .slice(1)
    .filter((r) => !(r.fields.length === 1 && r.fields[0]!.trim() === ''));
  if (rows.length === 0)
    return { ok: false, problems: [{ line: header.line, message: 'no rows below the header' }] };
  const ids = nextEntryIds(doc, rows.length);
  const entries: CatalogEntry[] = [];

  rows.forEach((row, index) => {
    if (row.fields.length !== columns.length) {
      problem({
        line: row.line,
        message: `${row.fields.length} fields where the header has ${columns.length}`,
      });
      return;
    }
    const fields: Record<string, string> = {};
    columns.forEach((col, i) => {
      fields[col] = row.fields[i]!;
    });
    const r = readEntryFields(fields, ids[index]!, options.units);
    if (!r.ok) {
      for (const p of r.problems) problem({ line: row.line, column: p.column, message: p.message });
      return;
    }
    entries.push(r.entry);
  });

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    entries,
    command:
      entries.length === 1
        ? { type: 'setCatalogEntry', entry: entries[0]! }
        : { type: 'batch', commands: entries.map((entry) => ({ type: 'setCatalogEntry', entry })) },
  };
}

/** A problem as one line for people: `line 4, dynamicLoad: ...`. */
export function problemText(p: CsvProblem): string {
  return `line ${p.line}${p.column !== undefined ? `, ${p.column.slice(0, 64)}` : ''}: ${p.message}`;
}
