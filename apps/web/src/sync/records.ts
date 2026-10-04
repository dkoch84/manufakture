// Named versions and branches on the sync server (T7.1e; docs/user/sync.md, "Versions and
// branches"), for the document that syncs in this tab:
//
// - A version made here on the main branch while the document syncs is stored on the server,
//   naming the server revision that holds what it names: the confirmed revision when nothing was
//   waiting to be sent, else the revision the last waiting change landed at (`landed`). Until
//   then it waits in `uploads`, saved with the sync state, so a reload does not lose it.
// - A branch made here from a version the server has is stored there too; its server log starts
//   from that version.
// - Versions and branches on the server that this browser does not have are kept in the library
//   (`adoptVersion`, `adoptBranch`), so the History panel lists them, and they can be viewed,
//   restored, branched from and pinned like any other.
// - What sync makes itself (the version and branch that keep work a rebase dropped) stays here:
//   the work on that branch is this browser's.
//
// Versions and branches that were here before the document started syncing in this tab stay
// here. Edits on a branch are not synced: only the main branch's log is.
// Kept free of React.

import { serialize } from '@manufakture/core';
import { ServerVersionSchema, type SyncClient } from '@manufakture/sync';
import {
  MAIN_BRANCH,
  versionBranch,
  type DocumentLibrary,
  type LibraryChange,
  type SyncUploads,
} from '../persistence/library';
import type { ServerSettings } from '../sharing/client';
import {
  SyncError,
  fetchServerVersion,
  listServerBranches,
  listServerVersions,
  uploadServerBranch,
  uploadServerVersion,
  type ApiOptions,
} from './api';

/** How often the server's versions and branches are looked at while a document syncs. */
export const RECORDS_POLL_MS = 5_000;

export interface RecordSyncOptions {
  readonly library: DocumentLibrary;
  readonly documentId: string;
  readonly server: ServerSettings;
  readonly client: SyncClient;
  /** What was waiting when the sync state was saved. */
  readonly uploads?: SyncUploads | undefined;
  /** Save the sync state soon: `uploads()` changed. */
  readonly save: () => void;
  readonly fetch?: typeof fetch;
  /** Default `RECORDS_POLL_MS`; 0: only when something happens here. */
  readonly pollMs?: number;
  readonly warn?: (message: string) => void;
  /** The clock retries are timed by (tests). */
  readonly now?: () => number;
}

/** How many landings are remembered for versions whose step has not run yet. */
const MAX_LANDINGS = 1000;
/** The first and the longest wait before keeping a server's record that failed is tried again. */
const RETRY_FIRST_MS = 10_000;
const RETRY_MAX_MS = 10 * 60_000;

/** A version waiting for the server: its server revision once known, or the entry it waits for. */
type Pending = SyncUploads['versions'][number];

export class RecordSync {
  readonly #library: DocumentLibrary;
  readonly #id: string;
  readonly #server: ServerSettings;
  readonly #client: SyncClient;
  readonly #save: () => void;
  readonly #api: ApiOptions;
  readonly #pollMs: number;
  readonly #warn: (message: string) => void;
  #versions: Pending[];
  #branches: string[];
  /** Ids already here (or kept from the server): a change that adds others made them here. */
  readonly #knownVersions = new Set<string>();
  readonly #knownBranches = new Set<string>();
  /** While sync itself makes versions and branches (`keep`), they are not stored on the server. */
  #keeping = 0;
  #chain: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #stops: Array<() => void> = [];
  #stopped = false;
  /** Revisions recent own entries landed at, by local id (`landed`), newest last. */
  readonly #landings = new Map<number, number>();
  /** Versions and branches from the server that could not be kept: when to try again. */
  readonly #failures = new Map<string, { count: number; next: number }>();
  readonly #now: () => number;

  constructor(options: RecordSyncOptions) {
    this.#library = options.library;
    this.#id = options.documentId;
    this.#server = options.server;
    this.#client = options.client;
    this.#save = options.save;
    this.#api = options.fetch ? { fetch: options.fetch } : {};
    this.#pollMs = options.pollMs ?? RECORDS_POLL_MS;
    this.#warn = options.warn ?? ((message) => console.warn(message));
    this.#now = options.now ?? Date.now;
    this.#versions = (options.uploads?.versions ?? []).map((u) => ({ ...u }));
    this.#branches = [...(options.uploads?.branches ?? [])];
  }

  /** What waits for the server, to save with the sync state (undefined: nothing). */
  uploads(): SyncUploads | undefined {
    if (this.#versions.length === 0 && this.#branches.length === 0) return undefined;
    return { versions: this.#versions.map((u) => ({ ...u })), branches: [...this.#branches] };
  }

  /**
   * Notes what is here now, then follows the library and the client. Subscribes at once, before
   * anything awaits, so a change that lands meanwhile is heard.
   */
  start(): Promise<void> {
    this.#stops.push(
      this.#client.on('landed', (e) => this.#landed(e.local, e.rev)),
      this.#library.subscribe((change) => this.#changed(change)),
    );
    if (this.#pollMs > 0) this.#timer = setInterval(() => void this.run(), this.#pollMs);
    return this.#queue(async () => {
      const versions = await this.#library.listVersions(this.#id);
      const branches = await this.#library.listBranches(this.#id);
      if (versions.ok) for (const v of versions.value) this.#knownVersions.add(v.id);
      if (branches.ok) for (const b of branches.value) this.#knownBranches.add(b.id);
    }).then(() => this.run());
  }

  /** No more runs of its own and no more listening; what is queued finishes. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    for (const s of this.#stops.splice(0)) s();
  }

  /** Runs `make` (sync keeping dropped work as a branch): what it makes stays in this browser. */
  async keep<T>(make: () => Promise<T>): Promise<T> {
    this.#keeping++;
    try {
      return await make();
    } finally {
      this.#keeping--;
    }
  }

  /** Stores what waits on the server and keeps what the server has that is not here. */
  run(): Promise<void> {
    return this.#queue(() => this.#reconcile());
  }

  #queue(step: () => Promise<void>): Promise<void> {
    // Steps queued before `stop` still run: a branch made just before its document closes (the
    // app opens the new branch) is still stored on the server. Records are sent idempotently.
    const next = this.#chain.then(step);
    this.#chain = next.catch((e: unknown) => {
      this.#warn(`manufakture: sync of versions and branches: ${String(e)}`);
    });
    return this.#chain;
  }

  #landed(local: number, rev: number): void {
    // Kept for a version whose change is noted but not yet added (its step is still queued).
    this.#landings.set(local, rev);
    if (this.#landings.size > MAX_LANDINGS) {
      this.#landings.delete(this.#landings.keys().next().value!);
    }
    let changed = false;
    for (const u of this.#versions) {
      if (u.after === local && u.rev === undefined) {
        u.rev = rev;
        delete u.after;
        changed = true;
      }
    }
    if (changed) {
      this.#save();
      void this.run();
    }
  }

  #changed(change: LibraryChange): void {
    if (change.id !== this.#id || this.#stopped) return;
    // Taken now: what the change names is what the client shows at this moment.
    const keeping = this.#keeping > 0;
    const pending = this.#client.pending;
    const at: Omit<Pending, 'id'> =
      pending.length === 0
        ? { rev: this.#client.confirmedRevision }
        : { after: pending.at(-1)!.local };
    void this.#queue(async () => {
      let added = false;
      if (change.kind === 'versions') {
        const listed = await this.#library.listVersions(this.#id);
        if (!listed.ok) return;
        for (const v of listed.value) {
          if (this.#knownVersions.has(v.id)) continue;
          this.#knownVersions.add(v.id);
          // Kept from the server, made on a branch, or made by sync itself: not stored there.
          if (keeping || v.serverRev !== undefined || versionBranch(v) !== MAIN_BRANCH) continue;
          // The change it waits for may have landed while this step waited in the queue.
          const landed = at.after === undefined ? undefined : this.#landings.get(at.after);
          this.#versions.push(
            landed === undefined ? { id: v.id, ...at } : { id: v.id, rev: landed },
          );
          added = true;
        }
      } else {
        const listed = await this.#library.listBranches(this.#id);
        if (!listed.ok) return;
        for (const b of listed.value) {
          if (this.#knownBranches.has(b.id)) continue;
          this.#knownBranches.add(b.id);
          if (keeping || b.id === MAIN_BRANCH) continue;
          this.#branches.push(b.id);
          added = true;
        }
      }
      if (added) this.#save();
    }).then(() => this.run());
  }

  async #reconcile(): Promise<void> {
    const id = this.#id;
    let changed = false;
    const drop = (what: string, why: string) => {
      this.#warn(`manufakture: ${what} of document ${id} stays in this browser: ${why}`);
      changed = true;
    };
    try {
      const versions = await this.#library.listVersions(id);
      if (!versions.ok) return;
      const here = new Map(versions.value.map((v) => [v.id, v]));

      // Versions made here: once their server revision is known, stored there.
      for (const u of [...this.#versions]) {
        const v = here.get(u.id);
        const remove = () => (this.#versions = this.#versions.filter((x) => x !== u));
        if (v === undefined) {
          remove();
          changed = true;
          continue;
        }
        if (u.rev === undefined) {
          // The change it waited for left the queue without landing (dropped or undone): it can
          // name the confirmed revision only if that is what it holds.
          if (this.#client.pending.length > 0) continue;
          const read = await this.#library.readVersion(id, u.id);
          if (
            read.ok &&
            serialize(read.value.document) === serialize(this.#client.confirmedDocument)
          ) {
            u.rev = this.#client.confirmedRevision;
            delete u.after;
            changed = true;
          } else {
            remove();
            drop(`version "${v.name}"`, 'the server never held what it names');
            continue;
          }
        }
        const record = ServerVersionSchema.safeParse({
          id: v.id,
          name: v.name,
          description: v.description,
          branch: MAIN_BRANCH,
          rev: u.rev,
          createdAt: v.createdAt,
        });
        if (!record.success) {
          remove();
          drop(`version "${v.name}"`, 'its record is not one the server takes');
          continue;
        }
        if (
          !(await this.#upload(() => uploadServerVersion(this.#server, id, record.data, this.#api)))
        ) {
          remove();
          drop(`version "${v.name}"`, 'the server refused it');
          continue;
        }
        remove();
        changed = true;
      }

      const onServer = await listServerVersions(this.#server, id, this.#api);
      const serverVersions = new Set(onServer.map((v) => v.id));

      // Branches made here from a version the server has.
      if (this.#branches.length > 0) {
        const branches = await this.#library.listBranches(id);
        if (!branches.ok) return;
        for (const bid of [...this.#branches]) {
          const b = branches.value.find((x) => x.id === bid);
          const remove = () => (this.#branches = this.#branches.filter((x) => x !== bid));
          if (b === undefined || b.fromVersion === null) {
            remove();
            changed = true;
            continue;
          }
          if (!serverVersions.has(b.fromVersion)) {
            // Its version may still be on its way; otherwise it is this browser's only.
            if (this.#versions.some((u) => u.id === b.fromVersion)) continue;
            remove();
            drop(`branch "${b.name}"`, 'the version it was made from is not on the server');
            continue;
          }
          const sent = await this.#upload(() =>
            uploadServerBranch(
              this.#server,
              id,
              { id: b.id, name: b.name, fromVersion: b.fromVersion!, createdAt: b.createdAt },
              this.#api,
            ),
          );
          remove();
          if (sent) changed = true;
          else drop(`branch "${b.name}"`, 'the server refused it');
        }
      }

      // What the server has that is not here.
      for (const sv of onServer) {
        if (here.has(sv.id) || this.#waiting(`v:${sv.id}`)) continue;
        const found = await fetchServerVersion(this.#server, id, sv.id, this.#api).catch(
          (e: unknown) => {
            // Unreachable or busy: everything waits. Anything else is this record's fault.
            if (e instanceof SyncError && [0, 401, 429].includes(e.status)) throw e;
            if (e instanceof SyncError && e.status >= 500) throw e;
            return null;
          },
        );
        if (found === null) {
          this.#failed(`v:${sv.id}`);
          continue;
        }
        this.#knownVersions.add(sv.id);
        const kept = await this.#library.adoptVersion(
          id,
          {
            id: sv.id,
            name: sv.name,
            description: sv.description,
            createdAt: sv.createdAt,
            branch: sv.branch,
            serverRev: sv.rev,
          },
          found.document,
        );
        if (kept.ok) this.#failures.delete(`v:${sv.id}`);
        else {
          this.#failed(`v:${sv.id}`);
          this.#warn(`manufakture: a version from the server: ${kept.message}`);
        }
      }
      const serverBranches = await listServerBranches(this.#server, id, this.#api);
      if (serverBranches.length > 0) {
        const branches = await this.#library.listBranches(id);
        if (!branches.ok) return;
        const local = new Set(branches.value.map((b) => b.id));
        for (const sb of serverBranches) {
          if (local.has(sb.id) || this.#waiting(`b:${sb.id}`)) continue;
          this.#knownBranches.add(sb.id);
          const kept = await this.#library.adoptBranch(id, sb);
          if (kept.ok) this.#failures.delete(`b:${sb.id}`);
          else {
            this.#failed(`b:${sb.id}`);
            this.#warn(`manufakture: a branch from the server: ${kept.message}`);
          }
        }
      }
    } catch (e) {
      // Offline or the server is away: everything waits for the next run.
      if (!(e instanceof SyncError)) throw e;
    } finally {
      if (changed) this.#save();
    }
  }

  /** Whether keeping `key` failed recently enough that it is not tried yet. */
  #waiting(key: string): boolean {
    const f = this.#failures.get(key);
    return f !== undefined && this.#now() < f.next;
  }

  /** Keeping `key` failed: wait twice as long as last time before trying again. */
  #failed(key: string): void {
    const count = (this.#failures.get(key)?.count ?? 0) + 1;
    const wait = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (count - 1));
    this.#failures.set(key, { count, next: this.#now() + wait });
  }

  /**
   * Sends one record: true when the server has it, false when it refused it for good (a 4xx but
   * a rate limit); throws when it may take it later (unreachable, busy).
   */
  async #upload(send: () => Promise<void>): Promise<boolean> {
    try {
      await send();
      return true;
    } catch (e) {
      if (e instanceof SyncError && e.status >= 400 && e.status < 500 && e.status !== 429) {
        if (e.status === 401) throw e;
        return false;
      }
      throw e;
    }
  }
}
