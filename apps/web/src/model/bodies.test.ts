// The part's bodies as the app shows them: names, colours, materials and hidden state from the
// document and view settings on top of what regen made.

import { applyCommand, findPart, type Command, type ManufaktureDocument } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import {
  BODY_PALETTE,
  addToGroupCommand,
  bodyName,
  bodyPropsCommand,
  defaultGroupName,
  deleteGroupCommand,
  groupBodies,
  groupOf,
  isolateHidden,
  newGroupCommand,
  pruneGroupsCommands,
  removeFromGroupCommand,
  renameGroupCommand,
  instanceViewId,
  parseInstanceViewId,
  partBodies,
  sameOr,
  viewBodyId,
} from './bodies';
import { twoBodyDocument, twoBodyModel } from './twoBodies.test-fixture';

describe('partBodies', () => {
  it('names and colours bodies by order until the user sets them', () => {
    const doc = twoBodyDocument();
    const bodies = partBodies(findPart(doc, 'part#1'), twoBodyModel());
    expect(bodies.map((b) => [b.bodyId, b.viewId, b.name, b.color, b.solids])).toEqual([
      ['extrude#1', 'part#1/extrude#1', 'Body 1', BODY_PALETTE[0], 1],
      ['extrude#3', 'part#1/extrude#3', 'Body 2', BODY_PALETTE[1], 2],
    ]);
    // The first body keeps the viewport's default colour, so a one-body part looks as before.
    expect(bodies[0]!.view.color).toBeUndefined();
    expect(bodies[1]!.view.color).toBe(BODY_PALETTE[1]);
    // The same regen view and colour give the same object, so the viewport is not rebuilt.
    const model = twoBodyModel();
    const a = partBodies(findPart(doc, 'part#1'), model);
    const b = partBodies(findPart(doc, 'part#1'), model);
    expect(b.map((x) => x.view)).toEqual(a.map((x) => x.view));
    expect(b[1]!.view).toBe(a[1]!.view);
  });

  it('uses the part name for its only body', () => {
    const doc = twoBodyDocument();
    const model = { ...twoBodyModel(), bodies: twoBodyModel().bodies.slice(0, 1) };
    expect(partBodies(findPart(doc, 'part#1'), model)[0]!.name).toBe('Demo part');
    expect(bodyName({ name: 'Bracket' }, 0, 1)).toBe('Bracket');
    expect(bodyName({ name: 'Bracket' }, 2, 3)).toBe('Body 3');
  });

  it('reads names, colours and materials from the part, the material falling back to the part', () => {
    let doc = twoBodyDocument();
    const run = (command: Parameters<typeof applyCommand>[1]) => {
      const r = applyCommand(doc, command);
      if (!r.ok) throw new Error(r.error.message);
      doc = r.value.document;
    };
    run({ type: 'setMaterial', partId: 'part#1', material: 'pla' });
    run({
      type: 'setBodyProps',
      partId: 'part#1',
      bodyId: 'extrude#3',
      props: { name: 'Lid', color: '#ff0000', material: 'petg' },
    });
    const hidden = new Set(['part#1/extrude#3']);
    const [first, second] = partBodies(findPart(doc, 'part#1'), twoBodyModel(), hidden);
    expect(first).toMatchObject({ name: 'Body 1', material: 'pla', ownMaterial: null });
    expect(first!.hidden).toBe(false);
    expect(second).toMatchObject({
      name: 'Lid',
      named: true,
      color: '#ff0000',
      material: 'petg',
      ownMaterial: 'petg',
      hidden: true,
    });
    expect(second!.view.color).toBe('#ff0000');
  });

  it('lists nothing for a part or model that is not there', () => {
    expect(partBodies(undefined, twoBodyModel())).toEqual([]);
    expect(partBodies(findPart(twoBodyDocument(), 'part#1'), undefined)).toEqual([]);
  });
});

describe('bodyPropsCommand', () => {
  it('patches a body settings, and drops a field set back to its default', () => {
    const body = { bodyId: 'extrude#3', props: undefined };
    expect(bodyPropsCommand('part#1', body, { name: 'Lid' })).toEqual({
      type: 'setBodyProps',
      partId: 'part#1',
      bodyId: 'extrude#3',
      props: { name: 'Lid' },
    });
    const named = {
      bodyId: 'extrude#3',
      props: { id: 'extrude#3', name: 'Lid', color: '#00ff00' },
    };
    expect(bodyPropsCommand('part#1', named, { name: null })).toMatchObject({
      props: { color: '#00ff00' },
    });
    expect(bodyPropsCommand('part#1', named, { material: 'abs' })).toMatchObject({
      props: { name: 'Lid', color: '#00ff00', material: 'abs' },
    });
    // Nothing changes: no command, so no undo step.
    expect(bodyPropsCommand('part#1', named, { name: 'Lid' })).toBeNull();
    expect(bodyPropsCommand('part#1', body, { material: null })).toBeNull();
  });
});

describe('helpers', () => {
  it('makes viewport ids and keeps equal arrays', () => {
    expect(viewBodyId('part#2', 'import#1')).toBe('part#2/import#1');
    const a = [1, 2];
    expect(sameOr(a, [1, 2])).toBe(a);
    expect(sameOr(a, [1, 3])).toEqual([1, 3]);
    expect(sameOr(null, a)).toBe(a);
  });
});

describe('instance view ids', () => {
  it('name a body an instance shows, and read back, body ids with slashes included', () => {
    const id = instanceViewId('assembly#2', 'inst#3', 'derived#1:from/extrude#1');
    expect(id).toBe('assembly#2/inst#3/derived#1:from/extrude#1');
    expect(parseInstanceViewId(id)).toEqual({
      assemblyId: 'assembly#2',
      instanceId: 'inst#3',
      bodyId: 'derived#1:from/extrude#1',
    });
    expect(parseInstanceViewId(viewBodyId('part#1', 'extrude#1'))).toBeNull();
  });
});

describe('body groups', () => {
  const part = (doc: ManufaktureDocument) => findPart(doc, 'part#1')!;
  const apply = (doc: ManufaktureDocument, command: Command | null) => {
    if (!command) throw new Error('no command');
    const r = applyCommand(doc, command);
    if (!r.ok) throw new Error(r.error.message);
    return r.value.document;
  };
  const withGroup = (bodies: string[] = ['extrude#1', 'extrude#3']) =>
    apply(twoBodyDocument(), newGroupCommand(part(twoBodyDocument()), bodies, 'Frame').command);

  it('makes a group of the chosen bodies with the next id and a default name', () => {
    const doc = twoBodyDocument();
    expect(defaultGroupName(part(doc))).toBe('Group 1');
    const made = newGroupCommand(part(doc), ['extrude#3', 'extrude#3', 'extrude#1']);
    expect(made.groupId).toBe('group#1');
    expect(made.name).toBe('Group 1');
    const next = apply(doc, made.command);
    expect(part(next).bodyGroups).toEqual([
      { id: 'group#1', name: 'Group 1', bodies: ['extrude#3', 'extrude#1'] },
    ]);
    expect(defaultGroupName(part(next))).toBe('Group 2');
    expect(newGroupCommand(part(next), []).groupId).toBe('group#2');
  });

  it('moves bodies out of their old group when they join another, in one command', () => {
    const doc = withGroup();
    const made = newGroupCommand(part(doc), ['extrude#3'], 'Lid');
    expect(made.command.type).toBe('batch');
    const next = apply(doc, made.command);
    expect(part(next).bodyGroups!.map((g) => [g.name, g.bodies])).toEqual([
      ['Frame', ['extrude#1']],
      ['Lid', ['extrude#3']],
    ]);
    expect(groupOf(part(next), 'extrude#3')?.id).toBe('group#2');
    // Adding moves too; adding what is already there is no change.
    const back = apply(next, addToGroupCommand(part(next), 'group#1', ['extrude#3']));
    expect(part(back).bodyGroups!.map((g) => g.bodies)).toEqual([['extrude#1', 'extrude#3'], []]);
    expect(addToGroupCommand(part(back), 'group#1', ['extrude#1'])).toBeNull();
    expect(addToGroupCommand(part(back), 'group#9', ['extrude#1'])).toBeNull();
  });

  it('renames, removes members and deletes a group, keeping the bodies', () => {
    const doc = withGroup();
    expect(renameGroupCommand(part(doc), 'group#1', ' Frame ')).toBeNull();
    const renamed = apply(doc, renameGroupCommand(part(doc), 'group#1', '  Base frame '));
    expect(part(renamed).bodyGroups![0]!.name).toBe('Base frame');
    const removed = apply(renamed, removeFromGroupCommand(part(renamed), 'group#1', ['extrude#1']));
    expect(part(removed).bodyGroups![0]!.bodies).toEqual(['extrude#3']);
    expect(removeFromGroupCommand(part(removed), 'group#1', ['extrude#1'])).toBeNull();
    const gone = apply(removed, deleteGroupCommand('part#1', 'group#1'));
    expect(part(gone).bodyGroups).toBeUndefined();
    expect(part(gone).features).toEqual(part(doc).features);
  });

  it('shows a group with the members regen made, and its hidden state from theirs', () => {
    const doc = withGroup(['extrude#9', 'extrude#3']);
    const hidden = new Set(['part#1/extrude#3']);
    const { groups, ungrouped } = groupBodies(
      part(doc),
      partBodies(part(doc), twoBodyModel(), hidden),
    );
    // extrude#9 is not a body regen made (gone, merged, rolled back): not shown, still listed.
    expect(groups[0]!.members.map((b) => b.bodyId)).toEqual(['extrude#3']);
    expect(groups[0]!.group.bodies).toEqual(['extrude#9', 'extrude#3']);
    expect(groups[0]!.hidden).toBe(true);
    expect(groups[0]!.partlyHidden).toBe(false);
    expect(ungrouped.map((b) => b.bodyId)).toEqual(['extrude#1']);

    const both = withGroup();
    const some = groupBodies(part(both), partBodies(part(both), twoBodyModel(), hidden));
    expect([some.groups[0]!.hidden, some.groups[0]!.partlyHidden]).toEqual([false, true]);
    expect(some.ungrouped).toEqual([]);
    // An empty group is not hidden.
    const empty = groupBodies(part(withGroup([])), partBodies(part(both), twoBodyModel()));
    expect([empty.groups[0]!.hidden, empty.groups[0]!.members]).toEqual([false, []]);
    expect(groupBodies(undefined, []).groups).toEqual([]);
  });

  it('prunes the members a deleted feature made, and only those', () => {
    const doc = withGroup(['extrude#1', 'extrude#3', 'pattern#1:i2']);
    expect(pruneGroupsCommands(part(doc), new Set(['extrude#3']))).toEqual([
      {
        type: 'setBodyGroup',
        partId: 'part#1',
        group: { id: 'group#1', name: 'Frame', bodies: ['extrude#1', 'pattern#1:i2'] },
      },
    ]);
    expect(pruneGroupsCommands(part(doc), new Set(['pattern#1']))[0]).toMatchObject({
      group: { bodies: ['extrude#1', 'extrude#3'] },
    });
    expect(pruneGroupsCommands(part(doc), new Set(['sketch#1']))).toEqual([]);
  });

  it('isolating hides everything else', () => {
    expect(isolateHidden(['a', 'b', 'c'], ['b', 'c'])).toEqual(['a']);
    expect(isolateHidden(['a', 'b'], [])).toEqual(['a', 'b']);
  });
});
