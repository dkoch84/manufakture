// The scenario every candidate implements, and the geometry it must produce.
//
// Part A (the T0.2 box case): a 40 x 30 x 20 mm box, all 12 edges filleted at
// 2 mm, meshed.
// Part B: a closed L-shaped polyline in the XY plane (a sketch wire) extruded
// 25 mm along +Z, minus a 4 mm radius cylinder drilled along Y through the
// base leg, meshed.

export const BOX = { dx: 40, dy: 30, dz: 20 } as const;
export const FILLET_RADIUS = 2;

/** Closed L profile, counter-clockwise, in the XY plane (mm). */
export const PROFILE: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [60, 0],
  [60, 10],
  [10, 10],
  [10, 40],
  [0, 40],
];
export const EXTRUDE_HEIGHT = 25;

/** Drill: radius, base point, direction (along +Y) and length. */
export const HOLE = {
  radius: 4,
  at: [35, -1, 12.5] as const,
  axis: [0, 1, 0] as const,
  length: 12,
} as const;

/** Mesh parameters, as in T0.2: 0.1 mm linear, 0.5 rad angular deflection. */
export const MESH = { linear: 0.1, angular: 0.5 } as const;
/** The T0.2 "fine" setting, to make mesh extraction cost visible. */
export const MESH_FINE = { linear: 0.01, angular: 0.1 } as const;

export function meshParams(fine: boolean | undefined) {
  return fine ? MESH_FINE : MESH;
}

/** Area of a simple polygon (shoelace). */
function polygonArea(points: ReadonlyArray<readonly [number, number]>): number {
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[(i + 1) % points.length]!;
    twice += x1 * y2 - x2 * y1;
  }
  return Math.abs(twice) / 2;
}

/**
 * Exact volume of a box with every edge filleted at radius r: the box, minus
 * the material removed along each straight edge (a square minus a quarter
 * disc, over the edge length between the corner blends), minus the corner
 * cubes, each of which keeps one eighth of a sphere.
 */
function filletedBoxVolume(a: number, b: number, c: number, r: number): number {
  const edgeRemoval = 4 * r * r * (1 - Math.PI / 4) * (a + b + c - 6 * r);
  const cornerRemoval = 8 * r ** 3 * (1 - Math.PI / 6);
  return a * b * c - edgeRemoval - cornerRemoval;
}

const extrudedVolume = polygonArea(PROFILE) * EXTRUDE_HEIGHT;
// The drill passes through the whole 10 mm thickness of the base leg.
const drilledVolume = Math.PI * HOLE.radius ** 2 * 10;

export const EXPECTED = {
  box: { volume: BOX.dx * BOX.dy * BOX.dz, faces: 6, edges: 12 },
  /** 6 trimmed box faces, 12 edge fillets, 8 corner blends. */
  filleted: { volume: filletedBoxVolume(BOX.dx, BOX.dy, BOX.dz, FILLET_RADIUS), faces: 26 },
  /** 6 side faces from the 6 profile segments, plus the two caps. */
  extruded: { volume: extrudedVolume, faces: 8 },
  /** The 8 prism faces (two of them now holed) plus the hole's cylindrical face. */
  cut: { volume: extrudedVolume - drilledVolume, faces: 9 },
} as const;

/** Relative tolerance for volumes computed by OCCT (exact B-rep integration). */
export const VOLUME_TOLERANCE = 1e-6;

/** What one candidate reports for one run of the scenario. */
export interface PartReport {
  volume: number;
  faces: number;
  triangles: number;
  vertices: number;
}

export interface ScenarioReport {
  filleted: PartReport;
  extruded: { volume: number; faces: number };
  cut: PartReport;
}

/** Phase timings of one run, in milliseconds. */
export interface ScenarioTimings {
  /** Box and fillet (part A modelling). */
  filletMs: number;
  /** Profile wire, face, extrude, cylinder and cut (part B modelling). */
  cutMs: number;
  /** Meshing and copying both meshes out to JS typed arrays. */
  meshMs: number;
  /** Volume and face count queries. */
  queryMs: number;
  totalMs: number;
}
