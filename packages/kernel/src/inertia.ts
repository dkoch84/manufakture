// Mass moments of inertia (T9.1c): pure arithmetic on what `measure` returns, with no OCCT, so
// the session, the MCP server and the web app's measure panel share it (subpath
// `@manufakture/kernel/inertia`).
//
// Units follow the rest of the app: lengths in mm, masses in grams, densities in kg/m³ (as the
// material table gives them), so a mass moment of inertia is in g·mm². 1 kg·m² = 1e9 g·mm².
//
// A tensor is the inertia tensor in the usual form: the moments about X, Y and Z on the diagonal
// and minus the products of inertia off it, `I[0][1] = -∫ x y dm`. That is the form OCCT's
// `GProp_GProps.MatrixOfInertia` returns (measured on a rotated block, see measure.test.ts), and
// the one for which `d · I · d` is the moment about a unit direction `d` and `R I Rᵀ` rotates it.

import type { MeasureAxis } from './measure';
import type { Placement, Vec3 } from './types';

/** A symmetric 3 x 3 matrix, by rows. */
export type Matrix3 = readonly [Vec3, Vec3, Vec3];

/** Grams per mm³ in one kg/m³. */
export const GRAMS_PER_MM3_PER_KG_M3 = 1e-6;
/** g·mm² in one kg·m². */
export const GMM2_PER_KGM2 = 1e9;

/** A rigid body's mass properties: grams, mm, and g·mm² about its centre of mass. */
export interface MassProperties {
  /** g. */
  mass: number;
  /** mm. */
  centerOfMass: Vec3;
  /** g·mm², about `centerOfMass`, along the axes of the coordinates it is given in. */
  inertia: Matrix3;
}

/** Principal moments (g·mm², ascending) and their unit axes (a right-handed frame, by rows). */
export interface PrincipalInertia {
  moments: Vec3;
  axes: Matrix3;
}

const ZERO: Matrix3 = [
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
];

function m3(f: (r: number, c: number) => number): Matrix3 {
  return [0, 1, 2].map((r) => [0, 1, 2].map((c) => f(r, c))) as unknown as Matrix3;
}

const at = (m: Matrix3, r: number, c: number): number => m[r]![c]!;

/** A uniform body's mass properties from `measure`'s volume (mm³), centre of mass and volume inertia (mm⁵). */
export function bodyMassProperties(
  volume: number,
  centerOfMass: Vec3,
  volumeInertia: Matrix3,
  density: number,
): MassProperties {
  const k = density * GRAMS_PER_MM3_PER_KG_M3;
  return {
    mass: volume * k,
    centerOfMass,
    inertia: m3((r, c) => at(volumeInertia, r, c) * k),
  };
}

/** The rotation matrix of a quaternion `[x, y, z, w]` (normalised first). */
export function rotationMatrix(q: readonly [number, number, number, number]): Matrix3 {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  const [x, y, z, w] = n > 0 ? q.map((v) => v / n) : [0, 0, 0, 1];
  return [
    [1 - 2 * (y! * y! + z! * z!), 2 * (x! * y! - z! * w!), 2 * (x! * z! + y! * w!)],
    [2 * (x! * y! + z! * w!), 1 - 2 * (x! * x! + z! * z!), 2 * (y! * z! - x! * w!)],
    [2 * (x! * z! - y! * w!), 2 * (y! * z! + x! * w!), 1 - 2 * (x! * x! + y! * y!)],
  ];
}

function apply(m: Matrix3, v: Vec3): Vec3 {
  return [0, 1, 2].map(
    (r) => at(m, r, 0) * v[0] + at(m, r, 1) * v[1] + at(m, r, 2) * v[2],
  ) as unknown as Vec3;
}

/** `R I Rᵀ`: a tensor given along a body's axes, along the axes the body is rotated into. */
export function rotateTensor(inertia: Matrix3, rotation: Matrix3): Matrix3 {
  return m3((r, c) => {
    let s = 0;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) s += at(rotation, r, i) * at(inertia, i, j) * at(rotation, c, j);
    }
    return s;
  });
}

/** Mass properties moved by a placement (`p_world = R p + translation`), as an assembly instance's pose. */
export function placeMassProperties(p: MassProperties, placement: Placement): MassProperties {
  const R = rotationMatrix(placement.rotation);
  const c = apply(R, p.centerOfMass);
  return {
    mass: p.mass,
    centerOfMass: [
      c[0] + placement.translation[0],
      c[1] + placement.translation[1],
      c[2] + placement.translation[2],
    ],
    inertia: rotateTensor(p.inertia, R),
  };
}

/** The parallel axis term: what a point mass `mass` at offset `r` adds to a tensor. */
function steiner(mass: number, r: Vec3): Matrix3 {
  const rr = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
  return m3((i, j) => mass * ((i === j ? rr : 0) - r[i]! * r[j]!));
}

function add(a: Matrix3, b: Matrix3): Matrix3 {
  return m3((r, c) => at(a, r, c) + at(b, r, c));
}

/** The tensor about `point` (parallel axis theorem), along the same axes. */
export function inertiaAt(p: MassProperties, point: Vec3): Matrix3 {
  const r: Vec3 = [
    p.centerOfMass[0] - point[0],
    p.centerOfMass[1] - point[1],
    p.centerOfMass[2] - point[2],
  ];
  return add(p.inertia, steiner(p.mass, r));
}

/**
 * The moment of inertia about an axis anywhere (a mate's axis, a shaft's): the moment about the
 * parallel axis through the centre of mass plus the mass times the square of the distance between
 * the two. g·mm². The direction need not be of unit length.
 */
export function momentAboutAxis(p: MassProperties, axis: MeasureAxis): number {
  const n = Math.hypot(...axis.direction);
  if (!(n > 0)) throw new RangeError('The axis direction is zero.');
  const d: Vec3 = [axis.direction[0] / n, axis.direction[1] / n, axis.direction[2] / n];
  const central = d.reduce((s, di, i) => s + di * apply(p.inertia, d)[i]!, 0);
  const r: Vec3 = [
    p.centerOfMass[0] - axis.origin[0],
    p.centerOfMass[1] - axis.origin[1],
    p.centerOfMass[2] - axis.origin[2],
  ];
  const along = r[0] * d[0] + r[1] * d[1] + r[2] * d[2];
  const perp2 = Math.max(0, r[0] * r[0] + r[1] * r[1] + r[2] * r[2] - along * along);
  return central + p.mass * perp2;
}

/** Several bodies as one: total mass, the common centre of mass, and the tensor about it. */
export function combineMassProperties(parts: readonly MassProperties[]): MassProperties | null {
  const mass = parts.reduce((s, p) => s + p.mass, 0);
  if (parts.length === 0 || !(mass > 0)) return null;
  const centerOfMass = [0, 1, 2].map(
    (i) => parts.reduce((s, p) => s + p.mass * p.centerOfMass[i]!, 0) / mass,
  ) as unknown as Vec3;
  const inertia = parts.reduce((s, p) => add(s, inertiaAt(p, centerOfMass)), ZERO);
  return { mass, centerOfMass, inertia };
}

/**
 * Principal moments and axes of a symmetric tensor (Jacobi rotations): the moments ascending, the
 * axes unit length, each with its largest component positive except the third, which completes a
 * right-handed frame. Where two moments are equal (a cylinder about its axis) any pair of axes in
 * their plane is principal; an axis-aligned body gets the coordinate axes.
 */
export function principalInertia(inertia: Matrix3): PrincipalInertia {
  const a = inertia.map((row) => [...row]) as number[][];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const scale = Math.abs(a[0]![0]!) + Math.abs(a[1]![1]!) + Math.abs(a[2]![2]!);
  // Products far below the moments are integration noise: keep the coordinate axes then.
  for (const [p, q] of [
    [0, 1],
    [0, 2],
    [1, 2],
  ] as const) {
    if (Math.abs(a[p]![q]!) <= 1e-12 * scale) a[p]![q] = a[q]![p] = 0;
  }
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0]![1]!) + Math.abs(a[0]![2]!) + Math.abs(a[1]![2]!);
    if (off <= 1e-15 * scale || off === 0) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const apq = a[p]![q]!;
      if (apq === 0) continue;
      const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k]![p]!;
        const akq = a[k]![q]!;
        a[k]![p] = c * akp - s * akq;
        a[k]![q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p]![k]!;
        const aqk = a[q]![k]!;
        a[p]![k] = c * apk - s * aqk;
        a[q]![k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k]![p]!;
        const vkq = v[k]![q]!;
        v[k]![p] = c * vkp - s * vkq;
        v[k]![q] = s * vkp + c * vkq;
      }
    }
  }
  // Column i of v is the axis of a[i][i].
  const pairs = [0, 1, 2]
    .map((i) => ({ moment: a[i]![i]!, axis: [v[0]![i]!, v[1]![i]!, v[2]![i]!] as Vec3 }))
    .sort((x, y) => x.moment - y.moment);
  const positive = (u: Vec3): Vec3 => {
    let big = 0;
    for (let i = 1; i < 3; i++) if (Math.abs(u[i]!) > Math.abs(u[big]!) + 1e-12) big = i;
    return u[big]! < 0 ? [-u[0], -u[1], -u[2]] : u;
  };
  const e1 = positive(pairs[0]!.axis);
  const e2 = positive(pairs[1]!.axis);
  const e3: Vec3 = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
  return {
    moments: [pairs[0]!.moment, pairs[1]!.moment, pairs[2]!.moment],
    axes: [e1, e2, e3],
  };
}

/** What the session and MCP report for a body or an assembly with a mass: g, mm and g·mm². */
export interface InertiaReport {
  /** g·mm², about the centre of mass along the X, Y and Z axes, in tensor form. */
  aboutCenterOfMass: Matrix3;
  principal: PrincipalInertia;
  /** g·mm², about the axis asked for; absent when none was. */
  aboutAxis?: number;
}

/** The inertia report of mass properties, with the moment about `axis` when given. */
export function inertiaReport(p: MassProperties, axis?: MeasureAxis): InertiaReport {
  return {
    aboutCenterOfMass: p.inertia,
    principal: principalInertia(p.inertia),
    ...(axis ? { aboutAxis: momentAboutAxis(p, axis) } : {}),
  };
}
