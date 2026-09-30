// The solver-neutral interface (ADR 0008 decision 2): plain data in, plain data out, so both
// cross a worker boundary and no solver type leaves the package.

import type { Pose, Vec3 } from './transform';

export type MateKind = 'fastened' | 'revolute' | 'slider' | 'planar' | 'cylindrical' | 'ball';

export interface InstanceInput {
  id: string;
  /** The last solved pose: the seed, and what chooses among solutions. */
  pose: Pose;
  /** A fixed instance never moves; fixed instances are the roots of the mate graph. */
  fixed?: boolean;
}

/** A mate connector: a frame in the instance's local coordinates. */
export interface ConnectorInput {
  instance: string;
  frame: Pose;
}

/** Revolute: radians; slider: millimetres. Either bound may be left out. */
export interface MateLimits {
  min?: number;
  max?: number;
}

export interface MateInput {
  id: string;
  kind: MateKind;
  a: ConnectorInput;
  b: ConnectorInput;
  /** A fixed transform after connector a, in a's frame, before the free coordinates. */
  offset?: Pose;
  /** Revolute and slider only. Clamp drags and tree solves; inside loops only a warning. */
  limits?: MateLimits;
  suppressed?: boolean;
}

/** Instances in any order; mates in creation order (the last is the newest). */
export interface AssemblyInput {
  instances: readonly InstanceInput[];
  mates: readonly MateInput[];
}

/**
 * What a drag aims at: a whole pose for the instance, or a point of the instance (in its local
 * coordinates) that should go to a world position (what a pointer drag gives).
 */
export type DragTarget = Pose | { point: Vec3; position: Vec3 };

// Report ---------------------------------------------------------------------

/**
 * `solved`: every mate is satisfied (redundant mates may still be listed).
 * `conflicting`: at least one loop of mates cannot close; see `conflicting`.
 * `invalid`: the input has issues; the offending instances or mates were left out and the
 * rest was solved.
 */
export type Outcome = 'solved' | 'conflicting' | 'invalid';

export type MateStatus = 'ok' | 'redundant' | 'conflicting' | 'invalid' | 'suppressed';

export interface Residual {
  /** Millimetres between the two connectors. */
  position: number;
  /** Radians between the two connectors' orientations. */
  angle: number;
}

export interface MateReport {
  status: MateStatus;
  /**
   * The mate's free coordinates: revolute [angle], slider [distance], planar [x, y, angle],
   * cylindrical [distance, angle], ball [rotation vector x, y, z], fastened [].
   */
  coordinates: number[];
  residual: Residual;
  message?: string;
}

/** Mates that together are redundant or contradict each other, in creation order. */
export interface MateGroup {
  mates: string[];
  /** The mate to remove or change: the newest in the group. */
  blame: string;
  message: string;
}

export type IssueCode =
  | 'duplicate-id'
  | 'invalid-pose'
  | 'unknown-instance'
  | 'self-mate'
  | 'unknown-kind'
  | 'invalid-limits';

export interface AssemblyIssue {
  code: IssueCode;
  message: string;
  instanceId?: string;
  mateId?: string;
}

export interface AssemblyWarning {
  code: 'outside-limits' | 'fixed-instance' | 'not-reached';
  message: string;
  instanceId?: string;
  mateId?: string;
}

export interface SolveReport {
  outcome: Outcome;
  /**
   * Per instance id, the solved pose. An instance that did not move gets its input pose back
   * unchanged (the same numbers), so callers can store only what changed.
   */
  poses: Record<string, Pose>;
  /**
   * Remaining degrees of freedom: 6 per instance group not attached to a fixed instance, plus
   * the free coordinates of every mate, minus the rank of the loop closures. `null` while
   * mates conflict (the count is undefined then).
   */
  dof: number | null;
  redundant: MateGroup[];
  conflicting: MateGroup[];
  /** Per mate id, in creation order. */
  mates: Record<string, MateReport>;
  issues: AssemblyIssue[];
  warnings: AssemblyWarning[];
  /** A readable summary for anything but a clean solve. */
  message?: string;
}

export interface DragReport extends SolveReport {
  /** How far the dragged instance ended from the target. */
  target: Residual & { reached: boolean };
}
