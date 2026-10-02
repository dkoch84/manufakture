// Which viewport faces a setup accepts: faces of its part, and of its body when it names one.

import { describe, expect, it } from 'vitest';
import { geometryRef } from '../state/selection';
import { camFaceReference, outsideScope } from './picking';

const face = (bodyId: string) => geometryRef('face', bodyId, 'extrude#2:cap:end');

describe('camFaceReference', () => {
  const context = {
    bodies: [],
    partBodies: new Set(['part#1/extrude#1', 'part#1/extrude#2', 'part#2/extrude#1']),
    referencer: undefined,
  };

  it('refuses a face of another part, and of another body when the setup names its body', async () => {
    expect(await camFaceReference(face('part#2/extrude#1'), 'part#1', context)).toEqual({
      ok: false,
      message: "Pick a face of the setup's part.",
    });
    expect(
      await camFaceReference(
        face('part#1/extrude#2'),
        { part: 'part#1', body: 'extrude#1' },
        context,
      ),
    ).toEqual({ ok: false, message: "Pick a face of the setup's body." });
  });

  it('takes any body of the part when the setup names none', () => {
    expect(outsideScope(face('part#1/extrude#2'), { part: 'part#1' })).toBeNull();
    expect(
      outsideScope(face('part#1/extrude#2'), { part: 'part#1', body: 'extrude#2' }),
    ).toBeNull();
    // A part id that is a prefix of another's is not that part.
    expect(outsideScope(face('part#10/extrude#1'), 'part#1')).not.toBeNull();
  });
});
