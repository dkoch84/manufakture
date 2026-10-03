// How the preview writes times and lengths, and its playback speeds (M5 plan, T5.3b).

/** Playback speeds: estimated machine minutes per minute of playback. */
export const PLAYBACK_SPEEDS: readonly number[] = [1, 5, 20, 100, 500];

/** Minutes as `m:ss`, or `h:mm:ss` from an hour. */
export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes)) return '-';
  const total = Math.round(minutes * 60);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** A length in mm, whole millimetres (one decimal under 10 mm). */
export function formatLength(mm: number): string {
  return `${mm < 10 ? mm.toFixed(1) : Math.round(mm).toLocaleString('en-US')} mm`;
}
