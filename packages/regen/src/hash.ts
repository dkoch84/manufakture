// Cache keys (ADR 0004 decision 8): a hash of a feature's inputs, the keys of
// what it depends on, and the versions that can change its output. Inputs are
// plain JSON-like data, serialized canonically (sorted keys, no undefined), so
// equal inputs always give equal keys whatever order their keys were built in.

/** Canonical JSON: object keys sorted, `undefined` members dropped, `-0` written as `0`. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  switch (typeof value) {
    case 'number':
      if (!Number.isFinite(value)) return JSON.stringify(String(value));
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
      if (ArrayBuffer.isView(value)) {
        return stableStringify(Array.from(value as unknown as ArrayLike<number>));
      }
      const o = value as Record<string, unknown>;
      const keys = Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`cannot hash a ${typeof value}`);
  }
}

/**
 * A 128-bit non-cryptographic hash of a string (four 32-bit lanes of a
 * multiply-xorshift mix, cyrb128 style), as 32 hex digits. Collisions would
 * serve a wrong cached result, so 128 bits keep that out of reach for any
 * realistic number of entries; nothing here needs to resist an attacker.
 */
export function hashString(text: string): string {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('');
}

/** The hash of a value's canonical JSON. */
export function hashValue(value: unknown): string {
  return hashString(stableStringify(value));
}
