// The limits the geometry stage (`@manufakture/regen`, which does not depend on `@manufakture/cam`)
// and the field checks here repeat from `@manufakture/cam`: pinned equal where both are importable,
// so a change on one side cannot leave the other accepting what the generators refuse.

import {
  DRILL_MAX_PECKS,
  ENTRY_MIN_ANGLE,
  PROFILE_MAX_TABS,
  SURFACE3D_MIN_SAMPLING,
} from '@manufakture/cam';
import {
  CAM_DRILL_MAX_PECKS,
  CAM_MAX_TABS,
  CAM_MIN_ENTRY_ANGLE,
  SURFACE3D_MIN_SAMPLING as REGEN_SURFACE3D_MIN_SAMPLING,
} from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import { ruleProblem } from './values';

describe('CAM limits shared by cam, regen and the forms', () => {
  it('pins the geometry stage to the generators', () => {
    expect(REGEN_SURFACE3D_MIN_SAMPLING).toBe(SURFACE3D_MIN_SAMPLING);
    expect(CAM_MIN_ENTRY_ANGLE).toBe(ENTRY_MIN_ANGLE);
    expect(CAM_MAX_TABS).toBe(PROFILE_MAX_TABS);
    expect(CAM_DRILL_MAX_PECKS).toBe(DRILL_MAX_PECKS);
  });

  it('checks a tab count from 1 to the most tabs a loop may have', () => {
    expect(ruleProblem('whole', 1)).toBeNull();
    expect(ruleProblem('whole', PROFILE_MAX_TABS)).toBeNull();
    for (const bad of [0, 2.5, PROFILE_MAX_TABS + 1, 1e9]) {
      expect(ruleProblem('whole', bad)).toBe(
        `The value must be a whole number from 1 to ${PROFILE_MAX_TABS}.`,
      );
    }
  });

  it('checks an entry angle from half a degree to below 90 degrees as it is typed', () => {
    const deg = (d: number) => (d * Math.PI) / 180;
    expect(ruleProblem('entryAngle', ENTRY_MIN_ANGLE)).toBeNull();
    expect(ruleProblem('entryAngle', deg(3))).toBeNull();
    for (const bad of [0, 1e-8, deg(0.4), deg(90)]) {
      expect(ruleProblem('entryAngle', bad)).toBe(
        'The angle must be at least 0.5 and less than 90 degrees.',
      );
    }
    expect(ruleProblem('sampling', SURFACE3D_MIN_SAMPLING)).toBeNull();
  });
});
