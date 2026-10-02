import { describe, expect, it } from 'vitest';
import { stockFromBounds, stockFromSize, stockSize, uniformMargins } from './stock';
import type { Box3 } from './types';

const BODY: Box3 = { min: [0, 0, 0], max: [100, 50, 20] };

describe('stockFromBounds', () => {
  it('grows the body bounds by each margin', () => {
    const r = stockFromBounds(
      BODY,
      { xMin: 1, xMax: 2, yMin: 3, yMax: 4, top: 5, bottom: 6 },
      'plywood',
    );
    expect(r).toEqual({
      ok: true,
      value: { min: [-1, -3, -6], max: [102, 54, 25], material: 'plywood' },
    });
    if (r.ok) expect(stockSize(r.value)).toEqual([103, 57, 31]);
  });

  it('uniform margins: sides, then top, bottom 0 by default', () => {
    expect(uniformMargins(5)).toEqual({ xMin: 5, xMax: 5, yMin: 5, yMax: 5, top: 5, bottom: 0 });
    expect(uniformMargins(5, 1, 2)).toEqual({
      xMin: 5,
      xMax: 5,
      yMin: 5,
      yMax: 5,
      top: 1,
      bottom: 2,
    });
    const r = stockFromBounds(BODY, uniformMargins(0));
    expect(r).toEqual({ ok: true, value: { min: [0, 0, 0], max: [100, 50, 20] } });
  });

  it('rejects negative or non-finite margins and bad bounds', () => {
    const neg = stockFromBounds(BODY, { ...uniformMargins(1), yMax: -1 });
    expect(neg.ok ? undefined : neg.error).toMatchObject({ code: 'invalid-input' });
    expect(neg.ok ? '' : neg.error.message).toContain('yMax');
    expect(stockFromBounds(BODY, { ...uniformMargins(1), top: Number.NaN }).ok).toBe(false);
    expect(stockFromBounds({ min: [1, 0, 0], max: [0, 1, 1] }, uniformMargins(1)).ok).toBe(false);
    expect(stockFromBounds({ min: [0, 0, 0], max: [Infinity, 1, 1] }, uniformMargins(1)).ok).toBe(
      false,
    );
  });
});

describe('stockFromSize', () => {
  it('places the body offset in from the stock minimum corner', () => {
    const r = stockFromSize(BODY, [120, 60, 25], [10, 5, 0]);
    expect(r).toEqual({ ok: true, value: { min: [-10, -5, 0], max: [110, 55, 25] } });
  });

  it('accepts a stock exactly the size of the body', () => {
    expect(stockFromSize(BODY, [100, 50, 20], [0, 0, 0]).ok).toBe(true);
  });

  it('refuses a stock that does not contain the body, naming the axis', () => {
    const short = stockFromSize(BODY, [120, 60, 19], [10, 5, 0]);
    expect(short.ok ? undefined : short.error).toEqual({
      code: 'stock-too-small',
      message: 'The stock does not contain the body along Z.',
    });
    const shifted = stockFromSize(BODY, [120, 60, 25], [-1, 5, 0]);
    expect(shifted.ok ? undefined : shifted.error.message).toContain('along X');
  });

  it('refuses a zero size', () => {
    expect(stockFromSize(BODY, [0, 60, 25], [0, 0, 0]).ok).toBe(false);
  });
});
