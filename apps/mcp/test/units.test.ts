// The small pieces on their own: holding JSON under a limit, file names made safe, and writing.

import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { boundJson } from '../src/bounds';
import { outputNames, place, safeFileName, writeOutputs } from '../src/files';

describe('boundJson', () => {
  it('leaves a value that fits alone', () => {
    const v = { a: [1, 2, 3], b: 'x' };
    expect(boundJson(v, 1000)).toEqual({ value: v, bytes: 21, truncated: [] });
  });

  it('halves the largest lists until it fits, and says where', () => {
    const v = { small: [1, 2], big: Array.from({ length: 1000 }, (_, i) => i) };
    const r = boundJson(v, 600);
    expect(r.bytes).toBeLessThanOrEqual(600);
    const out = r.value as { small: number[]; big: number[] };
    expect(out.small).toEqual([1, 2]);
    expect(out.big).toEqual(Array.from({ length: out.big.length }, (_, i) => i));
    expect(r.truncated).toEqual([{ path: '/big', kept: out.big.length, total: 1000 }]);
  });

  it('cuts a long string, and escapes keys in the pointer', () => {
    const r = boundJson({ 'a/b~c': 'x'.repeat(10_000) }, 2000);
    expect(r.bytes).toBeLessThanOrEqual(2000);
    expect(r.truncated[0]!.path).toBe('/a~1b~0c');
    expect(r.truncated[0]!.total).toBe(10_000);
  });

  it('cuts every oversized string in one pass, as little as it must', () => {
    // 400 long strings (no list holds them): cut one at a time, this would take more steps than
    // are allowed.
    const v = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`note${i}`, `${i}:`.padEnd(2000, 'y')]),
    );
    const r = boundJson(v, 400_000);
    expect(r.bytes).toBeLessThanOrEqual(400_000);
    const out = r.value as Record<string, string>;
    expect(Object.keys(out)).toHaveLength(400);
    const lengths = new Set(Object.values(out).map((t) => t.length));
    expect(lengths.size).toBe(1);
    const kept = [...lengths][0]!;
    // As little as it must: a few characters more would not fit.
    expect(kept).toBeGreaterThan(900);
    expect(JSON.stringify(v).length - 400 * (2000 - (kept + 5))).toBeGreaterThan(400_000);
    expect(r.truncated).toHaveLength(400);
    expect(r.truncated[399]).toEqual({ path: '/note399', kept, total: 2000 });
    // A short string is never cut, and a pair of surrogates never split.
    const s = boundJson({ a: 'short', b: '\u{1F600}'.repeat(5000) }, 1000);
    const o = s.value as { a: string; b: string };
    expect(o.a).toBe('short');
    expect(o.b.length % 2).toBe(0);
    expect(s.bytes).toBeLessThanOrEqual(1000);
  });

  it('drops what cannot be cut small enough', () => {
    const many = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`key${i}`, i]));
    const r = boundJson(many, 100);
    expect(r.value).toBeNull();
    expect(r.truncated).toEqual([{ path: '', kept: 0, total: r.truncated[0]!.total }]);
  });
});

describe('file names', () => {
  it('reduces any name to one plain file name', () => {
    expect(safeFileName('Bracket.step')).toBe('Bracket.step');
    expect(safeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeFileName('..')).toBe('export');
    expect(safeFileName('.bashrc')).toBe('bashrc');
    expect(safeFileName('C:\\Windows\\x.stl')).toBe('C_Windows_x.stl');
    expect(safeFileName('a\u0000b\nc.svg')).toBe('a_b_c.svg');
    expect(safeFileName('CON.txt')).toBe('_CON.txt');
    expect(safeFileName('Schrank für Bücher.pdf')).toBe('Schrank f_r B_cher.pdf');
    expect(safeFileName('x'.repeat(500) + '.step')).toHaveLength(120);
    expect(safeFileName('x'.repeat(500) + '.step').endsWith('.step')).toBe(true);
    expect(safeFileName('Bracket. . ')).toBe('Bracket');
    expect(safeFileName('CON. ')).toBe('_CON');
    expect(safeFileName('abc .')).toBe('abc');
  });

  it("names files after the agent's base, numbered, keeping each extension, never twice", () => {
    const f = (name: string) => ({ name, bytes: new Uint8Array(), type: '' });
    expect(outputNames([f('Bracket.step')], 'out')).toEqual(['out.step']);
    expect(outputNames([f('a.stl'), f('b.stl')], 'parts')).toEqual(['parts-1.stl', 'parts-2.stl']);
    expect(outputNames([f('Side.stl'), f('Side.stl')], undefined)).toEqual([
      'Side.stl',
      'Side (2).stl',
    ]);
    // Case differs only: one name on a file system without case.
    expect(outputNames([f('Side.stl'), f('side.stl')], undefined)).toEqual([
      'Side.stl',
      'side (2).stl',
    ]);
  });

  it('keeps names unique when a long name is cut', () => {
    const f = (name: string) => ({ name, bytes: new Uint8Array(), type: '' });
    const long = 'p'.repeat(200);
    const names = outputNames([f(`${long}.stl`), f(`${long}.stl`), f(`${long}.stl`)], undefined);
    expect(new Set(names).size).toBe(3);
    for (const n of names) {
      expect(n).toBe(safeFileName(n));
      expect(n.length).toBeLessThanOrEqual(120);
      expect(n.endsWith('.stl')).toBe(true);
    }
    expect(names[1]!.endsWith(' (2).stl')).toBe(true);
    // An agent's long base: the -n suffixes are cut away, the names stay apart.
    const based = outputNames([f('a.stl'), f('b.stl'), f('c.stl')], 'q'.repeat(119));
    expect(new Set(based.map((n) => n.toLowerCase())).size).toBe(3);
  });
});

describe('writing', () => {
  const file = (text: string) => ({ name: 'x', bytes: new TextEncoder().encode(text), type: '' });

  it('never replaces what appears at the name after the check, link or file', async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'mfk-mcp-files-')));
    try {
      await writeFile(path.join(dir, '.temp'), 'new');
      await writeFile(path.join(dir, 'there.stl'), 'old');
      await expect(
        place(path.join(dir, '.temp'), path.join(dir, 'there.stl')),
      ).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readFile(path.join(dir, 'there.stl'), 'utf8')).toBe('old');
      // A dangling link is a name too, and is not followed.
      await symlink(path.join(dir, 'nowhere'), path.join(dir, 'link.stl'));
      await expect(
        place(path.join(dir, '.temp'), path.join(dir, 'link.stl')),
      ).rejects.toMatchObject({
        code: 'EEXIST',
      });
      expect((await readdir(dir)).sort()).toEqual(['.temp', 'link.stl', 'there.stl']);
      // A free name: the file gets it, and the temporary name is gone.
      await place(path.join(dir, '.temp'), path.join(dir, 'free.stl'));
      expect(await readFile(path.join(dir, 'free.stl'), 'utf8')).toBe('new');
      expect((await readdir(dir)).sort()).toEqual(['free.stl', 'link.stl', 'there.stl']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('removes the files it wrote when a later one fails', async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'mfk-mcp-files-')));
    try {
      // The second file's bytes cannot be written.
      const broken = { name: 'y', bytes: { length: 1 } as unknown as Uint8Array, type: '' };
      const r = await writeOutputs(dir, [file('one'), broken], ['a.stl', 'b.stl'], false);
      expect(r).toMatchObject({ ok: false, error: { kind: 'server', code: 'storage' } });
      expect(await readdir(dir)).toEqual([]);
      // Two files under one name (by case) are refused before anything is written.
      const twice = await writeOutputs(dir, [file('1'), file('2')], ['a.stl', 'A.stl'], false);
      expect(twice).toMatchObject({ ok: false, error: { code: 'path' } });
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
