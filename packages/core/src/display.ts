// The document's display units (`DisplayUnits`, schema.ts) as `@manufakture/units` formats. Type
// imports only, so the module carries no schema code: the viewer, which must not load the rest of
// core (apps/web/src/viewer/bundleCheck.ts), formats lengths through it by the
// `@manufakture/core/display` subpath.

import type { AngleFormat, LengthFormat } from '@manufakture/units';
import type { DisplayUnits } from './schema';

/**
 * The format for lengths under these display units: the unit with its `denominator` for `ft-in`
 * and `in-fraction`, with its `decimals` otherwise. An unset precision stays unset, so the units
 * package's default applies.
 */
export function lengthFormat(units: DisplayUnits): LengthFormat {
  const l = units.length;
  if (l.unit === 'ft-in' || l.unit === 'in-fraction') {
    return l.denominator === undefined
      ? { unit: l.unit }
      : { unit: l.unit, denominator: l.denominator };
  }
  // `in`, not `l.decimals`: the inferred union does not narrow on `unit` here.
  const decimals = 'decimals' in l ? l.decimals : undefined;
  return decimals === undefined ? { unit: l.unit } : { unit: l.unit, decimals };
}

/** The format for angles under these display units. */
export function angleFormat(units: DisplayUnits): AngleFormat {
  const a = units.angle;
  return a.decimals === undefined ? { unit: a.unit } : { unit: a.unit, decimals: a.decimals };
}
