// The sketch's constraint state for the status bar, the DOF colouring and
// the conflict explanation.

import type { EntityStatus, SketchConstraint } from '@manufakture/sketch/model';
import type { SolveInfo } from './session';

export type SketchStatusKind =
  'solving' | 'under' | 'fully' | 'conflict' | 'invalid' | 'failed' | 'error';

export interface SketchStatus {
  kind: SketchStatusKind;
  /** Remaining degrees of freedom, when known. */
  dof: number | null;
  text: string;
  redundant: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function describeStatus(solve: SolveInfo | null, solverError: string | null): SketchStatus {
  if (solverError !== null) {
    return { kind: 'error', dof: null, text: `The solver failed: ${solverError}`, redundant: 0 };
  }
  if (!solve) return { kind: 'solving', dof: null, text: 'Solving', redundant: 0 };
  const d = solve.diagnosis;
  const redundant = d.redundant.length;
  switch (solve.status) {
    case 'aborted':
      return { kind: 'error', dof: null, text: solve.message ?? 'The solver stopped.', redundant };
    case 'invalid':
      return {
        kind: 'invalid',
        dof: null,
        text: solve.issues[0]?.message ?? solve.message ?? 'The sketch has a problem.',
        redundant,
      };
    default:
      break;
  }
  if (solve.status === 'conflicting' || d.conflicting.length > 0) {
    return {
      kind: 'conflict',
      dof: null,
      text: `Over-constrained: ${plural(d.conflicting.length, 'constraint conflicts', 'constraints conflict')}`,
      redundant,
    };
  }
  if (solve.status === 'failed') {
    return { kind: 'failed', dof: d.dof, text: 'The sketch did not solve', redundant };
  }
  const extra =
    redundant > 0 ? `, ${plural(redundant, 'redundant constraint', 'redundant constraints')}` : '';
  if (d.dof === 0) return { kind: 'fully', dof: 0, text: `Fully constrained${extra}`, redundant };
  const dof = d.dof ?? 0;
  return {
    kind: 'under',
    dof,
    text: `${plural(dof, 'degree of freedom', 'degrees of freedom')} left${extra}`,
    redundant,
  };
}

/** How to colour an entity: blue while it can move, foreground when fixed, red when over. */
export function entityStatus(solve: SolveInfo | null, id: string): EntityStatus {
  return solve?.diagnosis.entities[id] ?? 'under';
}

/** How a constraint takes part in the diagnosis. */
export function constraintState(
  solve: SolveInfo | null,
  id: string,
): 'ok' | 'conflicting' | 'redundant' {
  if (!solve) return 'ok';
  if (solve.diagnosis.conflicting.includes(id)) return 'conflicting';
  if (solve.diagnosis.redundant.includes(id)) return 'redundant';
  return 'ok';
}

/**
 * The conflicting constraints with the one to blame first: the newest one the
 * last edit added, else the newest in creation order (ADR 0003, decision 7).
 */
export function conflictBlame(
  conflicting: readonly string[],
  constraints: readonly SketchConstraint[],
  lastAdded: readonly string[],
): { blamed: string | null; others: string[] } {
  if (conflicting.length === 0) return { blamed: null, others: [] };
  const order = new Map(constraints.map((c, i) => [c.id, i]));
  const sorted = [...conflicting].sort((a, b) => (order.get(a) ?? -1) - (order.get(b) ?? -1));
  const fresh = sorted.filter((id) => lastAdded.includes(id));
  const blamed = fresh.at(-1) ?? sorted.at(-1)!;
  return { blamed, others: sorted.filter((id) => id !== blamed) };
}
