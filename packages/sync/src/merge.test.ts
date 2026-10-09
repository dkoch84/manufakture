import {
  FORMAT_VERSION,
  applyCommand,
  createdIds,
  type Command,
  type ManufaktureDocument,
  type SyncEntry,
} from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { SyncClient } from './client';
import { PART, addExtrude, addSketch, bracket, editExtrude, feature, mm } from './lab';
import {
  ORDER,
  commandOrigins,
  domainPolicy,
  domainsValidator,
  featurePolicy,
  formatPath,
  lostFields,
  mergeCommandFields,
  mergeValues,
  shallowPolicy,
  type MergeValidator,
} from './merge';

/** Reads every domain value as readable. */
const ACCEPT: MergeValidator = {
  domainData: () => ({ ok: true }),
  extensionParams: () => ({ ok: true }),
};

function ok<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const apply = (doc: ManufaktureDocument, ...commands: Command[]) =>
  commands.reduce((d, c) => ok(applyCommand(d, c)).document, doc);

/**
 * `commands` (made on `base`) replayed onto `onto`, as a branch merge does: an offline client at
 * `base` holds them, and `onto` arrives as the other side's change.
 */
function replay(
  base: ManufaktureDocument,
  onto: ManufaktureDocument,
  commands: Command[],
  mergeFields: boolean | { validate?: MergeValidator } = { validate: ACCEPT },
  whole: string[] = [],
): ManufaktureDocument {
  const client = new SyncClient(base, 0, { clientId: 'm', online: false, mergeFields });
  client.on('mergedWhole', ({ reasons }) => whole.push(...reasons));
  for (const [i, command] of commands.entries()) ok(client.submit({ command, label: `c${i}` }));
  const command: Command = { type: 'replaceDocument', document: onto };
  const entry = {
    clientId: 'other',
    clientSeq: 1,
    baseRev: 0,
    format: FORMAT_VERSION,
    cause: 'execute',
    label: 'other',
    command,
    created: ok(createdIds(base, command)) as SyncEntry['created'],
    at: '',
  } as const;
  ok(client.receive([{ rev: 1, entry }]));
  return client.document;
}

const wall = (params: object, expressions: object = {}) => ({
  id: 'wall#1',
  kind: 'extension',
  name: 'Back',
  params,
  expressions,
});

describe('mergeValues', () => {
  it('keeps each side where only that side changed, the later writer where both did', () => {
    const origin = wall({ height: 96, overrides: [] }, { height: 'h' });
    const theirs = wall(
      { height: 96, overrides: [{ id: 's3', delete: true }], header: 'a' },
      { height: 'h' },
    );
    const ours = { ...wall({ height: 90, overrides: [] }, { height: 'h - 6' }), name: 'Rear' };
    expect(mergeValues(origin, theirs, ours, featurePolicy)).toEqual({
      ...wall(
        { height: 90, overrides: [{ id: 's3', delete: true }], header: 'a' },
        { height: 'h - 6' },
      ),
      name: 'Rear',
    });
    // Both changed the height: ours.
    const both = wall({ height: 100, overrides: [] }, { height: 'h' });
    expect(mergeValues(origin, both, ours, featurePolicy)).toMatchObject({
      params: { height: 90 },
    });
  });

  it('merges a feature param that is an object as one value', () => {
    const origin = wall({ header: { stock: 'a', plies: 1 } });
    const theirs = wall({ header: { stock: 'b', plies: 1 } });
    const ours = wall({ header: { stock: 'a', plies: 2 } });
    expect(mergeValues(origin, theirs, ours, featurePolicy)).toEqual(ours);
    expect(lostFields(origin, theirs, ours, featurePolicy).map(formatPath)).toEqual([
      'params.header',
    ]);
    // Domain data goes all the way down.
    expect(mergeValues(origin, theirs, ours, domainPolicy)).toEqual(
      wall({ header: { stock: 'b', plies: 2 } }),
    );
  });

  it('merges lists of objects by id: adds and deletes from both sides, edit against delete', () => {
    const o = [
      { id: 'a', v: 1 },
      { id: 'b', v: 1 },
      { id: 'c', v: 1 },
      { id: 'd', v: 1 },
    ];
    // Theirs: adds x after a, deletes c, edits d.
    const t = [
      { id: 'a', v: 1 },
      { id: 'x', v: 1 },
      { id: 'b', v: 1 },
      { id: 'd', v: 2 },
    ];
    // Ours: deletes d (theirs edited it), edits c (theirs deleted it), adds y first.
    const b = [
      { id: 'y', v: 1 },
      { id: 'a', v: 1 },
      { id: 'b', v: 1 },
      { id: 'c', v: 3 },
    ];
    const merged = mergeValues(o, t, b, domainPolicy);
    expect(merged).toEqual([
      { id: 'y', v: 1 },
      { id: 'a', v: 1 },
      { id: 'x', v: 1 },
      { id: 'b', v: 1 },
      { id: 'c', v: 3 },
    ]);
    // Theirs lost: d's edit (deleted here) and c's delete (edited here).
    expect(lostFields(o, t, merged, domainPolicy).map(formatPath)).toEqual(['[c]', '[d]']);
  });

  it("keeps the other side's reorder when ours kept the order, and names a lost one", () => {
    const o = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const t = [{ id: 'c' }, { id: 'a' }, { id: 'b' }];
    const b = [{ id: 'a' }, { id: 'b', v: 1 }, { id: 'c' }];
    expect(mergeValues(o, t, b, domainPolicy)).toEqual([
      { id: 'c' },
      { id: 'a' },
      { id: 'b', v: 1 },
    ]);
    // Both reordered: ours.
    const r = [{ id: 'b' }, { id: 'a' }, { id: 'c' }];
    expect(mergeValues(o, t, r, domainPolicy)).toEqual(r);
    const lost = lostFields(o, t, r, domainPolicy);
    expect(lost).toEqual([[ORDER]]);
    expect(lost.map(formatPath)).toEqual(['the order']);
    expect(formatPath(['levels', ORDER])).toBe('levels (order)');
  });

  it('treats lists that are not of objects with unique ids as one value', () => {
    const o = { tags: ['a', 'b'] };
    const t = { tags: ['a', 'b', 'c'] };
    const b = { tags: ['a'] };
    expect(mergeValues(o, t, b, domainPolicy)).toEqual(b);
    expect(lostFields(o, t, b, domainPolicy).map(formatPath)).toEqual(['tags']);
    const once = { l: [{ id: 'a' }] };
    const dup = { l: [{ id: 'a' }, { id: 'a' }] };
    const edited = { l: [{ id: 'a', v: 1 }] };
    expect(mergeValues(once, dup, edited, domainPolicy)).toEqual(edited);
  });

  it('names a whole object that is gone, and only top-level fields of other objects', () => {
    expect(lostFields({ a: 1 }, { a: 2 }, undefined, shallowPolicy)).toEqual([[]]);
    expect(
      lostFields({ e: { x: 1 } }, { e: { x: 2, y: 1 } }, { e: { x: 3 } }, shallowPolicy).map(
        formatPath,
      ),
    ).toEqual(['e']);
    expect(lostFields({ a: 1 }, { a: 1, b: 2 }, { a: 5, b: 2 }, shallowPolicy)).toEqual([]);
  });
});

describe('merging commands by field on replay', () => {
  const base = bracket();
  const extrude1 = () =>
    feature(base, 'extrude#1') as Extract<
      NonNullable<ReturnType<typeof feature>>,
      { kind: 'extrude' }
    >;
  const deeper: Command = {
    type: 'editFeature',
    partId: PART,
    feature: { ...extrude1(), extent: { type: 'blind', distance: mm('20') } },
  };

  it("keeps the other side's edit of other fields of the same feature", () => {
    const onto = apply(base, deeper);
    const merged = replay(base, onto, [editExtrude(base, 'extrude#1', 'Boss')]);
    expect(feature(merged, 'extrude#1')).toMatchObject({
      name: 'Boss',
      extent: { distance: mm('20') },
    });
    // Without the option (live sync), the replayed edit replaces the feature whole.
    const whole = replay(base, onto, [editExtrude(base, 'extrude#1', 'Boss')], false);
    expect(feature(whole, 'extrude#1')).toMatchObject({
      name: 'Boss',
      extent: { distance: mm('thickness') },
    });
  });

  it('merges each edit of a batch, and the later of two edits of one feature on the first', () => {
    const onto = apply(base, deeper);
    const first = editExtrude(base, 'extrude#1', 'Boss');
    const second = editExtrude(apply(base, first), 'extrude#1', 'Boss 2');
    const batch: Command = { type: 'batch', commands: [first, { ...second }] };
    const merged = replay(base, onto, [batch]);
    expect(feature(merged, 'extrude#1')).toMatchObject({
      name: 'Boss 2',
      extent: { distance: mm('20') },
    });
  });

  it('does not merge an edit that another command of its batch changed the feature before', () => {
    const rename: Command = {
      type: 'renameFeature',
      partId: PART,
      featureId: 'extrude#1',
      name: 'Renamed',
    };
    const edit = editExtrude(apply(base, rename), 'extrude#1', 'Edited');
    const origins = commandOrigins(base, { type: 'batch', commands: [rename, edit] });
    expect(origins).toEqual([null, null]);
    // Alone, the edit has its origin: the feature before it.
    const alone = commandOrigins(base, edit);
    expect(alone).toHaveLength(1);
    expect(alone[0]).toMatchObject({ type: 'restoreFeature', feature: extrude1() });
    // With no origins, the command is left as it is.
    expect(mergeCommandFields(edit, [null], base)).toEqual({ command: edit, whole: [] });
  });

  it("follows the queue's renames: an edit of a feature the branch made, renamed on replay", () => {
    // The other side adds a sketch and an extrude, taking the ids the branch's have.
    const theirSketch = addSketch(base, 50);
    const onto = apply(
      base,
      theirSketch,
      addExtrude(apply(base, theirSketch), 'sketch#3', 'Theirs'),
    );
    const s = addSketch(base, 80);
    const withSketch = apply(base, s);
    const e = addExtrude(withSketch, 'sketch#3', 'Mine');
    const withExtrude = apply(withSketch, e);
    const edit = editExtrude(withExtrude, 'extrude#3', 'Mine, renamed');
    const merged = replay(base, onto, [s, e, edit]);
    expect(feature(merged, 'extrude#3')).toMatchObject({
      name: 'Theirs',
      profile: { sketch: 'sketch#3' },
    });
    expect(feature(merged, 'extrude#4')).toMatchObject({
      name: 'Mine, renamed',
      profile: { sketch: 'sketch#4' },
    });
  });

  it('merges domain data by key, and leaves it whole across schema versions', () => {
    const set = (
      schemaVersion: number,
      data: NonNullable<Extract<Command, { type: 'setDomainData' }>['data']>,
    ): Command => ({
      type: 'setDomainData',
      namespace: 'wood',
      schemaVersion,
      data,
    });
    const start = apply(base, set(1, { a: 1, b: 1 }));
    const onto = apply(start, set(1, { a: 2, b: 1 }));
    expect(replay(start, onto, [set(1, { a: 1, b: 2 })]).domains!.wood!.data).toEqual({
      a: 2,
      b: 2,
    });
    const newer = apply(start, set(2, { a: 2, b: 1 }));
    expect(replay(start, newer, [set(1, { a: 1, b: 2 })]).domains!.wood).toEqual({
      schemaVersion: 1,
      data: { a: 1, b: 2 },
    });
    // Nothing reads it: whole, and the replay says why. A reader that refuses it: whole too.
    const why: string[] = [];
    expect(replay(start, onto, [set(1, { a: 1, b: 2 })], true, why).domains!.wood!.data).toEqual({
      a: 1,
      b: 2,
    });
    expect(why).toEqual([
      'nothing here reads the domain data "wood", so it is not merged by field',
    ]);
    const strict = domainsValidator([
      {
        data: {
          wood: {
            read: (d: { a?: number; b?: number }) =>
              d.a === 2 && d.b === 2 ? { ok: false, message: 'a and b' } : { ok: true },
          },
        },
      },
    ]);
    why.length = 0;
    const refused = replay(start, onto, [set(1, { a: 1, b: 2 })], { validate: strict }, why);
    expect(refused.domains!.wood!.data).toEqual({ a: 1, b: 2 });
    expect(why).toEqual(['the domain data "wood" merged by field does not read (a and b)']);
    // A namespace the command removes, or one that was not there, is replaced as before.
    const remove: Command = { type: 'setDomainData', namespace: 'wood' };
    expect(replay(start, onto, [remove]).domains).toBeUndefined();
  });
});

describe('domainsValidator', () => {
  const domain = {
    data: { wood: { read: () => ({ ok: true }) } },
    types: {
      'wood.board': {
        params: (p: { n?: number }) => (p.n === 1 ? { ok: true } : { ok: false, message: 'n' }),
      },
      'wood.free': {},
    },
  };
  const v = domainsValidator([domain]);

  it('reads by namespace and by type, and knows nothing of the rest', () => {
    expect(v.domainData('wood', {}, 1)).toEqual({ ok: true });
    expect(v.domainData('stock', {}, 1)).toBeUndefined();
    expect(v.extensionParams('wood.board', { n: 1 }, 1)).toEqual({ ok: true });
    expect(v.extensionParams('wood.board', { n: 2 }, 1)).toEqual({ ok: false, message: 'n' });
    expect(v.extensionParams('wood.free', { n: 2 }, 1)).toEqual({ ok: true });
    expect(v.extensionParams('wood.other', {}, 1)).toBeUndefined();
  });
});
