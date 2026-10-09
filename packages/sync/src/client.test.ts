import { FORMAT_VERSION, type Command, type ManufaktureDocument } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { SyncClient, type SyncClientEvents } from './client';
import {
  AT,
  Lab,
  PART,
  addExtrude,
  addSketch,
  editExtrude,
  feature,
  isPush,
  verdictOf,
} from './lab';
import {
  PUSH_WINDOW,
  SUBMIT_OVERHEAD,
  jsonBytes,
  type PushedEntry,
  type ServerMessage,
  type SubmitMessage,
} from './protocol';

function submitted(lab: Lab, id: string): { label: string; clientSeq: number; prevSeq?: number }[] {
  return lab.sent
    .get(id)!
    .filter((m): m is SubmitMessage => m.type === 'submit')
    .flatMap((m) =>
      m.entries.map((e) => ({
        label: e.label,
        clientSeq: e.clientSeq,
        ...(e.prevSeq !== undefined && { prevSeq: e.prevSeq }),
      })),
    );
}

function ok<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const setVar = (name: string, source: string): Command => ({
  type: 'setVariable',
  name,
  expression: { source, lengthUnit: 'mm', angleUnit: 'deg' },
});

/** Save, through JSON, and restore with the confirmed document saved beside the state. */
function reload(c: SyncClient): SyncClient {
  const state = JSON.parse(JSON.stringify(c.save())) as unknown;
  const doc = JSON.parse(JSON.stringify(c.confirmedDocument)) as ManufaktureDocument;
  return ok(SyncClient.restore(state, doc, { now: () => AT }));
}

function events(c: SyncClient) {
  const remapped: SyncClientEvents['remapped'][] = [];
  const dropped: SyncClientEvents['dropped'][] = [];
  c.on('remapped', (e) => remapped.push(e));
  c.on('dropped', (e) => dropped.push(e));
  return { remapped, dropped };
}

describe('SyncClient: concurrent adds of one id', () => {
  it('two clients that add extrude#3 end with two extrudes; the loser is renamed and resent', () => {
    const lab = new Lab();
    const a = lab.add('a');
    const b = lab.add('b');
    const ev = events(a);
    ok(b.submit({ command: addExtrude(b.document, 'sketch#1', 'B'), label: 'B' }));
    lab.send('b');
    ok(a.submit({ command: addExtrude(a.document, 'sketch#2', 'A'), label: 'add A' }));
    // A later entry of the loser that edits its own extrude#3, sent before the verdicts.
    ok(a.submit({ command: editExtrude(a.document, 'extrude#3', 'A edited'), label: 'edit A' }));
    lab.send('a');
    // Refused as id-reused and predecessor-refused.
    expect(lab.server.outcome('a', 1)).toMatchObject({ error: { code: 'id-reused' } });
    expect(lab.server.outcome('a', 2)).toMatchObject({ error: { code: 'predecessor-refused' } });
    const never = () => {
      expect(feature(a.document, 'extrude#3')?.name).not.toBe('A edited');
      expect(feature(lab.server.head, 'extrude#3')?.name).toBe('B');
    };
    while (lab.inbox.get('a')!.length > 0) {
      lab.deliver('a', (m) => m === lab.inbox.get('a')![0]);
      never();
      lab.send('a');
    }
    lab.settle();
    never();
    expect(feature(lab.server.head, 'extrude#4')).toMatchObject({ name: 'A edited' });
    expect(feature(a.document, 'extrude#4')).toMatchObject({ name: 'A edited' });
    expect(b.document).toEqual(lab.server.head);
    // Resubmitted under new clientSeqs.
    expect(submitted(lab, 'a')).toEqual([
      { label: 'add A', clientSeq: 1 },
      { label: 'edit A', clientSeq: 2, prevSeq: 1 },
      { label: 'add A', clientSeq: 3 },
      { label: 'edit A', clientSeq: 4, prevSeq: 3 },
    ]);
    expect(ev.remapped[0]?.table).toEqual({ [`part:${PART}`]: { 'extrude#3': 'extrude#4' } });
    expect(ev.dropped).toEqual([]);
  });

  it('matches its own entry in the push stream when the ack is lost, and never renames it', () => {
    const lab = new Lab();
    const a = lab.add('a');
    const b = lab.add('b');
    const ev = events(a);
    ok(b.submit({ command: addSketch(b.document, 100), label: 'B sketch' }));
    lab.send('b');
    ok(a.submit({ command: addExtrude(a.document, 'sketch#1', 'A'), label: 'A' }));
    const sent = a.pending[0]!.sent;
    lab.send('a');
    expect(lab.drop('a', verdictOf(1))).toHaveLength(1);
    // The foreign entry (rev 1) arrives before the client's own (rev 2).
    lab.deliver('a', isPush);
    expect(a.pending).toEqual([]);
    expect(a.confirmedRevision).toBe(2);
    expect(lab.server.log[1]!.entry.command).toEqual(sent);
    expect(ev.remapped).toEqual([]);
    expect(a.document).toEqual(lab.server.head);
  });
});

describe('SyncClient: lost replies', () => {
  it('a resubmission after a lost ack applies once', () => {
    const lab = new Lab();
    const a = lab.add('a');
    ok(a.submit({ command: setVar('p', '2'), label: 'p' }));
    lab.send('a');
    lab.drop('a', () => true);
    lab.send('a', a.retry());
    expect(lab.server.revision).toBe(1);
    lab.settle();
    // The ack came back but the push was lost too: the next retry pulls.
    expect(a.pending.map((e) => e.state)).toEqual(['in-flight']);
    lab.send('a', a.retry());
    lab.settle();
    expect(lab.server.revision).toBe(1);
    expect(a.pending).toEqual([]);
    expect(a.stats.resubmits).toBe(1);
  });

  it('a resubmission after a lost refusal gets the same refusal', () => {
    const lab = new Lab();
    const a = lab.add('a');
    const b = lab.add('b');
    ok(b.submit({ command: addExtrude(b.document, 'sketch#1', 'B'), label: 'B' }));
    lab.send('b');
    ok(a.submit({ command: addExtrude(a.document, 'sketch#1', 'A'), label: 'A' }));
    lab.send('a');
    const first = lab.drop('a', verdictOf(1));
    lab.send('a', a.retry());
    const second = lab.drop('a', verdictOf(1));
    expect(second).toEqual(first);
    expect(first[0]).toMatchObject({ type: 'refuse', error: { code: 'id-reused' } });
  });
});

describe('SyncClient: id-reused with a delayed push stream', () => {
  it('pulls up to the head the refusal carries before renaming, so A is not refused again', () => {
    const lab = new Lab();
    const a = lab.add('a');
    const b = lab.add('b');
    ok(b.submit({ command: addExtrude(b.document, 'sketch#1', 'B1'), label: 'B1' }));
    lab.send('b');
    lab.deliver('b');
    ok(b.submit({ command: addExtrude(b.document, 'sketch#1', 'B2'), label: 'B2' }));
    lab.send('b');
    ok(a.submit({ command: addExtrude(a.document, 'sketch#2', 'A'), label: 'A' }));
    lab.send('a');
    // The pushes of B1 and B2 are delayed: only the refusal arrives.
    lab.deliver('a', verdictOf(1));
    expect(a.pending[0]!.state).toBe('id-reused');
    const out = a.takeOutgoing();
    expect(out).toEqual([{ type: 'pull', since: 0 }]);
    lab.send('a', out);
    const box = lab.inbox.get('a')!;
    lab.deliver('a', (m) => m === box[box.length - 1]);
    expect(a.confirmedRevision).toBe(2);
    lab.send('a');
    lab.settle();
    expect(lab.server.outcome('a', 2)).toEqual({ kind: 'accepted', rev: 3 });
    expect(feature(lab.server.head, 'extrude#5')).toMatchObject({ name: 'A' });
  });
});

/**
 * ADR 0009 decision 2's worked example: P accepted; A adds extrude#3, B edits it, C comes after B,
 * all in flight; another client's extrude#3 is accepted first.
 */
function chain(order: 'a-first' | 'bc-first' | 'reload') {
  const lab = new Lab();
  let a = lab.add('a');
  const o = lab.add('o');
  ok(a.submit({ command: setVar('p', '1'), label: 'P' }));
  lab.settle();
  ok(o.submit({ command: addExtrude(o.document, 'sketch#1', 'O'), label: 'O' }));
  lab.send('o');
  ok(a.submit({ command: addExtrude(a.document, 'sketch#2', 'A'), label: 'A' }));
  ok(a.submit({ command: editExtrude(a.document, 'extrude#3', 'B'), label: 'B' }));
  ok(a.submit({ command: setVar('c', '3'), label: 'C' }));
  lab.send('a');
  const never = () => {
    expect(feature(a.document, 'extrude#3')?.name).toBe(a.confirmedRevision >= 2 ? 'O' : undefined);
    expect(feature(lab.server.head, 'extrude#3')?.name).toBe('O');
  };
  const step = (match: (m: ServerMessage) => boolean) => {
    expect(lab.deliver('a', match)).toHaveLength(1);
    never();
    lab.send('a');
    never();
  };
  step(isPush);
  if (order === 'bc-first') {
    step(verdictOf(3));
    step(verdictOf(4));
    expect(a.pending.map((e) => e.state)).toEqual([
      'doomed',
      'predecessor-refused',
      'predecessor-refused',
    ]);
    step(verdictOf(2));
  } else {
    step(verdictOf(2));
    // A' is sent before B's and C's verdicts, ahead of them, naming P.
    expect(a.pending.map((e) => [e.label, e.state, e.clientSeq])).toEqual([
      ['A', 'in-flight', 5],
      ['B', 'doomed', 3],
      ['C', 'doomed', 4],
    ]);
    if (order === 'reload') {
      a = reload(a);
      lab.replace('a', a);
      never();
    }
    step(verdictOf(3));
    step(verdictOf(4));
  }
  lab.settle();
  never();
  expect(feature(lab.server.head, 'extrude#4')).toMatchObject({ name: 'B' });
  expect(lab.server.head.variables.map((v) => v.name)).toContain('c');
  expect(a.document).toEqual(lab.server.head);
  return submitted(lab, 'a').filter((s) => s.clientSeq > 4);
}

describe('SyncClient: A, B and C in flight when A is refused as id-reused', () => {
  const expected = [
    { label: 'A', clientSeq: 5, prevSeq: 1 },
    { label: 'B', clientSeq: 6, prevSeq: 5 },
    { label: 'C', clientSeq: 7, prevSeq: 6 },
  ];

  it("sends A' first, holds B and C until their verdicts, and they land after it", () => {
    expect(chain('a-first')).toEqual(expected);
  });

  it("gives A', B' and C' the same sequences when B's and C's verdicts arrive first", () => {
    expect(chain('bc-first')).toEqual(expected);
  });

  it("survives a reload after A's refusal and before B's verdict", () => {
    expect(chain('reload')).toEqual(expected);
  });
});

describe('SyncClient: predecessor-unknown', () => {
  it('keeps the entry in flight and resends it after its predecessor, which gets its verdict', () => {
    const lab = new Lab();
    const a = lab.add('a');
    const o = lab.add('o');
    ok(o.submit({ command: addExtrude(o.document, 'sketch#1', 'O'), label: 'O' }));
    lab.send('o');
    ok(a.submit({ command: addExtrude(a.document, 'sketch#2', 'A'), label: 'A' }));
    ok(a.submit({ command: editExtrude(a.document, 'extrude#3', 'B'), label: 'B' }));
    const [submit] = a.takeOutgoing() as [SubmitMessage];
    // A's request is lost; B's arrives.
    lab.send('a', [{ ...submit, entries: [submit.entries[1]!] }]);
    expect(lab.inbox.get('a')!.at(-1)).toEqual({ type: 'predecessor-unknown', clientSeq: 2 });
    expect(lab.server.outcome('a', 2)).toBeUndefined();
    expect(lab.server.rowCount('a')).toBe(0);
    lab.deliver('a', verdictOf(2));
    expect(a.pending.map((e) => e.state)).toEqual(['in-flight', 'in-flight']);
    const again = a.takeOutgoing();
    expect(again).toMatchObject([
      { type: 'submit', entries: [{ clientSeq: 1 }, { clientSeq: 2 }] },
    ]);
    lab.send('a', again);
    expect(lab.server.outcome('a', 1)).toMatchObject({ error: { code: 'id-reused' } });
    expect(lab.server.outcome('a', 2)).toMatchObject({ error: { code: 'predecessor-refused' } });
    lab.settle();
    expect(feature(lab.server.head, 'extrude#3')).toMatchObject({ name: 'O' });
    expect(feature(lab.server.head, 'extrude#4')).toMatchObject({ name: 'B' });
  });
});

describe('SyncClient: undo', () => {
  it('refuses the inverse of an in-flight command with it, and removes it when the command is dropped', () => {
    const lab = new Lab();
    const a = lab.add('a');
    const o = lab.add('o');
    ok(o.submit({ command: addSketch(o.document, 200), label: 'sketch 3' }));
    lab.settle();
    ok(
      o.submit({
        command: { type: 'deleteFeature', partId: PART, featureId: 'sketch#3' },
        label: 'delete',
      }),
    );
    lab.send('o');
    const ev = events(a);
    ok(a.submit({ command: addExtrude(a.document, 'sketch#3', 'A'), label: 'A' }));
    lab.send('a');
    expect(a.undo()).toEqual({ ok: true });
    expect(a.pending.map((e) => [e.cause, e.clientSeq, e.prevSeq])).toEqual([
      ['execute', 1, undefined],
      ['undo', 2, 1],
    ]);
    lab.send('a');
    expect(lab.server.outcome('a', 2)).toMatchObject({ error: { code: 'predecessor-refused' } });
    lab.settle();
    expect(ev.dropped.flatMap((d) => d.drops.map((x) => x.label))).toEqual(['A']);
    expect(a.pending).toEqual([]);
    expect(a.stats).toMatchObject({ made: 2, landed: 0, dropped: 1, withdrawn: 1 });
    expect(a.redoStatus()).toBe('empty');
    expect(a.document).toEqual(lab.server.head);
  });

  it('hides a held entry from the undo stack and waits; it returns with its renamed inverse', () => {
    const lab = new Lab();
    const a = lab.add('a');
    const o = lab.add('o');
    ok(a.submit({ command: setVar('x', '1'), label: 'X' }));
    lab.settle();
    ok(o.submit({ command: addExtrude(o.document, 'sketch#1', 'O'), label: 'O' }));
    lab.send('o');
    ok(a.submit({ command: addExtrude(a.document, 'sketch#2', 'A'), label: 'A' }));
    lab.send('a');
    lab.deliver('a', isPush);
    expect(a.pending[0]!.state).toBe('doomed');
    expect(a.visibleUndo().map((u) => u.label)).toEqual(['X']);
    expect(a.undoStatus()).toBe('waiting');
    expect(a.undo()).toEqual({ ok: false, reason: 'waiting' });
    lab.deliver('a', verdictOf(2));
    expect(a.undoStatus()).toBe('ready');
    expect(a.visibleUndo().map((u) => u.label)).toEqual(['X', 'A']);
    expect(a.undoLabel).toBe('A');
    expect(a.undo()).toEqual({ ok: true });
    expect(a.pending.at(-1)!.command).toEqual({
      type: 'deleteFeature',
      partId: PART,
      featureId: 'extrude#4',
    });
    lab.settle();
    expect(feature(lab.server.head, 'extrude#3')).toMatchObject({ name: 'O' });
    expect(feature(lab.server.head, 'extrude#4')).toBeUndefined();
    expect(a.undoLabel).toBe('X');
  });

  it('undoes the renamed feature after a remap, unsent or confirmed', () => {
    const lab = new Lab();
    const a = lab.add('a', { online: false });
    const o = lab.add('o');
    const ev = events(a);
    ok(a.submit({ command: addExtrude(a.document, 'sketch#2', 'A'), label: 'A' }));
    ok(o.submit({ command: addExtrude(o.document, 'sketch#1', 'O'), label: 'O' }));
    lab.send('o');
    lab.deliver('a');
    expect(ev.remapped.map((e) => e.table)).toEqual([
      { [`part:${PART}`]: { 'extrude#3': 'extrude#4' } },
    ]);
    // Unsent: undo removes it, redo makes it again under its new id.
    expect(a.undo()).toEqual({ ok: true });
    expect(feature(a.document, 'extrude#4')).toBeUndefined();
    expect(a.redo()).toEqual({ ok: true });
    expect(feature(a.document, 'extrude#4')).toMatchObject({ name: 'A' });
    a.setOnline(true);
    lab.settle();
    expect(feature(lab.server.head, 'extrude#4')).toMatchObject({ name: 'A' });
    // Confirmed: the inverse names extrude#4, never the other client's extrude#3.
    expect(a.undo()).toEqual({ ok: true });
    lab.settle();
    expect(feature(lab.server.head, 'extrude#4')).toBeUndefined();
    expect(feature(lab.server.head, 'extrude#3')).toMatchObject({ name: 'O' });
  });

  it('refuses to undo a command another client changed since (selective undo)', () => {
    const lab = new Lab();
    const a = lab.add('a');
    const o = lab.add('o');
    ok(a.submit({ command: editExtrude(a.document, 'extrude#1', 'mine'), label: 'rename' }));
    lab.settle();
    ok(o.submit({ command: editExtrude(o.document, 'extrude#1', 'theirs'), label: 'theirs' }));
    lab.settle();
    expect(a.undo()).toEqual({
      ok: false,
      reason: 'changed',
      message: 'rename was changed by another edit',
    });
    expect(feature(a.document, 'extrude#1')).toMatchObject({ name: 'theirs' });
  });

  it('undoes a confirmed command nobody else touched', () => {
    const lab = new Lab();
    const a = lab.add('a');
    const o = lab.add('o');
    ok(a.submit({ command: editExtrude(a.document, 'extrude#1', 'mine'), label: 'rename' }));
    lab.settle();
    ok(o.submit({ command: editExtrude(o.document, 'extrude#2', 'theirs'), label: 'theirs' }));
    lab.settle();
    expect(a.undo()).toEqual({ ok: true });
    lab.settle();
    expect(feature(lab.server.head, 'extrude#1')).toMatchObject({ name: 'Extrude 1' });
    expect(feature(lab.server.head, 'extrude#2')).toMatchObject({ name: 'theirs' });
  });
});

describe('SyncClient: versions', () => {
  it('stops at a server that speaks a newer protocol or format, with a message', () => {
    const lab = new Lab();
    const a = lab.add('a');
    const seen: string[] = [];
    a.on('incompatible', (e) => seen.push(e.code));
    const r = a.handle({ type: 'welcome', protocol: 99, format: 15, head: 0 });
    expect(r).toMatchObject({ ok: false, error: { code: 'version' } });
    expect(a.incompatibility?.message).toMatch(/upgrade the app|update the app/);
    expect(seen).toEqual(['protocol-version']);
    ok(a.submit({ command: setVar('p', '1'), label: 'p' }));
    expect(a.takeOutgoing()).toEqual([]);
  });

  it('pulls up to the head a welcome announces', () => {
    const lab = new Lab();
    const o = lab.add('o');
    ok(o.submit({ command: setVar('p', '1'), label: 'p' }));
    lab.settle();
    const a = lab.add('a');
    const late = new SyncClient(a.confirmedDocument, 0, { clientId: 'late', now: () => AT });
    expect(late.handle(lab.server.handle(late.hello()).replies[0])).toEqual({
      ok: true,
      value: undefined,
    });
    expect(late.takeOutgoing()).toEqual([{ type: 'pull', since: 0 }]);
  });

  it('refuses an invalid server message', () => {
    const a = new Lab().add('a');
    expect(a.handle({ type: 'push', entries: [{ rev: 0 }] })).toMatchObject({
      ok: false,
      error: { code: 'schema' },
    });
    expect(a.handle({ type: 'nope' }).ok).toBe(false);
  });
});

describe('SyncClient: saved queue state', () => {
  it('saves plain JSON that restores to the same state, and refuses a broken one', () => {
    const lab = new Lab();
    const a = lab.add('a');
    ok(a.submit({ command: setVar('p', '1'), label: 'p' }));
    ok(a.submit({ command: addExtrude(a.document, 'sketch#1', 'A'), label: 'A' }));
    const b = reload(a);
    expect(b.save()).toEqual(a.save());
    expect(b.document).toEqual(a.document);
    expect(SyncClient.restore({ ...a.save(), version: 2 }, a.confirmedDocument).ok).toBe(false);
    expect(SyncClient.restore({}, a.confirmedDocument)).toMatchObject({
      ok: false,
      error: { code: 'schema' },
    });
  });

  it('sends the retention floor: the lowest sequence an in-flight entry names', () => {
    const lab = new Lab();
    const a = lab.add('a');
    ok(a.submit({ command: setVar('p', '1'), label: 'p' }));
    lab.settle();
    ok(a.submit({ command: setVar('q', '1'), label: 'q' }));
    ok(a.submit({ command: setVar('r', '1'), label: 'r' }));
    expect(a.takeOutgoing()).toMatchObject([{ type: 'submit', floor: 1 }]);
  });
});

/** A pushed entry of another client at `rev` carrying `command`, built from a real log entry. */
function foreign(
  template: PushedEntry,
  rev: number,
  command: Command,
  clientSeq = rev,
): PushedEntry {
  return {
    rev,
    entry: { ...template.entry, clientId: 'x', clientSeq, command: command as never },
  };
}

describe('SyncClient: a server log that disagrees', () => {
  it('a pushed entry that does not apply stops the client without throwing, and saves a consistent state', () => {
    const lab = new Lab();
    const o = lab.add('o');
    const a = lab.add('a');
    ok(o.submit({ command: setVar('p', '1'), label: 'p' }));
    lab.settle();
    const template = lab.server.log.at(-1)!;
    ok(a.submit({ command: setVar('mine', '5'), label: 'mine' }));
    const seen: string[] = [];
    a.on('incompatible', (e) => seen.push(e.code));
    const good = foreign(template, 2, setVar('q', '2'));
    const bad = foreign(template, 3, editExtrude(a.confirmedDocument, 'extrude#1', 'x'));
    const broken = {
      ...bad,
      entry: { ...bad.entry, command: { type: 'deleteVariable', name: 'zz' } },
    };
    const after = foreign(template, 4, setVar('r', '3'));
    let r: ReturnType<SyncClient['handle']> | undefined;
    expect(() => {
      r = a.handle({ type: 'push', entries: [after, broken, good] });
    }).not.toThrow();
    expect(r).toMatchObject({ ok: false, error: { code: 'version' } });
    expect(seen).toEqual(['server-fault']);
    expect(a.incompatibility?.message).toMatch(/Confirmed entry 3 does not apply/);
    // What applied before the bad entry is confirmed, and the queue was rebased onto it.
    expect(a.confirmedRevision).toBe(2);
    expect(a.document.variables.map((v) => v.name)).toEqual(
      expect.arrayContaining(['p', 'q', 'mine']),
    );
    const saved = a.save();
    expect(saved.buffered).toEqual([]);
    expect(saved.confirmedRev).toBe(2);
    // Later pushes return an error; nothing throws.
    expect(a.handle({ type: 'push', entries: [broken] }).ok).toBe(false);
    // The saved state restores, consistent with its confirmed document; the bad entry is gone.
    const b = reload(a);
    expect(b.document).toEqual(a.document);
    expect(b.save()).toEqual(saved);
    const again = b.handle({ type: 'push', entries: [broken] });
    expect(again).toMatchObject({ ok: false, error: { code: 'version' } });
    expect(b.confirmedRevision).toBe(2);
    expect(b.save().buffered).toEqual([]);
  });

  it('treats its own entry coming back with another command as a server fault', () => {
    const lab = new Lab();
    const a = lab.add('a');
    ok(a.submit({ command: setVar('p', '1'), label: 'p' }));
    lab.send('a');
    const push = lab.inbox.get('a')!.find(isPush)!;
    lab.drop('a', isPush);
    const forged = structuredClone(push) as { type: 'push'; entries: PushedEntry[] };
    forged.entries[0] = {
      ...forged.entries[0]!,
      entry: { ...forged.entries[0]!.entry, command: setVar('p', '999') as never },
    };
    expect(a.handle(forged)).toMatchObject({ ok: false, error: { code: 'version' } });
    expect(a.incompatibility?.code).toBe('server-fault');
    expect(a.confirmedRevision).toBe(0);
    // The real copy, with its keys in another order, still matches.
    const c = lab.add('c');
    ok(c.submit({ command: setVar('q', '1'), label: 'q' }));
    lab.send('c');
    const real = lab.inbox.get('c')!.find(isPush)! as { type: 'push'; entries: PushedEntry[] };
    lab.drop('c', isPush);
    const e = real.entries[0]!;
    const reordered = Object.fromEntries(Object.entries(e.entry.command).reverse());
    const r = c.handle({ ...real, entries: [{ ...e, entry: { ...e.entry, command: reordered } }] });
    expect(r).toEqual({ ok: true, value: undefined });
    expect(c.pending).toEqual([]);
  });
});

describe('SyncClient: bounded server revisions', () => {
  it('does not buffer pushed entries beyond the window, pulls instead, and never overflows', () => {
    const lab = new Lab();
    const o = lab.add('o');
    const a = lab.add('a');
    ok(o.submit({ command: setVar('p', '1'), label: 'p' }));
    lab.send('o');
    const template = lab.server.log.at(-1)!;
    expect(a.receive([foreign(template, Number.MAX_SAFE_INTEGER, setVar('z', '1'))])).toEqual({
      ok: true,
      value: undefined,
    });
    expect(a.save().buffered).toEqual([]);
    expect(a.takeOutgoing()).toEqual([{ type: 'pull', since: 0 }]);
    // Far more entries than any message carries, all ahead of a gap: bounded, no RangeError.
    const many: PushedEntry[] = [];
    for (let rev = 2; rev <= PUSH_WINDOW * 7; rev += 1)
      many.push(foreign(template, rev, setVar('z', '1')));
    expect(() => a.receive(many)).not.toThrow();
    expect(a.save().buffered).toHaveLength(PUSH_WINDOW - 1);
    // The gap filled, the buffered entries apply in order.
    lab.deliver('a');
    expect(a.confirmedRevision).toBe(PUSH_WINDOW);
    expect(a.save().buffered).toEqual([]);
  });

  it("clamps a refusal's headRev, a welcome's head and an ack's rev to the window", () => {
    const lab = new Lab();
    const a = lab.add('a');
    ok(a.submit({ command: setVar('p', '1'), label: 'p' }));
    ok(a.submit({ command: setVar('q', '1'), label: 'q' }));
    a.takeOutgoing();
    const { protocol, format } = a.hello();
    a.handle({ type: 'welcome', protocol, format, head: Number.MAX_SAFE_INTEGER });
    a.handle({ type: 'ack', clientSeq: 1, rev: Number.MAX_SAFE_INTEGER });
    a.handle({
      type: 'refuse',
      clientSeq: 2,
      error: { code: 'dependency', message: 'no' },
      headRev: Number.MAX_SAFE_INTEGER,
    });
    // The ack's revision is kept as sent and clamped where it is used.
    a.retry();
    const s = a.save();
    expect(s.entries[1]!.verdict?.headRev).toBe(PUSH_WINDOW);
    expect(s.pullWanted).toBe(PUSH_WINDOW);
    expect(s.pullRequested).toBe(PUSH_WINDOW);
    expect(SyncClient.restore(s, a.confirmedDocument).ok).toBe(true);
  });

  it('pulls on, window by window, toward a head further away than one window', () => {
    const lab = new Lab();
    const o = lab.add('o');
    const a = lab.add('a');
    ok(o.submit({ command: setVar('p', '1'), label: 'p' }));
    lab.send('o');
    const template = lab.server.log.at(-1)!;
    const { protocol, format } = a.hello();
    a.handle({ type: 'welcome', protocol, format, head: PUSH_WINDOW * 2 });
    expect(a.takeOutgoing()).toEqual([{ type: 'pull', since: 0 }]);
    const window: PushedEntry[] = [];
    for (let rev = 1; rev <= PUSH_WINDOW; rev += 1)
      window.push(foreign(template, rev, setVar('z', String(rev))));
    ok(a.receive(window));
    expect(a.confirmedRevision).toBe(PUSH_WINDOW);
    expect(a.takeOutgoing()).toEqual([{ type: 'pull', since: PUSH_WINDOW }]);
  });

  it('pulls again after an entry it cannot read, with nothing else buffered', () => {
    const lab = new Lab();
    const o = lab.add('o');
    const a = lab.add('a');
    const b = lab.add('b');
    ok(o.submit({ command: setVar('p', '1'), label: 'p' }));
    lab.send('o');
    const template = lab.server.log.at(-1)!;
    const unreadable: PushedEntry = {
      rev: 1,
      entry: { ...template.entry, format: 9999 },
    };
    const later = foreign(template, 2, setVar('q', '1'));
    const r = a.receive([unreadable, later]);
    expect(r.ok).toBe(false);
    expect(a.incompatibility).toBeUndefined();
    // The buffer is cleared, so the saved state holds nothing that cannot apply.
    const s = a.save();
    expect(s.buffered).toEqual([]);
    expect(s.confirmedRev).toBe(0);
    expect(a.takeOutgoing()).toEqual([{ type: 'pull', since: 0 }]);
    expect(SyncClient.restore(s, a.confirmedDocument).ok).toBe(true);
    // Only the unreadable entry, nothing buffered behind it: a pull is still queued.
    expect(b.receive([unreadable]).ok).toBe(false);
    expect(b.save().buffered).toEqual([]);
    expect(b.takeOutgoing()).toEqual([{ type: 'pull', since: 0 }]);
  });
});

describe('SyncClient: its own sequence from the server', () => {
  it('treats a pushed entry with its own clientId and a sequence it never sent as a server fault', () => {
    const lab = new Lab();
    const o = lab.add('o');
    const a = lab.add('a');
    ok(o.submit({ command: setVar('p', '1'), label: 'p' }));
    lab.send('o');
    const template = lab.server.log.at(-1)!;
    ok(a.submit({ command: setVar('mine', '1'), label: 'mine' }));
    const forged: PushedEntry = {
      rev: 1,
      entry: { ...template.entry, clientId: 'a', clientSeq: 9e15 },
    };
    expect(a.handle({ type: 'push', entries: [forged] })).toMatchObject({
      ok: false,
      error: { code: 'version' },
    });
    expect(a.incompatibility?.code).toBe('server-fault');
    expect(a.confirmedRevision).toBe(0);
    const s = a.save();
    expect(s.latestAccepted).toBeUndefined();
    const b = reload(a);
    expect(b.document).toEqual(a.document);
    expect(b.save()).toEqual(s);
  });
});

describe('SyncClient: a saved state from an older format', () => {
  /** A current document written the way format 13 wrote it (no CAM, no script library). */
  function asV13(doc: ManufaktureDocument): Record<string, unknown> {
    const out = structuredClone(doc) as unknown as Record<string, unknown>;
    delete out.cam;
    delete out.scripts;
    out.version = 13;
    return out;
  }

  it('resends an in-flight replaceDocument under the current format, migrated once', () => {
    const lab = new Lab();
    const a = lab.add('a');
    const replaced = { ...a.document, name: 'Replaced' };
    ok(a.submit({ command: { type: 'replaceDocument', document: replaced }, label: 'replace' }));
    a.takeOutgoing(); // Sent, and lost.
    const s = structuredClone(a.save());
    s.format = 13;
    const old = { type: 'replaceDocument', document: asV13(replaced) };
    s.entries[0]!.command = structuredClone(old);
    s.entries[0]!.wire!.command = structuredClone(old);
    s.entries[0]!.wire!.format = 13;
    const b = ok(SyncClient.restore(s, a.confirmedDocument, { now: () => AT }));
    lab.replace('a', b);
    const sent = b.retry().filter((m): m is SubmitMessage => m.type === 'submit');
    expect(sent.flatMap((m) => m.entries.map((e) => e.format))).toEqual([FORMAT_VERSION]);
    lab.send('a', sent);
    expect(lab.server.outcome('a', 1)).toMatchObject({ kind: 'accepted' });
    lab.settle();
    expect(b.pending).toEqual([]);
    expect(b.document.name).toBe('Replaced');
    expect(lab.server.head.name).toBe('Replaced');
    expect(b.save().format).toBe(FORMAT_VERSION);
  });
});

describe('SyncClient: restoring a saved state checks it', () => {
  function base() {
    const a = new Lab().add('a');
    ok(a.submit({ command: setVar('p', '1'), label: 'p' }));
    ok(a.submit({ command: setVar('q', '1'), label: 'q' }));
    ok(a.submit({ command: setVar('p', '2'), label: 'p again' }));
    return a;
  }
  const refused = (a: SyncClient, edit: (s: ReturnType<SyncClient['save']>) => void) => {
    const s = structuredClone(a.save());
    edit(s);
    return SyncClient.restore(s, a.confirmedDocument);
  };

  it('accepts the state as saved', () => {
    const a = base();
    expect(SyncClient.restore(a.save(), a.confirmedDocument).ok).toBe(true);
  });

  it.each([
    ['duplicate local ids', (s: ReturnType<SyncClient['save']>) => (s.entries[1]!.local = 1)],
    ['a clientSeq not below nextSeq', (s: ReturnType<SyncClient['save']>) => (s.nextSeq = 2)],
    [
      'a pull past the window',
      (s: ReturnType<SyncClient['save']>) => (s.pullWanted = s.confirmedRev + PUSH_WINDOW + 1),
    ],
    [
      'a requested pull past the window',
      (s: ReturnType<SyncClient['save']>) => (s.pullRequested = Number.MAX_SAFE_INTEGER),
    ],
    [
      'a verdict waiting past the window',
      (s: ReturnType<SyncClient['save']>) =>
        (s.entries[0]!.verdict = { code: 'dependency', message: 'no', headRev: 9e15 }),
    ],
    [
      'an undoOf that is not before the entry',
      (s: ReturnType<SyncClient['save']>) => (s.entries[0]!.undoOf = 3),
    ],
    [
      'a sent command that does not validate',
      (s: ReturnType<SyncClient['save']>) => (s.entries[0]!.wire!.command = { type: 'nope' }),
    ],
    [
      'an undo inverse that does not validate',
      (s: ReturnType<SyncClient['save']>) =>
        s.undo.push({
          local: 1,
          label: 'x',
          inverse: { type: 'setVariable' },
          touched: [],
          foreignChanged: false,
          confirmed: true,
        }),
    ],
  ])('refuses %s', (_name, edit) => {
    expect(refused(base(), edit).ok).toBe(false);
  });

  it('accepts a held command that names a tombstone', () => {
    const a = new Lab().add('a', { online: false });
    ok(a.submit({ command: addExtrude(a.document, 'sketch#1', 'A'), label: 'A' }));
    const s = structuredClone(a.save());
    s.entries[0]!.state = 'held';
    const command = s.entries[0]!.command as unknown as { feature: { id: string } };
    command.feature.id = 'extrude#0';
    const r = SyncClient.restore(s, a.confirmedDocument, { online: false });
    expect(r.ok).toBe(true);
  });
});

describe('SyncClient: T7.1e additions', () => {
  it('emits landed with the revision its own entry was confirmed at', () => {
    const lab = new Lab();
    const o = lab.add('o');
    const a = lab.add('a');
    const landed: SyncClientEvents['landed'][] = [];
    a.on('landed', (e) => landed.push(e));
    ok(o.submit({ command: setVar('p', '1'), label: 'p' }));
    lab.send('o');
    const { local } = ok(a.submit({ command: setVar('q', '2'), label: 'q' }));
    lab.settle();
    expect(landed).toEqual([{ local, clientSeq: 1, rev: 2 }]);
    // The server's document at that revision holds it.
    expect(lab.server.head.variables.map((v) => v.name)).toContain('q');
  });

  it('keeps a requested pull across a restore: no second pull, and retry asks again', () => {
    const lab = new Lab();
    const o = lab.add('o');
    const a = lab.add('a');
    ok(o.submit({ command: setVar('p', '1'), label: 'p' }));
    lab.send('o');
    const { protocol, format } = a.hello();
    a.handle({ type: 'welcome', protocol, format, head: 1 });
    expect(a.takeOutgoing()).toEqual([{ type: 'pull', since: 0 }]);
    const saved = a.save();
    expect(saved.pullRequested).toBe(1);
    const back = reload(a);
    expect(back.save()).toEqual(saved);
    // The pull is in flight already: the restored client does not send it again on its own...
    expect(back.takeOutgoing()).toEqual([]);
    // ...and a retry (after a reconnect, the reply lost) asks for it again.
    expect(back.retry()).toEqual([{ type: 'pull', since: 0 }]);
  });

  it('a push window of its own: pushes beyond it are pulled, and restore needs the same window', () => {
    const lab = new Lab();
    const o = lab.add('o');
    const a = lab.add('a', { pushWindow: 2 });
    for (const n of ['1', '2', '3', '4', '5']) {
      ok(o.submit({ command: setVar(`v${n}`, n), label: n }));
      lab.send('o');
    }
    lab.drop('a', isPush);
    const all = lab.server.pull(0).entries;
    ok(a.receive(all.slice(1)));
    expect(a.save().buffered.map((p) => p.rev)).toEqual([2]);
    expect(a.takeOutgoing()).toEqual([{ type: 'pull', since: 0 }]);
    // Window by window: each delivery applies at most two revisions past the confirmed one.
    ok(a.receive(all));
    expect(a.confirmedRevision).toBe(2);
    // The rest was beyond the window: it is pulled from where the client is now.
    expect(a.takeOutgoing()).toEqual([{ type: 'pull', since: 2 }]);
    ok(a.receive(all));
    ok(a.receive(all));
    expect(a.confirmedRevision).toBe(5);
    const { protocol, format } = a.hello();
    a.handle({ type: 'welcome', protocol, format, head: 50 });
    const s = JSON.parse(JSON.stringify(a.save())) as unknown;
    expect(a.save().pullWanted).toBe(7);
    expect(SyncClient.restore(s, a.confirmedDocument, { pushWindow: 2 }).ok).toBe(true);
    const wide = structuredClone(a.save());
    wide.pullWanted = 8;
    expect(SyncClient.restore(wide, a.confirmedDocument, { pushWindow: 2 }).ok).toBe(false);
  });
});

describe('SyncClient: entry and message size limits', () => {
  /** A variable whose expression takes about `n` bytes. */
  const sized = (name: string, n: number): Command => setVar(name, `1.${'0'.repeat(n)}`);
  const names = (doc: ManufaktureDocument) => doc.variables.map((v) => v.name);

  it('drops an entry over the limit before sending it, with the notice, and syncs the edits after it', () => {
    const lab = new Lab();
    const a = lab.add('a', { maxEntryBytes: 4000 });
    const ev = events(a);
    ok(a.submit({ command: setVar('before', '1'), label: 'before' }));
    lab.settle();
    ok(a.submit({ command: setVar('pending', '1'), label: 'pending' }));
    ok(a.submit({ command: sized('big', 5000), label: 'big' }));
    ok(a.submit({ command: setVar('after', '2'), label: 'after' }));
    lab.settle();
    // Never sent: no submit carried it, the server recorded nothing for it.
    expect(submitted(lab, 'a').map((e) => e.label)).toEqual(['before', 'pending', 'after']);
    expect(ev.dropped).toHaveLength(1);
    const [drop] = ev.dropped;
    expect(drop!.drops).toEqual([
      expect.objectContaining({
        label: 'big',
        error: expect.objectContaining({ code: 'entry-too-large' }),
      }),
    ]);
    // The state before the drop, for the app's "Kept from sync" branch: it holds the big command.
    expect(drop!.before.revision).toBe(1);
    expect(drop!.before.commands.map((c) => c.label)).toEqual(['pending', 'big']);
    expect(a.pending).toEqual([]);
    expect(names(a.document)).toEqual(expect.arrayContaining(['before', 'pending', 'after']));
    expect(names(a.document)).not.toContain('big');
    expect(a.document).toEqual(lab.server.head);
    expect(a.stats).toMatchObject({ dropped: 1, landed: 3 });
    expect(a.undoLabel).toBe('after');
  });

  it('drops an oversized entry made offline when it comes to be sent, as the queue rebases', () => {
    const lab = new Lab();
    const a = lab.add('a', { maxEntryBytes: 4000, online: false });
    const ev = events(a);
    ok(a.submit({ command: sized('big', 5000), label: 'big' }));
    ok(a.submit({ command: setVar('after', '2'), label: 'after' }));
    expect(ev.dropped.flatMap((d) => d.drops.map((x) => x.label))).toEqual(['big']);
    a.setOnline(true);
    lab.settle();
    expect(names(lab.server.head)).toEqual(['thickness', 'width', 'after']);
    expect(a.document).toEqual(lab.server.head);
  });

  it('drops an entry the server refuses as too large, and the entries chained to it land', () => {
    const lab = new Lab(undefined, { maxEntryBytes: 4000 });
    const a = lab.add('a');
    const ev = events(a);
    ok(a.submit({ command: setVar('before', '1'), label: 'before' }));
    ok(a.submit({ command: sized('big', 5000), label: 'big' }));
    ok(a.submit({ command: setVar('after', '2'), label: 'after' }));
    lab.settle();
    expect(lab.server.outcome('a', 2)).toMatchObject({ error: { code: 'entry-too-large' } });
    expect(lab.server.outcome('a', 3)).toMatchObject({ error: { code: 'predecessor-refused' } });
    expect(ev.dropped.flatMap((d) => d.drops.map((x) => `${x.label}: ${x.error.code}`))).toEqual([
      'big: entry-too-large',
    ]);
    expect(a.pending).toEqual([]);
    expect(names(lab.server.head)).toEqual(['thickness', 'width', 'before', 'after']);
    expect(a.document).toEqual(lab.server.head);
  });

  it('cuts submits by bytes as well as by count, every entry once and in order', () => {
    const lab = new Lab();
    const maxMessageBytes = 4000 + SUBMIT_OVERHEAD;
    const a = lab.add('a', { maxEntryBytes: 4000, maxMessageBytes, online: false });
    for (let i = 0; i < 10; i++) ok(a.submit({ command: sized(`v${i}`, 1500), label: `v${i}` }));
    a.setOnline(true);
    const out = a.takeOutgoing();
    const submits = out.filter((m): m is SubmitMessage => m.type === 'submit');
    expect(submits.length).toBeGreaterThan(1);
    for (const m of submits) expect(jsonBytes(m)).toBeLessThanOrEqual(maxMessageBytes);
    expect(submits.flatMap((m) => m.entries.map((e) => e.clientSeq))).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 1),
    );
    lab.send('a', out);
    lab.settle();
    expect(a.pending).toEqual([]);
    expect(lab.server.revision).toBe(10);
    expect(a.document).toEqual(lab.server.head);
    // An entry at the limit fits a submit on its own.
    expect(() => lab.add('b', { maxEntryBytes: 4000, maxMessageBytes: 4000 })).toThrow(RangeError);
  });

  it('measures bytes as UTF-8, as the server does', () => {
    expect(jsonBytes('a')).toBe(3);
    expect(jsonBytes('\u00e9')).toBe(4);
    expect(jsonBytes('\u20ac')).toBe(5);
    expect(jsonBytes('\u{1f600}')).toBe(6);
    expect(jsonBytes({ s: 'x\u00e9\u{1f600}' })).toBe(
      Buffer.byteLength(JSON.stringify({ s: 'x\u00e9\u{1f600}' })),
    );
  });
});

describe('SyncClient: measured variables follow renames (#1202)', () => {
  const sourceOf = (doc: ManufaktureDocument, name: string) =>
    doc.variables.find((v) => v.name === name)?.expression.source;

  it('renames the faces a pending variable measures, made by earlier pending entries', () => {
    const lab = new Lab();
    const a = lab.add('a', { online: false });
    const o = lab.add('o');
    const ev = events(a);
    // Offline: two extrudes (extrude#3, extrude#4), then a variable measuring the second.
    ok(a.submit({ command: addExtrude(a.document, 'sketch#2', 'A1'), label: 'A1' }));
    ok(a.submit({ command: addExtrude(a.document, 'sketch#2', 'A2'), label: 'A2' }));
    const gap = 'distance("extrude#4:cap:end", "extrude#3:cap:start") + 1 mm';
    ok(a.submit({ command: setVar('gap', gap), label: 'gap' }));
    // Another client's extrude#3 lands first: A1 becomes extrude#4, A2 extrude#5.
    ok(o.submit({ command: addExtrude(o.document, 'sketch#1', 'O'), label: 'O' }));
    lab.send('o');
    lab.deliver('a');
    expect(ev.remapped.map((e) => e.table)).toEqual([
      { [`part:${PART}`]: { 'extrude#3': 'extrude#4', 'extrude#4': 'extrude#5' } },
    ]);
    expect(ev.remapped[0]!.report.unresolved).toBe(0);
    const renamed = 'distance("extrude#5:cap:end", "extrude#4:cap:start") + 1 mm';
    expect(sourceOf(a.document, 'gap')).toBe(renamed);
    a.setOnline(true);
    lab.settle();
    expect(feature(lab.server.head, 'extrude#5')).toMatchObject({ name: 'A2' });
    expect(sourceOf(lab.server.head, 'gap')).toBe(renamed);
  });

  it('renames them in a command waiting on the redo stack', () => {
    const lab = new Lab();
    const a = lab.add('a', { online: false });
    const o = lab.add('o');
    ok(a.submit({ command: addExtrude(a.document, 'sketch#2', 'A1'), label: 'A1' }));
    ok(a.submit({ command: addExtrude(a.document, 'sketch#2', 'A2'), label: 'A2' }));
    ok(
      a.submit({ command: setVar('gap', 'distance("extrude#4:cap:end", "x#1:y")'), label: 'gap' }),
    );
    expect(a.undo()).toEqual({ ok: true });
    expect(sourceOf(a.document, 'gap')).toBeUndefined();
    ok(o.submit({ command: addExtrude(o.document, 'sketch#1', 'O'), label: 'O' }));
    lab.send('o');
    lab.deliver('a');
    expect(a.redo()).toEqual({ ok: true });
    expect(sourceOf(a.document, 'gap')).toBe('distance("extrude#5:cap:end", "x#1:y")');
  });
});
