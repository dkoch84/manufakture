// Bolted joints, simplified after VDI 2230 and Shigley chapter 8: preload from torque, bolt and
// clamped-member stiffness, the joint constant, and factors against separation, slip, proof load
// and overload. Concentric axial load introduced at the interface (load factor n = 1).

import { REQUIRED_FACTOR } from './factor';
import {
  calc,
  requireRange,
  value,
  type InputSpec,
  type Param,
  type RecordOptions,
} from './record';
import { iso898, shigley10, vdi2230 } from './sources';

const KB = { name: 'Bolt stiffness', symbol: 'k_b', unit: 'N/m' } as const;
const KM = { name: 'Clamped-member stiffness', symbol: 'k_m', unit: 'N/m' } as const;
const FI = { name: 'Preload', symbol: 'F_i', unit: 'N' } as const;
const P_EXT = { name: 'External axial load per bolt', symbol: 'P', unit: 'N' } as const;

/** Tensile stress area of an ISO metric thread: A_t = π/4 (d - 0.9382 P)². */
export function tensileStressArea(p: { d: Param; P: Param }, options?: RecordOptions) {
  return calc(
    {
      id: 'bolt.stress-area',
      title: 'Thread tensile stress area',
      method: 'Mean of pitch and minor diameter of the ISO basic profile',
      formula: 'A_t = (π/4) (d - 0.9382 P)²',
      unit: 'm^2',
      sources: [iso898('stress area A_s,nom'), shigley10('Table 8-1')],
      inputs: {
        d: { name: 'Nominal diameter', symbol: 'd', unit: 'm' },
        P: { name: 'Pitch', symbol: 'P', unit: 'm' },
      },
    },
    p,
    options,
    (v) => {
      requireRange(v.d > 0.9382 * v.P && v.P > 0, 'Needs d > 0.9382 P > 0');
      return { result: (Math.PI / 4) * (v.d - 0.9382 * v.P) ** 2 };
    },
  );
}

/** Preload from tightening torque with thread and under-head friction (VDI 2230). */
export function preloadFromTorque(
  p: { T: Param; d: Param; P: Param; muG: Param; muK: Param; DKm: Param; d2?: Param },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'bolt.preload-vdi',
      title: 'Bolt preload from tightening torque',
      method: 'VDI 2230 tightening-torque relation, 60° ISO thread',
      formula: 'F_M = T / (0.16 P + 0.58 d₂ μ_G + (D_Km / 2) μ_K)',
      unit: 'N',
      sources: [vdi2230('calculation step R13, tightening torque')],
      assumptions: [
        '60° thread; torque fully converted to preload, thread and head friction',
        'Scatter of the tightening method not included: the result is the nominal preload',
      ],
      inputs: {
        T: { name: 'Tightening torque', symbol: 'T', unit: 'N·m' },
        d: { name: 'Nominal diameter', symbol: 'd', unit: 'm' },
        P: { name: 'Pitch', symbol: 'P', unit: 'm' },
        muG: { name: 'Thread friction coefficient', symbol: 'μ_G', unit: '1' },
        muK: { name: 'Under-head friction coefficient', symbol: 'μ_K', unit: '1' },
        DKm: { name: 'Mean bearing diameter under the head', symbol: 'D_Km', unit: 'm' },
      },
      optional: { d2: { name: 'Pitch diameter', symbol: 'd₂', unit: 'm' } },
    },
    p,
    options,
    (v) => {
      const d2 = v.d2 ?? v.d - 0.649519 * v.P;
      const lever = 0.16 * v.P + 0.58 * d2 * v.muG + (v.DKm / 2) * v.muK;
      requireRange(lever > 0, 'The torque lever must be positive');
      return {
        result: v.T / lever,
        derived: [
          value('Pitch diameter', 'd₂', d2, 'm'),
          value('Torque per unit preload', 'T/F_M', lever, 'm'),
        ],
        assumptions: v.d2 === undefined ? ['Basic pitch diameter d₂ = d - 0.649519 P'] : [],
      };
    },
  );
}

/** Preload from torque with a nut factor: F_i = T / (K d). */
export function preloadFromTorqueNutFactor(
  p: { T: Param; d: Param; K?: Param },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'bolt.preload-nut-factor',
      title: 'Bolt preload from torque (nut factor)',
      method: 'Short-form torque relation with an empirical nut factor',
      formula: 'F_i = T / (K d)',
      unit: 'N',
      sources: [shigley10('Eq. (8-27) and Table 8-15')],
      inputs: {
        T: { name: 'Tightening torque', symbol: 'T', unit: 'N·m' },
        d: { name: 'Nominal diameter', symbol: 'd', unit: 'm' },
        K: {
          name: 'Nut factor',
          symbol: 'K',
          unit: '1',
          default: { value: 0.2, note: 'unspecified finish' },
        },
      },
    },
    p,
    options,
    (v) => ({ result: v.T / (v.K * v.d) }),
  );
}

/** Bolt stiffness from the unthreaded and threaded lengths within the grip. */
export function boltStiffness(
  p: { Ad: Param; At: Param; ld: Param; lt: Param; E: Param },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'bolt.stiffness',
      title: 'Bolt stiffness',
      method: 'Shank and threaded length in the grip as springs in series',
      formula: 'k_b = A_d A_t E / (A_d l_t + A_t l_d)',
      unit: 'N/m',
      sources: [shigley10('Eq. (8-17)')],
      assumptions: ['Head and nut deformation not included'],
      inputs: {
        Ad: { name: 'Major-diameter area', symbol: 'A_d', unit: 'm^2' },
        At: { name: 'Tensile stress area', symbol: 'A_t', unit: 'm^2' },
        ld: { name: 'Unthreaded length in the grip', symbol: 'l_d', unit: 'm' },
        lt: { name: 'Threaded length in the grip', symbol: 'l_t', unit: 'm' },
        E: { name: "Bolt Young's modulus", symbol: 'E', unit: 'Pa' },
      },
    },
    p,
    options,
    (v) => {
      const den = v.Ad * v.lt + v.At * v.ld;
      requireRange(den > 0, 'The grip must have a length');
      return { result: (v.Ad * v.At * v.E) / den };
    },
  );
}

/** Stiffness of one conical frustum of clamped material (30° half-angle). */
export function frustumStiffness(
  p: { E: Param; d: Param; D: Param; t: Param },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'bolt.frustum-stiffness',
      title: 'Clamped-member frustum stiffness',
      method: 'Pressure cone of 30° half-angle',
      formula: 'k = 0.5774 π E d / ln[(1.155 t + D - d)(D + d) / ((1.155 t + D + d)(D - d))]',
      unit: 'N/m',
      sources: [shigley10('Eq. (8-20)')],
      assumptions: ['30° cone half-angle; D is the cone diameter where the frustum starts'],
      inputs: {
        E: { name: "Member Young's modulus", symbol: 'E', unit: 'Pa' },
        d: { name: 'Bolt diameter', symbol: 'd', unit: 'm' },
        D: { name: 'Bearing-face diameter at the frustum start', symbol: 'D', unit: 'm' },
        t: { name: 'Frustum thickness', symbol: 't', unit: 'm' },
      },
    },
    p,
    options,
    (v) => {
      requireRange(v.D > v.d && v.d > 0 && v.t > 0, 'Needs D > d > 0 and t > 0');
      const ln = Math.log(
        ((1.155 * v.t + v.D - v.d) * (v.D + v.d)) / ((1.155 * v.t + v.D + v.d) * (v.D - v.d)),
      );
      return { result: (0.5774 * Math.PI * v.E * v.d) / ln };
    },
  );
}

/** Member stiffness for two equal frusta of one material over grip l, washer face 1.5 d. */
export function memberStiffness(p: { E: Param; d: Param; l: Param }, options?: RecordOptions) {
  return calc(
    {
      id: 'bolt.member-stiffness',
      title: 'Clamped-member stiffness (one material)',
      method: 'Two 30° frusta meeting at mid-grip, bearing face 1.5 d',
      formula: 'k_m = 0.5774 π E d / (2 ln[5 (0.5774 l + 0.5 d) / (0.5774 l + 2.5 d)])',
      unit: 'N/m',
      sources: [shigley10('Eq. (8-22)')],
      assumptions: ['All members of one material; washer-face diameter 1.5 d'],
      inputs: {
        E: { name: "Member Young's modulus", symbol: 'E', unit: 'Pa' },
        d: { name: 'Bolt diameter', symbol: 'd', unit: 'm' },
        l: { name: 'Grip length', symbol: 'l', unit: 'm' },
      },
    },
    p,
    options,
    (v) => {
      requireRange(v.d > 0 && v.l > 0, 'd and l must be positive');
      const ln = Math.log((5 * (0.5774 * v.l + 0.5 * v.d)) / (0.5774 * v.l + 2.5 * v.d));
      return { result: (0.5774 * Math.PI * v.E * v.d) / (2 * ln) };
    },
  );
}

/** Stiffnesses in series (frusta of a multi-material joint): 1/k = Σ 1/kᵢ. */
export function seriesStiffness(parts: Param[], options?: RecordOptions) {
  const inputs: Record<string, InputSpec> = {};
  const params: Record<string, Param> = {};
  parts.forEach((part, i) => {
    inputs[`k${i + 1}`] = { name: `Stiffness ${i + 1}`, symbol: `k${i + 1}`, unit: 'N/m' };
    params[`k${i + 1}`] = part;
  });
  return calc<string>(
    {
      id: 'bolt.series-stiffness',
      title: 'Clamped-member stiffness (springs in series)',
      method: 'Springs in series',
      formula: '1/k_m = Σ 1/kᵢ',
      unit: 'N/m',
      sources: [shigley10('Eq. (8-18)')],
      inputs,
    },
    params,
    options,
    (v) => {
      requireRange(parts.length > 0, 'At least one stiffness is needed');
      let sum = 0;
      for (let i = 1; i <= parts.length; i++) {
        const k = v[`k${i}`] as number;
        requireRange(k > 0, 'Every stiffness must be positive');
        sum += 1 / k;
      }
      return { result: 1 / sum };
    },
  );
}

function jointConstant(kb: number, km: number): number {
  requireRange(kb > 0 && km > 0, 'Stiffnesses must be positive');
  return kb / (kb + km);
}

/** Factor against joint separation: n0 = F_i / (P (1 - C)). */
export function separationFactor(
  p: { Fi: Param; P: Param; kb: Param; km: Param; requiredFactor?: Param },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'bolt.separation-factor',
      title: 'Bolted joint: factor against separation',
      method: 'Preload over the share of the external load that unloads the members',
      formula: 'n₀ = F_i / (P (1 - C)), C = k_b / (k_b + k_m)',
      unit: '1',
      sources: [shigley10('Eq. (8-30)'), vdi2230('residual clamp load, load factor Φ')],
      assumptions: ['External load introduced at the interface (load introduction factor n = 1)'],
      inputs: { Fi: FI, P: P_EXT, kb: KB, km: KM },
      optional: { requiredFactor: REQUIRED_FACTOR },
      limit: { input: 'requiredFactor', kind: 'at-least' },
    },
    p,
    options,
    (v) => {
      const C = jointConstant(v.kb, v.km);
      requireRange(v.P > 0, 'The external load must be positive');
      return {
        result: v.Fi / (v.P * (1 - C)),
        derived: [value('Joint constant', 'C', C, '1')],
      };
    },
  );
}

/** Factor against slip of a friction-grip joint under a transverse load. */
export function slipFactor(
  p: {
    Fi: Param;
    Fq: Param;
    mu: Param;
    interfaces?: Param;
    P?: Param;
    kb?: Param;
    km?: Param;
    requiredFactor?: Param;
  },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'bolt.slip-factor',
      title: 'Bolted joint: factor against slip',
      method: 'Friction from the residual clamp load against the transverse load per bolt',
      formula: 'n_s = μ q (F_i - (1 - C) P) / F_Q',
      unit: '1',
      sources: [vdi2230('calculation step R12, slipping'), shigley10('Sec. 8-9')],
      assumptions: ['Friction carries the whole transverse load; no bearing on the bolt shank'],
      inputs: {
        Fi: FI,
        Fq: { name: 'Transverse load per bolt', symbol: 'F_Q', unit: 'N' },
        mu: { name: 'Interface friction coefficient', symbol: 'μ', unit: '1' },
        interfaces: {
          name: 'Friction interfaces',
          symbol: 'q',
          unit: '1',
          default: { value: 1, note: 'one interface' },
        },
        P: { ...P_EXT, default: { value: 0, note: 'no external axial load' } },
      },
      optional: { kb: KB, km: KM, requiredFactor: REQUIRED_FACTOR },
      limit: { input: 'requiredFactor', kind: 'at-least' },
    },
    p,
    options,
    (v) => {
      requireRange(v.Fq > 0, 'The transverse load must be positive');
      let C = 0;
      if (v.P !== 0) {
        requireRange(v.kb !== undefined && v.km !== undefined, 'An axial load needs k_b and k_m');
        C = jointConstant(v.kb as number, v.km as number);
      }
      const clamp = v.Fi - (1 - C) * v.P;
      return {
        result: (v.mu * v.interfaces * Math.max(clamp, 0)) / v.Fq,
        derived: [
          value('Residual clamp load', 'F_KR', clamp, 'N'),
          value('Joint constant', 'C', C, '1'),
        ],
      };
    },
  );
}

/** Factor of the bolt's proof strength against its peak load: n_p = S_p A_t / (C P + F_i). */
export function boltProofFactor(
  p: { Sp: Param; At: Param; Fi: Param; P: Param; kb: Param; km: Param; requiredFactor?: Param },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'bolt.proof-factor',
      title: 'Bolt: factor against proof load',
      method: 'Proof load over preload plus the bolt share of the external load',
      formula: 'n_p = S_p A_t / (C P + F_i)',
      unit: '1',
      sources: [shigley10('Eq. (8-28)')],
      inputs: {
        Sp: { name: 'Proof strength', symbol: 'S_p', unit: 'Pa' },
        At: { name: 'Tensile stress area', symbol: 'A_t', unit: 'm^2' },
        Fi: FI,
        P: P_EXT,
        kb: KB,
        km: KM,
      },
      optional: { requiredFactor: REQUIRED_FACTOR },
      limit: { input: 'requiredFactor', kind: 'at-least' },
    },
    p,
    options,
    (v) => {
      const C = jointConstant(v.kb, v.km);
      return {
        result: (v.Sp * v.At) / (C * v.P + v.Fi),
        derived: [value('Joint constant', 'C', C, '1')],
      };
    },
  );
}

/** Load factor against overload: n_L = (S_p A_t - F_i) / (C P). */
export function boltOverloadFactor(
  p: { Sp: Param; At: Param; Fi: Param; P: Param; kb: Param; km: Param; requiredFactor?: Param },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'bolt.overload-factor',
      title: 'Bolt: load factor against overload',
      method: 'Margin between proof load and preload over the bolt share of the external load',
      formula: 'n_L = (S_p A_t - F_i) / (C P)',
      unit: '1',
      sources: [shigley10('Eq. (8-29)')],
      inputs: {
        Sp: { name: 'Proof strength', symbol: 'S_p', unit: 'Pa' },
        At: { name: 'Tensile stress area', symbol: 'A_t', unit: 'm^2' },
        Fi: FI,
        P: P_EXT,
        kb: KB,
        km: KM,
      },
      optional: { requiredFactor: REQUIRED_FACTOR },
      limit: { input: 'requiredFactor', kind: 'at-least' },
    },
    p,
    options,
    (v) => {
      const C = jointConstant(v.kb, v.km);
      requireRange(v.P > 0, 'The external load must be positive');
      return {
        result: (v.Sp * v.At - v.Fi) / (C * v.P),
        derived: [value('Joint constant', 'C', C, '1')],
      };
    },
  );
}
