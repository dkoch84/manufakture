// The mechanical domain's evaluation stage (ADR 0017 decision 15): what regen calls after the
// parts and assemblies. Its first step asks regen to measure the bodies the checks need; its
// second runs every check and returns the records (with their lines) as the result's data and a
// `mech-check` warning for each record below the user's factor or not computed, with every
// drivetrain read into numbers (T9.3a: the bodies its stages name are measured in the first step)
// and a `mech-reference` warning for what a stage names that is not there. A document that
// uses neither the `mech` section nor `domains.mech` reports nothing.

import { DISCLAIMER_SHORT } from '../disclaimer';
import {
  analyseDrivetrains,
  drivetrainNeeds,
  drivetrainWarnings,
  type DrivetrainAnalysis,
} from '../drivetrain';
import { DEFAULT_MECH_SETTINGS, type MechSettings } from '../settings';
import { cableTension } from './cable';
import { measuredFrom, NOTHING_MEASURED } from './measured';
import { CheckRegistry, RecordCache, runChecks, type CheckEntry } from './registry';
import { NO_SIMULATION, type SimulationEnvelopes } from './simulation';
import type { CheckModel } from './types';
import type {
  DomainEvaluation,
  EvaluationContext,
  EvaluationQuery,
  JsonValue,
} from '@manufakture/regen';

/** The version of `MechEvaluation`'s shape. */
export const MECH_EVALUATION_VERSION = 1;

/** What the stage reports as `DomainEvaluationResult.data` for `mech`. */
export interface MechEvaluation {
  version: number;
  /** Every check's records, in check order, each with its line for people. */
  checks: CheckEntry[];
  /**
   * Every drivetrain read into numbers, with its records (T9.3a); absent when the document has
   * none (results of builds before T9.3a lack it too).
   */
  drivetrains?: DrivetrainAnalysis[];
  /** The short notice, shown with the records. */
  disclaimer: string;
}

/** The checks this build ships. T9.5b to T9.5h register theirs here. */
export function builtinChecks(): CheckRegistry {
  const registry = new CheckRegistry();
  registry.register(cableTension);
  return registry;
}

export interface MechEvaluationOptions {
  registry?: CheckRegistry;
  /** The simulation's envelopes (T9.4b); absent: none has run. */
  simulation?: (context: EvaluationContext) => SimulationEnvelopes;
  /** Bump with any change to what the stage returns (`MECH_IMPLEMENTATION`). */
  implementation: number;
}

/** The model the checks read, from regen's context (and the answers, once measured). */
export function checkModel(
  context: EvaluationContext,
  simulation: SimulationEnvelopes,
  measured = NOTHING_MEASURED,
): CheckModel {
  const settings = (context.data.mech as MechSettings | undefined) ?? DEFAULT_MECH_SETTINGS;
  return {
    document: context.document,
    settings,
    variables: context.variables,
    simulation,
    measured,
  };
}

/** A part's final bodies as regen built them, for the drivetrain's measurements. */
function partBodies(context: EvaluationContext): (part: string) => readonly string[] | undefined {
  return (part) => {
    const p = context.parts.find((x) => x.partId === part);
    return p === undefined || !p.built ? undefined : p.bodies;
  };
}

/** Whether a document uses the mechanical domain at all. */
function inUse(context: EvaluationContext): boolean {
  const d = context.document;
  return d.mech !== undefined || (d.domains !== undefined && Object.hasOwn(d.domains, 'mech'));
}

/**
 * The stage, with its own record cache (records are recomputed only when their inputs change).
 * `mechDomain` registers one; tests make their own.
 */
export function createMechEvaluation(options: MechEvaluationOptions): DomainEvaluation & {
  readonly cache: RecordCache;
} {
  const registry = options.registry ?? builtinChecks();
  const cache = new RecordCache();
  const simulation = (context: EvaluationContext) => options.simulation?.(context) ?? NO_SIMULATION;
  return {
    cache,
    measure(context) {
      if (!inUse(context)) return [];
      const model = checkModel(context, simulation(context));
      const seen = new Set<string>();
      const out: EvaluationQuery[] = [];
      const needs = registry.list().flatMap((def) => def.measures?.(model) ?? []);
      needs.push(...drivetrainNeeds(context.document, partBodies(context)));
      for (const need of needs) {
        const k = `${need.part}\n${need.body}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ type: 'body', part: need.part, body: need.body });
      }
      return out;
    },
    evaluate(context, answers) {
      if (!inUse(context)) return {};
      const measured = measuredFrom(answers);
      const model = checkModel(context, simulation(context), measured);
      const run = runChecks(model, registry, cache, options.implementation);
      const drivetrains = analyseDrivetrains({
        document: context.document,
        variables: (n) => context.variables.get(n),
        measured,
        partBodies: partBodies(context),
      });
      if (run.entries.length === 0 && drivetrains.length === 0) return {};
      const data: MechEvaluation = {
        version: MECH_EVALUATION_VERSION,
        checks: run.entries,
        ...(drivetrains.length > 0 ? { drivetrains } : {}),
        disclaimer: DISCLAIMER_SHORT,
      };
      return {
        data: data as unknown as JsonValue,
        warnings: [...drivetrainWarnings(drivetrains), ...run.warnings],
      };
    },
  };
}

/**
 * The mechanical evaluation in a regen result, or undefined when there is none (no checks, or a
 * build that reports a newer shape).
 */
export function mechEvaluationOf(
  evaluations: readonly { namespace: string; data?: unknown }[] | undefined,
): MechEvaluation | undefined {
  const data = evaluations?.find((e) => e.namespace === 'mech')?.data;
  if (typeof data !== 'object' || data === null) return undefined;
  const d = data as Partial<MechEvaluation>;
  if (d.version !== MECH_EVALUATION_VERSION || !Array.isArray(d.checks)) return undefined;
  return d as MechEvaluation;
}
