// The CAM geometry stage as an export reaches it (T5.1f; ADR 0014 decision 7; moved from the app in
// M8 plan T8.1b): one setup of the document resolved by regen (sources on the final body,
// expressions evaluated, depths in machine Z), at the current generation so it never cancels a
// regen. The app's kernel scene loader provides one on its regen worker; a headless session wraps
// `RegenEngine.camGeometry`.

import type { ManufaktureDocument } from '@manufakture/core';
import type { CamGeometryResult } from '@manufakture/regen';

export interface CamGeometer {
  /**
   * The geometry of setup `setupId` of `document` as stored (the geometer applies its active
   * configuration row, as a regen does). Null when a newer regen superseded it or the worker
   * stopped; rejects when the document has no such setup.
   */
  geometry(
    document: ManufaktureDocument,
    setupId: string,
    options?: { mesh?: boolean },
  ): Promise<CamGeometryResult | null>;
}
