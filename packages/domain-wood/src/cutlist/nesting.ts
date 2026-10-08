// Running a nesting job (M4 plan T4.3d; moved from the app in M8 plan T8.1b): every sheet layout
// and lumber plan of a cut list, one attempt per step, cancellable, with progress over the whole
// job. The app's nesting worker runs it, and so do Node callers and the tests, in-process. Imports
// only `@manufakture/nesting`, so the worker's bundle stays small: the worker loads it through the
// `@manufakture/domain-wood/nesting` subpath, not the package root.

import {
  layoutSheetsSteps,
  layoutSticksSteps,
  type Progress,
  type SheetInput,
  type SheetLayoutResult,
  type StickInput,
  type StickLayoutResult,
} from '@manufakture/nesting';

export interface SheetJob {
  stock: string;
  name: string;
  thickness: number;
  input: SheetInput;
}

export interface StickJob {
  stock: string;
  name: string;
  input: StickInput;
}

/** Why a stock or a part has no layout. */
export interface LayoutNote {
  stock: string;
  /** The cut list row key, when the note is about one row. */
  row?: string;
  message: string;
}

export interface NestingJob {
  sheets: SheetJob[];
  sticks: StickJob[];
  /** What is left out of the layouts, and why. */
  notes: LayoutNote[];
}

export interface NestingResult {
  sheets: { stock: string; name: string; thickness: number; result: SheetLayoutResult }[];
  sticks: { stock: string; name: string; result: StickLayoutResult }[];
  notes: LayoutNote[];
}

/** Attempts finished and planned over the whole job. */
export interface JobProgress {
  done: number;
  total: number;
}

/**
 * Runs every layout of the job, one attempt per step, yielding to the event loop between steps
 * so a cancel (the signal) is seen. Rejects with the signal's reason when aborted. A layout that
 * throws (a RangeError for a bad input) rejects the run.
 */
export async function runNesting(
  job: NestingJob,
  options: { signal?: AbortSignal; onProgress?: (p: JobProgress) => void } = {},
): Promise<NestingResult> {
  const result: NestingResult = { sheets: [], sticks: [], notes: [...job.notes] };
  const runs: { steps: Generator<Progress, unknown, void>; total: number; done: number }[] = [
    ...job.sheets.map((j) => ({ steps: layoutSheetsSteps(j.input), total: 1, done: 0 })),
    ...job.sticks.map((j) => ({ steps: layoutSticksSteps(j.input), total: 1, done: 0 })),
  ];
  const report = () =>
    options.onProgress?.({
      done: runs.reduce((a, r) => a + r.done, 0),
      total: runs.reduce((a, r) => a + r.total, 0),
    });
  const outputs: unknown[] = [];
  // Yield once first, so a cancel sent right after the job (a newer job) is seen before any work.
  await new Promise((resolve) => setTimeout(resolve, 0));
  let lastYield = Date.now();
  for (const run of runs) {
    for (;;) {
      options.signal?.throwIfAborted();
      const r = run.steps.next();
      if (r.done) {
        run.done = run.total;
        outputs.push(r.value);
        break;
      }
      run.done = r.value.attempt;
      run.total = r.value.total;
      // Yield about every 16 ms, not every attempt: a small attempt takes microseconds.
      if (Date.now() - lastYield > 16) {
        report();
        await new Promise((resolve) => setTimeout(resolve, 0));
        lastYield = Date.now();
      }
    }
  }
  options.signal?.throwIfAborted();
  report();
  job.sheets.forEach((j, i) =>
    result.sheets.push({
      stock: j.stock,
      name: j.name,
      thickness: j.thickness,
      result: outputs[i] as SheetLayoutResult,
    }),
  );
  job.sticks.forEach((j, i) =>
    result.sticks.push({
      stock: j.stock,
      name: j.name,
      result: outputs[job.sheets.length + i] as StickLayoutResult,
    }),
  );
  return result;
}
