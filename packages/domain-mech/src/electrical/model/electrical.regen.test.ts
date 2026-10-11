// The electrical system through regen with the real kernel (libcascade in Node): the mechanical
// domain's evaluation stage reports the system read into a model as the result's data, and a
// `mech-reference` warning for each instance or purchased part it names that is not there, which
// is what an agent's `get_errors` lists.

import {
  applyCommand,
  createDocument,
  type Command,
  type ManufaktureDocument,
} from '@manufakture/core';
import type { KernelService } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import { ExtensionRegistry, RegenEngine, type RegenSolver } from '@manufakture/regen';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mechEvaluationOf } from '../../checks/evaluation';
import { registerMech } from '../../domain';

let service: KernelService;

beforeAll(async () => {
  service = await createNodeService();
}, 60_000);

afterAll(async () => {
  await service.idle();
});

const NO_SOLVER = {
  solve: () => {
    throw new Error('no sketches in these tests');
  },
} as unknown as RegenSolver;

function apply(doc: ManufaktureDocument, ...commands: Command[]): ManufaktureDocument {
  for (const c of commands) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    doc = r.value.document;
  }
  return doc;
}

/** A pack placed on an instance the assembly lacks, using a purchased part the design lacks. */
function design(): ManufaktureDocument {
  return apply(
    createDocument({ id: 'doc-electrical', name: 'Electrical' }),
    { type: 'addAssembly', assemblyId: 'assembly#1', name: 'Trainer' },
    {
      type: 'setElectrical',
      electrical: {
        assembly: 'assembly#1',
        components: [
          { id: 'el#1', name: 'Pack', role: 'pack', use: 'pp#9', instance: 'inst#9' },
          { id: 'el#2', name: 'Fuse', role: 'fuse' },
        ],
        connections: [
          {
            id: 'conn#1',
            from: { component: 'el#1', terminal: '+' },
            to: { component: 'el#2', terminal: '1' },
          },
        ],
        harness: [],
      },
    },
  );
}

describe('the electrical system through regen', () => {
  it('reports its model, and a mech-reference warning for each missing part and instance', async () => {
    const extensions = new ExtensionRegistry();
    registerMech(extensions);
    const engine = new RegenEngine({ kernel: service, solver: NO_SOLVER, extensions });
    try {
      const result = await engine.regen(design());
      if (result === null) throw new Error('superseded');
      const ev = result.evaluations?.find((e) => e.namespace === 'mech');
      expect(ev?.error).toBeUndefined();
      expect(ev!.warnings).toEqual([
        {
          code: 'mech-reference',
          message:
            'Electrical system, el#1: components.0.use: names purchased part pp#9, which the design does not have',
          objectId: 'el#1',
          target: 'pp#9',
        },
        {
          code: 'mech-reference',
          message:
            'Electrical system, el#1: components.0.instance: names instance inst#9, which Trainer does not have',
          objectId: 'el#1',
          target: 'inst#9',
        },
      ]);
      // Unconnected terminals are in the model, not among the warnings.
      const electrical = mechEvaluationOf(result.evaluations)?.electrical;
      expect(electrical?.components.map((c) => c.id)).toEqual(['el#1', 'el#2']);
      expect(
        electrical?.problems.filter((p) => p.kind === 'dangling').map((p) => p.target),
      ).toEqual(['el#1/-', 'el#2/2']);
    } finally {
      await engine.dispose();
      await service.idle();
    }
    expect(service.leaks()).toEqual([]);
  }, 60_000);
});
