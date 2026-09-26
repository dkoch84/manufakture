// The solver worker's API (ADR 0007): one interface, plain data in and out,
// so it can run in a Web Worker or in Node for tests.
//
// - Interactive sessions are keyed by sketch id. Drag moves are coalesced per
//   session: the latest target wins, and superseded moves resolve to `null`
//   without being solved, so a slow solve never queues stale drags.
// - Regen solves (`solve`) are stateless and never coalesced or dropped: each
//   is answered in full, whatever the sessions are doing. Each gets a fresh
//   solver system, disposed afterwards, so its result depends on the sketch
//   alone and never on what was solved before (entity and constraint ids
//   repeat across sketches).
// - When the solver instance aborts (out of memory), the call reports
//   `aborted`, the instance is discarded, and the next call loads a new one;
//   sessions reload their sketch (and resume a drag) on their next use.

import type { Quantity, VariableLookup } from '@manufakture/units';
import {
  applyCoordinates,
  packCoordinates,
  type DragResult,
  type PointRef,
  type SketchInput,
  type SolveResult,
  type Vec2,
} from './model';
import { loadPlanegcsBackend } from './planegcs/system';
import type { SketchSolverBackend, SketchSystem } from './solver';

/** Variable values by name (without '#'), as plain data. */
export type Variables = Readonly<Record<string, Quantity>>;

export interface SketchSolverApi {
  /**
   * Solve a sketch as stored, for the regen engine. Independent of sessions;
   * never coalesced.
   */
  solve(sketch: SketchInput, variables?: Variables): Promise<SolveResult>;
  /** Load or update the session for `sessionId` (a sketch id) and solve it. */
  update(
    sessionId: string,
    sketch: SketchInput,
    variables?: Variables,
    options?: { analyze?: boolean },
  ): Promise<SolveResult>;
  /** Start dragging a point of the session's sketch. */
  dragStart(sessionId: string, point: PointRef): Promise<void>;
  /**
   * Move the drag target. Resolves to `null` when a later move superseded
   * this one before it was solved.
   */
  dragMove(sessionId: string, target: Vec2): Promise<DragResult | null>;
  /** End the drag; the result carries the final entities and diagnosis. */
  dragEnd(sessionId: string): Promise<SolveResult>;
  /** Drop a session and its solver state. */
  close(sessionId: string): Promise<void>;
}

export interface SolverServiceOptions {
  /** Loads a solver instance; the default loads planegcs. */
  loadBackend?: () => Promise<SketchSolverBackend>;
  /**
   * Runs the coalesced drag solve later. The default, a zero-delay timeout,
   * lets moves already queued in the worker arrive first.
   */
  schedule?: (fn: () => void) => void;
}

interface Waiter {
  resolve: (r: DragResult | null) => void;
  reject: (e: unknown) => void;
}

interface Session {
  system: SketchSystem | null;
  /** The last accepted sketch; the coordinates are the latest solved ones. */
  sketch: SketchInput;
  variables: Variables | undefined;
  /** Whether `system` needs `sketch` loaded (new or recycled instance). */
  needsLoad: boolean;
  dragPoint: PointRef | null;
  /** Coordinates after the last drag move, for reloading mid-drag. */
  dragCoordinates: Float64Array | null;
  pending: { target: Vec2; waiters: Waiter[] } | null;
  flushing: Promise<void> | null;
}

function lookup(variables: Variables | undefined): VariableLookup | undefined {
  if (!variables) return undefined;
  return (name) => (Object.hasOwn(variables, name) ? variables[name] : undefined);
}

export class SolverService implements SketchSolverApi {
  private readonly loadBackend: () => Promise<SketchSolverBackend>;
  private readonly schedule: (fn: () => void) => void;
  private backend: Promise<SketchSolverBackend> | null = null;
  private readonly sessions = new Map<string, Session>();
  /** How many solver instances were loaded (1 plus one per recycle). */
  loads = 0;

  constructor(options: SolverServiceOptions = {}) {
    this.loadBackend = options.loadBackend ?? (() => loadPlanegcsBackend());
    this.schedule = options.schedule ?? ((fn) => void setTimeout(fn, 0));
  }

  async solve(sketch: SketchInput, variables?: Variables): Promise<SolveResult> {
    const backend = await this.getBackend();
    const system = backend.createSystem();
    try {
      const vars = lookup(variables);
      return system.update(sketch, vars ? { variables: vars } : {});
    } finally {
      system.dispose();
    }
  }

  async update(
    sessionId: string,
    sketch: SketchInput,
    variables?: Variables,
    options: { analyze?: boolean } = {},
  ): Promise<SolveResult> {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        system: null,
        sketch,
        variables,
        needsLoad: true,
        dragPoint: null,
        dragCoordinates: null,
        pending: null,
        flushing: null,
      };
      this.sessions.set(sessionId, session);
    }
    await this.settle(session);
    const system = await this.systemFor(session);
    const vars = lookup(variables);
    const result = system.update(sketch, {
      ...(vars ? { variables: vars } : {}),
      ...(options.analyze === undefined ? {} : { analyze: options.analyze }),
    });
    if (result.status !== 'invalid') {
      session.sketch = { entities: result.entities, constraints: sketch.constraints };
      session.variables = variables;
      session.needsLoad = result.status === 'aborted';
      session.dragPoint = null;
      session.dragCoordinates = null;
    }
    return result;
  }

  async dragStart(sessionId: string, point: PointRef): Promise<void> {
    const session = this.session(sessionId);
    await this.settle(session);
    session.dragPoint = point;
    session.dragCoordinates = null;
    const system = await this.loaded(session);
    if (system.aborted) return; // reported by the next move
    try {
      system.beginDrag(point);
    } catch (e) {
      session.dragPoint = null;
      throw e;
    }
  }

  dragMove(sessionId: string, target: Vec2): Promise<DragResult | null> {
    const session = this.session(sessionId);
    if (!session.dragPoint)
      return Promise.reject(new Error(`No drag in progress in '${sessionId}'`));
    return new Promise<DragResult | null>((resolve, reject) => {
      const waiter = { resolve, reject };
      const scheduled = session.pending !== null;
      if (session.pending) {
        session.pending.target = target;
        session.pending.waiters.push(waiter);
      } else {
        session.pending = { target, waiters: [waiter] };
      }
      if (!scheduled) this.schedule(() => void this.flush(session));
    });
  }

  async dragEnd(sessionId: string): Promise<SolveResult> {
    const session = this.session(sessionId);
    await this.settle(session);
    const system = await this.loaded(session);
    const result = system.endDrag();
    session.dragPoint = null;
    session.dragCoordinates = null;
    if (result.status !== 'aborted') {
      session.sketch = { entities: result.entities, constraints: session.sketch.constraints };
    } else {
      session.needsLoad = true;
    }
    return result;
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    for (const w of session.pending?.waiters ?? []) w.resolve(null);
    session.pending = null;
    session.system?.dispose();
  }

  /** Session ids currently open. */
  get sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  // Internals ----------------------------------------------------------------

  private session(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`No solver session '${id}'; call update first`);
    return s;
  }

  /** The live backend, loading a new one when there is none or it aborted. */
  private async getBackend(): Promise<SketchSolverBackend> {
    if (this.backend) {
      const current = await this.backend;
      if (!current.aborted) return current;
      // Discard every system of the dead instance.
      this.backend = null;
      for (const s of this.sessions.values()) {
        s.system = null;
        s.needsLoad = true;
      }
    }
    if (!this.backend) {
      this.loads++;
      this.backend = this.loadBackend();
      this.backend.catch(() => (this.backend = null));
    }
    return this.backend;
  }

  private async systemFor(session: Session): Promise<SketchSystem> {
    const backend = await this.getBackend();
    if (!session.system || session.system.aborted) {
      session.system = backend.createSystem();
      session.needsLoad = true;
    }
    return session.system;
  }

  /** The session's system with its sketch loaded, and its drag resumed, after a recycle. */
  private async loaded(session: Session): Promise<SketchSystem> {
    const system = await this.systemFor(session);
    if (!session.needsLoad) return system;
    const entities = session.dragCoordinates
      ? applyCoordinates(session.sketch.entities, session.dragCoordinates)
      : session.sketch.entities;
    const vars = lookup(session.variables);
    const result = system.update(
      { entities, constraints: session.sketch.constraints },
      vars ? { variables: vars } : {},
    );
    if (result.status === 'aborted') return system;
    session.needsLoad = false;
    if (session.dragPoint) system.beginDrag(session.dragPoint);
    return system;
  }

  /** Solve the latest pending move now, if one is waiting. */
  private async settle(session: Session): Promise<void> {
    if (session.flushing) await session.flushing;
    if (session.pending) await this.flush(session);
  }

  private flush(session: Session): Promise<void> {
    const pending = session.pending;
    if (!pending) return session.flushing ?? Promise.resolve();
    session.pending = null;
    const run = async () => {
      const last = pending.waiters.pop()!;
      for (const w of pending.waiters) w.resolve(null);
      try {
        const system = await this.loaded(session);
        if (!session.dragPoint || session.pending) {
          // Ended or superseded while the instance was loading.
          last.resolve(null);
          return;
        }
        const result = system.aborted
          ? ({
              status: 'aborted',
              coordinates:
                session.dragCoordinates?.slice() ?? packCoordinates(session.sketch.entities),
              message: system.aborted,
            } satisfies DragResult)
          : system.drag(pending.target);
        if (result.status === 'aborted') session.needsLoad = true;
        else session.dragCoordinates = result.coordinates.slice();
        last.resolve(result);
      } catch (e) {
        last.reject(e);
      }
    };
    const flushing = run().finally(() => {
      if (session.flushing === flushing) session.flushing = null;
    });
    session.flushing = flushing;
    return flushing;
  }
}

export function createSolverService(options?: SolverServiceOptions): SolverService {
  return new SolverService(options);
}
