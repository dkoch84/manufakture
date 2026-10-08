// The posts an export writes (M5 plan, T5.4e; moved from the app in M8 plan T8.1b), in the export
// dialog's order, and their display names: the built-in dialects' (`post/posts.ts`). The app keeps
// the same list in its eager code (`apps/web/src/cam/commands.ts`), so the workspace does not load
// the CAM package for one set of names; its tests check that the two agree.

import { builtinDialect } from '../post/posts';

/** The post ids this build writes, in the order the export offers them. */
export const POST_IDS: readonly string[] = [
  'grbl',
  'carbide-motion',
  'grblhal',
  'linuxcnc',
  'mach3',
];

/** A post's display name; the id itself for one this build does not know. */
export function postName(id: string): string {
  return builtinDialect(id)?.dialect.name ?? id;
}
