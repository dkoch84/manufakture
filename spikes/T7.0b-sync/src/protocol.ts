// Wire shapes between the simulated clients and the in-memory server (ADR 0009 decision 2).

import type { Command } from '@manufakture/core';
import type { FreshRange } from './scopes.ts';

export interface SyncEntry {
  clientId: string;
  clientSeq: number;
  prevSeq?: number | undefined;
  baseRev: number;
  label: string;
  command: Command;
  /**
   * The ids the command allocates, as the client computed them against the document it made the
   * command on. The server cannot recompute them: an editFeature that adds entity e10 to a sketch
   * which, on the server's head, already has another client's e10 looks like an edit of that e10.
   */
  created?: FreshRange[] | undefined;
}

export type Verdict =
  | { kind: 'accepted'; clientSeq: number; rev: number }
  | { kind: 'refused'; clientSeq: number; code: string; message: string; headRev: number }
  | { kind: 'predecessor-unknown'; clientSeq: number };

export interface Broadcast {
  rev: number;
  entry: SyncEntry;
}
