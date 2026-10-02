// What the drawing workspace asks of the regen worker (M4 plan T4.4e): a sheet's views, their
// dimensions and picking data, and its display list. The scene loader makes one on the regen
// client; kernel-free scenes have none, and the workspace says that drawings need the kernel.

import type { ManufaktureDocument } from '@manufakture/core';
import type { DrawingSheetResult } from '@manufakture/regen';

export interface Drawer {
  /**
   * Every view of a sheet and the sheet's display list, for `document` as stored (the drawer
   * applies its active configuration row). With `pick`, each view's picking data too. Null when a
   * newer regen superseded it or the worker stopped.
   */
  sheet(
    document: ManufaktureDocument,
    drawingId: string,
    sheetId: string,
    options?: { pick?: boolean },
  ): Promise<DrawingSheetResult | null>;
}
