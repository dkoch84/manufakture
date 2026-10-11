// The rep and session simulation (ADR 0017 decision 14, the M9 plan's decision 6, task T9.4b),
// productised from the T9.0b spike's `simulate` (docs/spikes/T9.0b-sim.md): a prescribed cable
// motion with the force its resistance law sets, stepped through the transmission, the motor,
// the controller, the pack and the braking resistor, with the thermal state carried through the
// whole run. Deterministic: the same job gives the same numbers, bit for bit on a given JavaScript
// engine
// (a browser worker or an agent's Node session); nothing here reads a clock except for the budget.
//
// The model, as the spike validated it:
// - The user is a prescribed motion (cable extension and speed against time) and the controller
//   is ideal force control: it feeds forward the inertia and the loss torques so the cable
//   carries the target force, unless a limit intervenes. The force the user feels comes out of
//   the shaft's torque balance `J·α = Te + F·r·η±/G − T_loss`, where the cable path's and the
//   reductions' efficiencies divide or multiply by which way power flows.
// - Motor: a surface-magnet PMSM in the rotor frame, i_d = 0, `T = Kt·i_q`, copper loss
//   `1.5·R(T_w)·|i|²`, Kt falling with the housing (magnet) temperature. `quasi-static` (the
//   default) lets the currents follow their references within a step; `full` runs a PI current
//   loop with decoupling and anti-windup on the RL plant, for transients.
// - Controller: fixed loss plus conduction `1.5·R_on·|i|²` plus switching ∝ Vbus·|i|, a current
//   limit and a voltage limit `m·Vbus/√3` (flagged; field weakening is not modelled).
// - Pack: `P = (OCV(SoC) − R·I)·I` solved for I; charging capped by its limit; the chopper sends
//   the surplus to the braking resistor. State of charge counts coulombs.
// - Thermal: the motor's winding and housing (copper into the winding; iron and friction into the
//   housing; housing to ambient), and optionally a pack node and a resistor node.
// - Integration: the theta method on every state; θ = 0.5 (the implicit midpoint rule, the
//   default) conserves the quadratic storages exactly when every power is taken at the midpoint,
//   so the energy ledger closes to rounding. That closure is partly by construction (the user's
//   force comes from the torque balance, the resistor takes the surplus): the tests check the
//   current, the kinetic energy and the charge against closed forms independently.

import { forceAt, type ForceLaw } from '../requirements/laws';
import { segmentKinematics, type SegmentPhase } from '../requirements/motion';
import {
  chargeLimitAt,
  lossPowers,
  packEnergy,
  packOcv,
  radiusAt,
  type SimMachine,
} from './machine';
import { profileDuration, segmentScale, type SimSegment } from './profile';
import { EnvelopeAccumulator, SIM_SERIES, type Envelope } from './series';

/** How the run steps and what it records. */
export interface SimOptions {
  /** Step, s; default 1 ms (quasi-static) or 50 µs (full). */
  dt?: number;
  /** 0.5 (default): implicit midpoint; 1: backward Euler. */
  theta?: number;
  electrical?: 'quasi-static' | 'full';
  /** Recorded points: one every `every` seconds, by default the run over `maxPoints` (2000). */
  record?: { every?: number; maxPoints?: number };
  /** Wall-clock budget, ms: the run stops there with status `budget`. Absent: none. */
  budgetMs?: number;
}

/** The state carried across runs: charge and temperatures (K). */
export interface SimState {
  soc: number;
  windingTemperature?: number;
  housingTemperature?: number;
  packTemperature?: number;
  resistorTemperature?: number;
}

/** Component ids of the electrical system, for the `electrical/<id>/<quantity>` series. */
export interface SimComponents {
  controller?: string;
  /** The braking resistor. */
  resistor?: string;
  /** A separate chopper; absent: the controller's own brake output feeds the resistor. */
  chopper?: string;
}

/** Everything a run needs. Plain JSON. */
export interface SimJob {
  machine: SimMachine;
  law: ForceLaw;
  segments: SimSegment[];
  start: SimState;
  options?: SimOptions;
  components?: SimComponents;
}

/** Energy over the run, J. `userWork + packChemical = storage + losses + residual`. */
export interface SimLedger {
  /** Net work the user put into the cable. */
  userWork: number;
  userWorkIn: number;
  userWorkOut: number;
  /** Chemical energy the pack released, from its state of charge (negative when charged). */
  packChemical: number;
  kinetic: number;
  magnetic: number;
  cable: number;
  reduction: number;
  friction: number;
  iron: number;
  copper: number;
  controller: number;
  aux: number;
  resistor: number;
  packResistance: number;
  /** Regenerated energy with nowhere to go (no resistor). */
  unabsorbed: number;
  /**
   * Energy the bus asked for beyond the most the pack can give (OCV² / 4R): an input on the
   * ledger's left side, since nothing modelled supplies it.
   */
  unsupplied: number;
  residual: number;
  /** |residual| over the gross energy in (user work in plus pack energy released). */
  residualRelative: number;
}

export interface ThermalLedger {
  heatIn: number;
  stored: number;
  rejected: number;
  residual: number;
}

/** Per phase of the motion (pull, return, pause, hold, rest). */
export interface PhaseStats {
  duration: number;
  userWork: number;
  /** At the DC bus from the controller and the always-on loads: positive drawn. */
  busEnergy: number;
  busReturned: number;
  busReturnedPeak: number;
  packCharged: number;
  resistor: number;
  copper: number;
}

export type SimWarningCode =
  | 'current-limit'
  | 'voltage-limit'
  | 'brake-overload'
  | 'unabsorbed'
  | 'below-cutoff'
  | 'pack-power-limit'
  | 'pack-empty'
  | 'slack'
  | 'ledger';

export interface SimWarning {
  code: SimWarningCode;
  /** Steps it held for. */
  steps: number;
  message: string;
}

export type SimStatus = 'done' | 'budget' | 'cancelled';

export interface SimResult {
  status: SimStatus;
  /** Simulated time reached, s, and the profile's whole duration. */
  time: number;
  duration: number;
  steps: number;
  dt: number;
  electrical: 'quasi-static' | 'full';
  ledger: SimLedger;
  thermal: { motor?: ThermalLedger; pack?: ThermalLedger; resistor?: ThermalLedger };
  phases: Partial<Record<SegmentPhase, PhaseStats>>;
  start: SimState;
  end: SimState;
  /** By series name, from every step. */
  envelopes: Record<string, Envelope>;
  /** Recorded points: `t` (s) and each series' values at those times. */
  series: { t: number[]; values: Record<string, number[]> };
  warnings: SimWarning[];
  /** Force the user feels minus the target (non-zero only where a limit or the loop lags), N. */
  forceError: { maxAbs: number; rms: number };
}

const SQRT3 = Math.sqrt(3);

// Every series a step computes, in a fixed order; a run includes those its machine gives.
const BASE = Object.keys(SIM_SERIES) as (keyof typeof SIM_SERIES)[];
const IDX = Object.fromEntries(BASE.map((k, i) => [k, i])) as Record<
  keyof typeof SIM_SERIES,
  number
>;
const E_CTRL_BUS = BASE.length;
const E_CTRL_PHASE = BASE.length + 1;
const E_RES = BASE.length + 2;
const E_CHOP = BASE.length + 3;
const SLOTS = BASE.length + 4;

const emptyLedger = (): SimLedger => ({
  userWork: 0,
  userWorkIn: 0,
  userWorkOut: 0,
  packChemical: 0,
  kinetic: 0,
  magnetic: 0,
  cable: 0,
  reduction: 0,
  friction: 0,
  iron: 0,
  copper: 0,
  controller: 0,
  aux: 0,
  resistor: 0,
  packResistance: 0,
  unabsorbed: 0,
  unsupplied: 0,
  residual: 0,
  residualRelative: 0,
});

const emptyThermal = (): ThermalLedger => ({ heatIn: 0, stored: 0, rejected: 0, residual: 0 });

const emptyPhase = (): PhaseStats => ({
  duration: 0,
  userWork: 0,
  busEnergy: 0,
  busReturned: 0,
  busReturnedPeak: 0,
  packCharged: 0,
  resistor: 0,
  copper: 0,
});

/** Which series a job's run gives, as (name, slot) pairs. */
function seriesPlan(job: SimJob): { names: string[]; slots: number[] } {
  const m = job.machine;
  const names: string[] = [];
  const slots: number[] = [];
  for (const k of BASE) {
    if ((k === 'motor/winding-temperature' || k === 'motor/housing-temperature') && !m.motorThermal)
      continue;
    if (k === 'pack/temperature' && !m.pack.thermal) continue;
    if (
      (k === 'resistor/temperature' && !m.brake?.thermal) ||
      (k.startsWith('resistor/') && !m.brake)
    )
      continue;
    if (k === 'unabsorbed/power' && m.brake) continue;
    names.push(k);
    slots.push(IDX[k]);
  }
  const c = job.components ?? {};
  if (c.controller !== undefined) {
    names.push(
      `electrical/${c.controller}/bus-current`,
      `electrical/${c.controller}/phase-current`,
    );
    slots.push(E_CTRL_BUS, E_CTRL_PHASE);
  }
  if (c.resistor !== undefined && m.brake) {
    names.push(`electrical/${c.resistor}/resistor-current`);
    slots.push(E_RES);
  }
  if (c.chopper !== undefined) {
    names.push(`electrical/${c.chopper}/bus-current`);
    slots.push(E_CHOP);
  }
  return { names, slots };
}

/** A run in progress: `advance` it in slices, then read its `result`. */
export class Simulation {
  readonly duration: number;
  readonly totalSteps: number;
  readonly dt: number;
  private readonly theta: number;
  private readonly full: boolean;
  private readonly job: SimJob;
  private readonly starts: number[];
  private n = 0;
  // States.
  private soc: number;
  private tw: number;
  private th: number;
  private tp: number;
  private tr: number;
  private id = 0;
  private iq = 0;
  private xd = 0;
  private xq = 0;
  private vTerm: number;
  private k0: { x: number; v: number };
  private r0: number;
  private w00: number;
  private wEnd: number;
  private seg = 0;
  private segMid = 0;
  // Results.
  private readonly ledger = emptyLedger();
  private readonly motorHeat = emptyThermal();
  private readonly packHeat = emptyThermal();
  private readonly resistorHeat = emptyThermal();
  private readonly phases: Partial<Record<SegmentPhase, PhaseStats>> = {};
  private readonly counts: Record<SimWarningCode, number> = {
    'current-limit': 0,
    'voltage-limit': 0,
    'brake-overload': 0,
    unabsorbed: 0,
    'below-cutoff': 0,
    'pack-power-limit': 0,
    'pack-empty': 0,
    slack: 0,
    ledger: 0,
  };
  private feMax = 0;
  private feSq = 0;
  private packChemOut = 0;
  private readonly e0Pack: number;
  private readonly startState: SimState;
  private readonly values = new Float64Array(SLOTS);
  private readonly compact: Float64Array;
  private readonly plan: { names: string[]; slots: number[] };
  private readonly acc: EnvelopeAccumulator;
  private readonly recStride: number;
  private readonly recT: number[] = [];
  private readonly recV: number[][];
  private forceScale = 0;

  constructor(job: SimJob) {
    this.job = job;
    const opts = job.options ?? {};
    this.full = (opts.electrical ?? 'quasi-static') === 'full';
    this.dt = opts.dt ?? (this.full ? 50e-6 : 1e-3);
    if (!(this.dt > 0)) throw new Error('the step must be above zero');
    this.theta = opts.theta ?? 0.5;
    if (!(this.theta >= 0.5 && this.theta <= 1)) throw new Error('theta is from 0.5 to 1');
    if (job.segments.length === 0) throw new Error('the profile has no segments');
    this.starts = [];
    let t = 0;
    for (const s of job.segments) {
      this.starts.push(t);
      t += s.duration;
    }
    this.duration = profileDuration(job.segments);
    this.totalSteps = Math.round(this.duration / this.dt);
    const m = job.machine;
    this.soc = job.start.soc;
    this.tw = m.motorThermal ? (job.start.windingTemperature ?? m.ambient) : m.ambient;
    this.th = m.motorThermal ? (job.start.housingTemperature ?? m.ambient) : m.ambient;
    this.tp = m.pack.thermal ? (job.start.packTemperature ?? m.ambient) : m.ambient;
    this.tr = m.brake?.thermal ? (job.start.resistorTemperature ?? m.ambient) : m.ambient;
    this.startState = this.state();
    this.vTerm = packOcv(m.pack, this.soc);
    this.e0Pack = packEnergy(m.pack, this.soc);
    this.k0 = this.kinAt(0);
    this.r0 = radiusAt(m.transmission.radius, this.k0.x);
    this.w00 = (m.transmission.ratio * this.k0.v) / this.r0;
    this.wEnd = this.w00;
    this.plan = seriesPlan(job);
    this.compact = new Float64Array(this.plan.names.length);
    this.acc = new EnvelopeAccumulator(this.plan.names);
    this.recV = this.plan.names.map(() => []);
    const rec = opts.record ?? {};
    const every = rec.every ?? this.duration / (rec.maxPoints ?? 2000);
    this.recStride = Math.max(1, Math.round(every / this.dt));
    this.forceScale = job.law.force;
    if (this.full) this.startCurrentLoop();
  }

  /** Steps done over steps in the run, 0 to 1. */
  get progress(): number {
    return this.totalSteps === 0 ? 1 : this.n / this.totalSteps;
  }

  get done(): boolean {
    return this.n >= this.totalSteps;
  }

  private state(): SimState {
    const m = this.job.machine;
    return {
      soc: this.soc,
      ...(m.motorThermal ? { windingTemperature: this.tw, housingTemperature: this.th } : {}),
      ...(m.pack.thermal ? { packTemperature: this.tp } : {}),
      ...(m.brake?.thermal ? { resistorTemperature: this.tr } : {}),
    };
  }

  /** Extension and speed at time t; steps are monotonic, so the walk only goes forward. */
  private kinAt(t: number): { x: number; v: number } {
    const segs = this.job.segments;
    while (this.seg < segs.length - 1 && t >= this.starts[this.seg + 1]! - 1e-12) this.seg++;
    return segmentKinematics(segs[this.seg]!, t - this.starts[this.seg]!);
  }

  /** Full mode starts in steady state on the first segment's force, not from a current step. */
  private startCurrentLoop(): void {
    const m = this.job.machine;
    const first = this.job.segments[0]!;
    const tx = this.r0 / m.transmission.ratio;
    const kTorque = m.motor.kt * (1 + m.motor.magnetAlpha * (this.th - m.motor.reference));
    const f = forceAt(this.job.law, this.k0.x, this.k0.v) * segmentScale(first, 0);
    const lim = m.controller.currentLimit ?? Infinity;
    const ref = Math.max(-lim, Math.min(lim, (-f * tx) / kTorque));
    this.iq = ref;
    this.xq = m.motor.resistance * (1 + m.motor.copperAlpha * (this.tw - m.motor.reference)) * ref;
  }

  /** Runs up to `maxSteps` steps; true when the run is complete. */
  advance(maxSteps: number): boolean {
    const end = Math.min(this.totalSteps, this.n + Math.max(0, Math.floor(maxSteps)));
    while (this.n < end) this.step();
    return this.done;
  }

  private step(): void {
    const job = this.job;
    const m = job.machine;
    const { motor, controller: ctl, pack, brake, transmission: tm } = m;
    const segs = job.segments;
    const dt = this.dt;
    const theta = this.theta;
    const n = this.n;
    const t0 = n * dt;
    const t1 = t0 + dt;
    const tmid = t0 + theta * dt;
    while (this.segMid < segs.length - 1 && tmid >= this.starts[this.segMid + 1]!) this.segMid++;
    const sg = segs[this.segMid]!;
    const k0 = this.k0;
    const k1 = this.kinAt(t1);
    const G = tm.ratio;
    const r0 = this.r0;
    const r1 = radiusAt(tm.radius, k1.x);
    const xth = (1 - theta) * k0.x + theta * k1.x;
    const rth = radiusAt(tm.radius, xth);
    const w0 = (G * k0.v) / r0;
    const w1 = (G * k1.v) / r1;
    const wth = (1 - theta) * w0 + theta * w1;
    const alpha = (w1 - w0) / dt;
    // The cable speed the shaft moves the cable at, at the theta point.
    const vth = (rth * wth) / G;

    const rT = motor.resistance * (1 + motor.copperAlpha * (this.tw - motor.reference));
    const ktScale = 1 + motor.magnetAlpha * (this.th - motor.reference);
    const kTorque = motor.kt * ktScale;
    const ke = kTorque / 1.5;
    const L = motor.inductance;
    const we = motor.polePairs * wth;

    let etaC = 1;
    let etaG = 1;
    if (vth > 0) {
      etaC = tm.cableEfficiency;
      etaG = tm.efficiency;
    } else if (vth < 0) {
      etaC = 1 / tm.cableEfficiency;
      etaG = 1 / tm.efficiency;
    }
    const txFactor = (rth * etaC * etaG) / G;
    const J = tm.inertia;

    const lp = lossPowers(motor, wth);
    const lossTorque = wth === 0 ? 0 : ((lp.friction + lp.iron) / Math.abs(wth)) * Math.sign(wth);

    const u = sg.duration > 0 ? (tmid - this.starts[this.segMid]!) / sg.duration : 0;
    const fTarget = forceAt(job.law, xth, vth) * segmentScale(sg, Math.min(1, Math.max(0, u)));
    const teReq = J * alpha - fTarget * txFactor + lossTorque;
    let iqRef = teReq / kTorque;
    const lim = ctl.currentLimit ?? Infinity;
    if (Math.abs(iqRef) > lim) {
      iqRef = Math.sign(iqRef) * lim;
      this.counts['current-limit']++;
    }
    const vMax = (ctl.modulation / SQRT3) * this.vTerm;

    let idTh: number;
    let iqTh: number;
    let id1: number;
    let iq1: number;
    let vd: number;
    let vq: number;
    if (this.full) {
      const wc = 2 * Math.PI * ctl.loopHz;
      const kp = L * wc;
      const ki = motor.resistance * wc;
      const ed = 0 - this.id;
      const eq = iqRef - this.iq;
      let vdc = kp * ed + this.xd - we * L * this.iq;
      let vqc = kp * eq + this.xq + we * L * this.id + ke * wth;
      const mag = Math.hypot(vdc, vqc);
      if (mag > vMax) {
        vdc *= vMax / mag;
        vqc *= vMax / mag;
        this.counts['voltage-limit']++;
      } else {
        this.xd += ki * ed * dt;
        this.xq += ki * eq * dt;
      }
      vd = vdc;
      vq = vqc;
      const a = L / (theta * dt) + rT;
      const b = we * L;
      const rd = vd + (L * this.id) / (theta * dt);
      const rq = vq - ke * wth + (L * this.iq) / (theta * dt);
      const det = a * a + b * b;
      idTh = (a * rd + b * rq) / det;
      iqTh = (a * rq - b * rd) / det;
      id1 = this.id + (idTh - this.id) / theta;
      iq1 = this.iq + (iqTh - this.iq) / theta;
    } else {
      idTh = 0;
      iqTh = iqRef;
      vd = -we * L * iqTh;
      vq = rT * iqTh + ke * wth;
      if (Math.hypot(vd, vq) > vMax) this.counts['voltage-limit']++;
      id1 = idTh;
      iq1 = iqTh;
    }
    const voltageUse = vMax > 0 ? Math.hypot(vd, vq) / vMax : Infinity;

    const iMag2 = idTh * idTh + iqTh * iqTh;
    const pIn = 1.5 * (vd * idTh + vq * iqTh);
    const pCu = 1.5 * rT * iMag2;
    const te = kTorque * iqTh;
    // Magnetic storage only in the full mode: the quasi-static voltages have no L·di/dt term, so
    // nothing supplies it there.
    const eMag = this.full
      ? 0.75 * L * (id1 * id1 + iq1 * iq1 - (this.id * this.id + this.iq * this.iq))
      : 0;

    const force = (J * alpha - te + lossTorque) / txFactor;
    if (force < -1e-9 * Math.max(1, this.forceScale)) this.counts.slack++;
    const fErr = force - fTarget;
    this.feMax = Math.max(this.feMax, Math.abs(fErr));
    this.feSq += fErr * fErr;

    const pUser = force * vth;
    const pSpool = pUser * etaC;
    const pShaft = pSpool * etaG;
    const lossCable = pUser - pSpool;
    const lossRed = pSpool - pShaft;

    const iAbs = Math.sqrt(iMag2);
    const pCond = 1.5 * ctl.legResistance * iMag2;
    const pSw =
      3 * 0.5 * this.vTerm * (2 / Math.PI) * iAbs * ctl.switchingTime * ctl.switchingFrequency;
    const pCtl = ctl.fixedLoss + pCond + pSw;
    const pDrive = pIn + pCtl;
    const pBus = pDrive + m.aux;

    // Pack: P = (OCV − R·I)·I solved for I; the charge limit caps charging; the chopper burns the
    // surplus in the braking resistor (or, with none, it is unabsorbed).
    const ocv = packOcv(pack, this.soc);
    const R = pack.resistance;
    // Past OCV² / 4R the pack cannot deliver: it gives its most (at I = OCV / 2R) and the rest
    // is booked as unsupplied, with a warning, rather than vanishing.
    const disc = ocv * ocv - 4 * R * pBus;
    let pShort = 0;
    let iPack: number;
    if (R > 0 && disc < 0) {
      pShort = pBus - (ocv * ocv) / (4 * R);
      iPack = ocv / (2 * R);
      this.counts['pack-power-limit']++;
    } else iPack = R > 0 ? (ocv - Math.sqrt(disc)) / (2 * R) : pBus / ocv;
    let surplus = 0;
    const iChgMax = chargeLimitAt(pack, this.soc);
    if (iPack < -iChgMax) {
      iPack = -iChgMax;
      surplus = (ocv - R * iPack) * iPack - pBus;
    }
    const vT = ocv - R * iPack;
    let pRes = 0;
    let pLost = 0;
    let duty = 0;
    if (brake) {
      pRes = surplus;
      const resMax = (vT * vT) / brake.resistance;
      if (pRes > resMax * (1 + 1e-9)) this.counts['brake-overload']++;
      duty = resMax > 0 ? pRes / resMax : 0;
    } else {
      pLost = surplus;
      if (pLost > 1e-9) this.counts.unabsorbed++;
    }
    const pRint = R * iPack * iPack;
    if (iPack > 0) this.packChemOut += ocv * iPack * dt;
    if (pack.cutoff !== undefined && vT < pack.cutoff) this.counts['below-cutoff']++;
    if (this.soc <= 0 && iPack > 0) this.counts['pack-empty']++;

    // Thermal nodes, theta method.
    const pH = lp.iron + lp.friction;
    let tw1 = this.tw;
    let th1 = this.th;
    if (m.motorThermal) {
      const T = m.motorThermal;
      const g1 = 1 / T.windingToHousing;
      const g2 = 1 / T.housingToAmbient;
      const a11 = T.windingCapacity / (theta * dt) + g1;
      const a22 = T.housingCapacity / (theta * dt) + g1 + g2;
      const b1 = pCu + (T.windingCapacity * this.tw) / (theta * dt);
      const b2 = pH + g2 * m.ambient + (T.housingCapacity * this.th) / (theta * dt);
      const detT = a11 * a22 - g1 * g1;
      const twTh = (b1 * a22 + g1 * b2) / detT;
      const thTh = (a11 * b2 + g1 * b1) / detT;
      tw1 = this.tw + (twTh - this.tw) / theta;
      th1 = this.th + (thTh - this.th) / theta;
      this.motorHeat.heatIn += (pCu + pH) * dt;
      this.motorHeat.rejected += g2 * (thTh - m.ambient) * dt;
    }
    const node = (
      node: { capacity: number; toAmbient: number },
      t: number,
      p: number,
      ledger: ThermalLedger,
    ): number => {
      const g = 1 / node.toAmbient;
      const c = node.capacity / (theta * dt);
      const tth = (c * t + p + g * m.ambient) / (c + g);
      ledger.heatIn += p * dt;
      ledger.rejected += g * (tth - m.ambient) * dt;
      return t + (tth - t) / theta;
    };
    const tp1 = pack.thermal ? node(pack.thermal, this.tp, pRint, this.packHeat) : this.tp;
    const tr1 = brake?.thermal ? node(brake.thermal, this.tr, pRes, this.resistorHeat) : this.tr;

    // Ledger.
    const Lg = this.ledger;
    Lg.userWork += pUser * dt;
    if (pUser > 0) Lg.userWorkIn += pUser * dt;
    else Lg.userWorkOut -= pUser * dt;
    Lg.magnetic += eMag;
    Lg.cable += lossCable * dt;
    Lg.reduction += lossRed * dt;
    Lg.friction += lp.friction * dt;
    Lg.iron += lp.iron * dt;
    Lg.copper += pCu * dt;
    Lg.controller += pCtl * dt;
    Lg.aux += m.aux * dt;
    Lg.resistor += pRes * dt;
    Lg.unabsorbed += pLost * dt;
    Lg.unsupplied += pShort * dt;
    Lg.packResistance += pRint * dt;

    let ph = this.phases[sg.phase];
    if (ph === undefined) {
      ph = emptyPhase();
      this.phases[sg.phase] = ph;
    }
    ph.duration += dt;
    ph.userWork += pUser * dt;
    ph.busEnergy += pBus * dt;
    if (pBus < 0) {
      ph.busReturned -= pBus * dt;
      ph.busReturnedPeak = Math.max(ph.busReturnedPeak, -pBus);
    }
    if (iPack < 0) ph.packCharged -= vT * iPack * dt;
    ph.resistor += pRes * dt;
    ph.copper += pCu * dt;

    // Advance the states.
    this.id = id1;
    this.iq = iq1;
    this.tw = tw1;
    this.th = th1;
    this.tp = tp1;
    this.tr = tr1;
    this.soc -= (iPack * dt) / pack.capacity;
    this.vTerm = vT;
    this.k0 = k1;
    this.r0 = r1;
    this.wEnd = w1;
    this.n = n + 1;

    // Series: powers and currents at the theta point, states at the end of the step.
    const v = this.values;
    v[IDX['cable/position']] = k1.x;
    v[IDX['cable/speed']] = vth;
    v[IDX['cable/force']] = force;
    v[IDX['cable/target-force']] = fTarget;
    v[IDX['user/power']] = pUser;
    v[IDX['cable/loss-power']] = lossCable;
    v[IDX['reduction/loss-power']] = lossRed;
    v[IDX['motor/speed']] = wth;
    v[IDX['motor/torque']] = te;
    v[IDX['motor/current']] = iAbs;
    v[IDX['motor/voltage-use']] = voltageUse;
    v[IDX['motor/copper-power']] = pCu;
    v[IDX['motor/iron-power']] = lp.iron;
    v[IDX['motor/friction-power']] = lp.friction;
    v[IDX['motor/shaft-power']] = te * wth;
    v[IDX['controller/loss-power']] = pCtl;
    v[IDX['bus/power']] = pBus;
    v[IDX['aux/power']] = m.aux;
    v[IDX['pack/current']] = iPack;
    v[IDX['pack/voltage']] = vT;
    v[IDX['pack/state-of-charge']] = this.soc;
    v[IDX['pack/loss-power']] = pRint;
    v[IDX['pack/charge-power']] = iPack < 0 ? -vT * iPack : 0;
    v[IDX['resistor/power']] = pRes;
    v[IDX['resistor/duty']] = duty;
    v[IDX['unabsorbed/power']] = pLost;
    v[IDX['pack/unsupplied-power']] = pShort;
    v[IDX['motor/winding-temperature']] = tw1;
    v[IDX['motor/housing-temperature']] = th1;
    v[IDX['pack/temperature']] = tp1;
    v[IDX['resistor/temperature']] = tr1;
    const sep = job.components?.chopper !== undefined;
    v[E_CTRL_BUS] = (sep ? pDrive : pDrive + pRes) / vT;
    v[E_CTRL_PHASE] = iAbs;
    v[E_RES] = brake ? Math.sqrt(Math.max(0, pRes) / brake.resistance) : 0;
    v[E_CHOP] = pRes / vT;
    const slots = this.plan.slots;
    const c = this.compact;
    for (let i = 0; i < slots.length; i++) c[i] = v[slots[i]!]!;
    this.acc.add(c, dt);
    if (n % this.recStride === 0 || this.n === this.totalSteps) {
      this.recT.push(t1);
      for (let i = 0; i < c.length; i++) this.recV[i]!.push(c[i]!);
    }
  }

  /** The result so far: `done` once complete, else the status the caller stopped it with. */
  result(stopped: Exclude<SimStatus, 'done'> = 'budget'): SimResult {
    const m = this.job.machine;
    const L: SimLedger = { ...this.ledger };
    const J = m.transmission.inertia;
    L.kinetic = 0.5 * J * (this.wEnd * this.wEnd - this.w00 * this.w00);
    L.packChemical = this.e0Pack - packEnergy(m.pack, this.soc);
    const lhs = L.userWork + L.packChemical + L.unsupplied;
    const rhs =
      L.kinetic +
      L.magnetic +
      L.cable +
      L.reduction +
      L.friction +
      L.iron +
      L.copper +
      L.controller +
      L.aux +
      L.resistor +
      L.unabsorbed +
      L.packResistance;
    L.residual = lhs - rhs;
    const gross = L.userWorkIn + this.packChemOut + L.unsupplied;
    L.residualRelative = gross > 0 ? Math.abs(L.residual) / gross : 0;

    const s0 = this.startState;
    const thermal: SimResult['thermal'] = {};
    if (m.motorThermal) {
      const T = m.motorThermal;
      const h = { ...this.motorHeat };
      h.stored =
        T.windingCapacity * (this.tw - s0.windingTemperature!) +
        T.housingCapacity * (this.th - s0.housingTemperature!);
      h.residual = h.heatIn - h.stored - h.rejected;
      thermal.motor = h;
    }
    if (m.pack.thermal) {
      const h = { ...this.packHeat };
      h.stored = m.pack.thermal.capacity * (this.tp - s0.packTemperature!);
      h.residual = h.heatIn - h.stored - h.rejected;
      thermal.pack = h;
    }
    if (m.brake?.thermal) {
      const h = { ...this.resistorHeat };
      h.stored = m.brake.thermal.capacity * (this.tr - s0.resistorTemperature!);
      h.residual = h.heatIn - h.stored - h.rejected;
      thermal.resistor = h;
    }

    const values: Record<string, number[]> = {};
    this.plan.names.forEach((name, i) => (values[name] = this.recV[i]!.slice()));
    const done = this.done;
    return {
      status: done ? 'done' : stopped,
      time: this.n * this.dt,
      duration: this.duration,
      steps: this.n,
      dt: this.dt,
      electrical: this.full ? 'full' : 'quasi-static',
      ledger: L,
      thermal,
      phases: structuredClone(this.phases),
      start: { ...s0 },
      end: this.state(),
      envelopes: this.acc.envelopes(),
      series: { t: this.recT.slice(), values },
      warnings: this.warnings(L),
      forceError: {
        maxAbs: this.feMax,
        rms: this.n > 0 ? Math.sqrt(this.feSq / this.n) : 0,
      },
    };
  }

  private warnings(ledger: SimLedger): SimWarning[] {
    const out: SimWarning[] = [];
    const dt = this.dt;
    const time = (steps: number) => `${Number((steps * dt).toPrecision(3))} s`;
    const c = this.counts;
    const m = this.job.machine;
    if (c['current-limit'] > 0) {
      out.push({
        code: 'current-limit',
        steps: c['current-limit'],
        message: `The controller's current limit (${m.controller.currentLimit} A) held the current for ${time(c['current-limit'])}: the cable force fell short of the target there.`,
      });
    }
    if (c['voltage-limit'] > 0) {
      out.push({
        code: 'voltage-limit',
        steps: c['voltage-limit'],
        message: `The motor needed more voltage than the bus offers for ${time(c['voltage-limit'])}; field weakening is not modelled.`,
      });
    }
    if (c['brake-overload'] > 0) {
      out.push({
        code: 'brake-overload',
        steps: c['brake-overload'],
        message: `The braking resistor had to take more than V²/R at the bus voltage for ${time(c['brake-overload'])}.`,
      });
    }
    if (c.unabsorbed > 0) {
      out.push({
        code: 'unabsorbed',
        steps: c.unabsorbed,
        message: `For ${time(c.unabsorbed)} the motor returned more power than the pack accepts and there is no braking resistor: ${Number(this.ledger.unabsorbed.toPrecision(3))} J had nowhere to go.`,
      });
    }
    if (c['below-cutoff'] > 0) {
      out.push({
        code: 'below-cutoff',
        steps: c['below-cutoff'],
        message: `The pack's terminal voltage was below its cutoff (${m.pack.cutoff} V) for ${time(c['below-cutoff'])}.`,
      });
    }
    if (c['pack-power-limit'] > 0) {
      out.push({
        code: 'pack-power-limit',
        steps: c['pack-power-limit'],
        message: `For ${time(c['pack-power-limit'])} the bus asked for more than the pack can give (OCV² / 4R, at half its open-circuit voltage): ${Number(ledger.unsupplied.toPrecision(3))} J was not supplied, and the numbers past that point do not describe a machine that runs.`,
      });
    }
    if (c['pack-empty'] > 0) {
      out.push({
        code: 'pack-empty',
        steps: c['pack-empty'],
        message: `The pack was empty (state of charge at or below 0) and still drawn on for ${time(c['pack-empty'])}; the run counts on past it with the OCV held at its 0 % value.`,
      });
    }
    if (c.slack > 0) {
      out.push({
        code: 'slack',
        steps: c.slack,
        message: `The cable would have gone slack for ${time(c.slack)}: the drivetrain's inertia or losses need more than the target force.`,
      });
    }
    if (ledger.residualRelative > 0.01) {
      out.push({
        code: 'ledger',
        steps: this.n,
        message: `The energy ledger does not close: ${Number(ledger.residual.toPrecision(3))} J unaccounted for, ${Number((ledger.residualRelative * 100).toPrecision(3))} % of the energy in. The step is too long for this run, or the model is outside what it covers.`,
      });
    }
    return out;
  }
}

/** How often the synchronous run looks at the clock, in steps. */
const CLOCK_STRIDE = 4096;

function now(): number {
  return globalThis.performance?.now() ?? Date.now();
}

/**
 * Runs a job to its end on this thread, or until its budget (`options.budgetMs`) or `shouldStop`
 * stops it (status `budget` or `cancelled`).
 */
export function simulate(job: SimJob, shouldStop?: () => boolean): SimResult {
  const sim = new Simulation(job);
  const budget = job.options?.budgetMs;
  const t0 = budget !== undefined ? now() : 0;
  while (!sim.advance(CLOCK_STRIDE)) {
    if (shouldStop?.()) return sim.result('cancelled');
    if (budget !== undefined && now() - t0 > budget) return sim.result('budget');
  }
  return sim.result();
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Fraction done, 0 to 1, after each slice. */
  onProgress?: (fraction: number) => void;
  /** Wall time per slice before yielding to the event loop, ms (default 25). */
  sliceMs?: number;
}

/**
 * Runs a job in slices, yielding between them so a worker hears a cancel and a page stays
 * responsive. Resolves with status `cancelled` when the signal aborts, `budget` past the budget.
 */
export async function runSimulation(job: SimJob, options: RunOptions = {}): Promise<SimResult> {
  const sim = new Simulation(job);
  const budget = job.options?.budgetMs;
  const slice = options.sliceMs ?? 25;
  const t0 = now();
  for (;;) {
    if (options.signal?.aborted) return sim.result('cancelled');
    const s0 = now();
    while (!sim.done && now() - s0 < slice) sim.advance(CLOCK_STRIDE);
    options.onProgress?.(sim.progress);
    if (sim.done) return sim.result();
    if (budget !== undefined && now() - t0 > budget) return sim.result('budget');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
