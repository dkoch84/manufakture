import {
  FORMAT_MIGRATIONS,
  NAMING_MIGRATIONS,
  type JsonObject,
  type Migration,
} from './migrations';
import { fail, ok, schemaError, type CoreResult } from './result';
import {
  DocumentSchema,
  FORMAT_TAG,
  FORMAT_VERSION,
  NAMING_SCHEME,
  type DomainData,
  type ManufaktureDocument,
} from './schema';
import { checkDocument } from './validate';

/**
 * Reading and writing the document file (ADR 0004 decisions 2, 3 and 9). Loading is:
 * parse JSON, check the format tag, refuse a newer version, run the file format migrations,
 * refuse a newer naming scheme, run the naming migrations, check the schema, check the semantic
 * rules. Every step reports a `CoreError` and nothing is repaired silently. The input is never
 * modified.
 */

export interface MigrationOptions {
  readonly formatMigrations?: readonly Migration[];
  readonly formatVersion?: number;
  readonly namingMigrations?: readonly Migration[];
  readonly namingScheme?: number;
}

export interface Loaded {
  readonly document: ManufaktureDocument;
  /** The versions the file was written in, before migration. */
  readonly from: { readonly version: number; readonly namingScheme: number };
  /** Whether any migration ran, so the app can offer to save in the current version. */
  readonly migrated: boolean;
}

/**
 * Canonical JSON: keys in schema order, two-space indent, trailing newline. Serializing a
 * document read back from its own output gives the same text.
 */
export function serialize(doc: ManufaktureDocument): string {
  const parsed = DocumentSchema.safeParse(doc);
  if (!parsed.success) {
    // A document that reached here without passing the schema is a programming error.
    throw new Error(schemaError('Cannot serialize an invalid document', parsed.error).message);
  }
  return `${JSON.stringify(canonical(parsed.data), null, 2)}\n`;
}

function sortKeys(value: unknown, deep: boolean): unknown {
  if (Array.isArray(value)) return deep ? value.map((v) => sortKeys(v, deep)) : value;
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, deep ? sortKeys(value[k], deep) : value[k]]),
  );
}

/**
 * Schema-shaped objects already come out of zod in schema order. Records (`nextIds` of the
 * document, its parts, its assemblies, its print section and its drawings, an extension's
 * `expressions` and its opaque `params`, a configuration row's `values`, the `domains` namespaces
 * and each one's opaque `data`) keep insertion order, so they are sorted here; otherwise two equal
 * documents could be saved as different text.
 */
function canonical(doc: ManufaktureDocument): ManufaktureDocument {
  const { configurations, domains, drawings } = doc;
  return {
    ...doc,
    ...(drawings && {
      drawings: drawings.map((drawing) => ({
        ...drawing,
        nextIds: sortKeys(drawing.nextIds, false) as Record<string, number>,
      })),
    }),
    ...(domains && {
      domains: Object.fromEntries(
        Object.keys(domains)
          .sort()
          .map((ns) => [
            ns,
            { ...domains[ns]!, data: sortKeys(domains[ns]!.data, true) as DomainData['data'] },
          ]),
      ),
    }),
    ...(configurations && {
      configurations: {
        ...configurations,
        rows: configurations.rows.map((row) => ({
          ...row,
          values: sortKeys(row.values, false) as typeof row.values,
        })),
      },
    }),
    nextIds: sortKeys(doc.nextIds, false) as Record<string, number>,
    print: {
      ...doc.print,
      nextIds: sortKeys(doc.print.nextIds, false) as Record<string, number>,
    },
    assemblies: doc.assemblies.map((assembly) => ({
      ...assembly,
      nextIds: sortKeys(assembly.nextIds, false) as Record<string, number>,
    })),
    parts: doc.parts.map((part) => ({
      ...part,
      nextIds: sortKeys(part.nextIds, false) as Record<string, number>,
      features: part.features.map((f) =>
        f.kind === 'extension'
          ? {
              ...f,
              expressions: sortKeys(f.expressions, false) as typeof f.expressions,
              params: sortKeys(f.params, true) as typeof f.params,
            }
          : f,
      ),
    })),
  };
}

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function runChain(
  doc: JsonObject,
  key: 'version' | 'namingScheme',
  start: number,
  target: number,
  chain: readonly Migration[],
  indexOf: (from: number) => number,
): CoreResult<JsonObject> {
  let current = doc;
  for (let v = start; v < target; v++) {
    const m = chain[indexOf(v)];
    if (!m || m.from !== v || m.to !== v + 1) {
      return fail('migration', `No ${key} migration from ${v} to ${v + 1}`, [key]);
    }
    let next: JsonObject;
    try {
      next = m.migrate(current);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return fail('migration', `Migration from ${key} ${v} to ${v + 1} failed: ${why}`, [key]);
    }
    if (!isObject(next) || next[key] !== v + 1) {
      return fail(
        'migration',
        `Migration from ${key} ${v} to ${v + 1} did not produce ${key} ${v + 1}`,
        [key],
      );
    }
    current = next;
  }
  return ok(current);
}

function readVersion(
  doc: JsonObject,
  key: 'version' | 'namingScheme',
  min: number,
): CoreResult<number> {
  const v = doc[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
    return fail('version', `"${key}" must be an integer of at least ${min}`, [key]);
  }
  return ok(v);
}

/**
 * Brings raw document JSON up to the current file format and naming scheme, without checking
 * the result against the schema. Exposed for tests and tools; apps use `parseDocument`.
 */
export function migrateJson(
  value: unknown,
  options: MigrationOptions = {},
): CoreResult<{
  json: JsonObject;
  from: { version: number; namingScheme: number };
}> {
  const formatVersion = options.formatVersion ?? FORMAT_VERSION;
  const namingScheme = options.namingScheme ?? NAMING_SCHEME;
  if (!isObject(value) || value.format !== FORMAT_TAG) {
    return fail('format', `Not a ${FORMAT_TAG} document`, ['format']);
  }
  const version = readVersion(value, 'version', 0);
  if (!version.ok) return version;
  if (version.value > formatVersion) {
    return fail(
      'version',
      `This document was saved by a newer version of manufakture (file format ${version.value}; this app reads up to ${formatVersion}). It was not opened or changed.`,
      ['version'],
    );
  }
  // The input stays untouched: migrations get a deep copy.
  const copy = JSON.parse(JSON.stringify(value)) as JsonObject;
  const formatted = runChain(
    copy,
    'version',
    version.value,
    formatVersion,
    options.formatMigrations ?? FORMAT_MIGRATIONS,
    (v) => v,
  );
  if (!formatted.ok) return formatted;

  const scheme = readVersion(formatted.value, 'namingScheme', 1);
  if (!scheme.ok) return scheme;
  if (scheme.value > namingScheme) {
    return fail(
      'version',
      `This document uses a newer topological naming scheme (${scheme.value}; this app knows up to ${namingScheme}). It was not opened or changed.`,
      ['namingScheme'],
    );
  }
  const named = runChain(
    formatted.value,
    'namingScheme',
    scheme.value,
    namingScheme,
    options.namingMigrations ?? NAMING_MIGRATIONS,
    (v) => v - 1,
  );
  if (!named.ok) return named;
  return ok({
    json: named.value,
    // Before version 1 the scheme was implicit; the version 0 migration fills it in.
    from: { version: version.value, namingScheme: scheme.value },
  });
}

/** Loads a document from parsed JSON: migrate, then validate. */
export function parseDocument(value: unknown): CoreResult<Loaded> {
  try {
    return loadDocument(value);
  } catch (e) {
    // Data nested deeper than the schema's limits can overflow the stack in the deep copy
    // before the schema runs: report it like any other bad document.
    if (e instanceof RangeError) return tooDeep(e);
    throw e;
  }
}

function tooDeep(e: RangeError): CoreResult<never> {
  return fail('schema', `Invalid document: it nests too deeply (${e.message})`);
}

function loadDocument(value: unknown): CoreResult<Loaded> {
  const migrated = migrateJson(value);
  if (!migrated.ok) return migrated;
  const parsed = DocumentSchema.safeParse(migrated.value.json);
  if (!parsed.success) return { ok: false, error: schemaError('Invalid document', parsed.error) };
  const checked = checkDocument(parsed.data);
  if (!checked.ok) return checked;
  const { from } = migrated.value;
  return ok({
    document: parsed.data,
    from,
    migrated: from.version !== FORMAT_VERSION || from.namingScheme !== NAMING_SCHEME,
  });
}

/** Loads a document from its file text. */
export function deserialize(text: string): CoreResult<Loaded> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    if (e instanceof RangeError) return tooDeep(e);
    return fail('json', `Not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseDocument(value);
}
