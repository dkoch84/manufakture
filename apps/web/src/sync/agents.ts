// Agent branches on the sync server, for the reviewer in this browser (ADR 0016 decisions 9 to 12,
// T8.4b). A headless session writes its agent branch on the server: its log, its review bundle
// and its review state. For each agent branch the server lists (kept in the library by
// `RecordSync`, provenance included), this:
//
// - brings the branch's server log into the library branch, one revision per entry, so History
//   shows the agent's batches and the Review view regenerates its head;
// - keeps the newest review bundle with the branch, and the images it names (checked against
//   their SHA-256), looking at its revision first so that a bundle already here is not downloaded;
// - follows the review state both ways. What the server said last is kept per branch (`known`),
//   saved with the sync state, so a reload still tells a reviewer's decision not sent yet (the
//   branch here differs from `known`) from a change made on the server (the server differs from
//   `known`). A decision made here (Approve, Request changes with its comment, Reject, or a failed
//   merge's return to submitted) goes to the server, a compare-and-set on `known`; a change made
//   there (the agent submitting, or reopening the branch by writing) comes here. When both moved,
//   the server's state wins, except a branch approved here, whose merge into Main has happened: its
//   approval is sent again only while the branch on the server is still the revision approved;
//   when the agent wrote to it since, the reviewer is told and the server keeps its state;
// - leaves a branch closed here (approved or rejected) alone once the server agrees, or once that
//   decision can no longer be sent: no log, bundle or review requests for it;
// - and drops an agent branch the server no longer lists (an update from Main replaced it, or the
//   owner deleted it), unless it was approved or rejected here.
//
// The library parses every provenance strictly, never turns a person's branch into an agent's or
// the reverse, and the bundle stays untrusted (the Review view checks it). Kept free of React.

import { applyCommand, migrateCommand, type ManufaktureDocument } from '@manufakture/core';
import {
  MAIN_BRANCH,
  MAX_REVIEW_BUNDLE_BYTES,
  type AgentReviewState,
  type BranchProvenance,
  type DocumentLibrary,
  type LogEntry,
} from '@manufakture/library';
import { ServerApi, ServerApiError, type Provenance, type ServerBranch } from '@manufakture/sync';

/** Images taken from one bundle, at most. */
export const MAX_BUNDLE_IMAGES = 64;
/** JSON values walked looking for them, at most. */
const MAX_WALK = 200_000;
const SHA256 = /^[0-9a-f]{64}$/;

/** A review state with its comment (none: undefined). */
interface Review {
  review: Provenance['review'];
  comment: string | undefined;
}

const reviewOf = (p: Pick<Provenance, 'review' | 'comment'>): Review => ({
  review: p.review,
  comment: p.comment,
});

const same = (a: Review | Pick<Provenance, 'review' | 'comment'>, b: Review): boolean =>
  a.review === b.review && a.comment === b.comment;

const closed = (review: Provenance['review']): boolean =>
  review === 'approved' || review === 'rejected';

/** The SHA-256s of the images a bundle names (`{ sha256 }` anywhere in it), bounded. */
export function bundleImages(record: unknown): string[] {
  const found = new Set<string>();
  const stack: unknown[] = [record];
  let walked = 0;
  while (stack.length > 0 && walked < MAX_WALK && found.size < MAX_BUNDLE_IMAGES) {
    const v = stack.pop();
    walked++;
    if (typeof v !== 'object' || v === null) continue;
    if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
      continue;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'sha256' && typeof x === 'string' && SHA256.test(x)) found.add(x);
      else stack.push(x);
    }
  }
  return [...found];
}

export interface AgentBranchSyncOptions {
  readonly library: DocumentLibrary;
  readonly documentId: string;
  readonly api: ServerApi;
  readonly warn: (message: string) => void;
  /** The review states last known on the server, as saved with the sync state. */
  readonly known?: readonly AgentReviewState[] | undefined;
  /** `known()` changed: save the sync state soon. */
  readonly save?: () => void;
}

export class AgentBranchSync {
  readonly #library: DocumentLibrary;
  readonly #id: string;
  readonly #api: ServerApi;
  readonly #warn: (message: string) => void;
  readonly #save: () => void;
  /** Per agent branch: its review state and comment on the server, as last taken in or sent. */
  readonly #known = new Map<string, Review>();
  #changed = false;

  constructor(options: AgentBranchSyncOptions) {
    this.#library = options.library;
    this.#id = options.documentId;
    this.#api = options.api;
    this.#warn = options.warn;
    this.#save = options.save ?? (() => undefined);
    for (const k of options.known ?? []) {
      this.#known.set(k.branch, { review: k.review, comment: k.comment });
    }
  }

  /** The review states last known on the server, to save with the sync state. */
  known(): AgentReviewState[] {
    return [...this.#known].map(([branch, r]) => ({
      branch,
      review: r.review,
      ...(r.comment === undefined ? {} : { comment: r.comment }),
    }));
  }

  #know(branch: string, r: Review | undefined): void {
    const was = this.#known.get(branch);
    if (r === undefined) {
      if (was === undefined) return;
      this.#known.delete(branch);
    } else {
      if (was !== undefined && same(was, r)) return;
      this.#known.set(branch, r);
    }
    this.#changed = true;
  }

  /**
   * One pass over the server's branch records (already kept in the library), listed by a request
   * that succeeded: logs, bundles, review states, and agent branches gone from the server. Never
   * throws for one branch's trouble; an unreachable server ends the pass (the next one tries
   * again).
   */
  async reconcile(server: readonly ServerBranch[]): Promise<void> {
    try {
      await this.#reconcile(server);
    } finally {
      if (this.#changed) {
        this.#changed = false;
        this.#save();
      }
    }
  }

  async #reconcile(server: readonly ServerBranch[]): Promise<void> {
    const listed = await this.#library.listBranches(this.#id);
    if (!listed.ok) return;
    const onServer = new Map(server.map((b) => [b.id, b]));
    // The versions kept from the server, read once and only when a branch is missing there.
    let fromServer: Set<string> | null = null;
    const cameFromServer = async (version: string | null): Promise<boolean> => {
      if (version === null) return false;
      if (fromServer === null) {
        const versions = await this.#library.listVersions(this.#id);
        fromServer = new Set(
          versions.ok
            ? versions.value.filter((v) => v.serverRev !== undefined).map((v) => v.id)
            : [],
        );
      }
      return fromServer.has(version);
    };
    for (const local of listed.value) {
      if (local.id === MAIN_BRANCH || local.provenance === undefined) continue;
      const sb = onServer.get(local.id);
      try {
        if (sb === undefined) {
          const synced = this.#known.has(local.id) || (await cameFromServer(local.fromVersion));
          await this.#gone(local.id, local.name, local.provenance, synced);
          continue;
        }
        if (sb.provenance === undefined) continue; // a person's there: never mixed up
        const review = await this.#review(local.id, local.provenance, sb.provenance);
        // Closed here: nothing more of it is taken from the server.
        if (closed(review)) continue;
        await this.#pullLog(local.id, local.name);
        await this.#bundle(local.id);
      } catch (e) {
        if (e instanceof ServerApiError && (e.status === 0 || e.status === 401)) throw e;
        this.#warn(`manufakture: agent branch "${local.name}": ${String(e)}`);
      }
    }
    // Branches neither here nor on the server are forgotten.
    const here = new Set(listed.value.map((b) => b.id));
    for (const branch of [...this.#known.keys()]) {
      if (!here.has(branch) && !onServer.has(branch)) this.#know(branch, undefined);
    }
  }

  /** The branch's server log after what the library holds (its revision n is the log's n - 1). */
  async #pullLog(branch: string, name: string): Promise<void> {
    const opened = await this.#library.open(this.#id, branch);
    if (!opened.ok) return;
    let doc: ManufaktureDocument = opened.value.document;
    let rev = opened.value.revision - 1;
    for (let pages = 0; pages < 1000; pages++) {
      const page = await this.#api.pull(this.#id, branch, rev);
      if (page.length === 0) return;
      for (const p of page) {
        if (p.rev !== rev + 1) {
          this.#warn(`manufakture: agent branch "${name}": its log on the server has a gap.`);
          return;
        }
        const command = migrateCommand(p.entry.command, p.entry.format);
        const applied = command.ok ? applyCommand(doc, command.value) : command;
        if (!command.ok || !applied.ok) {
          this.#warn(`manufakture: agent branch "${name}": an entry does not apply here.`);
          return;
        }
        const entry: LogEntry = {
          cause: p.entry.cause,
          label: p.entry.label,
          command: command.value,
          at: p.entry.at,
        };
        await this.#library.save(applied.value.document, [entry], branch);
        doc = applied.value.document;
        rev = p.rev;
      }
    }
  }

  /** Takes the server's review state and comment in here. */
  async #takeServer(branch: string, there: Provenance): Promise<Provenance['review']> {
    const set = await this.#library.setBranchReview(this.#id, branch, there.review, {
      comment: there.comment ?? null,
    });
    if (!set.ok) throw new Error(set.message);
    this.#know(branch, reviewOf(there));
    return there.review;
  }

  /** Follows the review state both ways (see the top of the file); the state here after it. */
  async #review(
    branch: string,
    here: BranchProvenance,
    there: Provenance,
  ): Promise<Provenance['review']> {
    if (same(here, reviewOf(there))) {
      this.#know(branch, reviewOf(there));
      return there.review;
    }
    const known = this.#known.get(branch);
    // Never seen by this browser's sync state: nothing here is a decision of its own to send.
    if (known === undefined) return this.#takeServer(branch, there);
    if (same(here, known)) {
      // Changed there only. A branch closed here stays as it is.
      if (closed(here.review)) return here.review;
      return this.#takeServer(branch, there);
    }
    // Decided here, not sent yet: to the server, a compare-and-set on what was last seen there.
    const decision = {
      review: here.review,
      ...(here.comment !== known.comment ? { comment: here.comment ?? null } : {}),
    };
    try {
      const stored = await this.#api.setReview(this.#id, branch, {
        ...decision,
        expected: known.review,
      });
      this.#know(branch, reviewOf(stored.provenance!));
      return here.review;
    } catch (e) {
      if (!(e instanceof ServerApiError) || e.code !== 'review-changed') throw e;
    }
    if (here.review === 'approved') return this.#approvedMeanwhile(branch, here, there, decision);
    this.#warn(
      `manufakture: the review of an agent branch changed on the server meanwhile; it is ${there.review} now.`,
    );
    return this.#takeServer(branch, there);
  }

  /**
   * Approved here (and merged into Main) while the server's state moved. The approval is sent
   * again only while the branch on the server is still the revision approved here; if the agent
   * wrote to it since, the server keeps its state, the reviewer is told, and this browser sends
   * the approval no more.
   */
  async #approvedMeanwhile(
    branch: string,
    here: BranchProvenance,
    there: Provenance,
    decision: { review: Provenance['review']; comment?: string | null },
  ): Promise<Provenance['review']> {
    const opened = await this.#library.open(this.#id, branch);
    if (!opened.ok) throw new Error(opened.message);
    const approved = opened.value.revision - 1;
    const later = await this.#api.pull(this.#id, branch, approved);
    if (later.length === 0) {
      const stored = await this.#api.setReview(this.#id, branch, {
        ...decision,
        expected: there.review,
      });
      this.#know(branch, reviewOf(stored.provenance!));
      return here.review;
    }
    this.#warn(
      `manufakture: an agent branch approved here was written to on the server since (it is ${there.review} there): the approval stands here, and the agent's later work waits on the server.`,
    );
    // Nothing more to send: the branch is closed here.
    this.#know(branch, reviewOf(here));
    return here.review;
  }

  /** The server's newest bundle of the branch, with its images, when it is newer than ours. */
  async #bundle(branch: string): Promise<void> {
    // A look at its revision first: a bundle already here is not downloaded again.
    const meta = await this.#api.bundleMeta(this.#id, branch);
    if (meta === null) return;
    const here = await this.#library.reviewBundle(this.#id, branch);
    if (here.ok && here.value !== null && here.value.revision >= meta.revision) return;
    if (meta.bytes > MAX_REVIEW_BUNDLE_BYTES) {
      this.#warn('manufakture: a review bundle on the server is too large to keep.');
      return;
    }
    const there = await this.#api.getBundle(this.#id, branch);
    if (there === null) return;
    for (const sha of bundleImages(there.record)) {
      if ((await this.#library.reviewImage(this.#id, sha)) !== null) continue;
      const bytes = await this.#api.getBlob(sha);
      if (bytes === null) continue;
      const stored = await this.#library.storeReviewImage(this.#id, bytes);
      // Bytes that do not hash to their name are not that image: the Review view shows it missing.
      if (stored.ok && stored.value !== sha) {
        this.#warn('manufakture: an image of a review bundle did not match its name.');
      }
    }
    const kept = await this.#library.storeReviewBundle(
      this.#id,
      branch,
      there.revision,
      there.record,
    );
    if (!kept.ok) this.#warn(`manufakture: a review bundle from the server: ${kept.message}`);
  }

  /**
   * An agent branch the server no longer lists: replaced by an update from Main, or deleted.
   * Only a branch that came from the server goes (`synced`); one approved or rejected here stays.
   */
  async #gone(
    branch: string,
    name: string,
    here: BranchProvenance,
    synced: boolean,
  ): Promise<void> {
    if (!synced) return;
    this.#know(branch, undefined);
    if (closed(here.review)) return;
    const deleted = await this.#library.deleteBranch(this.#id, branch);
    if (!deleted.ok) this.#warn(`manufakture: agent branch "${name}": ${deleted.message}`);
  }
}
