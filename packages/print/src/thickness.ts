// Wall thickness and gaps by ray casting on the meshes (plan T3.1c, ADR 0012 decision 5).
//
// For sample points on every triangle, a ray goes inward along -normal through the same body's
// mesh; the distance to the first surface it leaves the material through (a triangle facing the
// way the ray goes) is the local wall thickness. A ray outward along +normal gives the gap: the
// distance to the first surface it enters material through, of the same body or of any other body
// of the setup. Each body's triangles sit in a bounding volume hierarchy (`bvh.ts`).
//
// Samples: the centroid of every triangle, and on a large triangle the centroids of the k x k
// congruent pieces it divides into, k = ceil(longest edge / spacing) up to `maxSplit`, each
// standing for an equal share of the area. The ray direction at a sample is the vertex normals
// interpolated there (radial on a tessellated cylinder), or the triangle's own normal when they
// cancel out or point the other way.
//
// Near edges: the ray starts RAY_OFFSET inside (or outside) the surface and hits within
// GRAZING_ANGLE of parallel to the ray are passed over, so a ray from near a sharp edge does not
// read the neighbouring face as a thin wall. A genuinely acute edge (a knife edge) still reads as
// thin near its tip, which it is.
//
// Values are in the setup's frame (the placement only moves the mesh, so thickness does not
// depend on it, but gaps between bodies do). Distances beyond `range` are not measured: such a
// sample has thickness or gap Infinity.

import type { MeshData } from '@manufakture/kernel';
import { TriangleBvh } from './bvh';
import { quatToMatrix, type Placement } from './geometry';
import { printThresholds, type PrintThresholds } from './thresholds';

/** How far rays start inside (or outside) the surface, mm; added back to every distance. */
export const RAY_OFFSET = 1e-4;
/** Hits on surfaces within this angle of parallel to the ray are ignored (radians, 3 degrees). */
export const GRAZING_ANGLE = (3 * Math.PI) / 180;
/**
 * Distances within this many mm of a threshold count as at the threshold, which is not below it.
 * Covers the float32 positions of `MeshData` (about 1e-5 mm at 100 mm from the origin).
 */
export const LENGTH_TOLERANCE = 1e-4;
/** Default distance up to which thickness and gaps are measured, mm. */
export const DEFAULT_RANGE = 10;
/** Default sample spacing on large triangles, mm. */
export const DEFAULT_SPACING = 1;
/** Default largest split of a triangle per edge (at most maxSplit^2 samples per triangle). */
export const DEFAULT_MAX_SPLIT = 8;

/** Bits of `BodyThickness.flags`. */
export const THICKNESS_FLAGS = {
  /** Some sample is thinner than the minimum feature: not printed at all. */
  belowMinFeature: 1,
  /** Some sample is at least the minimum feature but thinner than the minimum wall. */
  thinWall: 2,
  /** Some sample's gap is narrower than the minimum gap. */
  narrowGap: 4,
} as const;

export type ThicknessIssueKind = keyof typeof THICKNESS_FLAGS;

/** What the thickness check reads from a mesh: positions, normals and triangles, face ids when it has them. */
export type ThicknessMesh = Pick<MeshData, 'positions' | 'normals' | 'indices'> &
  Partial<Pick<MeshData, 'triangleFaces'>>;

export interface ThicknessBody {
  mesh: ThicknessMesh;
  /** The body's placement in the setup (`orientationPlacement`); default the mesh as it is. */
  placement?: Placement;
}

export interface ThicknessOptions {
  /** Default: `printThresholds(0.4)`. */
  thresholds?: Pick<PrintThresholds, 'minFeature' | 'minWall' | 'minGap'>;
  /** mm; default `DEFAULT_RANGE`. */
  range?: number;
  /** mm; default `DEFAULT_SPACING`. */
  spacing?: number;
  /** Default `DEFAULT_MAX_SPLIT`. */
  maxSplit?: number;
}

export interface FaceThickness {
  /** 1-based face index (topology numbering). */
  face: number;
  /** The thinnest sample, mm; Infinity when no sample found an opposite wall within range. */
  minThickness: number;
  /** The narrowest gap, mm; Infinity when none within range. */
  minGap: number;
  /** Area in mm2 of the samples in each class (a sample stands for its share of its triangle). */
  areas: Record<ThicknessIssueKind, number>;
  triangles: number;
}

export interface BodyThickness {
  /** Per triangle: its thinnest sample, mm (Infinity: nothing within range). */
  thickness: Float32Array;
  /** Per triangle: its narrowest gap, mm (Infinity: nothing within range). */
  gap: Float32Array;
  /** Per triangle: `THICKNESS_FLAGS` bits of the classes its samples fall in. */
  flags: Uint8Array;
  /** Per face, slot i for face i + 1; empty when the mesh has no `triangleFaces`. */
  faces: FaceThickness[];
  /** Rays cast per direction (samples). */
  samples: number;
}

/**
 * One problem on one face: the area of its samples in the class, and the worst value (the
 * thinnest wall or narrowest gap). `face` is 0 when the mesh has no face ids (the whole body).
 */
export interface ThicknessIssue {
  kind: ThicknessIssueKind;
  /** Index of the body in the input. */
  body: number;
  face: number;
  /** mm: the thinnest sample (or narrowest gap) of the face in this class. */
  value: number;
  /** mm2. */
  area: number;
}

export interface ThicknessResult {
  bodies: BodyThickness[];
  issues: ThicknessIssue[];
  /** The thresholds used. */
  thresholds: Pick<PrintThresholds, 'minFeature' | 'minWall' | 'minGap'>;
}

/** Thickness and gaps of every body, in one go. */
export function analyzeThickness(
  bodies: readonly ThicknessBody[],
  options: ThicknessOptions = {},
): ThicknessResult {
  const job = new ThicknessJob(bodies, options);
  while (!job.step(Infinity));
  return job.result();
}

interface Prepared {
  /** Placed positions (float64), xyz per vertex. */
  positions: Float64Array;
  /** Rotated vertex normals, xyz per vertex. */
  normals: Float64Array;
  indices: ArrayLike<number>;
  triangleFaces: ArrayLike<number> | undefined;
  bvh: TriangleBvh;
  out: BodyThickness;
  /** Areas per class for the whole body, when the mesh has no face ids. */
  whole: Record<ThicknessIssueKind, number>;
}

/**
 * The analysis in steps, so that a worker can yield between them and drop stale work (ADR 0007
 * decision 4). `step(n)` runs at most n more triangles and returns true when everything is done.
 */
export class ThicknessJob {
  private readonly prepared: Prepared[] = [];
  private readonly thresholds: Pick<PrintThresholds, 'minFeature' | 'minWall' | 'minGap'>;
  private readonly range: number;
  private readonly spacing: number;
  private readonly maxSplit: number;
  private readonly minCos = Math.sin(GRAZING_ANGLE);
  private body = 0;
  private triangle = 0;

  constructor(bodies: readonly ThicknessBody[], options: ThicknessOptions = {}) {
    this.thresholds = options.thresholds ?? printThresholds(0.4);
    this.range = options.range ?? DEFAULT_RANGE;
    this.spacing = options.spacing ?? DEFAULT_SPACING;
    this.maxSplit = Math.max(1, Math.floor(options.maxSplit ?? DEFAULT_MAX_SPLIT));
    for (const body of bodies) this.prepared.push(prepare(body));
  }

  /** Runs up to `budget` triangles; true when the whole analysis is done. */
  step(budget: number): boolean {
    let left = budget;
    while (this.body < this.prepared.length) {
      const p = this.prepared[this.body]!;
      const n = p.out.thickness.length;
      while (this.triangle < n) {
        if (left-- <= 0) return false;
        this.measure(this.body, this.triangle++);
      }
      this.body++;
      this.triangle = 0;
    }
    return true;
  }

  /** The result; call once `step` has returned true. */
  result(): ThicknessResult {
    const issues: ThicknessIssue[] = [];
    this.prepared.forEach((p, b) => {
      const faces = p.out.faces;
      if (faces.length > 0) {
        for (const f of faces) {
          for (const kind of ISSUE_KINDS) {
            if (f.areas[kind] > 0) {
              const value = kind === 'narrowGap' ? f.minGap : f.minThickness;
              issues.push({ kind, body: b, face: f.face, value, area: f.areas[kind] });
            }
          }
        }
      } else {
        // No face ids: one summary for the whole body.
        for (const kind of ISSUE_KINDS) {
          if (p.whole[kind] > 0) {
            issues.push({
              kind,
              body: b,
              face: 0,
              value: kind === 'narrowGap' ? minOf(p.out.gap) : minOf(p.out.thickness),
              area: p.whole[kind],
            });
          }
        }
      }
    });
    return { bodies: this.prepared.map((p) => p.out), issues, thresholds: this.thresholds };
  }

  private measure(b: number, t: number): void {
    const p = this.prepared[b]!;
    const { positions: P, normals: N, indices } = p;
    const { minFeature, minWall, minGap } = this.thresholds;
    const ia = indices[3 * t]!,
      ib = indices[3 * t + 1]!,
      ic = indices[3 * t + 2]!;
    const ax = P[3 * ia]!,
      ay = P[3 * ia + 1]!,
      az = P[3 * ia + 2]!;
    const bx = P[3 * ib]!,
      by = P[3 * ib + 1]!,
      bz = P[3 * ib + 2]!;
    const cx = P[3 * ic]!,
      cy = P[3 * ic + 1]!,
      cz = P[3 * ic + 2]!;
    const e1x = bx - ax,
      e1y = by - ay,
      e1z = bz - az;
    const e2x = cx - ax,
      e2y = cy - ay,
      e2z = cz - az;
    let gx = e1y * e2z - e1z * e2y,
      gy = e1z * e2x - e1x * e2z,
      gz = e1x * e2y - e1y * e2x;
    const g = Math.hypot(gx, gy, gz);
    const area = g / 2;
    const face = p.triangleFaces?.[t] ?? 0;
    const summary = this.faceSummary(p, face);
    if (summary.face) summary.face.triangles++;
    if (!(g > 0)) {
      // A degenerate triangle has no direction to measure along.
      p.out.thickness[t] = Infinity;
      p.out.gap[t] = Infinity;
      return;
    }
    gx /= g;
    gy /= g;
    gz /= g;
    const longest = Math.sqrt(
      Math.max(
        e1x * e1x + e1y * e1y + e1z * e1z,
        e2x * e2x + e2y * e2y + e2z * e2z,
        (cx - bx) ** 2 + (cy - by) ** 2 + (cz - bz) ** 2,
      ),
    );
    const k = Math.min(this.maxSplit, Math.max(1, Math.ceil(longest / this.spacing)));
    const weight = area / (k * k);
    let thin = Infinity;
    let narrow = Infinity;
    let flags = 0;
    const range = this.range;
    const own = p.bvh;

    const sample = (u: number, v: number) => {
      const w = 1 - u - v;
      const px = w * ax + u * bx + v * cx,
        py = w * ay + u * by + v * cy,
        pz = w * az + u * bz + v * cz;
      let nx = w * N[3 * ia]! + u * N[3 * ib]! + v * N[3 * ic]!;
      let ny = w * N[3 * ia + 1]! + u * N[3 * ib + 1]! + v * N[3 * ic + 1]!;
      let nz = w * N[3 * ia + 2]! + u * N[3 * ib + 2]! + v * N[3 * ic + 2]!;
      const nl = Math.hypot(nx, ny, nz);
      if (nl > 1e-9 && (nx * gx + ny * gy + nz * gz) / nl > 0) {
        nx /= nl;
        ny /= nl;
        nz /= nl;
      } else {
        nx = gx;
        ny = gy;
        nz = gz;
      }
      // Thickness: inward, through the body's own material.
      const inward = own.firstHit(
        px - RAY_OFFSET * nx,
        py - RAY_OFFSET * ny,
        pz - RAY_OFFSET * nz,
        -nx,
        -ny,
        -nz,
        0,
        range,
        1,
        this.minCos,
        t,
      );
      const d = inward ? inward.t + RAY_OFFSET : Infinity;
      // Gap: outward, to the nearest wall of any body.
      let gap = range;
      let found = false;
      for (let o = 0; o < this.prepared.length; o++) {
        const hit = this.prepared[o]!.bvh.firstHit(
          px + RAY_OFFSET * nx,
          py + RAY_OFFSET * ny,
          pz + RAY_OFFSET * nz,
          nx,
          ny,
          nz,
          0,
          gap,
          -1,
          this.minCos,
          o === b ? t : -1,
        );
        if (hit) {
          gap = hit.t;
          found = true;
        }
      }
      const s = found ? gap + RAY_OFFSET : Infinity;
      if (d < thin) thin = d;
      if (s < narrow) narrow = s;
      if (d < minFeature - LENGTH_TOLERANCE) {
        flags |= THICKNESS_FLAGS.belowMinFeature;
        summary.values.belowMinFeature += weight;
      } else if (d < minWall - LENGTH_TOLERANCE) {
        flags |= THICKNESS_FLAGS.thinWall;
        summary.values.thinWall += weight;
      }
      if (s < minGap - LENGTH_TOLERANCE) {
        flags |= THICKNESS_FLAGS.narrowGap;
        summary.values.narrowGap += weight;
      }
    };

    // Centroids of the k x k pieces: "up" pieces (i, j) with i + j <= k - 1 and "down" pieces
    // with i + j <= k - 2, in barycentric coordinates along the edges a->b and a->c.
    for (let i = 0; i < k; i++) {
      for (let j = 0; i + j < k; j++) {
        sample((i + 1 / 3) / k, (j + 1 / 3) / k);
        if (i + j <= k - 2) sample((i + 2 / 3) / k, (j + 2 / 3) / k);
      }
    }
    p.out.samples += k * k;
    p.out.thickness[t] = thin;
    p.out.gap[t] = narrow;
    p.out.flags[t] = flags;
    if (summary.face) {
      summary.face.minThickness = Math.min(summary.face.minThickness, thin);
      summary.face.minGap = Math.min(summary.face.minGap, narrow);
    }
  }

  private faceSummary(
    p: Prepared,
    face: number,
  ): { face: FaceThickness | null; values: Record<ThicknessIssueKind, number> } {
    if (face > 0 && face <= p.out.faces.length) {
      const f = p.out.faces[face - 1]!;
      return { face: f, values: f.areas };
    }
    return { face: null, values: p.whole };
  }
}

const ISSUE_KINDS = Object.keys(THICKNESS_FLAGS) as ThicknessIssueKind[];

function minOf(a: Float32Array): number {
  let m = Infinity;
  for (const v of a) if (v < m) m = v;
  return m;
}

function prepare(body: ThicknessBody): Prepared {
  const { positions, normals, indices, triangleFaces } = body.mesh;
  const m = quatToMatrix(body.placement?.rotation ?? [0, 0, 0, 1]);
  const tr = body.placement?.translation ?? [0, 0, 0];
  const vertexCount = Math.floor(positions.length / 3);
  const P = new Float64Array(vertexCount * 3);
  const N = new Float64Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v++) {
    const x = positions[3 * v]!,
      y = positions[3 * v + 1]!,
      z = positions[3 * v + 2]!;
    P[3 * v] = m[0] * x + m[1] * y + m[2] * z + tr[0];
    P[3 * v + 1] = m[3] * x + m[4] * y + m[5] * z + tr[1];
    P[3 * v + 2] = m[6] * x + m[7] * y + m[8] * z + tr[2];
    const nx = normals[3 * v] ?? 0,
      ny = normals[3 * v + 1] ?? 0,
      nz = normals[3 * v + 2] ?? 0;
    N[3 * v] = m[0] * nx + m[1] * ny + m[2] * nz;
    N[3 * v + 1] = m[3] * nx + m[4] * ny + m[5] * nz;
    N[3 * v + 2] = m[6] * nx + m[7] * ny + m[8] * nz;
  }
  const triangleCount = Math.floor(indices.length / 3);
  for (let i = 0; i < triangleCount * 3; i++) {
    if (!(indices[i]! < vertexCount)) {
      throw new RangeError(
        `triangle ${Math.floor(i / 3)} names vertex ${indices[i]} of ${vertexCount}`,
      );
    }
  }
  let faceCount = 0;
  if (triangleFaces) for (const f of triangleFaces) if (f > faceCount) faceCount = f;
  const faces: FaceThickness[] = [];
  for (let f = 1; f <= faceCount; f++) {
    faces.push({
      face: f,
      minThickness: Infinity,
      minGap: Infinity,
      areas: { belowMinFeature: 0, thinWall: 0, narrowGap: 0 },
      triangles: 0,
    });
  }
  return {
    positions: P,
    normals: N,
    indices,
    triangleFaces,
    bvh: new TriangleBvh(P, indices.subarray(0, triangleCount * 3)),
    out: {
      thickness: new Float32Array(triangleCount),
      gap: new Float32Array(triangleCount),
      flags: new Uint8Array(triangleCount),
      faces,
      samples: 0,
    },
    whole: { belowMinFeature: 0, thinWall: 0, narrowGap: 0 },
  };
}
