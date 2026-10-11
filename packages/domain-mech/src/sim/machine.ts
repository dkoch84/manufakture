// The machine the rep and session simulation steps through (ADR 0017 decision 14, the M9 plan's
// decision 6, task T9.4b): one degree of freedom along the drivetrain (cable, spool or screw,
// reductions, rotor), a surface-magnet PMSM from its datasheet constants in the internal
// convention of `catalog/conventions.ts`, a controller with a current and a voltage limit and its
// losses, a pack with an open-circuit voltage curve, an internal resistance and a charge limit, a
// braking resistor on an ideal chopper, and lumped thermal nodes (the motor's winding and
// housing, optionally the pack and the resistor). Plain JSON, SI throughout (temperatures in
// kelvin), so a job crosses a worker boundary as it is.
//
// The T9.0b spike (`docs/spikes/T9.0b-sim.md`) built and validated this model; `./engine` is its
// `simulate`, productised.

/** A surface-magnet PMSM under field-oriented control, in the internal convention. */
export interface SimMotor {
  /** N·m per ampere of phase current amplitude (q axis), at `reference`. */
  kt: number;
  /** Equivalent wye phase-to-neutral resistance, ohm, at `reference`. */
  resistance: number;
  /** Equivalent wye phase-to-neutral inductance, H (Ld = Lq). */
  inductance: number;
  polePairs: number;
  /** Rotor inertia alone, kg·m² (also inside `SimTransmission.inertia`); for the records only. */
  rotorInertia?: number;
  /** Constant loss torque (bearings, friction), N·m, and speed-proportional, N·m·s/rad. */
  frictionCoulomb: number;
  frictionViscous: number;
  /** Iron loss P = ironHysteresis·|ω| + ironEddy·ω², W with ω in rad/s at the rotor. */
  ironHysteresis: number;
  ironEddy: number;
  /** Copper resistance coefficient, 1/K (0.00393 for copper). */
  copperAlpha: number;
  /** Torque-constant coefficient with the housing (magnet) temperature, 1/K (NdFeB about -0.0012). */
  magnetAlpha: number;
  /** Temperature at which `kt` and `resistance` are given, K. */
  reference: number;
}

/** The motor's two thermal nodes: copper loss into the winding, iron and friction into the housing. */
export interface SimMotorThermal {
  /** J/K. */
  windingCapacity: number;
  /** K/W. */
  windingToHousing: number;
  /** J/K. */
  housingCapacity: number;
  /** K/W. */
  housingToAmbient: number;
}

/** One lumped thermal node to ambient. */
export interface SimNode {
  /** J/K. */
  capacity: number;
  /** K/W. */
  toAmbient: number;
}

/** Effective radius of the output against cable extension, m. */
export type SimRadius =
  | { kind: 'constant'; radius: number }
  /**
   * Wound layers paid out outermost first (`radiusSteps`): each `[from, to)` of extension at its
   * radius. The radius moves from one layer's to the next over one turn of cable about the
   * boundary, as the cable climbs down, so the shaft speed has no step.
   */
  | { kind: 'steps'; steps: readonly { from: number; to: number; radius: number }[] };

/** From the cable to the rotor. */
export interface SimTransmission {
  radius: SimRadius;
  /** Rotor turns per output turn (1 for direct drive). */
  ratio: number;
  /** The reductions' product, 0 to 1. */
  efficiency: number;
  /** The cable path (fairlead, bending, the output's bearings), 0 to 1. */
  cableEfficiency: number;
  /** Everything that turns, reflected to the rotor, kg·m². */
  inertia: number;
}

export interface SimController {
  /** A peak (phase amplitude); absent: no limit. */
  currentLimit?: number;
  /** The largest voltage vector is `modulation · Vbus / sqrt(3)`. */
  modulation: number;
  /** Current-loop bandwidth for the full electrical mode, Hz. */
  loopHz: number;
  /** Gate drive, logic and sensors, W. */
  fixedLoss: number;
  /** Effective on-resistance per leg, ohm: conduction loss 1.5 · R · |i|². */
  legResistance: number;
  /** Switching loss 3 · ½ · Vbus · (2/π)|i| · time · frequency. */
  switchingTime: number;
  switchingFrequency: number;
}

/** One point of the pack's open-circuit voltage curve: state of charge 0 to 1, pack volts. */
export interface SimOcvPoint {
  soc: number;
  voltage: number;
}

export interface SimPack {
  /** Rising state of charge from 0 to 1, pack volts (series times the cell's). */
  ocv: readonly SimOcvPoint[];
  /** Coulombs. */
  capacity: number;
  /** DC internal resistance, ohm. */
  resistance: number;
  /** A charge current limit, A, held to `taperStart` then falling to none at full; absent: none. */
  chargeLimit?: number;
  /** State of charge where the charge limit starts to fall. */
  taperStart: number;
  /** Terminal voltage under load below which the BMS would cut off, V; absent: not watched. */
  cutoff?: number;
  thermal?: SimNode;
}

export interface SimBrake {
  /** Ohm, on an ideal chopper that burns what the pack does not accept (up to V² / R). */
  resistance: number;
  thermal?: SimNode;
}

export interface SimMachine {
  motor: SimMotor;
  /** Absent: the winding stays at ambient and its temperature is not a result. */
  motorThermal?: SimMotorThermal;
  transmission: SimTransmission;
  controller: SimController;
  pack: SimPack;
  /** Absent: regenerated power the pack cannot accept has nowhere to go (a warning). */
  brake?: SimBrake;
  /** Always-on loads on the bus (board, display, sensors, a DC-DC converter), W. */
  aux: number;
  /** K. */
  ambient: number;
}

/** The pack's open-circuit voltage at a state of charge, linear between points, clamped. */
export function packOcv(pack: Pick<SimPack, 'ocv'>, soc: number): number {
  const pts = pack.ocv;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (soc <= first.soc) return first.voltage;
  if (soc >= last.soc) return last.voltage;
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid]!.soc <= soc) lo = mid;
    else hi = mid;
  }
  const a = pts[lo]!;
  const b = pts[hi]!;
  return a.voltage + ((b.voltage - a.voltage) * (soc - a.soc)) / (b.soc - a.soc);
}

/**
 * The pack's chemical energy between state of charge 0 and `soc`, J: capacity times the exact
 * integral of the piecewise-linear OCV curve, flat beyond its ends (as `packOcv` is), also below
 * 0 and above 1.
 */
export function packEnergy(pack: Pick<SimPack, 'ocv' | 'capacity'>, soc: number): number {
  const pts = pack.ocv;
  // Not clamped: a run that empties (or overfills) the pack still balances its ledger.
  const s = soc;
  // Flat below the first point (negative below 0).
  const first = pts[0]!;
  let sum = Math.min(s, first.soc) * first.voltage;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (s <= a.soc) break;
    const end = Math.min(s, b.soc);
    const h = b.soc - a.soc;
    const u = end - a.soc;
    sum += u * (a.voltage + ((b.voltage - a.voltage) * u) / (2 * h));
  }
  const last = pts[pts.length - 1]!;
  if (s > last.soc) sum += (s - last.soc) * last.voltage;
  return pack.capacity * sum;
}

/** The charge current the pack accepts at a state of charge, A (Infinity: no limit). */
export function chargeLimitAt(pack: SimPack, soc: number): number {
  if (pack.chargeLimit === undefined) return Infinity;
  if (soc <= pack.taperStart) return pack.chargeLimit;
  if (pack.taperStart >= 1) return pack.chargeLimit;
  return Math.max(0, (pack.chargeLimit * (1 - soc)) / (1 - pack.taperStart));
}

/** Friction and iron loss powers at rotor speed `w`, W, both at least zero. */
export function lossPowers(motor: SimMotor, w: number): { friction: number; iron: number } {
  const a = Math.abs(w);
  return {
    friction: motor.frictionCoulomb * a + motor.frictionViscous * w * w,
    iron: motor.ironHysteresis * a + motor.ironEddy * w * w,
  };
}

/** The effective radius at extension `x`, m, with one turn of blending at each layer boundary. */
export function radiusAt(radius: SimRadius, x: number): number {
  if (radius.kind === 'constant') return radius.radius;
  const steps = radius.steps;
  if (steps.length === 0) return NaN;
  // The steps run outermost first, by rising extension; find the one holding x.
  let k = 0;
  while (k < steps.length - 1 && x >= steps[k]!.to) k++;
  const here = steps[k]!;
  let r = here.radius;
  // Blend across the boundary below (with the previous step) and above (with the next), each over
  // one turn of the larger radius, at most half of either step's length.
  const blend = (a: { from: number; to: number; radius: number }, b: typeof a): number => {
    const boundary = a.to;
    const half = Math.min(
      Math.PI * Math.max(a.radius, b.radius),
      (a.to - a.from) / 2,
      (b.to - b.from) / 2,
    );
    if (!(half > 0) || Math.abs(x - boundary) >= half) return NaN;
    const u = (x - (boundary - half)) / (2 * half);
    return a.radius + (b.radius - a.radius) * u;
  };
  if (k > 0) {
    const v = blend(steps[k - 1]!, here);
    if (!Number.isNaN(v)) r = v;
  }
  if (k < steps.length - 1) {
    const v = blend(here, steps[k + 1]!);
    if (!Number.isNaN(v)) r = v;
  }
  return r;
}
