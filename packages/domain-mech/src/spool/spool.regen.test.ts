// The spool through regen with the real kernel (libcascade in Node): with no flange diameter
// typed, the evaluation stage asks for the spool body, the kernel measures its bounding box, and
// the spool reads its outside diameter from it. The "spool" here is a placed bearing placeholder,
// a tube 47 mm across and 12 mm long, so the flange read is 47 mm.

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
import { SPOOL_FLANGE_CLEARANCE, SPOOL_LAYERS } from './records';

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

describe('the spool through regen', () => {
  it('reads the flange diameter from the body’s bounding box', async () => {
    let doc = apply(
      createDocument({ id: 'doc-spool', name: 'Spool' }),
      {
        type: 'setPurchasedUse',
        use: {
          id: 'pp#1',
          entry: builtinRef('rope/samson-amsteel-blue-3mm')!,
          alternates: [],
        },
      },
      { type: 'addAssembly', assemblyId: 'assembly#2', name: 'Spool' },
    );
    const placed = await placePurchasedPart(doc, builtinRef('bearing/skf-6005-2rsh')!, {
      assemblyId: 'assembly#2',
    });
    if (!placed.ok) throw new Error(placed.message);
    doc = apply(doc, placed.command);
    doc = apply(doc, {
      type: 'setDrivetrain',
      drivetrain: {
        id: 'drive#9',
        name: 'Winch',
        assembly: 'assembly#2',
        stages: [],
        output: {
          kind: 'spool',
          instance: placed.instanceId!,
          cable: 'pp#1',
          length: x('1 m'),
          core: x('30 mm'),
          width: x('9 mm'),
          inertia: x('1e-5 kg*m^2'),
        },
      },
    });

    const extensions = new ExtensionRegistry();
    registerMech(extensions);
    const engine = new RegenEngine({ kernel: service, solver: NO_SOLVER, extensions });
    try {
      const result = await engine.regen(doc);
      if (result === null) throw new Error('superseded');
      const s = mechEvaluationOf(result.evaluations)!.drivetrains![0]!.spool!;
      expect(s.box?.outerDiameter).toBeCloseTo(0.047, 6);
      expect(s.box?.overallLength).toBeCloseTo(0.012, 6);
      expect(s.flange.source).toBe('measured');
      // 1 m of 3 mm on a 30 mm core, 3 turns a layer: r_1 = 16.5 mm holds 3 · 2π · 0.0165 =
      // 0.311 m, r_2 = 19.5 mm 0.368 m (0.679 m), r_3 = 22.5 mm 0.424 m (1.103 m): 3 layers.
      expect(s.records.find((r) => r.check === SPOOL_LAYERS)?.result).toBe(3);
      // 23.5 - (15 + 3 · 3) = -0.5 mm: the top layer stands above the 47 mm flange.
      const c = s.records.find((r) => r.check === SPOOL_FLANGE_CLEARANCE)!;
      expect(c.result).toBeCloseTo(-0.0005, 6);
      expect(c.status).toBe('warning');
      // The chain has no motor (a structure problem of the chain); the spool itself has none.
      const outputProblems = (r: typeof result) =>
        mechEvaluationOf(r.evaluations)!.drivetrains![0]!.problems.filter(
          (p) => p.path[0] === 'output',
        );
      expect(outputProblems(result)).toEqual([]);

      // A typed width longer than the 12 mm body is the drivetrain's problem.
      const wide = apply(doc, {
        type: 'setDrivetrain',
        drivetrain: {
          ...doc.mech!.drivetrains![0]!,
          output: { ...doc.mech!.drivetrains![0]!.output, width: x('20 mm') } as never,
        },
      });
      const again = await engine.regen(wide);
      if (again === null) throw new Error('superseded');
      expect(outputProblems(again)).toEqual([
        {
          path: ['output', 'width'],
          message:
            'the width between the flanges is longer than the spool body (12 mm along its axis)',
          kind: 'value',
        },
      ]);
    } finally {
      await engine.dispose();
      await service.idle();
    }
    expect(service.leaks()).toEqual([]);
  }, 60_000);
});
