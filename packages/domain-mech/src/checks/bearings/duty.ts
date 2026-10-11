// What the bearing checks read (task T9.5c): every rolling bearing on a drivetrain's shafts, and
// what each load case does to the spool those shafts turn. The loads come from the load cases
// themselves: a dynamic load case's force law over its prescribed motion gives the cable tension
// and the spool's turning through a rep (the effective radius follows the wound layers, T9.3b),
// and its sets and reps give the duty cycle; a static one gives its largest cable pull. Where the
// simulation (T9.4b) has run, its peak cable tension stands in for the force law's peak when it is
// larger, since it carries the inertia and the controller the force law leaves out.
//
// Which bearings carry the cable: those of the shaft nearest the spool with no belt, gear or
// planetary between it and the spool, shared evenly unless an override says otherwise. A shaft
// before a reduction carries belt or gear forces this check does not derive, so its share is
// missing until the user gives one. Only spool outputs are read; a rotary or linear output's loads
// are not modelled here.

import {
  mechItems,
  type CatalogEntry,
  type Drivetrain,
  type LoadCase,
  type PurchasedUse,
  type Stage,
} from '@manufakture/core';
import type { VariableLookup } from '@manufakture/units';
import { drivetrainChain, REDUCTION_KINDS, STAGE_KIND_TEXT } from '../../drivetrain/chain';
import { refText, resolveEntry, type BuiltinEntry } from '../../parts/catalog';
import { forceAt } from '../../requirements/laws';
import {
  dutyCycle,
  repSegments,
  resolveDynamic,
  segmentKinematics,
} from '../../requirements/motion';
import { siValue } from '../../requirements/values';
import { analyseSpool } from '../../spool/analysis';
import { effectiveRadius, radiusSteps, type Winding } from '../../spool/winding';
import { CABLE_TENSION_SERIES } from '../cable';
import type { CheckModel, InputRef } from '../types';

/** Sub-intervals each moving segment of a rep is cut into. */
const SAMPLES = 256;

type ShaftStage = Extract<Stage, { kind: 'shaft' }>;

/** A rolling bearing type the checks know; a bushing is not a rolling bearing. */
export type RollingType = 'deep groove ball' | 'angular contact' | 'needle';

const ROLLING: readonly string[] = ['deep groove ball', 'angular contact', 'needle'];

/** A number, or why there is none. */
export type Known = { value: number; source: string } | { value: undefined; missing: string };

/** One bearing on one shaft of one drivetrain. */
export interface BearingSite {
  /** `drive#1/stage#2/pp#4`, with `:2` on a second listing of the same use in a stage. */
  location: string;
  drivetrain: Drivetrain;
  stage: ShaftStage;
  use: PurchasedUse;
  /** Undefined when the entry does not resolve (then `unresolved` says why). */
  entry: CatalogEntry | BuiltinEntry | undefined;
  /** Why the use's catalog entry could not be read: the records are `unknown`, naming it. */
  unresolved?: string;
  /** "SKF 6204-2RSH (pp#4) on Shaft (stage#2)". */
  label: string;
  /** The entry's type; undefined when it gives none. */
  type: RollingType | undefined;
  /** The radial load on this bearing per newton of cable tension. */
  share: Known;
  /** The shaft's speed over the spool's. */
  speedRatio: Known;
}

/** One sample of a rep: the cable tension over a stretch of the spool's turning. */
export interface TurnSample {
  /** N. */
  force: number;
  /** rad of the spool. */
  angle: number;
}

/** What a dynamic load case does to the spool. */
export interface Turning {
  samples: TurnSample[];
  /** rad of the spool in one rep. */
  anglePerRep: number;
  /** Reps in a session: reps times sets. */
  repsPerSession: number;
  reps: number;
  sets: number;
  /** s, pauses and rests included. */
  sessionDuration: number;
  /** rad/s of the spool. */
  peakSpoolSpeed: number;
}

/** The largest cable tension of a load case. */
export type Peak = { value: number; source: string; ref: InputRef } | { missing: string };

/** One load case as the bearings of one drivetrain see it. */
export interface CaseDuty {
  loadCase: LoadCase;
  /** Undefined: the load case does not pull the cable. */
  peak?: Peak;
  /** Dynamic load cases only. */
  turning?: Turning | { missing: string };
}

/** The bearings of one spool drivetrain and what its load cases do. */
export interface DrivetrainDuty {
  drivetrain: Drivetrain;
  sites: BearingSite[];
  cases: CaseDuty[];
}

/** The angle the spool turns through while the extension goes from `a` to `b`, rad. */
export function spoolAngle(w: Winding, a: number, b: number): number {
  const steps = radiusSteps(w);
  if (steps.length === 0) return Number.NaN;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  let angle = 0;
  // Beyond the ends the radius stays at the outermost layer (below zero) or layer 1 (past the
  // length), as `effectiveRadius` clamps it.
  if (lo < 0) angle += (Math.min(hi, 0) - lo) / steps[0]!.radius;
  if (hi > w.length) angle += (hi - Math.max(lo, w.length)) / steps[steps.length - 1]!.radius;
  for (const s of steps) {
    const overlap = Math.min(hi, s.to) - Math.max(lo, s.from);
    if (overlap > 0) angle += overlap / s.radius;
  }
  return angle;
}

/** A dynamic load case's rep, sampled: tension against the spool's turning, and the duty. */
export function turning(
  lc: LoadCase,
  winding: Winding,
  variables: VariableLookup,
): { turning: Turning; peakForce: number } | { missing: string } {
  if (lc.dynamic === undefined) return { missing: `${lc.id} has no motion` };
  const resolved = resolveDynamic(lc.dynamic, variables);
  if (!resolved.ok) {
    return {
      missing: `${lc.name} (${lc.id}) does not read: ${resolved.problems.map((p) => p.message).join('; ')}`,
    };
  }
  const d = resolved.value;
  const samples: TurnSample[] = [];
  let peakForce = 0;
  let peakSpeed = 0;
  let anglePerRep = 0;
  for (const seg of repSegments(d.law, d.motion)) {
    if (seg.shape === 'still' || seg.from === seg.to || !(seg.duration > 0)) {
      peakForce = Math.max(peakForce, forceAt(d.law, seg.from, 0));
      continue;
    }
    const dt = seg.duration / SAMPLES;
    for (let i = 0; i < SAMPLES; i++) {
      const a = segmentKinematics(seg, i * dt);
      const b = segmentKinematics(seg, (i + 1) * dt);
      const m = segmentKinematics(seg, (i + 0.5) * dt);
      const force = forceAt(d.law, m.x, m.v);
      const angle = spoolAngle(winding, a.x, b.x);
      samples.push({ force, angle });
      anglePerRep += angle;
      peakForce = Math.max(peakForce, force);
    }
    for (let i = 0; i <= SAMPLES; i++) {
      const k = segmentKinematics(seg, i * dt);
      const r = effectiveRadius(winding, k.x);
      if (r !== undefined && r > 0) peakSpeed = Math.max(peakSpeed, Math.abs(k.v) / r);
    }
  }
  return {
    turning: {
      samples,
      anglePerRep,
      repsPerSession: d.reps * d.sets,
      reps: d.reps,
      sets: d.sets,
      sessionDuration: dutyCycle(d).sessionDuration,
      peakSpoolSpeed: peakSpeed,
    },
    peakForce,
  };
}

/** A static load case's largest cable pull, or undefined when it pulls none. */
function staticPeak(lc: LoadCase, variables: VariableLookup): Peak | undefined {
  const pulls = (lc.static ?? []).filter((l) => l.kind === 'cable');
  if (pulls.length === 0) return undefined;
  let best: { value: number; name: string } | undefined;
  for (const pull of pulls) {
    const f = siValue(pull.force, 'force', variables);
    if (!f.ok) {
      return {
        missing: `the force "${pull.force.source}" of cable pull "${pull.name}" in ${lc.name} (${lc.id}) does not evaluate: ${f.message}`,
      };
    }
    if (best === undefined || Math.abs(f.value) > best.value) {
      best = { value: Math.abs(f.value), name: pull.name };
    }
  }
  return {
    value: best!.value,
    source: `load case ${lc.name} (${lc.id}), cable pull "${best!.name}"`,
    ref: { kind: 'given' },
  };
}

/** The simulation's peak cable tension where it is larger than the force law's. */
function withSimulation(model: CheckModel, lc: LoadCase, peak: Peak): Peak {
  const simulated = model.simulation.envelope(lc.id, CABLE_TENSION_SERIES, 'peak');
  if (simulated === undefined || !Number.isFinite(simulated)) return peak;
  if ('value' in peak && Math.abs(simulated) <= peak.value) return peak;
  return {
    value: Math.abs(simulated),
    source: `peak of ${CABLE_TENSION_SERIES} in the simulation of ${lc.name} (${lc.id})`,
    ref: { kind: 'simulation', loadCase: lc.id, series: CABLE_TENSION_SERIES, statistic: 'peak' },
  };
}

function rollingType(entry: CatalogEntry | BuiltinEntry): RollingType | 'bushing' | undefined {
  const t = Object.hasOwn(entry.ratings, 'type') ? entry.ratings.type : undefined;
  if (t === undefined || !('text' in t)) return undefined;
  if (t.text === 'bushing') return 'bushing';
  return ROLLING.includes(t.text) ? (t.text as RollingType) : undefined;
}

/** The shaft stage that turns with the spool and carries the cable, if there is one. */
function cableShaft(d: Drivetrain): string | undefined {
  for (let i = d.stages.length - 1; i >= 0; i--) {
    const s = d.stages[i]!;
    if (REDUCTION_KINDS.includes(s.kind)) return undefined;
    if (s.kind === 'shaft') return s.id;
  }
  return undefined;
}

function drivetrainDuty(model: CheckModel, d: Drivetrain): DrivetrainDuty | undefined {
  if (d.output.kind !== 'spool') return undefined;
  const doc = model.document;
  const variables: VariableLookup = (n) => model.variables.get(n);
  const uses = mechItems(doc.mech, 'purchased');
  const ctx = {
    document: doc,
    variables,
    measured: model.measured,
    ...(model.partBodies !== undefined ? { partBodies: model.partBodies } : {}),
  };
  const chain = drivetrainChain(ctx, d);
  const carrier = cableShaft(d);
  const sites: BearingSite[] = [];
  for (const stage of d.stages) {
    if (stage.kind !== 'shaft') continue;
    const stageName = `${STAGE_KIND_TEXT.shaft} (${stage.id})`;
    const result = chain.stages.find((s) => s.id === stage.id);
    const outN = chain.output.n;
    const speedRatio: Known =
      result?.nOut !== undefined && outN !== undefined
        ? {
            value: outN / result.nOut,
            source:
              outN === result.nOut
                ? `${stageName} turns with the spool`
                : `the ratios of ${d.name} (${d.id}) between ${stageName} and the spool`,
          }
        : { value: undefined, missing: `a ratio of ${d.name} (${d.id}) does not read` };
    const count = stage.bearings.length;
    const seen = new Map<string, number>();
    for (const b of stage.bearings) {
      const use = uses.find((u) => u.id === b.use);
      if (use === undefined) continue;
      const resolved = resolveEntry(doc, use.entry);
      // A resolved entry of another family is not a bearing; one that does not resolve may be.
      if (resolved.ok && resolved.entry.family !== 'bearing') continue;
      const type = resolved.ok ? rollingType(resolved.entry) : undefined;
      if (type === 'bushing') continue;
      const nth = (seen.get(use.id) ?? 0) + 1;
      seen.set(use.id, nth);
      const name = resolved.ok
        ? `${resolved.entry.maker} ${resolved.entry.partNumber}`.trim()
        : refText(use.entry);
      const label = `${use.name ?? name} (${use.id}) on ${stageName}`;
      const share: Known =
        stage.id !== carrier
          ? {
              value: undefined,
              missing: `${stageName} is not the spool's shaft, and the belt or gear forces on it are not derived: give k, this bearing's radial load per newton of cable tension, with an override`,
            }
          : count === 1
            ? { value: 1, source: `the only bearing of ${stageName}: it carries the whole pull` }
            : {
                value: 1 / count,
                source: `shared evenly by the ${count} bearings of ${stageName} (assumed: the cable pulls midway between them; give k with an override when it does not)`,
              };
      sites.push({
        location: `${d.id}/${stage.id}/${use.id}${nth > 1 ? `:${nth}` : ''}`,
        drivetrain: d,
        stage,
        use,
        entry: resolved.ok ? resolved.entry : undefined,
        ...(resolved.ok
          ? {}
          : { unresolved: `the catalog entry of ${use.id}: ${resolved.message}` }),
        label,
        type,
        share,
        speedRatio,
      });
    }
  }
  if (sites.length === 0) return { drivetrain: d, sites, cases: [] };

  const winding = analyseSpool(ctx, d)?.winding;
  const hasLayers = winding !== undefined && winding.layers.length > 0;
  const cases: CaseDuty[] = [];
  for (const lc of mechItems(doc.mech, 'loadCases')) {
    if (lc.drivetrain !== undefined && lc.drivetrain !== d.id) continue;
    if (lc.dynamic !== undefined) {
      if (!hasLayers) {
        const missing = `the spool of ${d.name} (${d.id}) has no winding to turn: its core, width, cable or length does not read`;
        cases.push({ loadCase: lc, peak: { missing }, turning: { missing } });
        continue;
      }
      const t = turning(lc, winding, variables);
      if ('missing' in t) {
        cases.push({ loadCase: lc, peak: { missing: t.missing }, turning: t });
        continue;
      }
      const lawPeak: Peak = {
        value: t.peakForce,
        source: `the force law of ${lc.name} (${lc.id}) over its motion`,
        ref: { kind: 'given' },
      };
      cases.push({ loadCase: lc, peak: withSimulation(model, lc, lawPeak), turning: t.turning });
      continue;
    }
    const peak = staticPeak(lc, variables);
    if (peak !== undefined) cases.push({ loadCase: lc, peak: withSimulation(model, lc, peak) });
  }
  return { drivetrain: d, sites, cases };
}

const CACHE = new WeakMap<CheckModel, DrivetrainDuty[]>();

/** Every spool drivetrain's bearings and load cases, read once per model. */
export function bearingDuties(model: CheckModel): DrivetrainDuty[] {
  const hit = CACHE.get(model);
  if (hit !== undefined) return hit;
  const out: DrivetrainDuty[] = [];
  for (const d of mechItems(model.document.mech, 'drivetrains')) {
    const duty = drivetrainDuty(model, d);
    if (duty !== undefined && duty.sites.length > 0) out.push(duty);
  }
  CACHE.set(model, out);
  return out;
}
