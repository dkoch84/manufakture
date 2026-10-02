// The shapes of the tool library, the feed presets and the machine profiles (T5.1d). Plain data:
// every number that comes from the outside world carries where it comes from (`source`) and
// whether it was checked against that source (`verified`), like the kernel's `HOLE_SIZES`.
//
// Library data keeps each number in the unit its source states (`unit: 'in'` for Carbide 3D's
// inch tools and charts), so nothing is rounded on the way in; `toMm` and the resolved forms in
// `feeds.ts` give internal units. Angles in library data are degrees (`angleDeg`), as catalogues
// print them.

import type { DialSetting } from '../post/writer';
import type { ToolKind } from '../types';

/** The unit a library entry's lengths (and feeds, per minute) are written in. */
export type LibraryUnit = 'mm' | 'in';

/** A number (or other value) from outside, with where it comes from and whether it was checked. */
export interface Sourced<T> {
  readonly value: T;
  /** The URL and the figure as the source prints it. */
  readonly source: string;
  /** True when the value was read from `source` on implementation and matches it. */
  readonly verified: boolean;
  readonly note?: string;
}

// ---------------------------------------------------------------------------------------------
// Feed presets

/**
 * A feed category: what a stock is cut as (`plywood`, `hardwood`). A stock's `material` and a
 * preset's `material` in a document name one of these (a CAM table id).
 */
export interface FeedCategory {
  readonly id: string;
  readonly name: string;
  /** Shown with every preset of this category, when cutting it needs care. */
  readonly warning?: string;
}

/** Which of a preset's numbers were read from its source (not derived or a default). */
export interface PresetVerified {
  /** `rpm`, `feed` and `plunge`. */
  readonly feeds: boolean;
  readonly stepdown: boolean;
  readonly stepover: boolean;
}

/**
 * Feeds and speeds for one tool in one feed category, in `unit` (feeds in `unit` per minute).
 * A starting point, not a promise: tables disagree, and stock, machine and tool condition vary.
 */
export interface LibraryPreset {
  readonly category: string;
  readonly unit: LibraryUnit;
  readonly rpm: number;
  /** Cutting feed, `unit` per minute. */
  readonly feed: number;
  /** Plunge feed, `unit` per minute. */
  readonly plunge: number;
  /** Depth per pass, `unit`. For a drill, the peck depth. */
  readonly stepdown: number;
  /** Fraction of the tool diameter, greater than 0 and at most 1. */
  readonly stepover: number;
  readonly source: string;
  readonly verified: PresetVerified;
  readonly note?: string;
}

// ---------------------------------------------------------------------------------------------
// Tools

/** A maker's catalogue entry: Carbide 3D #201. */
export interface ToolVendor {
  readonly maker: string;
  /** The catalogue number; also the tool number a post writes. */
  readonly number: number;
  /** The maker's product page. */
  readonly url: string;
}

/**
 * A tool in a library. Lengths in `unit`; `angleDeg` in degrees (a V-bit's included angle, a
 * drill's point angle). Kind rules as a document's `CamTool`: `cornerRadius` for a bull nose
 * only (and required there), `angleDeg` required by a V-bit and allowed on a drill,
 * `tipDiameter` a V-bit's only.
 */
export interface LibraryTool {
  /** A CAM table id, unique in its library: `c3d-201`, `flat-3mm-2f`. */
  readonly id: string;
  readonly name: string;
  readonly kind: ToolKind;
  readonly vendor?: ToolVendor;
  readonly unit: LibraryUnit;
  readonly diameter: number;
  readonly fluteLength: number;
  readonly flutes: number;
  readonly shankDiameter?: number;
  readonly cornerRadius?: number;
  readonly angleDeg?: number;
  readonly tipDiameter?: number;
  /** Where the geometry comes from. */
  readonly source: string;
  /** True when the geometry was read from `source` on implementation. */
  readonly verified: boolean;
  readonly note?: string;
  /** At most one per feed category. */
  readonly presets: readonly LibraryPreset[];
}

/** A tool library as stored and exchanged as JSON. */
export interface ToolLibraryFile {
  readonly format: typeof TOOL_LIBRARY_FORMAT;
  readonly version: typeof TOOL_LIBRARY_VERSION;
  readonly tools: readonly LibraryTool[];
}

export const TOOL_LIBRARY_FORMAT = 'manufakture-tool-library';
export const TOOL_LIBRARY_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Machines

export type SpindleKind = 'router' | 'vfd';

/**
 * A spindle: a trim router whose speed is set by hand on a dial, or a VFD spindle whose speed the
 * G-code sets.
 */
export interface SpindleProfile {
  readonly id: string;
  readonly name: string;
  readonly kind: SpindleKind;
  /** The speed range, rpm, as the maker states it. */
  readonly rpmRange: Sourced<readonly [number, number]>;
  /** The dial's settings and their speeds; a router's only. */
  readonly dial?: Sourced<readonly DialSetting[]>;
  readonly url: string;
}

/** The firmware a machine's controller runs, as far as the posts care. */
export type MachineFirmware = 'grbl-1.1' | 'grblhal';

/**
 * A machine: its travel (machine XYZ, mm), the fastest feed and rapid it runs (mm/min), its
 * spindle, controller firmware, sender and the posts that suit it.
 */
export interface MachineProfile {
  /** A CAM table id: `shapeoko-5-pro-4x4`. */
  readonly id: string;
  readonly name: string;
  readonly maker: string;
  /** The machines the user cuts on, listed first in pickers. */
  readonly primary: boolean;
  readonly url: string;
  readonly travel: {
    readonly x: Sourced<number>;
    readonly y: Sourced<number>;
    readonly z: Sourced<number>;
  };
  /** The fastest cutting feed in X and Y, mm/min. */
  readonly maxFeed: Sourced<number>;
  /** The rapid rate the time estimate uses, mm/min. */
  readonly maxRapid: Sourced<number>;
  /** The spindle in the machine's default configuration (a `SPINDLES` id). */
  readonly spindle: Sourced<string>;
  /** Every spindle the maker offers for it, the default first. */
  readonly spindleOptions: readonly string[];
  readonly firmware: Sourced<MachineFirmware>;
  /** The sender the maker ships (`carbide-motion`). */
  readonly sender: Sourced<string>;
  /** Whether a tool length sensor (Carbide 3D's BitSetter) is standard. */
  readonly toolLengthSensor: Sourced<boolean>;
  /** Post ids that suit it, preferred first; the first is the default post. */
  readonly posts: readonly string[];
}
