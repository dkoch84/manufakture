import { describe, expect, it } from 'vitest';
import {
  KNOWN_WASM,
  escapeHtml,
  knownWasmFor,
  renderSourcePage,
  type SourceInfo,
  type WasmModule,
} from './offer';

const INFO: SourceInfo = {
  commit: '0123456789abcdef0123456789abcdef01234567',
  dirty: false,
  repository: 'https://git.example/owner/manufakture',
};

const KERNEL: WasmModule = {
  file: 'assets/opencascade_single-B9DBEong.wasm',
  package: 'libcascade',
  version: '3.0.2',
  license: 'LGPL-2.1-only WITH Open-CASCADE-Exception-1.0',
  repository: 'https://github.com/taucad/opencascade.js',
  role: 'the geometry kernel',
};

describe('knownWasmFor', () => {
  it('finds a shipped module by its name before the hash', () => {
    expect(knownWasmFor('assets/opencascade_single-B9DBEong.wasm')?.package).toBe('libcascade');
    expect(knownWasmFor('assets/planegcs-r8EUavAY.wasm')?.package).toBe('@salusoft89/planegcs');
    expect(knownWasmFor('assets/manifold-BE4c7gO-.wasm')?.package).toBe('manifold-3d');
    // A hyphen in the module's own name is not taken for the hash.
    expect(knownWasmFor('assets/web-ifc-BDaIXFUT.wasm')?.package).toBe('web-ifc');
    expect(knownWasmFor('assets/emscripten-module-Ab_d-123.wasm')?.package).toBe(
      '@jitl/quickjs-wasmfile-release-sync',
    );
    expect(knownWasmFor('planegcs.wasm')?.base).toBe('planegcs');
  });

  it('knows nothing else', () => {
    expect(knownWasmFor('assets/opencascade_multi-B9DBEong.wasm')).toBeUndefined();
    expect(knownWasmFor('assets/planegcs-r8EUavAY.js')).toBeUndefined();
    expect(knownWasmFor('assets/other-12345678.wasm')).toBeUndefined();
  });

  it('has one entry per module name', () => {
    const bases = KNOWN_WASM.map((k) => k.base);
    expect(new Set(bases).size).toBe(bases.length);
  });
});

describe('renderSourcePage', () => {
  it('names the commit, links it in the repository and lists every module', () => {
    const html = renderSourcePage(INFO, [KERNEL]);
    expect(html).toContain(`data-commit="${INFO.commit}"`);
    expect(html).toContain(`href="${INFO.repository}/tree/${INFO.commit}"`);
    expect(html).toContain('>0123456789ab</a>');
    expect(html).toContain(
      `href="${INFO.repository}/blob/${INFO.commit}/docs/adr/0006-licensing.md"`,
    );
    expect(html).toContain('<code>assets/opencascade_single-B9DBEong.wasm</code>');
    expect(html).toContain(
      '<a href="https://github.com/taucad/opencascade.js">libcascade 3.0.2</a>',
    );
    expect(html).toContain('GNU General Public License, version 3');
    expect(html).not.toContain('source-dirty');
  });

  it('carries no script and no inline style, so the strict policy serves it', () => {
    const html = renderSourcePage(INFO, [KERNEL]);
    expect(html).not.toMatch(/<script|<style|\sstyle=|\son[a-z]+=/i);
    expect(html).toContain('<link rel="stylesheet" href="source.css" />');
  });

  it('says so when the build is not exactly the commit', () => {
    const html = renderSourcePage({ ...INFO, dirty: true }, []);
    expect(html).toContain('data-testid="source-dirty"');
  });

  it('works without a commit or a repository', () => {
    const none = renderSourcePage({ commit: null, dirty: false, repository: null }, [
      { ...KERNEL, repository: null },
    ]);
    expect(none).toContain('names no commit');
    expect(none).not.toContain('data-commit');
    expect(none).toContain('<td>libcascade 3.0.2</td>');
    const noRepo = renderSourcePage({ ...INFO, repository: null }, []);
    expect(noRepo).toContain('commit 0123456789ab.');
    expect(noRepo).not.toContain('<a href="null');
  });

  it('escapes what it prints and links only http(s) addresses', () => {
    const html = renderSourcePage(INFO, [
      {
        ...KERNEL,
        package: '<img src=x>',
        license: 'A & "B"',
        repository: 'javascript:alert(1)',
      },
    ]);
    expect(html).toContain('&lt;img src=x&gt; 3.0.2');
    expect(html).toContain('A &amp; &quot;B&quot;');
    expect(html).not.toContain('javascript:');
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});
