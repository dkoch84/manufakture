// Approach 1: a software rasteriser of regen meshes in plain TypeScript. Orthographic camera
// fitted to the model, a depth buffer, flat shading per triangle (a key light and a headlight in
// view space, so every view is lit the same way), B-rep edge polylines (and crease edges of
// member meshes) drawn over it with a depth test, a silhouette pass from depth discontinuities,
// supersampling for anti-aliasing, PNG through fflate.
//
// Determinism: only IEEE double arithmetic (+ - * / sqrt, which are exactly rounded) in a fixed
// order over the scene's arrays; no transcendental functions per pixel, no threads, no clocks.

import type { Rgb, Scene } from './fixtures';
import { encodePng } from './png';

export type Vec3 = readonly [number, number, number];

export interface View {
  name: string;
  /** The way the eye looks, into the model. */
  direction: Vec3;
  /** The model direction shown upwards. */
  up: Vec3;
}

const S3 = 1 / Math.sqrt(3);
/** As core's `STANDARD_VIEWS` (third angle, Z up), and the viewer's `iso`. */
export const VIEWS: readonly View[] = [
  { name: 'iso', direction: [-S3, S3, -S3], up: [0, 0, 1] },
  { name: 'front', direction: [0, 1, 0], up: [0, 0, 1] },
  { name: 'top', direction: [0, 0, -1], up: [0, 1, 0] },
  { name: 'right', direction: [-1, 0, 0], up: [0, 0, 1] },
];

export interface RasterOptions {
  width: number;
  height: number;
  /** Supersampling factor per axis (1: none). */
  ss: number;
  /** Draw edge polylines. */
  edges: boolean;
  /** Draw silhouettes from depth discontinuities. */
  outline: boolean;
  /** Edge and outline width, output pixels. */
  lineWidth: number;
  /** Empty border, output pixels. */
  margin: number;
  /** Instance names drawn in the highlight colour. */
  highlight?: ReadonlySet<string>;
}

export const DEFAULT_OPTIONS: RasterOptions = {
  width: 1024,
  height: 768,
  ss: 2,
  edges: true,
  outline: true,
  lineWidth: 1.25,
  margin: 24,
};

const BACKGROUND: Rgb = [0xf6, 0xf7, 0xf9];
const INK: Rgb = [0x1f, 0x23, 0x28];
const HIGHLIGHT: Rgb = [0xf0, 0x8a, 0x24];

export interface RasterStats {
  /** Triangles and edge segments drawn. */
  triangles: number;
  segments: number;
  /** Model mm per output pixel. */
  mmPerPixel: number;
  ms: { transform: number; triangles: number; edges: number; outline: number; resolve: number };
}

export interface RasterImage {
  width: number;
  height: number;
  rgb: Uint8Array;
  stats: RasterStats;
}

function normalize(v: Vec3): [number, number, number] {
  const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

const cross = (a: Vec3, b: Vec3): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Light directions in view space (x right, y up, z into the screen), towards the light. */
const KEY = normalize([-0.45, 0.65, -0.62]);

/** Render `scene` from `view`. */
export function rasterize(
  scene: Scene,
  view: View,
  options: Partial<RasterOptions> = {},
): RasterImage {
  const o = { ...DEFAULT_OPTIONS, ...options };
  const ss = o.ss;
  const W = o.width * ss;
  const H = o.height * ss;
  const d = normalize(view.direction);
  const r = normalize(cross(d, view.up));
  const u = cross(r, d);

  // 1. Every instance's vertices to view space (x right, y up, z depth), and the 2D bounds.
  let t0 = performance.now();
  const items: { mesh: number; instance: number; first: number; color: Rgb }[] = [];
  let vertexCount = 0;
  for (const m of scene.meshes)
    vertexCount += (m.positions.length / 3) * (m.matrices ? m.matrices.length / 16 : 1);
  const vs = new Float64Array(vertexCount * 3);
  let edgePointCount = 0;
  for (const m of scene.meshes)
    edgePointCount += (m.edgePositions.length / 3) * (m.matrices ? m.matrices.length / 16 : 1);
  const es = new Float64Array(edgePointCount * 3);
  const edgeFirst: number[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let vo = 0;
  let eo = 0;
  scene.meshes.forEach((m, mi) => {
    const count = m.matrices ? m.matrices.length / 16 : 1;
    for (let i = 0; i < count; i++) {
      // The instance matrix composed with the view rotation: 3 rows of (x y z t).
      let a00 = r[0],
        a01 = r[1],
        a02 = r[2],
        a03 = 0;
      let a10 = u[0],
        a11 = u[1],
        a12 = u[2],
        a13 = 0;
      let a20 = d[0],
        a21 = d[1],
        a22 = d[2],
        a23 = 0;
      if (m.matrices) {
        const M = m.matrices;
        const b = 16 * i;
        const row = (x: number, y: number, z: number) => [
          x * M[b]! + y * M[b + 1]! + z * M[b + 2]!,
          x * M[b + 4]! + y * M[b + 5]! + z * M[b + 6]!,
          x * M[b + 8]! + y * M[b + 9]! + z * M[b + 10]!,
          x * M[b + 12]! + y * M[b + 13]! + z * M[b + 14]!,
        ];
        [a00, a01, a02, a03] = row(r[0], r[1], r[2]) as [number, number, number, number];
        [a10, a11, a12, a13] = row(u[0], u[1], u[2]) as [number, number, number, number];
        [a20, a21, a22, a23] = row(d[0], d[1], d[2]) as [number, number, number, number];
      }
      const name = m.names[i]!;
      const color = o.highlight?.has(name) ? HIGHLIGHT : m.colors[i]!;
      items.push({ mesh: mi, instance: i, first: vo / 3, color });
      const P = m.positions;
      for (let k = 0; k < P.length; k += 3) {
        const x = P[k]!;
        const y = P[k + 1]!;
        const z = P[k + 2]!;
        const X = a00 * x + a01 * y + a02 * z + a03;
        const Y = a10 * x + a11 * y + a12 * z + a13;
        const Z = a20 * x + a21 * y + a22 * z + a23;
        vs[vo++] = X;
        vs[vo++] = Y;
        vs[vo++] = Z;
        if (X < minX) minX = X;
        if (X > maxX) maxX = X;
        if (Y < minY) minY = Y;
        if (Y > maxY) maxY = Y;
        if (Z < minZ) minZ = Z;
        if (Z > maxZ) maxZ = Z;
      }
      edgeFirst.push(eo / 3);
      const E = m.edgePositions;
      for (let k = 0; k < E.length; k += 3) {
        const x = E[k]!;
        const y = E[k + 1]!;
        const z = E[k + 2]!;
        es[eo++] = a00 * x + a01 * y + a02 * z + a03;
        es[eo++] = a10 * x + a11 * y + a12 * z + a13;
        es[eo++] = a20 * x + a21 * y + a22 * z + a23;
      }
    }
  });
  // Fit: model mm to supersampled pixels, centred.
  const spanX = Math.max(maxX - minX, 1e-9);
  const spanY = Math.max(maxY - minY, 1e-9);
  const scale = Math.min((W - 2 * o.margin * ss) / spanX, (H - 2 * o.margin * ss) / spanY);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const toX = (x: number) => (x - cx) * scale + W / 2;
  const toY = (y: number) => H / 2 - (y - cy) * scale;
  for (let k = 0; k < vs.length; k += 3) {
    vs[k] = toX(vs[k]!);
    vs[k + 1] = toY(vs[k + 1]!);
  }
  for (let k = 0; k < es.length; k += 3) {
    es[k] = toX(es[k]!);
    es[k + 1] = toY(es[k + 1]!);
  }
  const tTransform = performance.now() - t0;

  // 2. Triangles: depth buffer and flat colour.
  t0 = performance.now();
  const depth = new Float32Array(W * H).fill(Infinity);
  /** Per pixel: the triangle in front (its index into `planes`), -1 for the background. */
  const front = new Int32Array(W * H).fill(-1);
  let triangleCount = 0;
  for (const item of items) triangleCount += scene.meshes[item.mesh]!.indices.length / 3;
  /** Per drawn triangle: its depth plane in supersampled pixels, z = a x + b y + c. */
  const planes = new Float64Array(3 * triangleCount);
  const color = new Uint8Array(W * H * 3);
  for (let p = 0; p < W * H; p++) {
    color[3 * p] = BACKGROUND[0];
    color[3 * p + 1] = BACKGROUND[1];
    color[3 * p + 2] = BACKGROUND[2];
  }
  let triangles = 0;
  for (const item of items) {
    const I = scene.meshes[item.mesh]!.indices;
    const base = item.first;
    const [cr, cg, cb] = item.color;
    for (let t = 0; t < I.length; t += 3) {
      const ia = 3 * (base + I[t]!);
      const ib = 3 * (base + I[t + 1]!);
      const ic = 3 * (base + I[t + 2]!);
      const ax = vs[ia]!,
        ay = vs[ia + 1]!,
        az = vs[ia + 2]!;
      const bx = vs[ib]!,
        by = vs[ib + 1]!,
        bz = vs[ib + 2]!;
      const qx = vs[ic]!,
        qy = vs[ic + 1]!,
        qz = vs[ic + 2]!;
      // Signed area in pixels (y down): zero-area triangles are edge-on, skipped.
      const area = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
      if (area === 0) continue;
      const tri = triangles++;
      // Depth plane: z = a x + b y + c through the three vertices.
      {
        const pa = ((bz - az) * (qy - ay) - (qz - az) * (by - ay)) / area;
        const pb = ((qz - az) * (bx - ax) - (bz - az) * (qx - ax)) / area;
        planes[3 * tri] = pa;
        planes[3 * tri + 1] = pb;
        planes[3 * tri + 2] = az - pa * ax - pb * ay;
      }
      // The normal in view space (y up: flip the pixel y back), facing the eye.
      const ux = bx - ax,
        uy = -(by - ay),
        uz = (bz - az) * scale;
      const wx = qx - ax,
        wy = -(qy - ay),
        wz = (qz - az) * scale;
      let nx = uy * wz - uz * wy;
      let ny = uz * wx - ux * wz;
      let nz = ux * wy - uy * wx;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= nl;
      ny /= nl;
      nz /= nl;
      if (nz > 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      const key = nx * KEY[0] + ny * KEY[1] + nz * KEY[2];
      const lit = 0.42 + 0.4 * (key > 0 ? key : 0) + 0.2 * -nz;
      const s = lit > 1 ? 1 : lit;
      const R = Math.round(cr * s);
      const G = Math.round(cg * s);
      const B = Math.round(cb * s);
      let x0 = Math.floor(Math.min(ax, bx, qx));
      let x1 = Math.ceil(Math.max(ax, bx, qx));
      let y0 = Math.floor(Math.min(ay, by, qy));
      let y1 = Math.ceil(Math.max(ay, by, qy));
      if (x0 < 0) x0 = 0;
      if (y0 < 0) y0 = 0;
      if (x1 > W - 1) x1 = W - 1;
      if (y1 > H - 1) y1 = H - 1;
      const inv = 1 / area;
      // Edge functions at the first pixel centre of the box, stepped incrementally (normalised by
      // the area, so they are the barycentric weights of b-c, c-a and a-b).
      const px0 = x0 + 0.5;
      const py0 = y0 + 0.5;
      let r0 = ((bx - px0) * (qy - py0) - (by - py0) * (qx - px0)) * inv;
      let r1 = ((qx - px0) * (ay - py0) - (qy - py0) * (ax - px0)) * inv;
      const dx0 = (by - qy) * inv;
      const dy0 = (qx - bx) * inv;
      const dx1 = (qy - ay) * inv;
      const dy1 = (ax - qx) * inv;
      const dz0 = az - qz;
      const dz1 = bz - qz;
      const dx2 = -(dx0 + dx1);
      for (let y = y0; y <= y1; y++, r0 += dy0, r1 += dy1) {
        // The span of this row inside all three edges: each weight is linear in x, so its
        // non-negative part is a half-line; the loop still tests every pixel, so the span only
        // has to contain the covered pixels (a pixel of slack on each side).
        const r2 = 1 - r0 - r1;
        let lo = 0;
        let hi = x1 - x0;
        if (dx0 > 0) lo = Math.max(lo, Math.floor(-r0 / dx0));
        else if (dx0 < 0) hi = Math.min(hi, Math.ceil(r0 / -dx0));
        else if (r0 < 0) continue;
        if (dx1 > 0) lo = Math.max(lo, Math.floor(-r1 / dx1));
        else if (dx1 < 0) hi = Math.min(hi, Math.ceil(r1 / -dx1));
        else if (r1 < 0) continue;
        if (dx2 > 0) lo = Math.max(lo, Math.floor(-r2 / dx2));
        else if (dx2 < 0) hi = Math.min(hi, Math.ceil(r2 / -dx2));
        else if (r2 < 0) continue;
        if (lo > hi) continue;
        let w0 = r0 + lo * dx0;
        let w1 = r1 + lo * dx1;
        let p = y * W + x0 + lo;
        for (let x = lo; x <= hi; x++, p++, w0 += dx0, w1 += dx1) {
          if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
          const z = qz + w0 * dz0 + w1 * dz1;
          if (z < depth[p]!) {
            depth[p] = z;
            front[p] = tri;
            color[3 * p] = R;
            color[3 * p + 1] = G;
            color[3 * p + 2] = B;
          }
        }
      }
    }
  }
  const tTriangles = performance.now() - t0;

  // 3. Edge polylines, depth tested against the surfaces with a bias that grows with the line
  //    width (the brush reaches pixels of the faces meeting at the edge).
  t0 = performance.now();
  const half = (o.lineWidth * ss) / 2;
  const pixel = 1 / scale; // model mm per supersampled pixel
  // A point of an edge is visible when, at one of the 3 x 3 pixels around it, the background is
  // in front, or the triangle in front there, extended as a plane to the point's exact position,
  // is not nearer than the point: the faces meeting at an edge pass through it, while a panel in
  // front of a hidden edge is in front at the point itself, however thin. A depth bias cannot do
  // this at house scale, where 11 mm sheathing on a rafter is half a pixel.
  const bias = 0.05 * pixel + (maxZ - minZ) * 1e-7;
  let segments = 0;
  const plot = (x: number, y: number, z: number) => {
    const cx0 = Math.floor(x);
    const cy0 = Math.floor(y);
    let seen = false;
    for (let yy = Math.max(0, cy0 - 1); yy <= Math.min(H - 1, cy0 + 1) && !seen; yy++)
      for (let xx = Math.max(0, cx0 - 1); xx <= Math.min(W - 1, cx0 + 1); xx++) {
        const t = front[yy * W + xx]!;
        if (
          t === -1 ||
          planes[3 * t]! * x + planes[3 * t + 1]! * y + planes[3 * t + 2]! >= z - bias
        ) {
          seen = true;
          break;
        }
      }
    if (!seen) return;
    const x0 = Math.max(0, Math.round(x - half));
    const x1 = Math.min(W - 1, Math.round(x + half) - 1);
    const y0 = Math.max(0, Math.round(y - half));
    const y1 = Math.min(H - 1, Math.round(y + half) - 1);
    for (let yy = y0; yy <= y1; yy++)
      for (let xx = x0; xx <= x1; xx++) {
        const p = yy * W + xx;
        color[3 * p] = INK[0];
        color[3 * p + 1] = INK[1];
        color[3 * p + 2] = INK[2];
      }
  };
  if (o.edges) {
    for (let k = 0; k < items.length; k++) {
      const m = scene.meshes[items[k]!.mesh]!;
      const first = edgeFirst[k]!;
      const R = m.edgeRanges;
      for (let e = 0; e < R.length; e += 2) {
        const start = first + R[e]!;
        const n = R[e + 1]!;
        for (let i = 0; i + 1 < n; i++) {
          const a = 3 * (start + i);
          const b = a + 3;
          const ax = es[a]!,
            ay = es[a + 1]!,
            az = es[a + 2]!;
          const bx = es[b]!,
            by = es[b + 1]!,
            bz = es[b + 2]!;
          segments++;
          const steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay))));
          for (let s = 0; s <= steps; s++) {
            const f = s / steps;
            plot(ax + (bx - ax) * f, ay + (by - ay) * f, az + (bz - az) * f);
          }
        }
      }
    }
  }
  const tEdges = performance.now() - t0;

  // 4. Silhouettes: where depth jumps by more than a few pixels' worth (or the model meets the
  //    background), ink the nearer side.
  t0 = performance.now();
  if (o.outline) {
    const jump = 4 * pixel;
    const mark = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        const z = depth[p]!;
        if (x + 1 < W) {
          const q = p + 1;
          const zq = depth[q]!;
          if (z - zq > jump) mark[q] = 1;
          else if (zq - z > jump) mark[p] = 1;
        }
        if (y + 1 < H) {
          const q = p + W;
          const zq = depth[q]!;
          if (z - zq > jump) mark[q] = 1;
          else if (zq - z > jump) mark[p] = 1;
        }
      }
    // Widen the one-pixel marks to the line width.
    const reach = Math.max(0, Math.round(half) - 1);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (!mark[y * W + x]) continue;
        for (let yy = Math.max(0, y - reach); yy <= Math.min(H - 1, y + reach); yy++)
          for (let xx = Math.max(0, x - reach); xx <= Math.min(W - 1, x + reach); xx++) {
            const p = yy * W + xx;
            color[3 * p] = INK[0];
            color[3 * p + 1] = INK[1];
            color[3 * p + 2] = INK[2];
          }
      }
  }
  const tOutline = performance.now() - t0;

  // 5. Resolve the supersampled image (box filter, integer arithmetic).
  t0 = performance.now();
  const out = new Uint8Array(o.width * o.height * 3);
  const n = ss * ss;
  for (let y = 0; y < o.height; y++)
    for (let x = 0; x < o.width; x++) {
      let R = 0;
      let G = 0;
      let B = 0;
      for (let j = 0; j < ss; j++) {
        const row = (y * ss + j) * W;
        for (let i = 0; i < ss; i++) {
          const p = 3 * (row + x * ss + i);
          R += color[p]!;
          G += color[p + 1]!;
          B += color[p + 2]!;
        }
      }
      const q = 3 * (y * o.width + x);
      out[q] = ((R + (n >> 1)) / n) | 0;
      out[q + 1] = ((G + (n >> 1)) / n) | 0;
      out[q + 2] = ((B + (n >> 1)) / n) | 0;
    }
  const tResolve = performance.now() - t0;

  return {
    width: o.width,
    height: o.height,
    rgb: out,
    stats: {
      triangles,
      segments,
      mmPerPixel: pixel * ss,
      ms: {
        transform: tTransform,
        triangles: tTriangles,
        edges: tEdges,
        outline: tOutline,
        resolve: tResolve,
      },
    },
  };
}

/** Render and encode. */
export function renderPng(
  scene: Scene,
  view: View,
  options: Partial<RasterOptions> = {},
): { png: Uint8Array; image: RasterImage; encodeMs: number } {
  const image = rasterize(scene, view, options);
  const t0 = performance.now();
  const png = encodePng(image.rgb, image.width, image.height);
  return { png, image, encodeMs: performance.now() - t0 };
}
