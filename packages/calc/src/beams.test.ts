import { describe, expect, it } from 'vitest';
import {
  cantileverPointLoad,
  cantileverUniformLoad,
  simplySupportedCentreLoad,
  simplySupportedUniformLoad,
} from './beams';
import { derivedValue } from './record';
import { GPA, INCH, LBF, MM, MPSI, within } from './test-units';

describe('beams', () => {
  it('Shigley 10th ed. Problem 4-10 (solutions manual): cantilever, point load plus uniform load, 25.4 mm', () => {
    const common = { L: 3, E: 207 * GPA, I: 4.14e6 * MM ** 4 };
    const point = cantileverPointLoad({ ...common, F: 2500, a: 2 });
    const uniform = cantileverUniformLoad({ ...common, w: 1000 });
    const total = (point.result as number) + (uniform.result as number);
    expect(within(total, 25.4 * MM, 0.002)).toBe(true);
    // Moment at the wall: 9.5e6 N·mm.
    const M = (derivedValue(point, 'M_max') as number) + (derivedValue(uniform, 'M_max') as number);
    expect(M).toBeCloseTo(9500, 6);
  });

  it('Shigley 10th ed. Problem 4-44 (solutions manual): simply supported uniform load, 1.812 in', () => {
    const r = simplySupportedUniformLoad({
      w: (250 * LBF) / INCH,
      L: 300 * INCH,
      E: 30 * MPSI,
      I: 485 * INCH ** 4,
    });
    expect(within(r.result, 1.812 * INCH, 0.001)).toBe(true);
  });

  it('closed-form check, not a textbook example: simply supported centre load F L³ / 48 E I', () => {
    const r = simplySupportedCentreLoad({ F: 1000, L: 2, E: 200 * GPA, I: 1e-6, c: 0.05 });
    expect(r.result).toBeCloseTo(8000 / 9.6e6, 12);
    expect(derivedValue(r, 'M_max')).toBeCloseTo(500, 9);
    expect(derivedValue(r, 'σ_max')).toBeCloseTo(25e6, 3);
  });

  it('closed-form check, not a textbook example: cantilever end load and the allowed deflection', () => {
    const r = cantileverPointLoad({ F: 100, L: 1, E: 200 * GPA, I: 1e-8, maxDeflection: 0.01 });
    expect(r.result).toBeCloseTo(100 / (3 * 2000), 9);
    expect(r.assumptions).toContain('Load at the free end (a = L)');
    expect(r.status).toBe('warning');
    expect(r.limitKind).toBe('at-most');
    expect(cantileverPointLoad({ F: 100, L: 1, E: 200 * GPA, I: 1e-8, a: 2 }).status).toBe(
      'unknown',
    );
  });
});
