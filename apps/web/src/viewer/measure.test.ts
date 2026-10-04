import { describe, expect, it, vi } from 'vitest';
import { distanceOf, measureDelegate, nextMeasurement } from './measure';

describe('measuring', () => {
  it('takes two points, then starts again', () => {
    let m = nextMeasurement(null, [0, 0, 0]);
    expect(distanceOf(m)).toBeNull();
    m = nextMeasurement(m, [3, -4, 12]);
    expect(distanceOf(m)).toEqual({ value: 13, dx: 3, dy: 4, dz: 12 });
    m = nextMeasurement(m, [1, 1, 1]);
    expect(m).toEqual({ from: [1, 1, 1], to: null });
    expect(distanceOf(null)).toBeNull();
  });

  it('takes a press on the model and leaves one beside it to the navigation', () => {
    const onPoint = vi.fn();
    const surface = vi.fn((x: number) => (x > 10 ? ([x, 0, 0] as const) : null));
    const d = measureDelegate(surface, onPoint);
    const e = {} as PointerEvent;
    expect(d.down(e, { x: 5, y: 0 })).toBe(false);
    expect(onPoint).not.toHaveBeenCalled();
    expect(d.down(e, { x: 20, y: 0 })).toBe(true);
    expect(onPoint).toHaveBeenCalledWith([20, 0, 0]);
  });
});
