import type { ExtensionFeature } from '@manufakture/core';
import type { ToolItem } from '@manufakture/kernel';
import type { FeatureResult } from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import { jointDetail } from '../kinds';
import {
  buildJoint,
  dashed,
  jointFormOf,
  jointPreviewLines,
  newJointForm,
  previewJoint,
  primitiveEdges,
  readable,
  swapBoards,
  toolsByBoard,
  type JointForm,
} from './joints';
import { jointsDocument, jointsModel, SCENES } from './joints.test-fixture';

const PART = 'part#1';

function results(scene: (typeof SCENES)[keyof typeof SCENES]) {
  const part = jointsModel(scene).getState().parts[0]!;
  return new Map<string, FeatureResult>(part.features.map((f) => [f.featureId, f]));
}

function form(patch: Partial<JointForm> = {}): JointForm {
  return {
    ...newJointForm(jointsDocument(), PART, []),
    a: 'extension#1',
    b: 'extension#2',
    ...patch,
  };
}

function preview(f: JointForm, scene: (typeof SCENES)[keyof typeof SCENES]) {
  return previewJoint(f, { doc: jointsDocument(), partId: PART, results: results(scene) });
}

describe('the joint form', () => {
  it('starts on a dado between the selected boards, or the last two', () => {
    const doc = jointsDocument();
    expect(newJointForm(doc, PART)).toMatchObject({
      kind: 'dado',
      a: 'extension#2',
      b: 'extension#3',
    });
    const picked = newJointForm(doc, PART, [
      { kind: 'feature', id: 'extension#1' },
      { kind: 'face', id: 'x', bodyId: 'part#1/extension#2' } as never,
    ]);
    expect(picked).toMatchObject({ a: 'extension#1', b: 'extension#2' });
    expect(swapBoards(picked)).toMatchObject({ a: 'extension#2', b: 'extension#1' });
  });

  it('builds one command with both boards in dependsOn and scope, and reads it back', () => {
    const doc = jointsDocument();
    const r = buildJoint(
      form({ kind: 'dado', stopped: 'low', values: { stop: '20', clearance: '' } }),
      { doc, partId: PART },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.feature).toMatchObject({
      id: 'extension#4',
      name: 'Dado 4',
      extension: 'wood.joint',
      dependsOn: ['extension#1', 'extension#2'],
      scope: ['extension#1', 'extension#2'],
      params: { kind: 'dado', a: 'extension#1', b: 'extension#2', stopped: 'low' },
      expressions: { stop: { source: '20' } },
    });
    expect(r.feature.operation).toBeUndefined();
    expect(r.command.type).toBe('addFeature');
    const back = jointFormOf(r.feature);
    expect(back.ok && back.form).toMatchObject({
      kind: 'dado',
      stopped: 'low',
      values: { stop: '20' },
    });
  });

  it('renames a default-named joint when its kind changes, and keeps a name the user gave', () => {
    const doc = jointsDocument();
    const r = buildJoint(form(), { doc, partId: PART });
    if (!r.ok) throw new Error('not built');
    const edited = buildJoint(form({ kind: 'rabbet' }), { doc, partId: PART, existing: r.feature });
    expect(edited.ok && edited.feature.name).toBe('Rabbet 4');
    const named: ExtensionFeature = { ...r.feature, name: 'Shelf housing' };
    const kept = buildJoint(form({ kind: 'rabbet' }), { doc, partId: PART, existing: named });
    expect(kept.ok && kept.feature.name).toBe('Shelf housing');
  });

  it('refuses missing boards, one board twice, bad values and a stopped dado with no stop', () => {
    const doc = jointsDocument();
    const r = buildJoint(form({ a: '', b: 'extension#2' }), { doc, partId: PART });
    expect(r.ok || r.errors).toEqual({ a: 'Choose a board.' });
    const same = buildJoint(form({ b: 'extension#1' }), { doc, partId: PART });
    expect(same.ok || same.errors).toEqual({ b: 'Choose two different boards.' });
    const notBoard = buildJoint(form({ b: 'sketch#1' }), { doc, partId: PART });
    expect(notBoard.ok || notBoard.errors.b).toBe('Outline is not a board.');
    const count = buildJoint(form({ kind: 'dowel', values: { count: '2.5' } }), {
      doc,
      partId: PART,
    });
    expect(count.ok || count.errors.count).toBe('Must be a whole number.');
    const stop = buildJoint(form({ stopped: 'both' }), { doc, partId: PART });
    expect(stop.ok || stop.errors.stop).toContain('needs the stop');
    // Only the kind's own fields are stored: a through dado drops a typed stop.
    const through = buildJoint(form({ values: { stop: '20', diameter: '8' } }), {
      doc,
      partId: PART,
    });
    expect(through.ok && through.feature.expressions).toEqual({});
  });
});

describe('the joint preview', () => {
  it('cuts a dado from A only, the depth from the overlap', () => {
    const p = preview(form(), SCENES.dado);
    if (p.state !== 'ok') throw new Error(JSON.stringify(p));
    expect(toolsByBoard(p.items, form())).toEqual({
      a: { cut: ['groove'], added: [] },
      b: { cut: [], added: [] },
    });
    expect(p.metadata.details).toMatchObject({ depth: 6, width: 18, length: 300 });
    expect(p.metadata.warnings).toEqual([]);
  });

  it('warns about a dado deeper than half of A, in the boards names', () => {
    const p = preview(form(), SCENES.deep);
    if (p.state !== 'ok') throw new Error(JSON.stringify(p));
    expect(p.metadata.warnings).toHaveLength(1);
    expect(p.metadata.warnings[0]!.code).toBe('rule-of-thumb');
    expect(p.metadata.warnings[0]!.message).toMatch(
      /^Rule of thumb, not engineering: .*Side \(A\)/,
    );
  });

  it('cuts a rabbet at the edge, and refuses a rabbet away from it on the kind', () => {
    expect(preview(form({ kind: 'rabbet' }), SCENES.rabbet).state).toBe('ok');
    const p = preview(form({ kind: 'rabbet' }), SCENES.dado);
    expect(p).toMatchObject({ state: 'refused', field: 'kind' });
  });

  it('cuts a tenon on B and a mortise in A', () => {
    const f = form({ kind: 'mortise-tenon' });
    const p = preview(f, SCENES.tenon);
    if (p.state !== 'ok') throw new Error(JSON.stringify(p));
    const tools = toolsByBoard(p.items, f);
    expect(tools.a.cut).toEqual(['mortise']);
    expect(tools.b.cut).toEqual(expect.arrayContaining(['cheek-0', 'cheek-1']));
    expect(p.metadata.details).toMatchObject({ thickness: 6, width: 68, length: 25 });
  });

  it('drills dowels and pockets in boards that touch, counting the hardware', () => {
    const dowels = preview(form({ kind: 'dowel' }), SCENES.touching);
    if (dowels.state !== 'ok') throw new Error(JSON.stringify(dowels));
    expect(dowels.metadata.hardware).toEqual([
      { item: 'dowel', diameter: 8, length: 32, quantity: 4 },
    ]);
    const pockets = preview(form({ kind: 'pocket-screw' }), SCENES.touching);
    if (pockets.state !== 'ok') throw new Error(JSON.stringify(pockets));
    expect(pockets.metadata.hardware).toEqual([
      { item: 'pocket-screw', length: 1.25 * 25.4, quantity: 3 },
    ]);
    expect(toolsByBoard(pockets.items, form()).a.cut).toEqual([]);
    // Dowels need boards that touch without overlapping.
    expect(preview(form({ kind: 'dowel' }), SCENES.dado).state).toBe('refused');
  });

  it('cuts box joint fingers from both boards', () => {
    const p = preview(form({ kind: 'box-joint' }), SCENES.box);
    if (p.state !== 'ok') throw new Error(JSON.stringify(p));
    expect(p.metadata.details).toMatchObject({ fingers: 6 });
    const tools = toolsByBoard(p.items, form());
    expect(tools.a.cut).toHaveLength(3);
    expect(tools.b.cut).toHaveLength(3);
  });

  it('refuses a splayed board readably, on B', () => {
    const p = preview(form(), SCENES.splayed);
    expect(p).toMatchObject({ state: 'refused', field: 'b' });
    expect(p.state === 'refused' && p.message).toMatch(
      /^Shelf \(B\) is not square to Side \(A\) \(about 30° off\)/,
    );
  });

  it('waits for boards regen has not built', () => {
    const r = results(SCENES.dado);
    r.delete('extension#2');
    const p = previewJoint(form(), { doc: jointsDocument(), partId: PART, results: r });
    expect(p).toMatchObject({ state: 'waiting', message: expect.stringContaining('Shelf') });
  });
});

describe('the preview lines', () => {
  const box: ToolItem = {
    id: 't',
    body: 'extension#1',
    mode: 'subtract',
    primitive: {
      type: 'box',
      frame: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] },
      size: [10, 20, 30],
    },
  };

  it('outlines a box by its twelve edges, in its frame', () => {
    const edges = primitiveEdges(box);
    expect(edges).toHaveLength(6);
    expect(edges[1]).toContainEqual([10, 20, 30]);
  });

  it('outlines a stepped cylinder with a tip', () => {
    const edges = primitiveEdges({
      ...box,
      primitive: {
        type: 'cylinder',
        axis: { origin: [0, 0, 0], direction: [0, 0, 1] },
        radius: 2,
        length: 10,
        step: { radius: 4, length: 3 },
        tip: { angle: Math.PI / 2 },
      },
    });
    // Two rings and four lines for the step, the same for the pilot, four lines to the tip.
    expect(edges).toHaveLength(6 + 6 + 4);
    expect(edges.at(-1)!.at(-1)![2]).toBeCloseTo(12);
  });

  it('dashes the tools on B and draws the ones on A solid', () => {
    expect(
      dashed(
        [
          [0, 0, 0],
          [10, 0, 0],
        ],
        1,
      ),
    ).toHaveLength(5);
    const onB = { ...box, body: 'extension#2' };
    const f = { a: 'extension#1', b: 'extension#2' };
    expect(jointPreviewLines([box], f)).toHaveLength(6);
    expect(jointPreviewLines([onB], f).length).toBeGreaterThan(6);
  });
});

describe('joint messages and the tree', () => {
  it('names boards by name and role', () => {
    const doc = jointsDocument();
    const features = doc.parts[0]!.features;
    expect(readable('extension#2 must touch extension#1', form(), features)).toBe(
      'Shelf (B) must touch Side (A).',
    );
  });

  it("shows a joint's boards and hardware in the tree", () => {
    const doc = jointsDocument();
    const r = buildJoint(form({ kind: 'dowel' }), { doc, partId: PART });
    if (!r.ok) throw new Error('not built');
    const metadata = {
      kind: 'dowel',
      a: 'extension#1',
      b: 'extension#2',
      hardware: [{ item: 'dowel', diameter: 8, length: 32, quantity: 4 }],
      warnings: [],
      details: {},
    };
    expect(jointDetail(r.feature, { features: doc.parts[0]!.features, metadata })).toBe(
      'Shelf into Side, 4 dowels',
    );
  });
});
