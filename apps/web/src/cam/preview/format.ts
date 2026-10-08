// How the preview writes times and lengths, and its playback speeds (M5 plan, T5.3b).

/** Playback speeds: estimated machine minutes per minute of playback. */
export const PLAYBACK_SPEEDS: readonly number[] = [1, 5, 20, 100, 500];

/** Minutes as `m:ss`, or `h:mm:ss` from an hour, as the setup sheet writes them. */
export { formatMinutes } from '@manufakture/cam/export';

/** A length in mm, whole millimetres (one decimal under 10 mm). */
export function formatLength(mm: number): string {
  return `${mm < 10 ? mm.toFixed(1) : Math.round(mm).toLocaleString('en-US')} mm`;
}
