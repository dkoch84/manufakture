// File names for posted G-code (M5 plan, T5.4b). This builds the base name only; the export UI
// passes it through `@manufakture/io`'s `fileName`, which replaces reserved characters, removes
// bidirectional controls and caps the length, so the rules live in one place.

import type { PostFile, PostJob } from './writer';

/** The extension posted G-code files are saved with: Carbide Motion and most senders open `.nc`. */
export const GCODE_FILE_EXTENSION = 'nc';

/** The stem used when the names give nothing to build one from. */
export const FALLBACK_FILE_STEM = 'job';

/**
 * Windows device names, reserved with any extension and in any case (`con.nc`, `Nul.tar.gz`):
 * the part before the first dot, trailing spaces ignored, must not be one of them.
 */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * A posted file's base name, without extension: the job and setup names, and for a job written
 * as several files, `n of m` and the file's first tool, so the operator runs them in order with
 * the right tool: `Sign - Top - 2 of 3 - #302 60 deg V-bit`. `FALLBACK_FILE_STEM` when the names
 * are empty; a Windows device name (`CON`, `LPT1`) gets a leading `_`.
 */
export function postFileStem(
  job: Pick<PostJob, 'job' | 'setup' | 'toolpath'>,
  file: PostFile,
  fileCount: number,
): string {
  const parts = [job.job.trim()];
  const setup = job.setup?.trim();
  if (setup) parts.push(setup);
  if (fileCount > 1) {
    parts.push(`${file.index} of ${fileCount}`);
    const first = file.tools[0];
    const change = job.toolpath.entries.find((e) => e.kind === 'toolChange' && e.tool === first);
    const name = change?.kind === 'toolChange' ? change.name.trim() : '';
    if (name) parts.push(name);
  }
  const stem = parts.filter((p) => p !== '').join(' - ') || FALLBACK_FILE_STEM;
  const head = stem.split('.')[0]!.trimEnd();
  return WINDOWS_RESERVED.test(head) ? `_${stem}` : stem;
}
