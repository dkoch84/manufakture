// The source offer (ADR 0006, task T7.3c). Serving the app distributes it, so every build carries
// a page, `source.html`, that names the exact commit it was built from and, for every `.wasm`
// module it ships, the package, version, license and upstream repository that hold the module's
// build recipe. The build (vite.config.ts) gathers the facts and writes the page; this module is
// pure, so the page is unit tested (offer.test.ts) and the dev server can serve the same page.

/** The page's file name, at the root of the build next to index.html. */
export const SOURCE_PAGE = 'source.html';

/** Where the build came from. */
export interface SourceInfo {
  /** The full commit id, or null when the build was not made from a git checkout. */
  commit: string | null;
  /** True when the working tree had changes not in `commit`. */
  dirty: boolean;
  /** The public repository's web address (no trailing slash), or null when not known. */
  repository: string | null;
}

/** A `.wasm` module the build ships, and where its build recipe lives. */
export interface WasmModule {
  /** The file's name in the build (`assets/name-hash.wasm`). */
  file: string;
  package: string;
  version: string;
  license: string;
  /** The upstream repository's web address, or null when the package names none. */
  repository: string | null;
  /** What the module is, for people. */
  role: string;
}

/** A shipped `.wasm`, by the name Vite gives it before the hash, and the package it comes from. */
export interface KnownWasm {
  /** The file name without hash and extension, e.g. `opencascade_single`. */
  base: string;
  package: string;
  /** The workspace package that depends on it (its node_modules holds the installed copy). */
  from: string;
  role: string;
}

/**
 * Every `.wasm` the app may ship. A build that emits one not listed here fails (vite.config.ts),
 * so a new module cannot ship without its entry on the source page.
 */
export const KNOWN_WASM: readonly KnownWasm[] = [
  {
    base: 'opencascade_single',
    package: 'libcascade',
    from: 'packages/kernel',
    role: 'the geometry kernel (OpenCASCADE), loaded by the regen worker',
  },
  {
    base: 'planegcs',
    package: '@salusoft89/planegcs',
    from: 'packages/sketch',
    role: 'the sketch constraint solver (FreeCAD planegcs)',
  },
  {
    base: 'manifold',
    package: 'manifold-3d',
    from: 'packages/regen',
    role: 'mesh booleans for framing members with cuts',
  },
  {
    base: 'web-ifc',
    package: 'web-ifc',
    from: 'packages/io',
    role: 'the IFC writer, loaded only on IFC export',
  },
  {
    base: 'emscripten-module',
    package: '@jitl/quickjs-wasmfile-release-sync',
    from: 'packages/script',
    role: 'the QuickJS interpreter that runs scripted features',
  },
];

/** A Vite asset name with its content hash: `name-XXXXXXXX.ext`. */
const HASHED = /^(.+)-[A-Za-z0-9_-]{8}$/;

/** The entry for an emitted `.wasm` file (`assets/planegcs-r8EUavAY.wasm`), or undefined. */
export function knownWasmFor(fileName: string): KnownWasm | undefined {
  const name = fileName.split('/').pop() ?? fileName;
  if (!name.endsWith('.wasm')) return undefined;
  const stem = name.slice(0, -'.wasm'.length);
  const base = HASHED.exec(stem)?.[1] ?? stem;
  return KNOWN_WASM.find((k) => k.base === base);
}

/** Text safe inside HTML element content and double-quoted attributes. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http(s) addresses become links; anything else is shown as text. */
function link(href: string | null, text: string): string {
  if (href && /^https?:\/\//.test(href)) {
    return `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
  }
  return escapeHtml(text);
}

/** A link into the repository at the commit, in GitHub's `tree/` and `blob/` form (GitLab redirects it). */
function atCommit(info: SourceInfo, path = ''): string | null {
  if (!info.repository || !info.commit) return null;
  return path
    ? `${info.repository}/blob/${info.commit}/${path}`
    : `${info.repository}/tree/${info.commit}`;
}

/**
 * The source page: static HTML with no script and no inline style (its few rules are in
 * `source.css`, emitted next to it), so it works under the strict Content-Security-Policy.
 */
export function renderSourcePage(info: SourceInfo, modules: readonly WasmModule[]): string {
  const short = info.commit ? info.commit.slice(0, 12) : null;
  const commitLine = info.commit
    ? `This build was made from commit ${link(atCommit(info), short!)}` +
      (info.repository ? ` of ${link(info.repository, info.repository)}.` : '.')
    : 'This build was not made from a git checkout, so it names no commit.';
  const dirtyLine = info.dirty
    ? '<p class="warning" data-testid="source-dirty"><strong>The build was made from a working tree with changes that are not in that commit,</strong> so the commit is not its exact source. Whoever serves this build must offer its modified source as well.</p>'
    : '';
  const rows = modules
    .map(
      (m) =>
        `<tr><td><code>${escapeHtml(m.file)}</code></td><td>${escapeHtml(m.role)}</td>` +
        `<td>${link(m.repository, `${m.package} ${m.version}`)}</td>` +
        `<td>${escapeHtml(m.license)}</td></tr>`,
    )
    .join('\n');
  const docs = (path: string, text: string) => link(atCommit(info, path), text);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="referrer" content="no-referrer" />
    <link rel="icon" href="icons/icon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="source.css" />
    <title>manufakture: source code</title>
  </head>
  <body>
    <main>
      <h1>Source code of this build</h1>
      <p>manufakture is free software, licensed under the GNU General Public License, version 3 or (at your option) any later version. You may copy, change and share it under that license.</p>
      <p data-testid="source-commit"${info.commit ? ` data-commit="${escapeHtml(info.commit)}"` : ''}>${commitLine}</p>
      ${dirtyLine}
      <p>The licenses and the dependency rules are in ${docs('docs/adr/0006-licensing.md', 'ADR 0006')}; the exact version of every dependency is pinned in ${docs('pnpm-lock.yaml', 'pnpm-lock.yaml')}. How to build and host it yourself: ${docs('docs/hosting.md', 'docs/hosting.md')}.</p>
      <h2>WebAssembly modules</h2>
      <p>Each module below is a separate file, loaded at run time and never bundled into the app's JavaScript, so it can be replaced by a build of your own. Its source and build recipe are in the upstream repository named, at the version shown.</p>
      <table data-testid="source-wasm">
        <thead><tr><th>File</th><th>What it is</th><th>Package and source</th><th>License</th></tr></thead>
        <tbody>
${rows}
        </tbody>
      </table>
      <p><a href="./">Back to manufakture</a></p>
    </main>
  </body>
</html>
`;
}

/** The source page's stylesheet (a file of its own, so the page needs no inline style). */
export const SOURCE_CSS = `body { font-family: system-ui, sans-serif; color: #1f2733; background: #f4f6f8; margin: 0; }
main { max-width: 52rem; margin: 0 auto; padding: 1.5rem; line-height: 1.45; }
h1 { font-size: 1.4rem; }
h2 { font-size: 1.1rem; margin-top: 1.5rem; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; background: #fff; }
th, td { text-align: left; vertical-align: top; padding: 0.3rem 0.5rem; border: 1px solid #d6dce3; }
code { font-size: 0.85em; word-break: break-all; }
.warning { padding: 0.5rem 0.75rem; background: #fff4e5; border: 1px solid #f0b46c; }
`;
