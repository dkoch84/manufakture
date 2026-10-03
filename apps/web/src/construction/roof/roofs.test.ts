import type { WallMetadata } from '@manufakture/domain-construction';
import { describe, expect, it } from 'vitest';
import { FT, FT_IN } from '../construction.test-fixture';
import { checkPitch, pitchText } from './pitch';
import { levelFootprint, roofPreviewLines, wallsFootprint } from './roofs';

const wall = (points: [number, number][], closed = true): WallMetadata =>
  ({
    kind: 'wall',
    level: 'level-1',
    base: 0,
    height: 2466.975,
    points,
    closed,
    justification: 'left',
    thickness: 88.9,
    free: { start: false, end: false },
    layers: [],
    settings: {},
    overrides: [],
  }) as unknown as WallMetadata;

const close = (a: readonly number[], b: readonly number[]) =>
  a.every((v, i) => Math.abs(v - b[i]!) < 1e-6);

describe('the pitch', () => {
  it('reads slope notations and bounds the angle', () => {
    const six = checkPitch('6/12', FT_IN);
    expect(six.ok && six.value).toBeCloseTo(Math.atan(0.5), 12);
    expect(six.ok && six.expression).toEqual({
      source: '6/12',
      lengthUnit: 'in',
      angleUnit: 'deg',
    });
    expect(checkPitch('30', FT_IN)).toEqual({
      ok: false,
      message: 'Ambiguous: write 30° or 30/12',
    });
    expect(checkPitch('', FT_IN).ok).toBe(false);
    expect(checkPitch('85deg', FT_IN).ok).toBe(false);
    expect(checkPitch('-6/12', FT_IN).ok).toBe(false);
    expect(pitchText(Math.atan(0.25))).toBe('3/12');
  });
});

describe('the pitch preview', () => {
  const shed = wall([
    [0, 0],
    [16 * FT, 0],
    [16 * FT, 12 * FT],
    [0, 12 * FT],
  ]);

  it("finds the walls' rectangle and plate top", () => {
    const fp = wallsFootprint([shed])!;
    expect(fp.length).toBeCloseTo(16 * FT, 6);
    expect(fp.width).toBeCloseTo(12 * FT, 6);
    expect(fp.plate).toBeCloseTo(2466.975, 6);
    expect(wallsFootprint([])).toBeNull();
  });

  it('draws a gable: eaves, two gable ends and the ridge, risen by half the width times the pitch', () => {
    const fp = wallsFootprint([shed])!;
    const { lines, apex } = roofPreviewLines(fp, 'gable', 'long', Math.atan(0.5));
    expect(lines).toHaveLength(4);
    const rise = 6 * FT * 0.5;
    expect(close(apex, [8 * FT, 6 * FT, 2466.975 + rise])).toBe(true);
    // The ridge runs along the 16' side.
    const ridge = lines[3]!;
    expect(close(ridge[0]!, [0, 6 * FT, 2466.975 + rise])).toBe(true);
    expect(close(ridge[1]!, [16 * FT, 6 * FT, 2466.975 + rise])).toBe(true);
  });

  it('turns the ridge to the short side when asked, and draws hips to a shorter ridge', () => {
    const fp = wallsFootprint([shed])!;
    const short = roofPreviewLines(fp, 'gable', 'short', Math.atan(0.5));
    const r = short.lines[3]!;
    expect(Math.abs(r[0]![0] - r[1]![0])).toBeLessThan(1e-6);
    const hip = roofPreviewLines(fp, 'hip', 'long', Math.atan(0.5));
    const ridge = hip.lines[3]!;
    expect(Math.hypot(ridge[1]![0] - ridge[0]![0], ridge[1]![1] - ridge[0]![1])).toBeCloseTo(
      4 * FT,
      6,
    );
  });

  it('places a rectangle on a level by its corner, sides and rotation', () => {
    const fp = levelFootprint(
      { x: 100, y: 200, length: 1000, width: 500, rotation: Math.PI / 2 },
      3000,
    )!;
    const { lines } = roofPreviewLines(fp, 'gable', 'long', Math.atan(0.5));
    expect(close(lines[0]![1]!, [100, 1200, 3000])).toBe(true);
    expect(levelFootprint({ x: 0, y: 0, length: undefined, width: 1 }, 0)).toBeNull();
  });
});
