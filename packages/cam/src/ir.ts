// The toolpath intermediate representation (IR): what operations and linking produce and what
// the post-processor, the preview and the simulation read (M5 plan, T5.1c; ADR 0014 decisions 10
// and 12). Machine coordinates (the setup's WCS), millimetres, mm/min, rpm. Arcs lie in the XY
// plane (G17), with an optional helical change in Z.

import type { Vec2, Vec3 } from './types';

/** Why a feed move is fed the way it is: picks the feed from the operation's `Feeds`. */
export type FeedClass = 'cut' | 'plunge' | 'ramp' | 'lead';

export const FEED_CLASSES: readonly FeedClass[] = ['cut', 'plunge', 'ramp', 'lead'];

/** What every move carries: which operation and which pass produced it. */
export interface MoveTag {
  /** The operation id (`profile#2`), or a linking id such as `link` for moves between them. */
  readonly op: string;
  /** Pass number within the operation, from 0 (a depth step, a pocket ring, a peck, ...). */
  readonly pass: number;
}

/** A rapid (G0) straight to `to`. Never cuts material on purpose. */
export interface RapidMove extends MoveTag {
  readonly kind: 'rapid';
  readonly to: Vec3;
}

/** A feed move (G1) straight to `to`. */
export interface LinearMove extends MoveTag {
  readonly kind: 'linear';
  readonly to: Vec3;
  /** mm/min, greater than zero. */
  readonly feed: number;
  readonly feedClass: FeedClass;
}

/**
 * A circular arc (G2 clockwise, G3 counter-clockwise, seen from +Z) in the XY plane from the
 * current position to `to`, about `center` (absolute machine XY, not IJ offsets). When `to[2]`
 * differs from the start's Z the arc is a helix: Z changes linearly with the angle.
 *
 * The sweep runs from the start's angle to the end's angle in `direction`, in (0, 2 pi). Start and
 * end coinciding in XY means a full circle only when `fullCircle` is true; otherwise it is an
 * error (ADR 0014 decisions 10 and 12: a tiny arc must never become a full turn). One IR arc is at
 * most one full turn; a helical bore of n turns is n arcs.
 */
export interface ArcMove extends MoveTag {
  readonly kind: 'arc';
  readonly to: Vec3;
  readonly center: Vec2;
  readonly direction: 'cw' | 'ccw';
  /** True for an intended full circle (a helical bore turn, a circular pocket ring). */
  readonly fullCircle: boolean;
  readonly feed: number;
  readonly feedClass: FeedClass;
}

export type Move = RapidMove | LinearMove | ArcMove;

/** Pause in place (G4). */
export interface Dwell {
  readonly kind: 'dwell';
  /** Seconds, zero or more. */
  readonly seconds: number;
  readonly op?: string;
}

/** Change to another tool. The spindle must be off (a `spindle` off entry before it). */
export interface ToolChange {
  readonly kind: 'toolChange';
  /** The tool's document id, `tool#n`. */
  readonly tool: string;
  /** The tool number a post writes with `T`. */
  readonly number?: number;
  /** For comments and the operator prompt. */
  readonly name: string;
  /** Cutting diameter, mm, for the post's tool comments (`{tool_diameter}`). */
  readonly diameter?: number;
  readonly op?: string;
}

/** Start, change or stop the spindle (M3, M4, M5 with S). */
export type Spindle =
  | {
      readonly kind: 'spindle';
      readonly state: 'cw' | 'ccw';
      /** rpm, greater than zero. */
      readonly rpm: number;
      readonly op?: string;
    }
  | { readonly kind: 'spindle'; readonly state: 'off'; readonly op?: string };

/** A comment for the operator or the setup sheet. Posts sanitise it (ADR 0014 decision 10). */
export interface Comment {
  readonly kind: 'comment';
  readonly text: string;
  readonly op?: string;
}

export type IrEntry = Move | Dwell | ToolChange | Spindle | Comment;

/** A program: entries in order, from a known start position. */
export interface Toolpath {
  /** Machine position before the first entry (where linking assumes the tool is). */
  readonly start: Vec3;
  readonly entries: readonly IrEntry[];
}

export function isMove(entry: IrEntry): entry is Move {
  return entry.kind === 'rapid' || entry.kind === 'linear' || entry.kind === 'arc';
}

/** A feed move: anything that may touch material. */
export function isFeedMove(entry: IrEntry): entry is LinearMove | ArcMove {
  return entry.kind === 'linear' || entry.kind === 'arc';
}
