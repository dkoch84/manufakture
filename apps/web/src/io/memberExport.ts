// Framing members in STL and 3MF export (ADR 0015 decision 4): the members the viewport shows, as
// export bodies, through `@manufakture/io`'s `memberExportBodies` (each member its shared shape
// mesh under its own transform, named by its full id).

import { memberExportBodies, type ExportBody } from '@manufakture/io';
import { memberStore, shownMemberView, type MemberStore } from '../viewport/memberStore';

export { matrix3x4, memberExportBodies } from '@manufakture/io';

/** The members the viewport shows now (the active part's), as export bodies. */
export function shownMemberExports(store: MemberStore = memberStore): ExportBody[] {
  return memberExportBodies(shownMemberView(store.getState()));
}
