// Canonical hashing for toolpath cache keys (ADR 0014 decision 9, after ADR 0004 decision 8).
// The same canonical form and 128-bit hash as regen's `hash.ts` (packages/regen/src/hash.ts),
// copied rather than imported since this package may not load regen (ADR 0014 decision 1), with
// one difference: a typed array is hashed from its bytes, not written out number by number, so a
// 100,000-triangle mesh costs one pass over its buffer rather than a multi-megabyte string.

/**
 * Canonical JSON: object keys sorted, `undefined` members dropped, `-0` written as `0`, and a typed
 * array as `{"$typed":<constructor>,"length":n,"hash":<hash of its bytes>}`. Any other object that
 * is not a plain object or an array (an `ArrayBuffer`, `Map`, `Set`, `Date`) throws, since it would
 * otherwise hash as `{}`.
 */
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
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        const length = 'length' in value ? (value as { length: number }).length : value.byteLength;
        return (
          `{"$typed":${JSON.stringify(value.constructor.name)},` +
          `"length":${length},"hash":"${hashBytes(bytes)}"}`
        );
      }
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        // An ArrayBuffer, Map, Set or Date has no own enumerable keys and would hash as `{}`.
        const name = (value as { constructor?: { name?: string } }).constructor?.name ?? 'object';
        throw new TypeError(`cannot hash a ${name}: only plain objects, arrays and typed arrays`);
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

/** Four 32-bit lanes of a multiply-xorshift mix (cyrb128 style), as 32 hex digits. */
function cyrb128(length: number, at: (i: number) => number): string {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < length; i++) {
    const k = at(i);
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

/**
 * A 128-bit non-cryptographic hash of a string, as 32 hex digits; the same function as regen's
 * `hashString`. A collision would serve a wrong toolpath, so 128 bits keep that out of reach for
 * any realistic number of entries; nothing here needs to resist an attacker.
 */
export function hashString(text: string): string {
  return cyrb128(text.length, (i) => text.charCodeAt(i));
}

/** The same hash over bytes. */
export function hashBytes(bytes: Uint8Array): string {
  return cyrb128(bytes.length, (i) => bytes[i]!);
}

/** The hash of a value's canonical JSON. */
export function hashValue(value: unknown): string {
  return hashString(stableStringify(value));
}
