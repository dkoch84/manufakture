// Builders for feature tests: sketch profiles with edge ids, and a helper
// that applies features and checks they succeeded. Test support only.

import { expect } from 'vitest';
import {
  applyFeature,
  type FeatureInput,
  type FeatureOutcome,
  type SketchProfile,
} from '../features';
import type { Kernel } from '../kernel';
import type { Names } from '../naming';
import type { Frame, ProfileEntity, ShapeId, Topology, Vec2, Vec3 } from '../types';

export const XY: Frame = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };

/** The XY plane lifted to height z. */
export const atZ = (z: number): Frame => ({ ...XY, origin: [0, 0, z] });

/** A closed polygon, edge i (point i to i + 1) tagged `ids[i]`. */
export function polygon(points: readonly Vec2[], ids: readonly string[]): ProfileEntity[] {
  return points.map((start, i) => ({
    kind: 'line' as const,
    id: ids[i]!,
    start,
    end: points[(i + 1) % points.length]!,
  }));
}

export function rectangle(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  ids: readonly string[] = ['e1', 'e2', 'e3', 'e4'],
): ProfileEntity[] {
  return polygon(
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
    ids,
  );
}

export function circle(center: Vec2, radius: number, id = 'c1'): ProfileEntity[] {
  return [{ kind: 'circle', id, center, radius }];
}

/** A profile: the first loop is the outline, the rest holes. */
export function profile(frame: Frame, ...loops: ProfileEntity[][]): SketchProfile {
  return { frame, loops: loops.map((entities) => ({ entities })) };
}

/** A body with its names, as the feature operations leave it. */
export interface NamedBody {
  shape: ShapeId;
  names: Names;
  topology: Topology;
}

/** Apply features in order, requiring each to succeed; returns the last outcome's body. */
export function build(k: Kernel, features: readonly FeatureInput[], from: ShapeId | null = null) {
  let body = from;
  const outcomes: FeatureOutcome[] = [];
  for (const f of features) {
    const out = applyFeature(k, body, f);
    expect(out.errors, `${f.id} failed`).toEqual([]);
    expect(out.ok).toBe(true);
    outcomes.push(out);
    body = out.shape;
  }
  return { shape: body!, outcomes, last: outcomes.at(-1)! };
}

/** Apply features in order, letting failures pass through like the regen engine would. */
export function regen(k: Kernel, features: readonly FeatureInput[]) {
  let body: ShapeId | null = null;
  const outcomes: FeatureOutcome[] = [];
  for (const f of features) {
    const out = applyFeature(k, body, f);
    outcomes.push(out);
    body = out.shape;
  }
  const named = body === null ? null : k.named(body);
  return {
    shape: body,
    outcomes,
    body: named && body !== null ? { shape: body, ...named } : null,
    errors: outcomes.flatMap((o) => o.errors),
    warnings: outcomes.flatMap((o) => o.warnings),
    resolved: outcomes.flatMap((o) => o.resolved),
  };
}

export function named(k: Kernel, shape: ShapeId): NamedBody {
  const n = k.named(shape);
  expect(n, `shape ${shape} has names`).not.toBeNull();
  return { shape, ...n! };
}

export function faceNames(body: NamedBody): string[] {
  return body.names.faces.map((f) => f.name);
}

export function edgeNames(body: NamedBody): string[] {
  return body.names.edges.map((e) => e.name);
}

export function faceIndex(body: NamedBody, name: string): number {
  const i = body.names.faces.findIndex((f) => f.name === name);
  expect(i, `face ${name} in ${faceNames(body).join(', ')}`).toBeGreaterThanOrEqual(0);
  return i + 1;
}

export function near(a: Vec3, b: Vec3, tol = 1e-6): boolean {
  return a.every((v, i) => Math.abs(v - b[i]!) <= tol);
}

export function edgeAt(body: NamedBody, midpoint: Vec3, tol = 1e-6): number {
  const found = body.topology.edges.filter((e) => near(e.midpoint, midpoint, tol));
  expect(found, `edge at ${midpoint.join(',')}`).toHaveLength(1);
  return found[0]!.index;
}

/** Names of the faces sharing an edge with face `index`. */
export function neighbours(body: NamedBody, index: number): string[] {
  const out = new Set<string>();
  for (const e of body.topology.edges) {
    if (!e.faces.includes(index)) continue;
    for (const f of e.faces) if (f !== index) out.add(body.names.faces[f - 1]!.name);
  }
  return [...out].sort();
}

/** Volume, face count and bounding box of a shape, checked against expected values. */
export function expectGolden(
  k: Kernel,
  shape: ShapeId,
  expected: {
    volume: number;
    faces: number;
    min: Vec3;
    max: Vec3;
    volumeTol?: number;
    /** Bounding box tolerance, mm (default 1e-4). */
    boxTol?: number;
  },
): void {
  const p = k.properties(shape);
  expect(p.valid, 'BRepCheck_Analyzer').toBe(true);
  const tol = expected.volumeTol ?? 1e-6 * Math.max(1, Math.abs(expected.volume));
  expect(
    Math.abs(p.volume - expected.volume),
    `volume ${p.volume} vs ${expected.volume}`,
  ).toBeLessThanOrEqual(tol);
  expect(p.faces).toBe(expected.faces);
  // OCCT enlarges boxes by the shape tolerance (1e-7) and curved faces by more.
  const boxTol = expected.boxTol ?? 1e-4;
  const box = p.boundingBox!;
  expect(near(box.min, expected.min, boxTol), `min ${box.min.join(',')}`).toBe(true);
  expect(near(box.max, expected.max, boxTol), `max ${box.max.join(',')}`).toBe(true);
}
