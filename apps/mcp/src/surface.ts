// The tool surface as a contract (ADR 0016 decision 7): every tool's name with its input and
// output JSON Schemas, as a client sees them in `tools/list`, and the rule a new surface must
// keep against the old one: add, never silently change.
//
// `surfaceChanges(old, next)` lists every change that does more than add:
//
// - a tool removed;
// - inputs: a property removed or newly required, a type, const, pattern or format changed, an
//   enum value or union option dropped, a bound tightened (a lower maximum, a higher minimum, a
//   new bound), unknown fields refused where they were allowed;
// - outputs: a property removed, a type, const, pattern or format changed, a property no longer
//   required, an enum value or union option dropped, an enum value added (a client that handles
//   every value it knows meets one it does not), a bound changed.
//
// Descriptions and titles are not part of the contract's shape and may be reworded; the golden
// leaves them out.

/** One tool as `tools/list` gives it, without its description. */
export interface ToolContract {
  name: string;
  inputSchema: unknown;
  outputSchema: unknown;
}

export interface SurfaceContract {
  surfaceVersion: string;
  tools: ToolContract[];
}

type Json = Record<string, unknown>;
type Mode = 'input' | 'output';

const IGNORED = new Set(['description', 'title', '$schema']);
const EXACT = new Set(['type', 'const', 'pattern', 'format', '$ref']);
const UPPER = new Set(['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties']);
const LOWER = new Set(['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties']);

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** `v` with object keys sorted, for comparison. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (isObject(v)) {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical(v[k])]),
    );
  }
  return v;
}

function schemaChanges(old: unknown, next: unknown, mode: Mode, path: string, out: string[]): void {
  if (equal(old, next)) return;
  if (!isObject(old) || !isObject(next)) {
    // `true`/`{}` schemas and the like: only an equal one keeps the contract.
    if (!(isObject(old) && Object.keys(old).length === 0 && mode === 'input')) {
      out.push(`${path}: the schema changed`);
    }
    return;
  }
  const keys = new Set([...Object.keys(old), ...Object.keys(next)]);
  for (const key of keys) {
    if (IGNORED.has(key)) continue;
    const a = old[key];
    const b = next[key];
    const at = `${path}/${key}`;
    if (EXACT.has(key)) {
      if (!equal(a, b)) out.push(`${at}: changed`);
    } else if (UPPER.has(key) || LOWER.has(key)) {
      if (mode === 'output') {
        if (!equal(a, b)) out.push(`${at}: changed`);
      } else if (b !== undefined) {
        const tighter =
          a === undefined ||
          (UPPER.has(key) ? (b as number) < (a as number) : (b as number) > (a as number));
        if (tighter) out.push(`${at}: tightened`);
      }
    } else if (key === 'properties') {
      const ap = (isObject(a) ? a : {}) as Json;
      const bp = (isObject(b) ? b : {}) as Json;
      for (const name of Object.keys(ap)) {
        if (!(name in bp)) out.push(`${at}/${name}: removed`);
        else schemaChanges(ap[name], bp[name], mode, `${at}/${name}`, out);
      }
    } else if (key === 'required') {
      const ar = new Set((a as string[] | undefined) ?? []);
      const br = new Set((b as string[] | undefined) ?? []);
      if (mode === 'input') {
        for (const r of br) if (!ar.has(r)) out.push(`${at}: ${r} is newly required`);
      } else {
        for (const r of ar) if (!br.has(r)) out.push(`${at}: ${r} is no longer always there`);
      }
    } else if (key === 'enum') {
      const bv = ((b as unknown[] | undefined) ?? []).map((x) => JSON.stringify(x));
      for (const v of (a as unknown[] | undefined) ?? []) {
        if (!bv.includes(JSON.stringify(v))) out.push(`${at}: ${JSON.stringify(v)} dropped`);
      }
      if (a === undefined) out.push(`${at}: added`);
      else if (mode === 'output') {
        const av = (a as unknown[]).map((x) => JSON.stringify(x));
        for (const v of bv) if (!av.includes(v)) out.push(`${at}: ${v} added to an output enum`);
      }
    } else if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
      const ao = (a as unknown[] | undefined) ?? [];
      const bo = (b as unknown[] | undefined) ?? [];
      if (key === 'allOf' ? ao.length !== bo.length : bo.length < ao.length) {
        out.push(`${at}: options removed or changed`);
      }
      ao.forEach((o, i) => {
        if (i < bo.length) schemaChanges(o, bo[i], mode, `${at}/${i}`, out);
      });
    } else if (key === 'items' || key === 'prefixItems') {
      if (Array.isArray(a) || Array.isArray(b)) {
        const aa = (a as unknown[] | undefined) ?? [];
        const ba = (b as unknown[] | undefined) ?? [];
        if (aa.length !== ba.length) out.push(`${at}: changed`);
        aa.forEach((x, i) => schemaChanges(x, ba[i], mode, `${at}/${i}`, out));
      } else {
        schemaChanges(a ?? {}, b ?? {}, mode, at, out);
      }
    } else if (key === 'additionalProperties') {
      // Inputs: refusing unknown fields that were allowed tightens. Outputs: any change is one.
      if (mode === 'input') {
        if (b === false && a !== false) out.push(`${at}: tightened`);
        else if (isObject(a) && isObject(b)) schemaChanges(a, b, mode, at, out);
      } else if (!equal(a, b)) {
        out.push(`${at}: changed`);
      }
    } else if (!equal(a, b)) {
      out.push(`${at}: changed`);
    }
  }
}

/** Every change from `old` to `next` that does more than add. Empty: the contract holds. */
export function surfaceChanges(old: SurfaceContract, next: SurfaceContract): string[] {
  const out: string[] = [];
  const byName = new Map(next.tools.map((t) => [t.name, t]));
  for (const tool of old.tools) {
    const now = byName.get(tool.name);
    if (now === undefined) {
      out.push(`${tool.name}: removed`);
      continue;
    }
    schemaChanges(tool.inputSchema, now.inputSchema, 'input', `${tool.name} input`, out);
    schemaChanges(tool.outputSchema, now.outputSchema, 'output', `${tool.name} output`, out);
  }
  return out;
}

/** Keywords whose value maps names to schemas (the names are data, not keywords). */
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);
/** Keywords whose value is data, never a schema. */
const DATA = new Set(['enum', 'const', 'required', 'default', 'examples']);

/** `schema` without descriptions and titles (wording, not shape), keys sorted. */
function shapeOf(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(shapeOf);
  if (!isObject(schema)) return schema;
  const out: Json = {};
  for (const key of Object.keys(schema).sort()) {
    if (IGNORED.has(key) && key !== '$schema') continue;
    const v = schema[key];
    if (SCHEMA_MAPS.has(key) && isObject(v)) {
      out[key] = Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((name) => [name, shapeOf(v[name])]),
      );
    } else {
      out[key] = DATA.has(key) ? canonical(v) : shapeOf(v);
    }
  }
  return out;
}

/** The contract of `tools` (as `tools/list` gives them), sorted by name. */
export function contractOf(
  surfaceVersion: string,
  tools: readonly { name: string; inputSchema: unknown; outputSchema?: unknown }[],
): SurfaceContract {
  return {
    surfaceVersion,
    tools: [...tools]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((t) => ({
        name: t.name,
        inputSchema: shapeOf(t.inputSchema),
        outputSchema: shapeOf(t.outputSchema ?? null),
      })),
  };
}

/** Whether semantic version `a` is greater than `b` (`major.minor.patch`). */
export function versionAfter(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}
