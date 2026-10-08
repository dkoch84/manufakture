import { describe, expect, it } from 'vitest';
import {
  AUTO_RUN_DEFAULT,
  MAX_SOURCES_PER_SCRIPT,
  SCRIPT_GRANTS_KEY,
  SCRIPTS_SECURITY_SIGNED_OFF,
  blockedUses,
  createScriptGrantsStore,
  mayRunScript,
  readSaved,
  scriptedUses,
  sourceSha256,
} from './policy';
import { BOX_SOURCE, OTHER_SOURCE, memoryStorage, scriptedDocument } from './scripts.test-fixture';

const shasOf = async (...sources: string[]) =>
  new Map(await Promise.all(sources.map(async (s) => [s, await sourceSha256(s)] as const)));

describe('the script opt-in', () => {
  it('runs nothing automatically until the security sign-off', () => {
    expect(SCRIPTS_SECURITY_SIGNED_OFF).toBe(false);
    expect(AUTO_RUN_DEFAULT).toBe(false);
    const grants = createScriptGrantsStore(() => memoryStorage());
    expect(grants.getState().auto()).toBe(false);
    expect(grants.getState().policy()).toEqual({ auto: false, documents: [], scripts: [] });
  });

  it('allows a document, then lists nothing as blocked in it', async () => {
    const doc = scriptedDocument();
    const grants = createScriptGrantsStore(() => memoryStorage());
    const shas = await shasOf(BOX_SOURCE, OTHER_SOURCE);
    const blocked = blockedUses(doc, grants.getState(), shas)!;
    expect(blocked.map((u) => [u.feature.id, u.script?.name])).toEqual([
      ['scripted#1', 'Box'],
      ['scripted#2', 'Other'],
    ]);
    const revision = grants.getState().revision;
    grants.getState().allowDocument(doc.id);
    expect(grants.getState().revision).toBe(revision + 1);
    expect(blockedUses(doc, grants.getState(), shas)).toEqual([]);
    expect(grants.getState().policy().documents).toEqual(['doc-s']);
    // Another document is not covered.
    expect(blockedUses({ ...doc, id: 'doc-t' }, grants.getState(), shas)).toHaveLength(2);
  });

  it('a source saved in the editor runs; another script of the document, or a changed source, does not', async () => {
    const doc = scriptedDocument();
    const grants = createScriptGrantsStore(() => memoryStorage());
    await grants.getState().allowSource(doc.id, 'script#1', BOX_SOURCE);
    const shas = await shasOf(BOX_SOURCE, OTHER_SOURCE);
    expect(blockedUses(doc, grants.getState(), shas)!.map((u) => u.feature.id)).toEqual([
      'scripted#2',
    ]);
    const box = doc.scripts![0]!;
    expect(await mayRunScript(grants.getState(), doc.id, box)).toBe(true);
    expect(
      await mayRunScript(grants.getState(), doc.id, { ...box, source: BOX_SOURCE + ' ' }),
    ).toBe(false);
    expect(await mayRunScript(grants.getState(), 'doc-t', box)).toBe(false);
    expect(grants.getState().policy().scripts).toEqual([
      { document: 'doc-s', script: 'script#1', sha256: await sourceSha256(BOX_SOURCE) },
    ]);
  });

  it('says whether a grant was new, and takes back exactly one source', async () => {
    const grants = createScriptGrantsStore(() => memoryStorage());
    expect(await grants.getState().allowSource('d', 's', 'a')).toBe(true);
    expect(await grants.getState().allowSource('d', 's', 'a')).toBe(false);
    await grants.getState().allowSource('d', 's', 'b');
    await grants.getState().revokeSource('d', 's', 'a');
    expect(grants.getState().sources.map((g) => g.sha256)).toEqual([await sourceSha256('b')]);
  });

  it('is null while a source in use has no hash yet', () => {
    const grants = createScriptGrantsStore(() => memoryStorage());
    expect(blockedUses(scriptedDocument(), grants.getState(), new Map())).toBeNull();
  });

  it('keeps the last few sources per script, so undo finds an older one allowed', async () => {
    const grants = createScriptGrantsStore(() => memoryStorage());
    for (let i = 0; i < MAX_SOURCES_PER_SCRIPT + 5; i++) {
      await grants.getState().allowSource('d', 's', `source ${i}`);
    }
    await grants.getState().allowSource('d', 'other', 'x');
    const mine = grants.getState().sources.filter((g) => g.script === 's');
    expect(mine).toHaveLength(MAX_SOURCES_PER_SCRIPT);
    expect(mine.at(-1)!.sha256).toBe(await sourceSha256(`source ${MAX_SOURCES_PER_SCRIPT + 4}`));
  });

  it('on an agent’s branch asks again: no whole-document choice or setting, only exact sources', async () => {
    const doc = scriptedDocument();
    const grants = createScriptGrantsStore(() => memoryStorage(), { signedOff: true });
    grants.getState().allowDocument(doc.id);
    grants.getState().allowDocument('doc-other');
    const shas = await shasOf(BOX_SOURCE, OTHER_SOURCE);
    expect(blockedUses(doc, grants.getState(), shas)).toEqual([]);
    const revision = grants.getState().revision;
    grants.getState().setAgentDocument(doc.id);
    expect(grants.getState().revision).toBe(revision + 1);
    // Unchanged scope: no new revision (no regen).
    grants.getState().setAgentDocument(doc.id);
    expect(grants.getState().revision).toBe(revision + 1);
    // No document is allowed whole, not even another one a derived part takes from.
    expect(grants.getState().policy()).toEqual({ auto: false, documents: [], scripts: [] });
    expect(blockedUses(doc, grants.getState(), shas)).toHaveLength(2);
    expect(
      await mayRunScript(grants.getState(), doc.id, { id: 'script#1', source: BOX_SOURCE }),
    ).toBe(false);
    // Allowed exactly as it is: that source runs, a changed one does not.
    await grants.getState().allowSource(doc.id, 'script#1', BOX_SOURCE);
    expect(blockedUses(doc, grants.getState(), shas)!.map((u) => u.feature.id)).toEqual([
      'scripted#2',
    ]);
    expect(
      await mayRunScript(grants.getState(), doc.id, { id: 'script#1', source: `${BOX_SOURCE} ` }),
    ).toBe(false);
    // Back on a person's branch the earlier choices hold again, and the scope is never stored.
    grants.getState().setAgentDocument(null);
    expect(blockedUses(doc, grants.getState(), shas)).toEqual([]);
    expect(grants.getState().policy().auto).toBe(true);
  });

  it('the automatic setting is locked off until the sign-off, even if storage says on', () => {
    const storage = memoryStorage({ [SCRIPT_GRANTS_KEY]: JSON.stringify({ auto: true }) });
    const grants = createScriptGrantsStore(() => storage);
    expect(grants.getState().autoAvailable).toBe(false);
    expect(grants.getState().autoChoice).toBe(true);
    expect(grants.getState().auto()).toBe(false);
    grants.getState().setAuto(true);
    expect(grants.getState().auto()).toBe(false);
    expect(grants.getState().policy().auto).toBe(false);
    expect(blockedUses(scriptedDocument(), grants.getState(), new Map())).toBeNull();
  });

  it('after the sign-off the setting is on by default, can be turned off, and runs every document', () => {
    const grants = createScriptGrantsStore(() => memoryStorage(), { signedOff: true });
    expect(grants.getState().autoAvailable).toBe(true);
    expect(grants.getState().auto()).toBe(true);
    expect(blockedUses(scriptedDocument(), grants.getState(), new Map())).toEqual([]);
    expect(grants.getState().policy().auto).toBe(true);
    grants.getState().setAuto(false);
    expect(grants.getState().auto()).toBe(false);
    expect(grants.getState().policy().auto).toBe(false);
  });

  it('is kept in storage, never in the document, and read back checked', async () => {
    const storage = memoryStorage();
    const grants = createScriptGrantsStore(() => storage);
    grants.getState().allowDocument('doc-s');
    await grants.getState().allowSource('doc-x', 'script#1', 'a');
    const again = createScriptGrantsStore(() => storage);
    expect(again.getState().documents).toEqual(['doc-s']);
    expect(again.getState().sources).toHaveLength(1);
    expect(again.getState().autoChoice).toBeNull();
    const signed = createScriptGrantsStore(() => storage, { signedOff: true });
    signed.getState().setAuto(false);
    expect(JSON.parse(storage.getItem(SCRIPT_GRANTS_KEY)!)).toMatchObject({ auto: false });
    expect(
      createScriptGrantsStore(() => storage, { signedOff: true })
        .getState()
        .auto(),
    ).toBe(false);

    // Forgetting a document drops its grants of both kinds.
    again.getState().forget('doc-s');
    again.getState().forget('doc-x');
    expect(again.getState().policy()).toEqual({ auto: false, documents: [], scripts: [] });

    expect(readSaved('{not json')).toEqual({ autoChoice: null, documents: [], sources: [] });
    expect(
      readSaved(
        JSON.stringify({
          auto: 'yes',
          documents: ['a', 3],
          sources: [{ document: 'a', script: 'b', sha256: 'nothex' }],
        }),
      ),
    ).toEqual({ autoChoice: null, documents: ['a'], sources: [] });
  });

  it('survives storage that throws', () => {
    const grants = createScriptGrantsStore(() => {
      throw new Error('no storage');
    });
    grants.getState().allowDocument('d');
    expect(grants.getState().documents).toEqual(['d']);
  });

  it('lists every scripted feature with its part and script', () => {
    const uses = scriptedUses(scriptedDocument());
    expect(uses.map((u) => [u.partName, u.feature.name, u.script?.id])).toEqual([
      ['Part 1', 'Scripted 1', 'script#1'],
      ['Part 1', 'Scripted 2', 'script#2'],
    ]);
  });
});
