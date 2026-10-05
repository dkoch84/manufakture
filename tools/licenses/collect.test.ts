import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { check } from './check.ts';
import {
  collect,
  compareCodeUnits,
  isPackageName,
  licenseOf,
  repositoryOf,
  resolvePackage,
  type Collected,
} from './collect.ts';
import type { Target } from './policy.ts';

// A small pnpm-shaped tree: a workspace app and package, packages under node_modules/.pnpm
// reached through symlinks, a dependency that is not installed, an optional one that is not, a
// pruned tooling dependency and a font.
let root: string;
let collected: Collected;

function file(path: string, content: string | object) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content));
}

function link(from: string, to: string) {
  const full = join(root, from);
  mkdirSync(dirname(full), { recursive: true });
  symlinkSync(relative(dirname(full), join(root, to)), full);
}

const store = (name: string, version: string) =>
  `node_modules/.pnpm/${name}@${version}/node_modules/${name}`;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'licenses-'));
  file('apps/app/package.json', {
    name: '@x/app',
    version: '0.0.0',
    license: 'GPL-3.0-or-later',
    dependencies: { a: '1', '@x/lib': 'workspace:*', gone: '1', Zed: '1', '../escape': '1' },
    optionalDependencies: { 'not-here': '1' },
    devDependencies: { dev: '1' },
  });
  link('apps/app/node_modules/a', store('a', '1.0.0'));
  link('apps/app/node_modules/Zed', store('Zed', '1.0.0'));
  file(`${store('Zed', '1.0.0')}/package.json`, { name: 'Zed', version: '1.0.0', license: 'MIT' });
  file(`${store('Zed', '1.0.0')}/LICENSE`, 'MIT text');
  // What `../escape` would reach if it were joined into a path unchecked.
  file('apps/app/escape/package.json', { name: 'escape', version: '6.6.6', license: 'MIT' });
  link('apps/app/node_modules/@x/lib', 'packages/lib');
  link('apps/app/node_modules/dev', store('dev', '1.0.0'));
  file('packages/lib/package.json', {
    name: '@x/lib',
    version: '0.0.0',
    license: 'MIT',
    dependencies: { b: '1' },
  });
  link('packages/lib/node_modules/b', store('b', '2.0.0'));

  file(`${store('a', '1.0.0')}/package.json`, {
    name: 'a',
    version: '1.0.0',
    license: 'MIT',
    repository: 'github:owner/a',
    dependencies: { c: '1' },
  });
  file(`${store('a', '1.0.0')}/LICENSE`, 'MIT text\r\n\r\n');
  file(`${store('a', '1.0.0')}/NOTICE.md`, 'a notice');
  link('node_modules/.pnpm/a@1.0.0/node_modules/c', store('c', '1.0.0'));
  file(`${store('c', '1.0.0')}/package.json`, { name: 'c', version: '1.0.0', license: 'MPL-2.0' });
  file(
    `${store('c', '1.0.0')}/LICENSE.md`,
    'Exhibit B - "Incompatible With Secondary Licenses" Notice',
  );
  file(
    `${store('c', '1.0.0')}/dist/c.js`,
    '/* This Source Code Form is "Incompatible With Secondary Licenses" */',
  );
  file(`${store('b', '2.0.0')}/package.json`, {
    name: 'b',
    version: '2.0.0',
    dependencies: { tooling: '1' },
  });
  file(`${store('dev', '1.0.0')}/package.json`, {
    name: 'dev',
    version: '1.0.0',
    license: 'AGPL-3.0-only',
  });
  file('fonts/Face.ttf', 'font bytes');
  file('fonts/README.md', 'not a font');

  const target: Target = {
    name: 'web',
    title: 'test',
    roots: ['apps/app'],
    notShipped: [{ package: 'b', dependencies: ['tooling'], reason: 'cli only' }],
    fontDirs: ['fonts'],
  };
  collected = collect(root, target, { manual: [], packageTexts: {} });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('collect', () => {
  it('walks dependencies (not devDependencies) through workspace packages and the store', () => {
    expect(collected.packages.map((p) => `${p.name}@${p.version} via ${p.via}`)).toEqual([
      // Code-unit order, whatever the locale: uppercase before lowercase.
      'Zed@1.0.0 via @x/app@0.0.0',
      'a@1.0.0 via @x/app@0.0.0',
      'b@2.0.0 via @x/lib@0.0.0',
      'c@1.0.0 via a@1.0.0',
    ]);
    expect(collected.workspace.map((w) => [w.name, w.dir, w.license])).toEqual([
      ['@x/app', 'apps/app', 'GPL-3.0-or-later'],
      ['@x/lib', 'packages/lib', 'MIT'],
    ]);
  });

  it('records missing dependencies, but not missing optional ones', () => {
    expect(collected.missing).toEqual([{ name: 'gone', from: '@x/app@0.0.0' }]);
  });

  it('never resolves a dependency key that is not an npm package name', () => {
    expect(collected.invalid).toEqual([{ name: '../escape', from: '@x/app@0.0.0' }]);
    expect(collected.packages.some((p) => p.name === 'escape')).toBe(false);
    expect(() => resolvePackage(join(root, 'apps/app'), '../escape')).toThrow(
      /not an npm package name/,
    );
  });

  it('skips the dependencies a not-shipped rule names', () => {
    expect(collected.pruned).toEqual([{ package: 'b', dependency: 'tooling' }]);
  });

  it('reads license and NOTICE files, the repository, and Exhibit B outside license files', () => {
    const a = collected.packages.find((p) => p.name === 'a')!;
    expect(a.licenseFiles).toEqual([{ name: 'LICENSE', text: 'MIT text' }]);
    expect(a.noticeFiles).toEqual([{ name: 'NOTICE.md', text: 'a notice' }]);
    expect(a.repository).toBe('https://github.com/owner/a');
    expect(a.exhibitB).toEqual([]);
    const c = collected.packages.find((p) => p.name === 'c')!;
    expect(c.exhibitB).toEqual([join('dist', 'c.js')]);
  });

  it('hashes the font files', () => {
    expect(collected.fonts).toEqual([
      { path: 'fonts/Face.ttf', sha256: createHash('sha256').update('font bytes').digest('hex') },
    ]);
  });

  it('feeds check, which names every problem', () => {
    const problems = check(collected);
    expect(problems).toHaveLength(7);
    expect(problems.join('\n')).toMatch(/"\.\.\/escape", which is not a valid npm package name/);
    expect(problems.join('\n')).toMatch(/depends on gone/);
    expect(problems.join('\n')).toMatch(/@x\/lib .* not GPL-3.0-or-later/);
    expect(problems.join('\n')).toMatch(/b@2.0.0 \(from @x\/lib@0.0.0\) declares no license/);
    expect(problems.join('\n')).toMatch(/b@2.0.0 ships no license file/);
    expect(problems.join('\n')).toMatch(/c@1.0.0 .*Incompatible With Secondary Licenses/);
    expect(problems.join('\n')).toMatch(/font fonts\/Face.ttf has no entry/);
  });
});

describe('compareCodeUnits and isPackageName', () => {
  it('orders by code unit, not by locale', () => {
    const names = ['zod', 'web-ifc', 'Zlib', 'a', '@x/b', 'zustand'];
    expect([...names].sort(compareCodeUnits)).toEqual([
      '@x/b',
      'Zlib',
      'a',
      'web-ifc',
      'zod',
      'zustand',
    ]);
    expect([...names].sort(compareCodeUnits)).toEqual([...names].sort());
    expect(compareCodeUnits('a', 'a')).toBe(0);
  });

  it('accepts npm names and rejects paths', () => {
    for (const ok of [
      'react',
      '@codemirror/view',
      'opentype.js',
      'JSONStream',
      'ipaddr.js',
      '@jitl/quickjs-ffi-types',
    ]) {
      expect(isPackageName(ok), ok).toBe(true);
    }
    for (const bad of [
      '',
      '..',
      '../x',
      '/etc',
      '@x/../y',
      '@x/y/z',
      'a/b',
      '.hidden',
      '@/x',
      'a\\b',
      '@x/',
    ]) {
      expect(isPackageName(bad), bad).toBe(false);
    }
  });
});

describe('licenseOf and repositoryOf', () => {
  it('reads the legacy license forms', () => {
    expect(licenseOf({ license: 'MIT' })).toBe('MIT');
    expect(licenseOf({ license: { type: 'ISC' } })).toBe('ISC');
    expect(licenseOf({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe(
      '(MIT) AND (Apache-2.0)',
    );
    expect(licenseOf({ license: ' ' })).toBeNull();
    expect(licenseOf({})).toBeNull();
  });

  it('turns repository fields into web addresses', () => {
    expect(repositoryOf({ type: 'git', url: 'git+https://github.com/o/r.git' })).toBe(
      'https://github.com/o/r',
    );
    expect(repositoryOf('git@github.com:o/r.git')).toBe('https://github.com/o/r');
    expect(repositoryOf('o/r')).toBe('https://github.com/o/r');
    expect(repositoryOf('gitlab:o/r')).toBe('https://gitlab.com/o/r');
    expect(repositoryOf(undefined, 'https://example.org')).toBe('https://example.org');
    expect(repositoryOf(undefined)).toBeNull();
  });
});
