// One writer per branch (the headless session model, docs/plans/agent-surface.md): a session
// takes its branch's lock when it opens and releases it when it closes, and a second session
// asking for the same branch is refused instead of waiting. These are not the library's own
// document locks (`DocumentLocks`, held for one operation at a time): a branch lock is held for
// as long as a session works on the branch, across many operations.
//
// `MemoryBranchLocks` holds them in one process. The Node file system version (`./node`,
// `NodeBranchLocks`) holds them across processes with lock files.

import { isBranchId, isStorableId } from './library';

/** A held branch lock. */
export interface BranchLock {
  readonly documentId: string;
  readonly branch: string;
  /** Whether this holder still has it (a file lock can be broken as stale; see `./node`). */
  held(): Promise<boolean>;
  /** Let it go. Releasing twice, or after it was broken, does nothing. */
  release(): Promise<void>;
}

export interface BranchLocks {
  /**
   * The lock on branch `branch` of document `documentId`, or null while another holder has it.
   * Never waits. `holder` names who takes it (a session id), for whoever finds it taken.
   */
  acquire(documentId: string, branch: string, holder?: string): Promise<BranchLock | null>;
}

/** Throws unless `documentId` and `branch` are ids the library stores: no path can be made. */
export function checkLockIds(documentId: string, branch: string): void {
  if (!isStorableId(documentId))
    throw new Error(`Cannot lock a document with the id "${documentId}"`);
  if (!isBranchId(branch)) throw new Error(`Cannot lock a branch with the id "${branch}"`);
}

/** Branch locks within one process: tests, and a library only one process opens. */
export class MemoryBranchLocks implements BranchLocks {
  readonly #held = new Map<string, symbol>();

  async acquire(documentId: string, branch: string): Promise<BranchLock | null> {
    checkLockIds(documentId, branch);
    const key = `${documentId}/${branch}`;
    if (this.#held.has(key)) return null;
    const token = Symbol(key);
    this.#held.set(key, token);
    const mine = () => this.#held.get(key) === token;
    return {
      documentId,
      branch,
      held: async () => mine(),
      release: async () => {
        if (mine()) this.#held.delete(key);
      },
    };
  }
}
