// Two published motor datasheets, the model built from each one's constants, and the model's error
// against the operating points and curves the datasheets publish.
//
// Both makers rate their brushless motors as DC equivalents under block commutation (terminal
// resistance and inductance line to line, a DC torque constant), so the model runs in its
// six-step mode here: R = 2·R_phase, L = 2·L_phase, k = (3√3/π)·p·λ.
//
// What goes in: terminal resistance, inductance, torque constant, rotor inertia, pole pairs, the
// no-load current at the no-load speed (to set the friction and iron loss), and for maxon the
// thermal resistances. What comes out and is compared: no-load speed, stall torque, the slope of
// the speed-torque line, maximum efficiency, the speed and current at the rated torque, the
// mechanical time constant (from a time-stepped spin-up), and for maxon the continuous current at
// the winding's temperature limit.

import { electricalForm, lossPowers, SIX_STEP_FACTOR, type Motor } from './model.ts';

export interface Winding {
  id: string;
  voltage: number;
  noLoadSpeedRpm: number;
  noLoadCurrent: number;
  ratedSpeedRpm: number;
  ratedTorque: number; // N·m
  ratedCurrent: number;
  stallTorque: number; // N·m
  startingCurrent: number;
  etaMax: number; // 0..1
  resistance: number; // ohm, line to line
  inductance: number; // H, line to line
  torqueConstant: number; // N·m/A
  speedConstantRpmPerV: number;
  slopeRpmPerNm: number;
  mechTimeConstant: number; // s
}

export interface Datasheet {
  maker: string;
  model: string;
  source: string;
  url: string;
  tempRef: number;
  rotorInertia: number; // kg·m²
  polePairs: number;
  windings: Winding[];
  thermal?: {
    rHousingAmbient: number;
    rWindingHousing: number;
    tauWinding: number;
    tauMotor: number;
    tWindingMax: number;
    tAmbient: number;
  };
  notes: string[];
}

const rpm = (n: number): number => (n * Math.PI) / 30;
const toRpm = (w: number): number => (w * 30) / Math.PI;

export const MAXON_EC90_FLAT: Datasheet = {
  maker: 'maxon motor',
  model: 'EC 90 flat, 90 mm, brushless, 90 W, with Hall sensors (order numbers 323772 and 244879)',
  source: 'maxon EC motor catalog page 197, April 2006 edition ("Motor Data (provisional)")',
  url: 'https://mat.transtechnik.fr/LINMOT/documentation/Moteurs/EC%20Motors/Maxon/Maxon%20-%20EC_90_flat_244879.pdf',
  tempRef: 25,
  rotorInertia: 3060e-7,
  polePairs: 12,
  windings: [
    {
      id: '323772 (24 V)',
      voltage: 24,
      noLoadSpeedRpm: 3190,
      noLoadCurrent: 0.539,
      ratedSpeedRpm: 2650,
      ratedTorque: 0.387,
      ratedCurrent: 5.39,
      stallTorque: 4.67,
      startingCurrent: 66.2,
      etaMax: 0.83,
      resistance: 0.363,
      inductance: 0.264e-3,
      torqueConstant: 0.0705,
      speedConstantRpmPerV: 135,
      slopeRpmPerNm: 697,
      mechTimeConstant: 22.3e-3,
    },
    {
      id: '244879 (48 V)',
      voltage: 48,
      noLoadSpeedRpm: 2080,
      noLoadCurrent: 0.13,
      ratedSpeedRpm: 1640,
      ratedTorque: 0.494,
      ratedCurrent: 2.12,
      stallTorque: 4.53,
      startingCurrent: 20.9,
      etaMax: 0.85,
      resistance: 2.3,
      inductance: 2.5e-3,
      torqueConstant: 0.217,
      speedConstantRpmPerV: 44.0,
      slopeRpmPerNm: 466,
      mechTimeConstant: 14.9e-3,
    },
  ],
  thermal: {
    rHousingAmbient: 1.89,
    rWindingHousing: 2.99,
    tauWinding: 52.6,
    tauMotor: 281,
    tWindingMax: 125,
    tAmbient: 25,
  },
  notes: [
    'Values at nominal voltage and 25 °C ambient. Later editions list different nominal values for 323772 (for example 444 mNm and 6.06 A), so the edition matters.',
  ],
};

export const FAULHABER_4221_BXT_H: Datasheet = {
  maker: 'FAULHABER',
  model:
    'Brushless DC-flat motor series 4221 ... BXT H, external rotor, with housing (018, 024, 048 BXT H)',
  source: 'FAULHABER datasheet "Series 4221 ... BXT H", edition 2026 Jul. 28',
  url: 'https://www.faulhaber.com/fileadmin/Import/Media/EN_4221_BXTH_DFF.pdf',
  tempRef: 22,
  rotorInertia: 69e-7,
  polePairs: 7,
  windings: [
    {
      id: '4221G018BXTH (18 V)',
      voltage: 18,
      noLoadSpeedRpm: 5710,
      noLoadCurrent: 0.177,
      ratedSpeedRpm: 3980,
      ratedTorque: 0.102,
      ratedCurrent: 3.33,
      stallTorque: 1.17,
      startingCurrent: 18 / 0.46,
      etaMax: 0.88,
      resistance: 0.46,
      inductance: 396e-6,
      torqueConstant: 0.0298,
      speedConstantRpmPerV: 320,
      slopeRpmPerNm: 4930,
      mechTimeConstant: 3.56e-3,
    },
    {
      id: '4221G024BXTH (24 V)',
      voltage: 24,
      noLoadSpeedRpm: 6040,
      noLoadCurrent: 0.139,
      ratedSpeedRpm: 4380,
      ratedTorque: 0.112,
      ratedCurrent: 2.87,
      stallTorque: 1.22,
      startingCurrent: 24 / 0.74,
      etaMax: 0.87,
      resistance: 0.74,
      inductance: 664e-6,
      torqueConstant: 0.0377,
      speedConstantRpmPerV: 253,
      slopeRpmPerNm: 4970,
      mechTimeConstant: 3.59e-3,
    },
    {
      id: '4221G048BXTH (48 V)',
      voltage: 48,
      noLoadSpeedRpm: 6070,
      noLoadCurrent: 0.103,
      ratedSpeedRpm: 4700,
      ratedTorque: 0.107,
      ratedCurrent: 1.39,
      stallTorque: 1.39,
      startingCurrent: 48 / 2.6,
      etaMax: 0.88,
      resistance: 2.6,
      inductance: 2550e-6,
      torqueConstant: 0.0752,
      speedConstantRpmPerV: 127,
      slopeRpmPerNm: 4400,
      mechTimeConstant: 3.18e-3,
    },
  ],
  notes: [
    'Values at 22 °C and nominal voltage. The datasheet lists no starting current; U/R is used. Rated values are the thermal limit in a recommended operating area (plastic or metal flange), not points on the nominal-voltage line, so the rated speed is not compared.',
  ],
};

/** Share of the no-load loss torque that does not depend on speed (bearings, hysteresis). */
export const LOSS_SPLIT = 0.5;

/** The model's motor for one winding: six-step, constants from the datasheet. */
export function motorFromDatasheet(ds: Datasheet, w: Winding, split = LOSS_SPLIT): Motor {
  const kt = (1.5 * w.torqueConstant) / SIX_STEP_FACTOR;
  // Loss torque at the no-load point, k·I0, split into a constant and a part proportional to speed.
  const t0 = w.torqueConstant * w.noLoadCurrent;
  const w0 = rpm(w.noLoadSpeedRpm);
  return {
    name: `${ds.maker} ${w.id}`,
    polePairs: ds.polePairs,
    kt,
    rPhase: w.resistance / 2,
    lPhase: w.inductance / 2,
    inertia: ds.rotorInertia,
    frictionCoulomb: split * t0,
    frictionViscous: ((1 - split) * t0) / w0,
    ironHyst: 0,
    ironEddy: 0,
    copperAlpha: 0.00393,
    magnetAlpha: 0,
    tRef: ds.tempRef,
    commutation: 'six-step',
  };
}

/** Loss torque c0 + c1·ω of the model (N·m), for ω ≥ 0. */
function lossCoefficients(m: Motor): { c0: number; c1: number } {
  return { c0: m.frictionCoulomb + m.ironHyst, c1: m.frictionViscous + m.ironEddy };
}

export interface SteadyPoint {
  torque: number;
  speed: number; // rad/s
  current: number;
  efficiency: number;
}

/** Steady state at terminal voltage U and shaft torque M, with resistance scaled by rScale. */
export function steady(m: Motor, U: number, M: number, rScale = 1): SteadyPoint {
  const e = electricalForm(m);
  const k = e.c * e.ke;
  const R = e.r * rScale;
  const { c0, c1 } = lossCoefficients(m);
  // U = R·I + k·ω and k·I = M + c0 + c1·ω.
  const speed = (U - (R * (M + c0)) / k) / (e.ke + (R * c1) / k);
  const current = (M + c0 + c1 * speed) / k;
  const efficiency = current > 0 && speed > 0 ? (M * speed) / (U * current) : 0;
  return { torque: M, speed, current, efficiency };
}

export function maxEfficiency(m: Motor, U: number): SteadyPoint {
  const e = electricalForm(m);
  const stall = (e.c * e.ke * U) / e.r;
  let best = steady(m, U, 0);
  for (let i = 1; i < 20000; i++) {
    const p = steady(m, U, (stall * i) / 20000);
    if (p.speed <= 0) break;
    if (p.efficiency > best.efficiency) best = p;
  }
  return best;
}

/**
 * Time-stepped spin-up from rest at voltage U against load torque M (theta method on current and
 * speed), until steady. Returns the 63.2 % rise time of speed and the final point.
 */
export function bench(
  m: Motor,
  U: number,
  M: number,
  dt = 1e-5,
  duration = 0.5,
  theta = 0.5,
): { riseTime: number; final: SteadyPoint } {
  const e = electricalForm(m);
  const k = e.c * e.ke;
  const { c0, c1 } = lossCoefficients(m);
  const target = steady(m, U, M).speed;
  let i = 0;
  let w = 0;
  let rise = NaN;
  const n = Math.round(duration / dt);
  for (let s = 0; s < n; s++) {
    // (L/(θdt) + R)·Iθ + k·ωθ = U + L·I0/(θdt)
    // −k·Iθ + (J/(θdt) + c1)·ωθ = −M − c0 + J·ω0/(θdt)
    const a11 = e.l / (theta * dt) + e.r;
    const a12 = e.ke;
    const a21 = -k;
    const a22 = m.inertia / (theta * dt) + c1;
    const b1 = U + (e.l * i) / (theta * dt);
    const b2 = -M - c0 + (m.inertia * w) / (theta * dt);
    const det = a11 * a22 - a12 * a21;
    const iTh = (b1 * a22 - a12 * b2) / det;
    const wTh = (a11 * b2 - a21 * b1) / det;
    const w1 = w + (wTh - w) / theta;
    i = i + (iTh - i) / theta;
    if (Number.isNaN(rise) && w1 >= 0.632 * target) {
      // Linear interpolation inside the step.
      rise = (s + (0.632 * target - w) / (w1 - w)) * dt;
    }
    w = w1;
  }
  const current = i;
  return {
    riseTime: rise,
    final: { torque: M, speed: w, current, efficiency: w > 0 ? (M * w) / (U * current) : 0 },
  };
}

/** Continuous current at which the winding reaches its limit, at speed w (two-node steady state). */
export function thermalCurrent(m: Motor, ds: Datasheet, w: number): number {
  const th = ds.thermal!;
  const e = electricalForm(m);
  const lp = lossPowers(m, w);
  const pLoss = lp.friction + lp.iron;
  const rHot = e.r * (1 + m.copperAlpha * (th.tWindingMax - m.tRef));
  // T_w = T_a + R_ha·(P_cu + P_loss) + R_wh·P_cu
  const pCu =
    (th.tWindingMax - th.tAmbient - th.rHousingAmbient * pLoss) /
    (th.rHousingAmbient + th.rWindingHousing);
  return Math.sqrt(Math.max(0, pCu) / (e.c * rHot));
}

export interface Comparison {
  quantity: string;
  unit: string;
  published: number;
  model: number;
  error: number; // relative
  kind: 'predicted' | 'consistency';
  note?: string;
}

export function compareWinding(ds: Datasheet, w: Winding, split = LOSS_SPLIT): Comparison[] {
  const m = motorFromDatasheet(ds, w, split);
  const U = w.voltage;
  const out: Comparison[] = [];
  const add = (
    quantity: string,
    unit: string,
    published: number,
    model: number,
    kind: Comparison['kind'],
    note?: string,
  ): void => {
    const c: Comparison = {
      quantity,
      unit,
      published,
      model,
      error: (model - published) / published,
      kind,
    };
    if (note !== undefined) c.note = note;
    out.push(c);
  };

  const noLoad = steady(m, U, 0);
  add('No-load speed', 'rpm', w.noLoadSpeedRpm, toRpm(noLoad.speed), 'predicted');
  add(
    'No-load current',
    'A',
    w.noLoadCurrent,
    noLoad.current,
    'consistency',
    'the loss model is fitted to it',
  );
  const e = electricalForm(m);
  const k = e.c * e.ke;
  add('Starting current', 'A', w.startingCurrent, U / e.r, 'consistency', 'U/R');
  const { c0, c1 } = lossCoefficients(m);
  add(
    'Stall torque',
    'N·m',
    w.stallTorque,
    (k * U) / e.r - c0,
    'predicted',
    'net of the friction the model carries at standstill',
  );
  const slope = e.r / (k * k + e.r * c1); // rad/s per N·m
  add('Speed-torque slope', 'rpm/N·m', w.slopeRpmPerNm, toRpm(slope), 'predicted');
  add(
    'Speed constant × torque constant',
    'rpm·N·m/(V·A)',
    30 / Math.PI,
    w.speedConstantRpmPerV * w.torqueConstant,
    'consistency',
    'datasheet internal consistency (30/π for an ideal motor)',
  );
  const eta = maxEfficiency(m, U);
  add('Maximum efficiency', '%', w.etaMax * 100, eta.efficiency * 100, 'predicted');
  const rated = steady(m, U, w.ratedTorque);
  if (ds.thermal) {
    add(
      'Speed at rated torque, nominal voltage',
      'rpm',
      w.ratedSpeedRpm,
      toRpm(rated.speed),
      'predicted',
      'winding at 25 °C',
    );
    const hot = steady(m, U, w.ratedTorque, 1 + m.copperAlpha * (ds.thermal.tWindingMax - m.tRef));
    add(
      'Speed at rated torque, nominal voltage, hot',
      'rpm',
      w.ratedSpeedRpm,
      toRpm(hot.speed),
      'predicted',
      'winding at 125 °C',
    );
  }
  add('Current at rated torque', 'A', w.ratedCurrent, rated.current, 'predicted');
  const b = bench(m, U, 0, 1e-5, Math.max(0.2, 12 * w.mechTimeConstant));
  // Without inductance and loss the spin-up is first order with τ = J·R/k² exactly, which checks
  // the integrator against the definition the datasheets use.
  const ideal = bench(
    { ...m, lPhase: 0, frictionCoulomb: 0, frictionViscous: 0 },
    U,
    0,
    1e-5,
    Math.max(0.2, 12 * w.mechTimeConstant),
  );
  add(
    'Mechanical time constant, no inductance or loss (integrator check)',
    'ms',
    w.mechTimeConstant * 1e3,
    ideal.riseTime * 1e3,
    'consistency',
    'against J·R/k² from the datasheet: ' +
      (((m.inertia * e.r) / (k * k)) * 1e3).toFixed(3) +
      ' ms',
  );
  add(
    'Mechanical time constant (time-stepped spin-up)',
    'ms',
    w.mechTimeConstant * 1e3,
    b.riseTime * 1e3,
    'predicted',
    'includes inductance and friction; the datasheet uses J·R/k²',
  );
  if (ds.thermal) {
    const ic = thermalCurrent(m, ds, rpm(w.ratedSpeedRpm));
    add(
      'Continuous current at 125 °C winding',
      'A',
      w.ratedCurrent,
      ic,
      'predicted',
      'two-node steady state at the rated speed',
    );
  }
  return out;
}

/** Model speed and efficiency against the datasheet's line, from no load to 90 % of stall. */
export function curveError(
  ds: Datasheet,
  w: Winding,
  points = 19,
): {
  maxSpeedError: number;
  maxEfficiencyErrorPoints: number;
  rows: {
    torque: number;
    speedPublishedRpm: number;
    speedModelRpm: number;
    etaPublished: number;
    etaModel: number;
  }[];
} {
  const m = motorFromDatasheet(ds, w);
  const rows = [];
  let maxS = 0;
  let maxE = 0;
  for (let i = 0; i <= points; i++) {
    const M = (0.9 * w.stallTorque * i) / points;
    // The catalog's own curve: a straight speed-torque line through the no-load point with the
    // published slope, and current I0 + M/k (the way the makers draw their efficiency curves).
    const nPub = w.noLoadSpeedRpm - w.slopeRpmPerNm * M;
    const iPub = w.noLoadCurrent + M / w.torqueConstant;
    const etaPub = (M * rpm(nPub)) / (w.voltage * iPub);
    const p = steady(m, w.voltage, M);
    const nMod = toRpm(p.speed);
    maxS = Math.max(maxS, Math.abs(nMod - nPub) / w.noLoadSpeedRpm);
    maxE = Math.max(maxE, Math.abs(p.efficiency - etaPub) * 100);
    rows.push({
      torque: M,
      speedPublishedRpm: nPub,
      speedModelRpm: nMod,
      etaPublished: etaPub,
      etaModel: p.efficiency,
    });
  }
  return { maxSpeedError: maxS, maxEfficiencyErrorPoints: maxE, rows };
}
