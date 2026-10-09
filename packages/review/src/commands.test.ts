// The command list recomputed from a branch log and compared with a bundle's (threat model N-1):
// `commandMismatches` finds every way an untrusted list can misdescribe the log, never throws on
// one of the wrong shape, and finds nothing in a list made from the same log. That a real
// session's bundle matches its log is checked for the three M8 fixtures in bundle.test.ts.

import { applyCommand, type Command, type ManufaktureDocument } from '@manufakture/core';
import { DocumentLibrary, MemoryBackend, type LogEntry } from '@manufakture/library';
import { PART, bracketDocument } from '@manufakture/session/test-fixtures';
import { describe, expect, it } from 'vitest';
import {
  MAX_COMMAND_MISMATCHES,
  branchLog,
  commandDiff,
  commandMismatches,
  type CommandList,
  type LoggedBatch,
} from './commands';

const RENAME = { type: 'renameFeature', partId: PART, featureId: 'fillet#1', name: 'Quiet round' };
const NAME = { type: 'renameDocument', name: 'Bracket, renamed' };

function replayed(base: ManufaktureDocument, log: readonly LoggedBatch[]): ManufaktureDocument {
  let doc = base;
  for (const e of log) {
    const r = applyCommand(doc, e.command);
    if (!r.ok) throw new Error(r.error.message);
    doc = r.value.document;
  }
  return doc;
}

function fixture(): { list: CommandList; base: ManufaktureDocument; log: LoggedBatch[] } {
  const base = bracketDocument();
  const log: LoggedBatch[] = [
    { revision: 2, cause: 'execute', label: 'Rename a fillet', command: RENAME as Command },
    {
      revision: 3,
      cause: 'execute',
      label: 'Rename the document',
      command: { type: 'batch', commands: [NAME] } as Command,
    },
  ];
  return { list: commandDiff(base, replayed(base, log), log), base, log };
}

const copy = (x: CommandList) => JSON.parse(JSON.stringify(x)) as CommandList;

describe('commandMismatches', () => {
  it('finds nothing in a list made from the same log, read back as JSON', () => {
    const { list } = fixture();
    expect(list.batches.items.map((b) => b.commands.map((c) => c.summary))).toEqual([
      ['Renamed Fillet 1 to Quiet round'],
      ['Renamed the document from Bracket to Bracket, renamed'],
    ]);
    expect(commandMismatches(copy(list), list)).toEqual([]);
  });

  it('flags a batch the bundle leaves out, a label, a summary and JSON it changes', () => {
    const { list } = fixture();
    const omitted = copy(list);
    omitted.batches.items.shift();
    expect(commandMismatches(omitted, list)).toEqual([
      'The bundle lists 1 batch; the branch log has 2.',
      'Batch 1 (revision 2): the bundle says revision 3.',
      'Batch 1 (revision 2): the bundle labels it "Rename the document", the log "Rename a fillet".',
      'Batch 1 (revision 2), command 1: the bundle says "Renamed the document from Bracket to Bracket, renamed", the log "Renamed Fillet 1 to Quiet round".',
      'Batch 2 (revision 3) "Rename the document": in the branch log (1 command), not in the bundle.',
    ]);

    const edited = copy(list);
    edited.batches.items[0]!.label = 'Tidy up';
    edited.batches.items[1]!.commands[0]!.json = '{"type":"renameDocument","name":"Bracket"}';
    edited.batches.items[1]!.commands.push({ ...edited.batches.items[1]!.commands[0]! });
    expect(commandMismatches(edited, list)).toEqual([
      'Batch 1 (revision 2): the bundle labels it "Tidy up", the log "Rename a fillet".',
      'Batch 2 (revision 3) "Rename the document": the bundle lists 2 commands, the log 1.',
      'Batch 2 (revision 3), command 1 "Renamed the document from Bracket to Bracket, renamed": the bundle shows other JSON than the log has.',
      'Batch 2 (revision 3), command 2: in the bundle ("Renamed the document from Bracket to Bracket, renamed"), not in the log.',
    ]);

    const counted = copy(list);
    counted.omittedCommands = 3;
    expect(commandMismatches(counted, list)).toEqual([
      'The bundle says it left out 3 commands; the log leaves out 0.',
    ]);
  });

  it('never throws on a list of the wrong shape, and lists each difference as text', () => {
    const { list } = fixture();
    for (const bad of [null, 'x', 1, [], { batches: { items: [null, 'x'] } }]) {
      expect(commandMismatches(bad, list).length).toBeGreaterThan(0);
    }
    expect(commandMismatches({ batches: { items: [{ label: { x: 1 } }] } }, list)).toContain(
      'Batch 1 (revision 2): the bundle labels it an object, the log "Rename a fillet".',
    );
    // Control characters in the bundle's text are made visible, and long text is cut.
    const hostile = copy(list);
    hostile.batches.items[0]!.label = `‮${'x'.repeat(1000)}`;
    const [m] = commandMismatches(hostile, list);
    expect(m).not.toContain('‮');
    expect(m!.length).toBeLessThan(300);
  });

  it('lists at most MAX_COMMAND_MISMATCHES differences', () => {
    const { list } = fixture();
    const many = {
      batches: {
        items: Array.from({ length: 300 }, () => ({ label: 'x', commands: [] })),
        omitted: 0,
      },
      omittedCommands: 0,
    };
    const m = commandMismatches(many, list);
    expect(m).toHaveLength(MAX_COMMAND_MISMATCHES + 1);
    expect(m.at(-1)).toMatch(/^and \d+ more differences$/);
  });
});

describe('branchLog', () => {
  it('reads each entry with the revision it led to', async () => {
    let n = 0;
    const lib = new DocumentLibrary(new MemoryBackend(), { locks: null, newId: () => `id-${++n}` });
    const { base, log } = fixture();
    await lib.save(base);
    const entries = (e: LoggedBatch): LogEntry => ({
      cause: 'execute',
      label: e.label,
      command: e.command,
      at: 'now',
    });
    const once = replayed(base, log.slice(0, 1));
    await lib.save(once, [entries(log[0]!)]);
    await lib.save(replayed(base, log), [entries(log[1]!)]);
    expect(await branchLog(lib, base.id, 'main')).toEqual(log);
    await expect(branchLog(lib, '../not an id', 'main')).rejects.toThrow('There is no document');
  });
});
