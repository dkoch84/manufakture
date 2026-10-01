import { describe, expect, it } from 'vitest';
import { DEFAULT_FIT_TOLERANCE, boundingBox, checkBedFit, usableRegion } from './bedFit';
import type { Vec3 } from './geometry';
import { orientationPlacement } from './orientation';
import { findPrinter, type Printer } from './printers';
import { boxFaces, meshFromFaces } from './test-helpers';

function printer(id: string): Printer {
  const p = findPrinter(id);
  if (!p) throw new Error(`no printer ${id}`);
  return p;
}

const box = (min: Vec3, max: Vec3) => ({ box: { min, max } });

describe('checkBedFit', () => {
  it('a 180 mm cube fits the A1 mini and a 181 mm one does not, on x', () => {
    const a1mini = printer('bambu-a1-mini');
    const fits = checkBedFit(a1mini, box([0, 0, 0], [180, 180, 180]));
    expect(fits.fits).toBe(true);
    expect(fits.overshoot).toEqual({ x: 0, y: 0, z: 0 });
    expect(fits.exclusions).toEqual([]);

    const tooBig = checkBedFit(a1mini, box([0, 0, 0], [181, 180, 180]));
    expect(tooBig.fits).toBe(false);
    expect(tooBig.overshoot).toEqual({ x: 1, y: 0, z: 0 });

    // Centred it is still 1 mm too wide, half on each side.
    const centred = checkBedFit(a1mini, box([-0.5, 0, 0], [180.5, 180, 180]));
    expect(centred.fits).toBe(false);
    expect(centred.overshoot.x).toBeCloseTo(1, 12);
  });

  it('measures the cube from its oriented mesh', () => {
    const a1mini = printer('bambu-a1-mini');
    for (const [size, ok] of [
      [180, true],
      [181, false],
    ] as const) {
      const mesh = meshFromFaces(boxFaces([0, 0, 0], [size, size, size]));
      const placement = orientationPlacement({ kind: 'asModelled' }, mesh.positions);
      const b = boundingBox(mesh.positions, placement)!;
      const r = checkBedFit(a1mini, { box: b });
      expect(r.fits).toBe(ok);
      expect(r.overshoot.x).toBeCloseTo(size - 180, 9);
      expect(r.overshoot.z).toBeCloseTo(size - 180, 9);
    }
  });

  it('allows float noise up to the tolerance and no more', () => {
    const a1mini = printer('bambu-a1-mini');
    const t = DEFAULT_FIT_TOLERANCE;
    expect(checkBedFit(a1mini, box([-t / 2, 0, -t / 2], [180 + t / 2, 180, 180])).fits).toBe(true);
    expect(checkBedFit(a1mini, box([0, 0, 0], [180 + 2 * t, 180, 180])).fits).toBe(false);
  });

  it('reports the height overshoot and a body below the bed', () => {
    const x1c = printer('bambu-x1c');
    expect(checkBedFit(x1c, box([20, 20, 0], [100, 100, 250])).fits).toBe(true);
    const tall = checkBedFit(x1c, box([20, 20, 0], [100, 100, 251]));
    expect(tall.fits).toBe(false);
    expect(tall.overshoot).toEqual({ x: 0, y: 0, z: 1 });
    const sunk = checkBedFit(x1c, box([20, 20, -2], [100, 100, 10]));
    expect(sunk.fits).toBe(false);
    expect(sunk.overshoot.z).toBe(2);
  });

  it("an object inside the X1's excluded corner fails with the exclusion named", () => {
    const x1 = printer('bambu-x1');
    const r = checkBedFit(x1, box([2, 2, 0], [10, 10, 5]));
    expect(r.fits).toBe(false);
    expect(r.overshoot).toEqual({ x: 0, y: 0, z: 0 });
    expect(r.exclusions.map((e) => e.id)).toEqual(['origin-corner']);
    expect(r.exclusions[0]!.name).toMatch(/corner/);
  });

  it('a footprint that only overlaps part of the corner fails too; touching it is fine', () => {
    const x1c = printer('bambu-x1c');
    expect(checkBedFit(x1c, box([10, 20, 0], [100, 100, 5])).exclusions).toHaveLength(1);
    expect(checkBedFit(x1c, box([18, 0, 0], [100, 100, 5])).fits).toBe(true);
    expect(checkBedFit(x1c, box([0, 28, 0], [100, 100, 5])).fits).toBe(true);
    // The whole bed is never usable on the X1 Carbon.
    const whole = checkBedFit(x1c, box([0, 0, 0], [256, 256, 250]));
    expect(whole.fits).toBe(false);
    expect(whole.exclusions.map((e) => e.id)).toEqual(['origin-corner']);
  });

  it('on the H2D, a body using both nozzles is checked against their overlap', () => {
    const h2d = printer('bambu-h2d');
    const body = (nozzles?: number[]) => ({
      box: { min: [30, 0, 0] as Vec3, max: [320, 320, 322] as Vec3 },
      ...(nozzles ? { nozzles } : {}),
    });

    const both = checkBedFit(h2d, body([0, 1]));
    expect(both.region.area).toEqual([
      [25, 0],
      [325, 0],
      [325, 320],
      [25, 320],
    ]);
    expect(both.region.height).toBe(320);
    expect(both.region.nozzles).toEqual(['left', 'right']);
    expect(both.fits).toBe(false);
    expect(both.overshoot).toEqual({ x: 0, y: 0, z: 2 });

    // The same body with the right nozzle alone: its area and its 325 mm height.
    const right = checkBedFit(h2d, body([1]));
    expect(right.region.height).toBe(325);
    expect(right.region.nozzles).toEqual(['right']);
    expect(right.fits).toBe(true);

    // With the left nozzle alone: 320 mm high, so it does not fit.
    const left = checkBedFit(h2d, body([0]));
    expect(left.region.height).toBe(320);
    expect(left.fits).toBe(false);
  });

  it('on the H2D, a body near the left edge fits the left nozzle only', () => {
    const h2d = printer('bambu-h2d');
    const at = (nozzles: number[]) => ({
      box: { min: [5, 10, 0] as Vec3, max: [100, 100, 50] as Vec3 },
      nozzles,
    });
    expect(checkBedFit(h2d, at([0])).fits).toBe(true);
    const right = checkBedFit(h2d, at([1]));
    expect(right.fits).toBe(false);
    expect(right.overshoot.x).toBe(20);
    const both = checkBedFit(h2d, at([1, 0, 1]));
    expect(both.fits).toBe(false);
    expect(both.overshoot.x).toBe(20);
    expect(both.region.nozzles).toEqual(['left', 'right']);
  });

  it('without nozzles, a two-nozzle printer is checked against its whole printable area', () => {
    const h2d = printer('bambu-h2d');
    const r = checkBedFit(h2d, box([0, 0, 0], [350, 320, 325]));
    expect(r.region.nozzles).toEqual([]);
    expect(r.fits).toBe(true);
  });

  it('an unknown nozzle index never fits and is reported', () => {
    const h2d = printer('bambu-h2d');
    const r = checkBedFit(h2d, { box: { min: [30, 0, 0], max: [40, 10, 10] }, nozzles: [2] });
    expect(r.fits).toBe(false);
    expect(r.region.unknownNozzles).toEqual([2]);
  });

  it('single-nozzle printers ignore the nozzles passed', () => {
    const x1c = printer('bambu-x1c');
    const r = checkBedFit(x1c, { box: { min: [20, 20, 0], max: [40, 40, 10] }, nozzles: [0, 1] });
    expect(r.fits).toBe(true);
    expect(r.region.unknownNozzles).toEqual([]);
  });

  it('the X2D overlap is the right nozzle area under the lower height', () => {
    const r = usableRegion(printer('bambu-x2d'), [0, 1]);
    expect(r.area).toEqual([
      [20.5, 0],
      [256, 0],
      [256, 256],
      [20.5, 256],
    ]);
    expect(r.height).toBe(256);
    expect(usableRegion(printer('bambu-x2d'), [0]).height).toBe(261);
  });

  it('nozzle areas that do not overlap leave nothing usable', () => {
    const odd: Printer = {
      ...printer('bambu-h2d'),
      nozzleAreas: [
        {
          name: 'left',
          area: [
            [0, 0],
            [100, 0],
            [100, 100],
            [0, 100],
          ],
          height: 100,
        },
        {
          name: 'right',
          area: [
            [200, 0],
            [300, 0],
            [300, 100],
            [200, 100],
          ],
          height: 100,
        },
      ],
    };
    const r = checkBedFit(odd, { box: { min: [10, 10, 0], max: [20, 20, 5] }, nozzles: [0, 1] });
    expect(r.region.area).toEqual([]);
    expect(r.fits).toBe(false);
  });
});

describe('boundingBox', () => {
  it('bounds placed points and is null for none', () => {
    const mesh = meshFromFaces(boxFaces([0, 0, 0], [10, 20, 30]));
    const p = orientationPlacement({ kind: 'rotate', x: Math.PI / 2, y: 0, z: 0 }, mesh.positions);
    const b = boundingBox(mesh.positions, p)!;
    // About x by 90 degrees: y (0..20) -> z (0..20), z (0..30) -> -y (-30..0).
    [0, -30, 0].forEach((v, i) => expect(b.min[i]).toBeCloseTo(v, 9));
    [10, 0, 20].forEach((v, i) => expect(b.max[i]).toBeCloseTo(v, 9));
    expect(boundingBox(new Float32Array(0))).toBeNull();
    expect(boundingBox([])).toBeNull();
  });
});
