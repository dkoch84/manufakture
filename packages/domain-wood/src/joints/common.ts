// What every joint kind returns, and the small helpers they share: a refusal carrying the field at
// fault, and readers of the evaluated expressions with their defaults and limits.

import type { ToolItem } from '@manufakture/kernel';
import type { Path } from '../read';
import { mm } from './geometry';

/** Hardware a joint uses, for the bill of materials (T4.3a). Lengths in mm. */
export type JointHardware =
  /** Wooden dowels: `length` is the two holes' depths together (pick dowels a little shorter). */
  | { item: 'dowel'; diameter: number; length: number; quantity: number }
  /** Pocket screws, by length (bottom of the head to the tip); the screw is not modelled. */
  | { item: 'pocket-screw'; length: number; quantity: number };

/**
 * A warning a joint reports. `rule-of-thumb`: the joint weakens a board below a common
 * woodworking rule of thumb (a dado deeper than half the board's thickness). Not engineering.
 */
export interface JointWarning {
  code: 'rule-of-thumb';
  message: string;
}

/** A joint kind's result: the tools, in order, and what the joint reports. */
export interface Built {
  items: ToolItem[];
  hardware: JointHardware[];
  warnings: JointWarning[];
  /** The joint's measured sizes (mm, radians or counts), for the dialog's preview. */
  details: Record<string, number>;
}

/** A joint that cannot be built: thrown by the kinds, caught by the translator. */
export class Refusal extends Error {
  constructor(
    message: string,
    readonly field: Path,
  ) {
    super(message);
  }
}

export function refuse(message: string, field: Path): never {
  throw new Refusal(message, field);
}

/** The joint's evaluated expressions, read with defaults and limits. */
export class Values {
  constructor(private readonly values: Readonly<Record<string, number>>) {}

  has(name: string): boolean {
    return Object.hasOwn(this.values, name);
  }

  /** A length above zero; `fallback` when the joint has no such expression. */
  positive(name: string, fallback: number): number;
  positive(name: string, fallback?: number): number | undefined;
  positive(name: string, fallback?: number): number | undefined {
    if (!this.has(name)) return fallback;
    const v = this.values[name]!;
    if (!(v > 0) || !Number.isFinite(v)) refuse(`the ${label(name)} must be above zero`, at(name));
    return v;
  }

  /** A length of zero or more. */
  nonNegative(name: string, fallback: number): number {
    if (!this.has(name)) return fallback;
    const v = this.values[name]!;
    if (!(v >= 0) || !Number.isFinite(v)) {
      refuse(`the ${label(name)} must be zero or more`, at(name));
    }
    return v;
  }

  /** Any finite number (an offset). */
  any(name: string, fallback: number): number {
    if (!this.has(name)) return fallback;
    const v = this.values[name]!;
    if (!Number.isFinite(v)) refuse(`the ${label(name)} is not a number`, at(name));
    return v;
  }

  /** A whole number from `min`. */
  count(name: string, min: number, max: number): number | undefined {
    if (!this.has(name)) return undefined;
    const v = this.values[name]!;
    if (!Number.isInteger(v) || v < min || v > max) {
      refuse(`the ${label(name)} must be a whole number from ${min} to ${max}`, at(name));
    }
    return v;
  }

  /** Refuse giving both of two expressions that say the same thing. */
  oneOf(x: string, y: string): void {
    if (this.has(x) && this.has(y)) {
      refuse(`give the ${label(x)} or the ${label(y)}, not both`, at(y));
    }
  }
}

const LABELS: Readonly<Record<string, string>> = {
  depthA: 'depth into A',
  depthB: 'depth into B',
  edge: 'edge distance',
  finger: 'finger width',
  screw: 'screw length',
};

export function label(name: string): string {
  return LABELS[name] ?? name;
}

export function at(name: string): Path {
  return ['expressions', name];
}

/** The rule-of-thumb warning for a groove or a housing deeper than half the board. */
export function tooDeep(what: string, depth: number, board: string, axis: string, size: number) {
  return {
    code: 'rule-of-thumb' as const,
    message: `Rule of thumb, not engineering: the ${what} is ${mm(depth)} deep, more than half of ${board}'s ${mm(size)} ${axis}, which weakens it`,
  };
}
