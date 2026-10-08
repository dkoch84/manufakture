// Small hand-made scenes and a PNG decoder, for the tests that need no kernel.

import { unzlibSync } from 'fflate';
import type { SceneMesh } from '../scene';
import type { Rgb, Vec3 } from '../types';

/**
 * An axis-aligned box as a body mesh: six faces (named `<name>:x-`, `:x+`, `:y-`, ...), two
 * triangles each, counter-clockwise from outside, and its twelve edges (named `<name>:e0` ...).
 */
export function boxMesh(
  name: string,
  min: Vec3,
  max: Vec3,
  color: Rgb = [0xc2, 0xca, 0xd3],
  partId = 'part#1',
): SceneMesh {
  const c = (i: number): Vec3 => [
    i & 1 ? max[0] : min[0],
    i & 2 ? max[1] : min[1],
    i & 4 ? max[2] : min[2],
  ];
  // Corner indices per face, counter-clockwise seen from outside.
  const faces: [string, number[]][] = [
    ['x-', [0, 4, 6, 2]],
    ['x+', [1, 3, 7, 5]],
    ['y-', [0, 1, 5, 4]],
    ['y+', [2, 6, 7, 3]],
    ['z-', [0, 2, 3, 1]],
    ['z+', [4, 5, 7, 6]],
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  const triangleFaces: number[] = [];
  faces.forEach(([, q], f) => {
    const b = positions.length / 3;
    for (const i of q) positions.push(...c(i));
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
    triangleFaces.push(f + 1, f + 1);
  });
  const pairs = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  const edgePositions: number[] = [];
  const edgeRanges: number[] = [];
  pairs.forEach(([a, b], e) => {
    edgeRanges.push(2 * e, 2);
    edgePositions.push(...c(a!), ...c(b!));
  });
  return {
    kind: 'body',
    partId,
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    edgePositions: new Float32Array(edgePositions),
    edgeRanges: new Uint32Array(edgeRanges),
    triangleFaces: new Uint32Array(triangleFaces),
    faceNames: faces.map(([n]) => `${name}:${n}`),
    edgeNames: pairs.map((_, e) => `${name}:e${e}`),
    matrices: null,
    colors: [color],
    names: [name],
  };
}

/** Decode an 8-bit RGB PNG as `encodePng` writes it (one IDAT, no interlace). */
export function decodePng(png: Uint8Array): { width: number; height: number; rgb: Uint8Array } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let o = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (o < png.length) {
    const len = view.getUint32(o);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    const data = png.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(o + 8);
      height = view.getUint32(o + 12);
    } else if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const raw = unzlibSync(idat.length === 1 ? idat[0]! : concat(idat));
  const stride = width * 3;
  const rgb = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)]!;
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i]!;
      const a = i >= 3 ? rgb[y * stride + i - 3]! : 0;
      const b = y > 0 ? rgb[(y - 1) * stride + i]! : 0;
      const c = i >= 3 && y > 0 ? rgb[(y - 1) * stride + i - 3]! : 0;
      let pred = 0;
      if (type === 1) pred = a;
      else if (type === 2) pred = b;
      else if (type === 3) pred = (a + b) >> 1;
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      rgb[y * stride + i] = (x + pred) & 0xff;
    }
  }
  return { width, height, rgb };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** How many pixels have exactly colour `c`. */
export function count(rgb: Uint8Array, c: Rgb): number {
  let n = 0;
  for (let i = 0; i < rgb.length; i += 3)
    if (rgb[i] === c[0] && rgb[i + 1] === c[1] && rgb[i + 2] === c[2]) n++;
  return n;
}

/** Whether the pixel at (x, y) is colour `c`. */
export function pixelIs(img: { width: number; rgb: Uint8Array }, x: number, y: number, c: Rgb) {
  const p = 3 * (y * img.width + x);
  return img.rgb[p] === c[0] && img.rgb[p + 1] === c[1] && img.rgb[p + 2] === c[2];
}

/** The colour of the pixel at (x, y). */
export function colorAt(img: { width: number; rgb: Uint8Array }, x: number, y: number): Rgb {
  const p = 3 * (y * img.width + x);
  return [img.rgb[p]!, img.rgb[p + 1]!, img.rgb[p + 2]!];
}
