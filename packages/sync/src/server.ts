import {
  applyCommand,
  counterRegressions,
  documentCounters,
  maxCounters,
  migrateCommand,
  takenIds,
  type CounterTable,
  type ManufaktureDocument,
  type SyncEntry,
} from '@manufakture/core';
import {
  CURRENT_VERSIONS,
  MAX_ENTRIES_PER_MESSAGE,
  ClientMessageSchema,
  checkVersions,
  describeIssues,
  type ClientMessage,
  type PushedEntry,
  type PushMessage,
  type Refusal,
  type ServerMessage,
  type SubmitMessage,
  type Versions,
} from './protocol';

/** What the server recorded for one `(clientId, clientSeq)`. */
export type Outcome =
  | { readonly kind: 'accepted'; readonly rev: number }
  | { readonly kind: 'refused'; readonly error: Refusal };

/** What `judgeEntry` decided. */
export type Judgement =
  /** Already judged: answer with the recorded outcome, change nothing. */
  | { readonly kind: 'recorded'; readonly outcome: Outcome }
  /** Retryable and not recorded: `prevSeq` has no outcome yet. */
  | { readonly kind: 'predecessor-unknown' }
  /** Refused; record it. */
  | { readonly kind: 'refused'; readonly error: Refusal }
  /** Accepted: the new head and high-water mark, to store with the next revision. */
  | {
      readonly kind: 'accepted';
      readonly document: ManufaktureDocument;
      readonly highWater: CounterTable;
    };

export interface JudgeContext {
  /** The head document. */
  readonly head: ManufaktureDocument;
  /** The `maxCounters` of every accepted head (a deleted part's counters included). */
  readonly highWater: CounterTable;
  /** The recorded outcome of `(clientId, clientSeq)`, if any. */
  outcome(clientId: string, clientSeq: number): Outcome | undefined;
}

/**
 * Judges one entry against a head, in the order of ADR 0009 decision 2 and its amendment (items 2
 * and 3), with no storage of its own so any store can use it (the reference server here, T7.1c's
 * SQLite server):
 *
 * 1. a recorded `(clientId, clientSeq)` gets its recorded outcome, refusals included;
 * 2. a `prevSeq` with no outcome is `predecessor-unknown` (retryable, not recorded);
 * 3. a `prevSeq` that was refused makes this one `predecessor-refused`;
 * 4. the command is migrated from the entry's `format` (a newer format is refused);
 * 5. a created id below the head's counter is `id-reused` (the takeover guard);
 * 6. core's `applyCommand`, whose `CoreError` is the refusal;
 * 7. a head counter below the high-water mark is `counter-regression`.
 */
export function judgeEntry(ctx: JudgeContext, entry: SyncEntry): Judgement {
  const seen = ctx.outcome(entry.clientId, entry.clientSeq);
  if (seen !== undefined) return { kind: 'recorded', outcome: seen };
  if (entry.prevSeq !== undefined) {
    const prev = ctx.outcome(entry.clientId, entry.prevSeq);
    if (prev === undefined) return { kind: 'predecessor-unknown' };
    if (prev.kind === 'refused') {
      return {
        kind: 'refused',
        error: {
          code: 'predecessor-refused',
          message: `The change it was built on (${entry.prevSeq}) was refused`,
        },
      };
    }
  }
  const command = migrateCommand(entry.command, entry.format);
  if (!command.ok) return refusal(command.error);
  const counters = documentCounters(ctx.head);
  const taken = takenIds(counters, entry.created);
  const scope = Object.keys(taken)[0];
  if (scope !== undefined) {
    return {
      kind: 'refused',
      error: {
        code: 'id-reused',
        message: `Id "${taken[scope]![0]}" in ${scope} was already taken by another change`,
      },
    };
  }
  const applied = applyCommand(ctx.head, command.value);
  if (!applied.ok) return refusal(applied.error);
  const after = documentCounters(applied.value.document);
  const back = counterRegressions(maxCounters(ctx.highWater, counters), after);
  if (back.length > 0) {
    const b = back[0]!;
    return {
      kind: 'refused',
      error: {
        code: 'counter-regression',
        message: `Counter ${b.counter} of ${b.scope} would go back from ${b.before} to ${b.after}`,
      },
    };
  }
  return {
    kind: 'accepted',
    document: applied.value.document,
    highWater: maxCounters(ctx.highWater, after),
  };
}

function refusal(error: { code: string; message: string }): Judgement {
  return { kind: 'refused', error: { code: error.code, message: error.message.slice(0, 2000) } };
}

export interface ReferenceServerOptions {
  /** The versions this server runs (default: this build's). For version-skew tests. */
  readonly versions?: Versions;
}

/** Replies to the sender, and accepted entries for every client. */
export interface Handled {
  readonly replies: ServerMessage[];
  /** Entries this message got accepted, to push to every connected client. */
  readonly push?: PushMessage;
}

interface ClientRows {
  readonly outcomes: Map<number, Outcome>;
  /** The highest retention floor the client has sent; never lowered. */
  floor: number;
  latestAccepted?: number;
}

/**
 * The server of ADR 0009 decision 3 in memory: one log for one document branch, ordered by
 * arrival and judged by `judgeEntry`, with the de-duplication table of decision 2 and its
 * retention floor. Used by tests and fuzzing; T7.1c puts the same judgement behind storage and
 * transport.
 */
export class ReferenceServer {
  private doc: ManufaktureDocument;
  private high: CounterTable;
  private readonly entries: PushedEntry[] = [];
  private readonly clients = new Map<string, ClientRows>();
  private readonly versions: Versions;

  constructor(doc: ManufaktureDocument, options: ReferenceServerOptions = {}) {
    this.doc = doc;
    this.high = documentCounters(doc);
    this.versions = options.versions ?? CURRENT_VERSIONS;
  }

  /** The head document. */
  get head(): ManufaktureDocument {
    return this.doc;
  }

  /** The head revision (0 before any entry). */
  get revision(): number {
    return this.entries.length;
  }

  /** The high-water mark of every head's counters. */
  get highWater(): CounterTable {
    return this.high;
  }

  /** The log: every accepted entry in revision order. */
  get log(): readonly PushedEntry[] {
    return this.entries;
  }

  /** How many de-duplication rows the server holds for `clientId` (retention tests). */
  rowCount(clientId: string): number {
    return this.clients.get(clientId)?.outcomes.size ?? 0;
  }

  /** The recorded outcome of `(clientId, clientSeq)`. */
  outcome(clientId: string, clientSeq: number): Outcome | undefined {
    return this.clients.get(clientId)?.outcomes.get(clientSeq);
  }

  /** Handles one message from a client, validating it first. */
  handle(raw: unknown): Handled {
    const parsed = ClientMessageSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        replies: [
          { type: 'error', code: 'invalid-message', message: describeIssues(parsed.error) },
        ],
      };
    }
    return this.handleParsed(parsed.data);
  }

  private handleParsed(message: ClientMessage): Handled {
    switch (message.type) {
      case 'hello': {
        const skew = checkVersions(message, this.versions);
        if (skew !== undefined) return { replies: [skew] };
        return {
          replies: [{ type: 'welcome', ...this.versions, head: this.revision }],
        };
      }
      case 'pull':
        return { replies: [this.pull(message.since)] };
      case 'submit':
        return this.submit(message);
    }
  }

  /** Entries after revision `since`, at most `MAX_ENTRIES_PER_MESSAGE` of them. */
  pull(since: number): PushMessage {
    return { type: 'push', entries: this.entries.slice(since, since + MAX_ENTRIES_PER_MESSAGE) };
  }

  /** Judges a submit's entries in order. */
  submit(message: SubmitMessage): Handled {
    const replies: ServerMessage[] = [];
    const pushed: PushedEntry[] = [];
    for (const entry of message.entries) {
      const rows = this.rows(entry.clientId);
      if (entry.clientSeq < rows.floor && !rows.outcomes.has(entry.clientSeq)) {
        replies.push({
          type: 'error',
          code: 'below-floor',
          clientSeq: entry.clientSeq,
          message: `Entry ${entry.clientSeq} is below the client's retention floor ${rows.floor}`,
        });
        continue;
      }
      const j = judgeEntry(
        { head: this.doc, highWater: this.high, outcome: (c, s) => this.outcome(c, s) },
        entry,
      );
      switch (j.kind) {
        case 'recorded':
          replies.push(this.answer(entry.clientSeq, j.outcome));
          break;
        case 'predecessor-unknown':
          replies.push({ type: 'predecessor-unknown', clientSeq: entry.clientSeq });
          break;
        case 'refused': {
          const outcome: Outcome = { kind: 'refused', error: j.error };
          rows.outcomes.set(entry.clientSeq, outcome);
          replies.push(this.answer(entry.clientSeq, outcome));
          break;
        }
        case 'accepted': {
          this.doc = j.document;
          this.high = j.highWater;
          const p: PushedEntry = { rev: this.entries.length + 1, entry };
          this.entries.push(p);
          pushed.push(p);
          const outcome: Outcome = { kind: 'accepted', rev: p.rev };
          rows.outcomes.set(entry.clientSeq, outcome);
          rows.latestAccepted = Math.max(rows.latestAccepted ?? 0, entry.clientSeq);
          replies.push(this.answer(entry.clientSeq, outcome));
          break;
        }
      }
    }
    const first = message.entries[0]!;
    this.retain(this.rows(first.clientId), message.floor);
    return pushed.length > 0 ? { replies, push: { type: 'push', entries: pushed } } : { replies };
  }

  private answer(clientSeq: number, outcome: Outcome): ServerMessage {
    return outcome.kind === 'accepted'
      ? { type: 'ack', clientSeq, rev: outcome.rev }
      : { type: 'refuse', clientSeq, error: outcome.error, headRev: this.revision };
  }

  private rows(clientId: string): ClientRows {
    let rows = this.clients.get(clientId);
    if (rows === undefined) this.clients.set(clientId, (rows = { outcomes: new Map(), floor: 1 }));
    return rows;
  }

  /** Raises the floor (never lowers it) and forgets rows below it but the latest accepted. */
  private retain(rows: ClientRows, floor: number): void {
    if (floor <= rows.floor) return;
    rows.floor = floor;
    for (const seq of [...rows.outcomes.keys()]) {
      if (seq < floor && seq !== rows.latestAccepted) rows.outcomes.delete(seq);
    }
  }
}
