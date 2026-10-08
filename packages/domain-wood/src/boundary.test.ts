import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ADR 0013 decision 1: `packages/domain-wood` is pure TypeScript. At run time it may load only
// its own modules, `@manufakture/core`, `@manufakture/units` and the shared packages
// `@manufakture/takeoff`, `@manufakture/nesting` and `@manufakture/stock`. It never loads the
// kernel, regen or any `.wasm`, the sketch package, another domain or the app, so the translators
// and the cut list run in Node tests. Type-only imports may also name `@manufakture/regen` (the
// translator contract) and `@manufakture/kernel` (the `FeatureInput` types); they are erased.
// Tests may also load `vitest`, Node built-ins, and regen, the kernel and the sketch package, to
// run the features through regen with the real kernel. One directory more: `files/` (the
// `./files` subpath, M8 plan T8.1b, ADR 0013 amendment) writes the cut list's CSV and PDF and may
// load `@manufakture/io` at run time; nothing outside it may, and the package root never imports
// it. This is an allowlist, so a new dependency fails here until it is added on purpose.

const RUNTIME = [
  '@manufakture/core',
  '@manufakture/units',
  '@manufakture/takeoff',
  '@manufakture/nesting',
  '@manufakture/stock',
];
const TYPE_ONLY = [...RUNTIME, '@manufakture/regen', '@manufakture/kernel'];
const TEST_ONLY = ['vitest', '@manufakture/regen', '@manufakture/kernel', '@manufakture/sketch'];

const SRC = fileURLToPath(new URL('.', import.meta.url));
/** `files/` may load these at run time. */
const FILES_RUNTIME = [...RUNTIME, '@manufakture/io'];
const FILES_TYPE_ONLY = [...TYPE_ONLY, '@manufakture/io'];
const FILES = join(SRC, 'files') + sep;

describe('package boundary', () => {
  it('every module imports only what ADR 0013 allows', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.endsWith('boundary.test.ts'))).toBe(true);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const name = relative(SRC, file);
      const isTest =
        file.endsWith('.test.ts') ||
        name === 'test-helpers.ts' ||
        /(^|[\\/])test-[\w-]+\.ts$/.test(name);
      for (const { spec, typeOnly } of importsOf(text)) {
        expect(allowed(spec, typeOnly, isTest, file), `${name} imports '${spec}'`).toBe(true);
      }
    }
  });

  it('the scanner finds every runtime form', () => {
    // Built at run time so this file's own source holds no import of these names.
    const kernel = ['@manufakture', 'kernel'].join('/');
    const F = 'from';
    const q = "'";
    const bt = '`';
    const forms = [
      `import { tessellate } ${F} ${q}${kernel}${q};`,
      `import ${q}${kernel}${q};`,
      `export * ${F} ${q}${kernel}${q};`,
      `import { type MeshData, tessellate } ${F} ${q}${kernel}${q};`,
      `const k = await import(${q}${kernel}${q});`,
      `const k = await import(${bt}${kernel}${bt});`,
      `const k = require(${q}${kernel}${q});`,
      `import {\n  a,\n  b,\n} ${F} ${q}${kernel}${q};`,
    ];
    for (const text of forms) {
      expect(
        importsOf(text).map((i) => [i.spec, i.typeOnly]),
        text,
      ).toEqual([[kernel, false]]);
      expect(importsOf(text).every((i) => allowed(i.spec, i.typeOnly, false, SRC + 'x.ts'))).toBe(
        false,
      );
    }
    for (const text of [
      `import type { MeshData } ${F} ${q}${kernel}${q};`,
      `export type {\n  MeshData,\n} ${F} ${q}${kernel}${q};`,
    ]) {
      const found = importsOf(text);
      expect(
        found.map((i) => [i.spec, i.typeOnly]),
        text,
      ).toEqual([[kernel, true]]);
      expect(allowed(found[0]!.spec, true, false, SRC + 'x.ts')).toBe(true);
    }
    for (const text of [
      `// import ${q}${kernel}${q};`,
      `/* import ${q}${kernel}${q}; */`,
      `const keys = [${q}${F}${q}, ${q}sizing${q}];`,
      `const header = [${q}Counted ${F}${q},\n  ${q}Notes${q}];`,
    ]) {
      expect(importsOf(text), text).toEqual([]);
    }
  });

  it('the allowlist refuses the forbidden packages and paths out of the package', () => {
    const file = join(SRC, 'x.ts');
    for (const spec of [
      '@manufakture/kernel',
      '@manufakture/kernel/testing',
      '@manufakture/regen',
      '@manufakture/sketch',
      '@manufakture/domain-construction',
      '@manufakture/cam',
      '@manufakture/io',
      '@manufakture/web',
      'manifold-3d',
      '../../regen/src/engine',
      '../../../apps/web/src/main',
      'vitest',
      'node:fs',
    ]) {
      expect(allowed(spec, false, false, file), spec).toBe(false);
    }
    expect(allowed('@manufakture/domain-construction', true, false, file)).toBe(false);
    expect(allowed('@manufakture/io', true, false, file)).toBe(false);
    expect(allowed('@manufakture/regen', true, false, file)).toBe(true);
    expect(allowed('./board', false, false, file)).toBe(true);
    expect(allowed('../board', false, false, join(SRC, 'joints', 'x.ts'))).toBe(true);
    expect(allowed('@manufakture/units', false, false, file)).toBe(true);
    expect(allowed('@manufakture/core', false, false, file)).toBe(true);
    expect(allowed('node:fs', false, true, file)).toBe(true);
    expect(allowed('@manufakture/kernel/node', false, true, file)).toBe(true);
    expect(allowed('@manufakture/regen', false, true, file)).toBe(true);
    expect(allowed('@manufakture/sketch', false, true, file)).toBe(true);
    // `@manufakture/io` in `files/` only, and the rest of the package never loads `files/`.
    const writer = join(SRC, 'files', 'x.ts');
    expect(allowed('@manufakture/io', false, false, writer)).toBe(true);
    expect(allowed('@manufakture/io', true, false, writer)).toBe(true);
    expect(allowed('../cutlist/index', false, false, writer)).toBe(true);
    expect(allowed('@manufakture/regen', false, false, writer)).toBe(false);
    expect(allowed('./files', false, false, file)).toBe(false);
    expect(allowed('./files/cutlist', false, false, file)).toBe(false);
    expect(allowed('../files/cutlist-pdf', false, false, join(SRC, 'cutlist', 'x.ts'))).toBe(false);
  });
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

interface Found {
  readonly spec: string;
  readonly typeOnly: boolean;
}

/** Every module specifier in `text`, outside comments, and whether its statement is type-only. */
function importsOf(text: string): Found[] {
  let code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  const found: Found[] = [];
  const typeOnly = /^\s*(?:import|export)\s+type\s[^;]*?\bfrom\s*(['"])([^'"]+)\1/gm;
  code = code.replace(typeOnly, (_m, _q, spec: string) => {
    found.push({ spec, typeOnly: true });
    return '';
  });
  // `from` as a word, not inside a string (`'from'` is a params key), and a specifier with no
  // white space (so the end of a string such as `'Counted from',` is not one).
  const runtime =
    /(?<!['"`])\bfrom\s*(['"`])([^'"`\s]+)\1|\bimport\s*\(\s*(['"`])([^'"`]+)\3|\brequire\s*\(\s*(['"`])([^'"`]+)\5|^\s*import\s*(['"`])([^'"`]+)\7/gm;
  for (const m of code.matchAll(runtime)) {
    const spec = m[2] ?? m[4] ?? m[6] ?? m[8];
    if (spec !== undefined) found.push({ spec, typeOnly: false });
  }
  return found;
}

function allowed(spec: string, typeOnly: boolean, isTest: boolean, file: string): boolean {
  if (spec.startsWith('.')) {
    const target = resolve(file, '..', spec);
    // The package root never loads the fabrication files.
    if ((target + sep).startsWith(FILES) && !file.startsWith(FILES)) return false;
    return (
      target === SRC.replace(/[\\/]$/, '') || target.startsWith(SRC.endsWith(sep) ? SRC : SRC + sep)
    );
  }
  const pkg = packageOf(spec);
  if (isTest && (TEST_ONLY.includes(pkg) || spec.startsWith('node:'))) return true;
  if (file.startsWith(FILES)) return (typeOnly ? FILES_TYPE_ONLY : FILES_RUNTIME).includes(pkg);
  return (typeOnly ? TYPE_ONLY : RUNTIME).includes(pkg);
}

/** `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`. */
function packageOf(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}
