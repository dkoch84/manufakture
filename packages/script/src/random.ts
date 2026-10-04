// The seed of a script's `Math.random` (ADR 0010 decision 3): a hash of the script source as
// stored in the document, mixed with the feature's integer `seed`. Never the feature id, which
// sync and branch merges may rename (ADR 0009 decision 5): the geometry must not change when they
// do. The same source and seed give the same sequence in every run, runtime and browser.

/** 32-bit FNV-1a over the UTF-16 code units of `text`. */
export function hashSource(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Murmur3's 32-bit finaliser: spreads every input bit over the output. */
function mix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The 32-bit generator seed for a script source and a feature seed (a safe integer). */
export function randomSeed(source: string, seed: number): number {
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError(`feature seed must be a safe integer, got ${seed}`);
  }
  const low = seed >>> 0;
  const high = Math.floor(seed / 4294967296) >>> 0;
  return mix(mix(hashSource(source) ^ low) ^ high ^ 0x9e3779b9);
}
