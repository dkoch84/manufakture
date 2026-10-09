// What the latest applied regen measured for the variables' `distance(...)` and `angle(...)`
// calls (#1202), for the many places that evaluate the document's variables on their own (the
// feature dialogs, the sketcher, the wood and construction tools) without a model store at hand.
// The model store sets it whenever it shows a result; measurements are keyed by the call (the
// function and its two face names), so a list from a regen one edit behind still answers the
// calls it has, and a call it lacks is simply not measured yet.

import type { Measurement } from '@manufakture/core';

let latest: readonly Measurement[] = [];

/** Record the measurements of the result being shown. */
export function setLatestMeasurements(list: readonly Measurement[]): void {
  latest = list;
}

/** The measurements of the result shown last; empty before the first. */
export function latestMeasurements(): readonly Measurement[] {
  return latest;
}
