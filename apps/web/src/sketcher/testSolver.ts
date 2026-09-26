// A stand-in solver for component tests: it answers every update at once
// with the input geometry and whatever diagnosis the test sets. The session
// logic itself is tested against the real solver (session.test.ts).

import type { SketchSolverApi } from '@manufakture/sketch';
import type { Diagnosis, SketchInput, SolveResult } from '@manufakture/sketch/model';
import { vi } from 'vitest';

export function immediateSolver(diagnosis: Partial<Diagnosis> = {}) {
  const state = {
    diagnosis: {
      dof: 0,
      conflicting: [],
      redundant: [],
      partiallyRedundant: [],
      entities: {},
      ...diagnosis,
    } as Diagnosis,
  };
  const result = (sketch: SketchInput): SolveResult => ({
    status: state.diagnosis.conflicting.length > 0 ? 'conflicting' : 'solved',
    entities: [...sketch.entities],
    diagnosis: state.diagnosis,
    issues: [],
  });
  const solver = {
    solve: vi.fn(async (sketch: SketchInput) => result(sketch)),
    update: vi.fn(async (_id: string, sketch: SketchInput) => result(sketch)),
    dragStart: vi.fn(async () => {}),
    dragMove: vi.fn(async () => null),
    dragEnd: vi.fn(async () => result({ entities: [], constraints: [] })),
    close: vi.fn(async () => {}),
  } satisfies SketchSolverApi;
  return {
    solver,
    setDiagnosis(d: Partial<Diagnosis>) {
      state.diagnosis = { ...state.diagnosis, ...d };
    },
  };
}
