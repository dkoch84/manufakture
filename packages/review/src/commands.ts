// The command diff: every batch of the branch with its label, and each command with a readable
// summary and its JSON. The log is replayed from the base document through core, so each
// summary sees the document right before and after its command (an edit says what it changed).
// A command that no longer applies is still listed, with names looked up in base and head.

import { applyCommand, type Command, type ManufaktureDocument } from '@manufakture/core';
import { Names } from './describe';
import type { DomainSummariser } from './domains';
import { summarise } from './summaries';
import { bounded, jsonText, shown } from './text';
import { LIMITS, type BatchDiff, type Bounded, type CommandSummary } from './types';

/** One entry of the branch's log, with the revision it led to. */
export interface LoggedBatch {
  revision: number;
  cause: string;
  label: string;
  command: Command;
}

function apply(doc: ManufaktureDocument | null, command: Command): ManufaktureDocument | null {
  if (doc === null) return null;
  const r = applyCommand(doc, command);
  return r.ok ? r.value.document : null;
}

export function commandDiff(
  base: ManufaktureDocument,
  head: ManufaktureDocument,
  log: readonly LoggedBatch[],
  summarisers: ReadonlyMap<string, DomainSummariser>,
): { batches: Bounded<BatchDiff>; omittedCommands: number } {
  let doc: ManufaktureDocument | null = base;
  let listed = 0;
  let omittedCommands = 0;
  const batches: BatchDiff[] = [];
  for (const entry of log) {
    const parts = entry.command.type === 'batch' ? entry.command.commands : [entry.command];
    const commands: CommandSummary[] = [];
    for (const command of parts) {
      const before: ManufaktureDocument | null = doc;
      // A batch's parts are applied one by one: the same state the batch reaches as a whole.
      doc = apply(doc, command);
      if (listed >= LIMITS.commands) {
        omittedCommands++;
        continue;
      }
      listed++;
      const json = jsonText(command, LIMITS.commandJson);
      commands.push({
        type: shown(String(command.type), 64),
        summary: summarise(command, {
          before,
          after: doc,
          names: new Names([before ?? undefined, doc ?? undefined, head, base]),
          summarisers,
        }),
        json: json.json,
        truncated: json.truncated,
      });
    }
    batches.push({
      revision: entry.revision,
      cause: shown(entry.cause, 32),
      label: shown(entry.label),
      commands,
    });
  }
  return { batches: bounded(batches, LIMITS.batches), omittedCommands };
}
