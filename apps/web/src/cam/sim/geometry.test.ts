import { SIM_CLASS, type Heightmap } from '@manufakture/cam';
import { describe, expect, it } from 'vitest';
import { simGridData, simGridIndices, simStride } from './geometry';
import { SimulationOverlay } from './overlay';

function heightmap(nx: number, ny: number, at: (i: number, j: number) => number): Heightmap {
  const heights = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) heights[j * nx + i] = at(i, j);
  return { origin: [10, 20], cell: 0.5, nx, ny, heights };
}

describe('the displayed grid', () => {
  it('puts one vertex at each cell centre, at its height, coloured by what happened there', () => {
    const hm = heightmap(4, 3, (i) => (i === 2 ? -1 : 0));
    const classes = new Uint8Array(12);
    classes[1 * 4 + 2] = SIM_CLASS.gouge;
    classes[0] = SIM_CLASS.leftover;
    const g = simGridData(hm, 0, classes);
    expect([g.nx, g.ny, g.stride]).toEqual([4, 3, 1]);
    expect([...g.positions.subarray(0, 3)]).toEqual([10.25, 20.25, 0]);
    const v = (1 * 4 + 2) * 3;
    expect([...g.positions.subarray(v, v + 3)]).toEqual([11.25, 20.75, -1]);
    expect(g.gougeVertices).toBe(1);
    // Gouge red, leftover amber, cut lighter than untouched stock.
    expect(g.colors[v]!).toBeGreaterThan(0.5);
    expect(g.colors[v + 1]!).toBeLessThan(0.05);
    const cut = (0 * 4 + 2) * 3;
    const stock = 1 * 3;
    expect(g.colors[cut + 2]!).toBeGreaterThan(g.colors[stock + 2]!);
    expect(g.colors[0]).not.toEqual(g.colors[stock]);
  });

  it('shows a large heightmap coarser, keeping the lowest point and any gouge of each block', () => {
    expect(simStride(100, 100, 2500)).toBe(2);
    expect(simStride(10, 10, 2500)).toBe(1);
    const hm = heightmap(100, 100, (i, j) => (i === 51 && j === 7 ? -3 : 0));
    const classes = new Uint8Array(100 * 100);
    classes[9 * 100 + 99] = SIM_CLASS.gouge;
    const g = simGridData(hm, 0, classes, undefined, 2500);
    expect([g.nx, g.ny, g.stride]).toEqual([50, 50, 2]);
    expect(g.positions[(3 * 50 + 25) * 3 + 2]).toBe(-3);
    expect(g.gougeVertices).toBe(1);
    // Written into the arrays of an earlier grid of the same size.
    const again = simGridData(hm, 0, undefined, g, 2500);
    expect(again.positions).toBe(g.positions);
    expect(again.gougeVertices).toBe(0);
  });

  it('indexes two triangles per square, counter-clockwise from above', () => {
    const idx = simGridIndices(3, 2);
    expect([...idx]).toEqual([0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4]);
    expect(simGridIndices(1, 5)).toHaveLength(0);
  });

  it('draws into a group placed by the WCS frame, reusing its buffers for frames of one size', () => {
    const frame = {
      origin: [0, 0, 10] as const,
      xAxis: [1, 0, 0] as const,
      yAxis: [0, 1, 0] as const,
      zAxis: [0, 0, 1] as const,
    };
    const o = new SimulationOverlay(frame, 0);
    expect(o.root.matrix.elements[14]).toBe(10);
    o.update(heightmap(4, 3, () => 0));
    const mesh = o.root.children[0]!;
    o.update(heightmap(4, 3, () => -1));
    expect(o.root.children).toEqual([mesh]);
    o.update(heightmap(5, 3, () => -1));
    expect(o.root.children).toHaveLength(1);
    expect(o.root.children[0]).not.toBe(mesh);
    expect(o.grid?.nx).toBe(5);
    o.dispose();
    expect(o.root.children).toHaveLength(0);
  });
});
