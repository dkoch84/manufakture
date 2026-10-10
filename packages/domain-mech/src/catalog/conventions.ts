// One internal convention for motor constants, and the conversions to it with their working (ADR
// 0017 decision 8, T9.0b's spike). Every catalog entry stores Kv, Kt, R and L as the datasheet
// gives them, with the convention named; these pure functions turn them into the one convention
// the simulation and the checks use, and say how, so a calc record can cite the derivation.
//
// Internal:
// - Kt in newton-metres per ampere of phase current amplitude (peak) of sinusoidal three-phase
//   current, motor side, so torque is `Kt * i_q` in amplitude-invariant dq.
// - Kv in rpm per volt of line-to-line amplitude, motor side (stored in SI as rad/s per volt).
// - R and L as the equivalent wye phase-to-neutral values, so copper loss is `1.5 * R * I^2` with
//   I the amplitude.
//
// Conversions (decision 8):
// - Kt per ampere RMS: `Kt = Kt_rms / sqrt(2)`.
// - Kt of a block-commutated motor rated in DC terms: `Kt = k_dc * pi / (2 sqrt(3))`.
// - Kt from Kv when no Kt is given (marked derived): `Kt = (60 / 2 pi)(sqrt(3) / 2) / Kv`, about
//   8.27 / Kv with Kv in rpm/V of line-to-line amplitude.
// - Kv line-to-line RMS: `Kv = Kv_rms / sqrt(2)`; peak-to-peak: `Kv = 2 Kv_pp`; a DC speed
//   constant: `Kv = 3 Kv_dc / pi` (from `k_dc = 1 / Kv_dc` and the six-step factor).
// - R or L line to line (wye or delta): `R = R_ll / 2`; one delta winding's own: `R = R_w / 3`.
// - Output side of a geared actuator: `Kt = Kt_out / ratio`, `Kv = Kv_out * ratio`. Gear
//   efficiency stays its own field.

import type { CatalogEntry, Rated } from '@manufakture/core';
import { OUTPUT_SIDE } from '../parts/families';

/** `(60 / 2 pi)(sqrt(3) / 2)`: Kt in N*m/A of phase amplitude times Kv in rpm/V line-to-line amplitude. */
export const KT_KV_PRODUCT = (60 / (2 * Math.PI)) * (Math.sqrt(3) / 2);

/** `pi / (2 sqrt(3))`: a six-step DC torque constant to the FOC amplitude one. */
export const SIX_STEP_TO_FOC = Math.PI / (2 * Math.sqrt(3));

const RPM_PER_RAD_S = 60 / (2 * Math.PI);

/** What an entry holds for these functions: its family and ratings. */
export type MotorRatings = Pick<CatalogEntry, 'family' | 'ratings'>;

export type Normalised =
  | {
      ok: true;
      /** SI, in the internal convention. */
      value: number;
      /** How it was reached, for a calc record (`Kt 0.0551 N*m/A from Kv 150 rpm/V ...`). */
      derivation: string;
      /** Computed from another field (Kt from Kv), not given. */
      derived?: true;
      /** An input was marked as an estimate. */
      estimated?: true;
    }
  | {
      ok: false;
      /** The fields that are missing or unknown. */
      missing: string[];
      message: string;
    };

function num(v: number): string {
  return String(Number(v.toPrecision(4)));
}

type Given = { value: number; convention?: string; estimated?: true };

function given(rated: Rated | undefined): Given | 'unknown' | undefined {
  if (rated === undefined) return undefined;
  if ('unknown' in rated) return 'unknown';
  if ('text' in rated) return undefined;
  return rated;
}

/** A convention split into its base and whether it is the output side. */
function side(convention: string): { base: string; output: boolean } {
  return convention.endsWith(OUTPUT_SIDE)
    ? { base: convention.slice(0, -OUTPUT_SIDE.length), output: true }
    : { base: convention, output: false };
}

function missing(field: string, why: string): Normalised {
  return { ok: false, missing: [field], message: why };
}

function noConvention(field: string, label: string): Normalised {
  return {
    ok: false,
    missing: [`${field}.convention`],
    message: `${label} has no convention, so it cannot be read`,
  };
}

function unknownConvention(field: string, label: string, convention: string): Normalised {
  return {
    ok: false,
    missing: [`${field}.convention`],
    message: `${label} is entered as "${convention}", which is not a known convention, so it cannot be read`,
  };
}

/** The gear ratio an output-side constant needs, or why not. */
function ratioOf(entry: MotorRatings): number | Normalised {
  const r = given(entry.ratings.ratio);
  if (r === undefined || r === 'unknown') {
    return missing('ratio', 'an output-side constant needs the gear ratio');
  }
  if (!(r.value > 0)) return missing('ratio', 'the gear ratio must be above zero');
  return r.value;
}

/** Refuses an entry of another family, whose ratings mean something else. */
function notMotor(entry: MotorRatings): Normalised | undefined {
  return entry.family === 'motor'
    ? undefined
    : { ok: false, missing: [], message: `a ${entry.family} has no motor constants` };
}

function ok(value: number, derivation: string, estimated: boolean, derived = false): Normalised {
  return {
    ok: true,
    value,
    derivation,
    ...(derived ? { derived: true as const } : {}),
    ...(estimated ? { estimated: true as const } : {}),
  };
}

/**
 * The velocity constant in rad/s per volt of line-to-line amplitude, motor side. Kv has no
 * derivation from Kt here: a Kv is only ever given.
 */
export function motorVelocityConstant(entry: MotorRatings): Normalised {
  const other = notMotor(entry);
  if (other) return other;
  const kv = given(entry.ratings.kv);
  if (kv === undefined || kv === 'unknown') return missing('kv', 'no velocity constant Kv');
  if (kv.convention === undefined) return noConvention('kv', 'Kv');
  const { base, output } = side(kv.convention);
  const rpm = kv.value * RPM_PER_RAD_S;
  let value: number;
  let how: string;
  switch (base) {
    case 'line-to-line amplitude':
      value = kv.value;
      how = 'as entered';
      break;
    case 'line-to-line rms':
      value = kv.value / Math.SQRT2;
      how = 'line-to-line rms / sqrt(2)';
      break;
    case 'line-to-line peak-to-peak':
      value = kv.value * 2;
      how = 'line-to-line peak-to-peak x 2';
      break;
    case 'dc (six-step)':
      value = (kv.value * 3) / Math.PI;
      how = 'six-step DC x 3 / pi';
      break;
    default:
      return unknownConvention('kv', 'Kv', kv.convention);
  }
  if (output) {
    const ratio = ratioOf(entry);
    if (typeof ratio !== 'number') return ratio;
    value *= ratio;
    how += `, output side x ratio ${num(ratio)}`;
  }
  return ok(
    value,
    `Kv ${num(value * RPM_PER_RAD_S)} rpm/V (line-to-line amplitude, motor side) from Kv ${num(rpm)} rpm/V ${kv.convention}, ${how}`,
    kv.estimated === true,
  );
}

/**
 * The torque constant in N*m per ampere of phase amplitude, motor side. Without a Kt (or with an
 * unknown one) it is derived from Kv and marked so.
 */
export function motorTorqueConstant(entry: MotorRatings): Normalised {
  const other = notMotor(entry);
  if (other) return other;
  const kt = given(entry.ratings.kt);
  if (kt === undefined || kt === 'unknown') {
    const kv = motorVelocityConstant(entry);
    if (!kv.ok) {
      return {
        ok: false,
        missing: ['kt', ...kv.missing],
        message: `no torque constant Kt, and none from Kv: ${kv.message}`,
      };
    }
    const value = Math.sqrt(3) / 2 / kv.value;
    return ok(
      value,
      `Kt ${num(value)} N*m/A derived from ${kv.derivation}; ${num(KT_KV_PRODUCT)} / Kv`,
      kv.estimated === true,
      true,
    );
  }
  if (kt.convention === undefined) return noConvention('kt', 'Kt');
  const { base, output } = side(kt.convention);
  let value: number;
  let how: string;
  switch (base) {
    case 'phase amplitude':
      value = kt.value;
      how = 'as entered';
      break;
    case 'phase rms':
      value = kt.value / Math.SQRT2;
      how = 'per ampere rms / sqrt(2)';
      break;
    case 'dc (six-step)':
      value = kt.value * SIX_STEP_TO_FOC;
      how = `six-step DC x pi / (2 sqrt(3)) = x ${num(SIX_STEP_TO_FOC)}`;
      break;
    default:
      return unknownConvention('kt', 'Kt', kt.convention);
  }
  if (output) {
    const ratio = ratioOf(entry);
    if (typeof ratio !== 'number') return ratio;
    value /= ratio;
    how += `, output side / ratio ${num(ratio)}`;
  }
  return ok(
    value,
    `Kt ${num(value)} N*m/A (phase amplitude, motor side) from Kt ${num(kt.value)} N*m/A ${kt.convention}, ${how}`,
    kt.estimated === true,
  );
}

function phaseValue(
  entry: MotorRatings,
  field: 'resistance' | 'inductance',
  symbol: string,
  unit: string,
): Normalised {
  const other = notMotor(entry);
  if (other) return other;
  const v = given(entry.ratings[field]);
  if (v === undefined || v === 'unknown') return missing(field, `no winding ${field} ${symbol}`);
  if (v.convention === undefined) return noConvention(field, symbol);
  let value: number;
  let how: string;
  switch (v.convention) {
    case 'phase-neutral':
      value = v.value;
      how = 'as entered';
      break;
    case 'line-to-line':
      value = v.value / 2;
      how = 'line to line / 2';
      break;
    case 'delta winding':
      value = v.value / 3;
      how = 'one delta winding / 3';
      break;
    default:
      return unknownConvention(field, symbol, v.convention);
  }
  return ok(
    value,
    `${symbol} ${num(value)} ${unit} (equivalent wye, phase to neutral) from ${symbol} ${num(v.value)} ${unit} ${v.convention}, ${how}`,
    v.estimated === true,
  );
}

/** The equivalent wye phase-to-neutral resistance in ohms. */
export function motorResistance(entry: MotorRatings): Normalised {
  return phaseValue(entry, 'resistance', 'R', 'ohm');
}

/** The equivalent wye phase-to-neutral inductance in henries. */
export function motorInductance(entry: MotorRatings): Normalised {
  return phaseValue(entry, 'inductance', 'L', 'H');
}
