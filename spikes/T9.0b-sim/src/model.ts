// The lumped electromechanical model of the M9 plan's decision 6: one degree of freedom along the
// drivetrain (cable, spool, reduction, rotor), a surface-magnet PMSM in the rotor frame (dq), a
// controller with current and voltage limits and fixed losses, a pack with an open-circuit voltage
// curve, internal resistance and a charge-acceptance limit, a braking resistor on a chopper, and a
// two-node thermal model of the motor (winding, stator and housing).
//
// The user is a prescribed motion (cable position and speed against time) with a target cable
// force, so the force the user feels is an output and every run is repeatable.
//
// Sign conventions: positive cable speed is paying out (the user pulls); positive shaft speed and
// torque point the same way. A motor resisting a pull therefore has negative torque and positive
// speed, and generates. Currents are amplitude-invariant dq currents (A peak phase current) in FOC
// mode, and the DC current in six-step mode.
//
// Integration is the theta method on every state: theta = 0.5 is the implicit midpoint rule (second
// order, A-stable, and it conserves quadratic storage exactly, so the energy ledger closes to
// rounding when every power is evaluated at the theta point); theta = 1 is backward Euler (first
// order, numerically dissipative), kept to show what the choice costs.

export interface Motor {
  name: string;
  polePairs: number;
  /** Torque constant at the reference temperature: N·m per A of q-axis current (A peak phase). */
  kt: number;
  /** Phase resistance at the reference temperature (ohm). Line-to-line is twice this. */
  rPhase: number;
  /** Phase inductance (H), Ld = Lq. Line-to-line is twice this. */
  lPhase: number;
  /** Rotor inertia (kg·m²). */
  inertia: number;
  /** Bearing friction: Coulomb (N·m) and viscous (N·m·s/rad). */
  frictionCoulomb: number;
  frictionViscous: number;
  /** Iron loss P = ironHyst·|ω| + ironEddy·ω² (W, ω in rad/s at the shaft). */
  ironHyst: number;
  ironEddy: number;
  /** Copper resistance coefficient (1/K) and magnet torque-constant coefficient (1/K). */
  copperAlpha: number;
  magnetAlpha: number;
  /** Temperature at which kt and rPhase are given (°C). */
  tRef: number;
  /** 'foc': sinusoidal currents in dq. 'six-step': block commutation as its DC equivalent. */
  commutation: 'foc' | 'six-step';
}

export interface Thermal {
  /** Winding node heat capacity (J/K) and winding-to-housing thermal resistance (K/W). */
  cWinding: number;
  rWindingHousing: number;
  /** Stator and housing node heat capacity (J/K) and housing-to-ambient resistance (K/W). */
  cHousing: number;
  rHousingAmbient: number;
  tAmbient: number;
}

export interface Drivetrain {
  /** Effective spool radius (m). */
  spoolRadius: number;
  /** Reduction ratio, motor turns per spool turn (1 for direct drive). */
  ratio: number;
  /** Efficiency of the reduction and of the cable path (fairlead, bending, spool bearings). */
  etaReduction: number;
  etaCable: number;
  /** Inertia on the spool shaft (spool, pulley), reflected to the motor through the ratio. */
  spoolInertia: number;
}

export interface Controller {
  /** Current limit (A peak phase in FOC, A DC in six-step). */
  currentLimit: number;
  /** Maximum modulation: |v| <= m·Vbus/√3 in FOC, |v| <= m·Vbus in six-step. */
  modulationMax: number;
  /** Current-loop bandwidth (Hz), used by the full electrical mode. */
  currentLoopHz: number;
  /** Fixed losses: gate drive, MCU, sensors (W). */
  fixed: number;
  /** Effective on-resistance per phase leg (ohm): conduction loss c·rOn·|i|². */
  rOn: number;
  /** Switching: P = 3 · ½ · Vbus · (2/π)|i| · tSwitch · fSwitch in FOC. */
  tSwitch: number;
  fSwitch: number;
  /** Always-on loads outside the controller (display, radio, encoder, load cell) (W). */
  aux: number;
}

export interface Pack {
  seriesCells: number;
  /** Capacity (Ah). */
  capacityAh: number;
  /** Cell open-circuit voltage at evenly listed state-of-charge breakpoints (V), 0 to 1. */
  ocvSoc: number[];
  ocvVolts: number[];
  /** Pack internal resistance including interconnects, fuse and BMS switches (ohm). */
  rInternal: number;
  /** Charge current limit (A) up to soc taperStart, falling linearly to 0 at soc 1. */
  chargeLimit: number;
  taperStart: number;
  /** Cell voltage under load below which the BMS would cut off (V). */
  cutoffCell: number;
}

export interface Brake {
  /** Braking resistor (ohm) on an ideal chopper: it absorbs up to Vbus²/R. */
  resistance: number;
}

export interface Machine {
  motor: Motor;
  drivetrain: Drivetrain;
  controller: Controller;
  pack: Pack;
  brake: Brake;
  thermal: Thermal;
}

/** One piece of the prescribed motion. Moves follow a half-cosine (zero speed at both ends). */
export interface Segment {
  phase: 'pull' | 'return' | 'pause' | 'hold' | 'rest';
  duration: number;
  /** Cable extension at the start and the end (m). Equal for a pause, hold or rest. */
  from: number;
  to: number;
  /** Target cable force (N), at the start of the segment. */
  force: number;
  /** Target force at the end, for a linear ramp (default: constant). */
  forceTo?: number;
}

export interface SimOptions {
  /** Time step (s). */
  dt: number;
  /** 0.5 midpoint (default), 1 backward Euler. */
  theta?: number;
  /** 'full': current dynamics with a PI current loop. 'quasi-static': currents follow at once. */
  electrical?: 'full' | 'quasi-static';
  /** Initial state. */
  soc: number;
  tWinding?: number;
  tHousing?: number;
  /** Record a time series every `recordEvery` seconds (0 or absent: none). */
  recordEvery?: number;
}

export interface Ledger {
  /** Work the user put into the cable (positive) net of work the machine did on the user. */
  userWork: number;
  userWorkIn: number;
  userWorkOut: number;
  /** Chemical energy released by the pack, from the state of charge (negative when charged). */
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
  /** Left side minus right side of: userWork + packChemical = storage + losses. */
  residual: number;
  /** |residual| over the gross energy that entered (user work in plus pack energy released). */
  residualRelative: number;
}

export interface ThermalLedger {
  heatIn: number;
  stored: number;
  rejected: number;
  residual: number;
}

export interface PhaseStats {
  duration: number;
  userWork: number;
  /** Energy at the DC bus from the controller: positive drawn, negative returned. */
  busEnergy: number;
  busReturned: number;
  busReturnedPeakW: number;
  busReturnedMeanW: number;
  packCharged: number;
  resistor: number;
  copper: number;
}

export interface SimResult {
  ledger: Ledger;
  thermal: ThermalLedger;
  phases: Record<string, PhaseStats>;
  end: { t: number; soc: number; tWinding: number; tHousing: number };
  peaks: {
    tWinding: number;
    tHousing: number;
    current: number;
    torque: number;
    copperW: number;
    busReturnedW: number;
    resistorW: number;
    packDischargeA: number;
    packChargeA: number;
    voltageUse: number;
    minTerminalV: number;
    maxTerminalV: number;
    brakeDuty: number;
  };
  flags: {
    currentLimited: number;
    voltageLimited: number;
    brakeOverload: number;
    slack: number;
    belowCutoff: number;
  };
  forceError: { maxAbs: number; rms: number };
  steps: number;
  series?: Record<string, number[]>;
}

const SQRT3 = Math.sqrt(3);

/** Six-step back-EMF constant per unit of p·λ, for sinusoidal back-EMF: 3√3/π. */
export const SIX_STEP_FACTOR = (3 * SQRT3) / Math.PI;

/** Cell OCV at a state of charge, linear between evenly spaced breakpoints. */
export function cellOcv(pack: Pack, soc: number): number {
  const s = Math.min(1, Math.max(0, soc));
  const n = pack.ocvVolts.length - 1;
  const x = s * n;
  const i = Math.min(n - 1, Math.floor(x));
  const f = x - i;
  return pack.ocvVolts[i]! * (1 - f) + pack.ocvVolts[i + 1]! * f;
}

/** Integral of cell OCV over state of charge from 0 to soc (V), exact for the piecewise-linear curve. */
export function cellOcvIntegral(pack: Pack, soc: number): number {
  const s = Math.min(1, Math.max(0, soc));
  const n = pack.ocvVolts.length - 1;
  const h = 1 / n;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = i * h;
    if (s <= a) break;
    const b = Math.min(s, a + h);
    const va = pack.ocvVolts[i]!;
    const vb = pack.ocvVolts[i + 1]!;
    // ∫ (va + (vb − va)·u/h) du over [0, b − a]
    sum += (b - a) * (va + ((vb - va) * (b - a)) / (2 * h));
  }
  return sum;
}

/** Chemical energy (J) the pack holds between state of charge 0 and soc. */
export function packEnergy(pack: Pack, soc: number): number {
  return pack.seriesCells * pack.capacityAh * 3600 * cellOcvIntegral(pack, soc);
}

export function chargeLimit(pack: Pack, soc: number): number {
  if (soc <= pack.taperStart) return pack.chargeLimit;
  return Math.max(0, (pack.chargeLimit * (1 - soc)) / (1 - pack.taperStart));
}

/** Electrical constants of the model for a commutation mode. */
export function electricalForm(motor: Motor): {
  c: number;
  r: number;
  l: number;
  /** Back-EMF constant: V per rad/s of shaft speed, on the q axis (FOC) or the DC side. */
  ke: number;
  cross: boolean;
} {
  if (motor.commutation === 'foc') {
    return { c: 1.5, r: motor.rPhase, l: motor.lPhase, ke: motor.kt / 1.5, cross: true };
  }
  // Block commutation, two phases in series, sinusoidal back-EMF averaged over a sixty-degree
  // interval: the DC constant is (3√3/π)·p·λ, with p·λ = kt/1.5.
  return {
    c: 1,
    r: 2 * motor.rPhase,
    l: 2 * motor.lPhase,
    ke: (SIX_STEP_FACTOR * motor.kt) / 1.5,
    cross: false,
  };
}

/** Steady motor torque constant of the active commutation mode (N·m/A) at the reference temperature. */
export function torqueConstant(motor: Motor): number {
  const e = electricalForm(motor);
  return e.c * e.ke;
}

/** Friction and iron loss powers (W, positive) at shaft speed w (rad/s). */
export function lossPowers(motor: Motor, w: number): { friction: number; iron: number } {
  const a = Math.abs(w);
  return {
    friction: motor.frictionCoulomb * a + motor.frictionViscous * w * w,
    iron: motor.ironHyst * a + motor.ironEddy * w * w,
  };
}

interface Segments {
  starts: number[];
  total: number;
}

function indexSegments(segs: Segment[]): Segments {
  const starts: number[] = [];
  let t = 0;
  for (const s of segs) {
    starts.push(t);
    t += s.duration;
  }
  return { starts, total: t };
}

/** Cable extension and speed at time t within a segment. */
export function segmentKinematics(seg: Segment, tau: number): { x: number; v: number } {
  const d = seg.to - seg.from;
  if (d === 0 || seg.duration <= 0) return { x: seg.from, v: 0 };
  const u = Math.min(1, Math.max(0, tau / seg.duration));
  const x = seg.from + (d * (1 - Math.cos(Math.PI * u))) / 2;
  const v = ((d * Math.PI) / (2 * seg.duration)) * Math.sin(Math.PI * u);
  return { x, v };
}

export function profileDuration(segs: Segment[]): number {
  return indexSegments(segs).total;
}

function emptyPhase(): PhaseStats {
  return {
    duration: 0,
    userWork: 0,
    busEnergy: 0,
    busReturned: 0,
    busReturnedPeakW: 0,
    busReturnedMeanW: 0,
    packCharged: 0,
    resistor: 0,
    copper: 0,
  };
}

/**
 * Runs the prescribed profile through the machine and returns the ledger, the thermal ledger,
 * per-phase statistics, peaks and limit flags.
 */
export function simulate(machine: Machine, profile: Segment[], opts: SimOptions): SimResult {
  const { motor, drivetrain: dtn, controller: ctl, pack, brake, thermal: th } = machine;
  const theta = opts.theta ?? 0.5;
  const full = (opts.electrical ?? 'full') === 'full';
  const dt = opts.dt;
  const idx = indexSegments(profile);
  const steps = Math.round(idx.total / dt);

  const el = electricalForm(motor);
  const p = motor.polePairs;
  const G = dtn.ratio;
  const r = dtn.spoolRadius;
  const jTot = motor.inertia + dtn.spoolInertia / (G * G);
  const qAs = pack.capacityAh * 3600;
  const vLimitFactor = ctl.modulationMax / (motor.commutation === 'foc' ? SQRT3 : 1);
  const wc = 2 * Math.PI * ctl.currentLoopHz;
  const kp = el.l * wc;
  const ki = el.r * wc;

  let soc = opts.soc;
  let tw = opts.tWinding ?? th.tAmbient;
  let thh = opts.tHousing ?? th.tAmbient;
  let id = 0;
  let iq = 0;
  let xd = 0;
  let xq = 0;
  let vTerm = pack.seriesCells * cellOcv(pack, soc);

  const L: Ledger = {
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
    residual: 0,
    residualRelative: 0,
  };
  const TL: ThermalLedger = { heatIn: 0, stored: 0, rejected: 0, residual: 0 };
  const phases: Record<string, PhaseStats> = {};
  const peaks = {
    tWinding: tw,
    tHousing: thh,
    current: 0,
    torque: 0,
    copperW: 0,
    busReturnedW: 0,
    resistorW: 0,
    packDischargeA: 0,
    packChargeA: 0,
    voltageUse: 0,
    minTerminalV: Infinity,
    maxTerminalV: -Infinity,
    brakeDuty: 0,
  };
  const flags = {
    currentLimited: 0,
    voltageLimited: 0,
    brakeOverload: 0,
    slack: 0,
    belowCutoff: 0,
  };
  let feMax = 0;
  let feSq = 0;
  let feN = 0;
  let packChemOut = 0;

  const rec = opts.recordEvery && opts.recordEvery > 0 ? opts.recordEvery : 0;
  const recStride = rec ? Math.max(1, Math.round(rec / dt)) : 0;
  const series: Record<string, number[]> | undefined = rec
    ? {
        t: [],
        x: [],
        v: [],
        force: [],
        torque: [],
        current: [],
        copperW: [],
        busW: [],
        packA: [],
        resistorW: [],
        vTerm: [],
        tWinding: [],
        tHousing: [],
        soc: [],
      }
    : undefined;

  const e0Pack = packEnergy(pack, soc);
  const tw0 = tw;
  const th0 = thh;

  let seg = 0;
  const kinAt = (t: number): { x: number; v: number } => {
    // Steps are monotonic: walk forward only.
    while (seg < profile.length - 1 && t >= idx.starts[seg + 1]! - 1e-12) seg++;
    return segmentKinematics(profile[seg]!, t - idx.starts[seg]!);
  };

  let k0 = kinAt(0);
  const w00 = (G * k0.v) / r;
  {
    // Start in steady state on the first segment: the machine already carries its force, so the
    // first step does not measure the current loop's response to a step from zero.
    const first = profile[0]!;
    const txStatic = r / G;
    const ktScale0 = 1 + motor.magnetAlpha * (thh - motor.tRef);
    const ref = Math.max(
      -ctl.currentLimit,
      Math.min(ctl.currentLimit, (-first.force * txStatic) / (el.c * el.ke * ktScale0)),
    );
    iq = ref;
    // The PI integrator holds the resistive drop, so the loop needs no error to keep the current.
    xq = el.r * (1 + motor.copperAlpha * (tw - motor.tRef)) * ref;
  }
  let wEnd = w00;
  let segMid = 0;

  for (let n = 0; n < steps; n++) {
    const t0 = n * dt;
    const t1 = t0 + dt;
    const tm = t0 + theta * dt;
    // Segment of the theta point, for the target force and the phase label.
    while (segMid < profile.length - 1 && tm >= idx.starts[segMid + 1]!) segMid++;
    const sg = profile[segMid]!;
    const k1 = kinAt(t1);
    const v0 = k0.v;
    const v1 = k1.v;
    const vth = (1 - theta) * v0 + theta * v1;
    const w0 = (G * v0) / r;
    const w1 = (G * v1) / r;
    const wth = (1 - theta) * w0 + theta * w1;
    const alpha = (w1 - w0) / dt;

    // Temperature-dependent constants, from the state at the start of the step.
    const rT = el.r * (1 + motor.copperAlpha * (tw - motor.tRef));
    const ktScale = 1 + motor.magnetAlpha * (thh - motor.tRef);
    const ke = el.ke * ktScale;
    const kTorque = el.c * ke;
    const we = el.cross ? p * wth : 0;

    // Transmission: torque on the motor shaft per newton of cable force, by power direction.
    let etaC: number;
    let etaG: number;
    if (vth > 0) {
      etaC = dtn.etaCable;
      etaG = dtn.etaReduction;
    } else if (vth < 0) {
      etaC = 1 / dtn.etaCable;
      etaG = 1 / dtn.etaReduction;
    } else {
      etaC = 1;
      etaG = 1;
    }
    const txFactor = (r * etaC * etaG) / G; // cable force to shaft torque

    const lp = lossPowers(motor, wth);
    const lossTorque = wth === 0 ? 0 : ((lp.friction + lp.iron) / Math.abs(wth)) * Math.sign(wth);

    // Ideal force control: feed forward inertia and losses so the cable carries the target force.
    const fTarget =
      sg.forceTo === undefined
        ? sg.force
        : sg.force + ((sg.forceTo - sg.force) * (tm - idx.starts[segMid]!)) / sg.duration;
    const teReq = jTot * alpha - fTarget * txFactor + lossTorque;
    let iqRef = teReq / kTorque;
    if (Math.abs(iqRef) > ctl.currentLimit) {
      iqRef = Math.sign(iqRef) * ctl.currentLimit;
      flags.currentLimited++;
    }
    const idRef = 0;
    const vMax = vLimitFactor * vTerm;

    let idTh: number;
    let iqTh: number;
    let id1: number;
    let iq1: number;
    let vd: number;
    let vq: number;
    if (full) {
      // PI current loop with decoupling, from the currents at the start of the step.
      const ed = idRef - id;
      const eq = iqRef - iq;
      let vdc = kp * ed + xd + (el.cross ? -we * el.l * iq : 0);
      let vqc = kp * eq + xq + (el.cross ? we * el.l * id : 0) + ke * wth;
      const mag = Math.hypot(vdc, vqc);
      if (mag > vMax) {
        vdc *= vMax / mag;
        vqc *= vMax / mag;
        flags.voltageLimited++;
      } else {
        xd += ki * ed * dt;
        xq += ki * eq * dt;
      }
      vd = vdc;
      vq = vqc;
      // Theta-point currents from the RL plant with cross-coupling: a 2 × 2 linear solve.
      const a = el.l / (theta * dt) + rT;
      const b = we * el.l;
      const rd = vd + (el.l * id) / (theta * dt);
      const rq = vq - ke * wth + (el.l * iq) / (theta * dt);
      const det = a * a + b * b;
      idTh = (a * rd + b * rq) / det;
      iqTh = (a * rq - b * rd) / det;
      id1 = id + (idTh - id) / theta;
      iq1 = iq + (iqTh - iq) / theta;
    } else {
      // Currents follow their references within the step; voltages from the steady equations.
      idTh = idRef;
      iqTh = iqRef;
      vd = rT * idTh - we * el.l * iqTh;
      vq = rT * iqTh + we * el.l * idTh + ke * wth;
      const mag = Math.hypot(vd, vq);
      if (mag > vMax) flags.voltageLimited++;
      id1 = idTh;
      iq1 = iqTh;
    }
    peaks.voltageUse = Math.max(peaks.voltageUse, Math.hypot(vd, vq) / vMax);

    const iMag2 = idTh * idTh + iqTh * iqTh;
    const pIn = el.c * (vd * idTh + vq * iqTh);
    const pCu = el.c * rT * iMag2;
    const te = kTorque * iqTh;
    const eMag = 0.5 * el.c * el.l * (id1 * id1 + iq1 * iq1 - (id * id + iq * iq));

    // Cable force from the torque balance on the shaft: J·α = Te + F·txFactor − Tloss.
    const force = (jTot * alpha - te + lossTorque) / txFactor;
    if (force < 0) flags.slack++;
    const fErr = force - fTarget;
    feMax = Math.max(feMax, Math.abs(fErr));
    feSq += fErr * fErr;
    feN++;

    const pUser = force * vth;
    const pSpool = force * vth * etaC; // power at the spool shaft (into the drivetrain)
    const pShaft = pSpool * etaG; // power at the motor shaft
    const lossCable = pUser - pSpool;
    const lossRed = pSpool - pShaft;

    // Controller and DC bus.
    const iAbs = Math.sqrt(iMag2);
    const pCond = el.c * ctl.rOn * iMag2;
    const pSw =
      motor.commutation === 'foc'
        ? 3 * 0.5 * vTerm * (2 / Math.PI) * iAbs * ctl.tSwitch * ctl.fSwitch
        : 2 * 0.5 * vTerm * iAbs * ctl.tSwitch * ctl.fSwitch;
    const pCtl = ctl.fixed + pCond + pSw;
    const pBus = pIn + pCtl + ctl.aux;

    // Pack: terminal power P = (OCV − R·I)·I, solved for I. Charging is capped by acceptance;
    // the chopper burns the surplus in the braking resistor.
    const ocv = pack.seriesCells * cellOcv(pack, soc);
    const R = pack.rInternal;
    const solveI = (pt: number): number => {
      const disc = ocv * ocv - 4 * R * pt;
      return (ocv - Math.sqrt(Math.max(0, disc))) / (2 * R);
    };
    let iPack = solveI(pBus);
    let pRes = 0;
    const iChgMax = chargeLimit(pack, soc);
    if (iPack < -iChgMax) {
      iPack = -iChgMax;
      const pTerm = (ocv - R * iPack) * iPack;
      pRes = pTerm - pBus;
    }
    const vT = ocv - R * iPack;
    const resMax = (vT * vT) / brake.resistance;
    if (pRes > resMax * (1 + 1e-9)) flags.brakeOverload++;
    peaks.brakeDuty = Math.max(peaks.brakeDuty, pRes / resMax);
    const pRint = R * iPack * iPack;
    if (iPack > 0) packChemOut += ocv * iPack * dt;

    // Thermal: copper into the winding, iron and friction into the housing.
    const g1 = 1 / th.rWindingHousing;
    const g2 = 1 / th.rHousingAmbient;
    const pH = lp.iron + lp.friction;
    const a11 = th.cWinding / (theta * dt) + g1;
    const a22 = th.cHousing / (theta * dt) + g1 + g2;
    const b1 = pCu + (th.cWinding * tw) / (theta * dt);
    const b2 = pH + g2 * th.tAmbient + (th.cHousing * thh) / (theta * dt);
    const detT = a11 * a22 - g1 * g1;
    const twTh = (b1 * a22 + g1 * b2) / detT;
    const thTh = (a11 * b2 + g1 * b1) / detT;
    const tw1 = tw + (twTh - tw) / theta;
    const th1 = thh + (thTh - thh) / theta;
    TL.heatIn += (pCu + pH) * dt;
    TL.rejected += g2 * (thTh - th.tAmbient) * dt;

    // Ledger.
    L.userWork += pUser * dt;
    if (pUser > 0) L.userWorkIn += pUser * dt;
    else L.userWorkOut -= pUser * dt;
    L.magnetic += eMag;
    L.cable += lossCable * dt;
    L.reduction += lossRed * dt;
    L.friction += lp.friction * dt;
    L.iron += lp.iron * dt;
    L.copper += pCu * dt;
    L.controller += pCtl * dt;
    L.aux += ctl.aux * dt;
    L.resistor += pRes * dt;
    L.packResistance += pRint * dt;

    let ph = phases[sg.phase];
    if (!ph) {
      ph = emptyPhase();
      phases[sg.phase] = ph;
    }
    ph.duration += dt;
    ph.userWork += pUser * dt;
    ph.busEnergy += pBus * dt;
    if (pBus < 0) {
      ph.busReturned -= pBus * dt;
      ph.busReturnedPeakW = Math.max(ph.busReturnedPeakW, -pBus);
    }
    if (iPack < 0) ph.packCharged -= vT * iPack * dt;
    ph.resistor += pRes * dt;
    ph.copper += pCu * dt;

    peaks.current = Math.max(peaks.current, iAbs);
    peaks.torque = Math.max(peaks.torque, Math.abs(te));
    peaks.copperW = Math.max(peaks.copperW, pCu);
    peaks.busReturnedW = Math.max(peaks.busReturnedW, -pBus);
    peaks.resistorW = Math.max(peaks.resistorW, pRes);
    peaks.packDischargeA = Math.max(peaks.packDischargeA, iPack);
    peaks.packChargeA = Math.max(peaks.packChargeA, -iPack);
    peaks.minTerminalV = Math.min(peaks.minTerminalV, vT);
    peaks.maxTerminalV = Math.max(peaks.maxTerminalV, vT);
    if (vT < pack.seriesCells * pack.cutoffCell) flags.belowCutoff++;

    if (series && n % recStride === 0) {
      series.t!.push(t0);
      series.x!.push(k0.x);
      series.v!.push(vth);
      series.force!.push(force);
      series.torque!.push(te);
      series.current!.push(iAbs);
      series.copperW!.push(pCu);
      series.busW!.push(pBus);
      series.packA!.push(iPack);
      series.resistorW!.push(pRes);
      series.vTerm!.push(vT);
      series.tWinding!.push(tw);
      series.tHousing!.push(thh);
      series.soc!.push(soc);
    }

    // Advance the states.
    id = id1;
    iq = iq1;
    tw = tw1;
    thh = th1;
    soc -= (iPack * dt) / qAs;
    vTerm = vT;
    peaks.tWinding = Math.max(peaks.tWinding, tw);
    peaks.tHousing = Math.max(peaks.tHousing, thh);
    k0 = k1;
    wEnd = w1;
  }

  L.kinetic = 0.5 * jTot * (wEnd * wEnd - w00 * w00);
  L.packChemical = e0Pack - packEnergy(pack, soc);
  const lhs = L.userWork + L.packChemical;
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
    L.packResistance;
  L.residual = lhs - rhs;
  const gross = L.userWorkIn + packChemOut;
  L.residualRelative = gross > 0 ? Math.abs(L.residual) / gross : 0;

  TL.stored = th.cWinding * (tw - tw0) + th.cHousing * (thh - th0);
  TL.residual = TL.heatIn - TL.stored - TL.rejected;

  for (const ph of Object.values(phases)) {
    // Mean returned power over the time the bus was receiving it is not tracked per step; report
    // the mean over the phase instead.
    ph.busReturnedMeanW = ph.duration > 0 ? ph.busReturned / ph.duration : 0;
  }

  const result: SimResult = {
    ledger: L,
    thermal: TL,
    phases,
    end: { t: steps * dt, soc, tWinding: tw, tHousing: thh },
    peaks,
    flags,
    forceError: { maxAbs: feMax, rms: feN ? Math.sqrt(feSq / feN) : 0 },
    steps,
  };
  if (series) result.series = series;
  return result;
}
