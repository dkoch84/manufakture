// The built-in catalogs per family (ADR 0017 decision 7, T9.2b to T9.2e) and the conversions of
// motor constants to the one internal convention (decision 8). `../parts/catalog.ts` adds these
// entries to `BUILTIN_ENTRIES`, where references resolve. Data is typical and unverified unless an
// entry says otherwise.

import type { BuiltinEntry } from '../parts/catalog';
import { CONTROLLER_ENTRIES } from './controllers';
import { MOTOR_ENTRIES } from './motors';

export { KT_CONVENTIONS, KV_CONVENTIONS, OUTPUT_SIDE } from '../parts/families';
export { CONTROLLER_ENTRIES } from './controllers';
export { MOTOR_ENTRIES } from './motors';
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
];
