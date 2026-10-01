// The part's bodies as the app shows them: names, colours, materials and hidden state from the
// document and view settings on top of what regen made.

import { applyCommand, findPart } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import {
  BODY_PALETTE,
  bodyName,
  bodyPropsCommand,
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
