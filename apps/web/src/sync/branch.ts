// The branch fallback of ADR 0009 decision 6 (T7.1d): when a rebase drops commands, the work as
// it was before the others' changes arrived is kept as a local branch of the document, through
// the library's branches (T2.5c), so nothing the user made is lost; the notice names the branch.

import type { Command, ManufaktureDocument } from '@manufakture/core';
import type { DroppedCommand } from '@manufakture/sync';
import type { Branch, DocumentLibrary, LogEntry } from '@manufakture/library';

/** The notice's text for dropped commands. */
export function droppedText(drops: readonly DroppedCommand[]): string {
  const names = drops.map((d) => `"${d.label}"`).join(', ');
  return drops.length === 1
    ? `${names} could not be kept after changes from another browser: ${drops[0]!.error.message}`
    : `${drops.length} changes could not be kept after changes from another browser (${names}).`;
}

const stamp = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

/**
 * Keeps `kept` (the work before a rebase dropped part of it) as a new branch of document `id`:
 * a version of the main branch to branch from, the branch, then the kept document saved on it.
 * Returns the branch, or throws with a message to show.
 */
export async function keepAsBranch(
  library: DocumentLibrary,
  id: string,
  kept: ManufaktureDocument,
  now: Date = new Date(),
): Promise<Branch> {
  const at = stamp(now);
  const version = await library.createVersion(id, {
    name: `Before sync changes ${at}`,
    description: 'Named by sync, to branch the work it could not keep from.',
  });
  if (!version.ok) throw new Error(version.message);
  let branch: Branch | null = null;
  for (let n = 1; branch === null; n++) {
    const name = `Kept from sync ${at}${n > 1 ? ` (${n})` : ''}`;
    const made = await library.createBranch(id, version.value.id, name);
    if (made.ok) branch = made.value;
    else if (n >= 5 || !/name/i.test(made.message)) throw new Error(made.message);
  }
  const command: Command = { type: 'replaceDocument', document: kept };
  const entry: LogEntry = {
    cause: 'execute',
    label: 'Work kept from sync',
    command,
    at: now.toISOString(),
  };
  await library.save(kept, [entry], branch.id);
  return branch;
}
