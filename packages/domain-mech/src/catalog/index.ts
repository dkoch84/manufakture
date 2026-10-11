// The built-in catalogs per family (ADR 0017 decision 7, T9.2b to T9.2e: motors and controllers,
// cells and BMS, bearings, belts, pulleys, gears and rope, wire, connectors, fuses, switches and
// braking resistors), the conversions of motor constants to the
// one internal convention (decision 8) and the pack builder (T9.2c).
// `../parts/catalog.ts` adds these entries to `BUILTIN_ENTRIES`, where references resolve. Data is
// typical and unverified unless an entry says otherwise.

import type { BuiltinEntry } from '../parts/catalog';
import { BEARING_ENTRIES } from './bearings';
import { BELT_ENTRIES, PULLEY_ENTRIES } from './belts';
import { BMS_ENTRIES } from './bms';
import { CELL_ENTRIES } from './cells';
import { CONNECTOR_ENTRIES } from './connectors';
import { CONTROLLER_ENTRIES } from './controllers';
import { FUSE_ENTRIES } from './fuses';
import { GEAR_ENTRIES } from './gears';
import { MOTOR_ENTRIES } from './motors';
import { RESISTOR_ENTRIES } from './resistors';
import { ROPE_ENTRIES } from './rope';
import { SWITCH_ENTRIES } from './switches';
import { WIRE_ENTRIES } from './wire';

export {
  KT_CONVENTIONS,
  KV_CONVENTIONS,
  OCV_SOC_PERCENT,
  OUTPUT_SIDE,
  ocvField,
} from '../parts/families';
export { BEARING_ENTRIES } from './bearings';
export { BELT_ENTRIES, PULLEY_ENTRIES } from './belts';
export { BMS_ENTRIES } from './bms';
export { CELL_ENTRIES } from './cells';
export { CONNECTOR_ENTRIES } from './connectors';
export { CONTROLLER_ENTRIES } from './controllers';
export { FUSE_ENTRIES } from './fuses';
export { GEAR_ENTRIES } from './gears';
export { MOTOR_ENTRIES } from './motors';
export { RESISTOR_ENTRIES } from './resistors';
export { ROPE_ENTRIES } from './rope';
export { SWITCH_ENTRIES } from './switches';
export { WIRE_ENTRIES } from './wire';
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
  ...BEARING_ENTRIES,
  ...BELT_ENTRIES,
  ...PULLEY_ENTRIES,
  ...GEAR_ENTRIES,
  ...ROPE_ENTRIES,
  ...WIRE_ENTRIES,
  ...CONNECTOR_ENTRIES,
  ...FUSE_ENTRIES,
  ...SWITCH_ENTRIES,
  ...RESISTOR_ENTRIES,
];
