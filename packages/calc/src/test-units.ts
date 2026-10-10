// US customary to SI conversions for tests that check against US-unit textbook examples.

export const INCH = 0.0254;
export const FOOT = 0.3048;
export const LBF = 4.4482216152605;
export const PSI = 6894.757293168;
export const KPSI = 1000 * PSI;
export const MPSI = 1e6 * PSI;
export const MM = 1e-3;
export const MPA = 1e6;
export const GPA = 1e9;
export const KN = 1000;
export const RPM = (2 * Math.PI) / 60;

/** Relative closeness: |actual - expected| <= tol * |expected|. */
export function within(actual: number | null | undefined, expected: number, tol: number): boolean {
  if (actual === null || actual === undefined) return false;
  return Math.abs(actual - expected) <= tol * Math.abs(expected);
}
