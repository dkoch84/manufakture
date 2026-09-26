// Ground grid scaling. The grid shows two decades at once: minor lines every
// 10^k mm and major lines every 10^(k+1) mm, with k chosen from the zoom.
// Minor lines fade in as they spread apart on screen and are fully opaque
// exactly when the next finer decade takes over, at which point they become
// that decade's major lines. So zooming never makes lines pop.

export interface GridLevels {
  /** Minor line spacing in mm, a power of ten. */
  minor: number;
  /** Major line spacing in mm: ten minor cells. */
  major: number;
  /** Opacity of the minor lines, 0..1. */
  minorFade: number;
  /** Side of the square the grid is drawn on, in mm. */
  extent: number;
}

/** Minor lines closer than this many CSS pixels are not drawn. */
export const MIN_MINOR_PX = 6;

/** Major cells across the drawn grid square. */
export const MAJOR_CELLS = 40;

export function gridLevels(worldPerPixel: number, minMinorPx = MIN_MINOR_PX): GridLevels {
  const wpp = Math.max(worldPerPixel, 1e-9);
  // Smallest power of ten whose on-screen spacing is at least minMinorPx.
  const k = Math.ceil(Math.log10(wpp * minMinorPx) - 1e-9);
  const minor = 10 ** k;
  const px = minor / wpp;
  const t = Math.log10(px / minMinorPx); // 0 at the threshold, 1 ten times further out
  const minorFade = smoothstep(Math.min(Math.max(t, 0), 1));
  const major = minor * 10;
  return { minor, major, minorFade, extent: major * MAJOR_CELLS };
}

/** Centre of the drawn grid square: the target, snapped to the major grid so lines do not swim. */
export function gridCenter(x: number, y: number, major: number): [number, number] {
  // `+ 0` turns a -0 from rounding a small negative into 0.
  return [Math.round(x / major) * major + 0, Math.round(y / major) * major + 0];
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}
