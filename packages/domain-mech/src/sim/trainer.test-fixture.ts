// The T9.0b spike's cable trainer (spikes/T9.0b-sim/src/trainer.ts at ec4af7c), in the
// simulation's own types, for the tests: the direct-drive machine, the 200 lbf rep and session.

import type { ForceLaw } from '../requirements/laws';
import type { RepMotion, ResolvedDynamic, Segment } from '../requirements/motion';
import type { SimMachine } from './machine';

export const LBF = 4.448222;
/** 200 lbf, N. */
export const FORCE_MAX = 200 * LBF;
const C = (degC: number) => degC + 273.15;
export const AMBIENT = C(25);

/** The spike's generic NMC cell OCV at 0, 10, ... 100 % (V). */
const NMC_OCV = [3.0, 3.45, 3.55, 3.61, 3.66, 3.72, 3.8, 3.88, 3.97, 4.07, 4.18];

/** 16S1P 1.7 Ah, 0.42 ohm, 2C charge acceptance tapering from 85 %, cutoff 2.8 V a cell. */
export const SPIKE_PACK: SimMachine['pack'] = {
  ocv: NMC_OCV.map((v, i) => ({ soc: i / (NMC_OCV.length - 1), voltage: 16 * v })),
  capacity: 1.7 * 3600,
  resistance: 16 * 0.025 + 0.02,
  chargeLimit: 2 * 1.7,
  taperStart: 0.85,
  cutoff: 16 * 2.8,
};

/** Direct drive: Kt 0.5 N*m/A amplitude, 0.04 ohm a phase, 25 mm spool, cable path 0.97. */
export const DIRECT: SimMachine = {
  motor: {
    kt: 0.5,
    resistance: 0.04,
    inductance: 100e-6,
    polePairs: 14,
    rotorInertia: 3e-3,
    frictionCoulomb: 0.03,
    frictionViscous: 1e-4,
    ironHysteresis: 0.06,
    ironEddy: 8e-4,
    copperAlpha: 0.00393,
    magnetAlpha: -0.0012,
    reference: C(25),
  },
  motorThermal: {
    windingCapacity: 200,
    windingToHousing: 0.3,
    housingCapacity: 1000,
    housingToAmbient: 1.0,
  },
  transmission: {
    radius: { kind: 'constant', radius: 0.025 },
    ratio: 1,
    efficiency: 1,
    cableEfficiency: 0.97,
    inertia: 3e-3 + 2e-4,
  },
  controller: {
    currentLimit: 60,
    modulation: 0.95,
    loopHz: 1000,
    fixedLoss: 1.5,
    legResistance: 0.004,
    switchingTime: 100e-9,
    switchingFrequency: 20e3,
  },
  pack: SPIKE_PACK,
  brake: { resistance: 2.5 },
  aux: 2.5,
  ambient: AMBIENT,
};

export const CONSTANT_200: ForceLaw = { kind: 'constant', force: FORCE_MAX };

/** The spike's rep: 0.6 m, pull peaking at 1.5 m/s, return over 1.0 s, 0.2 s pauses. */
export const SPIKE_MOTION: RepMotion = {
  kind: 'half-cosine',
  stroke: 0.6,
  pullSpeed: 1.5,
  returnSpeed: (Math.PI * 0.6) / (2 * 1.0),
  pause: 0.2,
};

/** Ten reps; and the "max" session of 5 sets of 10 with 90 s rests. */
export const TEN_REPS: ResolvedDynamic = {
  law: CONSTANT_200,
  motion: SPIKE_MOTION,
  reps: 10,
  sets: 1,
  rest: 0,
};
export const SPIKE_SESSION: ResolvedDynamic = { ...TEN_REPS, sets: 5, rest: 90 };

/** A hold at 0.3 m. */
export const hold = (seconds: number): Segment[] => [
  { phase: 'hold', duration: seconds, from: 0.3, to: 0.3, shape: 'still' },
];

/** The machine with temperature effects off, so closed forms hold exactly. */
export function isothermal(m: SimMachine): SimMachine {
  return { ...m, motor: { ...m.motor, copperAlpha: 0, magnetAlpha: 0 } };
}

/** A machine with no losses anywhere and a flat pack, for closed forms. */
export function ideal(over: Partial<SimMachine> = {}): SimMachine {
  return {
    motor: {
      kt: 0.4,
      resistance: 0,
      inductance: 0,
      polePairs: 0,
      frictionCoulomb: 0,
      frictionViscous: 0,
      ironHysteresis: 0,
      ironEddy: 0,
      copperAlpha: 0,
      magnetAlpha: 0,
      reference: AMBIENT,
    },
    transmission: {
      radius: { kind: 'constant', radius: 0.025 },
      ratio: 1,
      efficiency: 1,
      cableEfficiency: 1,
      inertia: 1e-3,
    },
    controller: {
      modulation: 0.95,
      loopHz: 1000,
      fixedLoss: 0,
      legResistance: 0,
      switchingTime: 0,
      switchingFrequency: 0,
    },
    pack: {
      ocv: [
        { soc: 0, voltage: 50 },
        { soc: 1, voltage: 50 },
      ],
      capacity: 2 * 3600,
      resistance: 0,
      taperStart: 0.85,
    },
    aux: 0,
    ambient: AMBIENT,
    ...over,
  };
}
