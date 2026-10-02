// What the cut list is computed from (M4 plan T4.3a, ADR 0013 decision 8). Plain data, so the
// domain needs no kernel and no regen at run time: the app (T4.3d) fills it from regen's results
// (`cutListPart` does the mapping), and tests from fixtures.

import type { WoodSettings } from '../wood-data';
import type { StockData } from '../stock-data';

/** One body of a part after regen (regen's `BodyResult`, the fields the cut list reads). */
export interface CutListBody {
  bodyId: string;
  /** The feature that made it: a `wood.board` feature for a board. */
  creator: string;
  /** Display name: the body's own (`Part.bodies`), else its creating feature's. */
  name?: string;
  /** The body's own material (`Part.bodies`), when it sets one. */
  material?: string;
  /** Volume, mm³, when measured: shown for a body whose size is unknown. */
  volume?: number;
}

/** A feature's result (regen's `FeatureResult`, the fields the cut list reads). */
export interface CutListFeature {
  featureId: string;
  name?: string;
  /** What the translator reported: a board's frame, a joint's hardware. */
  metadata?: unknown;
}

/**
 * The oriented size of a body that is not a board, from the kernel's `obb` op (T4.3b, called by
 * the app in T4.3d): its box's three sizes in mm, in any order (sorted longest first here).
 */
export interface OrientedSize {
  bodyId: string;
  sizes: readonly [number, number, number];
}

/** One built part: a part studio, or one configuration of it. */
export interface CutListPart {
  /**
   * Which build this is: the part id, or a key of the part in a configuration row (`part#1@cfg#2`)
   * when an assembly's instances show it in one. Sources name it as their `part`.
   */
  id: string;
  name?: string;
  /** The part's material (`Part.material`): what a body that is not a board is made of. */
  material?: string;
  bodies: readonly CutListBody[];
  features: readonly CutListFeature[];
  orientedSizes?: readonly OrientedSize[];
}

/** One instance of an assembly (core's `Instance`, the fields the cut list reads). */
export interface CutListInstance {
  id: string;
  /** The `CutListPart.id` it shows. */
  part: string;
  /** The bodies it shows; absent: every body of the part (`Instance.bodies`). */
  bodies?: readonly string[];
  suppressed?: boolean;
}

export interface CutListInput {
  /** Every part build the list reads. */
  parts: readonly CutListPart[];
  /**
   * An assembly to count through: each instance counts the bodies it shows. Absent: a part studio
   * list, every body of every part once.
   */
  assembly?: { instances: readonly CutListInstance[] };
  /** The document's stock overrides (`domains.stock`); absent: the catalog as it is. */
  stock?: StockData;
  /** The woodworking settings (`domains.wood`), for the grain rule of sheet layouts. */
  settings?: Pick<WoodSettings, 'grain'>;
  /** The configuration row in force when the parts were built, echoed in the result. */
  configuration?: { id: string; name: string };
}
