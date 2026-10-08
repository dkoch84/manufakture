// The export gate as the library offers it (M8 plan T8.3c, ADR 0016 decision 12): whether a
// fabrication file may be made from a branch, by its record. The rule itself is
// `@manufakture/io`'s `exportAllowed`, since every package with a fabrication entry point depends
// on `@manufakture/io` and this one does too; this is the same function, typed for `Branch`.

import { exportAllowed as gate, type ExportVerdict } from '@manufakture/io';
import type { Branch } from './library';

export {
  ExportRefusedError,
  UNKNOWN_EXPORT_SOURCE,
  UNREVIEWED_EXPORT,
  type ExportSource,
  type ExportVerdict,
} from '@manufakture/io';

/**
 * Whether a fabrication file may be made from `branch` (as `listBranches` lists it): yes for
 * main and a person's branch, and for an agent's branch in review state `approved`; no, with
 * "This is an agent's unreviewed branch. Review it in History first.", for an agent's branch in
 * any other state; no for a missing or malformed record.
 */
export function exportAllowed(branch: Branch | null | undefined): ExportVerdict {
  return gate(branch);
}
