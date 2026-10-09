import { applyCommand, createDocument, type Command } from '@manufakture/core';
import type { LogEntry } from '@manufakture/library';
import { describe, expect, it } from 'vitest';
import { builtInMergeValidator, replayOnto } from './rebase';

type Data = NonNullable<Extract<Command, { type: 'setDomainData' }>['data']>;

const set = (data: Data, namespace = 'wood'): Command => ({
  type: 'setDomainData',
  namespace,
  schemaVersion: 1,
  data,
});

const HEADER = { stock: 'us-2x8', plies: 2, jacks: 1 };
const wallType = (...layers: Data[]): Data => ({
  wallTypes: [{ id: 'w1', name: 'Exterior', layers }],
});

describe('replayOnto', () => {
  it('merges a replayed edit of domain data by field, as the library merge does', () => {
    const start = applyCommand(
      createDocument({ id: 'doc-1', name: 'Doc' }),
      set({ framing: { spacing: 16 }, levels: [{ id: 'L1', height: 1 }] }),
    );
    if (!start.ok) throw new Error(start.error.message);
    const base = start.value.document;
    // Main meanwhile: a header rule, and a level.
    const main = applyCommand(
      base,
      set({
        framing: { spacing: 16 },
        headerRules: [{ maxWidth: 48 }],
        levels: [
          { id: 'L1', height: 1 },
          { id: 'L2', height: 2 },
        ],
      }),
    );
    if (!main.ok) throw new Error(main.error.message);
    // The branch: blocking, and L1 higher.
    const entries: LogEntry[] = [
      {
        cause: 'execute',
        label: 'Blocking',
        command: set({
          framing: { spacing: 16, blocking: 'mid' },
          levels: [{ id: 'L1', height: 3 }],
        }),
        at: 'a',
      },
    ];
    // No domain reads "wood" data here (the validator is not given): it is replaced whole.
    const unread = replayOnto(base, main.value.document, entries, {});
    if (!unread.ok) throw new Error(unread.message);
    expect(unread.value.document.domains!.wood!.data).toEqual(
      (entries[0]!.command as { data: Data }).data,
    );
    expect(unread.value.mergedWhole).toEqual([
      {
        label: 'Blocking',
        reasons: ['nothing here reads the domain data "wood", so it is not merged by field'],
      },
    ]);
    // With a reader that accepts it, it merges field by field.
    const accepting = {
      domainData: () => ({ ok: true as const }),
      extensionParams: () => ({ ok: true as const }),
    };
    const r = replayOnto(base, main.value.document, entries, { validate: accepting });
    if (!r.ok) throw new Error(r.message);
    const merged = {
      framing: { spacing: 16, blocking: 'mid' },
      headerRules: [{ maxWidth: 48 }],
      levels: [
        { id: 'L1', height: 3 },
        { id: 'L2', height: 2 },
      ],
    };
    expect(r.value.document.domains!.wood!.data).toEqual(merged);
    // The kept command is the merged one, so the branch's revisions replay to the same state.
    expect(r.value.entries).toEqual([
      { cause: 'execute', label: 'Blocking', command: set(merged) },
    ]);
    expect(r.value.dropped).toEqual([]);
    expect(r.value.overwritten).toEqual([]);
    expect(r.value.mergedWhole).toEqual([]);
  });

  it('keeps no merged construction data its reader refuses, and says what Main loses', () => {
    const f1 = { id: 'f1', kind: 'framing', stock: 'us-2x4', header: HEADER };
    const f2 = { id: 'f2', kind: 'framing', stock: 'us-2x6', header: HEADER };
    const start = applyCommand(
      createDocument({ id: 'doc-1', name: 'Doc' }),
      set(wallType(f1), 'construction'),
    );
    if (!start.ok) throw new Error(start.error.message);
    const base = start.value.document;
    expect(builtInMergeValidator.domainData('construction', wallType(f1), 1)).toEqual({
      ok: true,
    });
    // Main replaces framing layer f1 with f2; the branch edits f1.
    const main = applyCommand(base, set(wallType(f2), 'construction'));
    if (!main.ok) throw new Error(main.error.message);
    const edited = wallType({ ...f1, bottomPlates: 2 });
    const entries: LogEntry[] = [
      { cause: 'execute', label: 'Two plates', command: set(edited, 'construction'), at: 'a' },
    ];
    // Merged by id, the edit brings f1 back beside f2: a wall type with two framing layers, which
    // the construction reader refuses. The branch's whole data is used instead, and both say so.
    const r = replayOnto(base, main.value.document, entries);
    if (!r.ok) throw new Error(r.message);
    expect(r.value.document.domains!.construction!.data).toEqual(edited);
    expect(r.value.mergedWhole).toHaveLength(1);
    expect(r.value.mergedWhole[0]!.reasons[0]).toContain('a wall type has one framing layer');
    expect(r.value.overwritten).toEqual([
      {
        name: "the document's domains",
        fields: ['construction.wallTypes[w1].layers[f1]', 'construction.wallTypes[w1].layers[f2]'],
      },
    ]);
  });
});
