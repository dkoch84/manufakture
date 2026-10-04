import { CreatedIdsSchema, RenameTableSchema } from '@manufakture/core';
import { z } from 'zod';
import { PUSH_WINDOW, PushedEntrySchema, RefusalSchema } from './protocol';

/**
 * A client's queue state as plain JSON (ADR 0009 decision 4 and its amendment, item 6): what
 * `SyncClient.save()` returns and `SyncClient.restore()` reads, so a client can be saved at any
 * step and rebuilt exactly. The confirmed document is not in it: the caller saves the state in one
 * step with the document it belongs to (T7.1d).
 *
 * Commands are kept in storage form and read back through `migrateCommand` from `format`, so a
 * queue saved before a format bump replays after it.
 */

/** Bumped when the shape of `SyncQueueState` changes. */
export const SYNC_QUEUE_STATE_VERSION = 1;

const seq = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
const rev = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const local = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
/** A command in storage form; validated by `migrateCommand` on restore. */
const StoredCommandSchema = z.looseObject({ type: z.string() });
const at = z.string().max(64);
const label = z.string().max(1000);
const cause = z.enum(['execute', 'undo', 'redo']);

/**
 * Where an entry is (ADR 0009 decision 4):
 *
 * - `unsent`: waiting to be sent (and renamed if its ids are taken);
 * - `in-flight`: sent, no verdict yet, shown;
 * - `held`: not shown and not sent: an in-flight entry that no longer applies locally, or any
 *   entry after a held, doomed or refused one;
 * - `doomed`: in flight and known to be refused (it chains through `prevSeq` to a refused entry,
 *   or its created ids are below the confirmed counters); renamed in the client's naming, its
 *   sent copy kept unchanged, until its own verdict arrives;
 * - `predecessor-refused`: refused because its predecessor was; returns to `unsent` once the
 *   predecessor is renamed or dropped;
 * - `id-reused`: refused for an id another change took, waiting for the pull up to the head
 *   revision the refusal carried before it returns to `unsent`, renamed.
 */
export const ENTRY_STATES = [
  'unsent',
  'in-flight',
  'held',
  'doomed',
  'predecessor-refused',
  'id-reused',
] as const;
export type EntryState = (typeof ENTRY_STATES)[number];

/** What was sent for an entry: never edited after it is sent. */
export const WireSchema = z.strictObject({
  clientSeq: seq,
  prevSeq: seq.exactOptional(),
  baseRev: rev,
  format: z.int().min(0),
  command: StoredCommandSchema,
  created: CreatedIdsSchema,
  /** Handed to the transport at least once. */
  transmitted: z.boolean(),
  /** To be sent again (after `predecessor-unknown` or a retry). */
  resend: z.boolean(),
});

export const QueueEntrySchema = z.strictObject({
  /** The entry's local id: stable across renames and resubmissions. */
  local,
  state: z.enum(ENTRY_STATES),
  label,
  cause,
  at,
  /** The command in the client's current naming (for a doomed entry, renamed; `wire` is not). */
  command: StoredCommandSchema,
  /** The ids the command creates, in the client's current naming. */
  created: CreatedIdsSchema,
  /**
   * A restore kept as its intent (ADR 0009 amendment, item 11): the version it restores, re-derived
   * as `restoredDocument(head, document, highWater)` at every replay.
   */
  restore: z
    .strictObject({
      document: z.looseObject({}),
      /** The version's id, when it is a named one (T2.5a). */
      version: z.string().max(200).exactOptional(),
    })
    .exactOptional(),
  /** For an undo inverse: the entry it undoes. Removed without a notice if that one is dropped. */
  undoOf: local.exactOptional(),
  wire: WireSchema.exactOptional(),
  /** A refusal waiting for the pull up to `headRev` before it is acted on. */
  verdict: z.strictObject({ ...RefusalSchema.shape, headRev: rev }).exactOptional(),
  predecessorRefused: z.literal(true).exactOptional(),
  /** In flight with created ids below the confirmed counters: certain to be refused. */
  certain: z.literal(true).exactOptional(),
  /** The server acknowledged it at this revision; the push stream will confirm it. */
  acceptedRev: z.int().min(1).exactOptional(),
});

export const UndoRecordSchema = z.strictObject({
  /** The entry this record undoes. */
  local,
  label,
  /** Once the entry is confirmed: its inverse, kept in the client's naming. */
  inverse: StoredCommandSchema.exactOptional(),
  /** Once the entry is confirmed: the objects it changed (`ObjectKey`s). */
  touched: z.array(z.string().max(5000)),
  /** Another client changed one of `touched` since: undo refuses. */
  foreignChanged: z.boolean(),
  confirmed: z.boolean(),
});

export const RedoRecordSchema = z.strictObject({
  /** The entry that was undone. */
  local,
  /** The undo inverse's entry, when the undo was submitted as one. */
  undoLocal: local.exactOptional(),
  label,
  command: StoredCommandSchema,
  restore: QueueEntrySchema.shape.restore,
});

export const SyncQueueStateSchema = z.strictObject({
  version: z.literal(SYNC_QUEUE_STATE_VERSION),
  /** The `FORMAT_VERSION` the commands in this state are written under. */
  format: z.int().min(0),
  clientId: z.string().min(1).max(128),
  /** The revision of the confirmed document saved with this state. */
  confirmedRev: rev,
  /** The next `clientSeq` to hand out. */
  nextSeq: seq,
  /** The client's latest accepted `clientSeq`. */
  latestAccepted: seq.exactOptional(),
  nextLocal: local,
  /** Every pending entry, in queue order. */
  entries: z.array(QueueEntrySchema),
  /** Known refusals, `clientSeq` to error, for sequences in-flight entries still name. */
  refusals: z.array(z.strictObject({ clientSeq: seq, error: RefusalSchema })),
  /**
   * The pending rename table: tombstones of dropped commands not yet applied to the queue (the
   * amendment's one table in the client's naming replaces per-entry tables; this is what is left
   * of it between rebases, usually empty).
   */
  pendingRenames: RenameTableSchema,
  /** The high-water mark of every confirmed document's counters (the floor for restores). */
  highWater: z.record(z.string(), z.record(z.string(), z.int().min(1))),
  /** Pushed entries that arrived ahead of a gap, by revision. */
  buffered: z.array(PushedEntrySchema),
  /** A pull the client wants up to this revision, and the one it asked for. */
  pullWanted: rev.exactOptional(),
  pullRequested: rev.exactOptional(),
  undo: z.array(UndoRecordSchema),
  redo: z.array(RedoRecordSchema),
});

export type SyncQueueState = z.infer<typeof SyncQueueStateSchema>;

/**
 * What the schema cannot see: whether a state's parts agree with each other. Returns the first
 * problem, or `undefined`. `SyncClient.restore` refuses a state with one.
 *
 * An undo inverse's `undoOf` may name an entry no longer in the queue (it landed), but never
 * itself, a later entry or one not handed out yet.
 */
export function checkQueueState(s: SyncQueueState): string | undefined {
  // The client clamps every revision a server names to the window past its confirmed revision.
  const bound = s.confirmedRev + PUSH_WINDOW;
  const locals = new Set<number>();
  const seqs = new Set<number>();
  for (const e of s.entries) {
    if (locals.has(e.local)) return `two entries have local id ${e.local}`;
    locals.add(e.local);
    if (e.local >= s.nextLocal) return `entry ${e.local} is not below nextLocal ${s.nextLocal}`;
    if (e.undoOf !== undefined && e.undoOf >= e.local) {
      return `entry ${e.local} undoes ${e.undoOf}, which is not before it`;
    }
    const w = e.wire;
    if (w === undefined) {
      if (e.state !== 'unsent' && e.state !== 'held') {
        return `entry ${e.local} is ${e.state} but was never sent`;
      }
      if (e.verdict || e.predecessorRefused || e.certain || e.acceptedRev !== undefined) {
        return `entry ${e.local} has a verdict but was never sent`;
      }
      continue;
    }
    if (e.state === 'unsent') return `entry ${e.local} is unsent but has a sequence`;
    if (w.clientSeq >= s.nextSeq) {
      return `entry ${e.local} has clientSeq ${w.clientSeq}, not below nextSeq ${s.nextSeq}`;
    }
    if (seqs.has(w.clientSeq)) return `two entries have clientSeq ${w.clientSeq}`;
    seqs.add(w.clientSeq);
    if (w.prevSeq !== undefined && w.prevSeq >= w.clientSeq) {
      return `entry ${e.local} names prevSeq ${w.prevSeq}, not before its clientSeq`;
    }
    if (w.baseRev > s.confirmedRev) {
      return `entry ${e.local} has baseRev ${w.baseRev}, past confirmedRev ${s.confirmedRev}`;
    }
    if (e.verdict !== undefined && e.verdict.headRev > bound) {
      return `entry ${e.local} waits for revision ${e.verdict.headRev}, past the window`;
    }
  }
  if (s.latestAccepted !== undefined && s.latestAccepted >= s.nextSeq) {
    return `latestAccepted ${s.latestAccepted} is not below nextSeq ${s.nextSeq}`;
  }
  for (const r of s.refusals) {
    if (r.clientSeq >= s.nextSeq) return `a refusal names clientSeq ${r.clientSeq}, not sent yet`;
  }
  for (const [name, value] of [
    ['pullWanted', s.pullWanted],
    ['pullRequested', s.pullRequested],
  ] as const) {
    if (value !== undefined && value > bound) return `${name} ${value} is past the window`;
  }
  const revs = new Set<number>();
  for (const p of s.buffered) {
    if (p.rev <= s.confirmedRev || p.rev > s.confirmedRev + PUSH_WINDOW) {
      return `buffered revision ${p.rev} is outside the window after ${s.confirmedRev}`;
    }
    if (revs.has(p.rev)) return `revision ${p.rev} is buffered twice`;
    revs.add(p.rev);
  }
  for (const u of s.undo) {
    if (u.local >= s.nextLocal) return `an undo record names ${u.local}, not handed out yet`;
  }
  for (const r of s.redo) {
    if (r.local >= s.nextLocal || (r.undoLocal ?? 0) >= s.nextLocal) {
      return 'a redo record names an entry not handed out yet';
    }
  }
  return undefined;
}
