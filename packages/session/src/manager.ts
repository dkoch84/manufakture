// The sessions of one process (the MCP server's): opens and resumes them under the per-process
// limit (ADR 0016 decision 3: 4 with each session's kernel in a worker thread of its own, 2 when
// they share the main thread), finds them by id, and closes them all.

import type { BranchLocks, DocumentLibrary } from '@manufakture/library';
import type { BundleStore } from './bundles';
import { startEngine, type Engine, type EngineKind } from './engine';
import { sessionError, type SessionResult } from './errors';
import {
  IN_PROCESS_SESSIONS_PER_PROCESS,
  WORKER_SESSIONS_PER_PROCESS,
  sessionLimits,
  type SessionLimits,
} from './limits';
import {
  Session,
  type OpenOptions,
  type ResumeOptions,
  type SessionHost,
  type SessionLogEvent,
} from './session';

export interface SessionManagerOptions {
  library: DocumentLibrary;
  /** One holder per branch: `NodeBranchLocks` on the library's directory. */
  locks: BranchLocks;
  bundles?: BundleStore;
  /** Where each session's kernel runs (default `worker`). */
  engine?: EngineKind;
  /** The worker's script, for a bundled host (see `WorkerEngineOptions.url`). */
  workerUrl?: URL;
  workerExecArgv?: string[];
  /** Overrides of `DEFAULT_LIMITS`; `sessionsPerProcess` defaults by engine kind. */
  limits?: Partial<SessionLimits>;
  now?: () => Date;
  /**
   * The server-side log of errors the agent is told about only in general terms (file system
   * errors with their paths, a worker's error text). Default: none.
   */
  log?: (event: SessionLogEvent) => void;
}

export class SessionManager {
  readonly #options: SessionManagerOptions;
  readonly #limits: SessionLimits;
  readonly #sessions = new Map<string, Session>();
  /** Opens in flight count against the limit too. */
  #pending = 0;

  constructor(options: SessionManagerOptions) {
    this.#options = options;
    const kind = options.engine ?? 'worker';
    this.#limits = sessionLimits({
      sessionsPerProcess:
        kind === 'worker' ? WORKER_SESSIONS_PER_PROCESS : IN_PROCESS_SESSIONS_PER_PROCESS,
      ...options.limits,
    });
  }

  get limits(): SessionLimits {
    return this.#limits;
  }

  /** The open sessions. */
  list(): Session[] {
    return [...this.#sessions.values()];
  }

  get(sessionId: string): Session | undefined {
    return this.#sessions.get(sessionId);
  }

  #host(): SessionHost {
    const o = this.#options;
    return {
      library: o.library,
      locks: o.locks,
      limits: this.#limits,
      ...(o.bundles ? { bundles: o.bundles } : {}),
      ...(o.now ? { now: o.now } : {}),
      ...(o.log ? { log: o.log } : {}),
      isOpen: (sessionId) => this.#sessions.has(sessionId),
      engine: (): Promise<Engine> =>
        startEngine(o.engine ?? 'worker', {
          heapThresholdBytes: this.#limits.kernelHeapBytes,
          ...(o.workerUrl ? { url: o.workerUrl } : {}),
          ...(o.workerExecArgv ? { execArgv: o.workerExecArgv } : {}),
        }),
      onClose: (session) => {
        if (this.#sessions.get(session.id) === session) this.#sessions.delete(session.id);
      },
    };
  }

  async #admit(
    start: (host: SessionHost) => Promise<SessionResult<Session>>,
  ): Promise<SessionResult<Session>> {
    const max = this.#limits.sessionsPerProcess;
    if (this.#sessions.size + this.#pending >= max) {
      return sessionError(
        'too-many-sessions',
        `At most ${max} sessions are open at once: close one first.`,
        max,
      );
    }
    this.#pending++;
    try {
      const opened = await start(this.#host());
      if (!opened.ok) return opened;
      // Two starts of one id raced each other: the later one does not replace the earlier.
      if (this.#sessions.has(opened.value.id)) {
        await opened.value.close();
        return sessionError('locked', 'A session with that id is open.');
      }
      this.#sessions.set(opened.value.id, opened.value);
      return opened;
    } finally {
      this.#pending--;
    }
  }

  /** A new session on a new agent branch of the document's Main head. */
  open(options: OpenOptions): Promise<SessionResult<Session>> {
    if (options.sessionId !== undefined && this.#sessions.has(options.sessionId)) {
      return Promise.resolve(sessionError('locked', 'A session with that id is open.'));
    }
    return this.#admit((host) => Session.open(host, options));
  }

  /** Reopen an agent branch in review state `open` or `changes-requested`. */
  resume(options: ResumeOptions): Promise<SessionResult<Session>> {
    return this.#admit((host) => Session.resume(host, options));
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.list().map((s) => s.close()));
  }
}
