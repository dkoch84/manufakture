// What the viewer's JavaScript may contain, checked on every build (vite.config.ts,
// `viewerBundleCheck`) and measured again in the browser by e2e/viewer.spec.ts. Pure, so it is
// unit tested (bundleCheck.test.ts).
//
// The viewer (viewer.html, src/viewer/) shows a published `.mfkview` with three.js and the
// viewport's engine. It must never load the kernel (OCCT), the sketch solver (planegcs), regen,
// core or any editor code: a link someone sends you should open fast and run nothing it does not
// need. The rule is an allowlist over the modules rendered into the chunks the viewer entry
// reaches, statically or by `import()`: anything not on it fails the build and names the module.
//
// The budget is gzip bytes of those chunks, the size that crosses the network from a host that
// compresses (raw bytes are reported beside it). Measured at T7.3b: 314.7 KiB gzip (1138.7 KiB
// raw) in 9 files, nearly all of it shared with the app: three.js about 204 KiB (its `three`
// chunk also holds the addons the app uses, GLTFExporter among them, about 15 KiB), React about
// 60 KiB, and the viewport engine with the mfkview reader, fflate and the units formatter about
// 45 KiB; the viewer's own chunk is about 5 KiB. The budget is that plus about 8 percent: room
// for small growth, but a change that drags in another package fails.

/** Gzip bytes the viewer's JavaScript may weigh. */
export const VIEWER_JS_BUDGET_GZIP = 340 * 1024;

/** One chunk of the build, as the bundle check sees it. */
export interface BuiltChunk {
  fileName: string;
  /** The module the chunk stands for (an HTML entry for the pages), or null. */
  facadeModuleId: string | null;
  imports: readonly string[];
  dynamicImports: readonly string[];
  /** Module ids rendered into the chunk with any code (tree-shaken modules left out). */
  modules: readonly string[];
  rawBytes: number;
  gzipBytes: number;
}

export interface ViewerBundleReport {
  /** The viewer's chunks, entry first. */
  files: string[];
  rawBytes: number;
  gzipBytes: number;
  /** Modules that are not on the viewer's list, each with the rule it broke. */
  forbidden: { id: string; reason: string }[];
  /** Everything wrong, worded for a build log; empty when the viewer passes. */
  problems: string[];
}

/** Whether a chunk is the viewer page's entry. */
export const isViewerEntry = (c: Pick<BuiltChunk, 'facadeModuleId'>): boolean =>
  /(^|[\\/])viewer\.html$/.test(c.facadeModuleId ?? '');

// App modules the viewer may use: its own, the viewport (engine, materials, view cube, picking,
// navigation and the toolbar), the two view stores the engine reads, the length formatter, and
// the "Source" link (T7.3c; the page's name only, the page itself is built in Node).
const APP_ALLOWED = [
  /^src\/viewer\//,
  /^src\/viewport\//,
  /^src\/state\/(selection|viewSettings)\.ts$/,
  /^src\/measure\/format\.ts$/,
  /^src\/source\/(SourceLink\.tsx|offer\.ts)$/,
];

// Workspace packages: the `.mfkview` reader and its bounded zip reader, the units formatter, and
// two data-only kernel files (the `UNNAMED` constant and the name table: no OCCT in either).
const PACKAGE_ALLOWED = [
  /^io\/src\/(mfkview|zip)\.ts$/,
  /^units\/src\//,
  /^kernel\/src\/(types|names)\.ts$/,
];

// npm packages: three.js, React, zustand (the view stores) and fflate (inflate).
const NPM_ALLOWED = new Set(['three', 'react', 'react-dom', 'scheduler', 'zustand', 'fflate']);

/** Why a module may not be in the viewer, or null when it may. */
export function forbiddenReason(id: string, appRoot: string): string | null {
  const path = id.replace(/\\/g, '/').split('?')[0]!;
  // Bundler runtime and Vite's helpers (preload, modulepreload polyfill) are virtual modules.
  if (path.startsWith('\0') || /^(rolldown|vite)\//.test(path) || !path.startsWith('/')) {
    return null;
  }
  const npm = /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\//.exec(path);
  if (npm) {
    return NPM_ALLOWED.has(npm[1]!)
      ? null
      : `the npm package ${npm[1]} is not on the viewer's list`;
  }
  const root = appRoot.replace(/\\/g, '/').replace(/\/$/, '');
  if (path === `${root}/viewer.html`) return null;
  if (path.startsWith(`${root}/`)) {
    const rel = path.slice(root.length + 1);
    if (APP_ALLOWED.some((re) => re.test(rel))) return null;
    return `app module ${rel} is editor code, not on the viewer's list`;
  }
  const pkg = /\/packages\/(.+)$/.exec(path);
  if (pkg) {
    const rel = pkg[1]!;
    if (PACKAGE_ALLOWED.some((re) => re.test(rel))) return null;
    const name = rel.split('/')[0];
    return `module ${rel} of @manufakture/${name} is not on the viewer's list`;
  }
  return 'the module is from outside the app and its packages';
}

/** The chunks the entry reaches, statically or dynamically, entry first. */
export function reachableChunks(chunks: readonly BuiltChunk[], entry: BuiltChunk): BuiltChunk[] {
  const byName = new Map(chunks.map((c) => [c.fileName, c]));
  const seen = new Set<string>();
  const out: BuiltChunk[] = [];
  const queue = [entry.fileName];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const c = byName.get(name);
    if (!c) continue;
    out.push(c);
    queue.push(...c.imports, ...c.dynamicImports);
  }
  return out;
}

/**
 * Check the viewer's part of a build: null when the build has no viewer entry (the worker and
 * service worker builds), else the report.
 */
export function checkViewerBundle(
  chunks: readonly BuiltChunk[],
  appRoot: string,
  budget = VIEWER_JS_BUDGET_GZIP,
): ViewerBundleReport | null {
  const entry = chunks.find(isViewerEntry);
  if (!entry) return null;
  const reached = reachableChunks(chunks, entry);
  const forbidden: { id: string; reason: string }[] = [];
  for (const c of reached) {
    for (const id of c.modules) {
      const reason = forbiddenReason(id, appRoot);
      if (reason) forbidden.push({ id, reason });
    }
  }
  const rawBytes = reached.reduce((n, c) => n + c.rawBytes, 0);
  const gzipBytes = reached.reduce((n, c) => n + c.gzipBytes, 0);
  const problems = forbidden.map((f) => `viewer: ${f.reason} (${f.id})`);
  if (gzipBytes > budget) {
    problems.push(
      `viewer: its JavaScript is ${kib(gzipBytes)} gzip, over the ${kib(budget)} budget ` +
        '(src/viewer/bundleCheck.ts says how it is set)',
    );
  }
  return { files: reached.map((c) => c.fileName), rawBytes, gzipBytes, forbidden, problems };
}

export const kib = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KiB`;
