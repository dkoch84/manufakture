import { describe, expect, it } from 'vitest';
import { MAJOR_CELLS, gridCenter, gridLevels } from './grid';

describe('grid scaling', () => {
  it('picks the smallest decade that is at least the minimum spacing on screen', () => {
    // 0.1 mm per pixel: 1 mm lines would be 10 px apart, above 6 px.
    expect(gridLevels(0.1).minor).toBe(1);
    // 0.2 mm per pixel: 1 mm is 5 px, too dense, so 10 mm.
    expect(gridLevels(0.2).minor).toBe(10);
    expect(gridLevels(0.2).major).toBe(100);
  });

  it('scales with zoom: ten times the world per pixel gives ten times the spacing', () => {
    expect(gridLevels(1).minor * 10).toBeCloseTo(gridLevels(10).minor);
    expect(gridLevels(0.001).minor).toBeCloseTo(0.01);
    expect(gridLevels(1000).minor).toBe(10_000);
  });

  it('fades minor lines in from invisible at the threshold to opaque a decade later', () => {
    const minPx = 6;
    // Exactly at the threshold: minor lines 6 px apart.
    expect(gridLevels(1 / minPx, minPx).minorFade).toBeCloseTo(0, 6);
    // Just before the next decade takes over, minor lines are almost opaque.
    expect(gridLevels(10 / (minPx * 10) + 1e-6, minPx).minorFade).toBeGreaterThan(0.99);
  });

  it('is continuous across a decade switch: the old major lines become opaque minor lines', () => {
    const minPx = 6;
    const boundary = 1 / minPx; // world per pixel where 1 mm lines hit 6 px
    const finer = gridLevels(boundary * 0.9999, minPx);
    const coarser = gridLevels(boundary * 1.0001, minPx);
    expect(finer.minor).toBe(1);
    expect(finer.minorFade).toBeLessThan(0.01);
    expect(coarser.minor).toBe(10);
    expect(coarser.minor).toBe(finer.major);
    expect(coarser.minorFade).toBeGreaterThan(0.99);
  });

  it('draws a fixed number of major cells', () => {
    const g = gridLevels(0.5);
    expect(g.extent).toBe(g.major * MAJOR_CELLS);
  });

  it('never breaks on zero or negative input', () => {
    const g = gridLevels(0);
    expect(Number.isFinite(g.minor)).toBe(true);
    expect(g.minor).toBeGreaterThan(0);
  });

  it('snaps the grid centre to the major lines', () => {
    expect(gridCenter(123, -47, 100)).toEqual([100, 0]);
    expect(gridCenter(151, 49, 100)).toEqual([200, 0]);
  });
});
