// The in-memory server: one log per document, ordered by arrival, validated by core's
// applyCommand, with the de-duplication table and predecessor rules of ADR 0009 decision 2.

import { applyCommand, checkDocument, type ManufaktureDocument } from '@manufakture/core';
import type { Broadcast, SyncEntry, Verdict } from './protocol.ts';
import { counterKey, counters, regressions } from './scopes.ts';

export interface ServerOptions {
  /**
   * Refuse a command whose result moves any counter backwards, as `id-reused`. Core's
   * `replaceDocument` does not check this, so without the guard a stale replacement lowers the
   * counters on the server and an id is later handed out twice.
   */
  guardCounters: boolean;
  /**
   * Refuse, as `id-reused`, an entry whose `created` ids are below the head's counters. Without
   * it a whole-feature edit can take over an id another client's edit just allocated.
   */
  guardCreated: boolean;
}

type Outcome =
  { kind: 'accepted'; rev: number } | { kind: 'refused'; code: string; message: string };

export class Server {
  doc: ManufaktureDocument;
  rev = 0;
  readonly log: Broadcast[] = [];
  /** Problems found by the invariant checks on every new head (should stay empty). */
  readonly violations: string[] = [];
  readonly refusals = new Map<string, number>();
  /** Entries refused by the created-ids guard. */
  createdCaught = 0;
  /** Of those, entries core would have accepted (an edit taking over another client's id). */
  takeovers = 0;
  private readonly outcomes = new Map<string, Outcome>();
  private readonly highWater = new Map<string, number>();
  private readonly options: ServerOptions;

  constructor(doc: ManufaktureDocument, options: ServerOptions) {
    this.doc = doc;
    this.options = options;
    for (const [k, n] of counters(doc)) this.highWater.set(k, n);
  }

  submit(entry: SyncEntry): { verdict: Verdict; broadcast?: Broadcast } {
    const key = `${entry.clientId}:${entry.clientSeq}`;
    const seen = this.outcomes.get(key);
    if (seen) return { verdict: this.verdict(entry, seen) };
    if (entry.prevSeq !== undefined) {
      const prev = this.outcomes.get(`${entry.clientId}:${entry.prevSeq}`);
      if (!prev) {
        this.count('predecessor-unknown');
        return { verdict: { kind: 'predecessor-unknown', clientSeq: entry.clientSeq } };
      }
      if (prev.kind === 'refused') {
        return { verdict: this.refuse(key, entry, 'predecessor-refused', 'predecessor refused') };
      }
    }
    const before = counters(this.doc);
    if (this.options.guardCreated) {
      for (const f of entry.created ?? []) {
        const n = before.get(counterKey(f.scope, f.counter));
        if (n !== undefined && f.start < n) {
          this.createdCaught++;
          // Would core alone have let it through? Then it is a takeover the guard prevented.
          if (applyCommand(this.doc, entry.command).ok) this.takeovers++;
          return {
            verdict: this.refuse(
              key,
              entry,
              'id-reused',
              `${f.scope} ${f.counter}${f.start} taken`,
            ),
          };
        }
      }
    }
    const r = applyCommand(this.doc, entry.command);
    if (!r.ok) return { verdict: this.refuse(key, entry, r.error.code, r.error.message) };
    const next = r.value.document;
    const after = counters(next);
    if (this.options.guardCounters) {
      const back = regressions(before, after);
      if (back.length > 0) {
        return {
          verdict: this.refuse(key, entry, 'id-reused', `counters would go back: ${back[0]}`),
        };
      }
      // A scope that comes back (a part restored after it was deleted) below its old counters.
      for (const [k, n] of after) {
        if (!k.endsWith('|') && n < (this.highWater.get(k) ?? 1)) {
          return {
            verdict: this.refuse(
              key,
              entry,
              'counter-regression',
              `${k} below ${this.highWater.get(k)}`,
            ),
          };
        }
      }
    }
    this.check(next, after);
    this.doc = next;
    this.rev++;
    const outcome: Outcome = { kind: 'accepted', rev: this.rev };
    this.outcomes.set(key, outcome);
    const broadcast: Broadcast = { rev: this.rev, entry };
    this.log.push(broadcast);
    return { verdict: this.verdict(entry, outcome), broadcast };
  }

  /** Every head must pass checkDocument, and no counter may ever go below its high-water mark. */
  private check(next: ManufaktureDocument, after: Map<string, number>): void {
    const c = checkDocument(next);
    if (!c.ok) this.violations.push(`rev ${this.rev + 1}: checkDocument: ${c.error.message}`);
    for (const [k, n] of after) {
      if (k.endsWith('|')) continue; // the scope-exists marker
      const hw = this.highWater.get(k) ?? 1;
      if (n < hw)
        this.violations.push(`rev ${this.rev + 1}: id reuse possible, ${k} ${hw} -> ${n}`);
      else this.highWater.set(k, n);
    }
  }

  private refuse(key: string, entry: SyncEntry, code: string, message: string): Verdict {
    this.outcomes.set(key, { kind: 'refused', code, message });
    this.count(code);
    return { kind: 'refused', clientSeq: entry.clientSeq, code, message, headRev: this.rev };
  }

  private verdict(entry: SyncEntry, o: Outcome): Verdict {
    return o.kind === 'accepted'
      ? { kind: 'accepted', clientSeq: entry.clientSeq, rev: o.rev }
      : {
          kind: 'refused',
          clientSeq: entry.clientSeq,
          code: o.code,
          message: o.message,
          headRev: this.rev,
        };
  }

  private count(code: string): void {
    this.refusals.set(code, (this.refusals.get(code) ?? 0) + 1);
  }
}
