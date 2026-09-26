// The published planegcs.wasm defines a fixed 16 MiB memory (min = max = 256
// pages, no ALLOW_MEMORY_GROWTH), and a 5 MiB stack lives inside it. The spike
// found that the solver aborts with "Aborted(OOM)" on the 200-entity sketch.
// A proper fix is a rebuild with -sALLOW_MEMORY_GROWTH (or a larger
// INITIAL_MEMORY). To measure large sketches without a rebuild toolchain, the
// spike rewrites the limits of the memory section in place. This is
// spike-only: nothing in the product should ship a patched binary.

export const WASM_PAGE = 64 * 1024;

function readLeb(bytes: Uint8Array, at: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = at;
  for (;;) {
    const b = bytes[i++];
    if (b === undefined) throw new Error('truncated LEB128');
    value += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(b & 0x80)) return { value, next: i };
  }
}

/** Write `value` into exactly `length` bytes of (possibly padded) LEB128. */
function writeLeb(bytes: Uint8Array, at: number, length: number, value: number): void {
  if (value >= 2 ** (7 * length)) throw new Error(`${value} does not fit in ${length} LEB bytes`);
  let v = value;
  for (let k = 0; k < length; k++) {
    const low = v % 128;
    v = Math.floor(v / 128);
    bytes[at + k] = k < length - 1 ? low | 0x80 : low;
  }
}

export interface MemoryLimits {
  minPages: number;
  maxPages: number | null;
}

interface Located extends MemoryLimits {
  minAt: number;
  minLen: number;
  maxAt: number;
  maxLen: number;
}

function locate(bytes: Uint8Array): Located {
  let i = 8; // magic + version
  while (i < bytes.length) {
    const id = bytes[i++];
    const size = readLeb(bytes, i);
    const start = size.next;
    if (id === 5) {
      const count = readLeb(bytes, start);
      if (count.value !== 1) throw new Error('expected exactly one memory');
      const flags = bytes[count.next]!;
      const minAt = count.next + 1;
      const min = readLeb(bytes, minAt);
      if (!(flags & 1)) {
        return {
          minPages: min.value,
          maxPages: null,
          minAt,
          minLen: min.next - minAt,
          maxAt: -1,
          maxLen: 0,
        };
      }
      const max = readLeb(bytes, min.next);
      return {
        minPages: min.value,
        maxPages: max.value,
        minAt,
        minLen: min.next - minAt,
        maxAt: min.next,
        maxLen: max.next - min.next,
      };
    }
    i = start + size.value;
  }
  throw new Error('no memory section (memory imported?)');
}

export function memoryLimits(bytes: Uint8Array): MemoryLimits {
  const { minPages, maxPages } = locate(bytes);
  return { minPages, maxPages };
}

/**
 * Return a copy of the module whose memory starts (and is capped) at `pages`.
 * The encoded width of the limits is kept, so no section sizes change; with
 * the stock 2-byte encoding the ceiling is 16383 pages (just under 1 GiB).
 */
export function withMemoryPages(bytes: Uint8Array, pages: number): Uint8Array {
  const out = new Uint8Array(bytes);
  const loc = locate(out);
  writeLeb(out, loc.minAt, loc.minLen, pages);
  if (loc.maxLen) writeLeb(out, loc.maxAt, loc.maxLen, pages);
  return out;
}
