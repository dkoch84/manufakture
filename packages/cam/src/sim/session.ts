// The simulation as the CAM worker serves it (M5 plan, T5.3c; ADR 0014 decision 7):
//
// - `SimulationSession` holds the program last loaded (one per worker API) under the id its
//   caller gave it, so the preview's playback sends the program once and then only move numbers:
//   `simulateProgram({ programId, program, upTo })` loads and runs, `simulateProgram({ programId,
//   upTo })` carries on (or goes back) from where the session stands. A request naming a program
//   the session does not hold gets `needs-program`, and the caller sends it again.
// - `simulateHeightmap` is the `Simulator` for the older `simulate` call on cached toolpaths: the
//   toolpaths one after another, each with its own tool, from the uncut stock.
//
// `simulateProgram` and `simulate` share one generation channel (`simulate`): a newer request of
// either kind supersedes an older one of either kind still running, so a playback's simulation and
// a `simulate` call on one worker cancel each other. The preview gives the simulation a worker of
// its own for that reason.
//
// Everything that goes back is a copy whose buffers the worker transfers (`frameTransferables`).

import { unpackToolpath, type PackedToolpath } from '../worker/pack';
import type { WorkContext } from '../worker/registry';
import type { Heightmap, SimulationInput, SimulationOutcome } from '../worker/api';
import { isMove, type IrEntry } from '../ir';
import type { Box3, Mesh, Tool, Vec3, WcsFrame } from '../types';
import { meshToMachine } from './part';
import { MaterialSimulation, type SimReport, type SimulationOptions } from './simulation';

/** A program for `simulateProgram`. Its buffers may be transferred to the worker. */
export interface CamSimProgram {
  /** The program, packed (`packToolpath`), machine coordinates. */
  readonly toolpath: PackedToolpath;
  /** The tools its tool changes name. */
  readonly tools: readonly Tool[];
  /** The stock box, machine coordinates. */
  readonly stock: Box3;
  /**
   * The part's mesh for the gouge check: in model coordinates with the setup's `frame` (the worker
   * takes it to machine coordinates), or in machine coordinates without one.
   */
  readonly part?: { readonly mesh: Mesh; readonly frame?: WcsFrame };
  readonly options?: SimulationOptions;
}

export interface CamSimulateProgramRequest {
  generation: number;
  /** Names the program; the caller makes a new id for every new program. */
  programId: string;
  /** The program; needed when the worker does not hold `programId`. */
  program?: CamSimProgram;
  /** Simulate up to this many moves done; default the whole program. */
  upTo?: number;
  /** Return the comparison's per-cell classes (with a part); default true. */
  classes?: boolean;
}

/** The simulation at some move, as the worker returns it. */
export interface CamSimFrame {
  readonly programId: string;
  /** The material top: a copy, transferred. */
  readonly heightmap: Heightmap;
  /** Per cell, a `SIM_CLASS`; with a part and `classes` not false. A copy, transferred. */
  readonly classes?: Uint8Array;
  readonly report: SimReport;
}

export type CamSimulateProgramReply =
  | { status: 'done'; generation: number; frame: CamSimFrame; ms: number }
  | { status: 'needs-program'; generation: number; programId: string }
  | { status: 'cancelled'; generation: number }
  | { status: 'failed'; generation: number; code: string; message: string };

/** What the session returns to the worker for one request. */
export type SessionOutcome =
  | { readonly ok: true; readonly frame: CamSimFrame }
  | { readonly ok: false; readonly needsProgram: true }
  | {
      readonly ok: false;
      readonly needsProgram?: false;
      readonly error: { readonly code: string; readonly message: string };
    };

/** The buffers of a frame to transfer. */
export function frameTransferables(frame: CamSimFrame): ArrayBuffer[] {
  const out = [frame.heightmap.heights.buffer as ArrayBuffer];
  if (frame.classes) out.push(frame.classes.buffer as ArrayBuffer);
  return out;
}

/** One loaded program and its simulation. */
export class SimulationSession {
  private programId: string | null = null;
  private sim: MaterialSimulation | null = null;

  /** The id of the program held, or null. */
  get loaded(): string | null {
    return this.programId;
  }

  /** Load (when the request carries a program) and simulate up to `upTo`. Throws `CamCancelled`. */
  async run(
    request: Omit<CamSimulateProgramRequest, 'generation'>,
    context: Pick<WorkContext, 'checkpoint'>,
  ): Promise<SessionOutcome> {
    if (request.program) {
      // Let the old simulation go before the new one is built: two grids and their snapshots at
      // once would double the peak memory of a reload.
      this.clear();
      const loaded = load(request.program);
      if (!loaded.ok) return loaded;
      this.sim = loaded.sim;
      this.programId = request.programId;
    } else if (this.programId !== request.programId || !this.sim) {
      return { ok: false, needsProgram: true };
    }
    const sim = this.sim;
    await sim.advance(request.upTo ?? sim.moveCount, () => context.checkpoint());
    const comparison = sim.compare();
    return {
      ok: true,
      frame: {
        programId: request.programId,
        heightmap: {
          origin: [sim.grid.x0, sim.grid.y0],
          cell: sim.grid.cell,
          nx: sim.grid.nx,
          ny: sim.grid.ny,
          heights: sim.heights.slice(),
        },
        ...(comparison && request.classes !== false ? { classes: comparison.classes } : {}),
        report: sim.report(comparison),
      },
    };
  }

  /** Forget the program. */
  clear(): void {
    this.programId = null;
    this.sim = null;
  }
}

function load(
  program: CamSimProgram,
): { ok: true; sim: MaterialSimulation } | { ok: false; error: { code: string; message: string } } {
  let toolpath;
  try {
    toolpath = unpackToolpath(program.toolpath);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'invalid-input',
        message: `The program cannot be read: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }
  const part = program.part
    ? program.part.frame
      ? meshToMachine(program.part.mesh, program.part.frame)
      : program.part.mesh
    : undefined;
  const r = MaterialSimulation.create(
    { toolpath, tools: program.tools, stock: program.stock, ...(part ? { part } : {}) },
    program.options,
  );
  return r.ok ? { ok: true, sim: r.value } : { ok: false, error: r.error };
}

/**
 * The `Simulator` for `CamWorkerApi.simulate`: cached toolpaths in order, each cut by its own
 * tool, on a heightfield of `input.cell` mm over the stock. Never mutates the cached toolpaths.
 */
export async function simulateHeightmap(
  input: SimulationInput,
  context: WorkContext,
): Promise<SimulationOutcome> {
  // Between toolpaths the tool rises above the stock, crosses and comes down to the next start:
  // links that touch nothing.
  const above = input.stock.max[2] + 1;
  const entries: IrEntry[] = [];
  let start: Vec3 | null = null;
  let pos: Vec3 | null = null;
  for (const { tool, toolpath } of input.toolpaths) {
    const tp = unpackToolpath(toolpath);
    if (pos === null) start = tp.start;
    else {
      const high = Math.max(above, pos[2], tp.start[2]);
      for (const to of [
        [pos[0], pos[1], high],
        [tp.start[0], tp.start[1], high],
        tp.start,
      ] as Vec3[]) {
        entries.push({ kind: 'rapid', op: 'link', pass: 0, to });
      }
    }
    entries.push({ kind: 'toolChange', tool: tool.id, name: tool.name });
    pos = tp.start;
    for (const e of tp.entries) {
      entries.push(e);
      if (isMove(e)) pos = e.to;
    }
  }
  const created = MaterialSimulation.create(
    {
      toolpath: { start: start ?? [0, 0, above], entries },
      tools: input.toolpaths.map((t) => t.tool),
      stock: input.stock,
    },
    { cell: input.cell, snapshotBytes: 0 },
  );
  if (!created.ok) return { ok: false, error: created.error };
  const sim = created.value;
  await sim.advance(sim.moveCount, () => context.checkpoint());
  return {
    ok: true,
    heightmap: {
      origin: [sim.grid.x0, sim.grid.y0],
      cell: sim.grid.cell,
      nx: sim.grid.nx,
      ny: sim.grid.ny,
      heights: sim.heights,
    },
  };
}
