// The buffers of a regen result (every body's mesh, of parts and of pinned sources), for `Comlink.transfer` when the result crosses the worker
// boundary (ADR 0007 decision 6: meshes are transferred, never copied).

import { meshBuffers } from '@manufakture/kernel';
import type { RegenResult } from './types';

export function regenTransferables(result: RegenResult): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const owner of [...result.parts, ...(result.sources ?? [])]) {
    for (const body of owner.bodies) if (body.mesh) out.push(...meshBuffers(body.mesh));
  }
  return out;
}
