// The Manufacture workspace's commands: a new setup's defaults (the Shapeoko 5 Pro 4x4 and its
// default post, margins, the part's material), undo and redo of every CAM command through the
// document store, and a reload keeping the setup (the state, serialized and read back, and the
// document library).

import { BUILTIN_POST_IDS, DEFAULT_MACHINE_ID, defaultPost, findMachine } from '@manufakture/cam';
import { deserialize, serialize, type Command } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { MemoryBackend } from '../persistence/backend';
import { DocumentLibrary } from '../persistence/library';
import { createDocumentStore } from '../state/document';
import { apply, mm, plywoodDocument, setupDocument, withTool } from './cam.test-fixture';
import {
  DEFAULT_MARGINS,
  POST_IDS,
  POST_NAMES,
  addSetupCommand,
  deleteOperationCommand,
  deleteToolCommand,
  editSetupCommand,
  machineById,
  machineCommand,
  moveOperationCommand,
  newSetup,
  partFeedCategory,
  postName,
  renameOperationCommand,
  reorderOperationCommand,
  sameWorkpiece,
  suppressOperationCommand,
  wcsFaceCommand,
} from './commands';
import { buildOperation, newOperationForm } from './forms';
import { camVariables } from './values';

describe('a new setup', () => {
  it('is on the Shapeoko 5 Pro 4x4 with its default post, margins and the part material', () => {
    const doc = withTool(plywoodDocument());
    const { setup, setupId } = newSetup(doc, 'part#1');
    const machine = findMachine(DEFAULT_MACHINE_ID)!;
    expect(setupId).toBe('setup#1');
    expect(setup).toMatchObject({
      id: 'setup#1',
      name: 'Setup 1',
      part: 'part#1',
      machine: 'shapeoko-5-pro-4x4',
      post: defaultPost(machine),
      stock: {
        kind: 'fromBody',
        margins: {
          xMin: { source: DEFAULT_MARGINS.side },
          top: { source: DEFAULT_MARGINS.top },
          bottom: { source: DEFAULT_MARGINS.bottom },
        },
        material: 'plywood',
      },
      wcs: { up: { kind: 'axis', axis: '+z' }, origin: { xy: 'front-left', z: 'top' } },
      heights: { clearance: { source: '10 mm' }, retract: { source: '5 mm' } },
      operations: [],
    });
    expect(setup.body).toBeUndefined();
  });

  it('takes no material when the part has none, and a body material over the part one', () => {
    const doc = withTool(plywoodDocument());
    expect(
      partFeedCategory(
        apply(doc, { type: 'setMaterial', partId: 'part#1', material: null }),
        'part#1',
      ),
    ).toBe(undefined);
    const oak = apply(doc, {
      type: 'setBodyProps',
      partId: 'part#1',
      bodyId: 'extrude#1',
      props: { material: 'oak' },
    });
    expect(partFeedCategory(oak, 'part#1', 'extrude#1')).toBe('hardwood');
    expect(partFeedCategory(oak, 'part#1')).toBe('plywood');
    expect(partFeedCategory(doc, 'part#9')).toBeUndefined();
  });

  it('names setups Setup n, skipping taken names', () => {
    let doc = withTool(plywoodDocument());
    doc = apply(doc, addSetupCommand(doc, 'part#1').command);
    doc = apply(doc, editSetupCommand('setup#1', { name: 'Setup 2' }));
    expect(newSetup(doc, 'part#1').setup.name).toBe('Setup 3');
  });

  it('knows the posts packages/cam has, and looks ids up safely', () => {
    expect([...POST_IDS].sort()).toEqual([...BUILTIN_POST_IDS].sort());
    expect(Object.keys(POST_NAMES).sort()).toEqual([...BUILTIN_POST_IDS].sort());
    // Ids are document data: `constructor` is a valid CAM table id and must not find a prototype.
    expect(machineById('constructor')).toBeUndefined();
    expect(postName('constructor')).toBe('constructor');
    expect(postName('toString')).toBe('toString');
    expect(machineById('shapeoko-4-xxl')?.name).toContain('XXL');
  });

  it('switches machines with the machine default post', () => {
    const doc = setupDocument();
    const setup = doc.cam.setups[0]!;
    const xxl = machineById('shapeoko-4-xxl')!;
    const next = apply(doc, machineCommand(setup, xxl));
    expect(next.cam.setups[0]).toMatchObject({ machine: 'shapeoko-4-xxl', post: defaultPost(xxl) });
  });
});

/** An operation of the setup, built by the dialog's own form. */
function profileCommand(
  doc: ReturnType<typeof setupDocument>,
  name = 'Outline',
  setupId = 'setup#1',
): Command {
  const setup = doc.cam.setups.find((s) => s.id === setupId)!;
  const form = { ...newOperationForm(doc, 'profile', name), sources: [] as never[] };
  const r = buildOperation(
    {
      ...form,
      sources: [{ kind: 'region', sketch: 'sketch#1', label: 'Regions of Sketch 1' }],
    },
    { doc, setup, units: doc.units, variables: camVariables(doc) },
  );
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.command;
}

describe('undo and redo', () => {
  it('undoes and redoes every CAM command, each one step', () => {
    const store = createDocumentStore(withTool(plywoodDocument()));
    const doc = () => store.getState().document;
    const steps: [string, (d: ReturnType<typeof doc>) => Command][] = [
      ['add setup', (d) => addSetupCommand(d, 'part#1').command],
      ['add second setup', (d) => addSetupCommand(d, 'part#1').command],
      ['reorder setups', () => ({ type: 'reorderCamSetups', setupId: 'setup#2', index: 0 })],
      [
        'edit setup',
        () =>
          editSetupCommand('setup#1', {
            name: 'Top',
            heights: { clearance: mm('12'), retract: mm('4') },
          }),
      ],
      [
        'machine',
        (d) =>
          machineCommand(
            d.cam.setups.find((s) => s.id === 'setup#1')!,
            machineById('shapeoko-4-xxl')!,
          ),
      ],
      [
        'wcs face',
        (d) =>
          wcsFaceCommand(
            d,
            d.cam.setups.find((s) => s.id === 'setup#1')!,
            { face: 'extrude#1:cap:end' },
          ),
      ],
      ['add operation', (d) => profileCommand(d)],
      ['add second operation', (d) => profileCommand(d, 'Second')],
      [
        'rename operation',
        (d) =>
          renameOperationCommand(
            'setup#1',
            d.cam.setups.find((s) => s.id === 'setup#1')!.operations[0]!,
            'Renamed',
          ),
      ],
      [
        'suppress operation',
        (d) =>
          suppressOperationCommand(
            'setup#1',
            d.cam.setups.find((s) => s.id === 'setup#1')!.operations[0]!,
            true,
          ),
      ],
      ['reorder operation', () => reorderOperationCommand('setup#1', 'profile#2', 0)],
      ['move operation', (d) => moveOperationCommand(d, 'setup#1', 'profile#1', 'setup#2')!],
      ['delete operation', () => deleteOperationCommand('setup#1', 'profile#2')],
      [
        'edit tool',
        (d) => ({ type: 'editCamTool', tool: { ...d.cam.tools[0]!, name: 'Quarter inch' } }),
      ],
      ['add tool', (d) => withToolCommand(d)],
      ['delete tool', () => deleteToolCommand('tool#2')],
      ['delete setup', () => ({ type: 'deleteCamSetup', setupId: 'setup#2' })],
    ];
    for (const [what, make] of steps) {
      const before = doc();
      const r = store.getState().execute(make(before), what);
      expect(r.ok, `${what}: ${r.ok ? '' : r.error.message}`).toBe(true);
      const after = doc();
      expect(after.cam, what).not.toEqual(before.cam);
      store.getState().undo();
      // Id counters only ever increase (ADR 0004 decision 4): undo puts back everything else.
      const { nextIds: _n, ...undone } = doc().cam;
      void _n;
      const { nextIds: _b, ...was } = before.cam;
      void _b;
      expect(undone, `undo ${what}`).toEqual(was);
      store.getState().redo();
      expect(doc().cam, `redo ${what}`).toEqual(after.cam);
    }
    // Where it ended: one setup with a WCS face, its moved-away operation gone with setup#2.
    expect(doc().cam.setups.map((s) => [s.id, s.name, s.operations.map((o) => o.id)])).toEqual([
      ['setup#1', 'Top', []],
    ]);
    expect(doc().cam.setups[0]!.wcs.up).toEqual({
      kind: 'face',
      face: { id: 'r1', ref: { face: 'extrude#1:cap:end' } },
    });
  });

  it('moves an operation to another setup under its own id, as one undo step', () => {
    let doc = setupDocument();
    doc = apply(doc, addSetupCommand(doc, 'part#1').command);
    doc = apply(doc, profileCommand(doc));
    const store = createDocumentStore(doc);
    const move = moveOperationCommand(doc, 'setup#1', 'profile#1', 'setup#2')!;
    expect(store.getState().execute(move, 'Move').ok).toBe(true);
    const after = store.getState().document.cam.setups;
    expect(after[0]!.operations).toEqual([]);
    expect(after[1]!.operations.map((o) => o.id)).toEqual(['profile#1']);
    store.getState().undo();
    expect(store.getState().document.cam.setups[0]!.operations.map((o) => o.id)).toEqual([
      'profile#1',
    ]);
    expect(moveOperationCommand(doc, 'setup#1', 'profile#1', 'setup#1')).toBeNull();
    expect(moveOperationCommand(doc, 'setup#1', 'profile#9', 'setup#2')).toBeNull();
  });

  it('does not move an operation to a setup of another part (feature ids are per part)', () => {
    let doc = setupDocument();
    doc = apply(doc, { type: 'addPart', partId: 'part#2', name: 'Lid' });
    doc = apply(doc, addSetupCommand(doc, 'part#2').command);
    doc = apply(doc, profileCommand(doc));
    expect(doc.cam.setups.map((s) => s.part)).toEqual(['part#1', 'part#2']);
    expect(moveOperationCommand(doc, 'setup#1', 'profile#1', 'setup#2')).toBeNull();
  });

  it('does not move an operation to a setup of another body of the same part', () => {
    // A feature that cuts two bodies names its faces alike on both: the moved operation would
    // resolve on the other body without a word.
    let doc = setupDocument();
    doc = apply(doc, addSetupCommand(doc, 'part#1', 'extrude#1').command);
    doc = apply(doc, addSetupCommand(doc, 'part#1', 'extrude#2').command);
    doc = apply(doc, addSetupCommand(doc, 'part#1', 'extrude#1').command);
    doc = apply(doc, profileCommand(doc, 'Outline', 'setup#2'));
    expect(doc.cam.setups.map((s) => s.body)).toEqual([
      undefined,
      'extrude#1',
      'extrude#2',
      'extrude#1',
    ]);
    expect(moveOperationCommand(doc, 'setup#2', 'profile#1', 'setup#3')).toBeNull();
    // No body chosen is not a body: it does not match a setup that names one, either way.
    expect(moveOperationCommand(doc, 'setup#2', 'profile#1', 'setup#1')).toBeNull();
    expect(moveOperationCommand(doc, 'setup#2', 'profile#1', 'setup#4')).not.toBeNull();
    // A body cleared with null matches one never set.
    const cleared = apply(doc, { type: 'editCamSetup', setupId: 'setup#4', body: null });
    expect(cleared.cam.setups[3]!.body ?? null).toBeNull();
    expect(sameWorkpiece(cleared.cam.setups[0]!, cleared.cam.setups[3]!)).toBe(true);
  });

  it('refuses to delete a tool an operation cuts with, naming it', () => {
    let doc = setupDocument();
    doc = apply(doc, profileCommand(doc));
    const store = createDocumentStore(doc);
    const r = store.getState().execute(deleteToolCommand('tool#1'), 'Delete tool');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('setup#1/profile#1');
  });
});

function withToolCommand(doc: ReturnType<typeof setupDocument>): Command {
  const next = withTool(doc, 'c3d-301');
  return { type: 'addCamTool', tool: next.cam.tools.at(-1)! };
}

describe('reload', () => {
  it('keeps the setup, its operations and tools through serialize and load', () => {
    const store = createDocumentStore(withTool(plywoodDocument()));
    const { command } = addSetupCommand(store.getState().document, 'part#1');
    store.getState().execute(command, 'Add CAM setup');
    store.getState().execute(profileCommand(store.getState().document), 'Add profile');
    const saved = store.getState().document;
    const loaded = deserialize(serialize(saved));
    if (!loaded.ok) throw new Error(loaded.error.message);
    const reloaded = createDocumentStore(loaded.value.document);
    expect(reloaded.getState().document.cam).toEqual(saved.cam);
    // The counters came back too: the next ids are fresh.
    expect(newSetup(reloaded.getState().document, 'part#1').setupId).toBe('setup#2');
  });

  it('keeps the setup through the document library (save, open in a new library)', async () => {
    const backend = new MemoryBackend();
    let n = 0;
    const lib = () =>
      new DocumentLibrary(backend, {
        now: () => new Date(Date.UTC(2026, 9, 2, 12, 0, n++)),
        newId: () => `copy-${n}`,
        locks: null,
      });
    let doc = setupDocument();
    doc = apply(doc, profileCommand(doc));
    await lib().save(doc);
    const opened = await lib().open(doc.id);
    if (!opened.ok) throw new Error(opened.message);
    expect(opened.value.document.cam).toEqual(doc.cam);
  });
});
