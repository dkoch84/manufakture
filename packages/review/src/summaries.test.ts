// Every command type core knows has a readable summary (ADR 0016 decision 11): the list comes
// from core's schema, so a new command type fails here until `SUMMARIES` has it. Every command
// of core's golden logs (which cover every type, batch included) is summarised through the
// command diff without falling back, and a few summaries are pinned word for word.

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  SimpleCommandSchema,
  applyCommand,
  migrateCommand,
  parseDocument,
  type Command,
  type ManufaktureDocument,
} from '@manufakture/core';
import { bracketDocument, PART } from '@manufakture/session/test-fixtures';
import { describe, expect, it } from 'vitest';
import { commandDiff } from './commands';
import { Names } from './describe';
import { summariserMap } from './domains';
import { SUMMARIES, lineCount, summarise } from './summaries';

const ALL_TYPES = [...SimpleCommandSchema.options.map((o) => o.shape.type.value), 'batch'];

describe('summaries', () => {
  it('has one for every command type in core, and none for a type core does not have', () => {
    expect(ALL_TYPES.filter((t) => !Object.hasOwn(SUMMARIES, t))).toEqual([]);
    expect(Object.keys(SUMMARIES).filter((t) => !ALL_TYPES.includes(t))).toEqual([]);
  });

  // Core's golden command logs, read as data (`fixtures/logs` beside core's sources).
  const logs = join(
    dirname(createRequire(import.meta.url).resolve('@manufakture/core')),
    'fixtures',
    'logs',
  );
  const files = readdirSync(logs)
    .filter((f) => f.endsWith('.json'))
    .sort();

  it('summarises every command of core golden logs, every type covered, none falling back', () => {
    const seen = new Set<string>();
    for (const file of files) {
      const log = JSON.parse(readFileSync(join(logs, file), 'utf8')) as {
        version: number;
        base: unknown;
        entries: { cause: string; label: string; command: unknown }[];
      };
      const parsed = parseDocument(log.base);
      if (!parsed.ok) throw new Error(`${file}: ${parsed.error.message}`);
      const base = parsed.value.document;
      const entries = log.entries.map((e, i) => {
        const c = migrateCommand(e.command, log.version);
        if (!c.ok) throw new Error(`${file}: ${c.error.message}`);
        return { revision: i + 2, cause: e.cause, label: e.label, command: c.value };
      });
      let head: ManufaktureDocument = base;
      for (const e of entries) {
        const r = applyCommand(head, e.command);
        if (r.ok) head = r.value.document;
      }
      const diff = commandDiff(base, head, entries, summariserMap());
      for (const batch of diff.batches.items) {
        for (const c of batch.commands) {
          seen.add(c.type);
          expect(c.summary, `${file} ${c.type}`).not.toMatch(/^A [a-zA-Z]+ command$/);
          expect(c.summary.length).toBeGreaterThan(8);
        }
      }
      for (const e of entries) if (e.command.type === 'batch') seen.add('batch');
    }
    expect(ALL_TYPES.filter((t) => !seen.has(t))).toEqual([]);
  });

  it('reads like a person wrote it', () => {
    const before = bracketDocument();
    const fillet = before.parts[0]!.features.find((f) => f.id === 'fillet#1')!;
    const add: Command = {
      type: 'addFeature',
      partId: PART,
      feature: {
        ...fillet,
        id: 'fillet#3',
        name: 'Fillet 3',
        radius: { source: '2', lengthUnit: 'mm', angleUnit: 'deg' },
        edges: [1, 2, 3, 4].map((i) => ({
          id: `r${i}`,
          ref: { faces: [`extrude#1:side:e${i}`, `extrude#1:side:e${i + 1}`] },
        })),
      } as never,
    };
    const after = applyCommand(before, add);
    const ctx = {
      before,
      after: after.ok ? after.value.document : null,
      names: new Names([before]),
      summarisers: summariserMap(),
    };
    expect(summarise(add, ctx)).toBe('Added Fillet 3 (2 mm) on 4 edges of Extrude 1');
    expect(
      summarise(
        { type: 'suppressFeature', partId: PART, featureId: 'hole#1', suppressed: true },
        ctx,
      ),
    ).toBe('Suppressed M4 holes');
    expect(
      summarise({ type: 'reorderFeature', partId: PART, featureId: 'fillet#1', index: 1 }, ctx),
    ).toBe('Moved Fillet 1 at position 2 in the feature list');
    expect(
      summarise(
        {
          type: 'setVariable',
          name: 'thickness',
          expression: { source: '8 mm', lengthUnit: 'mm', angleUnit: 'deg' },
        },
        ctx,
      ),
    ).toBe('Set variable thickness from 6 mm to 8 mm');
    expect(summarise({ type: 'deleteFeature', partId: PART, featureId: 'hole#1' }, ctx)).toBe(
      'Deleted hole M4 holes',
    );
  });

  it('shows names from the document as text, bounded, without control characters', () => {
    const before = bracketDocument();
    const name = `Evil‮eman ${'x'.repeat(1000)}`;
    const s = summarise(
      { type: 'renameFeature', partId: PART, featureId: 'fillet#1', name },
      { before, after: null, names: new Names([before]), summarisers: summariserMap() },
    );
    expect(s).not.toContain('‮');
    expect(s).toContain('Evil�eman');
    expect(s.length).toBeLessThanOrEqual(500);
  });

  it('counts lines as an editor does', () => {
    expect([lineCount(''), lineCount('a'), lineCount('a\n'), lineCount('a\nb')]).toEqual([
      0, 1, 1, 2,
    ]);
  });
});
