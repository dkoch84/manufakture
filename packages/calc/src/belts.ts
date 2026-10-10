// Belts: wrap angle, flat and V belt tensions by the capstan (Euler-Eytelwein) relation with
// centrifugal tension, and synchronous (toothed) belt tension and tooth load against the maker's
// ratings.

import { REQUIRED_FACTOR } from './factor';
import { calc, requireRange, value, type Param, type RecordOptions } from './record';
import { gates, shigley10 } from './sources';

/** Wrap angle on the smaller pulley of an open belt drive. */
export function beltWrapAngle(p: { D: Param; d: Param; C: Param }, options?: RecordOptions) {
  return calc(
    {
      id: 'belt.wrap-angle',
      title: 'Belt wrap angle on the small pulley',
      method: 'Open belt geometry',
      formula: 'θ_d = π - 2 asin((D - d) / (2C)); θ_D = π + 2 asin((D - d) / (2C))',
      unit: 'rad',
      sources: [shigley10('Eq. (17-1)')],
      inputs: {
        D: { name: 'Large pulley diameter', symbol: 'D', unit: 'm' },
        d: { name: 'Small pulley diameter', symbol: 'd', unit: 'm' },
        C: { name: 'Centre distance', symbol: 'C', unit: 'm' },
      },
    },
    p,
    options,
    (v) => {
      requireRange(
        v.D >= v.d && v.d > 0 && v.C > (v.D - v.d) / 2,
        'Needs D >= d > 0 and C > (D - d)/2',
      );
      const s = Math.asin((v.D - v.d) / (2 * v.C));
      return {
        result: Math.PI - 2 * s,
        derived: [value('Wrap on the large pulley', 'θ_D', Math.PI + 2 * s, 'rad')],
      };
    },
  );
}

/** Centrifugal tension F_c = m' V². */
export function beltCentrifugalTension(
  p: { massPerLength: Param; V: Param },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'belt.centrifugal-tension',
      title: 'Belt centrifugal tension',
      method: 'Mass per unit length times speed squared',
      formula: "F_c = m' V²",
      unit: 'N',
      sources: [shigley10('Sec. 17-2, centrifugal tension')],
      inputs: {
        massPerLength: { name: 'Belt mass per unit length', symbol: "m'", unit: 'kg/m' },
        V: { name: 'Belt speed', symbol: 'V', unit: 'm/s' },
      },
    },
    p,
    options,
    (v) => ({ result: v.massPerLength * v.V * v.V }),
  );
}

/**
 * Tight-side tension of a flat (or V, with the effective friction) belt at the onset of slip:
 * F₁ = F_c + ΔF e^(fθ) / (e^(fθ) - 1), F₂ = F₁ - ΔF, F_i = (F₁ + F₂)/2 - F_c.
 */
export function flatBeltTensions(
  p: { dF: Param; theta: Param; f: Param; Fc?: Param; allowable?: Param },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'belt.tensions',
      title: 'Belt tensions (tight side)',
      method: 'Capstan relation with centrifugal tension, at full friction development',
      formula: 'F₁ = F_c + ΔF e^(fθ) / (e^(fθ) - 1); F₂ = F₁ - ΔF; F_i = (F₁ + F₂)/2 - F_c',
      unit: 'N',
      sources: [shigley10('Sec. 17-2, flat-belt tension relations')],
      assumptions: ['Friction fully developed on the small pulley (minimum initial tension)'],
      inputs: {
        dF: { name: 'Transmitted tension difference T / r', symbol: 'ΔF', unit: 'N' },
        theta: { name: 'Wrap angle on the small pulley', symbol: 'θ', unit: 'rad' },
        f: { name: 'Friction coefficient (effective, for V belts)', symbol: 'f', unit: '1' },
        Fc: {
          name: 'Centrifugal tension',
          symbol: 'F_c',
          unit: 'N',
          default: { value: 0, note: 'neglected' },
        },
      },
      optional: { allowable: { name: 'Allowable belt tension', symbol: 'F_a', unit: 'N' } },
      limit: { input: 'allowable', kind: 'at-most' },
    },
    p,
    options,
    (v) => {
      requireRange(v.f > 0 && v.theta > 0, 'f and θ must be positive');
      const e = Math.exp(v.f * v.theta);
      const F1 = v.Fc + (v.dF * e) / (e - 1);
      const F2 = F1 - v.dF;
      return {
        result: F1,
        derived: [
          value('Slack-side tension', 'F₂', F2, 'N'),
          value('Initial tension', 'F_i', (F1 + F2) / 2 - v.Fc, 'N'),
          value('Friction exponential', 'e^(fθ)', e, '1'),
        ],
      };
    },
  );
}

/** Synchronous belt: effective tension from torque against the maker's allowable working tension. */
export function synchronousBeltTensionFactor(
  p: { T: Param; dp: Param; allowable: Param; requiredFactor?: Param },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'belt.synchronous-tension',
      title: 'Synchronous belt: factor on working tension',
      method: "Effective tension from the torque on the pitch diameter, against the maker's rating",
      formula: 'T_e = 2T / d_p; n = T_allow / T_e',
      unit: '1',
      sources: [gates('effective tension and belt width selection')],
      assumptions: ['Allowable tension is the catalog working tension for the chosen width'],
      inputs: {
        T: { name: 'Torque on the pulley', symbol: 'T', unit: 'N·m' },
        dp: { name: 'Pulley pitch diameter', symbol: 'd_p', unit: 'm' },
        allowable: { name: 'Allowable working tension', symbol: 'T_allow', unit: 'N' },
      },
      optional: { requiredFactor: REQUIRED_FACTOR },
      limit: { input: 'requiredFactor', kind: 'at-least' },
    },
    p,
    options,
    (v) => {
      requireRange(v.T > 0 && v.dp > 0, 'T and d_p must be positive');
      const Te = (2 * v.T) / v.dp;
      return { result: v.allowable / Te, derived: [value('Effective tension', 'T_e', Te, 'N')] };
    },
  );
}

/** Synchronous belt: load per tooth in mesh against the maker's tooth rating (tooth shear). */
export function synchronousBeltToothFactor(
  p: {
    T: Param;
    dp: Param;
    teeth: Param;
    theta: Param;
    toothRating: Param;
    requiredFactor?: Param;
  },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'belt.synchronous-teeth',
      title: 'Synchronous belt: factor on tooth load',
      method:
        "Effective tension shared by the whole teeth in mesh, against the maker's tooth rating",
      formula: 'TIM = floor(z θ / 2π); F_tooth = (2T / d_p) / TIM; n = F_rated / F_tooth',
      unit: '1',
      sources: [gates('teeth in mesh and tooth shear')],
      assumptions: [
        'Only whole teeth in mesh carry load, equally',
        'Makers commonly derate drives with fewer than 6 teeth in mesh',
      ],
      inputs: {
        T: { name: 'Torque on the pulley', symbol: 'T', unit: 'N·m' },
        dp: { name: 'Pulley pitch diameter', symbol: 'd_p', unit: 'm' },
        teeth: { name: 'Pulley teeth', symbol: 'z', unit: '1' },
        theta: { name: 'Wrap angle', symbol: 'θ', unit: 'rad' },
        toothRating: { name: 'Allowable load per tooth', symbol: 'F_rated', unit: 'N' },
      },
      optional: { requiredFactor: REQUIRED_FACTOR },
      limit: { input: 'requiredFactor', kind: 'at-least' },
    },
    p,
    options,
    (v) => {
      requireRange(v.T > 0 && v.dp > 0, 'T and d_p must be positive');
      const tim = Math.floor((v.teeth * v.theta) / (2 * Math.PI) + 1e-9);
      requireRange(tim >= 1, 'No whole tooth is in mesh');
      const perTooth = (2 * v.T) / v.dp / tim;
      return {
        result: v.toothRating / perTooth,
        derived: [
          value('Teeth in mesh', 'TIM', tim, '1'),
          value('Load per tooth', 'F_tooth', perTooth, 'N'),
        ],
      };
    },
  );
}
