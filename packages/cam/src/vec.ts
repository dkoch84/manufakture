// Small vector helpers, internal to the package.

import type { Vec3 } from './types';

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** `a` scaled to unit length, or undefined for a zero or non-finite vector. */
export function normalize(a: Vec3): Vec3 | undefined {
  const l = length(a);
  if (!(l > 0) || !Number.isFinite(l)) return undefined;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function isFiniteVec(a: readonly number[]): boolean {
  return a.every((v) => Number.isFinite(v));
}
