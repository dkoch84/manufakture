// Cosmetic threads in the viewport (M3 plan, T3.2f): the thread regen reports for each cosmetic
// thread feature (`FeatureResult.thread`) drawn as a helix over the resized face, with a circle
// at each end, so the face reads as threaded although its geometry is a plain cylinder. The
// engine draws the lines depth-tested in the scene (`ViewportEngine.setThreadLines`).

import type { ThreadReport, Vec3 } from '@manufakture/kernel';
import type { PartModel } from '../model/model';

/** How far a drawn helix stands off the face, so the face's facets never hide it, mm. */
const STANDOFF = 0.04;
/** Points per turn of a drawn helix. */
const SEGMENTS = 48;

/**
 * A cosmetic thread as lines: the helix along the thread at its radius, plus the two end
 * circles, each a polyline in world coordinates. The helix stands a little off the face, on the
 * side away from the material, where the viewer sees it.
 */
export function threadHelix(t: ThreadReport): Vec3[][] {
  const n = t.axis.direction;
  const len = Math.hypot(n[0], n[1], n[2]);
  const z: Vec3 = [n[0] / len, n[1] / len, n[2] / len];
  // The same reference direction as the kernel's: world X square to the axis (Y along X).
  const project = (v: Vec3): Vec3 | null => {
    const k = v[0] * z[0] + v[1] * z[1] + v[2] * z[2];
    const p: Vec3 = [v[0] - k * z[0], v[1] - k * z[1], v[2] - k * z[2]];
    const l = Math.hypot(p[0], p[1], p[2]);
    return l > 1e-6 ? [p[0] / l, p[1] / l, p[2] / l] : null;
  };
  const x = project([1, 0, 0]) ?? project([0, 1, 0])!;
  const y: Vec3 = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const r = t.radius + (t.side === 'external' ? STANDOFF : -STANDOFF);
  const h = t.hand === 'left' ? -1 : 1;
  const o = t.axis.origin;
  const at = (angle: number, along: number): Vec3 => {
    const c = r * Math.cos(angle);
    const s = r * Math.sin(angle);
    return [0, 1, 2].map((i) => o[i]! + along * z[i]! + c * x[i]! + s * y[i]!) as unknown as Vec3;
  };
  const turns = t.length / t.pitch;
  const steps = Math.max(8, Math.ceil(turns * SEGMENTS));
  const helix: Vec3[] = [];
  for (let i = 0; i <= steps; i++) {
    const tau = (turns * i) / steps;
    helix.push(at(t.phase + h * 2 * Math.PI * tau, t.pitch * tau));
  }
  const ring = (along: number): Vec3[] =>
    Array.from({ length: SEGMENTS + 1 }, (_, i) => at((2 * Math.PI * i) / SEGMENTS, along));
  return [helix, ring(0), ring(t.length)];
}

/**
 * The lines of every cosmetic thread a part's last regen built, for features that built (a
 * failed feature reports none). Modelled threads are real geometry and need none.
 */
export function cosmeticThreadLines(part: Pick<PartModel, 'features'> | undefined): Vec3[][] {
  if (part === undefined) return [];
  return part.features.flatMap((f) =>
    f.status === 'ok' && f.thread !== undefined && f.thread.representation === 'cosmetic'
      ? threadHelix(f.thread)
      : [],
  );
}
