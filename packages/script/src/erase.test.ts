import { describe, expect, it } from 'vitest';
import { positionAt, prepareSource } from './erase';

function erase(source: string) {
  const out = prepareSource(source, 'ts');
  if (!out.ok) throw new Error(out.error.message);
  return out.value;
}

describe('TypeScript erasure', () => {
  it('keeps every line', () => {
    const source = 'interface A {\n  x: number;\n}\ntype B = A;\nexport const b = 1;\n';
    const { code } = erase(source);
    expect(code.split('\n').length).toBe(source.split('\n').length);
    expect(code.split('\n')[4]).toBe('export const b = 1;');
  });

  it('maps columns that annotations moved back to the source', () => {
    const source =
      'const width: number = 10, height: Array<number> = [2]; foo(width as number, height!);';
    const { code, toSource } = erase(source);
    for (const token of ['height', 'foo', '[2]']) {
      const generated = code.indexOf(token);
      const mapped = toSource({ line: 1, column: generated + 1 });
      expect(source.slice(mapped.column - 1).startsWith(token), token).toBe(true);
    }
    // Inside a token the offset is kept.
    const inside = toSource({ line: 1, column: code.indexOf('foo') + 2 });
    expect(source[inside.column - 1]).toBe('o');
  });

  it('erases type-only imports and satisfies, keeps enums', () => {
    const { code } = erase(
      "import type { Ctx } from 'manufakture';\nimport { Shape } from 'manufakture';\nenum E { A }\nexport const p = { a: 1 } as const satisfies Record<string, number>;\nlet s: Shape;\n",
    );
    expect(code).not.toMatch(/import/);
    expect(code).toMatch(/E\["A"\]/);
  });

  it.each([
    ['namespace N { export const a = 1; }', 'namespace'],
    ['export namespace A.B { }', 'namespace'],
    ['module M { }', 'module'],
    ["import fs = require('fs');", 'require'],
    ['import type T = A.B;', 'require'],
  ])('refuses %s before sucrase drops it', (source, word) => {
    const out = prepareSource(source, 'ts');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('unsupported-syntax');
      expect(out.error.message).toContain(word);
      expect(out.error.line).toBe(1);
    }
  });

  it('allows ambient declarations and the words namespace and module as names', () => {
    expect(
      prepareSource("declare namespace N { const a: number }\ndeclare module 'x' { }\n", 'ts').ok,
    ).toBe(true);
    expect(
      prepareSource('const namespace = 1, module = 2; const s = "namespace X {";', 'ts').ok,
    ).toBe(true);
    expect(prepareSource('const r = /namespace N {/;', 'js').ok).toBe(true);
  });

  it('refuses value imports in JavaScript and TypeScript, at their position', () => {
    const out = prepareSource("const a = 1;\n  import x from 'y';", 'js');
    expect(out.ok ? null : out.error).toMatchObject({
      code: 'unsupported-syntax',
      line: 2,
      column: 3,
    });
    const ts = prepareSource("import { used } from 'y';\nexport const v = used;", 'ts');
    expect(ts.ok ? null : ts.error).toMatchObject({ code: 'unsupported-syntax', line: 1 });
  });

  it('reports parse errors at the source position', () => {
    const out = prepareSource('const a = 1;\nlet b: = 2;', 'ts');
    expect(out.ok ? null : out.error).toMatchObject({ code: 'syntax', line: 2, column: 8 });
  });

  it('passes JavaScript through untouched', () => {
    const source = 'export function run() { return 1; }';
    const out = prepareSource(source, 'js');
    expect(out.ok && out.value.code).toBe(source);
  });

  it('computes positions from offsets', () => {
    expect(positionAt('ab\ncd', 4)).toEqual({ line: 2, column: 2 });
  });
});
