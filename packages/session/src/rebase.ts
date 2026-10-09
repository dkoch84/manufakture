// Replaying a branch's commands onto another state, command by command (for `updateFromMain`).
// This is the library's `rebaseOnto` (T7.1f's merge: an offline `SyncClient` at the fork holds
// the branch's commands as its queue, and the other state arrives as the server's change), but it
// keeps each replayed command, renamed where needed, instead of only the final document: the
// session saves them one revision each, so the branch keeps one revision per batch, its labels,
// and an undo per batch.

import {
  FORMAT_VERSION,
  createdIds,
  type Command,
  type ManufaktureDocument,
  type SyncEntry,
} from '@manufakture/core';
import { constructionDomain } from '@manufakture/domain-construction';
import { woodDomain } from '@manufakture/domain-wood';
import { mergeOverwritten, type LogEntry, type Rebased } from '@manufakture/library';
import { stockDomain } from '@manufakture/stock';
import { SyncClient, domainsValidator, type MergeValidator } from '@manufakture/sync';

/**
 * Reads domain data and extension params as the built-in domains (stock, wood, construction) do,
 * so a merge keeps a field-merged value only when its domain reads it (sync's `./merge`). The
 * library is given it as `mergeValidator` by the hosts that merge.
 */
export const builtInMergeValidator: MergeValidator = domainsValidator([
  stockDomain,
  woodDomain,
  constructionDomain,
]);

export interface Replayed {
  /** The commands that applied, in order, renamed where needed. */
  entries: { cause: LogEntry['cause']; label: string; command: Command }[];
  /** The commands that do not apply on the other state, with why. */
  dropped: { label: string; message: string }[];
  /** Ids the replayed commands made that the other state had taken, and their new ids. */
  renamed: { from: string; to: string }[];
  /** The other state with the kept commands on top. */
  document: ManufaktureDocument;
  /** What the replay overwrote of the other state's own changes since `base` (as a merge says). */
  overwritten: Rebased['overwritten'];
  /** Commands replayed whole where a field merge was possible, and why (as a merge says). */
  mergedWhole: Rebased['mergedWhole'];
}

const CLIENT = 'session-update';
const TARGET = 'session-update-target';

/**
 * `entries` (a branch's commands, made on `base`) replayed onto `onto` (a state that also
 * descends from `base`). Fails when the commands do not apply to `base` itself.
 */
export function replayOnto(
  base: ManufaktureDocument,
  onto: ManufaktureDocument,
  entries: readonly LogEntry[],
  options: { validate?: MergeValidator } = { validate: builtInMergeValidator },
): { ok: true; value: Replayed } | { ok: false; message: string } {
  // Merged by field, as the library's merge does: an edit of a feature or of domain data that the
  // other state changed too keeps that state's edits of the other fields.
  const client = new SyncClient(base, 0, {
    clientId: CLIENT,
    online: false,
    mergeFields: { ...(options.validate && { validate: options.validate }) },
  });
  const whole = new Map<number, { label: string; reasons: string[] }>();
  client.on('mergedWhole', ({ local, label, reasons }) => {
    whole.set(local, { label, reasons });
  });
  const dropped: Replayed['dropped'] = [];
  const renames = new Map<string, string>();
  client.on('dropped', ({ drops }) => {
    for (const d of drops) dropped.push({ label: d.label, message: d.error.message });
  });
  client.on('remapped', ({ table }) => {
    for (const scope of Object.values(table)) {
      for (const [old, now] of Object.entries(scope)) {
        if (now !== null && old !== now) renames.set(old, now);
      }
    }
  });
  const causes = new Map<number, LogEntry['cause']>();
  for (const [i, e] of entries.entries()) {
    const r = client.submit(
      e.command.type === 'replaceDocument'
        ? { restore: { document: e.command.document }, label: e.label, at: e.at }
        : { command: e.command, label: e.label, at: e.at },
    );
    if (!r.ok) {
      return {
        ok: false,
        message: `"${e.label}" (step ${i + 1}) does not apply where the branch starts: ${r.error.message}`,
      };
    }
    causes.set(r.value.local, e.cause);
  }
  const command: Command = { type: 'replaceDocument', document: onto };
  const created = createdIds(base, command);
  if (!created.ok) return { ok: false, message: created.error.message };
  const received = client.receive([
    {
      rev: 1,
      entry: {
        clientId: TARGET,
        clientSeq: 1,
        baseRev: 0,
        format: FORMAT_VERSION,
        cause: 'execute',
        label: TARGET,
        command,
        created: created.value as SyncEntry['created'],
        at: entries.at(-1)?.at ?? '',
      },
    },
  ]);
  if (!received.ok) return { ok: false, message: received.error.message };
  const kept = client.pending.map((p) => ({
    cause: causes.get(p.local) ?? 'execute',
    label: p.label,
    command: p.command,
  }));
  const document = client.document;
  const live = new Set(client.pending.map((p) => p.local));
  return {
    ok: true,
    value: {
      entries: kept,
      dropped,
      renamed: [...renames].map(([from, to]) => ({ from, to })),
      document,
      overwritten: mergeOverwritten(base, onto, document),
      mergedWhole: [...whole].filter(([local]) => live.has(local)).map(([, w]) => w),
    },
  };
}
