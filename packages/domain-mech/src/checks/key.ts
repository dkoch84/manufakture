// The record cache's key: a canonical JSON of everything that goes into a record, with object
// keys sorted, so equal inputs give equal keys whatever order they were gathered in. `undefined`
// is written as `null` in arrays and left out in objects, as JSON does, and a non-finite number
// is written by name so that NaN and a missing value never share a key.

function canonical(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? value : `#${String(value)}`;
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonical(v)));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = canonical(v);
    }
    return out;
  }
  return value;
}

/** A string that is equal for equal plain values, whatever the order of their keys. */
export function stableKey(value: unknown): string {
  return JSON.stringify(canonical(value));
}
