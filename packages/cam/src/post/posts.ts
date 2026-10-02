// The built-in posts by id (M5 plan, T5.4c), for the export UI's post choice and the machine
// profiles' `posts` lists (`library/machines.ts`).

import { CARBIDE_MOTION } from './carbide-motion';
import type { CompiledDialect } from './dialect';
import { GRBL } from './grbl';
import { GRBLHAL } from './grblhal';
import { LINUXCNC } from './linuxcnc';
import { MACH3 } from './mach3';

/** Every built-in dialect, compiled, by id: `carbide-motion`, `grbl`, `grblhal`, ... */
export const BUILTIN_DIALECTS: Readonly<Record<string, CompiledDialect>> = Object.freeze(
  Object.fromEntries(
    [CARBIDE_MOTION, GRBL, GRBLHAL, LINUXCNC, MACH3].map((d) => [d.dialect.id, d]),
  ),
);

/** The ids of the built-in posts, for `defaultPost(machine, available)`. */
export const BUILTIN_POST_IDS: ReadonlySet<string> = new Set(Object.keys(BUILTIN_DIALECTS));

/** The built-in dialect `id`, or undefined. */
export function builtinDialect(id: string): CompiledDialect | undefined {
  return Object.hasOwn(BUILTIN_DIALECTS, id) ? BUILTIN_DIALECTS[id] : undefined;
}
