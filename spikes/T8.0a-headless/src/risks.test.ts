// What a Node host has to inject, shown by leaving each one out: a regen engine built with regen's
// defaults (as a host that copied the browser worker's setup without its asset URLs would get) on
// the engraved bracket and the bookshelf. Writes results/risks.json.

import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../../packages/core/src/index';
import { createNodeService } from '../../../packages/kernel/src/node';
import { RegenEngine } from '../../../packages/regen/src/engine';
import { createTextOutliner } from '../../../packages/regen/src/text-engine';
import { createSolverService } from '../../../packages/sketch/src/index';
import { bookshelfDocument, bracketDocument, engraveBatch } from './fixtures';
import { nodeExtensions } from './host';
import { writeResult } from './results';

const out: Record<string, unknown> = {};

const engraved = () => {
  const r = applyCommand(bracketDocument(), engraveBatch('MFK-1').command);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.document;
};

describe('what a Node host must inject', () => {
  it('the bundled font: regen default text outliner fetches a file: URL', async () => {
    const service = await createNodeService();
    const engine = new RegenEngine({
      kernel: service,
      solver: createSolverService(),
      text: createTextOutliner(),
    });
    const r = (await engine.regen(engraved()))!;
    const sketch = r.parts[0]!.features.find((f) => f.featureId === 'sketch#3')!;
    out.textWithoutFetchImpl = { status: sketch.status, errors: sketch.errors };
    expect(sketch.status).not.toBe('ok');
    await engine.dispose();
  });

  it('the domains: regen default registry is empty until a host fills it', async () => {
    const service = await createNodeService();
    const engine = new RegenEngine({ kernel: service, solver: createSolverService() });
    const r = (await engine.regen(bookshelfDocument()))!;
    const failed = r.parts[0]!.features.filter((f) => f.status !== 'ok');
    out.domainsWithoutRegistration = {
      failed: failed.length,
      first: failed[0] ? { id: failed[0].featureId, errors: failed[0].errors } : null,
    };
    expect(failed.length).toBeGreaterThan(0);
    await engine.dispose();
    // With the host's registry, the same document builds.
    const ok = new RegenEngine({
      kernel: service,
      solver: createSolverService(),
      extensions: nodeExtensions(),
    });
    const r2 = (await ok.regen(bookshelfDocument()))!;
    expect(r2.parts[0]!.features.filter((f) => f.status !== 'ok')).toEqual([]);
    await ok.dispose();
    writeResult('risks', out);
  });
});
