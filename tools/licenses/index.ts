// Third-party notices and the license check (ADR 0006 decision 5). The builds call `notices()`
// (apps/web/vite.config.ts and apps/server/vite.config.ts write the file into dist/); CI runs
// `pnpm licenses:check` (cli.ts), which reports the same problems.

import { check } from './check.ts';
import { collect, type Collected } from './collect.ts';
import { TARGETS, type TargetName } from './policy.ts';
import { NOTICES_FILE, renderNotices } from './render.ts';

export { NOTICES_FILE };
export type { TargetName };

export interface Notices {
  collected: Collected;
  /** Every reason the target may not ship; the file is still rendered, for reading. */
  problems: string[];
  text: string;
  /** Names of the npm packages in the closure. */
  packages: ReadonlySet<string>;
  /** File names of the font files the notices cover. */
  fontFiles: ReadonlySet<string>;
}

export function targetNamed(name: TargetName) {
  const target = TARGETS.find((t) => t.name === name);
  if (!target) throw new Error(`no license target ${name}`);
  return target;
}

export function notices(repoRoot: string, name: TargetName): Notices {
  const collected = collect(repoRoot, targetNamed(name));
  return {
    collected,
    problems: check(collected),
    text: renderNotices(collected),
    packages: new Set(collected.packages.map((p) => p.name)),
    fontFiles: new Set(
      collected.manual.flatMap((m) => m.entry.files?.map((f) => f.path.split('/').pop()!) ?? []),
    ),
  };
}
