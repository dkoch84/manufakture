// A drivetrain's spool and cable, read, wound and stated (task T9.3b). The drivetrain analysis
// (T9.3a) carries it for a `spool` output, so regen's `mech` evaluation data has it beside the
// drivetrain's own records, and the simulation (T9.4b) and the spool and cable checks (T9.5e) read
// the winding through ./winding: `layersWound(winding, paidOut)`, `effectiveRadius(winding,
// extension)`, `spoolAt`, `radiusSteps` and `bendRatio`.

import type { Drivetrain } from '@manufakture/core';
import type { MechRecord } from '../checks/types';
import type { DrivetrainContext } from '../drivetrain/chain';
import {
  SPOOL_FLANGE_CLEARANCE,
  SPOOL_LAYERS,
  SPOOL_RADIUS_OUT,
  SPOOL_RADIUS_WOUND,
  spoolRecords,
} from './records';
import { readSpool, type SpoolReading } from './spool';
import { radiusSteps, wind, type Winding } from './winding';

/** One spool output, read and stated. Plain JSON (it crosses regen's worker boundary). */
export interface SpoolAnalysis extends SpoolReading {
  /** Absent when the cable diameter, core, width or length does not read. */
  winding?: Winding;
  /** Effective radius against extension, outermost layer first. */
  steps?: { from: number; to: number; layer: number; radius: number }[];
  /** Values of the records, absent when unknown. */
  layers?: number;
  /** m. */
  radiusWound?: number;
  radiusOut?: number;
  flangeClearance?: number;
  records: MechRecord[];
}

/** The spool output of `d` (undefined for another output kind). */
export function analyseSpool(ctx: DrivetrainContext, d: Drivetrain): SpoolAnalysis | undefined {
  const o = d.output;
  if (o.kind !== 'spool') return undefined;
  const s = readSpool(ctx, d, o);
  const cable = s.cable.diameter.value;
  const core = s.core.value;
  const width = s.width.value;
  const winding =
    cable !== undefined && core !== undefined && width !== undefined && s.length !== undefined
      ? wind(
          { core, width, ...(s.flange.value !== undefined ? { flange: s.flange.value } : {}) },
          cable,
          s.length,
        )
      : undefined;
  const records = spoolRecords(s, winding);
  const value = (check: string) => records.find((r) => r.check === check)?.result ?? undefined;
  const layers = value(SPOOL_LAYERS);
  const radiusWound = value(SPOOL_RADIUS_WOUND);
  const radiusOut = value(SPOOL_RADIUS_OUT);
  const flangeClearance = value(SPOOL_FLANGE_CLEARANCE);
  return {
    ...s,
    ...(winding !== undefined ? { winding, steps: radiusSteps(winding) } : {}),
    ...(layers !== undefined ? { layers } : {}),
    ...(radiusWound !== undefined ? { radiusWound } : {}),
    ...(radiusOut !== undefined ? { radiusOut } : {}),
    ...(flangeClearance !== undefined ? { flangeClearance } : {}),
    records,
  };
}
