// The buffers of a regen result, for `Comlink.transfer` when the result crosses the worker
// boundary (ADR 0007 decision 6: meshes are transferred, never copied).

import { meshBuffers } from '@manufakture/kernel';
import type { RegenResult } from './types';

export function regenTransferables(result: RegenResult): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const part of result.parts) if (part.mesh) out.push(...meshBuffers(part.mesh));
  return out;
}
