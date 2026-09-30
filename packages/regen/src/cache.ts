// The per-feature result cache (ADR 0004 decision 8). An entry is keyed by a hash of the
// feature's inputs (definition with evaluated parameters, resolved upstream data such as
// profiles and pattern sources), the keys of the bodies it reads (not of the whole body set), the
// kernel build, the naming scheme and the implementation version (`cacheKey`). Equal keys mean equal results, so
// an entry never needs invalidating by hand; a missing entry is always just a miss.
//
// Kernel results hold a shape id in the kernel arena, which is only valid in the kernel instance
// that made it and only until it is released. This in-memory cache is therefore the live tier.
// A persistent tier (OPFS, T1.12 #935) plugs in behind the same interface: its `get` may be
// async, and it stores what can outlive the instance (statuses, sketch results, and later a
// serialized B-rep to restore the body from). See the README.

import type { ShapeId } from '@manufakture/kernel';
import { hashValue } from './hash';
import type { SketchResult } from './sketches';
import type { ReferenceResolution, RegenError, RegenWarning } from './types';

/**
 * Bump with any change to regen or feature code that can change a feature's output, so results
 * computed by older code are never served (ADR 0004 decision 8).
 */
export const REGEN_IMPLEMENTATION_VERSION = 2;

/**
 * The kernel build the results come from. The kernel package does not export a build identity
 * yet, so this names the pinned libcascade release (packages/kernel/package.json).
 */
export const DEFAULT_KERNEL_BUILD = 'libcascade@3.0.2';

/**
 * The sketch solver build that solved sketches come from, part of every sketch key. The sketch
 * package does not export a version either, so this names the pinned planegcs release
 * (packages/sketch/package.json). A persistent tier must never serve a sketch another solver
 * solved.
 */
export const DEFAULT_SOLVER_BUILD = 'planegcs@1.2.0';

export interface KeyVersions {
  kernelBuild: string;
  namingScheme: number;
  implementation: number;
}

export function cacheKey(versions: KeyVersions, parts: Record<string, unknown>): string {
  return hashValue({ versions, ...parts });
}

/** A body a kernel feature made or gave a new shape. */
export interface CachedBody {
  id: string;
  shape: ShapeId;
  solids: number;
  /** Made by the feature (`created`), rather than an existing body it changed. */
  created: boolean;
}

/**
 * What a kernel feature did to the bodies it read: the bodies it made or changed, in the kernel's
 * order, and the ones it merged away. Every other body keeps its shape. Empty lists (and a null
 * instance) when the feature failed or changed nothing.
 */
export interface CachedOutcome {
  /** The kernel instance the shapes live in. */
  instance: number | null;
  bodies: CachedBody[];
  consumed: string[];
}
export interface CacheEntry {
  key: string;
  /** The feature it was built for (informational; keys do not depend on ids alone). */
  featureId: string;
  type: 'sketch' | 'body';
  ok: boolean;
  errors: RegenError[];
  warnings: RegenWarning[];
  references: ReferenceResolution[];
  /** Kernel features: what it did to the bodies it read. */
  outcome?: CachedOutcome;
  /** Sketches: the solved sketch. */
  sketch?: SketchResult;
  /** What building it cost, in milliseconds. */
  ms: number;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * Storage for cache entries. The engine owns shape lifetimes: entries a cache drops through
 * `retain` or `clear` are handed back so their shapes can be released.
 */
export interface FeatureCache {
  get(key: string): MaybePromise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): MaybePromise<void>;
  /**
   * After a completed regen: keep every entry in `used`, keep others at the cache's discretion,
   * and return the ones dropped.
   */
  retain(used: ReadonlySet<string>): MaybePromise<CacheEntry[]>;
  /** Forget every entry holding a shape of a kernel instance other than `instance` (gone after a recycle). */
  dropBodies(instance: number | null): MaybePromise<void>;
  /** Drop everything; returns the dropped entries. */
  clear(): MaybePromise<CacheEntry[]>;
}

export interface MemoryCacheOptions {
  /**
   * Entries kept beyond the ones the last regen used, least recently used out first. They make
   * undo and toggling back cheap, at the cost of keeping their bodies in the kernel heap.
   * Default 64.
   */
  spare?: number;
}

/** Whether an entry holds kernel shapes (a kernel feature that made or changed a body). */
export function holdsShapes(entry: CacheEntry): boolean {
  return entry.outcome !== undefined && entry.outcome.bodies.length > 0;
}

/** The in-memory cache: a map in least-recently-used order. */
export class MemoryCache implements FeatureCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #spare: number;

  constructor(options: MemoryCacheOptions = {}) {
    this.#spare = Math.max(0, options.spare ?? 64);
  }

  get size(): number {
    return this.#entries.size;
  }

  keys(): string[] {
    return [...this.#entries.keys()];
  }

  get(key: string): CacheEntry | undefined {
    const e = this.#entries.get(key);
    if (e) {
      // Most recently used last.
      this.#entries.delete(key);
      this.#entries.set(key, e);
    }
    return e;
  }

  set(key: string, entry: CacheEntry): void {
    this.#entries.delete(key);
    this.#entries.set(key, entry);
  }

  retain(used: ReadonlySet<string>): CacheEntry[] {
    let spare = [...this.#entries.keys()].filter((k) => !used.has(k)).length;
    const dropped: CacheEntry[] = [];
    for (const [k, e] of this.#entries) {
      if (spare <= this.#spare) break;
      if (used.has(k)) continue;
      this.#entries.delete(k);
      dropped.push(e);
      spare--;
    }
    return dropped;
  }

  dropBodies(instance: number | null): void {
    for (const [k, e] of this.#entries) {
      if (holdsShapes(e) && e.outcome!.instance !== instance) this.#entries.delete(k);
    }
  }

  clear(): CacheEntry[] {
    const all = [...this.#entries.values()];
    this.#entries.clear();
    return all;
  }
}
