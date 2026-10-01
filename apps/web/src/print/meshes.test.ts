// Export-tolerance meshes for the print workspace: asked for once per body, named like the
// viewport mesh, and the viewport mesh used meanwhile or when they cannot be had.

import { describe, expect, it, vi } from 'vitest';
import { EXPORT_TOLERANCES, deflectionOf } from '@manufakture/io';
import type { MeshData } from '@manufakture/kernel';
import type { Exchanger } from '../io/exchange';
import { boxBody } from '../viewport/testMeshes';
import { MAX_TRIES, PRINT_DEFLECTION, createPrintMeshes, withNames } from './meshes';

type Tessellate = Exchanger['tessellate'];

const view = () => boxBody({ id: 'part#1/extrude#1' });
/** The same box meshed again: new arrays, names not filled in. */
const finer = () => boxBody({ id: 'part#1/extrude#1', named: false }).mesh;

describe('print meshes', () => {
  it('asks at the export tolerance io calls normal', () => {
    expect(PRINT_DEFLECTION).toEqual(deflectionOf(EXPORT_TOLERANCES.normal));
  });

  it('takes the viewport mesh names, and refuses a mesh of another shape', () => {
    const v = view();
    const fine = finer();
    const named = withNames(v, fine)!;
    expect(named.mesh.positions).toBe(fine.positions);
    expect(named.mesh.faceNames).toBe(v.mesh.faceNames);
    expect(named.mesh.edgeNames).toBe(v.mesh.edgeNames);
    expect(named.names).toBe(v.names);
    const fewer: MeshData = { ...fine, faceRanges: fine.faceRanges.slice(2) };
    expect(withNames(v, fewer)).toBeNull();
  });

  it('uses the viewport mesh until the finer one arrives, then that one, asking once', async () => {
    const fine = finer();
    const tessellate = vi.fn<Tessellate>(async () => ({
      ok: true as const,
      value: [{ name: 'Body', mesh: fine }],
    }));
    const meshes = createPrintMeshes({ tessellate });
    const v = view();
    expect(meshes.meshOf(v)).toBe(v);
    expect(meshes.waiting([v])).toBe(true);
    expect(await meshes.request([v])).toBe(true);
    expect(tessellate).toHaveBeenCalledWith(['part#1/extrude#1'], PRINT_DEFLECTION);
    const got = meshes.meshOf({ ...v, color: '#ff0000' });
    expect(got.mesh.positions).toBe(fine.positions);
    expect(got.color).toBe('#ff0000');
    expect(meshes.waiting([v])).toBe(false);
    expect(await meshes.request([v])).toBe(false);
    expect(tessellate).toHaveBeenCalledTimes(1);
  });

  it('retries a request a regen dropped, then gives up on it', async () => {
    const tessellate = vi.fn<Tessellate>(async () => ({ ok: false as const, message: 'dropped' }));
    const meshes = createPrintMeshes({ tessellate });
    const v = view();
    for (let i = 0; i < MAX_TRIES; i++) expect(await meshes.request([v])).toBe(false);
    expect(meshes.waiting([v])).toBe(false);
    expect(meshes.meshOf(v)).toBe(v);
    await meshes.request([v]);
    expect(tessellate).toHaveBeenCalledTimes(MAX_TRIES);
  });

  it('checks the viewport meshes when there is no kernel', async () => {
    const meshes = createPrintMeshes(null);
    const v = view();
    expect(meshes.waiting([v])).toBe(false);
    expect(await meshes.request([v])).toBe(false);
    expect(meshes.meshOf(v)).toBe(v);
  });
});
