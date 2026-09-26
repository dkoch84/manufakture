// Picking, minus the GPU. The engine renders a small window around the
// cursor into an offscreen target: every face, edge and vertex drawn with its
// own pick id (24-bit RGB), depth-tested against the faces exactly as on
// screen, so anything hidden behind the part leaves no pixel there. It also
// projects edge segments and vertices to the screen; everything after that is
// here, so it can be tested without WebGL.
//
// - Faces: the id under the cursor pixel.
// - Edges and vertices: the nearest within a tolerance in CSS pixels, but
//   only if the pick window shows a pixel of it within that tolerance. The
//   geometric distance ranks candidates; when only a farther part of an edge
//   is visible, the distance to its nearest visible pixel is used instead.
// - A vertex beats an edge, an edge beats a face, as in other CAD tools.
//
// The result is always a name, never an index (ADR 0007, decision 8).

import { UNNAMED } from '@manufakture/kernel';
import { geometryRef, type GeometryKind, type GeometryRef } from '../state/selection';
import type { ViewBody } from './bodies';
import { isPlaceholderName, placeholderName } from './naming';

/** Pick tolerance for edges and vertices, in CSS pixels. */
export const PICK_TOLERANCE_PX = 6;

export function encodePickId(id: number): [number, number, number] {
  return [id & 0xff, (id >> 8) & 0xff, (id >> 16) & 0xff];
}

export function decodePickId(r: number, g: number, b: number): number {
  return r | (g << 8) | (b << 16);
}

export type PickKind = 'face' | 'edge' | 'vertex';

export interface PickTarget {
  body: number;
  kind: PickKind;
  /** 1-based face, edge or vertex index. */
  index: number;
}

/** What a pick id stands for, or null for the background or an unknown id. */
export function decodePickTarget(bodies: readonly ViewBody[], id: number): PickTarget | null {
  if (id === 0) return null;
  for (let b = 0; b < bodies.length; b++) {
    const body = bodies[b]!;
    let i = id - body.pickBase;
    if (i < 0 || i >= body.pickCount) continue;
    if (i < body.faceCount) return { body: b, kind: 'face', index: i + 1 };
    i -= body.faceCount;
    if (i < body.edgeCount) return { body: b, kind: 'edge', index: i + 1 };
    return { body: b, kind: 'vertex', index: i - body.edgeCount + 1 };
  }
  return null;
}

export interface FaceHit {
  body: number;
  face: number;
}

export interface PickWindow {
  /**
   * The face under the cursor pixel. Where an edge or vertex is drawn over
   * that pixel, the nearest face pixel in the window stands in.
   */
  center: FaceHit | null;
  /** Per body: visible edge index to the distance of its nearest pixel from the cursor. */
  edges: Map<number, number>[];
  /** Per body: visible vertex index to the distance of its nearest pixel from the cursor. */
  vertices: Map<number, number>[];
}

/**
 * Decode an RGBA window of `size` x `size` pixels whose centre pixel is
 * centred on the cursor, as read back from the pick target.
 */
export function readPickWindow(
  pixels: Uint8Array,
  size: number,
  bodies: readonly ViewBody[],
): PickWindow {
  const edges = bodies.map(() => new Map<number, number>());
  const vertices = bodies.map(() => new Map<number, number>());
  const half = (size - 1) / 2;
  let center: FaceHit | null = null;
  let centerDistance = Infinity;
  let lastId = -1;
  let last: PickTarget | null = null;
  for (let p = 0; p < size * size; p++) {
    const id = decodePickId(pixels[p * 4]!, pixels[p * 4 + 1]!, pixels[p * 4 + 2]!);
    // Runs of one id are common: decode each run once.
    const hit: PickTarget | null = id === lastId ? last : decodePickTarget(bodies, id);
    lastId = id;
    last = hit;
    if (!hit) continue;
    const d = Math.hypot((p % size) - half, Math.floor(p / size) - half);
    if (hit.kind === 'face') {
      if (d < centerDistance) {
        centerDistance = d;
        center = { body: hit.body, face: hit.index };
      }
      continue;
    }
    const seen = (hit.kind === 'edge' ? edges : vertices)[hit.body]!;
    if (d < (seen.get(hit.index) ?? Infinity)) seen.set(hit.index, d);
  }
  // Only the centre pixel picks a face, unless an edge or vertex covers it.
  const centreId = (half * size + half) * 4;
  const centreHit = decodePickTarget(
    bodies,
    decodePickId(pixels[centreId]!, pixels[centreId + 1]!, pixels[centreId + 2]!),
  );
  if (!centreHit) center = null;
  return { center, edges, vertices };
}

export function pointSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export interface Candidate {
  body: number;
  /** 1-based edge or vertex index. */
  index: number;
  distance: number;
}

/**
 * Edges near the cursor. `screen` holds x0 y0 x1 y1 in CSS pixels per segment
 * of the body, NaN for a segment that is clipped away or behind the camera.
 */
export function edgeCandidates(
  body: number,
  screen: Float32Array,
  segmentEdges: Uint32Array,
  cursor: { x: number; y: number },
  tolerance: number,
): Candidate[] {
  const best = new Map<number, number>();
  for (let s = 0; s < segmentEdges.length; s++) {
    const ax = screen[s * 4]!;
    if (Number.isNaN(ax)) continue;
    const ay = screen[s * 4 + 1]!;
    const bx = screen[s * 4 + 2]!;
    const by = screen[s * 4 + 3]!;
    // Cheap box reject before the distance.
    if (
      cursor.x < Math.min(ax, bx) - tolerance ||
      cursor.x > Math.max(ax, bx) + tolerance ||
      cursor.y < Math.min(ay, by) - tolerance ||
      cursor.y > Math.max(ay, by) + tolerance
    ) {
      continue;
    }
    const d = pointSegmentDistance(cursor.x, cursor.y, ax, ay, bx, by);
    if (d > tolerance) continue;
    const edge = segmentEdges[s]!;
    if (d < (best.get(edge) ?? Infinity)) best.set(edge, d);
  }
  return [...best].map(([index, distance]) => ({ body, index, distance }));
}

/** Vertices near the cursor. `screen` holds x y per vertex (slot = index - 1), NaN when hidden. */
export function vertexCandidates(
  body: number,
  screen: Float32Array,
  cursor: { x: number; y: number },
  tolerance: number,
): Candidate[] {
  const out: Candidate[] = [];
  for (let v = 0; v < screen.length / 2; v++) {
    const x = screen[v * 2]!;
    if (Number.isNaN(x)) continue;
    const d = Math.hypot(cursor.x - x, cursor.y - screen[v * 2 + 1]!);
    if (d <= tolerance) out.push({ body, index: v + 1, distance: d });
  }
  return out;
}

export type PickHit =
  | { kind: 'face'; body: number; index: number }
  | { kind: 'edge'; body: number; index: number }
  | { kind: 'vertex'; body: number; index: number };

export interface PickCandidates {
  window: PickWindow;
  edges: readonly Candidate[];
  vertices: readonly Candidate[];
}

/**
 * Keep the candidates the pick window shows a pixel of within the tolerance.
 * A pixel is up to half a diagonal off the geometry, hence the slack.
 */
function visibleCandidates(
  cands: readonly Candidate[],
  seen: readonly Map<number, number>[],
  tolerance: number,
): Candidate[] {
  const out: Candidate[] = [];
  for (const c of cands) {
    const pixel = seen[c.body]?.get(c.index);
    if (pixel === undefined || pixel > tolerance + PIXEL_SLACK) continue;
    // The geometric distance is exact, but only to be trusted when the nearest
    // visible pixel agrees with it; otherwise only a farther part is visible.
    const distance = pixel <= c.distance + PIXEL_SLACK ? c.distance : pixel;
    out.push({ ...c, distance });
  }
  return out;
}

/** Half a pixel diagonal, plus a hair. */
const PIXEL_SLACK = 0.75;

function nearest(cands: readonly Candidate[]): Candidate | null {
  let best: Candidate | null = null;
  for (const c of cands) if (!best || c.distance < best.distance) best = c;
  return best;
}

/** Decide what the cursor picks. `enabled` is the selection filter. */
export function choosePick(
  c: PickCandidates,
  enabled: (kind: GeometryKind) => boolean,
  tolerance: number = PICK_TOLERANCE_PX,
): PickHit | null {
  if (enabled('vertex')) {
    const v = nearest(visibleCandidates(c.vertices, c.window.vertices, tolerance));
    if (v) return { kind: 'vertex', body: v.body, index: v.index };
  }
  if (enabled('edge')) {
    const e = nearest(visibleCandidates(c.edges, c.window.edges, tolerance));
    if (e) return { kind: 'edge', body: e.body, index: e.index };
  }
  if (enabled('face') && c.window.center) {
    return { kind: 'face', body: c.window.center.body, index: c.window.center.face };
  }
  return null;
}

/** The stable reference of a pick: the name from the mesh's name slots, never the index. */
export function hitToRef(bodies: readonly ViewBody[], hit: PickHit): GeometryRef | null {
  const body = bodies[hit.body];
  if (!body) return null;
  if (hit.kind === 'vertex') {
    // No vertex name slots yet: always a placeholder (see naming.ts).
    const name = placeholderName('vertex', hit.index);
    return geometryRef('vertex', body.id, name, { fragile: true, placeholder: true });
  }
  const slots = hit.kind === 'face' ? body.mesh.faceNames : body.mesh.edgeNames;
  const fragileFlags = hit.kind === 'face' ? body.mesh.faceFragile : body.mesh.edgeFragile;
  const slot = slots[hit.index - 1];
  if (slot === undefined) return null;
  const named = slot === UNNAMED ? undefined : body.names[slot];
  const name = named ?? placeholderName(hit.kind, hit.index);
  const placeholder = isPlaceholderName(name);
  return geometryRef(hit.kind, body.id, name, {
    fragile: placeholder || fragileFlags[hit.index - 1] === 1,
    placeholder,
  });
}
