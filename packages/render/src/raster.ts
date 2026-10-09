// The software rasteriser T8.0b chose (docs/spikes/T8.0b-render.md): an orthographic camera
// fitted to the model, per-row scan conversion into a depth buffer, flat shading per triangle
// with lights fixed in view space, B-rep edges and member creases drawn over it with an exact
// plane test, silhouettes from depth jumps, 2 x 2 supersampling.
//
// Determinism: only exactly rounded IEEE operations (+ - * /, sqrt, floor, ceil, round, abs,
// min, max) in a fixed order over the scene's arrays; no transcendental function, no threads,
// no clocks. The same scene and options give the same bytes on any conforming engine.

import { BACKGROUND, HIGHLIGHT, HIGHLIGHT_EDGE, INK } from './colors';
import { normalize, type ViewBasis } from './camera';
import type { Scene, SceneMesh } from './scene';
import { err, ok, type RenderResult, type Rgb, type SectionPlane, type Vec3 } from './types';

export interface RasterOptions {
  width: number;
  height: number;
  /** Supersampling factor per axis. */
  ss: number;
  edges: boolean;
  outlines: boolean;
  highlight: readonly string[];
  hide: readonly string[];
  only: 'bodies' | 'members' | null;
  section: SectionPlane | null;
}

export interface RasterImage {
  width: number;
  height: number;
  rgb: Uint8Array;
  /** Model mm per output pixel. */
  mmPerPixel: number;
  /** Highlight patterns that matched nothing drawn. */
  unmatched: string[];
}

/** Edge and outline width, output pixels. */
const LINE_WIDTH = 1.25;
/** Highlighted edges, output pixels. */
const HIGHLIGHT_LINE_WIDTH = 2.5;
/** Empty border of a fitted image, output pixels. */
const MARGIN = 24;
/** Lighting: ambient, a key light from the upper left, a headlight (view space). */
const AMBIENT = 0.42;
const KEY_LIGHT = 0.4;
const HEADLIGHT = 0.2;
/** Towards the key light, in view space (x right, y up, z into the screen). */
const KEY = normalize([-0.45, 0.65, -0.62]);
/** A section's cut faces: the body's colour at this brightness, unshaded. */
const CAP_SHADE = 0.6;
/** An edge point is hidden when a surface is nearer by more than this, in pixels. */
const EDGE_TOLERANCE = 0.05;
/** A silhouette is a depth jump of more than this many pixels' worth. */
const SILHOUETTE_JUMP = 4;
/**
 * The narrowest view the camera frames, as a fraction of the diagonal of everything drawn (seen
 * from the camera), and in mm: a fit to something with no width (an edge seen end-on, a point)
 * or a tiny `extent` is widened to this, so the scale stays finite and sane.
 */
export const MIN_VIEW_FRACTION = 1e-4;
export const MIN_VIEW_MM = 1e-3;

/** Name patterns: exact names, or prefixes when they end in `*`; each may name its part. */
class Patterns {
  private readonly exact = new Map<string, number[]>();
  private readonly prefixes: [string, number][] = [];
  readonly hit: Uint8Array;

  constructor(readonly patterns: readonly string[]) {
    this.hit = new Uint8Array(patterns.length);
    patterns.forEach((p, i) => {
      if (p.endsWith('*')) this.prefixes.push([p.slice(0, -1), i]);
      else {
        const list = this.exact.get(p);
        if (list) list.push(i);
        else this.exact.set(p, [i]);
      }
    });
  }

  get empty(): boolean {
    return this.patterns.length === 0;
  }

  /**
   * Whether `name` (of a thing in `partId`, drawn as assembly instance `instanceId` if any)
   * matches, marking the patterns that do: the name alone, qualified with its part, or with its
   * instance.
   */
  test(partId: string, name: string | null, instanceId?: string): boolean {
    if (name === null || this.empty) return false;
    const a = this.one(name);
    const b = this.one(`${partId}/${name}`);
    const c = instanceId !== undefined && this.one(`${instanceId}/${name}`);
    return a || b || c;
  }

  private one(name: string): boolean {
    let found = false;
    const list = this.exact.get(name);
    if (list) {
      for (const i of list) this.hit[i] = 1;
      found = true;
    }
    for (const [prefix, i] of this.prefixes)
      if (name.startsWith(prefix)) {
        this.hit[i] = 1;
        found = true;
      }
    return found;
  }

  unmatched(): string[] {
    return this.patterns.filter((_, i) => !this.hit[i]);
  }
}

interface Item {
  mesh: SceneMesh;
  /** Which instance of the mesh. */
  instance: number;
  /** First vertex in the view-space vertex array, and first edge point in the edge array. */
  first: number;
  edgeFirst: number;
  color: Rgb;
  /** The instance matrix turns the mesh inside out. */
  mirrored: boolean;
  /** Per face (bodies): 1 when highlighted. */
  faceHighlight: Uint8Array | null;
  /** Per edge: 1 when highlighted. */
  edgeHighlight: Uint8Array | null;
  /** What `fit` frames of it: everything, or some faces and edges. */
  fitAll: boolean;
  fitFaces: Uint8Array | null;
  fitEdges: Uint8Array | null;
}

/** Per-name flags over a list of names, or null when none is set. */
function flags(
  patterns: Patterns,
  mesh: SceneMesh,
  names: readonly (string | null)[],
): Uint8Array | null {
  if (patterns.empty) return null;
  let out: Uint8Array | null = null;
  names.forEach((n, i) => {
    if (patterns.test(mesh.partId, n, mesh.instanceId)) {
      (out ??= new Uint8Array(names.length))[i] = 1;
    }
  });
  return out;
}

/** Render `scene` seen through `view`, to RGB bytes. */
export function rasterize(
  scene: Scene,
  view: ViewBasis,
  o: RasterOptions,
): RenderResult<RasterImage> {
  const ss = o.ss;
  const W = o.width * ss;
  const H = o.height * ss;
  const { r, u, d } = view;
  const highlight = new Patterns(o.highlight);
  const hide = new Patterns(o.hide);
  const fit = new Patterns(view.fit ?? []);

  // 1. What is drawn, and every instance's vertices and edge points in view space (x right,
  //    y up, z depth along the view direction, all in mm).
  const items: Item[] = [];
  let vertexCount = 0;
  let edgePointCount = 0;
  for (const m of scene.meshes) {
    if (o.only !== null && (o.only === 'bodies') !== (m.kind === 'body')) continue;
    const count = m.matrices ? m.matrices.length / 16 : 1;
    for (let i = 0; i < count; i++) {
      const name = m.names[i]!;
      if (hide.test(m.partId, name, m.instanceId)) continue;
      const whole = highlight.test(m.partId, name, m.instanceId);
      let mirrored = false;
      if (m.matrices) {
        const M = m.matrices;
        const b = 16 * i;
        const det =
          M[b]! * (M[b + 5]! * M[b + 10]! - M[b + 9]! * M[b + 6]!) -
          M[b + 4]! * (M[b + 1]! * M[b + 10]! - M[b + 9]! * M[b + 2]!) +
          M[b + 8]! * (M[b + 1]! * M[b + 6]! - M[b + 5]! * M[b + 2]!);
        mirrored = det < 0;
      }
      const fitAll = fit.test(m.partId, name, m.instanceId);
      items.push({
        mesh: m,
        instance: i,
        first: vertexCount,
        edgeFirst: edgePointCount,
        color: whole ? HIGHLIGHT : m.colors[i]!,
        mirrored,
        faceHighlight: whole ? null : flags(highlight, m, m.faceNames),
        edgeHighlight: flags(highlight, m, m.edgeNames),
        fitAll,
        fitFaces: fitAll ? null : flags(fit, m, m.faceNames),
        fitEdges: fitAll ? null : flags(fit, m, m.edgeNames),
      });
      vertexCount += m.positions.length / 3;
      edgePointCount += m.edgePositions.length / 3;
    }
  }
  if (items.length === 0) return err('empty', 'nothing to draw: no bodies or members are shown');
  const unmatchedFit = fit.unmatched();
  if (unmatchedFit.length > 0)
    return err('unknown-name', `fit names match nothing drawn: ${unmatchedFit.join(', ')}`);

  const vs = new Float64Array(vertexCount * 3);
  const es = new Float64Array(edgePointCount * 3);
  const all = new Bounds();
  const framed = new Bounds();
  for (const item of items) {
    const m = item.mesh;
    const i = item.instance;
    // The instance matrix composed with the view rotation: 3 rows of (x y z t).
    let a: number[] = [r[0], r[1], r[2], 0, u[0], u[1], u[2], 0, d[0], d[1], d[2], 0];
    if (m.matrices) {
      const M = m.matrices;
      const b = 16 * i;
      const row = (x: number, y: number, z: number) => [
        x * M[b]! + y * M[b + 1]! + z * M[b + 2]!,
        x * M[b + 4]! + y * M[b + 5]! + z * M[b + 6]!,
        x * M[b + 8]! + y * M[b + 9]! + z * M[b + 10]!,
        x * M[b + 12]! + y * M[b + 13]! + z * M[b + 14]!,
      ];
      a = [...row(r[0], r[1], r[2]), ...row(u[0], u[1], u[2]), ...row(d[0], d[1], d[2])];
    }
    const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23] = a as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const P = m.positions;
    let vo = 3 * item.first;
    for (let k = 0; k < P.length; k += 3) {
      const x = P[k]!;
      const y = P[k + 1]!;
      const z = P[k + 2]!;
      const X = a00 * x + a01 * y + a02 * z + a03;
      const Y = a10 * x + a11 * y + a12 * z + a13;
      vs[vo++] = X;
      vs[vo++] = Y;
      vs[vo++] = a20 * x + a21 * y + a22 * z + a23;
      all.add(X, Y);
      if (item.fitAll) framed.add(X, Y);
    }
    const E = m.edgePositions;
    let eo = 3 * item.edgeFirst;
    for (let k = 0; k < E.length; k += 3) {
      const x = E[k]!;
      const y = E[k + 1]!;
      const z = E[k + 2]!;
      es[eo++] = a00 * x + a01 * y + a02 * z + a03;
      es[eo++] = a10 * x + a11 * y + a12 * z + a13;
      es[eo++] = a20 * x + a21 * y + a22 * z + a23;
    }
    if (item.fitFaces && m.triangleFaces) {
      const I = m.indices;
      for (let t = 0; t < I.length; t += 3) {
        if (!item.fitFaces[m.triangleFaces[t / 3]! - 1]) continue;
        for (let c = 0; c < 3; c++) {
          const v = 3 * (item.first + I[t + c]!);
          framed.add(vs[v]!, vs[v + 1]!);
        }
      }
    }
    if (item.fitEdges) {
      const R = m.edgeRanges;
      for (let e = 0; e < R.length / 2; e++) {
        if (!item.fitEdges[e]) continue;
        for (let p = 0; p < R[2 * e + 1]!; p++) {
          const v = 3 * (item.edgeFirst + R[2 * e]! + p);
          framed.add(es[v]!, es[v + 1]!);
        }
      }
    }
  }

  // 2. Scale (model mm to supersampled pixels) and centre.
  const box = view.fit ? framed : all;
  if (!(box.minX <= box.maxX)) return err('empty', 'nothing to draw: the meshes are empty');
  const minView = Math.max(
    MIN_VIEW_FRACTION * Math.sqrt((all.maxX - all.minX) ** 2 + (all.maxY - all.minY) ** 2),
    MIN_VIEW_MM,
  );
  let scale: number;
  let cx: number;
  let cy: number;
  if (view.extent !== null) {
    scale = Math.min(W, H) / Math.max(view.extent, minView);
    const t = view.target;
    cx = t ? r[0] * t[0] + r[1] * t[1] + r[2] * t[2] : (box.minX + box.maxX) / 2;
    cy = t ? u[0] * t[0] + u[1] * t[1] + u[2] * t[2] : (box.minY + box.maxY) / 2;
  } else {
    const spanX = Math.max(box.maxX - box.minX, minView);
    const spanY = Math.max(box.maxY - box.minY, minView);
    const room = (n: number) => Math.max(n - 2 * MARGIN * ss, n / 2);
    scale = Math.min(room(W) / spanX, room(H) / spanY);
    cx = (box.minX + box.maxX) / 2;
    cy = (box.minY + box.maxY) / 2;
  }
  const ox = W / 2 - cx * scale;
  const oy = H / 2 + cy * scale;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let k = 0; k < vs.length; k += 3) {
    vs[k] = vs[k]! * scale + ox;
    vs[k + 1] = oy - vs[k + 1]! * scale;
    const z = vs[k + 2]!;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  for (let k = 0; k < es.length; k += 3) {
    es[k] = es[k]! * scale + ox;
    es[k + 1] = oy - es[k + 1]! * scale;
  }

  // The section as a function of pixel position and depth: s > 0 is cut away.
  //   s = n.(p - origin), p = X r + Y u + Z d, X = (px - ox) / scale, Y = (oy - py) / scale.
  let SA = 0;
  let SB = 0;
  let SC = 0;
  let SD = 0;
  const section = o.section !== null;
  if (o.section) {
    const n = normalize(o.section.normal);
    const nr = n[0] * r[0] + n[1] * r[1] + n[2] * r[2];
    const nu = n[0] * u[0] + n[1] * u[1] + n[2] * u[2];
    const nd = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
    const no = dot(n, o.section.origin);
    SA = nr / scale;
    SB = -nu / scale;
    SC = nd;
    SD = -(nr * ox) / scale + (nu * oy) / scale - no;
  }

  // 3. Triangles: depth buffer, the triangle in front per pixel, flat colour.
  const depth = new Float32Array(W * H).fill(Infinity);
  /** Per pixel: the triangle in front (its index into `planes`), -1 for the background. */
  const front = new Int32Array(W * H).fill(-1);
  let triangleCount = 0;
  for (const item of items) triangleCount += item.mesh.indices.length / 3;
  /** Per drawn triangle, then the section: its depth plane in pixels, z = a x + b y + c. */
  const planes = new Float64Array(3 * (triangleCount + 1));
  const CAP = triangleCount;
  /** Per drawn triangle: 1 when its back is seen (only inside a section's cut). */
  const backs = section ? new Uint8Array(triangleCount) : null;
  const capBias = 1e-6 * Math.max(Math.abs(minZ), Math.abs(maxZ), maxZ - minZ) + 1e-9;
  const color = new Uint8Array(W * H * 3);
  for (let p = 0; p < W * H; p++) {
    color[3 * p] = BACKGROUND[0];
    color[3 * p + 1] = BACKGROUND[1];
    color[3 * p + 2] = BACKGROUND[2];
  }
  let tri = 0;
  for (const item of items) {
    const m = item.mesh;
    const I = m.indices;
    const base = item.first;
    for (let t = 0; t < I.length; t += 3) {
      const ia = 3 * (base + I[t]!);
      const ib = 3 * (base + I[t + 1]!);
      const ic = 3 * (base + I[t + 2]!);
      const ax = vs[ia]!;
      const ay = vs[ia + 1]!;
      const az = vs[ia + 2]!;
      const bx = vs[ib]!;
      const by = vs[ib + 1]!;
      const bz = vs[ib + 2]!;
      const qx = vs[ic]!;
      const qy = vs[ic + 1]!;
      const qz = vs[ic + 2]!;
      // Signed area in pixels (y down): zero-area triangles are edge-on, skipped. A triangle
      // counter-clockwise from outside has a negative area when its front faces the eye.
      const area = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
      if (area === 0) continue;
      const index = tri++;
      const pa = ((bz - az) * (qy - ay) - (qz - az) * (by - ay)) / area;
      const pb = ((qz - az) * (bx - ax) - (bz - az) * (qx - ax)) / area;
      planes[3 * index] = pa;
      planes[3 * index + 1] = pb;
      planes[3 * index + 2] = az - pa * ax - pb * ay;
      const back = item.mirrored ? area < 0 : area > 0;
      // Inside a section, a back face wins a tie: where two solids touch (a board in a rabbet),
      // the eye is inside the first one at the plane, so the pixel is cut face.
      const shift = backs && back ? capBias : 0;
      let base3: Rgb = item.color;
      if (item.faceHighlight && m.triangleFaces && item.faceHighlight[m.triangleFaces[t / 3]! - 1])
        base3 = HIGHLIGHT;
      let R: number;
      let G: number;
      let B: number;
      if (backs && back) {
        backs[index] = 1;
        R = Math.round(item.color[0] * CAP_SHADE);
        G = Math.round(item.color[1] * CAP_SHADE);
        B = Math.round(item.color[2] * CAP_SHADE);
      } else {
        // The normal in view space (y up: flip the pixel y back), facing the eye.
        const ux = bx - ax;
        const uy = -(by - ay);
        const uz = (bz - az) * scale;
        const wx = qx - ax;
        const wy = -(qy - ay);
        const wz = (qz - az) * scale;
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
        const lit = AMBIENT + KEY_LIGHT * (key > 0 ? key : 0) + HEADLIGHT * -nz;
        const s = lit > 1 ? 1 : lit;
        R = Math.round(base3[0] * s);
        G = Math.round(base3[1] * s);
        B = Math.round(base3[2] * s);
      }
      let x0 = Math.floor(Math.min(ax, bx, qx));
      let x1 = Math.ceil(Math.max(ax, bx, qx));
      let y0 = Math.floor(Math.min(ay, by, qy));
      let y1 = Math.ceil(Math.max(ay, by, qy));
      if (x0 < 0) x0 = 0;
      if (y0 < 0) y0 = 0;
      if (x1 > W - 1) x1 = W - 1;
      if (y1 > H - 1) y1 = H - 1;
      if (x0 > x1 || y0 > y1) continue;
      const inv = 1 / area;
      // Edge functions at the first pixel centre of the box, stepped incrementally (normalised
      // by the area, so they are the barycentric weights of b-c, c-a and a-b).
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
        // non-negative part is a half-line; every pixel in the span is still tested, so the span
        // only has to contain the covered pixels (a pixel of slack on each side).
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
        const sy = SB * (y + 0.5) + SD;
        for (let x = lo; x <= hi; x++, p++, w0 += dx0, w1 += dx1) {
          if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
          const z = qz + w0 * dz0 + w1 * dz1 - shift;
          if (z < depth[p]!) {
            if (section && SA * (x0 + x + 0.5) + sy + SC * (z + shift) > 0) continue;
            depth[p] = z;
            front[p] = index;
            color[3 * p] = R;
            color[3 * p + 1] = G;
            color[3 * p + 2] = B;
          }
        }
      }
    }
  }

  // 4. A section's cut: where the back of a surface is seen, the eye looks into a solid through
  //    the plane, so the pixel is the cut face, at the plane's depth. Exact for closed meshes.
  if (backs && SC !== 0) {
    planes[3 * CAP] = -SA / SC;
    planes[3 * CAP + 1] = -SB / SC;
    planes[3 * CAP + 2] = -SD / SC;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        const t = front[p]!;
        if (t < 0 || !backs[t]) continue;
        front[p] = CAP;
        depth[p] = -(SA * (x + 0.5) + SB * (y + 0.5) + SD) / SC;
      }
  }

  // 5. Edges. A point of an edge is visible when, at one of the 3 x 3 pixels around it, the
  //    background is in front, or the surface in front there, extended as a plane to the point's
  //    exact position, is not nearer than the point: the faces meeting at an edge pass through
  //    it, while a panel in front of a hidden edge is in front at the point itself, however thin.
  //    A depth bias cannot do this at house scale (11 mm sheathing on a rafter is half a pixel).
  const pixel = 1 / scale;
  const bias = EDGE_TOLERANCE * pixel + (maxZ - minZ) * 1e-7;
  const ink = (x: number, y: number, half: number, c: Rgb) => {
    const x0 = Math.max(0, Math.round(x - half));
    const x1 = Math.min(W - 1, Math.round(x + half) - 1);
    const y0 = Math.max(0, Math.round(y - half));
    const y1 = Math.min(H - 1, Math.round(y + half) - 1);
    for (let yy = y0; yy <= y1; yy++)
      for (let xx = x0; xx <= x1; xx++) {
        const p = yy * W + xx;
        color[3 * p] = c[0];
        color[3 * p + 1] = c[1];
        color[3 * p + 2] = c[2];
      }
  };
  const visible = (x: number, y: number, z: number) => {
    if (section && SA * x + SB * y + SC * z + SD > 0) return false;
    const cx0 = Math.floor(x);
    const cy0 = Math.floor(y);
    for (let yy = Math.max(0, cy0 - 1); yy <= Math.min(H - 1, cy0 + 1); yy++)
      for (let xx = Math.max(0, cx0 - 1); xx <= Math.min(W - 1, cx0 + 1); xx++) {
        const t = front[yy * W + xx]!;
        if (
          t === -1 ||
          planes[3 * t]! * x + planes[3 * t + 1]! * y + planes[3 * t + 2]! >= z - bias
        )
          return true;
      }
    return false;
  };
  const drawEdges = (highlighted: boolean) => {
    const half = ((highlighted ? HIGHLIGHT_LINE_WIDTH : LINE_WIDTH) * ss) / 2;
    const c = highlighted ? HIGHLIGHT_EDGE : INK;
    for (const item of items) {
      if (highlighted && !item.edgeHighlight) continue;
      const R = item.mesh.edgeRanges;
      for (let e = 0; e < R.length / 2; e++) {
        if (highlighted && !item.edgeHighlight![e]) continue;
        const start = item.edgeFirst + R[2 * e]!;
        const n = R[2 * e + 1]!;
        for (let i = 0; i + 1 < n; i++) {
          const a = 3 * (start + i);
          const b = a + 3;
          const ax = es[a]!;
          const ay = es[a + 1]!;
          const az = es[a + 2]!;
          const bx = es[b]!;
          const by = es[b + 1]!;
          const bz = es[b + 2]!;
          const steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay))));
          // Only the steps where a point can still ink a pixel (Liang-Barsky against the image
          // widened by the line's half width), so the work is bounded by the image's size however
          // far the segment reaches past it. The points stepped are the unclipped segment's own,
          // so clipping changes no pixel.
          let s0 = 0;
          let s1 = steps;
          const lo = -half;
          const hiX = W + half;
          const hiY = H + half;
          if (
            ax < lo ||
            ax > hiX ||
            ay < lo ||
            ay > hiY ||
            bx < lo ||
            bx > hiX ||
            by < lo ||
            by > hiY
          ) {
            const t = clip(ax, ay, bx - ax, by - ay, lo, hiX, hiY);
            if (t === null) continue;
            s0 = Math.max(0, Math.floor(t[0] * steps));
            s1 = Math.min(steps, Math.ceil(t[1] * steps));
          }
          for (let s = s0; s <= s1; s++) {
            const f = s / steps;
            const x = ax + (bx - ax) * f;
            const y = ay + (by - ay) * f;
            if (visible(x, y, az + (bz - az) * f)) ink(x, y, half, c);
          }
        }
      }
    }
  };
  if (o.edges) drawEdges(false);
  if (!highlight.empty) drawEdges(true);

  // 6. Silhouettes: where depth jumps by more than a few pixels' worth (or the model meets the
  //    background), ink the nearer side; and the outline of a section's cut.
  if (o.outlines) {
    const jump = SILHOUETTE_JUMP * pixel;
    const mark = new Uint8Array(W * H);
    const check = (p: number, q: number) => {
      const z = depth[p]!;
      const zq = depth[q]!;
      if (z - zq > jump) mark[q] = 1;
      else if (zq - z > jump) mark[p] = 1;
      else if (backs && (front[p] === CAP) !== (front[q] === CAP))
        mark[front[p] === CAP ? p : q] = 1;
    };
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (x + 1 < W) check(p, p + 1);
        if (y + 1 < H) check(p, p + W);
      }
    // Widen the one-pixel marks to the line width.
    const reach = Math.max(0, Math.round((LINE_WIDTH * ss) / 2) - 1);
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

  // 7. Resolve the supersampled image (box filter, integer arithmetic).
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

  return ok({
    width: o.width,
    height: o.height,
    rgb: out,
    mmPerPixel: pixel * ss,
    unmatched: highlight.unmatched(),
  });
}

/**
 * The part of the segment p + t (dx, dy), t in [0, 1], inside [lo, hiX] x [lo, hiY], as its
 * parameter range, or null when none of it is.
 */
function clip(
  px: number,
  py: number,
  dx: number,
  dy: number,
  lo: number,
  hiX: number,
  hiY: number,
): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const edge = (p: number, q: number): boolean => {
    // p t <= q must hold.
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  if (
    edge(-dx, px - lo) &&
    edge(dx, hiX - px) &&
    edge(-dy, py - lo) &&
    edge(dy, hiY - py) &&
    t0 <= t1
  )
    return [t0, t1];
  return null;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

class Bounds {
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;

  add(x: number, y: number): void {
    if (x < this.minX) this.minX = x;
    if (x > this.maxX) this.maxX = x;
    if (y < this.minY) this.minY = y;
    if (y > this.maxY) this.maxY = y;
  }
}
