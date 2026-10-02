// An in-memory LRU cache (ADR 0014 decision 9: the first toolpath cache lives in memory in the CAM
// worker). Bounded by entry count and by size; the least recently used entries go first. Any entry
// may be dropped at any time, and a miss only ever means regenerating, so callers never depend on
// what is in it. An OPFS tier would sit behind the same `get`/`set`, after the regen cache's
// `FeatureCache` shape.

export interface LruOptions<V> {
  /** Most entries kept; default 512. */
  maxEntries?: number;
  /** Largest total size kept, in the units of `sizeOf`; default 256 MiB. */
  maxSize?: number;
  /** The size of a value; default 1 each. A value larger than `maxSize` is never stored. */
  sizeOf?: (value: V) => number;
}

export class LruCache<V> {
  readonly maxEntries: number;
  readonly maxSize: number;
  private readonly sizeOf: (value: V) => number;
  /** In use order: the first key is the least recently used (a `Map` keeps insertion order). */
  private readonly entries = new Map<string, { value: V; size: number }>();
  private total = 0;
  private hitCount = 0;
  private missCount = 0;

  constructor(options: LruOptions<V> = {}) {
    this.maxEntries = options.maxEntries ?? 512;
    this.maxSize = options.maxSize ?? 256 * 1024 * 1024;
    this.sizeOf = options.sizeOf ?? (() => 1);
  }

  /** The value under `key`, now the most recently used; undefined on a miss. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.missCount++;
      return undefined;
    }
    this.hitCount++;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Whether `key` is cached, without touching its place in the order or the counts. */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** The value without touching its place in the order or the counts. */
  peek(key: string): V | undefined {
    return this.entries.get(key)?.value;
  }

  /** Store `value` as the most recently used, evicting the least recently used to make room. */
  set(key: string, value: V): void {
    this.delete(key);
    const size = this.sizeOf(value);
    if (size > this.maxSize || this.maxEntries < 1) return;
    this.entries.set(key, { value, size });
    this.total += size;
    for (const [oldest, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.total <= this.maxSize) break;
      this.entries.delete(oldest);
      this.total -= entry.size;
    }
  }

  delete(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.total -= entry.size;
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.total = 0;
  }

  /** Number of entries. */
  get size(): number {
    return this.entries.size;
  }

  /** Total size of the entries, in the units of `sizeOf`. */
  get totalSize(): number {
    return this.total;
  }

  /** Hits and misses of `get` since the cache was made. */
  get hits(): number {
    return this.hitCount;
  }

  get misses(): number {
    return this.missCount;
  }

  /** Keys from least to most recently used. */
  keys(): string[] {
    return [...this.entries.keys()];
  }
}
