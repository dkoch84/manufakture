// The drivetrain through regen with the real kernel (libcascade in Node): the evaluation stage asks
// for the bodies a stage's instance shows, the kernel measures them, and the inertia reflected to
// the motor comes back in the result's data, against the closed form of a tube (a placed bearing
// placeholder, 47 x 25 x 12 mm, steel). A stage naming a missing instance is a `mech-reference`
// warning on the drivetrain.

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
import { mechEvaluationOf } from '../checks/evaluation';
import { registerMech } from '../domain';
import { builtinRef } from '../parts/catalog';
import { placePurchasedPart } from '../parts/place';

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

describe('the drivetrain through regen', () => {
  it('measures a stage’s instance with the kernel and warns on a missing one', async () => {
    let doc = apply(
      createDocument({ id: 'doc-drive', name: 'Drive' }),
      {
        type: 'setCatalogEntry',
        entry: {
          id: 'entry#1',
          version: 1,
          family: 'motor',
          fieldsVersion: 1,
          maker: 'Acme',
          partNumber: 'BLDC 80',
          description: '',
          ratings: { rotorInertia: { value: 3.0e-4 } },
          sources: [],
          verified: false,
        },
      },
      {
        type: 'setPurchasedUse',
        use: { id: 'pp#2', entry: { source: 'document', id: 'entry#1' }, alternates: [] },
      },
      { type: 'addAssembly', assemblyId: 'assembly#1', name: 'Drive' },
    );
    const placed = await placePurchasedPart(doc, builtinRef('bearing/skf-6005-2rsh')!, {
      assemblyId: 'assembly#1',
    });
    if (!placed.ok) throw new Error(placed.message);
    doc = apply(doc, placed.command);
    doc = {
      ...doc,
      parts: doc.parts.map((p) => (p.id === placed.partId ? { ...p, material: 'steel' } : p)),
    };
    doc = apply(doc, {
      type: 'setDrivetrain',
      drivetrain: {
        id: 'drive#3',
        name: 'Main',
        assembly: 'assembly#1',
        stages: [
          { id: 'stage#4', kind: 'motor', use: 'pp#2' },
          {
            id: 'stage#5',
            kind: 'belt',
            ratio: x('2'),
            efficiency: x('1'),
          },
          { id: 'stage#6', kind: 'coupling', instance: placed.instanceId! },
          { id: 'stage#7', kind: 'shaft', instance: 'inst#99', bearings: [] },
        ],
        output: { kind: 'rotary' },
      },
    });

    const extensions = new ExtensionRegistry();
    registerMech(extensions);
    const engine = new RegenEngine({ kernel: service, solver: NO_SOLVER, extensions });
    try {
      const result = await engine.regen(doc);
      if (result === null) throw new Error('superseded');
      const ev = result.evaluations?.find((e) => e.namespace === 'mech');
      expect(ev?.error).toBeUndefined();
      expect(ev!.warnings).toEqual([
        {
          code: 'mech-reference',
          message:
            'Drivetrain Main (drive#3): stages.3.instance: names instance inst#99, which Drive does not have',
          objectId: 'drive#3',
          target: 'inst#99',
        },
      ]);
      const a = mechEvaluationOf(result.evaluations)!.drivetrains![0]!;
      // The tube about its axis: m (ro² + ri²) / 2, m = ρ π (ro² - ri²) h.
      const ro = 0.0235;
      const ri = 0.0125;
      const m = 7850 * Math.PI * (ro ** 2 - ri ** 2) * 0.012;
      const j = (m * (ro ** 2 + ri ** 2)) / 2;
      const coupling = a.elements.find((e) => e.at === 'stage#6')!;
      expect(coupling.source).toBe('measured');
      expect(coupling.n).toBe(2);
      expect(coupling.value! / j).toBeCloseTo(1, 4);
      // The shaft names a missing instance: the inertia record is unknown and says why.
      const inertia = a.records.find((r) => r.check === 'drivetrain.inertia')!;
      expect(inertia.status).toBe('unknown');
      expect(inertia.note).toMatch(/assembly#1 has no instance inst#99/);

      // Without the missing stage: J_motor = 3.0e-4 + J_tube / 2².
      const fixed = apply(doc, {
        type: 'setDrivetrain',
        drivetrain: {
          ...doc.mech!.drivetrains![0]!,
          stages: doc.mech!.drivetrains![0]!.stages.slice(0, 3),
        },
      });
      const again = await engine.regen(fixed);
      if (again === null) throw new Error('superseded');
      const b = mechEvaluationOf(again.evaluations)!.drivetrains![0]!;
      expect(b.inertiaAtMotor! / (3.0e-4 + j / 4)).toBeCloseTo(1, 4);
      expect(again.evaluations?.find((e) => e.namespace === 'mech')!.warnings).toEqual([]);
    } finally {
      await engine.dispose();
      await service.idle();
    }
    expect(service.leaks()).toEqual([]);
  }, 60_000);
});
