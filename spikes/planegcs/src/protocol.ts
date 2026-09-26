// Messages between the page and the solver worker. Plain postMessage (no
// Comlink) so the measured round trip is the platform's, not a library's.

import type { DragSpec, SetupResult } from './bench.ts';
import type { StatusName } from './solver.ts';

export type Request =
  | { type: 'init'; memoryPages: number }
  | { type: 'setup'; spec: DragSpec }
  | { type: 'move'; i: number }
  | { type: 'ping' };

export type Response =
  | { type: 'init'; initMs: number }
  | { type: 'setup'; setup: SetupResult }
  | {
      type: 'move';
      status: StatusName;
      solveMs: number;
      moveMs: number;
      errorMm: number;
      /** Every solver parameter after the solve; transferred, not copied. */
      params: Float64Array;
    }
  | { type: 'ping' }
  | { type: 'error'; message: string };
