// What the Cut list panel asks of the regen worker (M4 plan T4.3d): the oriented box sizes of a
// part's bodies that are not boards (`RegenClient.orientedSizes`, cached by body key there). The
// kernel scene loader provides one (`SceneLoader.sizer`); kernel-free scenes have none, and the
// list then shows such bodies with their size unknown.

import type { ManufaktureDocument } from '@manufakture/core';
import type { OrientedSizesResult } from '@manufakture/regen';

export interface Sizer {
  /** Resolves to null when a newer regen superseded the request, or there is no worker yet. */
  orientedSizes(
    document: ManufaktureDocument,
    partId: string,
    options: { bodies: readonly string[]; skipExtensions: readonly string[] },
  ): Promise<OrientedSizesResult | null>;
}
