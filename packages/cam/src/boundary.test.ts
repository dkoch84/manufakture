import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ADR 0014 decision 1: `packages/cam` never depends on the kernel at run time, on regen, on the
// sketch package, on any domain package, on the app or on the DOM. At run time it may load only
// its own modules, `@manufakture/units`, `comlink` (the worker, T5.1g) and `clipper2-ts` (the
// offset adapter, T5.2a). Type-only imports may also name `@manufakture/core` (the `cam` section's
// types) and `@manufakture/kernel` (`MeshData`); they are erased. Tests may also load `vitest`,
// `gcode-toolpath` (the post's round trip, T5.4a; a development dependency, MIT) and Node
// built-ins. This is an allowlist, so a new dependency fails here until it is added on purpose.

const RUNTIME = ['@manufakture/units', 'comlink', 'clipper2-ts'];
const TYPE_ONLY = [...RUNTIME, '@manufakture/core', '@manufakture/kernel'];
const TEST_ONLY = ['vitest', 'gcode-toolpath'];

const SRC = fileURLToPath(new URL('.', import.meta.url));

describe('package boundary', () => {
  it('every module imports only what ADR 0014 allows', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const name = relative(SRC, file);
      const isTest = file.endsWith('.test.ts') || name === 'test-helpers.ts';
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
    for (const text of [`// import ${q}${kernel}${q};`, `/* import ${q}${kernel}${q}; */`]) {
      expect(importsOf(text), text).toEqual([]);
    }
  });

  it('the allowlist refuses the forbidden packages and paths out of the package', () => {
    const file = join(SRC, 'x.ts');
    for (const spec of [
      '@manufakture/kernel',
      '@manufakture/regen',
      '@manufakture/sketch',
      '@manufakture/sketch/model',
      '@manufakture/domain-wood',
      '@manufakture/web',
      '@manufakture/core',
      '../../regen/src/engine',
      '../../../apps/web/src/main',
      'vitest',
      'node:fs',
    ]) {
      expect(allowed(spec, false, false, file), spec).toBe(false);
    }
    expect(allowed('@manufakture/sketch', true, false, file)).toBe(false);
    expect(allowed('./arc', false, false, file)).toBe(true);
    expect(allowed('../arc', false, false, join(SRC, 'offset', 'x.ts'))).toBe(true);
    expect(allowed('@manufakture/units', false, false, file)).toBe(true);
    expect(allowed('node:fs', false, true, file)).toBe(true);
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
  const runtime =
    /\bfrom\s*(['"`])([^'"`]+)\1|\bimport\s*\(\s*(['"`])([^'"`]+)\3|\brequire\s*\(\s*(['"`])([^'"`]+)\5|^\s*import\s*(['"`])([^'"`]+)\7/gm;
  for (const m of code.matchAll(runtime)) {
    const spec = m[2] ?? m[4] ?? m[6] ?? m[8];
    if (spec !== undefined) found.push({ spec, typeOnly: false });
  }
  return found;
}

function allowed(spec: string, typeOnly: boolean, isTest: boolean, file: string): boolean {
  if (spec.startsWith('.')) {
    const target = resolve(file, '..', spec);
    return (
      target === SRC.replace(/[\\/]$/, '') || target.startsWith(SRC.endsWith(sep) ? SRC : SRC + sep)
    );
  }
  const pkg = packageOf(spec);
  if (isTest && (TEST_ONLY.includes(pkg) || spec.startsWith('node:'))) return true;
  return (typeOnly ? TYPE_ONLY : RUNTIME).includes(pkg);
}

/** `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`. */
function packageOf(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}
