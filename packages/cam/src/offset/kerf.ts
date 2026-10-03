// Kerf compensation for laser and plasma outlines (M5 plan, T5.6b). A beam or arc removes a strip
// `kerf` wide centred on the path it follows, so a part cut along its own outline comes out
// `kerf / 2` small on every side. Moving the path by half the kerf into the waste puts the part's
// edge back where the model has it: outer loops out, holes in.
//
// Each loop is compensated on its own, as the cutter follows it: an outer loop (counter-clockwise)
// is `offsetLoops` by `+kerf / 2`, a hole (clockwise) is turned round, shrunk by `kerf / 2` and
// turned back, so a hole works on a layer of its own too (a lone clockwise loop encloses nothing
// for `offsetLoops`) and loops of different sources never merge. Arcs stay arcs (the tagged
// refit) and outside corners get round joins, the shape a round beam leaves.

import { err, ok, type CamResult, type Loop2 } from '../types';
import { reverseLoop } from '../wcs';
import { offsetLoops } from './engine';
import { loopArea } from './geometry';

export interface KerfResult {
  /**
   * The compensated loops, in the order of the loops they come from. A hole that shrinks through
   * a narrow waist can come back as several loops.
   */
  readonly loops: readonly Loop2[];
  /** How many loops vanished: holes narrower than the kerf, which close up. Zero for no kerf. */
  readonly lost: number;
}

/**
 * `loops` (outer loops counter-clockwise, holes clockwise) compensated for a cut `kerf` mm wide:
 * each offset by half the kerf, outer loops out and holes in. A zero kerf returns the loops
 * unchanged (no refit). A kerf that is negative or not finite is an `invalid-input` error; so is
 * a loop `offsetLoops` refuses (named by its index).
 */
export function kerfLoops(loops: readonly Loop2[], kerf: number): CamResult<KerfResult> {
  if (!Number.isFinite(kerf) || kerf < 0) {
    return err('invalid-input', `the kerf must be zero or more, got ${kerf}`);
  }
  if (kerf === 0) return ok({ loops: [...loops], lost: 0 });
  const d = kerf / 2;
  const out: Loop2[] = [];
  let lost = 0;
  for (const [i, loop] of loops.entries()) {
    const hole = loopArea(loop) < 0;
    const r = offsetLoops([hole ? reverseLoop(loop) : loop], hole ? -d : d);
    if (!r.ok) return err(r.error.code, `loop ${i}: ${r.error.message}`);
    if (r.value.length === 0) lost++;
    for (const region of r.value) {
      out.push(hole ? reverseLoop(region.outer) : region.outer);
      // Growing one simple loop never makes a hole, and a shrinking one has none to begin with.
      out.push(...region.holes.map((h) => (hole ? reverseLoop(h) : h)));
    }
  }
  return ok({ loops: out, lost });
}
