// The buffers of a regen result (every body's mesh, of parts and of pinned sources; every changed
// member set's matrices and every new member shape mesh), for `Comlink.transfer` when the result
// crosses the worker boundary (ADR 0007 decision 6: meshes are transferred, never copied).

import { meshBuffers } from '@manufakture/kernel';
import type { MemberBodiesResult, RegenResult } from './types';

export function regenTransferables(result: RegenResult): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const owner of [...result.parts, ...(result.sources ?? [])]) {
    for (const body of owner.bodies)
      if (body.mesh) for (const b of meshBuffers(body.mesh)) out.add(b);
  }
  for (const part of result.parts) {
    for (const set of part.members ?? []) {
      for (const list of set.instances ?? []) out.add(list.matrices.buffer as ArrayBuffer);
    }
  }
  for (const mesh of result.memberMeshes?.added ?? []) {
    out.add(mesh.positions.buffer as ArrayBuffer);
    out.add(mesh.normals.buffer as ArrayBuffer);
    out.add(mesh.indices.buffer as ArrayBuffer);
  }
  return [...out];
}

/** The STEP file of a `memberBodies` result. */
export function memberBodiesTransferables(result: MemberBodiesResult): ArrayBuffer[] {
  return result.step === null ? [] : [result.step.buffer as ArrayBuffer];
}
