// The cable trainer of the M9 plan ("The cable trainer, by the numbers"): its parameters and its
// load cases. Every value here is an assumption of the spike, stated in docs/spikes/T9.0b-sim.md;
// T9.0c replaces them with catalog data.

import type { Machine, Pack, Segment } from './model.ts';

export const LBF = 4.448222;
export const FORCE_MAX = 200 * LBF; // 889.6 N

/**
 * A generic NMC cell's open-circuit voltage at 0, 10, ... 100 % state of charge (V). Assumed, of
 * the usual shape for NMC 18650 and 21700 cells at 25 °C; T9.0c replaces it with the chosen cell's.
 */
export const NMC_OCV = [3.0, 3.45, 3.55, 3.61, 3.66, 3.72, 3.8, 3.88, 3.97, 4.07, 4.18];

/** 16S1P, 1.7 Ah: 57.6 V nominal (3.6 V a cell) and 97.9 Wh, the Voltra I's published rating. */
export const PACK: Pack = {
  seriesCells: 16,
  capacityAh: 1.7,
  ocvSoc: NMC_OCV.map((_, i) => i / (NMC_OCV.length - 1)),
  ocvVolts: NMC_OCV,
  // 25 mΩ DC per cell (a power cell of this capacity) × 16, plus 20 mΩ of interconnect, fuse and
  // BMS switches.
  rInternal: 16 * 0.025 + 0.02,
  // 2C charge acceptance for pulses at 25 °C, tapering to nothing between 85 % and 100 %.
  chargeLimit: 2 * 1.7,
  taperStart: 0.85,
  cutoffCell: 2.8,
};

/**
 * Direct drive with the plan's illustrative motor constants: Kt 0.5 N·m/A and 0.08 Ω, read here as
 * a datasheet would quote them for a FOC motor: Kt per ampere of peak phase current, and 0.08 Ω
 * line to line (0.04 Ω a phase).
 */
export const DIRECT: Machine = {
  motor: {
    name: 'direct-drive torque motor (assumed)',
    polePairs: 14,
    kt: 0.5,
    rPhase: 0.04,
    lPhase: 100e-6,
    inertia: 3e-3,
    frictionCoulomb: 0.03,
    frictionViscous: 1e-4,
    ironHyst: 0.06,
    ironEddy: 8e-4,
    copperAlpha: 0.00393,
    magnetAlpha: -0.0012,
    tRef: 25,
    commutation: 'foc',
  },
  drivetrain: {
    spoolRadius: 0.025,
    ratio: 1,
    etaReduction: 1,
    etaCable: 0.97,
    spoolInertia: 2e-4,
  },
  controller: {
    currentLimit: 60,
    modulationMax: 0.95,
    currentLoopHz: 1000,
    fixed: 1.5,
    rOn: 0.004,
    tSwitch: 100e-9,
    fSwitch: 20e3,
    aux: 2.5,
  },
  pack: PACK,
  brake: { resistance: 2.5 },
  thermal: {
    // About 0.5 kg of copper with an effective lumped capacity of 200 J/K; winding to housing
    // 0.3 K/W (τ = 60 s, against 53 s for the much smaller maxon EC 90 flat); stator and housing
    // 1,000 J/K, 1.0 K/W to the air inside a closed box.
    cWinding: 200,
    rWindingHousing: 0.3,
    cHousing: 1000,
    rHousingAmbient: 1.0,
    tAmbient: 25,
  },
};

/** The same output through a 5:1 belt and a representative large outrunner. */
export const BELT: Machine = {
  ...DIRECT,
  motor: {
    name: 'outrunner, 5:1 belt (assumed)',
    polePairs: 14,
    kt: 0.09,
    rPhase: 0.035,
    lPhase: 20e-6,
    inertia: 4e-4,
    frictionCoulomb: 0.008,
    frictionViscous: 1e-5,
    ironHyst: 0.02,
    ironEddy: 5e-5,
    copperAlpha: 0.00393,
    magnetAlpha: -0.0012,
    tRef: 25,
    commutation: 'foc',
  },
  drivetrain: {
    spoolRadius: 0.025,
    ratio: 5,
    etaReduction: 0.95,
    etaCable: 0.97,
    spoolInertia: 2e-4,
  },
  controller: { ...DIRECT.controller, currentLimit: 70 },
  thermal: {
    // A smaller motor: about 0.15 kg of copper.
    cWinding: 60,
    rWindingHousing: 0.6,
    cHousing: 350,
    rHousingAmbient: 1.5,
    tAmbient: 25,
  },
};

export interface RepSpec {
  stroke: number;
  pullTime: number;
  returnTime: number;
  pauseTop: number;
  pauseBottom: number;
  force: number;
}

/**
 * One rep at constant force: pull out over the stroke (a half-cosine, 1.5 m/s peak), pause, let
 * the cable wind back in under the same force (1.0 s), pause. 2.03 s a rep.
 */
export const REP: RepSpec = {
  stroke: 0.6,
  pullTime: (Math.PI * 0.6) / (2 * 1.5), // 0.628 s for 1.5 m/s peak
  returnTime: 1.0,
  pauseTop: 0.2,
  pauseBottom: 0.2,
  force: FORCE_MAX,
};

export function reps(count: number, spec: RepSpec = REP): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      phase: 'pull',
      duration: spec.pullTime,
      from: 0,
      to: spec.stroke,
      force: spec.force,
    });
    out.push({
      phase: 'pause',
      duration: spec.pauseTop,
      from: spec.stroke,
      to: spec.stroke,
      force: spec.force,
    });
    out.push({
      phase: 'return',
      duration: spec.returnTime,
      from: spec.stroke,
      to: 0,
      force: spec.force,
    });
    out.push({ phase: 'pause', duration: spec.pauseBottom, from: 0, to: 0, force: spec.force });
  }
  return out;
}

export function hold(seconds: number, force = FORCE_MAX, at = 0.3): Segment[] {
  return [{ phase: 'hold', duration: seconds, from: at, to: at, force }];
}

export function rest(seconds: number): Segment[] {
  return [{ phase: 'rest', duration: seconds, from: 0, to: 0, force: 0 }];
}

/**
 * The "max" session: 5 sets of 10 reps at 200 lbf with 90 s rests. Each set starts and ends with
 * a 0.5 s force ramp at the docked position, as firmware would, so no step in force reaches the
 * current loop. 466 s.
 */
export function session(sets = 5, repsPerSet = 10, restSeconds = 90): Segment[] {
  const out: Segment[] = [];
  for (let s = 0; s < sets; s++) {
    out.push({ phase: 'pause', duration: 0.5, from: 0, to: 0, force: 0, forceTo: REP.force });
    out.push(...reps(repsPerSet));
    out.push({ phase: 'pause', duration: 0.5, from: 0, to: 0, force: REP.force, forceTo: 0 });
    if (s < sets - 1) out.push(...rest(restSeconds));
  }
  return out;
}
