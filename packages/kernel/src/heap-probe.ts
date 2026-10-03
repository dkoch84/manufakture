// Heap probe for leak measurements (from the T0.2 spike's `node-child.ts leakprobe`, shared since
// the T6.5a framing spike so benchmarks such as T6.5d use one implementation). A wasm memory
// only grows, so its size says little about what is in use; this asks the allocator instead.

import type { Oc } from './occt';

/** What the probe needs from an Emscripten module: its memory and its allocator. */
export interface WasmAllocator {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(ptr: number): void;
}

/** The allocator of a libcascade instance. */
export function occtAllocator(oc: Oc): WasmAllocator {
  const raw = oc as unknown as {
    wasmMemory: WebAssembly.Memory;
    _emscripten_builtin_malloc(size: number): number;
    _emscripten_builtin_free(ptr: number): void;
  };
  return {
    memory: raw.wasmMemory,
    malloc: (size) => raw._emscripten_builtin_malloc(size),
    free: (ptr) => raw._emscripten_builtin_free(ptr),
  };
}

/**
 * Bytes of wasm heap in use: the memory's size less what the allocator can still hand out in
 * blocks of `block` bytes (64 KiB) before the memory must grow. Coarse (one block, and
 * fragmentation counts as used), but unlike the memory's size it moves with every allocation.
 *
 * The probe disturbs the allocator and grows the memory by one step, so call it once per
 * instance, at the end. To measure a leak, run the work N times on a fresh instance (in a fresh
 * process for libcascade), probe, and compare two values of N (the T0.2 method: N = 10 and 60).
 */
export function heapInUse(a: WasmAllocator, block = 64 * 1024): number {
  const start = a.memory.buffer.byteLength;
  const blocks: number[] = [];
  let free = 0;
  for (;;) {
    const ptr = a.malloc(block);
    if (ptr === 0) break; // the memory cannot grow any further
    blocks.push(ptr);
    if (a.memory.buffer.byteLength !== start) break; // this block needed new memory
    free++;
  }
  for (const ptr of blocks) a.free(ptr);
  return start - free * block;
}
