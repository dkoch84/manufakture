// @vitest-environment node
/// <reference types="node" />
// The fit-test coupon through the real regen engine, kernel, solver and text outliner, then
// through the print checks of `packages/print` for the coupon's own print setup (a Bambu Lab X1
// Carbon, 0.4 mm nozzle): every feature builds, the clearance labels are cut to their depth, both
// plates fit the bed clear of its excluded corner (and the Bambu Lab A1 mini's bed), nothing
// needs support, and the labels leave no wall or gap too thin to print.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DocumentStore, validateDocument } from '@manufakture/core';
import type { TextOutline } from '../sketcher/text';
import type { MeasureResult } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import {
  COUPON_CLEARANCES,
  analyzeThickness,
  boundingBox,
  checkBedFit,
  classifyOverhangs,
  findPrinter,
  orientationPlacement,
  printThresholds,
  type Placement,
} from '@manufakture/print';
import { RegenEngine, createTextOutliner } from '@manufakture/regen';
import { createSolverService } from '@manufakture/sketch';
import { describe, expect, it } from 'vitest';
import { insertFitVariables } from '../variables/fits';
import {
  COUPON_LABEL,
  COUPON_NAME,
  COUPON_PEG_DIAMETER,
  COUPON_PROCEDURE,
  couponCommands,
  couponDocument,
} from './coupon';

/** The hole plate's thickness, mm: the labels are cut into its top face. */
const HOLE_THICKNESS = 6;

/** The bundled font's file, read from disk: Node's fetch has no file: URLs. */
const fromDisk = async (url: URL): Promise<Response> =>
  new Response(readFileSync(fileURLToPath(url)));

describe('the fit-test coupon document', () => {
  it('is a valid document with a hole per clearance, named by its clearance', () => {
    const doc = couponDocument('coupon');
    expect(validateDocument(doc)).toEqual([]);
    expect(doc.name).toBe(COUPON_NAME);
    expect(doc.variables).toEqual([
      { name: 'peg_d', expression: { source: '6 mm', lengthUnit: 'mm', angleUnit: 'deg' } },
    ]);
    const holes = doc.parts[0]!.features.filter((f) => f.kind === 'hole');
    expect(holes.map((h) => [h.name, h.kind === 'hole' && h.diameter.source])).toEqual(
      COUPON_CLEARANCES.map((c, i) => [
        `Hole ${i + 1}: +${c.toFixed(2)} mm`,
        `#peg_d + ${c.toFixed(2)} mm`,
      ]),
    );
    // One debossed label per hole, in the bundled font, centred under or over its hole.
    expect(doc.fonts).toEqual([
      expect.objectContaining({
        id: 'font#1',
        source: expect.objectContaining({ kind: 'bundled', id: 'inter-bold' }),
      }),
    ]);
    const features = doc.parts[0]!.features;
    const sketch = features.find((f) => f.name === 'Clearance labels');
    const labels = (sketch?.kind === 'sketch' ? sketch.entities : []) as TextOutline[];
    expect(labels.map((l) => [l.source.text, l.anchor[0], l.source.font])).toEqual(
      COUPON_CLEARANCES.map((c, i) => [c.toFixed(2), 10 * (i + 1), 'font#1']),
    );
    expect(labels.every((l) => l.source.size.source === `${COUPON_LABEL.size} mm`)).toBe(true);
    expect(COUPON_LABEL.size).toBeGreaterThanOrEqual(4.2);
    expect(features.find((f) => f.name === 'Labels')).toMatchObject({
      kind: 'extrude',
      operation: 'cut',
      reverse: true,
      profile: { sketch: sketch!.id, entities: labels.map((l) => l.id) },
      extent: { type: 'blind', distance: { source: `${COUPON_LABEL.depth} mm` } },
    });
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

  it('writes the procedure: the labelled holes, and each fit by feel', () => {
    const text = COUPON_PROCEDURE.join('\n');
    expect(text).toMatch(/labelled with its clearance/);
    expect(text).toMatch(/right angles to the hole plate/);
    expect(text).toMatch(/Press fit: .*goes in with force and stays/);
    expect(text).toMatch(/Slip fit: .*slides in by hand without play/);
    expect(text).toMatch(/Sliding fit: .*moves freely/);
  });

  it('regenerates, fits the X1 Carbon bed and needs no support', async () => {
    const service = await createNodeService();
    const text = createTextOutliner({ fetchImpl: fromDisk });
    const engine = new RegenEngine({ kernel: service, solver: createSolverService(), text });
    const doc = couponDocument('coupon');
    const result = (await engine.regen(doc))!;
    const part = result.parts[0]!;
    for (const f of part.features)
      expect([f.featureId, f.status, f.errors, f.warnings]).toEqual([f.featureId, 'ok', [], []]);
    expect(part.bodies.map((b) => b.bodyId).sort()).toEqual(['extrude#1', 'extrude#3']);

    // The labels' ink: each label laid out alone, its regions' areas (outer less counters).
    let ink = 0;
    for (const c of COUPON_CLEARANCES) {
      const reply = await text.outline({
        font: { kind: 'bundled', id: 'inter-bold' },
        text: c.toFixed(2),
        size: COUPON_LABEL.size,
        align: { horizontal: 'center', vertical: 'middle' },
        letterSpacing: COUPON_LABEL.letterSpacing,
        lineSpacing: 1,
      });
      if (!reply.ok) throw new Error(reply.message);
      expect(reply.missing).toEqual([]);
      for (const r of reply.result.regions)
        ink += Math.abs(r.outer.area) - r.holes.reduce((s, h) => s + Math.abs(h.area), 0);
    }
    // Four glyphs of about 2 to 8 mm2 each at a 5 mm cap height.
    expect(ink).toBeGreaterThan(11 * 10);
    expect(ink).toBeLessThan(11 * 40);

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
      0,
    );
    const pegs = 3 * Math.PI * (COUPON_PEG_DIAMETER / 2) ** 2 * 10;
    const byId = Object.fromEntries(part.bodies.map((b, i) => [b.bodyId, volumes[i]!]));
    // Meshed circles are polygons, but the kernel measures the exact B-rep.
    expect(byId['extrude#1']).toBeCloseTo(120 * 26 * 6 - holes - ink * COUPON_LABEL.depth, 3);
    expect(byId['extrude#3']).toBeCloseTo(50 * 15 * 3 + pegs, 3);

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

    // The labels are printable: no wall between letters thinner than two line widths, no
    // stroke thinner than the minimum feature and no gap that closes up, on either plate.
    const thickness = analyzeThickness(
      meshes.map((mesh) => ({ mesh, placement })),
      { thresholds: printThresholds(doc.print.setups[0]!.nozzle) },
    );
    // The font's own knife edges read thin (the notch where a "1" meets its flag, the joins of
    // "2" and "5", as on the acceptance jig's label), but only there: every face with an issue
    // lies in the top 0.6 mm of the hole plate, where the pockets are. Nothing on the holes, the
    // pegs or the plates' sides, no gap that closes up, and (with the letter spacing) no wall
    // between neighbouring letters.
    expect(thickness.issues.filter((i) => i.kind === 'narrowGap')).toEqual([]);
    expect(new Set(thickness.issues.map((i) => i.body))).toEqual(new Set([0]));
    const plate = meshes[0]!;
    const lowest = new Map<number, number>();
    plate.triangleFaces!.forEach((face, t) => {
      for (let v = 0; v < 3; v++) {
        const z = plate.positions[3 * plate.indices[3 * t + v]! + 2]!;
        lowest.set(face, Math.min(lowest.get(face) ?? Infinity, z));
      }
    });
    const pocketFloor = HOLE_THICKNESS - COUPON_LABEL.depth - 1e-3;
    const misplaced = thickness.issues.filter((i) => !(lowest.get(i.face)! >= pocketFloor));
    expect(misplaced).toEqual([]);
    await engine.dispose();
  }, 120_000);
});
