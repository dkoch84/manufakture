// Branches for the export gate's tests (T8.3c): an agent's branch in a review state, and the
// states in which nothing may be exported from one.

import type { ExportSource } from '@manufakture/io';

/** The review states the gate refuses. */
export const REFUSED_REVIEWS = ['open', 'submitted', 'changes-requested', 'rejected'] as const;

/** An agent's branch in review state `review`, as the library lists it. */
export const agentSource = (review: string): ExportSource => ({
  id: 'branch-1',
  provenance: { origin: 'agent', review },
});
