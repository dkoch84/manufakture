import { describe, expect, it } from 'vitest';
import { check } from './check.ts';
import type { Collected, CollectedPackage } from './collect.ts';
import type { ManualEntry, Target } from './policy.ts';
import { NOTICES_FILE, renderNotices } from './render.ts';
import { NOTICES_FILE as SOURCE_PAGE_LINK } from '../../apps/web/src/source/offer.ts';

const target: Target = {
  name: 'web',
  title: 'a test app',
  roots: [],
  notShipped: [],
  fontDirs: [],
};

function pkg(
  name: string,
  license: string | null,
  extra: Partial<CollectedPackage> = {},
): CollectedPackage {
  return {
    name,
    version: '1.0.0',
    license,
    repository: null,
    via: 'root',
    licenseFiles: [{ name: 'LICENSE', text: `${name} license text` }],
    noticeFiles: [],
    manualTexts: [],
    manualNote: null,
    exhibitB: [],
    ...extra,
  };
}

function manual(extra: Partial<ManualEntry> = {}): ManualEntry {
  return {
    name: 'zlib (in mod)',
    version: '1.3',
    license: 'Zlib',
    kind: 'component',
    targets: ['web'],
    inside: ['mod'],
    source: 'https://example.org/zlib',
    texts: ['texts/zlib.txt'],
    note: 'read from upstream',
    ...extra,
  };
}

function collected(extra: Partial<Collected> = {}): Collected {
  return {
    target,
    packages: [],
    workspace: [],
    missing: [],
    invalid: [],
    pruned: [],
    manual: [],
    fonts: [],
    ...extra,
  };
}

describe('check', () => {
  it('passes a clean closure', () => {
    const c = collected({
      packages: [pkg('a', 'MIT'), pkg('mod', '(MIT OR Apache-2.0)')],
      workspace: [{ name: '@x/app', dir: 'apps/app', license: 'GPL-3.0-or-later' }],
      manual: [{ entry: manual(), texts: [{ name: 'texts/zlib.txt', text: 'zlib text' }] }],
    });
    expect(check(c)).toEqual([]);
  });

  it('fails a package with no license, or one off the allowlist', () => {
    const problems = check(
      collected({
        packages: [pkg('none', null), pkg('agpl', 'AGPL-3.0-only'), pkg('lgpl', 'LGPL-2.1-only')],
      }),
    );
    expect(problems).toEqual([
      'none@1.0.0 (from root) declares no license',
      'agpl@1.0.0 (from root): license "AGPL-3.0-only": AGPL-3.0-only is not allowed (ADR 0006 decision 3)',
      'lgpl@1.0.0 (from root): license "LGPL-2.1-only": LGPL-2.1-only is allowed only for a separately loaded .wasm module (ADR 0006 decision 4)',
    ]);
  });

  it('allows LGPL for the separate .wasm modules of the policy', () => {
    expect(
      check(
        collected({
          packages: [pkg('libcascade', 'LGPL-2.1-only WITH Open-CASCADE-Exception-1.0')],
        }),
      ),
    ).toEqual([]);
  });

  it('fails MPL-2.0 files that carry Exhibit B', () => {
    const problems = check(
      collected({ packages: [pkg('m', 'MPL-2.0', { exhibitB: ['dist/m.js'] })] }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/Incompatible With Secondary Licenses/);
  });

  it('needs a license text: a file in the package, or a manual one', () => {
    const bare = pkg('bare', 'MIT', { licenseFiles: [] });
    expect(check(collected({ packages: [bare] }))[0]).toMatch(/ships no license file/);
    const covered = { ...bare, manualTexts: [{ name: 'texts/bare.txt', text: 'MIT text' }] };
    expect(check(collected({ packages: [covered] }))).toEqual([]);
    const broken = { ...bare, manualTexts: [{ name: 'texts/bare.txt', text: null }] };
    expect(check(collected({ packages: [broken] }))).toEqual([
      'bare@1.0.0 ships no license file; add its text to PACKAGE_TEXTS (tools/licenses/policy.ts)',
      'bare@1.0.0: license text texts/bare.txt is missing',
    ]);
  });

  it('fails dependency keys that are not npm package names', () => {
    expect(check(collected({ invalid: [{ name: '../escape', from: 'a@1.0.0' }] }))).toEqual([
      'a@1.0.0 declares dependency "../escape", which is not a valid npm package name',
    ]);
  });

  it('fails missing dependencies and workspace packages that are not GPL-3.0-or-later', () => {
    const problems = check(
      collected({
        missing: [{ name: 'gone', from: '@x/app@0.0.0' }],
        workspace: [{ name: '@x/lib', dir: 'packages/lib', license: 'MIT' }],
      }),
    );
    expect(problems).toEqual([
      '@x/app@0.0.0 depends on gone, which is not installed (run pnpm install)',
      '@x/lib (packages/lib) says license "MIT", not GPL-3.0-or-later (ADR 0006 decision 1)',
    ]);
  });

  it('checks manual entries: license, texts, and that their package still ships', () => {
    const problems = check(
      collected({
        packages: [pkg('other', 'MIT')],
        manual: [
          {
            entry: manual({ license: 'JSON' }),
            texts: [{ name: 'texts/zlib.txt', text: null }],
          },
        ],
      }),
    );
    expect(problems).toEqual([
      'zlib (in mod) 1.3: license "JSON": JSON is not on the allowlist',
      'zlib (in mod) 1.3: license text texts/zlib.txt is missing',
      'zlib (in mod) 1.3: none of the packages it is inside (mod) ships with the web target; remove or update the entry',
    ]);
  });

  it('lets a manual entry inside a separate module be LGPL', () => {
    const c = collected({
      packages: [pkg('libcascade', 'LGPL-2.1-only')],
      manual: [
        {
          entry: manual({ license: 'LGPL-2.1-or-later', inside: ['libcascade'] }),
          texts: [{ name: 't', text: 'x' }],
        },
      ],
    });
    expect(check(c)).toEqual([]);
  });

  it('needs every font file listed with its hash, and OFL only for fonts', () => {
    const font = manual({
      name: 'Face',
      license: 'OFL-1.1',
      kind: 'font',
      inside: [],
      files: [{ path: 'fonts/a.ttf', sha256: 'aaa' }],
    });
    const texts = [{ name: 'fonts/OFL.txt', text: 'OFL' }];
    expect(
      check(
        collected({
          manual: [{ entry: font, texts }],
          fonts: [{ path: 'fonts/a.ttf', sha256: 'aaa' }],
        }),
      ),
    ).toEqual([]);
    expect(
      check(
        collected({
          manual: [{ entry: font, texts }],
          fonts: [
            { path: 'fonts/a.ttf', sha256: 'bbb' },
            { path: 'fonts/b.otf', sha256: 'ccc' },
          ],
        }),
      ),
    ).toEqual([
      'font fonts/a.ttf has SHA-256 bbb, not the aaa its entry records; a changed font needs its license read again (ADR 0011)',
      'font fonts/b.otf has no entry in MANUAL_ENTRIES (tools/licenses/policy.ts)',
    ]);
    expect(check(collected({ manual: [{ entry: font, texts }] }))).toEqual([
      'font fonts/a.ttf is listed in MANUAL_ENTRIES but missing',
    ]);
    const notFont = { ...font, kind: 'component' as const, files: [] };
    expect(check(collected({ manual: [{ entry: notFont, texts }] }))[0]).toMatch(
      /for font files only/,
    );
  });

  it('fails a not-shipped rule that matches nothing', () => {
    const t: Target = {
      ...target,
      notShipped: [{ package: 'tool', dependencies: '*', reason: 'cli' }],
    };
    expect(check(collected({ target: t }))).toEqual([
      'web: the not-shipped rule for tool matched nothing; remove it from policy.ts',
    ]);
    expect(check(collected({ target: t, pruned: [{ package: 'tool', dependency: 'x' }] }))).toEqual(
      [],
    );
  });
});

describe('renderNotices', () => {
  it('is the file the source page links to', () => {
    expect(NOTICES_FILE).toBe(SOURCE_PAGE_LINK);
  });

  it('writes every package and entry with its texts, the same bytes every time', () => {
    const c = collected({
      packages: [
        pkg('a', 'MIT', {
          repository: 'https://example.org/a',
          noticeFiles: [{ name: 'NOTICE', text: 'a notice' }],
        }),
      ],
      manual: [
        {
          entry: manual({ inside: ['a'] }),
          texts: [{ name: 'texts/zlib.txt', text: 'zlib text' }],
        },
      ],
    });
    const text = renderNotices(c);
    expect(text).toBe(renderNotices(c));
    expect(text).toContain('Third-party notices: manufakture, a test app');
    expect(text).toContain('Contents (1 npm package, 1 component inside them, 0 fonts):');
    expect(text).toContain('  a 1.0.0 (MIT)');
    expect(text).toContain('a 1.0.0\nLicense: MIT\nSource: https://example.org/a\n');
    expect(text).toContain('--- LICENSE ---\n\na license text\n');
    expect(text).toContain('--- NOTICE ---\n\na notice\n');
    expect(text).toContain(
      'zlib (in mod), 1.3\nLicense: Zlib\nSource: https://example.org/zlib\nInside: a\n',
    );
    expect(text).toContain('zlib text');
    expect(text.endsWith('\n')).toBe(true);
  });
});
