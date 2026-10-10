// The built-in catalogs per family (ADR 0017 decision 7, T9.2b to T9.2e), the conversions of
// motor constants to the one internal convention (decision 8) and the pack builder (T9.2c).
// `../parts/catalog.ts` adds these entries to `BUILTIN_ENTRIES`, where references resolve. Data is
// typical and unverified unless an entry says otherwise.

import type { BuiltinEntry } from '../parts/catalog';
import { BMS_ENTRIES } from './bms';
import { CELL_ENTRIES } from './cells';
import { CONTROLLER_ENTRIES } from './controllers';
import { MOTOR_ENTRIES } from './motors';

export {
  KT_CONVENTIONS,
  KV_CONVENTIONS,
  OCV_SOC_PERCENT,
  OUTPUT_SIDE,
  ocvField,
} from '../parts/families';
export { BMS_ENTRIES } from './bms';
export { CELL_ENTRIES } from './cells';
export { CONTROLLER_ENTRIES } from './controllers';
export { MOTOR_ENTRIES } from './motors';
export {
  GENERIC_OCV,
  MAX_PACK_COUNT,
  buildPack,
  cellOcvCurve,
  ocvAt,
  packRatings,
  type CellRatings,
  type OcvCurve,
  type OcvPoint,
  type Pack,
  type PackResult,
  type PackSpec,
} from './pack';
export {
  KT_KV_PRODUCT,
  SIX_STEP_TO_FOC,
  motorInductance,
  motorResistance,
  motorTorqueConstant,
  motorVelocityConstant,
  type MotorRatings,
  type Normalised,
} from './conventions';

/** Every family catalog's entries, every version. */
export const FAMILY_CATALOG_ENTRIES: readonly BuiltinEntry[] = [
  ...MOTOR_ENTRIES,
  ...CONTROLLER_ENTRIES,
  ...CELL_ENTRIES,
  ...BMS_ENTRIES,
];
