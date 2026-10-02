// Oriented sizes of a part's bodies on request (M4 plan T4.3d): what the cut list reads for a
// body that is not a board (an extruded or imported panel given a wood material). The kernel's
// `obb` op (T4.3b) measures each body; the sizes are cached by body key, so a body that did not
// change is never measured twice. Never part of a regen: the cut list panel asks when it shows.

import type { ManufaktureDocument } from '@manufakture/core';
import type { OrientedBox } from '@manufakture/kernel';

export interface OrientedSizesOptions {
  /** The client's current generation (never a new one, M5 T5.1f's rule). Default: the newest seen. */
  generation?: number;
  /** As for `RegenOptions.stored`. */
  stored?: ManufaktureDocument;
  /** The bodies to measure; absent: every body of the part. */
  bodies?: readonly string[];
  /**
   * Extension types whose bodies are not measured (`wood.board`: a board's size is its blank,
   * from its own frame, never its box).
   */
  skipExtensions?: readonly string[];
}

/** One body's oriented box sizes, mm, longest first (`domain-wood`'s `OrientedSize`). */
export interface OrientedBodySize {
  bodyId: string;
  sizes: [number, number, number];
  /** `obb` for the oriented box, `aabb` when the axis-aligned box was tighter or the only one. */
  source: OrientedBox['source'];
}

export interface OrientedSizesResult {
  generation: number;
  partId: string;
  /** In the part's body order. */
  sizes: OrientedBodySize[];
  /** Asked-for bodies the part does not have (merged away, or never made). */
  missing: string[];
  /** Bodies the kernel could not measure. */
  failures: { bodyId: string; message: string }[];
}

/** Counters, for tests and the stats. */
export interface OrientedStats {
  /** `obb` ops sent. */
  obbOps: number;
  /** Bodies answered from the cache. */
  obbHits: number;
}

/** How many bodies' sizes the cache keeps. */
export const ORIENTED_CACHE_SIZE = 2048;

/** The sizes cache, by body key, oldest dropped first. */
export class OrientedCache {
  readonly #sizes = new Map<string, Omit<OrientedBodySize, 'bodyId'>>();
  readonly stats: OrientedStats = { obbOps: 0, obbHits: 0 };
  readonly #limit: number;

  constructor(limit = ORIENTED_CACHE_SIZE) {
    this.#limit = limit;
  }

  get(key: string): Omit<OrientedBodySize, 'bodyId'> | undefined {
    const hit = this.#sizes.get(key);
    if (hit !== undefined) {
      // Most recently used last.
      this.#sizes.delete(key);
      this.#sizes.set(key, hit);
    }
    return hit;
  }

  set(key: string, box: OrientedBox): Omit<OrientedBodySize, 'bodyId'> {
    const entry = { sizes: [...box.sizes] as [number, number, number], source: box.source };
    this.#sizes.set(key, entry);
    while (this.#sizes.size > this.#limit) this.#sizes.delete(this.#sizes.keys().next().value!);
    return entry;
  }

  get size(): number {
    return this.#sizes.size;
  }
}
