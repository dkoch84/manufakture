// Flattening lines and arcs into Clipper2's scaled integer paths, with a Z tag on every vertex
// (T5.0a spike, recommendation 4). Tag n (from 1, since Clipper treats Z = 0 as "no tag") names
// `table.vertices[n - 1]`: its point and the source segments it lies on. The refit reads the tags
// of the offset's output to rebuild exact arcs.

import type { Point64 } from 'clipper2-ts';
import type { Segment2, Vec2 } from '../types';
import { arcRadius, dist, segmentTangent, signedSweep } from './geometry';
import {
  CLIPPER_SCALE,
  CONTINUITY_TOLERANCE,
  FLATTEN_TOLERANCE,
  MAX_COORD_MM,
  TANGENT_ANGLE,
} from './tolerances';

const TAU = 2 * Math.PI;

/** One flattened source vertex, named by its Z tag. */
export interface TagVertex {
  readonly point: Vec2;
  /** Indices into `TagTable.segments`: one, or two where one segment ends and the next starts. */
  readonly segments: readonly number[];
  /**
   * A sharp junction (not tangent), or an end of an open path: the offset puts a round join (or
   * cap) of radius |delta| about this point.
   */
  readonly corner: boolean;
  /** The first or last vertex of an open path. */
  readonly end: boolean;
}

/** The source of every Z tag in one Clipper call: subject and clip paths share one table. */
export class TagTable {
  readonly vertices: TagVertex[] = [];
  readonly segments: Segment2[] = [];

  vertex(tag: number): TagVertex | undefined {
    return tag > 0 ? this.vertices[tag - 1] : undefined;
  }
}

/** Number of chords for an arc so the chord error is at most `tol` (vertices on the arc). */
export function arcChordCount(radius: number, sweep: number, tol: number): number {
  const step = 2 * Math.acos(Math.max(-1, 1 - tol / radius));
  const min = Math.abs(sweep) >= TAU - 1e-9 ? 8 : 1;
  return Math.max(min, Math.ceil(Math.abs(sweep) / step));
}

/**
 * Checks a chain of segments: finite coordinates within the adapter's range, each segment
 * starting where the previous one ends (and the last ending at the first's start when
 * `closed`), arcs with a radius, matching end radii and a sweep. Returns a message or undefined.
 */
export function checkSegments(segments: readonly Segment2[], closed: boolean): string | undefined {
  if (segments.length === 0) return 'a path has no segments';
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    const pts = s.kind === 'arc' ? [s.start, s.end, s.center] : [s.start, s.end];
    for (const p of pts) {
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
        return `segment ${i} has a coordinate that is not a finite number`;
      }
      if (Math.abs(p[0]) > MAX_COORD_MM || Math.abs(p[1]) > MAX_COORD_MM) {
        return `segment ${i} lies beyond ${MAX_COORD_MM} mm from the origin`;
      }
    }
    if (s.kind === 'arc') {
      const r = arcRadius(s);
      if (!(r > 0)) return `arc ${i} has a zero radius`;
      if (Math.abs(dist(s.end, s.center) - r) > CONTINUITY_TOLERANCE) {
        return `arc ${i} ends ${Math.abs(dist(s.end, s.center) - r)} mm off its circle`;
      }
      if (signedSweep(s) === 0) return `arc ${i} starts where it ends without being a full circle`;
    }
    const next = segments[i + 1] ?? (closed ? segments[0] : undefined);
    if (next && dist(s.end, next.start) > CONTINUITY_TOLERANCE) {
      return `segment ${i} ends ${dist(s.end, next.start)} mm from where the next one starts`;
    }
  }
  return undefined;
}

/** The points of a segment's flattening, its start included and its end excluded. */
function segmentVertices(s: Segment2, tol: number): Vec2[] {
  if (s.kind === 'line') return [s.start];
  const r = arcRadius(s);
  const sweep = signedSweep(s);
  const n = arcChordCount(r, sweep, tol);
  const a0 = Math.atan2(s.start[1] - s.center[1], s.start[0] - s.center[0]);
  const out: Vec2[] = [s.start];
  for (let k = 1; k < n; k++) {
    const a = a0 + (sweep * k) / n;
    out.push([s.center[0] + r * Math.cos(a), s.center[1] + r * Math.sin(a)]);
  }
  return out;
}

/**
 * A polyline of the segments in millimetres, arcs within chord error `tol` (vertices on the arc).
 * A closed chain does not repeat its first point; an open one ends at its last segment's end.
 */
export function flattenSegments(
  segments: readonly Segment2[],
  closed: boolean,
  tol = FLATTEN_TOLERANCE,
): Vec2[] {
  const out: Vec2[] = [];
  for (const s of segments) out.push(...segmentVertices(s, tol));
  if (!closed && segments.length > 0) out.push(segments[segments.length - 1]!.end);
  return out;
}

const isSharp = (a: Vec2, b: Vec2): boolean =>
  Math.abs(a[0] * b[1] - a[1] * b[0]) > Math.sin(TANGENT_ANGLE) || a[0] * b[0] + a[1] * b[1] < 0;

const toUnits = (v: number): number => Math.round(v * CLIPPER_SCALE);

/**
 * Flattens a chain (already checked with `checkSegments`) into a scaled, tagged `Path64`,
 * registering its segments and vertices in `table`.
 */
export function tagPath(
  table: TagTable,
  segments: readonly Segment2[],
  closed: boolean,
): Point64[] {
  const ids = segments.map((s) => table.segments.push(s) - 1);
  const path: Point64[] = [];
  const push = (point: Vec2, segs: number[], corner: boolean, end = false): void => {
    table.vertices.push({ point, segments: segs, corner, end });
    path.push({ x: toUnits(point[0]), y: toUnits(point[1]), z: table.vertices.length });
  };
  const n = segments.length;
  segments.forEach((s, i) => {
    const vertices = segmentVertices(s, FLATTEN_TOLERANCE);
    const prevIndex = i > 0 ? i - 1 : closed ? n - 1 : -1;
    vertices.forEach((p, k) => {
      if (k > 0) {
        push(p, [ids[i]!], false);
        return;
      }
      if (prevIndex < 0) {
        push(p, [ids[i]!], true, true); // the start of an open path: a cap
        return;
      }
      const prev = segments[prevIndex]!;
      const sharp = isSharp(segmentTangent(prev, 1), segmentTangent(s, 0));
      push(p, [ids[i]!, ids[prevIndex]!], sharp);
    });
  });
  if (!closed) push(segments[n - 1]!.end, [ids[n - 1]!], true, true);
  return path;
}
