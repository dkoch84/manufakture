// View frames and the projection of 3D points into a view, in plain TypeScript. HLR's projector
// (`HLRAlgo_Projector` from a `gp_Ax2`) maps a point p to (dot(p - o, x), dot(p - o, y)), with z
// toward the viewer; `hlr.test.ts` checks that this function agrees with it and with the 2D
// coordinates of HLR's own output, so dimensions can be projected without calling the kernel.

export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

/** An orthographic view: the direction the viewer looks in, and which way is up on paper. */
export interface View {
  name: string;
  /** From the viewer into the scene. */
  direction: Vec3;
  /** Up on paper; must not be parallel to `direction`. */
  up: Vec3;
  /** The view frame's origin (default the world origin). Only shifts the 2D output. */
  origin?: Vec3;
}

/** The view's frame: x right, y up on paper, z toward the viewer (the gp_Ax2 HLR is given). */
export interface ViewFrame {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const unit = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));

export function frameOf(view: View): ViewFrame {
  const z = unit(scale(view.direction, -1));
  const x = unit(cross(view.up, z));
  const y = cross(z, x);
  return { origin: view.origin ?? [0, 0, 0], x, y, z };
}

/** A 3D point in view coordinates: [x, y] on paper (model millimetres) and the depth toward the viewer. */
export function project(frame: ViewFrame, p: Vec3): { at: Vec2; depth: number } {
  const d = sub(p, frame.origin);
  return { at: [dot(d, frame.x), dot(d, frame.y)], depth: dot(d, frame.z) };
}

/**
 * A 3D circle (centre, unit axis, radius) in a view: an ellipse with semi-axes r and r * |cos|,
 * the major axis along the projection of (axis x view z), or a line segment when seen edge on.
 */
export function projectCircle(
  frame: ViewFrame,
  center: Vec3,
  axis: Vec3,
  radius: number,
):
  | { kind: 'circle'; center: Vec2; radius: number }
  | { kind: 'ellipse'; center: Vec2; major: number; minor: number; rotation: number }
  | { kind: 'line'; a: Vec2; b: Vec2 } {
  const c = project(frame, center).at;
  const cosine = Math.abs(dot(unit(axis), frame.z));
  if (Math.abs(1 - cosine) < 1e-12) return { kind: 'circle', center: c, radius };
  let major = cross(axis, frame.z);
  major = unit(major);
  const m: Vec2 = [dot(major, frame.x), dot(major, frame.y)];
  if (cosine < 1e-12) {
    return {
      kind: 'line',
      a: [c[0] - radius * m[0], c[1] - radius * m[1]],
      b: [c[0] + radius * m[0], c[1] + radius * m[1]],
    };
  }
  return {
    kind: 'ellipse',
    center: c,
    major: radius,
    minor: radius * cosine,
    rotation: Math.atan2(m[1], m[0]),
  };
}

const S3 = 1 / Math.sqrt(3);

/** Third-angle standard views for a Z-up model: front looks along +Y, right along -X, top down -Z. */
export const VIEWS: Record<'front' | 'top' | 'right' | 'iso', View> = {
  front: { name: 'front', direction: [0, 1, 0], up: [0, 0, 1] },
  top: { name: 'top', direction: [0, 0, -1], up: [0, 1, 0] },
  right: { name: 'right', direction: [-1, 0, 0], up: [0, 0, 1] },
  iso: { name: 'iso', direction: [-S3, S3, -S3], up: [0, 0, 1] },
};
