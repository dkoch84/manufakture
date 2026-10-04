import { describe, expect, it } from 'vitest';
import { diffDocuments } from './changes';
import { CommandSchema, applyCommand, scriptUsers, type Command } from './commands';
import {
  explicitDependencies,
  featureDependencies,
  featureExpressions,
  featureSubIds,
  scriptedReferences,
} from './features';
import { deserialize, serialize } from './format';
import { migrateCommand } from './migrations';
import { remapDocument, remapIds } from './remap';
import type { CoreErrorCode } from './result';
import {
  DocumentSchema,
  FORMAT_VERSION,
  MAX_SCRIPTS,
  MAX_SCRIPT_PARAMS,
  MAX_SCRIPT_SEED,
  MAX_SCRIPT_SOURCE_BYTES,
  MAX_SCRIPT_TOTAL_BYTES,
  ScriptSchema,
  ScriptedFeatureSchema,
  type ManufaktureDocument,
  type Script,
  type ScriptedFeature,
} from './schema';
import { createdIds } from './sync';
import { PART, bracket, clone, mm, unwrap } from './test-helpers';
import { validateDocument } from './validate';
import { renameVariable } from './variables';

/** The script library and the `scripted` feature kind (format v16, ADR 0010 decision 8). */

const script = (id = 'script#1', over: Partial<Script> = {}): Script => ({
  id,
  name: 'Box',
  language: 'ts',
  apiVersion: 1,
  source: 'export function run(ctx: unknown) {}\n',
  ...over,
});

const scripted = (over: Partial<ScriptedFeature> = {}): ScriptedFeature => ({
  id: 'scripted#1',
  kind: 'scripted',
  name: 'Box 1',
  suppressed: false,
  script: 'script#1',
  params: {
    size: { kind: 'expression', expression: mm('width / 4') },
    rounded: { kind: 'boolean', value: true },
    on: { kind: 'reference', references: [{ id: 'r3', ref: { face: 'extrude#2:side:e5' } }] },
  },
  seed: 0,
  dependsOn: ['extrude#1'],
  ...over,
});

function apply(doc: ManufaktureDocument, command: Command): ManufaktureDocument {
  return unwrap(applyCommand(doc, command)).document;
}

function refused(
  doc: ManufaktureDocument,
  command: Command,
): { code: CoreErrorCode; message: string } {
  const r = applyCommand(doc, command);
  if (r.ok) throw new Error('expected the command to be refused');
  return r.error;
}

/** The bracket with script#1 and a scripted feature that runs it. */
function withScripted(): ManufaktureDocument {
  let doc = apply(bracket(), { type: 'setScript', script: script() });
  doc = apply(doc, { type: 'addFeature', partId: PART, feature: scripted() });
  return doc;
}

describe('ScriptSchema', () => {
  it('accepts a script', () => {
    expect(ScriptSchema.parse(script())).toEqual(script());
    expect(ScriptSchema.safeParse(script('script#2', { language: 'js', source: '' })).success).toBe(
      true,
    );
  });

  const invalid: [string, unknown, string][] = [
    ['an id of another counter', script('font#1'), 'id'],
    ['an id with a leading zero', script('script#01'), 'id'],
    ['an unknown language', { ...script(), language: 'py' }, 'language'],
    ['API version 0', script('script#1', { apiVersion: 0 }), 'apiVersion'],
    ['a fractional API version', script('script#1', { apiVersion: 1.5 }), 'apiVersion'],
    ['a blank name', script('script#1', { name: '  ' }), 'name'],
    ['an unknown key', { ...script(), author: 'me' }, ''],
    [
      'a source over the limit in characters',
      script('script#1', { source: 'x'.repeat(MAX_SCRIPT_SOURCE_BYTES + 1) }),
      'source',
    ],
    [
      // Under the limit in characters, over it in UTF-8 bytes.
      'a source over the limit in UTF-8 bytes',
      script('script#1', { source: '€'.repeat(MAX_SCRIPT_SOURCE_BYTES / 3 + 1) }),
      'source',
    ],
  ];
  it.each(invalid)('refuses %s', (_what, value, path) => {
    const r = ScriptSchema.safeParse(value);
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path.join('.'))).toContain(path);
  });

  it('allows a source of exactly the limit', () => {
    const source = 'x'.repeat(MAX_SCRIPT_SOURCE_BYTES);
    expect(ScriptSchema.safeParse(script('script#1', { source })).success).toBe(true);
  });
});

describe('ScriptedFeatureSchema', () => {
  it('accepts a scripted feature with every kind of parameter value', () => {
    const f = scripted({
      params: {
        a: { kind: 'expression', expression: mm('2') },
        b: { kind: 'boolean', value: false },
        c: { kind: 'choice', value: 'hex' },
        d: { kind: 'reference', references: [] },
      },
      seed: MAX_SCRIPT_SEED,
    });
    expect(ScriptedFeatureSchema.parse(f)).toEqual(f);
  });

  const invalid: [string, Partial<Record<keyof ScriptedFeature, unknown>>, string][] = [
    ['a script id of another counter', { script: 'font#1' }, 'script'],
    ['a negative seed', { seed: -1 }, 'seed'],
    ['a fractional seed', { seed: 0.5 }, 'seed'],
    ['a seed over 32 bits', { seed: MAX_SCRIPT_SEED + 1 }, 'seed'],
    ['a missing seed', { seed: undefined }, 'seed'],
    [
      'a parameter name that is not an identifier',
      { params: { 'a b': { kind: 'boolean', value: true } } },
      'params.a b',
    ],
    [
      'an unknown parameter value kind',
      { params: { a: { kind: 'vector', value: [1] } } },
      'params.a.kind',
    ],
    ['a bare expression as a value', { params: { a: mm('1') } }, 'params.a.kind'],
    [
      'a reference parameter with a bad reference id',
      { params: { a: { kind: 'reference', references: [{ id: 'x1', ref: { face: 'a' } }] } } },
      'params.a.references.0.id',
    ],
    ['a dependency that is not a feature id', { dependsOn: ['e1'] }, 'dependsOn.0'],
  ];
  it.each(invalid)('refuses %s', (_what, over, path) => {
    const r = ScriptedFeatureSchema.safeParse({ ...scripted(), ...over });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path.join('.'))).toContain(path);
  });

  it('refuses more parameter values than the limit', () => {
    const params: ScriptedFeature['params'] = {};
    for (let i = 0; i <= MAX_SCRIPT_PARAMS; i++) params[`p${i}`] = { kind: 'boolean', value: true };
    expect(ScriptedFeatureSchema.safeParse(scripted({ params })).success).toBe(false);
  });
});

describe('the document library', () => {
  it('is absent when empty and refused as an empty list', () => {
    const doc = bracket();
    expect('scripts' in doc).toBe(false);
    expect(DocumentSchema.safeParse({ ...doc, scripts: [] }).success).toBe(false);
  });

  it('caps the source bytes of all scripts together', () => {
    const big = 'x'.repeat(MAX_SCRIPT_SOURCE_BYTES);
    const n = MAX_SCRIPT_TOTAL_BYTES / MAX_SCRIPT_SOURCE_BYTES;
    const scripts = Array.from({ length: n + 1 }, (_, i) =>
      script(`script#${i + 1}`, { source: big }),
    );
    const doc = { ...bracket(), scripts, nextIds: { part: 2, script: n + 2 } };
    expect(DocumentSchema.safeParse(doc).success).toBe(false);
    expect(DocumentSchema.safeParse({ ...doc, scripts: scripts.slice(0, n) }).success).toBe(true);
  });

  it('round-trips through the file, after the CAM section', () => {
    const doc = withScripted();
    const text = serialize(doc);
    expect(unwrap(deserialize(text)).document).toEqual(doc);
    expect(text.indexOf('"cam"')).toBeLessThan(text.indexOf('"scripts"'));
    expect(doc.version).toBe(FORMAT_VERSION);
  });
});

describe('validation', () => {
  it('accepts a scripted feature that runs a script of the library', () => {
    expect(validateDocument(withScripted())).toEqual([]);
  });

  it('refuses a scripted feature whose script the document does not have', () => {
    const doc = clone(withScripted());
    (doc.parts[0]!.features.at(-1) as ScriptedFeature).script = 'script#9';
    const issues = validateDocument(doc);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'dependency', blockers: ['script#9'] });
    expect(issues[0]!.path).toEqual(['parts', 0, 'features', 5, 'script']);
  });

  it('refuses a script id never allocated, and one used twice', () => {
    const doc = clone(withScripted());
    doc.scripts = [script(), script('script#4')];
    expect(validateDocument(doc).map((e) => e.code)).toEqual(['invalid-id']);
    doc.scripts = [script(), script()];
    expect(validateDocument(doc).map((e) => e.code)).toEqual(['duplicate']);
  });

  it('refuses a scripted feature id that does not match its kind', () => {
    const doc = clone(withScripted());
    doc.parts[0]!.features[5] = { ...scripted(), id: 'extension#1' };
    expect(validateDocument(doc).map((e) => e.code)).toContain('invalid-id');
  });

  it('refuses parameter expressions with unknown variables', () => {
    const doc = clone(withScripted());
    (doc.parts[0]!.features[5] as ScriptedFeature).params.size = {
      kind: 'expression',
      expression: mm('nope * 2'),
    };
    const issues = validateDocument(doc);
    expect(issues.map((e) => e.code)).toEqual(['unknown-variable']);
    expect(issues[0]!.path).toEqual([
      'parts',
      0,
      'features',
      5,
      'params',
      'size',
      'expression',
      'source',
    ]);
  });
});

describe('features', () => {
  const f = scripted({
    params: {
      z: { kind: 'reference', references: [{ id: 'r4', ref: { face: 'fillet#1:round:r2' } }] },
      a: {
        kind: 'reference',
        references: [{ id: 'r3', ref: { faces: ['extrude#2:side:e5', 'extrude#1:cap:end'] } }],
      },
      size: { kind: 'expression', expression: mm('width') },
      count: { kind: 'expression', expression: mm('3') },
      flag: { kind: 'boolean', value: true },
    },
    dependsOn: ['sketch#2'],
  });

  it('lists references by parameter name, so the order is stable', () => {
    expect(scriptedReferences(f).map((r) => r.id)).toEqual(['r3', 'r4']);
    expect(featureSubIds(f)).toEqual(['r3', 'r4']);
  });

  it('depends on dependsOn and on every feature its references name', () => {
    expect(explicitDependencies(f)).toEqual(['sketch#2']);
    expect(featureDependencies(f)).toEqual(['extrude#1', 'extrude#2', 'fillet#1', 'sketch#2']);
  });

  it('lists expression parameters, by name, as untyped', () => {
    expect(featureExpressions(f)).toEqual([
      { path: ['params', 'count', 'expression'], expression: mm('3'), expected: 'any' },
      { path: ['params', 'size', 'expression'], expression: mm('width'), expected: 'any' },
    ]);
  });
});

describe('commands', () => {
  it('adds a script with a fresh id, at the end or at an index', () => {
    let doc = apply(bracket(), { type: 'setScript', script: script() });
    expect(doc.scripts).toEqual([script()]);
    expect(doc.nextIds.script).toBe(2);
    doc = apply(doc, { type: 'setScript', script: script('script#2'), index: 0 });
    expect(doc.scripts!.map((s) => s.id)).toEqual(['script#2', 'script#1']);
    expect(doc.nextIds.script).toBe(3);
  });

  it('undoes adding the first script back to a document with no library', () => {
    const before = bracket();
    const r = unwrap(applyCommand(before, { type: 'setScript', script: script() }));
    expect(r.inverse).toEqual({ type: 'deleteScript', scriptId: 'script#1' });
    const back = apply(r.document, r.inverse);
    expect('scripts' in back).toBe(false);
    expect(back).toEqual({ ...before, nextIds: { ...before.nextIds, script: 2 } });
  });

  it('refuses an id handed out before, even after a delete', () => {
    let doc = apply(bracket(), { type: 'setScript', script: script() });
    doc = apply(doc, { type: 'deleteScript', scriptId: 'script#1' });
    expect(refused(doc, { type: 'setScript', script: script() }).code).toBe('id-reused');
  });

  it('refuses an index past the end and a malformed id', () => {
    expect(refused(bracket(), { type: 'setScript', script: script(), index: 1 }).code).toBe(
      'invalid-index',
    );
    expect(
      CommandSchema.safeParse({ type: 'setScript', script: script('scripted#1') }).success,
    ).toBe(false);
  });

  it('replaces a script by id, in place, and the inverse puts the old one back', () => {
    let doc = apply(bracket(), { type: 'setScript', script: script() });
    doc = apply(doc, { type: 'setScript', script: script('script#2') });
    const edited = script('script#1', { source: 'export {}', apiVersion: 2, language: 'js' });
    const r = unwrap(applyCommand(doc, { type: 'setScript', script: edited, index: 1 }));
    expect(r.document.scripts).toEqual([edited, script('script#2')]);
    expect(r.document.nextIds).toEqual(doc.nextIds);
    expect(r.inverse).toEqual({ type: 'setScript', script: script() });
    expect(apply(r.document, r.inverse)).toEqual(doc);
  });

  it('refuses to delete a script a feature runs, naming the features', () => {
    const doc = withScripted();
    expect(scriptUsers(doc, 'script#1')).toEqual([`${PART}/scripted#1`]);
    const r = applyCommand(doc, { type: 'deleteScript', scriptId: 'script#1' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('dependency');
      expect(r.error.blockers).toEqual([`${PART}/scripted#1`]);
    }
  });

  it('deletes and restores a script at its place', () => {
    let doc = apply(bracket(), { type: 'setScript', script: script() });
    doc = apply(doc, { type: 'setScript', script: script('script#2') });
    const r = unwrap(applyCommand(doc, { type: 'deleteScript', scriptId: 'script#1' }));
    expect(r.document.scripts).toEqual([script('script#2')]);
    expect(r.inverse).toEqual({ type: 'restoreScript', script: script(), index: 0 });
    expect(apply(r.document, r.inverse)).toEqual(doc);
    expect(refused(doc, { type: 'deleteScript', scriptId: 'script#7' }).code).toBe('not-found');
  });

  it('refuses to restore a script that exists or was never handed out', () => {
    const doc = apply(bracket(), { type: 'setScript', script: script() });
    expect(refused(doc, { type: 'restoreScript', script: script(), index: 0 }).code).toBe(
      'duplicate',
    );
    expect(refused(doc, { type: 'restoreScript', script: script('script#5'), index: 0 }).code).toBe(
      'invalid-id',
    );
  });

  it('keeps the library within its limits', () => {
    const big = 'x'.repeat(MAX_SCRIPT_SOURCE_BYTES);
    let doc = bracket();
    const fit = MAX_SCRIPT_TOTAL_BYTES / MAX_SCRIPT_SOURCE_BYTES;
    for (let i = 1; i <= fit; i++) {
      doc = apply(doc, { type: 'setScript', script: script(`script#${i}`, { source: big }) });
    }
    const over = script(`script#${fit + 1}`, { source: 'x' });
    expect(refused(doc, { type: 'setScript', script: over }).code).toBe('schema');
    // A replace that grows the library past the cap is refused too.
    const small = apply(doc, { type: 'setScript', script: script('script#1', { source: '' }) });
    const grown = apply(small, { type: 'setScript', script: over });
    expect(
      refused(grown, { type: 'setScript', script: script('script#1', { source: big }) }).code,
    ).toBe('schema');

    let many = bracket();
    for (let i = 1; i <= MAX_SCRIPTS; i++) {
      many = apply(many, { type: 'setScript', script: script(`script#${i}`, { source: '' }) });
    }
    expect(
      refused(many, { type: 'setScript', script: script(`script#${MAX_SCRIPTS + 1}`) }).code,
    ).toBe('schema');
  });

  it('adds a scripted feature, allocating its reference ids, and refuses an unknown script', () => {
    const doc = withScripted();
    const part = doc.parts[0]!;
    expect(part.features.at(-1)).toEqual(scripted());
    expect(part.nextIds.scripted).toBe(2);
    expect(part.nextIds.r).toBe(4);
    const other = scripted({ id: 'scripted#2', script: 'script#2', params: {} });
    expect(refused(doc, { type: 'addFeature', partId: PART, feature: other }).code).toBe(
      'dependency',
    );
  });

  it('refuses to delete a feature a scripted feature depends on', () => {
    const doc = withScripted();
    const e = refused(doc, { type: 'deleteFeature', partId: PART, featureId: 'extrude#1' });
    expect(e.code).toBe('dependency');
  });

  it('renames a variable inside parameter expressions', () => {
    const doc = withScripted();
    const command = unwrap(renameVariable(doc, 'width', 'w'));
    const next = apply(doc, command);
    const f = next.parts[0]!.features.at(-1) as ScriptedFeature;
    expect(f.params.size).toEqual({ kind: 'expression', expression: mm('#w / 4') });
  });
});

describe('changes', () => {
  it('a script edit changes the features that run it, a rename does not', () => {
    const doc = withScripted();
    const edited = apply(doc, {
      type: 'setScript',
      script: script('script#1', { source: 'export {}' }),
    });
    const change = diffDocuments(doc, edited);
    expect(change.scriptsChanged).toEqual(['script#1']);
    expect(change.parts).toHaveLength(1);
    expect(change.parts[0]).toMatchObject({ changed: ['scripted#1'], firstAffectedIndex: 5 });

    const renamed = apply(doc, { type: 'setScript', script: script('script#1', { name: 'B' }) });
    const rename = diffDocuments(doc, renamed);
    expect(rename.scriptsChanged).toEqual(['script#1']);
    expect(rename.parts).toEqual([]);
    expect(rename.empty).toBe(false);
  });

  it('adding an unused script changes no part', () => {
    const doc = withScripted();
    const next = apply(doc, { type: 'setScript', script: script('script#2') });
    const change = diffDocuments(doc, next);
    expect(change.scriptsChanged).toEqual(['script#2']);
    expect(change.parts).toEqual([]);
  });
});

describe('sync', () => {
  it('reports the script id a setScript creates, and none for a replace', () => {
    const doc = bracket();
    expect(unwrap(createdIds(doc, { type: 'setScript', script: script() }))).toEqual({
      document: ['script#1'],
    });
    const has = apply(doc, { type: 'setScript', script: script() });
    expect(
      unwrap(createdIds(has, { type: 'setScript', script: script('script#1', { name: 'B' }) })),
    ).toEqual({});
    expect(
      unwrap(createdIds(has, { type: 'addFeature', partId: PART, feature: scripted() })),
    ).toEqual({ [`part:${PART}`]: ['r3', 'scripted#1'] });
  });

  it('remaps script ids in the library, the commands and the features that run them', () => {
    const table = {
      document: { 'script#1': 'script#5' },
      [`part:${PART}`]: { 'scripted#1': 'scripted#4', r3: 'r9', 'extrude#2': 'extrude#7' },
    };
    const commands: Command[] = [
      { type: 'setScript', script: script() },
      { type: 'addFeature', partId: PART, feature: scripted() },
      { type: 'deleteScript', scriptId: 'script#1' },
      { type: 'restoreScript', script: script(), index: 0 },
    ];
    const [set, add, del, restore] = remapIds(commands, table, { document: bracket() });
    expect(set).toEqual({ type: 'setScript', script: script('script#5') });
    expect(del).toEqual({ type: 'deleteScript', scriptId: 'script#5' });
    expect(restore).toEqual({ type: 'restoreScript', script: script('script#5'), index: 0 });
    const f = (add as Extract<Command, { type: 'addFeature' }>).feature as ScriptedFeature;
    expect(f.id).toBe('scripted#4');
    expect(f.script).toBe('script#5');
    expect(f.params.on).toEqual({
      kind: 'reference',
      references: [{ id: 'r9', ref: { face: 'extrude#7:side:e5' } }],
    });
    // Values that are not ids are left alone.
    expect(f.params.size).toEqual(scripted().params.size);
    expect(f.seed).toBe(0);

    const doc = remapDocument(withScripted(), { document: { 'script#1': 'script#5' } });
    expect(doc.scripts).toEqual([script('script#5')]);
    expect((doc.parts[0]!.features.at(-1) as ScriptedFeature).script).toBe('script#5');
    expect(doc.nextIds.script).toBe(6);
    expect(validateDocument(doc)).toEqual([]);
  });
});

describe('command migrations', () => {
  it('brings a version 15 command up unchanged', () => {
    const command: Command = { type: 'setVariable', name: 'w', expression: mm('1') };
    expect(unwrap(migrateCommand(command, 15))).toEqual(command);
  });

  it('refuses a version 15 replaceDocument that carries a scripts key', () => {
    const document = { ...clone(bracket()), version: 15, scripts: [script()] };
    const r = migrateCommand({ type: 'replaceDocument', document }, 15);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('migration');
  });

  it('refuses script commands from a format newer than this build', () => {
    const r = migrateCommand({ type: 'setScript', script: script() }, FORMAT_VERSION + 1);
    expect(r.ok).toBe(false);
  });
});
