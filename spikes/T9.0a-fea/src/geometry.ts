// The benchmark solids, built by manufakture's kernel (libcascade through packages/kernel) and
// handed to the mesher as STEP bytes, the way a body leaves the kernel worker for an FEA worker.
// Node only (it loads the kernel from disk); the browser run reads the STEP files this writes.

import { createNodeKernel } from '../../../packages/kernel/src/node.ts';
import { CANTILEVER, CYLINDER, PLATE } from './cases.ts';

export type SolidId = 'cantilever' | 'plate-hole' | 'lame' | 'bracket';

/** STEP bytes for each benchmark solid, plus the scaling solid (`bracket`). */
export async function buildSolids(): Promise<Record<SolidId, Uint8Array>> {
  const k = await createNodeKernel();
  const step = (shape: Parameters<typeof k.exportStep>[0][0]['shape'], name: string) =>
    k.exportStep([{ shape, name }]);

  const beam = k.box(CANTILEVER.L, CANTILEVER.b, CANTILEVER.h);

  const { halfLength, halfWidth, halfThickness, r } = PLATE;
  const plate = k.boolean('cut', k.box(halfLength, halfWidth, halfThickness), [
    k.cylinder(r, 3 * halfThickness, [0, 0, -halfThickness]),
  ]).shape;

  const { ri, ro, length } = CYLINDER;
  const tube = k.boolean('cut', k.cylinder(ro, length), [
    k.cylinder(ri, length + 2, [0, 0, -1]),
  ]).shape;
  const quarter = k.boolean('common', tube, [k.box(ro + 5, ro + 5, length)]).shape;

  // The scaling solid: a 160 x 40 x 20 bar with two through holes and a slot, clamped at one end.
  const bar = k.box(160, 40, 20);
  const bracket = k.boolean('cut', bar, [
    k.cylinder(8, 40, [60, 20, -10]),
    k.cylinder(8, 40, [110, 20, -10]),
    k.box(20, 10, 40, [130, 15, -10]),
  ]).shape;

  return {
    cantilever: step(beam, 'cantilever'),
    'plate-hole': step(plate, 'plate-hole'),
    lame: step(quarter, 'lame'),
    bracket: step(bracket, 'bracket'),
  };
}
