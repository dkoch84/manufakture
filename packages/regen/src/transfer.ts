// The buffers of a regen result (every body's mesh), for `Comlink.transfer` when the result crosses the worker
// boundary (ADR 0007 decision 6: meshes are transferred, never copied).

import { meshBuffers } from '@manufakture/kernel';
import type { RegenResult } from './types';

export function regenTransferables(result: RegenResult): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const part of result.parts) {
    for (const body of part.bodies) if (body.mesh) out.push(...meshBuffers(body.mesh));
  }
  return out;
}
