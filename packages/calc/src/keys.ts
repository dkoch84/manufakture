// Parallel keys: shear across the key and crushing (bearing) on its side, from the torque it
// carries (Shigley 10th ed. Sec. 7-7). The force acts at the shaft's surface; the key's shear
// strength is the distortion-energy value 0.577 S_y.

import { REQUIRED_FACTOR } from './factor';
import { calc, requireRange, value, type Param, type RecordOptions } from './record';
import { shigley10 } from './sources';

/** The smaller of a parallel key's factors in shear and in crushing. */
export function keyFactor(
  p: {
    T: Param;
    d: Param;
    /** Key width (across the shaft) and height. */
    w: Param;
    h: Param;
    /** Engaged length of the key. */
    l: Param;
    /** Yield strength of the key (shear, and crushing on the key). */
    Sy: Param;
    /** Yield strengths of the shaft and the hub; crushing takes the lowest of the three given. */
    SyShaft?: Param;
    SyHub?: Param;
    requiredFactor?: Param;
  },
  options?: RecordOptions,
) {
  return calc(
    {
      id: 'key.factor',
      title: 'Parallel key: factor in shear and crushing',
      method:
        'The torque as a force at the shaft surface; shear over the key width times its length, and bearing over half its height times its length',
      formula:
        'F = 2T / d; n_s = 0.577 S_y w l / F; S_c = min(S_y, S_y,shaft, S_y,hub); n_c = S_c (h/2) l / F; n = min(n_s, n_c)',
      unit: '1',
      sources: [shigley10('Sec. 7-7, keys; distortion energy S_sy = 0.577 S_y, Eq. (5-21)')],
      assumptions: [
        'The force is uniform along the key and acts at the shaft surface',
        'Half the key height bears on the hub (or shaft) side',
        'Shear is across the key, at the key yield strength; crushing is at the lowest yield of the key, shaft and hub given',
      ],
      inputs: {
        T: { name: 'Torque through the key', symbol: 'T', unit: 'N·m' },
        d: { name: 'Shaft diameter', symbol: 'd', unit: 'm' },
        w: { name: 'Key width', symbol: 'w', unit: 'm' },
        h: { name: 'Key height', symbol: 'h', unit: 'm' },
        l: { name: 'Key length', symbol: 'l', unit: 'm' },
        Sy: { name: 'Yield strength of the key', symbol: 'S_y', unit: 'Pa' },
      },
      optional: {
        SyShaft: { name: 'Yield strength of the shaft', symbol: 'S_y,shaft', unit: 'Pa' },
        SyHub: { name: 'Yield strength of the hub', symbol: 'S_y,hub', unit: 'Pa' },
        requiredFactor: REQUIRED_FACTOR,
      },
      limit: { input: 'requiredFactor', kind: 'at-least' },
    },
    p,
    options,
    (v) => {
      requireRange(v.T > 0, 'The torque must be positive');
      requireRange(v.d > 0 && v.w > 0 && v.h > 0 && v.l > 0, 'd, w, h and l must be positive');
      const F = (2 * v.T) / v.d;
      const ns = (0.577 * v.Sy * v.w * v.l) / F;
      const Sc = Math.min(v.Sy, v.SyShaft ?? Infinity, v.SyHub ?? Infinity);
      const nc = (Sc * (v.h / 2) * v.l) / F;
      return {
        result: Math.min(ns, nc),
        derived: [
          value('Force on the key', 'F', F, 'N'),
          value('Yield strength for crushing', 'S_c', Sc, 'Pa'),
          value('Factor in shear', 'n_s', ns, '1'),
          value('Factor in crushing', 'n_c', nc, '1'),
        ],
      };
    },
  );
}
