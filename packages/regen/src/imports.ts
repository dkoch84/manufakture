// Imported files as regen consumes them. The document stores a file as base64 `data` with its
// `size` and SHA-256 (core's `ImportSource`). Regen checks the hash against the data once per
// source object, before the file first reaches the kernel: a document edited by hand, or damaged
// on the way, fails that import instead of building from bytes that are not the file it names.
// Once checked, the hash and size stand for the data in cache keys, so a regen does not hash the
// whole base64 text (about 80 ms for a 20 MB file) on every run.
//
// Checking here rather than when a document is loaded: loading is synchronous (a schema check)
// and would pay for hashing every import, reference ones included, where regen hashes only
// imports that join the body, once, and only when they are built.

import type { ImportSource } from '@manufakture/core';
import type { FeatureInput } from '@manufakture/kernel';

/** Lower-case hex SHA-256 of bytes (Web Crypto: browser, worker and Node alike). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The bytes base64 `text` holds, or null when it is not base64. */
export function decodeBase64(text: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Whether `data` holds `size` bytes whose SHA-256 is `sha256`. */
export async function importSourceMatches(source: ImportSource): Promise<boolean> {
  const bytes = decodeBase64(source.data);
  if (bytes === null || bytes.length !== source.size) return false;
  return (await sha256Hex(bytes)) === source.sha256;
}

/**
 * What a kernel input contributes to its cache key. An import's file is keyed by its verified
 * hash and size instead of its text; every other input as it is.
 */
export function keyInput(input: FeatureInput, source: ImportSource | null): unknown {
  if (input.kind !== 'import' || source === null) return input;
  return { ...input, step: { sha256: source.sha256, size: source.size } };
}
