import type { Command, ManufaktureDocument } from '@manufakture/core';
import { describe, expect, it } from 'vitest';
import { runScenario, type Scenario } from './fuzz';
import type { SyncClientEvents } from './client';
import { Lab, PART, addExtrude, addSketch, bracket, editExtrude, feature, mm } from './lab';
import type { SubmitMessage } from './protocol';

/**
 * The fuzz suite (T7.1b): the T7.0b spike's scenarios, scaled down, run on the client engine and
 * the reference server with every fault of the plan, and the spike's fixed concurrent sequences.
 * `FUZZ_SEEDS=n` (default 3) and `FUZZ_FIRST=k` (default 1) widen a run by hand.
 */

function ok<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** Lost submits and verdicts, duplicated deliveries, a push stream behind the head, reloads. */
const FAULTS = { loss: 0.15, duplicate: 0.1, pushDelay: 300, saveRestore: 0.05 };

const SCENARIOS: Scenario[] = [
  // One user's two devices, edits far apart compared with the latency.
  {
    name: 'two-calm',
    clients: 2,
    commandsPerClient: 25,
    think: 2000,
    latency: 50,
    saveRestore: 0.05,
  },
  // Two clients editing as fast as the network turns round; submits reordered freely.
  { name: 'two-busy', clients: 2, commandsPerClient: 25, think: 100, latency: 100 },
  // Five clients editing faster than the round trip.
  { name: 'five-busy', clients: 5, commandsPerClient: 12, think: 100, latency: 150 },
  // The same with each client's submits on one ordered channel, and every fault.
  {
    name: 'five-busy-fifo',
    clients: 5,
    commandsPerClient: 12,
    think: 100,
    latency: 150,
    fifo: true,
    ...FAULTS,
  },
  // Every fault, submits reordered.
  { name: 'three-lossy', clients: 3, commandsPerClient: 20, think: 150, latency: 100, ...FAULTS },
  // Client 1 offline for 3.5 virtual seconds: a long unsent queue renamed on reconnect.
  {
    name: 'offline',
    clients: 3,
    commandsPerClient: 30,
    think: 200,
    latency: 80,
    offline: { from: 500, to: 4000 },
    ...FAULTS,
  },
  // Undo and redo between everyone's edits.
  {
    name: 'undo-redo',
    clients: 3,
    commandsPerClient: 25,
    think: 120,
    latency: 100,
    undo: 0.2,
    redo: 0.08,
    ...FAULTS,
  },
  // Restores of past versions, kept as intents and re-derived at every replay.
  {
    name: 'restores',
    clients: 3,
    commandsPerClient: 20,
    think: 150,
    latency: 150,
    restore: 0.08,
    generatorRestores: true,
    ...FAULTS,
  },
];

const seeds = Number(process.env.FUZZ_SEEDS ?? 3);
const first = Number(process.env.FUZZ_FIRST ?? 1);

describe('fuzz: random concurrent streams with faults', () => {
  for (const sc of SCENARIOS) {
    for (let seed = first; seed < first + seeds; seed++) {
      it(`${sc.name}, seed ${seed}: converges, valid, nothing lost or applied twice`, () => {
        const r = runScenario(sc, seed, bracket());
        expect(r.violations.slice(0, 5)).toEqual([]);
        expect(r.stuck).toBe(false);
        expect(r.converged).toBe(true);
        expect(r.landed).toBeGreaterThan(0);
        expect(r.made).toBe(r.landed + r.dropped + r.withdrawn);
        expect(r.accepted).toBe(r.landed);
        if (sc.saveRestore) expect(r.twinRestores).toBeGreaterThan(0);
      });
    }
  }
});

describe('fixed concurrent sequences from the T7.0b spike', () => {
  it('two concurrent sketch edits that add the same entity id: the second is renamed, never a takeover', () => {
    const lab = new Lab();
    const a = lab.add('a');
    const b = lab.add('b');
    const line = (doc: ManufaktureDocument, x: number): Command => {
      const s = feature(doc, 'sketch#1');
      if (s?.kind !== 'sketch') throw new Error('no sketch#1');
      return {
        type: 'editFeature',
        partId: PART,
        feature: {
          ...s,
          entities: [
            ...s.entities,
            { id: 'e6', kind: 'line', construction: true, start: [x, 0], end: [x, 9] },
          ],
        },
      };
    };
    ok(a.submit({ command: line(a.document, 11), label: 'line a' }));
    ok(b.submit({ command: line(b.document, 22), label: 'line b' }));
    lab.send('a');
    lab.send('b');
    // Core alone would take b's edit as an edit of a's e6; the created-ids guard refuses it.
    expect(lab.server.outcome('b', 1)).toMatchObject({ error: { code: 'id-reused' } });
    lab.settle();
    const s = feature(lab.server.head, 'sketch#1');
    if (s?.kind !== 'sketch') throw new Error('no sketch#1');
    // The later edit wins whole (decision 7), but its line got a fresh id: it never took over
    // a's e6, so nothing that names e6 binds to b's line.
    const lines = s.entities.filter((e) => e.kind === 'line' && e.construction);
    expect(lines.map((e) => [e.id, e.kind === 'line' && e.start[0]])).toEqual([['e7', 22]]);
    expect(b.document).toEqual(lab.server.head);
  });

  it('an in-flight collision followed by an edit of the remote feature edits the remote one', () => {
    const lab = new Lab();
    const a = lab.add('a');
    const o = lab.add('o');
    ok(a.submit({ command: addExtrude(a.document, 'sketch#2', 'A'), label: 'A' }));
    ok(o.submit({ command: addExtrude(o.document, 'sketch#1', 'O'), label: 'O' }));
    lab.send('o');
    lab.deliver('a');
    // A is certain to be refused: renamed in the client's naming at once, its sent copy kept.
    expect(a.pending[0]).toMatchObject({ state: 'doomed', clientSeq: 1 });
    expect(a.pending[0]!.command).toMatchObject({ feature: { id: 'extrude#4' } });
    expect(a.pending[0]!.sent).toMatchObject({ feature: { id: 'extrude#3' } });
    expect(feature(a.document, 'extrude#3')).toMatchObject({ name: 'O' });
    ok(a.submit({ command: editExtrude(a.document, 'extrude#3', 'O edited by a'), label: 'edit' }));
    lab.settle();
    expect(feature(lab.server.head, 'extrude#3')).toMatchObject({ name: 'O edited by a' });
    expect(feature(lab.server.head, 'extrude#4')).toMatchObject({ name: 'A' });
    expect(a.document).toEqual(lab.server.head);
  });

  it('a dropped head with a held follower: the head is dropped with its notice, an independent follower lands, a dependent one is dropped', () => {
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
    const dropped: SyncClientEvents['dropped'][] = [];
    a.on('dropped', (e) => dropped.push(e));
    ok(a.submit({ command: addExtrude(a.document, 'sketch#3', 'A'), label: 'A' }));
    ok(
      a.submit({
        command: { type: 'setVariable', name: 'q', expression: mm('7') },
        label: 'B',
      }),
    );
    ok(a.submit({ command: editExtrude(a.document, 'extrude#3', 'C'), label: 'C' }));
    lab.send('a');
    lab.settle();
    expect(dropped.flatMap((d) => d.drops.map((x) => [x.label, x.error.code]))).toEqual([
      ['A', 'dependency'],
      ['C', 'schema'],
    ]);
    // The pre-rebase state for a branch keeps every pending command.
    expect(dropped[0]!.before.commands.map((c) => c.label)).toEqual(['A', 'B', 'C']);
    expect(lab.server.head.variables.map((v) => v.name)).toContain('q');
    const submitted = lab.sent
      .get('a')!
      .filter((m): m is SubmitMessage => m.type === 'submit')
      .flatMap((m) => m.entries.map((e) => [e.label, e.clientSeq]));
    expect(submitted).toEqual([
      ['A', 1],
      ['B', 2],
      ['C', 3],
      ['B', 4],
    ]);
    expect(a.stats).toMatchObject({ made: 3, landed: 1, dropped: 2 });
    expect(a.document).toEqual(lab.server.head);
  });

  it("a duplicated part's copies follow the source part's renames", () => {
    const lab = new Lab();
    const a = lab.add('a', { online: false });
    const o = lab.add('o');
    ok(a.submit({ command: addExtrude(a.document, 'sketch#2', 'A'), label: 'A' }));
    ok(
      a.submit({
        command: { type: 'duplicatePart', sourcePartId: PART, partId: 'part#2', name: 'Copy' },
        label: 'duplicate',
      }),
    );
    ok(
      a.submit({
        command: editExtrude(a.document, 'extrude#3', 'copy edit', 'part#2'),
        label: 'edit',
      }),
    );
    ok(
      a.submit({ command: addExtrude(a.document, 'sketch#1', 'copy add', 'part#2'), label: 'add' }),
    );
    ok(o.submit({ command: addExtrude(o.document, 'sketch#1', 'O'), label: 'O' }));
    lab.send('o');
    lab.deliver('a');
    a.setOnline(true);
    lab.settle();
    const head = lab.server.head;
    expect(feature(head, 'extrude#3')).toMatchObject({ name: 'O' });
    expect(feature(head, 'extrude#4')).toMatchObject({ name: 'A' });
    // The copy holds O's extrude#3 untouched and its own extrude#4, edited; its own add is #5.
    expect(feature(head, 'extrude#3', 'part#2')).toMatchObject({ name: 'O' });
    expect(feature(head, 'extrude#4', 'part#2')).toMatchObject({ name: 'copy edit' });
    expect(feature(head, 'extrude#5', 'part#2')).toMatchObject({ name: 'copy add' });
    expect(a.document).toEqual(head);
  });

  it('a stale restore is re-derived on the head, and no counter goes back', () => {
    const lab = new Lab();
    const a = lab.add('a');
    const o = lab.add('o');
    ok(o.submit({ command: { type: 'addPart', partId: 'part#2', name: 'Two' }, label: 'part' }));
    lab.settle();
    const version = a.confirmedDocument;
    ok(o.submit({ command: addSketch(o.document, 0, 'part#2'), label: 'sketch in two' }));
    ok(o.submit({ command: addExtrude(o.document, 'sketch#1', 'O'), label: 'O' }));
    lab.settle();
    ok(o.submit({ command: { type: 'deletePart', partId: 'part#2' }, label: 'delete two' }));
    lab.send('o');
    a.setOnline(false);
    ok(a.submit({ restore: { document: version, version: 'v1' }, label: 'restore v1' }));
    expect(a.save().entries[0]!.restore?.version).toBe('v1');
    a.setOnline(true);
    lab.settle();
    const head = lab.server.head;
    expect(head.parts.map((p) => p.id)).toEqual([PART, 'part#2']);
    expect(feature(head, 'extrude#3')).toBeUndefined();
    // Counters are at their high-water marks, the deleted part's included.
    expect(head.parts[0]!.nextIds.extrude).toBe(4);
    expect(head.parts[1]!.nextIds.sketch).toBe(2);
    expect(lab.server.log.at(-1)!.entry.label).toBe('restore v1');
    expect(a.document).toEqual(head);
  });
});
