// Benchmark cases shared by the page, the measurement script and the test.

import type { PipelineOptions } from './pipeline.ts';

export type CaseName = 'box' | 'bracket' | 'bracketFine';

export const CASES: Record<CaseName, Omit<PipelineOptions, 'parallel' | 'memory'>> = {
  /** 40x30x20 box, all 12 edges filleted, 0.1 mm mesh deflection. */
  box: { part: 'box', filletRadius: 2, linearDeflection: 0.1, angularDeflection: 0.5 },
  /** L bracket with 6 holes, 30 edges filleted, 0.1 mm mesh deflection. */
  bracket: { part: 'bracket', filletRadius: 1.5, linearDeflection: 0.1, angularDeflection: 0.5 },
  /** Same bracket meshed 10x finer, to load the mesher. */
  bracketFine: {
    part: 'bracket',
    filletRadius: 1.5,
    linearDeflection: 0.01,
    angularDeflection: 0.1,
  },
};
