// Export-tolerance meshes for the print workspace: asked for once per body, named like the
// viewport mesh, the viewport mesh used meanwhile, and asked again until the kernel answers.

import { describe, expect, it, vi } from 'vitest';
import { EXPORT_TOLERANCES, deflectionOf } from '@manufakture/io';
import type { MeshData } from '@manufakture/kernel';
import type { Exchanger } from '../io/exchange';
import { boxBody } from '../viewport/testMeshes';
import { MAX_RETRY_MS, PRINT_DEFLECTION, RETRY_MS, createPrintMeshes, withNames } from './meshes';

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

  it('keeps asking for a request a regen dropped, backing off, until the kernel answers', async () => {
    // Every document change (an item added, laid flat) supersedes the request in flight; more
    // drops than a fixed number of tries must not leave the body on its viewport mesh for good.
    const fine = finer();
    let drops = 6;
    const tessellate = vi.fn<Tessellate>(async () =>
      drops-- > 0
        ? { ok: false as const, message: 'The kernel dropped the request; try again.' }
        : { ok: true as const, value: [{ name: 'Body', mesh: fine }] },
    );
    const meshes = createPrintMeshes({ tessellate });
    const v = view();
    expect(meshes.retryIn([v])).toBe(RETRY_MS);
    const waits: (number | null)[] = [];
    for (let i = 0; i < 6; i++) {
      expect(await meshes.request([v])).toBe(false);
      expect(meshes.waiting([v])).toBe(true);
      expect(meshes.meshOf(v)).toBe(v);
      waits.push(meshes.retryIn([v]));
    }
    expect(waits).toEqual([400, 800, 1600, 3200, MAX_RETRY_MS, MAX_RETRY_MS]);
    expect(await meshes.request([v])).toBe(true);
    expect(meshes.meshOf(v).mesh.positions).toBe(fine.positions);
    expect(meshes.waiting([v])).toBe(false);
    expect(meshes.retryIn([v])).toBeNull();
    expect(tessellate).toHaveBeenCalledTimes(7);
  });

  it('asks again after the exchanger throws', async () => {
    const fine = finer();
    const tessellate = vi
      .fn<Tessellate>()
      .mockRejectedValueOnce(new Error('worker restarted'))
      .mockResolvedValue({ ok: true, value: [{ name: 'Body', mesh: fine }] });
    const meshes = createPrintMeshes({ tessellate });
    const v = view();
    expect(await meshes.request([v])).toBe(false);
    expect(meshes.waiting([v])).toBe(true);
    expect(await meshes.request([v])).toBe(true);
    expect(meshes.meshOf(v).mesh.positions).toBe(fine.positions);
  });

  it('settles on the viewport mesh only when the kernel answers with another shape', async () => {
    const fine = finer();
    const tessellate = vi.fn<Tessellate>(async () => ({
      ok: true as const,
      value: [{ name: 'Body', mesh: { ...fine, faceRanges: fine.faceRanges.slice(2) } }],
    }));
    const meshes = createPrintMeshes({ tessellate });
    const v = view();
    expect(await meshes.request([v])).toBe(false);
    expect(meshes.waiting([v])).toBe(false);
    expect(meshes.meshOf(v)).toBe(v);
  });

  it('asks once per viewport mesh when items share a body', async () => {
    const fine = finer();
    const tessellate = vi.fn<Tessellate>(async (ids) => ({
      ok: true as const,
      value: ids.map(() => ({ name: 'Body', mesh: fine })),
    }));
    const meshes = createPrintMeshes({ tessellate });
    const v = view();
    expect(await meshes.request([v, { ...v, id: 'copy' }])).toBe(true);
    expect(tessellate).toHaveBeenCalledWith(['part#1/extrude#1'], PRINT_DEFLECTION);
  });

  it('checks the viewport meshes when there is no kernel', async () => {
    const meshes = createPrintMeshes(null);
    const v = view();
    expect(meshes.waiting([v])).toBe(false);
    expect(await meshes.request([v])).toBe(false);
    expect(meshes.meshOf(v)).toBe(v);
  });
});
