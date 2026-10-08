// A complete regen of a document on a fresh engine in Node, summarized (summary.ts): what the
// browser half and the reopen check compare against.

import type { ManufaktureDocument } from '../../../packages/core/src/index';
import type { KernelService } from '../../../packages/kernel/src/index';
import { RegenEngine } from '../../../packages/regen/src/engine';
import type { RegenSolver } from '../../../packages/regen/src/sketches';
import type { NodeHost } from './host';
import { summarize, type BodyMeasureLike, type Summary } from './summary';

export function measurer(service: KernelService, generation: () => number) {
  return async (shape: number): Promise<BodyMeasureLike | null> => {
    const reply = await service.run({
      generation: generation(),
      ops: [{ op: 'measure', shape: shape as never, targets: [], body: true }],
    });
    const r = reply.results[0];
    if (!r?.ok) throw new Error(`measure failed: ${JSON.stringify(r)}`);
    return (r.value as { body: BodyMeasureLike | null }).body;
  };
}

export async function nodeSummary(
  host: Pick<NodeHost, 'service' | 'text' | 'extensions'> & { solver: RegenSolver },
  doc: ManufaktureDocument,
): Promise<{ summary: Summary; regenMs: number }> {
  const engine = new RegenEngine({
    kernel: host.service,
    solver: host.solver,
    text: host.text,
    extensions: host.extensions,
  });
  try {
    const s = host.service.stats();
    const generation = Math.max(engine.generation, s.generation, s.cancelledThrough) + 1;
    const t = performance.now();
    const result = await engine.regen(doc, { generation });
    const regenMs = performance.now() - t;
    if (result === null) throw new Error('superseded');
    const summary = await summarize(
      result,
      measurer(host.service, () => engine.generation),
    );
    return { summary, regenMs };
  } finally {
    await engine.dispose();
  }
}
