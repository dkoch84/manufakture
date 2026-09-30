// @vitest-environment node
/// <reference types="node" />
// The demo document through the real regen engine, kernel and solver: every feature builds, every
// face is named, and the body is the demo part the e2e tests measure (a 60 x 40 x 20 block, every
// edge filleted at 3 mm, a through hole of radius 8).

import type { MeasureResult } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import { RegenEngine } from '@manufakture/regen';
import { createSolverService } from '@manufakture/sketch';
import { describe, expect, it } from 'vitest';
import { DEMO_PART_NAME, demoDocument } from './demo';

describe('the demo document', () => {
  it('regenerates into the named demo part', async () => {
    const service = await createNodeService();
    const engine = new RegenEngine({ kernel: service, solver: createSolverService() });
    const doc = demoDocument();
    expect(doc.parts[0]!.name).toBe(DEMO_PART_NAME);
    const result = (await engine.regen(doc))!;
    const part = result.parts[0]!;
    expect(part.features.map((f) => [f.featureId, f.status, f.errors])).toEqual([
      ['sketch#1', 'ok', []],
      ['extrude#1', 'ok', []],
      ['fillet#1', 'ok', []],
      ['sketch#2', 'ok', []],
      ['extrude#2', 'ok', []],
    ]);
    expect(part.bodies.map((b) => b.bodyId)).toEqual(['extrude#1']);
    const mesh = part.bodies[0]!.mesh!;
    const names = Array.from(mesh.faceNames, (i) => result.names[i]!);
    expect(names).toContain('extrude#1:cap:end');
    expect(names).toContain('extrude#2:side:e5');
    expect(names.some((n) => n.startsWith('fillet#1:corner:'))).toBe(true);

    const reply = await service.run({
      generation: engine.generation,
      ops: [{ op: 'measure', shape: part.bodies[0]!.shape, targets: [], body: true }],
    });
    const r = reply.results[0]!;
    if (!r.ok) throw new Error(r.error.message);
    const body = (r.value as MeasureResult).body!;
    // The block with rounded edges and corners (an inner block grown by a 3 mm ball), less the
    // hole, which cuts through the flat top and bottom only.
    const r3 = 3;
    const [a, b, c] = [60 - 2 * r3, 40 - 2 * r3, 20 - 2 * r3];
    const block =
      a * b * c +
      2 * r3 * (a * b + b * c + c * a) +
      Math.PI * r3 * r3 * (a + b + c) +
      (4 / 3) * Math.PI * r3 ** 3;
    const hole = Math.PI * 8 * 8 * 20;
    expect(body.volume).toBeCloseTo(block - hole, 0);
    expect(body.boundingBox!.min).toEqual([
      expect.closeTo(-30, 6),
      expect.closeTo(-20, 6),
      expect.closeTo(0, 6),
    ]);
    expect(body.boundingBox!.max).toEqual([
      expect.closeTo(30, 6),
      expect.closeTo(20, 6),
      expect.closeTo(20, 6),
    ]);
    await engine.dispose();
  }, 60_000);
});
