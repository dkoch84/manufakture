// Output size bounds (the security review's "output size"): every tool result's JSON is held
// under a byte limit. When a result is larger, its biggest list is halved, or, when strings are
// the biggest things in it, every string over the length that makes the result fit is cut to it
// in one pass; again until it fits. Each cut is reported as data, by JSON Pointer, with how much
// was kept. The result is serialized once at the start and once at the end: the bytes each cut
// saves are counted from the piece it cut. Images have limits of their own (render.ts).

/** One cut made to fit the limit. */
export interface Truncation {
  /** JSON Pointer to the list or string that was cut ('' for the whole value). */
  path: string;
  /** Items (or characters) kept. */
  kept: number;
  /** Items (or characters) there were. */
  total: number;
}

export interface Bounded {
  value: unknown;
  /** UTF-8 bytes of `JSON.stringify(value)`. */
  bytes: number;
  /** The cuts made, or empty when the value fit. */
  truncated: Truncation[];
}

/** Cut steps at most, before the value is dropped as a whole. */
const MAX_CUTS = 200;
/** Strings this long or shorter are never cut. */
const MIN_STRING = 64;
/** A cut string keeps at least this many characters. */
const STRING_FLOOR = 32;

const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8');
const jsonBytes = (v: unknown): number => bytesOf(JSON.stringify(v ?? null));

type Holder = unknown[] | Record<string, unknown>;

interface Candidate {
  holder: Holder;
  key: number | string;
  path: string;
  /** Approximate serialized size (characters). */
  size: number;
}

const pointer = (parent: string, key: string | number): string =>
  `${parent}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

const get = (c: Candidate): unknown => (c.holder as Record<string | number, unknown>)[c.key];
const set = (c: Candidate, v: unknown): void => {
  (c.holder as Record<string | number, unknown>)[c.key] = v;
};

/**
 * One walk over `root`: its largest non-empty list (by serialized size) and every string longer
 * than `MIN_STRING`. A JSON value from `JSON.parse`, so plain arrays, objects and primitives
 * only, at most a few hundred deep (the session's inputs are 100 deep at most; its outputs are
 * flatter).
 */
function survey(root: { v: unknown }): { list: Candidate | null; strings: Candidate[] } {
  let list = null as Candidate | null;
  const strings: Candidate[] = [];
  const size = (holder: Holder, key: number | string, path: string): number => {
    const v = (holder as Record<string | number, unknown>)[key];
    let n: number;
    if (Array.isArray(v)) {
      n = 2;
      v.forEach((_, i) => {
        n += size(v, i, pointer(path, i)) + 1;
      });
      if (v.length > 0 && (list === null || n > list.size)) list = { holder, key, path, size: n };
    } else if (v !== null && typeof v === 'object') {
      n = 2;
      for (const k of Object.keys(v)) {
        n += size(v as Record<string, unknown>, k, pointer(path, k)) + k.length + 4;
      }
    } else {
      n = JSON.stringify(v ?? null).length;
      if (typeof v === 'string' && v.length > MIN_STRING)
        strings.push({ holder, key, path, size: n });
    }
    return n;
  };
  size(root as unknown as Record<string, unknown>, 'v', '');
  return { list, strings };
}

/** `s` cut to at most `n` characters, never between the halves of a surrogate pair. */
function cut(s: string, n: number): string {
  if (s.length <= n) return s;
  const code = s.charCodeAt(n - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

/** Bytes saved by cutting every string of `strings` to `cap` characters. */
function savings(strings: readonly { text: string; bytes: number }[], cap: number): number {
  let saved = 0;
  for (const s of strings) if (s.text.length > cap) saved += s.bytes - jsonBytes(cut(s.text, cap));
  return saved;
}

/**
 * `value` held under `maxBytes` of JSON. A list keeps its first half on each cut; strings keep
 * their start. A value that still does not fit after `MAX_CUTS` steps is dropped (null).
 */
export function boundJson(value: unknown, maxBytes: number): Bounded {
  const text = JSON.stringify(value ?? null);
  const bytes = bytesOf(text);
  if (bytes <= maxBytes) return { value, bytes, truncated: [] };
  const root = { v: JSON.parse(text) as unknown };
  const cuts = new Map<string, Truncation>();
  const record = (path: string, kept: number, length: number) =>
    cuts.set(path, { path, kept, total: cuts.get(path)?.total ?? length });
  let now = bytes;
  for (let i = 0; i < MAX_CUTS && now > maxBytes; i++) {
    const { list, strings } = survey(root);
    const longest = strings.reduce((m, c) => Math.max(m, c.size), 0);
    if (list !== null && list.size >= longest) {
      const c = list as Candidate;
      const v = get(c) as unknown[];
      const kept = Math.floor(v.length / 2);
      const rest = v.slice(0, kept);
      now -= jsonBytes(v) - jsonBytes(rest);
      set(c, rest);
      record(c.path, kept, v.length);
      continue;
    }
    if (strings.length === 0) break;
    // Every string over the cap is cut to it, in one pass: the largest cap that saves enough,
    // but no lower than the largest list (which is cut next, if it is still needed).
    const texts = strings.map((c) => {
      const t = get(c) as string;
      return { text: t, bytes: jsonBytes(t) };
    });
    const excess = now - maxBytes;
    const longestText = texts.reduce((m, t) => Math.max(m, t.text.length), 0);
    const floor = Math.max(STRING_FLOOR, list === null ? 0 : Math.min(list.size, longestText - 1));
    let lo = floor;
    let hi = longestText - 1;
    if (savings(texts, lo) < excess) {
      hi = lo;
    } else {
      // The largest cap in [lo, hi] whose savings reach the excess.
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (savings(texts, mid) >= excess) lo = mid;
        else hi = mid - 1;
      }
    }
    const cap = Math.max(STRING_FLOOR, hi);
    let changed = false;
    strings.forEach((c, j) => {
      const t = texts[j]!;
      if (t.text.length <= cap) return;
      const short = cut(t.text, cap);
      now -= t.bytes - jsonBytes(short);
      set(c, short);
      record(c.path, short.length, t.text.length);
      changed = true;
    });
    if (!changed) break;
  }
  if (now <= maxBytes) {
    // The count is exact; serialize once more to be sure of it.
    const final = bytesOf(JSON.stringify(root.v));
    if (final <= maxBytes) return { value: root.v, bytes: final, truncated: [...cuts.values()] };
  }
  return { value: null, bytes: 4, truncated: [{ path: '', kept: 0, total: bytes }] };
}
