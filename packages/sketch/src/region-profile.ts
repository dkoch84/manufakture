// A region as the kernel's `profile` input: plain data shaped like the
// kernel's `Frame` and `ProfileLoop` (packages/kernel/src/types.ts), so this
// package does not depend on the kernel. Every entity carries its edge id, which
// the kernel's extrude reports back in `sideIds`, so the side faces can be
// named `<feature>:side:<edgeId>` (T0.5).

import type { Vec2, Vec3 } from './model';
import type { SketchPlacement } from './placement';
import type { Region, RegionCurve, RegionLoop } from './regions';

export type RegionProfileEntity =
  | { kind: 'line'; id: string; start: Vec2; end: Vec2 }
  | { kind: 'arc'; id: string; center: Vec2; start: Vec2; end: Vec2; clockwise: boolean }
  | { kind: 'circle'; id: string; center: Vec2; radius: number }
  /** 3 (quadratic) or 4 (cubic) control points: the kernel's Bezier profile entity (T3.2a). */
  | { kind: 'bezier'; id: string; points: Vec2[] };

export interface RegionProfileLoop {
  entities: RegionProfileEntity[];
}

export interface RegionProfileEdge {
  /** The sketch entity the edge lies on. */
  entityId: string;
  /** The edge id is positional (`<id>#<k>`), so names built on it are fragile. */
  fragile: boolean;
}

export interface RegionProfile {
  /** The kernel's `Frame`: the sketch placement. */
  frame: { origin: Vec3; xDir: Vec3; normal: Vec3 };
  /** Outer loop first, then the holes: the kernel's `profile` loops. */
  loops: RegionProfileLoop[];
  /** Per edge id in `loops`: where it comes from. */
  edges: Record<string, RegionProfileEdge>;
}

function entityOf(c: RegionCurve): RegionProfileEntity {
  switch (c.kind) {
    case 'line':
      return { kind: 'line', id: c.edgeId, start: c.start, end: c.end };
    case 'arc':
      return {
        kind: 'arc',
        id: c.edgeId,
        center: c.center,
        start: c.start,
        end: c.end,
        clockwise: c.reversed,
      };
    case 'circle':
      return { kind: 'circle', id: c.edgeId, center: c.center, radius: c.radius };
    case 'bezier':
      return { kind: 'bezier', id: c.edgeId, points: [...c.points] };
  }
}

/** The kernel `profile` input for a region on a sketch placement, with its edge ids. */
export function regionProfile(region: Region, placement: SketchPlacement): RegionProfile {
  const edges: Record<string, RegionProfileEdge> = {};
  const loop = (l: RegionLoop): RegionProfileLoop => ({
    entities: l.curves.map((c) => {
      edges[c.edgeId] = { entityId: c.entityId, fragile: c.fragile };
      return entityOf(c);
    }),
  });
  return {
    frame: { origin: placement.origin, xDir: placement.xDir, normal: placement.normal },
    loops: [loop(region.outer), ...region.holes.map(loop)],
    edges,
  };
}
