import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSourceInfo, repositoryOf, wasmModule, webUrlFromRemote } from './build';
import { KNOWN_WASM } from './offer';

const SHA = 'fedcba9876543210fedcba9876543210fedcba98';

/** A fake git: answers by the first argument, or fails (null) when not listed. */
function fakeGit(answers: Record<string, string>) {
  return (args: string[]) => answers[args.join(' ')] ?? null;
}

describe('webUrlFromRemote', () => {
  it('turns ssh and https remotes into the web address', () => {
    expect(webUrlFromRemote('git@git.example:owner/repo.git')).toBe(
      'https://git.example/owner/repo',
    );
    expect(webUrlFromRemote('ssh://git@git.example:2222/owner/repo.git')).toBe(
      'https://git.example/owner/repo',
    );
    expect(webUrlFromRemote('https://git.example/owner/repo.git')).toBe(
      'https://git.example/owner/repo',
    );
    expect(webUrlFromRemote('https://user:token@git.example/owner/repo/')).toBe(
      'https://git.example/owner/repo',
    );
  });

  it('refuses what is not a web address', () => {
    expect(webUrlFromRemote('/srv/git/repo.git')).toBeNull();
    expect(webUrlFromRemote('file:///srv/git/repo.git')).toBeNull();
    expect(webUrlFromRemote('not a url')).toBeNull();
  });
});

describe('repositoryOf', () => {
  it('reads the forms package.json allows', () => {
    expect(repositoryOf({ type: 'git', url: 'git+https://github.com/elalish/manifold.git' })).toBe(
      'https://github.com/elalish/manifold',
    );
    expect(repositoryOf('github:Salusoft89/planegcs')).toBe(
      'https://github.com/Salusoft89/planegcs',
    );
    expect(repositoryOf('owner/repo')).toBe('https://github.com/owner/repo');
    expect(repositoryOf({ url: 'https://github.com/justjake/quickjs-emscripten' })).toBe(
      'https://github.com/justjake/quickjs-emscripten',
    );
    expect(repositoryOf({ url: 'git://git.example/owner/repo.git' })).toBe(
      'https://git.example/owner/repo',
    );
    expect(repositoryOf(undefined)).toBeNull();
    expect(repositoryOf({ type: 'git' })).toBeNull();
  });
});

describe('readSourceInfo', () => {
  const git = fakeGit({
    'rev-parse HEAD': SHA,
    'status --porcelain --untracked-files=no': ' M apps/web/src/App.tsx',
    'remote get-url origin': 'git@git.example:owner/manufakture.git',
  });

  it('reads the checkout', () => {
    expect(readSourceInfo('/repo', {}, git)).toEqual({
      commit: SHA,
      dirty: true,
      repository: 'https://git.example/owner/manufakture',
    });
    expect(
      readSourceInfo(
        '/repo',
        {},
        fakeGit({ 'rev-parse HEAD': SHA, 'status --porcelain --untracked-files=no': '' }),
      ),
    ).toEqual({ commit: SHA, dirty: false, repository: null });
  });

  it('prefers GitHub Actions, then explicit settings', () => {
    const actions = {
      GITHUB_SHA: 'a'.repeat(40),
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'o/r',
    };
    expect(readSourceInfo('/repo', actions, git)).toMatchObject({
      commit: 'a'.repeat(40),
      repository: 'https://github.com/o/r',
    });
    expect(
      readSourceInfo(
        '/repo',
        {
          ...actions,
          MANUFAKTURE_SOURCE_COMMIT: 'b'.repeat(40),
          MANUFAKTURE_SOURCE_URL: 'https://fork.example/me/mfk.git',
          MANUFAKTURE_SOURCE_DIRTY: '0',
        },
        git,
      ),
    ).toEqual({ commit: 'b'.repeat(40), dirty: false, repository: 'https://fork.example/me/mfk' });
  });

  it('names nothing outside a checkout', () => {
    expect(readSourceInfo('/repo', {}, fakeGit({}))).toEqual({
      commit: null,
      dirty: false,
      repository: null,
    });
  });
});

describe('wasmModule', () => {
  it('reads version, license and repository from the installed package', () => {
    const root = mkdtempSync(join(tmpdir(), 'mfk-source-'));
    const known = KNOWN_WASM.find((k) => k.package === 'manifold-3d')!;
    const dir = join(root, known.from, 'node_modules', known.package);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        version: '9.9.9',
        license: 'Apache-2.0',
        repository: { type: 'git', url: 'git+https://github.com/elalish/manifold.git' },
      }),
    );
    expect(wasmModule(root, 'assets/manifold-x.wasm', known)).toEqual({
      file: 'assets/manifold-x.wasm',
      package: 'manifold-3d',
      version: '9.9.9',
      license: 'Apache-2.0',
      repository: 'https://github.com/elalish/manifold',
      role: known.role,
    });
  });
});
