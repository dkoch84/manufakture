import { SCRIPT_APIS } from '@manufakture/regen';
import { describe, expect, it } from 'vitest';
import { draftOf, scriptFromDraft, usersText } from './library';
import { positionText, scriptProblems } from './problems';
import { applyAll, PART, scriptedDocument, scriptedFeature } from './scripts.test-fixture';
import { NEW_SCRIPT_SOURCE, SCRIPT_API_VERSION, newScriptName } from './template';
import type { PartModel } from '../model/model';

describe('the script library', () => {
  it('new scripts are written against the newest API version regen runs', () => {
    expect(SCRIPT_APIS.has(SCRIPT_API_VERSION)).toBe(true);
    expect(Math.max(...SCRIPT_APIS.keys())).toBe(SCRIPT_API_VERSION);
  });

  it('a new script starts from the box with a free name and the next id', () => {
    const doc = scriptedDocument();
    const draft = draftOf(doc, null);
    expect(draft).toEqual({ name: 'Script 1', language: 'js', source: NEW_SCRIPT_SOURCE });
    expect(newScriptName(['Script 1', 'Script 2'])).toBe('Script 3');
    const r = scriptFromDraft(doc, null, draft);
    expect(r).toEqual({
      ok: true,
      script: {
        id: 'script#3',
        name: 'Script 1',
        language: 'js',
        apiVersion: SCRIPT_API_VERSION,
        source: NEW_SCRIPT_SOURCE,
      },
    });
  });

  it('an edited script keeps its id and API version', () => {
    const doc = scriptedDocument();
    const old = { ...doc, scripts: [{ ...doc.scripts![0]!, apiVersion: 7 }, doc.scripts![1]!] };
    const draft = { ...draftOf(old, 'script#1'), name: '  Boxy ', language: 'ts' as const };
    const r = scriptFromDraft(old, 'script#1', draft);
    expect(r.ok && r.script).toMatchObject({ id: 'script#1', name: 'Boxy', apiVersion: 7 });
    expect(scriptFromDraft(old, 'script#1', { ...draft, name: ' ' })).toEqual({
      ok: false,
      error: 'A script needs a name.',
    });
  });

  it('says which features run a script', () => {
    const doc = scriptedDocument();
    expect(usersText(doc, 'script#1')).toBe('Run by Scripted 1');
    expect(usersText(doc, 'script#9')).toBe('Not used');
    const more = applyAll(doc, [
      ...[3, 4, 5].map((n) => ({
        type: 'addFeature' as const,
        partId: PART,
        feature: scriptedFeature(`scripted#${n}`, 'script#1'),
      })),
    ]);
    expect(usersText(more, 'script#1')).toBe('Run by Scripted 1, Scripted 3 and 2 more');
  });
});

describe('script problems', () => {
  it('lists what regen reported for a script, with positions, but not Scripts not run', () => {
    const doc = scriptedDocument();
    const parts: PartModel[] = [
      {
        partId: PART,
        bodies: [],
        features: [
          {
            featureId: 'scripted#1',
            status: 'error',
            errors: [
              {
                code: 'script',
                scriptCode: 'runtime',
                scriptId: 'script#1',
                message: 'boom',
                line: 3,
                column: 5,
              },
            ],
          },
          {
            featureId: 'scripted#2',
            status: 'error',
            errors: [
              {
                code: 'script',
                scriptCode: 'not-allowed',
                scriptId: 'script#2',
                message: 'Scripts not run',
              },
            ],
          },
        ],
      } as unknown as PartModel,
    ];
    const box = scriptProblems(doc, parts, 'script#1');
    expect(box).toEqual([
      {
        partId: PART,
        featureId: 'scripted#1',
        where: 'Scripted 1',
        code: 'runtime',
        message: 'boom',
        line: 3,
        column: 5,
      },
    ]);
    expect(positionText(box[0]!)).toBe('line 3, column 5');
    expect(positionText({ line: 2 })).toBe('line 2');
    expect(positionText({})).toBe('');
    expect(scriptProblems(doc, parts, 'script#2')).toEqual([]);
  });
});
