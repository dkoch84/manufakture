import {
  FORMAT_VERSION,
  PROTOCOL_VERSION,
  createdIds,
  documentCounters,
  type Command,
  type ManufaktureDocument,
  type SyncEntry,
} from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { AT, PART, addExtrude, bracket, editExtrude } from './lab';
import { checkVersions } from './protocol';
import { ReferenceServer, judgeEntry, type Outcome } from './server';

function entry(
  doc: ManufaktureDocument,
  command: Command,
  clientSeq: number,
  prevSeq?: number,
  clientId = 'a',
): SyncEntry {
  // A command that does not apply creates nothing (the server must refuse it anyway).
  const created = createdIds(doc, command);
  return {
    clientId,
    clientSeq,
    ...(prevSeq !== undefined && { prevSeq }),
    baseRev: 0,
    format: FORMAT_VERSION,
    cause: 'execute',
    label: command.type,
    command: command as SyncEntry['command'],
    created: (created.ok ? created.value : {}) as SyncEntry['created'],
    at: AT,
  };
}

const setVar = (name: string): Command => ({
  type: 'setVariable',
  name,
  expression: { source: '1', lengthUnit: 'mm', angleUnit: 'deg' },
});

function submit(server: ReferenceServer, entries: SyncEntry[], floor = 1) {
  return server.handle({ type: 'submit', entries, floor });
}

describe('judgeEntry', () => {
  const doc = bracket();
  const ctx = (outcomes: Record<number, Outcome> = {}) => ({
    head: doc,
    highWater: documentCounters(doc),
    outcome: (_: string, seq: number) => outcomes[seq],
  });

  it('answers a recorded entry with its outcome, refusals included', () => {
    const refused: Outcome = { kind: 'refused', error: { code: 'dependency', message: 'x' } };
    expect(judgeEntry(ctx({ 1: refused }), entry(doc, setVar('p'), 1))).toEqual({
      kind: 'recorded',
      outcome: refused,
    });
  });

  it('answers predecessor-unknown before anything else is judged', () => {
    expect(judgeEntry(ctx(), entry(doc, setVar('p'), 2, 1))).toEqual({
      kind: 'predecessor-unknown',
    });
  });

  it('refuses an entry whose predecessor was refused', () => {
    const refused: Outcome = { kind: 'refused', error: { code: 'id-reused', message: 'x' } };
    expect(judgeEntry(ctx({ 1: refused }), entry(doc, setVar('p'), 2, 1))).toMatchObject({
      kind: 'refused',
      error: { code: 'predecessor-refused' },
    });
  });

  it('refuses a newer format, a taken created id, a core error and a counter regression', () => {
    const newer = { ...entry(doc, setVar('p'), 1), format: FORMAT_VERSION + 1 };
    expect(judgeEntry(ctx(), newer)).toMatchObject({ kind: 'refused', error: { code: 'version' } });

    // The created guard: an edit that adds e6 to a sketch whose head has another client's e6.
    const head = (() => {
      const s = doc.parts[0]!.features.find((f) => f.id === 'sketch#1')!;
      if (s.kind !== 'sketch') throw new Error('sketch');
      const line = (x: number) =>
        ({
          type: 'editFeature',
          partId: PART,
          feature: {
            ...s,
            entities: [
              ...s.entities,
              { id: 'e6', kind: 'line', construction: true, start: [x, 0], end: [x, 1] },
            ],
          },
        }) as Command;
      return { theirs: line(1), mine: line(2) };
    })();
    const s = new ReferenceServer(doc);
    expect(submit(s, [entry(doc, head.theirs, 1, undefined, 'b')]).replies[0]).toMatchObject({
      type: 'ack',
    });
    expect(judgeEntry({ ...ctx(), head: s.head }, entry(doc, head.mine, 1))).toMatchObject({
      kind: 'refused',
      error: { code: 'id-reused' },
    });

    expect(
      judgeEntry(
        ctx(),
        entry(doc, { type: 'deleteFeature', partId: PART, featureId: 'sketch#1' }, 1),
      ),
    ).toMatchObject({ kind: 'refused', error: { code: 'dependency' } });

    // A replaced document whose counters are below the high-water mark.
    const low = {
      ...doc,
      parts: doc.parts.map((p) => ({ ...p, nextIds: { ...p.nextIds, extrude: 3 } })),
    };
    const high = {
      ...documentCounters(doc),
      [`part:${PART}`]: { ...documentCounters(doc)[`part:${PART}`], extrude: 9 },
    };
    expect(
      judgeEntry(
        { ...ctx(), highWater: high },
        entry(doc, { type: 'replaceDocument', document: low }, 1),
      ),
    ).toMatchObject({ kind: 'refused', error: { code: 'counter-regression' } });
  });

  it('accepts what core accepts, with the new head and high-water mark', () => {
    const j = judgeEntry(ctx(), entry(doc, addExtrude(doc, 'sketch#1', 'x'), 1));
    expect(j.kind).toBe('accepted');
    if (j.kind === 'accepted') expect(j.highWater[`part:${PART}`]!.extrude).toBe(4);
  });
});

describe('ReferenceServer', () => {
  it('records outcomes, so a resubmission never applies twice', () => {
    const doc = bracket();
    const s = new ReferenceServer(doc);
    const e = entry(doc, addExtrude(doc, 'sketch#1', 'x'), 1);
    const first = submit(s, [e]);
    expect(first.replies).toEqual([{ type: 'ack', clientSeq: 1, rev: 1 }]);
    expect(first.push?.entries).toHaveLength(1);
    const again = submit(s, [e]);
    expect(again.replies).toEqual([{ type: 'ack', clientSeq: 1, rev: 1 }]);
    expect(again.push).toBeUndefined();
    expect(s.revision).toBe(1);
    expect(s.pull(0).entries.map((p) => p.rev)).toEqual([1]);
  });

  it('does not record predecessor-unknown, and judges the entry once its predecessor is known', () => {
    const doc = bracket();
    const s = new ReferenceServer(doc);
    const a = entry(doc, addExtrude(doc, 'sketch#1', 'x'), 1);
    const b = entry(doc, setVar('p'), 2, 1);
    expect(submit(s, [b]).replies).toEqual([{ type: 'predecessor-unknown', clientSeq: 2 }]);
    expect(s.rowCount('a')).toBe(0);
    expect(submit(s, [a, b]).replies.map((r) => r.type)).toEqual(['ack', 'ack']);
  });

  it('keeps a refused row while a doomed follower can still name it (the retention floor)', () => {
    const doc = bracket();
    const s = new ReferenceServer(doc);
    // Another client takes extrude#3 first.
    submit(s, [entry(doc, addExtrude(doc, 'sketch#1', 'o'), 1, undefined, 'o')]);
    const a = entry(doc, addExtrude(doc, 'sketch#1', 'A'), 1);
    const b = entry(doc, editExtrude(doc, 'extrude#1', 'B'), 2, 1);
    // B's submit is lost; A is refused. B is still in flight, so the floor stays 1.
    expect(submit(s, [a], 1).replies[0]).toMatchObject({
      type: 'refuse',
      error: { code: 'id-reused' },
    });
    expect(submit(s, [b], 1).replies[0]).toMatchObject({
      type: 'refuse',
      error: { code: 'predecessor-refused' },
    });
    // Once B has its verdict the floor rises past both; their rows may go.
    const c = entry(s.head, setVar('p'), 3);
    expect(submit(s, [c], 3).replies[0]).toMatchObject({ type: 'ack' });
    expect(s.outcome('a', 1)).toBeUndefined();
    expect(s.outcome('a', 2)).toBeUndefined();
    expect(s.outcome('a', 3)).toMatchObject({ kind: 'accepted' });
    // A late copy of an entry below the floor is never judged again.
    expect(submit(s, [a], 3).replies[0]).toMatchObject({
      type: 'error',
      code: 'below-floor',
      clientSeq: 1,
    });
    // The floor never goes down; the latest accepted entry stays.
    const d = entry(s.head, setVar('q'), 4, 3);
    expect(submit(s, [d], 1).replies[0]).toMatchObject({ type: 'ack' });
    submit(s, [entry(s.head, setVar('r'), 5, 4)], 5);
    expect(s.outcome('a', 4)).toBeUndefined();
    expect(s.outcome('a', 5)).toMatchObject({ kind: 'accepted' });
  });

  it('greets a client of the same versions and refuses newer or older ones with a message', () => {
    const s = new ReferenceServer(bracket());
    const hello = {
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      format: FORMAT_VERSION,
      clientId: 'a',
    };
    expect(s.handle(hello).replies).toEqual([
      { type: 'welcome', protocol: PROTOCOL_VERSION, format: FORMAT_VERSION, head: 0 },
    ]);
    expect(s.handle({ ...hello, protocol: PROTOCOL_VERSION + 1 }).replies[0]).toMatchObject({
      type: 'error',
      code: 'protocol-version',
      message: expect.stringMatching(/upgrade the server/),
    });
    expect(s.handle({ ...hello, format: FORMAT_VERSION - 1 }).replies[0]).toMatchObject({
      type: 'error',
      code: 'format-version',
      message: expect.stringMatching(/update the app/),
    });
  });

  it('refuses invalid messages without touching anything', () => {
    const doc = bracket();
    const s = new ReferenceServer(doc);
    expect(s.handle({ type: 'submit', entries: [], floor: 1 }).replies[0]).toMatchObject({
      type: 'error',
      code: 'invalid-message',
    });
    const mixed = [entry(doc, setVar('p'), 1), entry(doc, setVar('q'), 1, undefined, 'b')];
    expect(s.handle({ type: 'submit', entries: mixed, floor: 1 }).replies[0]).toMatchObject({
      code: 'invalid-message',
    });
    const bad = { ...entry(doc, setVar('p'), 1), extra: true };
    expect(s.handle({ type: 'submit', entries: [bad], floor: 1 }).replies[0]).toMatchObject({
      code: 'invalid-message',
    });
    expect(s.handle('nonsense').replies[0]).toMatchObject({ code: 'invalid-message' });
    expect(s.revision).toBe(0);
  });
});

describe('checkVersions', () => {
  it('passes equal versions only', () => {
    const v = { protocol: 1, format: 15 };
    expect(checkVersions(v, v)).toBeUndefined();
    expect(checkVersions({ protocol: 1, format: 16 }, v)?.code).toBe('format-version');
    expect(checkVersions({ protocol: 0, format: 15 }, v)?.code).toBe('protocol-version');
  });
});
