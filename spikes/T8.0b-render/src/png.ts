// A PNG encoder for 8-bit RGB images: per-row adaptive filtering (the filter with the least sum of
// absolute values, as libpng's heuristic), zlib through fflate (already in the tree: packages/io,
// apps/web). Deterministic: no timestamps, no text chunks, fixed compression level.

// fflate by path: the spike has no package.json, and packages/io depends on it.
import { zlibSync } from '../../../packages/io/node_modules/fflate/esm/index.mjs';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Filtered scanlines (filter byte + row), each row with the cheapest of the five filters. */
function filtered(rgb: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 3;
  const out = new Uint8Array((stride + 1) * height);
  const candidate = new Uint8Array(stride);
  const best = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const prev = row - stride;
    let bestSum = Infinity;
    let bestType = 0;
    for (let type = 0; type < 5; type++) {
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const x = rgb[row + i]!;
        const a = i >= 3 ? rgb[row + i - 3]! : 0;
        const b = y > 0 ? rgb[prev + i]! : 0;
        const c = i >= 3 && y > 0 ? rgb[prev + i - 3]! : 0;
        const v =
          type === 0
            ? x
            : type === 1
              ? x - a
              : type === 2
                ? x - b
                : type === 3
                  ? x - ((a + b) >> 1)
                  : x - paeth(a, b, c);
        const byte = v & 0xff;
        candidate[i] = byte;
        sum += byte < 128 ? byte : 256 - byte;
        if (sum >= bestSum) break;
      }
      if (sum < bestSum) {
        bestSum = sum;
        bestType = type;
        best.set(candidate);
      }
    }
    out[y * (stride + 1)] = bestType;
    out.set(best, y * (stride + 1) + 1);
  }
  return out;
}

export function encodePng(
  rgb: Uint8Array,
  width: number,
  height: number,
  level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 9,
): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlibSync(filtered(rgb, width, height), { level })),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
