import { describe, expect, it } from 'vitest';
import { heapInUse, occtAllocator, type WasmAllocator } from './heap-probe';
import { createNodeInstance } from './node';

/** A bump allocator over a fake memory that grows in 1 MiB steps up to `max` bytes. */
function fake(used: number, size: number, max: number) {
  const memory = { buffer: new ArrayBuffer(size) } as unknown as { buffer: ArrayBuffer };
  let top = used;
  let freed = 0;
  const a: WasmAllocator = {
    memory: memory as unknown as WebAssembly.Memory,
    malloc(n) {
      if (top + n > memory.buffer.byteLength) {
        const next = memory.buffer.byteLength + (1 << 20);
        if (next > max) return 0;
        memory.buffer = new ArrayBuffer(next);
      }
      top += n;
      return top - n + 8;
    },
    free() {
      freed++;
    },
  };
  return { a, freed: () => freed };
}

describe('heapInUse', () => {
  it('counts what the allocator cannot hand out before the memory grows', () => {
    const f = fake(3 << 20, 4 << 20, 64 << 20);
    expect(heapInUse(f.a)).toBe(3 << 20);
    expect(f.freed()).toBe(17); // 16 free blocks and the one that grew the memory
  });

  it('stops when the memory cannot grow', () => {
    const f = fake(3 << 20, 4 << 20, 4 << 20);
    expect(heapInUse(f.a)).toBe(3 << 20);
    expect(f.freed()).toBe(16);
  });

  // Leaks are many small objects (B-rep entities, handles), which is what the probe is for. A fresh
  // instance has free holes smaller than a block, which the probe counts as used and which small
  // allocations fill first; so compare two amounts of work, as the N = 10 / N = 60 method does.
  it('sees 4 MiB more leaked in 1 KiB pieces on a real instance', async () => {
    const probe = async (pieces: number) => {
      const oc = await createNodeInstance();
      const a = occtAllocator(oc);
      for (let i = 0; i < pieces; i++) expect(a.malloc(1024)).not.toBe(0);
      return heapInUse(a);
    };
    const base = await probe(4096);
    const more = await probe(8192);
    expect((more - base) / (4 << 20)).toBeGreaterThan(0.7);
    expect((more - base) / (4 << 20)).toBeLessThan(1.3);
  }, 60_000);
});
