// The material-removal simulation of one program (M5 plan, T5.3c): a heightfield over the stock
// (`heightfield.ts`) lowered move by move by the tool loaded at the time, rapids checked against the
// material left at that moment, and the result compared with the part's own heightmap (`part.ts`).
//
// It is incremental, for the preview's playback: `runTo(n)` simulates up to move n (n moves done,
// numbered in program order as the preview numbers them: rapids, lines and arcs, nothing else),
// carrying on from where it stands. Going back restores the nearest snapshot at or before n and
// simulates forward from there; snapshots are taken at even intervals of the program, as many as
// fit in `snapshotBytes`.

import { isMove, type Move, type Toolpath } from '../ir';
import { err, ok, type Box3, type CamResult, type Mesh, type Tool, type Vec3 } from '../types';
import {
  cellX,
  cellY,
  gridFor,
  simCellSize,
  sweepMove,
  toolProfile,
  type SimGrid,
  type ToolProfile,
} from './heightfield';
import { partBands, rasterPart } from './part';

/** Default tolerance of the gouge and leftover checks, mm. */
export const SIM_TOLERANCE = 0.05;

/**
 * Chord deflection allowed for between the part's mesh and the toolpath, mm: the app meshes the part
 * at 0.004 mm and flattens curved loop edges at 0.01 mm (`CAM_MESH_DEFLECTION` and
 * `CAM_LOOP_DEFLECTION` in the regen package), so a tool that follows a curved wall exactly can
 * still overlap the mesh by up to about 0.014 mm.
 */
export const SIM_DEFLECTION = 0.02;

/** A rapid's tool is taken this much narrower for the collision check, mm (grazing a wall is fine). */
export const SIM_GRAZE = 0.05;

/** A rapid must run this far below the material to count as a collision, mm. */
export const SIM_COLLISION_TOLERANCE = 0.01;

/** Default memory for playback snapshots: 64 MiB of heights. */
export const SIM_SNAPSHOT_BYTES = 64 * 1024 * 1024;

/** The most snapshots one program keeps. */
export const SIM_MAX_SNAPSHOTS = 16;

export interface SimulationOptions {
  /** Cell size, mm; default from the smallest tool (`simCellSize`). */
  readonly cell?: number;
  /** Most cells; default `SIM_MAX_CELLS`. The cell is coarsened to fit. */
  readonly maxCells?: number;
  /** Gouge and leftover tolerance, mm; default `SIM_TOLERANCE`. */
  readonly tolerance?: number;
  /**
   * Chord deflection of the part's mesh and the toolpath, mm; default `SIM_DEFLECTION`. The
   * comparison's sideways allowance is the tolerance plus this.
   */
  readonly deflection?: number;
  /** See `SIM_GRAZE`. */
  readonly graze?: number;
  /** See `SIM_COLLISION_TOLERANCE`. */
  readonly collisionTolerance?: number;
  /** Bytes the playback snapshots may take; default `SIM_SNAPSHOT_BYTES`. */
  readonly snapshotBytes?: number;
}

export interface SimulationProgram {
  /** The program, machine coordinates. */
  readonly toolpath: Toolpath;
  /**
   * The tools its tool changes name, by id. Moves before the first tool change are cut by the
   * first tool here.
   */
  readonly tools: readonly Tool[];
  /** The stock box, machine coordinates. */
  readonly stock: Box3;
  /** The part's mesh in machine coordinates, for the gouge and leftover check; none: no check. */
  readonly part?: Mesh;
}

/** A rapid that ran through material. */
export interface SimCollision {
  /** The rapid's move index (0 is the first move). */
  readonly move: number;
  /** The worst cell's centre and the material top there, machine coordinates. */
  readonly at: Vec3;
  /** How far the tool ran below the material there, mm. */
  readonly depth: number;
}

/** The worst cell of a kind: its centre at the simulated height, and by how much. */
export interface SimWorst {
  readonly at: Vec3;
  readonly depth: number;
}

/** Cell classes of the comparison. */
export const SIM_CLASS = {
  /** No part under the cell's centre: not compared. */
  none: 0,
  /** Within the tolerance of the part. */
  ok: 1,
  /** Cut below the part's surface by more than the tolerance. */
  gouge: 2,
  /** Material left above the part's surface by more than the tolerance. */
  leftover: 3,
} as const;

export interface SimComparison {
  /** One class per cell (`SIM_CLASS`), the heights' layout. */
  readonly classes: Uint8Array;
  readonly gougeCells: number;
  readonly leftoverCells: number;
  readonly worstGouge: SimWorst | null;
  readonly worstLeftover: SimWorst | null;
}

export interface SimReport {
  readonly done: number;
  readonly moveCount: number;
  readonly cell: number;
  readonly nx: number;
  readonly ny: number;
  /** Rapids through material among the moves done, in program order. */
  readonly collisions: readonly SimCollision[];
  /** The comparison with the part, or null without a part mesh. */
  readonly gougeCells: number | null;
  readonly leftoverCells: number | null;
  readonly worstGouge: SimWorst | null;
  readonly worstLeftover: SimWorst | null;
  readonly tolerance: number;
  /**
   * The comparison's sideways allowance, mm (tolerance plus deflection): a cut within this of the
   * part's wall in XY is not a gouge, nor material within this of a wall above it a leftover.
   */
  readonly sideAllowance: number;
}

export class MaterialSimulation {
  readonly grid: SimGrid;
  readonly moveCount: number;
  readonly tolerance: number;
  /** See `SimReport.sideAllowance`. */
  readonly sideAllowance: number;
  /** The current material top per cell. Live: it changes as the simulation runs. */
  readonly heights: Float32Array;
  /** The part's top per cell (-Infinity where none), or null without a part. */
  readonly part: Float32Array | null;
  private readonly bands: { low: Float32Array; high: Float32Array } | null;
  private readonly stockTop: number;
  private readonly moves: Move[] = [];
  private readonly starts: Float64Array;
  private readonly toolOf: Int32Array;
  private readonly profiles: ToolProfile[];
  private readonly graze: number;
  /** Most Z between two stamps of a move that changes Z: half the tolerance. */
  private readonly zStep: number;
  private readonly collisionTolerance: number;
  private readonly snapshots = new Map<number, Float32Array>();
  private readonly snapshotEvery: number;
  private found: SimCollision[] = [];
  private position = 0;

  private constructor(
    program: SimulationProgram,
    profiles: ToolProfile[],
    toolIds: Map<string, number>,
    options: SimulationOptions,
  ) {
    const { toolpath, stock } = program;
    const cell = simCellSize(stock, program.tools, options);
    this.grid = gridFor(stock, cell);
    this.stockTop = stock.max[2];
    this.heights = new Float32Array(this.grid.nx * this.grid.ny).fill(this.stockTop);
    this.tolerance = options.tolerance ?? SIM_TOLERANCE;
    this.sideAllowance = this.tolerance + (options.deflection ?? SIM_DEFLECTION);
    this.graze = options.graze ?? SIM_GRAZE;
    this.zStep = Math.max(this.tolerance / 2, 1e-3);
    this.collisionTolerance = options.collisionTolerance ?? SIM_COLLISION_TOLERANCE;
    this.profiles = profiles;
    for (const e of toolpath.entries) if (isMove(e)) this.moves.push(e);
    this.moveCount = this.moves.length;
    this.starts = new Float64Array(this.moveCount * 3);
    this.toolOf = new Int32Array(this.moveCount);
    let pos = toolpath.start;
    let tool = profiles.length > 0 ? 0 : -1;
    let m = 0;
    for (const e of toolpath.entries) {
      if (e.kind === 'toolChange') tool = toolIds.get(e.tool) ?? -1;
      if (!isMove(e)) continue;
      this.starts.set(pos, m * 3);
      this.toolOf[m] = tool;
      pos = e.to;
      m++;
    }
    const bytes = this.heights.byteLength;
    const fit = Math.floor((options.snapshotBytes ?? SIM_SNAPSHOT_BYTES) / Math.max(1, bytes));
    const count = Math.min(SIM_MAX_SNAPSHOTS, fit);
    this.snapshotEvery = count > 0 ? Math.max(1, Math.ceil(this.moveCount / count)) : 0;
    if (program.part) {
      this.part = rasterPart(program.part, this.grid);
      this.bands = partBands(program.part, this.grid, this.part, this.sideAllowance);
    } else {
      this.part = null;
      this.bands = null;
    }
  }

  /** A simulation of `program`, at move 0 (the stock uncut). */
  static create(
    program: SimulationProgram,
    options: SimulationOptions = {},
  ): CamResult<MaterialSimulation> {
    const { stock } = program;
    for (let a = 0; a < 3; a++) {
      if (!(Number.isFinite(stock.min[a]) && Number.isFinite(stock.max[a]))) {
        return err('invalid-input', 'The stock box is not finite.');
      }
    }
    if (!(stock.max[0] > stock.min[0] && stock.max[1] > stock.min[1])) {
      return err('invalid-input', 'The stock has no area.');
    }
    if (options.cell !== undefined && !(options.cell > 0 && Number.isFinite(options.cell))) {
      return err('invalid-input', 'The cell size must be positive.');
    }
    for (const v of [options.tolerance, options.deflection]) {
      if (v !== undefined && !(v >= 0 && Number.isFinite(v))) {
        return err('invalid-input', 'The tolerance and deflection must be zero or more.');
      }
    }
    const profiles: ToolProfile[] = [];
    const ids = new Map<string, number>();
    for (const t of program.tools) {
      const p = toolProfile(t);
      if (!p.ok) return p;
      ids.set(t.id, profiles.length);
      profiles.push(p.value);
    }
    for (const e of program.toolpath.entries) {
      if (e.kind === 'toolChange' && !ids.has(e.tool)) {
        return err('invalid-input', `The program changes to ${e.tool}, which was not given.`);
      }
    }
    return ok(new MaterialSimulation(program, profiles, ids, options));
  }

  /** Moves simulated so far. */
  get done(): number {
    return this.position;
  }

  /** Simulate up to move `n` (clamped to the program), going back through a snapshot if needed. */
  runTo(n: number): void {
    const target = this.rewind(n);
    while (this.position < target) this.step();
  }

  /**
   * As `runTo`, calling `checkpoint` every few moves (the CAM worker's, which yields and throws
   * `CamCancelled` when superseded). A cancelled run stops between two moves: the state stays
   * consistent at the moves done so far, and the next call carries on from there.
   */
  async advance(n: number, checkpoint: () => Promise<void>, every = 32): Promise<void> {
    const target = this.rewind(n);
    let k = 0;
    while (this.position < target) {
      if (k++ % every === 0) await checkpoint();
      this.step();
    }
  }

  /** Rapids through material among the moves done. */
  collisions(): readonly SimCollision[] {
    return this.found;
  }

  /** The comparison with the part at the moves done, or null without a part. */
  compare(): SimComparison | null {
    if (!this.bands || !this.part) return null;
    const { low, high } = this.bands;
    const h = this.heights;
    const tol = this.tolerance;
    const classes = new Uint8Array(h.length);
    let gougeCells = 0;
    let leftoverCells = 0;
    let gouge = { k: -1, depth: 0 };
    let leftover = { k: -1, depth: 0 };
    for (let k = 0; k < h.length; k++) {
      const p = this.part[k]!;
      if (p === -Infinity) continue;
      const below = low[k]! - h[k]!;
      const above = h[k]! - high[k]!;
      if (below > tol) {
        classes[k] = SIM_CLASS.gouge;
        gougeCells++;
        if (below > gouge.depth) gouge = { k, depth: below };
      } else if (above > tol) {
        classes[k] = SIM_CLASS.leftover;
        leftoverCells++;
        if (above > leftover.depth) leftover = { k, depth: above };
      } else {
        classes[k] = SIM_CLASS.ok;
      }
    }
    const worst = (w: { k: number; depth: number }): SimWorst | null =>
      w.k < 0 ? null : { at: this.cellPoint(w.k), depth: w.depth };
    return {
      classes,
      gougeCells,
      leftoverCells,
      worstGouge: worst(gouge),
      worstLeftover: worst(leftover),
    };
  }

  /** The report at the moves done; pass the comparison when already computed. */
  report(comparison: SimComparison | null = this.compare()): SimReport {
    return {
      done: this.position,
      moveCount: this.moveCount,
      cell: this.grid.cell,
      nx: this.grid.nx,
      ny: this.grid.ny,
      collisions: [...this.found],
      gougeCells: comparison?.gougeCells ?? null,
      leftoverCells: comparison?.leftoverCells ?? null,
      worstGouge: comparison?.worstGouge ?? null,
      worstLeftover: comparison?.worstLeftover ?? null,
      tolerance: this.tolerance,
      sideAllowance: this.sideAllowance,
    };
  }

  /** The material top at the centre of the cell holding (x, y), or NaN outside the stock. */
  heightAt(x: number, y: number): number {
    const k = this.cellAt(x, y);
    return k < 0 ? NaN : this.heights[k]!;
  }

  /** The index of the cell holding (x, y), or -1 outside the grid. */
  cellAt(x: number, y: number): number {
    const g = this.grid;
    const i = Math.floor((x - g.x0) / g.cell);
    const j = Math.floor((y - g.y0) / g.cell);
    if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return -1;
    return j * g.nx + i;
  }

  private cellPoint(k: number): Vec3 {
    const i = k % this.grid.nx;
    const j = (k - i) / this.grid.nx;
    return [cellX(this.grid, i), cellY(this.grid, j), this.heights[k]!];
  }

  /** Go back to the snapshot at or before `n` when `n` is behind; returns the clamped target. */
  private rewind(n: number): number {
    const target = Math.min(Math.max(Math.round(n), 0), this.moveCount);
    if (target >= this.position) return target;
    let best = 0;
    for (const s of this.snapshots.keys()) if (s <= target && s > best) best = s;
    const snap = this.snapshots.get(best);
    if (snap) this.heights.set(snap);
    else this.heights.fill(this.stockTop);
    this.position = best;
    this.found = this.found.filter((c) => c.move < best);
    return target;
  }

  /** Simulate the next move. */
  private step(): void {
    const m = this.position;
    const move = this.moves[m]!;
    const t = this.toolOf[m]!;
    const s = this.starts;
    const from: Vec3 = [s[m * 3]!, s[m * 3 + 1]!, s[m * 3 + 2]!];
    const tool = t >= 0 ? this.profiles[t] : undefined;
    if (tool) {
      const h = this.heights;
      if (move.kind === 'rapid') {
        let worstK = -1;
        let worst = this.collisionTolerance;
        // Narrower by the graze, but never below half the tool: a 0.1 mm engraver is still checked.
        const reach = Math.max(tool.radius - this.graze, tool.radius / 2);
        sweepMove(this.grid, from, move, tool, reach, this.zStep, (k, z) => {
          const d = h[k]! - z;
          if (d > worst) {
            worst = d;
            worstK = k;
          }
        });
        if (worstK >= 0) {
          this.found.push({ move: m, at: this.cellPoint(worstK), depth: worst });
        }
      }
      sweepMove(this.grid, from, move, tool, tool.radius, this.zStep, (k, z) => {
        if (z < h[k]!) h[k] = z;
      });
    }
    this.position = m + 1;
    if (
      this.snapshotEvery > 0 &&
      this.position % this.snapshotEvery === 0 &&
      !this.snapshots.has(this.position)
    ) {
      this.snapshots.set(this.position, this.heights.slice());
    }
  }
}
