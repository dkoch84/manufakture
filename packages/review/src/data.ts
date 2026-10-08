// What the app (T8.3b) needs of a bundle without the builder (`@manufakture/review/data`, safe in
// a browser: no Node module, no kernel): reading one back with its bounds checked, and whether it
// is stale. A bundle is untrusted content: `readBundle` checks the envelope and walks every
// value once, without recursion, refusing deep nesting, long lists, long strings and image
// references that are not SHA-256s, before the app shows any of it (as text).

import { BUNDLE_FORMAT, BUNDLE_VERSION, LIMITS, type BundleKey, type ReviewBundle } from './types';

/** Where a branch is now: its id, head revision and base version. */
export interface BranchHead {
  branch: string;
  revision: number;
  /** The version it was made from; when given, a bundle for another base is stale too. */
  baseVersion?: string;
}

/**
 * Whether `bundle` no longer describes the branch: built for another branch, another head
 * revision (a write came after it) or another base version. A stale bundle cannot be approved.
 */
export function isStale(bundle: { key: BundleKey }, head: BranchHead): boolean {
  return (
    bundle.key.branch !== head.branch ||
    bundle.key.headRevision !== head.revision ||
    (head.baseVersion !== undefined && bundle.key.baseVersion !== head.baseVersion)
  );
}

const MAX_DEPTH = 16;
const MAX_LIST = Math.max(LIMITS.commands, LIMITS.batches, LIMITS.bodies, LIMITS.quantities);
const MAX_TOTAL_TEXT = 64 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

function stringLimit(key: string | null): number {
  if (key === 'source' || key === 'previous') return LIMITS.scriptSource;
  if (key === 'json') return LIMITS.commandJson;
  return LIMITS.text;
}

/** A bundle as stored, checked; the reason when it does not read. */
export function readBundle(
  value: unknown,
): { ok: true; bundle: ReviewBundle } | { ok: false; message: string } {
  const v = value as Partial<ReviewBundle> | null;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return { ok: false, message: 'A bundle is an object.' };
  }
  if (v.format !== BUNDLE_FORMAT || v.version !== BUNDLE_VERSION) {
    return { ok: false, message: 'This is not a review bundle this release reads.' };
  }
  const key = v.key as BundleKey | undefined;
  if (
    typeof key !== 'object' ||
    key === null ||
    typeof key.documentId !== 'string' ||
    typeof key.branch !== 'string' ||
    typeof key.baseVersion !== 'string' ||
    !Number.isSafeInteger(key.headRevision) ||
    key.headRevision < 1
  ) {
    return { ok: false, message: 'The bundle has no valid key.' };
  }
  let text = 0;
  const stack: { value: unknown; key: string | null; depth: number }[] = [
    { value, key: null, depth: 0 },
  ];
  while (stack.length > 0) {
    const { value: x, key: k, depth } = stack.pop()!;
    if (depth > MAX_DEPTH) return { ok: false, message: 'The bundle nests too deep.' };
    if (typeof x === 'string') {
      if (x.length > stringLimit(k))
        return { ok: false, message: `A text in the bundle is too long (${k ?? 'value'}).` };
      if (k === 'sha256' && !SHA256.test(x))
        return { ok: false, message: 'An image reference is not a SHA-256.' };
      text += x.length;
      if (text > MAX_TOTAL_TEXT) return { ok: false, message: 'The bundle holds too much text.' };
      continue;
    }
    if (typeof x === 'number') {
      if (!Number.isFinite(x))
        return { ok: false, message: 'The bundle holds a number that is not finite.' };
      continue;
    }
    if (x === null || typeof x === 'boolean') continue;
    if (Array.isArray(x)) {
      if (x.length > MAX_LIST) return { ok: false, message: 'A list in the bundle is too long.' };
      for (const item of x) stack.push({ value: item, key: k, depth: depth + 1 });
      continue;
    }
    if (typeof x === 'object') {
      const entries = Object.entries(x as Record<string, unknown>);
      if (entries.length > MAX_LIST)
        return { ok: false, message: 'An object in the bundle is too large.' };
      for (const [name, item] of entries) {
        if (name.length > LIMITS.text)
          return { ok: false, message: 'A key in the bundle is too long.' };
        stack.push({ value: item, key: name, depth: depth + 1 });
      }
      continue;
    }
    return { ok: false, message: 'The bundle holds a value that is not JSON.' };
  }
  return { ok: true, bundle: v as ReviewBundle };
}
