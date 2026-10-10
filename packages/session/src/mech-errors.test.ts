// get_errors and the mechanical domain's evaluation (ADR 0017 decision 15, T9.5a): a check's
// record that is below the user's factor or not computed is a `where: 'mech'` warning with the
// record id and the check id; an evaluation that could not run is an error on the domain.

import {
  applyCommand,
  createDocument,
  type Command,
  type ManufaktureDocument,
  type StoredExpression,
} from '@manufakture/core';
import type { RegenResult } from '@manufakture/regen';
import { afterEach, describe, expect, it } from 'vitest';
import type { References } from './imports';
import { errorsOf } from './queries';
import type { Session } from './session';
import { ok, seeded } from './test/setup';

const x = (source: string): StoredExpression => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });

function apply(doc: ManufaktureDocument, ...commands: Command[]): ManufaktureDocument {
  for (const c of commands) {
    const r = applyCommand(doc, c);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    doc = r.value.document;
  }
  return doc;
}

const NO_REFERENCES = { list: () => [] } as unknown as References;

describe('errorsOf and the evaluation', () => {
  it('turns mech warnings into mech lines, and a stage error into an error first', () => {
    const result = {
      parts: [],
      assemblies: [],
      evaluations: [
        {
          namespace: 'mech',
          ms: 1,
          error: { code: 'extension', message: 'The "mech" evaluation failed: x' },
          warnings: [
            {
              code: 'mech-check',
              message: 'Cable tension, Rope in Rep: not computed. Missing: Peak cable tension',
              check: 'cable.tension',
              recordId: 'cable.tension@pp#2/lc#4',
              status: 'unknown',
            },
            {
              code: 'mech-requirement',
              message: 'Max force: misses',
              requirementId: 'req#1',
              status: 'misses',
            },
          ],
        },
      ],
    } as unknown as RegenResult;
    expect(errorsOf(result, NO_REFERENCES)).toEqual([
      {
        where: 'mech',
        id: 'mech',
        severity: 'error',
        code: 'extension',
        message: 'The "mech" evaluation failed: x',
      },
      {
        where: 'mech',
        id: 'cable.tension@pp#2/lc#4',
        check: 'cable.tension',
        severity: 'warning',
        code: 'mech-check',
        message: 'Cable tension, Rope in Rep: not computed. Missing: Peak cable tension',
      },
      {
        where: 'mech',
        id: 'req#1',
        severity: 'warning',
        code: 'mech-requirement',
        message: 'Max force: misses',
      },
    ]);
  });
});

const open: Session[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

describe('get_errors in a session', () => {
  it('lists a record below your factor, with the record and check ids', async () => {
    const doc = apply(
      createDocument({ id: 'doc-mech-errors', name: 'Trainer' }),
      {
        type: 'setDomainData',
        namespace: 'mech',
        schemaVersion: 1,
        data: { factors: { strength: 2 } } as never,
      },
      {
        type: 'setCatalogEntry',
        entry: {
          id: 'entry#1',
          version: 1,
          family: 'rope',
          fieldsVersion: 1,
          maker: 'Acme',
          partNumber: 'HMPE 3 mm',
          description: '',
          ratings: { minimumBreakingLoad: { value: 4500 } },
          sources: [],
          verified: false,
        },
      },
      {
        type: 'setPurchasedUse',
        use: {
          id: 'pp#2',
          entry: { source: 'document', id: 'entry#1' },
          alternates: [],
          name: 'Rope',
        },
      },
      {
        type: 'setMechLoadCase',
        loadCase: {
          id: 'lc#3',
          name: 'Hold',
          static: [{ kind: 'cable', name: 'Max pull', force: x('890 N'), angle: x('0 deg') }],
        },
      },
    );
    const seed = await seeded(doc);
    const s = ok(await seed.manager.open({ documentId: seed.documentId, clientName: 'Test' }));
    open.push(s);
    // Above the factor: nothing to report.
    expect(ok(await s.errors())).toEqual([]);
    const report = ok(
      await s.apply({
        label: 'Heavier pull',
        commands: [
          {
            type: 'setMechLoadCase',
            loadCase: {
              id: 'lc#3',
              name: 'Hold',
              static: [{ kind: 'cable', name: 'Max pull', force: x('2500 N'), angle: x('0 deg') }],
            },
          },
        ],
      }),
    );
    const line = {
      where: 'mech',
      id: 'cable.tension@pp#2/lc#3',
      check: 'cable.tension',
      severity: 'warning',
      code: 'mech-check',
      message:
        'Cable tension, Rope in Hold: load 2.50 kN, rated load 4.50 kN; factor 1.80, below your 2',
    };
    expect(report.errors).toEqual([line]);
    expect(ok(await s.errors())).toEqual([line]);
  }, 60_000);
});
