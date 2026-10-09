// The command diff: every batch of the branch with its label, and each command with a readable
// summary and its JSON. The log is replayed from the base document through core, so each
// summary sees the document right before and after its command (an edit says what it changed).
// A command that no longer applies is still listed, with names looked up in base and head.
//
// The same code serves the bundle builder and the app's Review view: the app reads the branch's
// log itself (`branchLog`), replays it here, shows what that gives, and compares it with the
// bundle's list (`commandMismatches`), since an agent with its token can store a bundle whose list
// misdescribes the log (threat model N-1). Core and the domain summarisers only: no Node module, no
// kernel.

import { applyCommand, type Command, type ManufaktureDocument } from '@manufakture/core';
import type { LibraryResult, LogEntry, LoggedRevision } from '@manufakture/library';
import { Names } from './describe';
import { DEFAULT_SUMMARISERS, summariserMap, type DomainSummariser } from './domains';
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

/** A bundle's `commands`: the batches listed, and how many commands past the limit were not. */
export interface CommandList {
  batches: Bounded<BatchDiff>;
  omittedCommands: number;
}

/** What `branchLog` reads: a `DocumentLibrary` has both. */
export interface LogSource {
  readHistory(id: string, branch?: string): Promise<LibraryResult<LoggedRevision[]>>;
  readLog(id: string, branch?: string): Promise<LibraryResult<LogEntry[]>>;
}

/** The branch's log entries with the revision each led to, oldest first. */
export async function branchLog(
  library: LogSource,
  documentId: string,
  branch: string,
): Promise<LoggedBatch[]> {
  const history = await library.readHistory(documentId, branch);
  if (!history.ok) throw new Error(history.message);
  const log = await library.readLog(documentId, branch);
  if (!log.ok) throw new Error(log.message);
  const out: LoggedBatch[] = [];
  let i = 0;
  for (const revision of history.value) {
    for (let k = 0; k < revision.entries.length; k++) {
      const entry = log.value[i++];
      if (entry === undefined) throw new Error('The branch log is incomplete.');
      out.push({
        revision: revision.revision,
        cause: entry.cause,
        label: entry.label,
        command: entry.command,
      });
    }
  }
  return out;
}

/** The command diff of `log` replayed from `base` (`head` for names). */
export function commandDiff(
  base: ManufaktureDocument,
  head: ManufaktureDocument,
  log: readonly LoggedBatch[],
  summarisers: ReadonlyMap<string, DomainSummariser> = summariserMap(DEFAULT_SUMMARISERS),
): CommandList {
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

// Comparing a bundle's list with the log's ----------------------------------------------------

/** The most differences `commandMismatches` lists; the rest are counted. */
export const MAX_COMMAND_MISMATCHES = 100;

const listOf = (x: unknown): readonly unknown[] => (Array.isArray(x) ? x : []);
const objOf = (x: unknown): Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
/** A value from the bundle as a short quote: text bounded, anything else named by its type. */
const quote = (x: unknown): string =>
  typeof x === 'string'
    ? `"${shown(x, 120)}"`
    : typeof x === 'number' && Number.isFinite(x)
      ? String(x)
      : x === undefined
        ? 'nothing'
        : Array.isArray(x)
          ? 'a list'
          : x === null
            ? 'null'
            : `${typeof x === 'object' || typeof x === 'undefined' ? 'an' : 'a'} ${typeof x}`;
const countOf = (x: unknown): number =>
  Number.isSafeInteger(x) && (x as number) > 0 ? (x as number) : 0;

/**
 * Where the bundle's command list (`bundled`, its untrusted `commands`) does not say what the
 * branch's log does (`fromLog`, `commandDiff` of the log): batches by revision, cause and label,
 * and each command by type, summary and JSON. Empty when they agree, as a bundle built by
 * `bundleBuilder` for the same log always does. Never throws: a list of the wrong shape is a
 * difference.
 */
export function commandMismatches(bundled: unknown, fromLog: CommandList): string[] {
  const out: string[] = [];
  const add = (m: string) => {
    out.push(m);
  };
  const commands = objOf(bundled);
  const batches = objOf(commands.batches);
  const theirs = listOf(batches.items).map(objOf);
  const ours = fromLog.batches.items;
  const n = (k: number, one: string, many = `${one}es`) => `${k} ${k === 1 ? one : many}`;
  if (theirs.length !== ours.length) {
    add(`The bundle lists ${n(theirs.length, 'batch')}; the branch log has ${ours.length}.`);
  }
  if (countOf(batches.omitted) !== fromLog.batches.omitted) {
    add(
      `The bundle says it left out ${countOf(batches.omitted)} batches; the log leaves out ${fromLog.batches.omitted}.`,
    );
  }
  if (countOf(commands.omittedCommands) !== fromLog.omittedCommands) {
    add(
      `The bundle says it left out ${countOf(commands.omittedCommands)} commands; the log leaves out ${fromLog.omittedCommands}.`,
    );
  }
  for (let i = 0; i < Math.max(theirs.length, ours.length); i++) {
    const t = theirs[i];
    const o = ours[i];
    if (o === undefined) {
      add(`Batch ${i + 1} ${quote(t!.label)}: in the bundle, not in the branch log.`);
      continue;
    }
    const where = `Batch ${i + 1} (revision ${o.revision})`;
    if (t === undefined) {
      add(
        `${where} "${o.label}": in the branch log (${n(o.commands.length, 'command', 'commands')}), not in the bundle.`,
      );
      continue;
    }
    if (t.revision !== o.revision) {
      add(`${where}: the bundle says revision ${quote(t.revision)}.`);
    }
    if (t.cause !== o.cause) {
      add(`${where}: the bundle says ${quote(t.cause)}, the log "${o.cause}".`);
    }
    if (t.label !== o.label) {
      add(`${where}: the bundle labels it ${quote(t.label)}, the log "${o.label}".`);
    }
    const tc = listOf(t.commands).map(objOf);
    if (tc.length !== o.commands.length) {
      add(
        `${where} "${o.label}": the bundle lists ${n(tc.length, 'command', 'commands')}, the log ${o.commands.length}.`,
      );
    }
    for (let j = 0; j < Math.max(tc.length, o.commands.length); j++) {
      const a = tc[j];
      const b = o.commands[j];
      const at = `${where}, command ${j + 1}`;
      if (b === undefined) add(`${at}: in the bundle (${quote(a!.summary)}), not in the log.`);
      else if (a === undefined) add(`${at}: in the log ("${b.summary}"), not in the bundle.`);
      else if (a.type !== b.type || a.summary !== b.summary) {
        add(`${at}: the bundle says ${quote(a.summary)}, the log "${b.summary}".`);
      } else if (a.json !== b.json || a.truncated !== b.truncated) {
        add(`${at} "${b.summary}": the bundle shows other JSON than the log has.`);
      }
    }
  }
  if (out.length > MAX_COMMAND_MISMATCHES) {
    const more = out.length - MAX_COMMAND_MISMATCHES;
    out.length = MAX_COMMAND_MISMATCHES;
    out.push(`and ${more} more differences`);
  }
  return out;
}
