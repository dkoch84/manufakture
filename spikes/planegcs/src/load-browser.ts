// Browser loading: Vite serves planegcs.wasm as a separate hashed asset; the
// bytes are fetched once so the memory limits can be raised (wasm-memory.ts).

import wasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';
import { createWrapper, loadModule } from './solver.ts';

export async function loadWrapper(memoryPages: number) {
  const bytes = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
  return createWrapper(await loadModule({ wasmBytes: bytes, memoryPages }));
}
