// Test-only: laser export files read back into loops, for the unit tests and the e2e
// (`e2e/laser.spec.ts`). DXF through dxf-parser (closed LWPOLYLINEs with bulges, and CIRCLEs);
// SVG from the writer's own path syntax (`M`, `L`, `A`, `Z`, in millimetres with y down), turned
// back to y up. Each loop's exact signed area (counter-clockwise positive, arcs included), its
// bounds, its counts of lines and arcs, and its arcs' centres (which a mirrored or turned drawing
// would move, while its area and bounds may stay the same).

import DxfParser from 'dxf-parser';

type P = [number, number];

export interface ReadLoop {
  layer: string;
  /** Signed, mm2: counter-clockwise positive; arcs exact. */
  area: number;
  lines: number;
  arcs: number;
  min: P;
  max: P;
  /** The centre of each arc (and circle), in order. */
  centers: P[];
}

interface Piece {
  end: P;
  /** Signed sweep (counter-clockwise positive) and radius of an arc; absent for a line. */
  sweep?: number;
  radius?: number;
}

/** A loop from its start and pieces: shoelace over the ends plus each arc's circular segment. */
function loopOf(layer: string, start: P, pieces: readonly Piece[]): ReadLoop {
  let area = 0;
  let lines = 0;
  let arcs = 0;
  const centers: P[] = [];
  const pts: P[] = [start];
  let a = start;
  for (const p of pieces) {
    const b = p.end;
    area += (a[0] * b[1] - b[0] * a[1]) / 2;
    if (p.sweep === undefined || p.radius === undefined) lines++;
    else {
      arcs++;
      const t = p.sweep;
      area += ((p.radius * p.radius) / 2) * (t - Math.sin(t));
      // Samples along the arc for the bounds: the centre is off the chord's middle, to the left
      // for a counter-clockwise sweep under half a turn.
      const c = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (c > 0) {
        const u: P = [(b[0] - a[0]) / c, (b[1] - a[1]) / c];
        const k = c / 2 / Math.tan(t / 2);
        const center: P = [(a[0] + b[0]) / 2 - u[1] * k, (a[1] + b[1]) / 2 + u[0] * k];
        centers.push(center);
        const a0 = Math.atan2(a[1] - center[1], a[0] - center[0]);
        for (let i = 1; i < 64; i++) {
          const ang = a0 + (t * i) / 64;
          pts.push([center[0] + p.radius * Math.cos(ang), center[1] + p.radius * Math.sin(ang)]);
        }
      }
    }
    pts.push(b);
    a = b;
  }
  if (a[0] !== start[0] || a[1] !== start[1]) {
    area += (a[0] * start[1] - start[0] * a[1]) / 2;
    lines++;
  }
  const min: P = [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1]))];
  const max: P = [Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))];
  return { layer, area, lines, arcs, min, max, centers };
}

/** The loops of a DXF: one per closed LWPOLYLINE (bulges as arcs) and one per CIRCLE. */
export function dxfLoops(text: string): ReadLoop[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dxf-parser's types are loose
  const parsed: any = new DxfParser().parseSync(text);
  const out: ReadLoop[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
  for (const e of parsed.entities as any[]) {
    if (e.type === 'CIRCLE') {
      const r = e.radius as number;
      out.push({
        layer: e.layer,
        area: Math.PI * r * r,
        lines: 0,
        arcs: 1,
        min: [e.center.x - r, e.center.y - r],
        max: [e.center.x + r, e.center.y + r],
        centers: [[e.center.x, e.center.y]],
      });
      continue;
    }
    if (e.type !== 'LWPOLYLINE') continue;
    const v = e.vertices as { x: number; y: number; bulge?: number }[];
    const pieces: Piece[] = [];
    const n = v.length;
    for (let i = 0; i < n; i++) {
      const a = v[i]!;
      const b = v[(i + 1) % n]!;
      if (i === n - 1 && !e.shape) break;
      const bulge = a.bulge ?? 0;
      if (bulge === 0) pieces.push({ end: [b.x, b.y] });
      else {
        const t = 4 * Math.atan(bulge);
        const c = Math.hypot(b.x - a.x, b.y - a.y);
        pieces.push({ end: [b.x, b.y], sweep: t, radius: c / (2 * Math.abs(Math.sin(t / 2))) });
      }
    }
    out.push(loopOf(e.layer, [v[0]!.x, v[0]!.y], pieces));
  }
  return out;
}

/** The loops of an SVG written by `loopsToSvg`, in millimetres with y up. */
export function svgLoops(text: string): ReadLoop[] {
  const viewBox = /viewBox="([^"]+)"/.exec(text)?.[1]?.split(/\s+/).map(Number) ?? [0, 0, 0, 0];
  const height = viewBox[3]!;
  const up = (x: number, y: number): P => [x, height - y];
  const out: ReadLoop[] = [];
  const groups = text.split('<g ').slice(1);
  for (const g of groups) {
    const layer = /data-layer="([^"]*)"/.exec(g)?.[1] ?? '';
    for (const m of g.matchAll(/<path[^>]* d="([^"]+)"/g)) {
      const tokens = m[1]!.match(/[MLAZ]|-?[0-9.]+(?:e-?[0-9]+)?/g) ?? [];
      let i = 0;
      const num = () => Number(tokens[i++]);
      let start: P | null = null;
      let at: P = [0, 0];
      let pieces: Piece[] = [];
      const flush = () => {
        if (start) out.push(loopOf(layer, start, pieces));
        start = null;
        pieces = [];
      };
      while (i < tokens.length) {
        const cmd = tokens[i++];
        if (cmd === 'M') {
          flush();
          at = up(num(), num());
          start = at;
        } else if (cmd === 'L') {
          at = up(num(), num());
          pieces.push({ end: at });
        } else if (cmd === 'A') {
          const r = num();
          num(); // ry: equal for circular arcs
          num(); // rotation
          const large = num() === 1;
          // y flips: sweep-flag 1 (positive angles, y down) is clockwise with y up.
          const cw = num() === 1;
          const end = up(num(), num());
          const c = Math.hypot(end[0] - at[0], end[1] - at[1]);
          const small = 2 * Math.asin(Math.min(1, c / (2 * r)));
          const mag = large ? 2 * Math.PI - small : small;
          pieces.push({ end, sweep: cw ? -mag : mag, radius: r });
          at = end;
        } else if (cmd === 'Z') {
          flush();
        }
      }
      flush();
    }
  }
  return out;
}
