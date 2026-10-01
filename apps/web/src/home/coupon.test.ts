// @vitest-environment node
/// <reference types="node" />
// The fit-test coupon through the real regen engine, kernel and solver, then through the print
// checks of `packages/print` for the coupon's own print setup (a Bambu Lab X1 Carbon, 0.4 mm
// nozzle): every feature builds, both plates fit the bed clear of its excluded corner (and the
// Bambu Lab A1 mini's bed), and nothing needs support.

import { DocumentStore, validateDocument } from '@manufakture/core';
import type { MeasureResult } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import {
  COUPON_CLEARANCES,
  boundingBox,
  checkBedFit,
  classifyOverhangs,
  findPrinter,
  orientationPlacement,
  type Placement,
} from '@manufakture/print';
import { RegenEngine } from '@manufakture/regen';
import { createSolverService } from '@manufakture/sketch';
import { describe, expect, it } from 'vitest';
import { insertFitVariables } from '../variables/fits';
import {
  COUPON_NAME,
  COUPON_PEG_DIAMETER,
  COUPON_PROCEDURE,
  couponCommands,
  couponDocument,
} from './coupon';

describe('the fit-test coupon document', () => {
  it('is a valid document with a hole per clearance, named by its clearance', () => {
    const doc = couponDocument('coupon');
    expect(validateDocument(doc)).toEqual([]);
    expect(doc.name).toBe(COUPON_NAME);
    expect(doc.variables).toEqual([
      { name: 'peg_d', expression: { source: '6 mm', lengthUnit: 'mm', angleUnit: 'deg' } },
    ]);
    const holes = doc.parts[0]!.features.filter((f) => f.kind === 'hole');
    expect(holes).toHaveLength(COUPON_CLEARANCES.length + 1);
    expect(holes.slice(0, 11).map((h) => [h.name, h.kind === 'hole' && h.diameter.source])).toEqual(
      COUPON_CLEARANCES.map((c, i) => [
        `Hole ${i + 1}: +${c.toFixed(2)} mm`,
        `#peg_d + ${c.toFixed(2)} mm`,
      ]),
    );
    expect(holes.at(-1)!.name).toMatch(/^Marker/);
    expect(doc.print.setups).toEqual([
      expect.objectContaining({ printer: 'bambu-x1c', nozzle: 0.4, items: [expect.anything()] }),
    ]);
  });

  it('builds fresh ids every time and a store accepts it', () => {
    expect(couponDocument('a').id).toBe('a');
    expect(couponDocument().id).not.toBe(couponDocument().id);
    expect(DocumentStore.create(couponDocument('b')).ok).toBe(true);
    expect(couponCommands()[0]).toMatchObject({ type: 'setVariable', name: 'peg_d' });
  });

  it('takes its fit variables from its X1 Carbon setup', () => {
    const r = insertFitVariables(couponDocument('c'));
    expect(r.defaults).toMatchObject({ family: 'bambu-lab', nozzle: 0.4, basis: 'table' });
    expect(r.message).toMatch(/Bambu Lab X1 Carbon/);
  });

  it('writes the procedure: hole 1 by the marker, and each fit by feel', () => {
    const text = COUPON_PROCEDURE.join('\n');
    expect(text).toMatch(/marker/);
    expect(text).toMatch(/right angles to the hole plate/);
    expect(text).toMatch(/Press fit: .*goes in with force and stays/);
    expect(text).toMatch(/Slip fit: .*slides in by hand without play/);
    expect(text).toMatch(/Sliding fit: .*moves freely/);
  });

  it('regenerates, fits the X1 Carbon bed and needs no support', async () => {
    const service = await createNodeService();
    const engine = new RegenEngine({ kernel: service, solver: createSolverService() });
    const doc = couponDocument('coupon');
    const result = (await engine.regen(doc))!;
    const part = result.parts[0]!;
    for (const f of part.features)
      expect([f.featureId, f.status, f.errors]).toEqual([f.featureId, 'ok', []]);
    expect(part.bodies.map((b) => b.bodyId).sort()).toEqual(['extrude#1', 'extrude#2']);

    // Hole n of the plate is #peg_d + its clearance: measure the hole plate's volume.
    const reply = await service.run({
      generation: engine.generation,
      ops: part.bodies.map((b) => ({
        op: 'measure' as const,
        shape: b.shape,
        targets: [],
        body: true,
      })),
    });
    const volumes = reply.results.map((r) => {
      if (!r.ok) throw new Error(r.error.message);
      return (r.value as MeasureResult).body!.volume;
    });
    const holes = COUPON_CLEARANCES.reduce(
      (sum, c) => sum + Math.PI * ((COUPON_PEG_DIAMETER + c) / 2) ** 2 * 6,
      Math.PI * 1 * 1 * 6,
    );
    const pegs = 3 * Math.PI * (COUPON_PEG_DIAMETER / 2) ** 2 * 10;
    const byId = Object.fromEntries(part.bodies.map((b, i) => [b.bodyId, volumes[i]!]));
    // Meshed circles are polygons, but the kernel measures the exact B-rep.
    expect(byId['extrude#1']).toBeCloseTo(120 * 20 * 6 - holes, 3);
    expect(byId['extrude#2']).toBeCloseTo(50 * 15 * 3 + pegs, 3);

    // T3.1's checks on the coupon's printer: placed as modelled, moved to the bed's middle.
    const printer = findPrinter(doc.print.setups[0]!.printer)!;
    const meshes = part.bodies.map((b) => b.mesh!);
    const positions = meshes.map((m) => m.positions);
    const dropped = orientationPlacement({ kind: 'asModelled' }, positions);
    const box0 = boundingBox(positions, dropped)!;
    const placement: Placement = {
      rotation: dropped.rotation,
      translation: [
        128 - (box0.min[0] + box0.max[0]) / 2,
        128 - (box0.min[1] + box0.max[1]) / 2,
        dropped.translation[2],
      ],
    };
    const fit = checkBedFit(printer, { box: boundingBox(positions, placement)! });
    expect(fit.fits).toBe(true);
    expect(fit.exclusions).toEqual([]);
    // The plan's acceptance names the A1 mini (180 mm bed): the same placement fits there too.
    const mini = findPrinter('bambu-a1-mini')!;
    const miniBox = boundingBox(positions, {
      ...placement,
      translation: [
        90 - (box0.min[0] + box0.max[0]) / 2,
        90 - (box0.min[1] + box0.max[1]) / 2,
        dropped.translation[2],
      ],
    })!;
    expect(checkBedFit(mini, { box: miniBox }).fits).toBe(true);
    // Even pushed into the corner the X1 Carbon excludes, it is refused, so the check is live.
    const corner: Placement = { ...placement, translation: [0, 0, dropped.translation[2]] };
    expect(checkBedFit(printer, { box: boundingBox(positions, corner)! }).fits).toBe(false);

    for (const mesh of meshes) {
      const o = classifyOverhangs(mesh, { placement, bedZ: 0 });
      expect(
        Array.from(o.faces, (f) => f.worst).filter((w) => w === 'overhang' || w === 'downwardFlat'),
      ).toEqual([]);
    }
    await engine.dispose();
  }, 120_000);
});
