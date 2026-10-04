// The bundle's display unit (the document's length unit, `manifest.units.display`) as the app's
// formatters take it, so the viewer's readouts look like the app's: `1016.00 mm`, `3' 4-1/2"`.
// An unknown unit (a newer writer, or a hand-edited file) shows millimetres.

import type { DisplayUnits } from '@manufakture/core';

const LINEAR = new Set(['mm', 'cm', 'm', 'in', 'ft']);
const IMPERIAL_COMPOSITE = new Set(['ft-in', 'in-fraction']);

export function viewerUnits(display: string): DisplayUnits {
  const angle = { unit: 'deg' } as const;
  if (LINEAR.has(display)) {
    return { length: { unit: display as 'mm' | 'cm' | 'm' | 'in' | 'ft' }, angle };
  }
  if (IMPERIAL_COMPOSITE.has(display)) {
    return { length: { unit: display as 'ft-in' | 'in-fraction' }, angle };
  }
  return { length: { unit: 'mm' }, angle };
}
