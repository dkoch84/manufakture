// Measured variables (#1202) end to end, with the real kernel and solver: a variable reading
// `distance(...)` between faces of two bodies drives a third body, follows an edit, fails with
// the face's name when it is lost, and refuses to measure what it shapes.

import type { Command, ManufaktureDocument } from '@manufakture/core';
import type { KernelService } from '@manufakture/kernel';
import { createNodeService } from '@manufakture/kernel/node';
import { createSolverService, type SolverService } from '@manufakture/sketch';
import { beforeAll, describe, expect, it } from 'vitest';
import { RegenEngine } from './engine';
import { buildGraph, dirtyFeaturesOf, featuresReading, variableReaders } from './graph';
import { callPart, measuredCalls } from './measured';
import {
  LID,
  add,
  addTo,
  apply,
  build,
  extrude,
  rectangle,
  setVariable,
  statuses,
} from './test-helpers';
import type { RegenResult } from './types';
import { evaluateVariables } from './values';

let service: KernelService;
let solver: SolverService;

beforeAll(async () => {
  service = await createNodeService();
  solver = createSolverService();
}, 60_000);

/** Body A's right side (x = w1) and body B's left side (x = 100). */
const A_RIGHT = 'extrude#1:side:e2';
const B_LEFT = 'extrude#2:side:e8';

/**
 * Body A (`w1` x 30 x 20 from the origin), body B (40 x 30 x 20 at x = 100), and between them a
 * body C at x = 45 as wide as `#fill`. `#gap` measures the space between A and B.
 */
function between(fill = '#gap - 10', gap = `distance("${A_RIGHT}", "${B_LEFT}")`) {
  return build([
    setVariable('w1', '40'),
    setVariable('gap', gap),
    setVariable('fill', fill),
    add(rectangle('sketch#1', { width: 'w1', depth: '30' })),
    add(extrude('extrude#1', 'sketch#1', '20')),
    add(
      rectangle('sketch#2', {
        width: '40',
        depth: '30',
        at: [100, 0],
        ids: ['e5', 'e6', 'e7', 'e8'],
        firstConstraint: 12,
      }),
    ),
    add(extrude('extrude#2', 'sketch#2', '20')),
    add(
      rectangle('sketch#3', {
        width: 'fill',
        depth: '30',
        at: [45, 0],
        ids: ['e9', 'e10', 'e11', 'e12'],
        firstConstraint: 30,
      }),
    ),
    add(extrude('extrude#3', 'sketch#3', '20')),
  ]);
}

const valueOf = (doc: ManufaktureDocument, r: RegenResult, name: string) =>
  evaluateVariables(doc.variables, r.measurements).values.get(name)?.value;

const setVar = (name: string, source: string): Command => setVariable(name, source);

describe('measured variables', () => {
  it('measure between faces of two bodies, and the features reading them follow', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const doc = apply(
      between(),
      // C's own width, measured: a variable measuring faces of a feature that reads another
      // measured variable is measured after it.
      setVar('c_width', 'distance("extrude#3:side:e10", "extrude#3:side:e12")'),
    );
    const first = (await engine.regen(doc))!;
    expect(Object.values(statuses(first)).every((s) => s === 'ok')).toBe(true);
    expect(first.measurements).toEqual([
      { fn: 'distance', faces: [A_RIGHT, B_LEFT], partId: 'part#1', value: 60 },
      {
        fn: 'distance',
        faces: ['extrude#3:side:e10', 'extrude#3:side:e12'],
        partId: 'part#1',
        value: 50,
      },
    ]);
    expect(first.variableErrors).toBeUndefined();
    // Each kernel feature was built once: the part built for the measurements gave the full
    // build its cache hits.
    expect(first.counters.featureOps).toBe(3);
    expect(valueOf(doc, first, 'fill')).toBeCloseTo(50);

    // Widen A by 10: the gap closes to 50 and C follows to 40.
    const wider = apply(doc, setVar('w1', '50'));
    expect(dirtyFeaturesOf(doc, wider, 'part#1')).toEqual([
      'sketch#1',
      'extrude#1',
      'sketch#3',
      'extrude#3',
    ]);
    const second = (await engine.regen(wider, { previous: doc }))!;
    expect(second.measurements!.map((m) => m.value)).toEqual([50, 40]);
    expect(valueOf(wider, second, 'fill')).toBeCloseTo(40);
    // A and C rebuilt (C in the round that measures it, the full build then a hit); B cached.
    expect(second.counters.featureOps).toBe(2);
    expect(second.parts[0]!.features.find((f) => f.featureId === 'extrude#2')!.cached).toBe(true);
  });

  it('a lost face is an error naming the variable and the face; its readers fail', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const doc = between('#gap - 10', `distance("${A_RIGHT}", "extrude#2:side:e99")`);
    const r = (await engine.regen(doc))!;
    expect(r.measurements).toEqual([
      {
        fn: 'distance',
        faces: [A_RIGHT, 'extrude#2:side:e99'],
        partId: 'part#1',
        value: null,
        error: 'Face "extrude#2:side:e99" is not found on part#1',
      },
    ]);
    expect(r.variableErrors).toEqual([
      {
        name: 'gap',
        code: 'measure',
        message: '#gap: Face "extrude#2:side:e99" is not found on part#1',
      },
      {
        name: 'fill',
        code: 'unknown-variable',
        message: '#fill reads #gap, which does not evaluate',
      },
    ]);
    const s = statuses(r);
    expect([s['extrude#1'], s['extrude#2'], s['sketch#3'], s['extrude#3']]).toEqual([
      'ok',
      'ok',
      'error',
      'upstream-error',
    ]);
    const sketch = r.parts[0]!.features.find((f) => f.featureId === 'sketch#3')!;
    expect(sketch.errors[0]!.message).toBe(
      'Variable "fill" does not evaluate: Unknown variable \'#gap\'',
    );
  });

  it('a feature that is gone, suppressed or fails loses its faces too', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const doc = apply(between(), {
      type: 'suppressFeature',
      partId: 'part#1',
      featureId: 'extrude#2',
      suppressed: true,
    } as Command);
    const r = (await engine.regen(doc))!;
    expect(r.measurements![0]!.error).toBe(
      'Face "extrude#2:side:e8" is not found on part#1: extrude#2 is suppressed',
    );
  });

  it('refuses to measure faces the variable shapes: a cycle, as an error, not a hang', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    // #gap measures C, whose width reads #fill, which reads #gap.
    const doc = between('40', `distance("${A_RIGHT}", "extrude#3:side:e12")`);
    const cyclic = apply(doc, setVar('fill', '#gap'));
    const r = (await engine.regen(cyclic))!;
    expect(r.measurements![0]).toMatchObject({
      value: null,
      error:
        '#gap measures face "extrude#3:side:e12", which extrude#3 makes, and extrude#3 depends on #gap: a variable cannot measure faces it shapes',
    });
    const s = statuses(r);
    expect([s['extrude#1'], s['sketch#3'], s['extrude#3']]).toEqual([
      'ok',
      'error',
      'upstream-error',
    ]);
    // Without the cycle (C a fixed 40 wide) the same variable measures 5 mm: 45 - 40.
    const fine = (await engine.regen(doc))!;
    expect(fine.measurements![0]!.value).toBeCloseTo(5);
  });

  it('two measured variables each shaping what the other measures: no order, an error each', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    // #a measures C, which reads #b (through #fill); #b measures A, which reads #a (through #w1).
    const doc = apply(
      between('40'),
      setVar('a', 'distance("extrude#3:side:e10", "extrude#3:side:e12")'),
      setVar('b', 'distance("extrude#1:side:e2", "extrude#1:side:e4")'),
      setVar('fill', '#b'),
      setVar('w1', '#a'),
    );
    const r = (await engine.regen(doc))!;
    // #gap measures A, which reads #a: it waits on the loop without being on it.
    const loop =
      '#a and #b measure faces made by features that read one another: no order measures them';
    expect(r.measurements!.map((m) => m.error)).toEqual([
      '#gap waits on #a, which cannot be measured: measured variables there read one another',
      loop,
      loop,
    ]);
    expect(r.variableErrors!.map((e) => e.name).sort()).toEqual(['a', 'b', 'fill', 'gap', 'w1']);
  });

  it('answers an angle, and a qualified face name picks the part', async () => {
    const engine = new RegenEngine({ kernel: service, solver });
    const doc = apply(
      between(),
      setVar('square', `angle("${A_RIGHT}", "extrude#1:side:e1")`),
      setVar('parallel', `angle("part#1/${A_RIGHT}", "part#1/${B_LEFT}")`),
    );
    const r = (await engine.regen(doc))!;
    const values = evaluateVariables(doc.variables, r.measurements).values;
    expect(values.get('square')!.value).toBeCloseTo(Math.PI / 2);
    expect(values.get('parallel')!.value).toBe(0);
  });

  it('says which part when a face name is on several, and refuses two parts', async () => {
    const doc = apply(
      between(),
      { type: 'addPart', partId: LID, name: 'Lid' },
      addTo(LID, rectangle('sketch#1', { width: '40', depth: '30' })),
      addTo(LID, extrude('extrude#1', 'sketch#1', '5')),
    );
    const parts = (source: string) =>
      measuredCalls(apply(doc, setVar('m', source)).variables)
        .filter((c) => c.variables.includes('m'))
        .map((c) => {
          const p = callPart(doc, c);
          return p.ok ? p.part.id : p.message;
        });
    expect(parts(`distance("${A_RIGHT}", "${B_LEFT}")`)).toEqual([
      'Face "extrude#1:side:e2" could be on part#1 or part#2: write the part before it, as "part#1/extrude#1:side:e2"',
    ]);
    expect(parts(`distance("part#2/${A_RIGHT}", "${B_LEFT}")`)).toEqual([
      'distance() measures within one part: "extrude#1:side:e2" is on part#2 and "extrude#2:side:e8" on part#1',
    ]);
    expect(parts(`distance("part#9/${A_RIGHT}", "${B_LEFT}")`)).toEqual([
      'There is no part part#9',
    ]);
    expect(parts(`distance("box", "${B_LEFT}")`)).toEqual([
      '"box" is not a face name: a face name starts with the feature that made it, like "extrude#1:cap:end"',
    ]);
    expect(parts(`distance("part#1/${A_RIGHT}", "${B_LEFT}")`)).toEqual(['part#1']);

    // The engine reports it the same way, on the variable.
    const engine = new RegenEngine({ kernel: service, solver });
    const r = (await engine.regen(doc))!;
    expect(r.variableErrors![0]).toMatchObject({ name: 'gap', code: 'measure' });
    expect(r.variableErrors![0]!.message).toMatch(/could be on part#1 or part#2/);
  });
});

describe('measured variables in the dependency graph', () => {
  it('the features reading a variable, and everything depending on them', () => {
    const doc = between();
    const graph = buildGraph(doc.parts[0]!, doc.variables);
    const readers = variableReaders(doc.variables, ['gap']);
    expect([...readers].sort()).toEqual(['fill', 'gap']);
    expect([...featuresReading(graph, readers)]).toEqual(['sketch#3', 'extrude#3']);
    expect([...featuresReading(graph, new Set(['w1']))].sort()).toEqual(['extrude#1', 'sketch#1']);
  });
});
