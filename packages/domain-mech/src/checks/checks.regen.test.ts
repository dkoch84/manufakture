// The checks through regen with the real kernel (libcascade in Node): the mechanical domain's
// evaluation stage reports `cable.tension`'s records as the result's data, with a `mech-check`
// warning naming the missing simulation peak; and a check that asks for a body to be measured
// gets the kernel's volume back, in SI.

import { calc } from '@manufakture/calc';
import {
  applyCommand,
  createDocument,
  type Command,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';
import type { KernelService } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import { ExtensionRegistry, RegenEngine, type RegenSolver } from '@manufakture/regen';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mechDomain, MECH_IMPLEMENTATION, registerMech } from '../domain';
import { builtinRef } from '../parts/catalog';
import { placePurchasedPart } from '../parts/place';
import { createMechEvaluation, mechEvaluationOf } from './evaluation';
import { measuredMassInput } from './measured';
import { CheckRegistry } from './registry';
import type { CheckDefinition } from './types';

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

const x = (source: string): StoredExpression => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });

function apply(doc: ManufaktureDocument, ...commands: Command[]): ManufaktureDocument {
  for (const c of commands) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    doc = r.value.document;
  }
  return doc;
}

async function withEngine(
  register: (registry: ExtensionRegistry) => void,
  run: (engine: RegenEngine) => Promise<void>,
) {
  const extensions = new ExtensionRegistry();
  register(extensions);
  const engine = new RegenEngine({ kernel: service, solver: NO_SOLVER, extensions });
  try {
    await run(engine);
  } finally {
    await engine.dispose();
    await service.idle();
  }
  expect(service.leaks()).toEqual([]);
}

/** A rope with a static and a dynamic load case, a strength factor of 2, and a placed bearing. */
async function design(): Promise<{ doc: ManufaktureDocument; bearing: string }> {
  let doc = apply(
    createDocument({ id: 'doc-checks', name: 'Checks' }),
    {
      type: 'setDomainData',
      namespace: 'mech',
      schemaVersion: 1,
      data: { factors: { strength: 2 } } as never,
    },
    {
      type: 'setCatalogEntry',
      entry: {
        id: 'entry#1',
        version: 1,
        family: 'rope',
        fieldsVersion: 1,
        maker: 'Acme',
        partNumber: 'HMPE 3 mm',
        description: '',
        ratings: { minimumBreakingLoad: { value: 4500 } },
        sources: [],
        verified: false,
      },
    },
    {
      type: 'setPurchasedUse',
      use: {
        id: 'pp#2',
        entry: { source: 'document', id: 'entry#1' },
        alternates: [],
        name: 'Rope',
      },
    },
    {
      type: 'setMechLoadCase',
      loadCase: {
        id: 'lc#3',
        name: 'Hold',
        static: [{ kind: 'cable', name: 'Max pull', force: x('200 lbf'), angle: x('0 deg') }],
      },
    },
    {
      type: 'setMechLoadCase',
      loadCase: {
        id: 'lc#4',
        name: 'Rep',
        dynamic: {
          mode: { kind: 'constant' },
          force: x('400 N'),
          motion: {
            kind: 'half-cosine',
            stroke: x('1 m'),
            pullSpeed: x('1 m/s'),
            returnSpeed: x('1 m/s'),
            pause: x('0.5 s'),
          },
          reps: x('10'),
        },
      },
    },
  );
  const placed = await placePurchasedPart(doc, builtinRef('bearing/skf-6005-2rsh')!);
  if (!placed.ok) throw new Error(placed.message);
  doc = apply(doc, placed.command);
  doc = {
    ...doc,
    parts: doc.parts.map((p) => (p.id === placed.partId ? { ...p, material: 'steel' } : p)),
  };
  return { doc, bearing: placed.partId };
}

describe('the checks through regen', () => {
  it('reports cable.tension’s records and a warning naming the missing simulation peak', async () => {
    const { doc } = await design();
    await withEngine(registerMech, async (engine) => {
      const result = await engine.regen(doc);
      if (result === null) throw new Error('superseded');
      const ev = result.evaluations?.find((e) => e.namespace === 'mech');
      expect(ev?.error).toBeUndefined();
      const mech = mechEvaluationOf(result.evaluations);
      expect(mech?.checks.map((c) => [c.record.id, c.record.status])).toEqual([
        ['cable.tension@pp#2/lc#3', 'ok'],
        ['cable.tension@pp#2/lc#4', 'unknown'],
      ]);
      const hold = mech!.checks[0]!;
      expect(hold.record.result).toBeCloseTo(4500 / (200 * 4.4482216152605), 6);
      expect(hold.text).toBe(
        'Cable tension, Rope in Hold: load 890 N, rated load 4.50 kN; factor 5.06, above your 2',
      );
      expect(ev!.warnings).toEqual([
        {
          code: 'mech-check',
          message:
            'Cable tension, Rope in Rep: not computed. Missing: Peak cable tension (no simulation of lc#4 has run)',
          check: 'cable.tension',
          recordId: 'cable.tension@pp#2/lc#4',
          status: 'unknown',
        },
      ]);
    });
  }, 60_000);

  it('measures the bodies a check asks for with the kernel, and reads them in SI', async () => {
    const { doc, bearing } = await design();
    const mass: CheckDefinition = {
      id: 'test.mass',
      title: 'Mass',
      version: 1,
      measures: () => [{ part: bearing, body: 'extension#1' }],
      subjects: (model) => [
        {
          location: bearing,
          title: 'Mass of the bearing',
          subject: [{ kind: 'part', part: bearing }],
          inputs: { m: measuredMassInput(model, bearing, 'extension#1') },
        },
      ],
      compute: ({ inputs, options }) =>
        calc(
          {
            id: 'test.mass',
            title: 'Mass',
            method: 'Measured volume times density',
            formula: 'm = ρ V',
            unit: 'kg',
            sources: [{ title: 'test', locator: '-' }],
            inputs: { m: { name: 'Mass', symbol: 'm', unit: 'kg' } },
          },
          { m: inputs.m },
          options,
          (v) => ({ result: v.m }),
        ),
    };
    const registry = new CheckRegistry();
    registry.register(mass);
    await withEngine(
      (r) =>
        r.registerDomain({
          ...mechDomain,
          evaluation: createMechEvaluation({ registry, implementation: MECH_IMPLEMENTATION }),
        }),
      async (engine) => {
        const result = await engine.regen(doc);
        if (result === null) throw new Error('superseded');
        const record = mechEvaluationOf(result.evaluations)!.checks[0]!.record;
        const volume = (Math.PI / 4) * (47 ** 2 - 25 ** 2) * 12 * 1e-9;
        expect(record.status).toBe('ok');
        expect(record.result).toBeCloseTo(volume * 7850, 4);
      },
    );
  }, 60_000);
});
