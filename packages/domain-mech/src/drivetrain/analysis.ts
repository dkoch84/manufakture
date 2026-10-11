// Every drivetrain of a document, read and stated (T9.3a): the chain, its records, and the
// `mech-reference` warnings for what a stage names that is not there (ADR 0017 decision 9: "a
// stage naming an instance, mate or use that no longer exists gives a `mech-reference` warning on
// the drivetrain, and the records that need it are `unknown`"). The evaluation stage runs this
// after the parts and assemblies regenerate; outside regen nothing is measured, and the records
// that need a measured inertia say so.

import { mechItems, type Drivetrain } from '@manufakture/core';
import type { DomainEvaluationWarning } from '@manufakture/regen';
import type { MechRecord } from '../checks/types';
import { analyseSpool, type SpoolAnalysis } from '../spool/analysis';
import {
  drivetrainChain,
  drivetrainProblemText,
  type DrivetrainChain,
  type DrivetrainContext,
} from './chain';
import { DRIVETRAIN_INERTIA, DRIVETRAIN_INERTIA_OUTPUT, drivetrainRecords } from './records';

/** One drivetrain with its records. Plain JSON. */
export interface DrivetrainAnalysis extends DrivetrainChain {
  /** kg·m²; absent when the record is unknown. */
  inertiaAtMotor?: number;
  inertiaAtOutput?: number;
  records: MechRecord[];
  /** A spool output, wound and stated (T9.3b): its effective radius against extension. */
  spool?: SpoolAnalysis;
}

/** One drivetrain, read and stated. */
export function analyseDrivetrain(ctx: DrivetrainContext, d: Drivetrain): DrivetrainAnalysis {
  const chain = drivetrainChain(ctx, d);
  const records = drivetrainRecords(chain);
  const value = (check: string) => records.find((r) => r.check === check)?.result ?? undefined;
  const atMotor = value(DRIVETRAIN_INERTIA);
  const atOutput = value(DRIVETRAIN_INERTIA_OUTPUT);
  const spool = analyseSpool(ctx, d);
  return {
    ...chain,
    ...(atMotor !== undefined ? { inertiaAtMotor: atMotor } : {}),
    ...(atOutput !== undefined ? { inertiaAtOutput: atOutput } : {}),
    // The spool's own problems (a typed length that does not read, a cable that is not a rope, a
    // width longer than the body) join the chain's, so the panel and the toolbar count show them.
    problems: spool === undefined ? chain.problems : [...chain.problems, ...spool.problems],
    records,
    ...(spool !== undefined ? { spool } : {}),
  };
}

/** Every drivetrain of the document, in its order. */
export function analyseDrivetrains(ctx: DrivetrainContext): DrivetrainAnalysis[] {
  return mechItems(ctx.document.mech, 'drivetrains').map((d) => analyseDrivetrain(ctx, d));
}

/** A `mech-reference` warning per missing thing a drivetrain names. */
export function drivetrainWarnings(
  analyses: readonly DrivetrainAnalysis[],
): DomainEvaluationWarning[] {
  const out: DomainEvaluationWarning[] = [];
  for (const a of analyses) {
    for (const p of a.problems) {
      if (p.kind !== 'reference' || p.target === undefined) continue;
      out.push({
        code: 'mech-reference',
        message: `Drivetrain ${a.name} (${a.id}): ${drivetrainProblemText(p)}`,
        objectId: a.id,
        target: p.target,
      });
    }
  }
  return out;
}
