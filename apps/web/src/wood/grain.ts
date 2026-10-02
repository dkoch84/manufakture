// Whether boards show their grain arrows in the viewport (M4 plan T4.1d: grain shown as an
// optional arrow on board bodies). A view preference for the session, like hiding a body: it is
// not part of the document.

import { createStore } from 'zustand/vanilla';
import type { Vec3 } from '@manufakture/kernel';
import { readBoardMetadata } from '@manufakture/domain-wood';
import type { PartModel } from '../model/model';
import { grainArrows } from './boards';

export const grainStore = createStore<{ show: boolean; setShow(show: boolean): void }>()((set) => ({
  show: true,
  setShow: (show) => set({ show }),
}));

/**
 * The grain arrows of every board a part's last regen built whose stock has a grain, for the
 * bodies in `shown` (regen body ids: a board's body is named after its feature).
 */
export function boardGrainLines(
  part: Pick<PartModel, 'features'> | undefined,
  shown: ReadonlySet<string>,
): Vec3[][] {
  if (part === undefined) return [];
  return part.features.flatMap((f) => {
    if (f.status !== 'ok' || f.kind !== 'extension' || !shown.has(f.featureId)) return [];
    const board = readBoardMetadata(f.metadata);
    return board && board.grain ? grainArrows(board.frame) : [];
  });
}
