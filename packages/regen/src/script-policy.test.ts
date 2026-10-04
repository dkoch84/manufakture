// The script policy (T7.2d; ADR 0010 amendment, item 11): until the security sign-off the app runs
// a document's scripts only where the user allowed them on this device. Checked here with the real
// kernel and QuickJS: a document that is not allowed builds without running anything, each
// scripted feature failing with "Scripts not run" (never cached, no run counted); a document
// grant, a grant of one exact source, and the automatic setting each let it run; and the
// declaration read the feature dialog uses.

import { readFile } from 'node:fs/promises';
import type { ScriptedFeature } from '@manufakture/core';
import type { KernelService } from '@manufakture/kernel';
import { createNodeService, wasmPath } from '@manufakture/kernel/node';
import { nodeScriptEngine } from '@manufakture/script/node';
import { createSolverService, type SolverService } from '@manufakture/sketch';
import { beforeAll, describe, expect, it } from 'vitest';
import { RegenEngine } from './engine';
import { checkScriptPolicy, scriptAllowed, sourceSha256, type ScriptPolicy } from './scripted';
import { DENY_ALL_SCRIPTS } from './scripted';
import { add, apply, block, build, derivedOf, pin, statuses } from './test-helpers';
import { createRegenWorkerApi } from './worker-api';
import type { RegenResult } from './types';

let service: KernelService;
let solver: SolverService;

beforeAll(async () => {
  service = await createNodeService();
  solver = createSolverService();
}, 60_000);

const engineWith = () =>
  new RegenEngine({ kernel: service, solver, scripts: { engine: nodeScriptEngine } });

const BLOCK = `export const params = { size: { kind: 'length', default: 10, min: 1 } };
export function run(ctx, p) {
  const s = ctx.sketch('base', { loops: [[{ kind: 'circle', id: 'rim', center: [0, 0], radius: p.size }]] });
  ctx.extrude('puck', s, { distance: 5 });
}
`;

const OTHER = `export function run(ctx) {
  const s = ctx.sketch('b', { loops: [[{ kind: 'circle', id: 'c', center: [100, 0], radius: 3 }]] });
  ctx.extrude('peg', s, { distance: 2 });
}
`;

const scripted = (id: string, script: string): ScriptedFeature => ({
  id,
  kind: 'scripted',
  name: id,
  suppressed: false,
  script,
  params: {},
  seed: 0,
  dependsOn: [],
});

/** Document `doc-1` with two scripts, each run by one scripted feature. */
function twoScripts() {
  return build([
    {
      type: 'setScript',
      script: { id: 'script#1', name: 'Block', language: 'js', apiVersion: 1, source: BLOCK },
    },
    {
      type: 'setScript',
      script: { id: 'script#2', name: 'Other', language: 'js', apiVersion: 1, source: OTHER },
    },
    add(scripted('scripted#1', 'script#1')),
    add(scripted('scripted#2', 'script#2')),
  ]);
}

const none: ScriptPolicy = { auto: false, documents: [], scripts: [] };

function errorsOf(r: RegenResult, id: string) {
  return r.parts[0]!.features.find((f) => f.featureId === id)!.errors;
}

describe('the script policy', () => {
  it('a document not allowed builds without running a script; Scripts not run is not cached', async () => {
    const engine = engineWith();
    engine.setScriptPolicy(none);
    const doc = twoScripts();
    const r = (await engine.regen(doc))!;
    expect(statuses(r)).toEqual({ 'scripted#1': 'error', 'scripted#2': 'error' });
    const [e] = errorsOf(r, 'scripted#1');
    expect(e).toMatchObject({ code: 'script', scriptCode: 'not-allowed', scriptId: 'script#1' });
    expect(e!.message).toMatch(/^Scripts not run/);
    expect(engine.scriptStats).toEqual({ declarations: 0, runs: 0, instances: 0 });
    expect(r.parts[0]!.bodies).toEqual([]);

    // Allowing the document builds both; nothing was cached as failed.
    engine.setScriptPolicy({ ...none, documents: ['doc-1'] });
    const allowed = (await engine.regen(doc))!;
    expect(statuses(allowed)).toEqual({ 'scripted#1': 'ok', 'scripted#2': 'ok' });
    expect(engine.scriptStats!.runs).toBe(2);

    // And taking the grant back stops them again, cache or not.
    engine.setScriptPolicy(none);
    const again = (await engine.regen(doc))!;
    expect(statuses(again)).toEqual({ 'scripted#1': 'error', 'scripted#2': 'error' });
    await engine.dispose();
  });

  it('a grant of one exact source runs that script only, and not once the source changes', async () => {
    const engine = engineWith();
    const sha = await sourceSha256(BLOCK);
    engine.setScriptPolicy({
      ...none,
      scripts: [{ document: 'doc-1', script: 'script#1', sha256: sha }],
    });
    const doc = twoScripts();
    const r = (await engine.regen(doc))!;
    expect(statuses(r)).toEqual({ 'scripted#1': 'ok', 'scripted#2': 'error' });
    expect(errorsOf(r, 'scripted#2')[0]).toMatchObject({ scriptCode: 'not-allowed' });

    // Another document with the same ids is not covered.
    const elsewhere = { ...doc, id: 'doc-2' };
    expect(statuses((await engine.regen(elsewhere))!)).toEqual({
      'scripted#1': 'error',
      'scripted#2': 'error',
    });

    // A changed source (as sync or a merge could bring) is not the source that was allowed.
    const changed = build([
      {
        type: 'setScript',
        script: {
          id: 'script#1',
          name: 'Block',
          language: 'js',
          apiVersion: 1,
          source: BLOCK + '// changed\n',
        },
      },
      add(scripted('scripted#1', 'script#1')),
    ]);
    expect(statuses((await engine.regen(changed))!)).toEqual({ 'scripted#1': 'error' });
    await engine.dispose();
  });

  it('the automatic setting and no policy at all run every script', async () => {
    const engine = engineWith();
    engine.setScriptPolicy({ ...none, auto: true });
    expect(statuses((await engine.regen(twoScripts()))!)).toEqual({
      'scripted#1': 'ok',
      'scripted#2': 'ok',
    });
    engine.setScriptPolicy(null);
    expect(statuses((await engine.regen({ ...twoScripts(), id: 'doc-9' }))!)).toEqual({
      'scripted#1': 'ok',
      'scripted#2': 'ok',
    });
    expect(() => engine.setScriptPolicy({ auto: 'yes' } as unknown as ScriptPolicy)).toThrow(
      TypeError,
    );
    await engine.dispose();
  });

  it('reads a script s declarations for the dialog, with errors as regen errors', async () => {
    const engine = engineWith();
    const ok = await engine.scriptDeclarations(
      { id: 'script#1', source: BLOCK, language: 'js', apiVersion: 1 },
      'doc-1',
    );
    expect(ok).toEqual({
      ok: true,
      params: [{ name: 'size', kind: 'length', default: 10, min: 1 }],
    });
    const bad = await engine.scriptDeclarations(
      {
        id: 'script#1',
        source: 'export const params = { w: { kind: "furlong" } };\nexport function run() {}',
        language: 'js',
        apiVersion: 1,
      },
      'doc-1',
    );
    expect(bad).toMatchObject({
      ok: false,
      error: { code: 'script', scriptCode: 'bad-declaration' },
    });
    const thrown = await engine.scriptDeclarations(
      {
        id: 'script#1',
        source: 'export function run() {}\nthrow new Error("nope");',
        language: 'js',
        apiVersion: 1,
      },
      'doc-1',
    );
    expect(thrown).toMatchObject({ ok: false, error: { scriptCode: 'runtime', line: 2 } });
    const version = await engine.scriptDeclarations(
      {
        id: 'script#1',
        source: BLOCK,
        language: 'js',
        apiVersion: 999,
      },
      'doc-1',
    );
    expect(version).toMatchObject({ ok: false, error: { scriptCode: 'api-version' } });
    expect(engine.scriptStats!.declarations).toBe(3);
    await engine.dispose();
  });
});

describe('the script policy: derived sources, declarations, failing closed', () => {
  it('a derived part s source scripts run only with the document grant, and the warning says so', async () => {
    const engine = engineWith();
    const source = apply(
      block(),
      {
        type: 'setScript',
        script: { id: 'script#1', name: 'Block', language: 'js', apiVersion: 1, source: OTHER },
      },
      add(scripted('scripted#1', 'script#1')),
    );
    const doc = build([add(derivedOf('derived#1', pin(source)))]);
    engine.setScriptPolicy({
      ...none,
      scripts: [{ document: 'doc-1', script: 'script#1', sha256: await sourceSha256(OTHER) }],
    });
    const r = (await engine.regen(doc))!;
    const derived = r.parts[0]!.features.find((f) => f.featureId === 'derived#1')!;
    expect(derived.warnings).toContainEqual(
      expect.objectContaining({ code: 'derived-source', scriptsNotRun: ['scripted#1'] }),
    );
    expect(engine.scriptStats!.runs).toBe(0);
    engine.setScriptPolicy({ ...none, documents: ['doc-1'] });
    const allowed = (await engine.regen(doc))!;
    const after = allowed.parts[0]!.features.find((f) => f.featureId === 'derived#1')!;
    expect(after.warnings.filter((w) => w.code === 'derived-source')).toEqual([]);
    expect(engine.scriptStats!.runs).toBe(1);
    await engine.dispose();
  });

  it('reads no declarations of a script the policy does not allow', async () => {
    const engine = engineWith();
    engine.setScriptPolicy(none);
    const script = { id: 'script#1', source: BLOCK, language: 'js' as const, apiVersion: 1 };
    expect(await engine.scriptDeclarations(script, 'doc-1')).toMatchObject({
      ok: false,
      error: { scriptCode: 'not-allowed', scriptId: 'script#1' },
    });
    expect(engine.scriptStats!.declarations).toBe(0);
    engine.setScriptPolicy({
      ...none,
      scripts: [{ document: 'doc-1', script: 'script#1', sha256: await sourceSha256(BLOCK) }],
    });
    expect((await engine.scriptDeclarations(script, 'doc-1')).ok).toBe(true);
    expect((await engine.scriptDeclarations(script, 'doc-2')).ok).toBe(false);
    await engine.dispose();
  });

  it('an engine given something that is not a policy denies every script', async () => {
    const engine = engineWith();
    expect(() => engine.setScriptPolicy({ auto: 1 } as unknown as ScriptPolicy)).toThrow(TypeError);
    const r = (await engine.regen(twoScripts()))!;
    expect(statuses(r)).toEqual({ 'scripted#1': 'error', 'scripted#2': 'error' });
    await engine.dispose();
  });

  it('the worker fails closed: no policy, null or a malformed one runs nothing', async () => {
    const api = createRegenWorkerApi({
      source: { bytes: new Uint8Array(await readFile(wasmPath())) },
      engine: { scripts: { engine: nodeScriptEngine } },
    });
    const doc = twoScripts();
    // No policy sent yet: nothing runs.
    const first = (await api.regen(doc, { generation: 1 }))!;
    expect(statuses(first)).toEqual({ 'scripted#1': 'error', 'scripted#2': 'error' });
    expect(first.parts[0]!.features[0]!.errors[0]).toMatchObject({ scriptCode: 'not-allowed' });
    await expect(api.setScriptPolicy({ ...none, auto: true })).resolves.toBeUndefined();
    expect(statuses((await api.regen(doc, { generation: 2 }))!)).toEqual({
      'scripted#1': 'ok',
      'scripted#2': 'ok',
    });
    // A refused policy, null included, denies everything again.
    await expect(api.setScriptPolicy(null as unknown as ScriptPolicy)).rejects.toThrow(/denied/);
    expect(statuses((await api.regen(doc, { generation: 3 }))!)).toEqual({
      'scripted#1': 'error',
      'scripted#2': 'error',
    });
    await api.setScriptPolicy({ ...none, auto: true });
    await expect(api.setScriptPolicy({ auto: true } as unknown as ScriptPolicy)).rejects.toThrow(
      TypeError,
    );
    expect(statuses((await api.regen(doc, { generation: 4 }))!)).toEqual({
      'scripted#1': 'error',
      'scripted#2': 'error',
    });
    expect(DENY_ALL_SCRIPTS).toEqual(none);
    expect(Object.isFrozen(DENY_ALL_SCRIPTS)).toBe(true);
  });
});

describe('script policy helpers', () => {
  it('checks a policy as untrusted input', () => {
    expect(checkScriptPolicy(none)).toEqual(none);
    expect(checkScriptPolicy(null)).toBeNull();
    expect(checkScriptPolicy({ auto: false, documents: [1], scripts: [] })).toBeNull();
    expect(
      checkScriptPolicy({
        auto: false,
        documents: [],
        scripts: [{ document: 'd', script: 's', sha256: 'XYZ' }],
      }),
    ).toBeNull();
    const extra = checkScriptPolicy({ ...none, extra: 1, documents: ['a'] });
    expect(extra).toEqual({ auto: false, documents: ['a'], scripts: [] });
  });

  it('sourceSha256 is the SHA-256 of the UTF-8 source', async () => {
    expect(await sourceSha256('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await sourceSha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('a derived source document needs the document grant, never a script grant', async () => {
    const script = { id: 'script#1', source: BLOCK };
    const sha = await sourceSha256(BLOCK);
    const policy: ScriptPolicy = {
      ...none,
      scripts: [{ document: 'doc-1', script: 'script#1', sha256: sha }],
    };
    expect(await scriptAllowed(policy, 'doc-1', true, script)).toBe(true);
    expect(await scriptAllowed(policy, 'doc-1', false, script)).toBe(false);
    expect(await scriptAllowed({ ...policy, documents: ['doc-1'] }, 'doc-1', false, script)).toBe(
      true,
    );
  });
});
