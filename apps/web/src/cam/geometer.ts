// The CAM geometry stage as the app reaches it (T5.1f; ADR 0014 decision 7): one setup of the
// document resolved in the regen worker (sources on the final body, expressions evaluated, depths
// in machine Z), at the client's current generation so it never cancels a regen. The kernel scene
// loader provides one; the kernel-free test scenes have none.

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
