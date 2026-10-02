import {
  BUILTIN_TOOLS,
  findBuiltinTool,
  serializeToolLibrary,
  type LibraryTool,
} from '@manufakture/cam/library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryBackend } from '../../persistence/backend';
import { CrashingBackend, cloneBackend } from '../../persistence/test-fixtures';
import {
  MAX_LIBRARY_JSON,
  TOOL_LIBRARY_DIR,
  MAX_FILE_NUMBER,
  MAX_REJECTED,
  ToolLibraryStore,
  rejectedName,
  type LibraryResult,
} from './store';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const path = (name: string) => `${TOOL_LIBRARY_DIR}/${name}`;
const FILE_RE = /\/tools-\d{8}\.json$/;
const libFile = (n: number) => path(`tools-${String(n).padStart(8, '0')}.json`);

function mine(id: string, name = `My ${id}`): LibraryTool {
  return { ...findBuiltinTool('c3d-201')!, id, name, verified: false };
}

function store(backend = new MemoryBackend()) {
  return { backend, lib: new ToolLibraryStore(backend, { locks: null }) };
}

function files(backend: MemoryBackend): string[] {
  return [...backend.files.keys()].sort();
}

function value<T>(r: LibraryResult<T>): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

async function ids(lib: ToolLibraryStore): Promise<string[]> {
  return value(await lib.list()).map((t) => t.id);
}

/** A library file written straight to storage, as another build or another tab would. */
async function writeFile(backend: MemoryBackend, n: number, content: unknown) {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  await backend.write(libFile(n), encoder.encode(text));
}

const libraryOf = (tools: readonly LibraryTool[]) =>
  JSON.parse(serializeToolLibrary(tools)) as unknown;

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe('user tool library store', () => {
  it('starts empty, and adds, replaces and removes tools', async () => {
    const { backend, lib } = store();
    expect(value(await lib.list())).toEqual([]);
    expect((await lib.put(mine('a'))).ok).toBe(true);
    expect((await lib.put(mine('b'))).ok).toBe(true);
    expect((await lib.put(mine('a', 'Renamed'))).ok).toBe(true);
    expect(value(await lib.list()).map((t) => [t.id, t.name])).toEqual([
      ['a', 'Renamed'],
      ['b', 'My b'],
    ]);
    expect(value(await lib.remove('a'))).toBe(true);
    expect(value(await lib.remove('a'))).toBe(false);
    expect(await ids(lib)).toEqual(['b']);
    // One file at a time: each save writes the next number and deletes the one it read.
    expect(files(backend)).toEqual([libFile(4)]);
    // A new store over the same storage (a reload) reads the same tools.
    expect(await new ToolLibraryStore(backend, { locks: null }).list()).toEqual(await lib.list());
  });

  it('refuses an invalid tool and writes nothing', async () => {
    const { backend, lib } = store();
    const r = await lib.put({ ...mine('a'), diameter: -1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('tool.diameter');
    expect(files(backend)).toEqual([]);
  });

  it('exports JSON that imports back', async () => {
    const { lib } = store();
    await lib.put(mine('a'));
    await lib.put(mine('b'));
    const json = value(await lib.exportJson());
    const other = store().lib;
    expect(await other.importJson(json)).toEqual({ ok: true, value: { added: 2, replaced: 0 } });
    expect(await other.list()).toEqual(await lib.list());
  });

  it('imports a picked file, checking its size before reading it', async () => {
    const { lib } = store();
    const file = new Blob([serializeToolLibrary([mine('a')])], { type: 'application/json' });
    expect(await lib.importJson(file)).toEqual({ ok: true, value: { added: 1, replaced: 0 } });
    const huge = new Blob(['x']);
    Object.defineProperty(huge, 'size', { value: MAX_LIBRARY_JSON + 1 });
    const text = vi.spyOn(huge, 'text');
    const r = await lib.importJson(huge);
    expect(r.ok).toBe(false);
    expect(text).not.toHaveBeenCalled();
  });

  it('imports by merging or replacing', async () => {
    const { lib } = store();
    await lib.put(mine('a', 'Old'));
    await lib.put(mine('keep'));
    const json = serializeToolLibrary([mine('a', 'New'), mine('c')]);
    expect(await lib.importJson(json)).toEqual({ ok: true, value: { added: 1, replaced: 1 } });
    expect(value(await lib.list()).map((t) => [t.id, t.name])).toEqual([
      ['a', 'New'],
      ['keep', 'My keep'],
      ['c', 'My c'],
    ]);
    expect(await lib.importJson(serializeToolLibrary(BUILTIN_TOOLS), 'replace')).toEqual({
      ok: true,
      value: { added: BUILTIN_TOOLS.length, replaced: 0 },
    });
    expect(value(await lib.list())).toEqual(BUILTIN_TOOLS);
  });

  it('refuses an invalid or oversized import and leaves the library as it was', async () => {
    const { backend, lib } = store();
    await lib.put(mine('a'));
    const before = files(backend);
    const bad = JSON.parse(serializeToolLibrary([mine('b')])) as {
      tools: Record<string, unknown>[];
    };
    bad.tools[0]!.flutes = 0;
    for (const json of [
      JSON.stringify(bad),
      '{"format":"something-else","version":1,"tools":[]}',
      'not json',
      ' '.repeat(MAX_LIBRARY_JSON + 1),
    ]) {
      const r = await lib.importJson(json, 'replace');
      expect(r.ok).toBe(false);
    }
    expect(files(backend)).toEqual(before);
    expect(await ids(lib)).toEqual(['a']);
  });

  it('passes over a damaged or foreign newer file without deleting it', async () => {
    const { backend, lib } = store();
    await lib.put(mine('a'));
    await writeFile(backend, 7, '{"format":');
    const foreign = { format: 'manufakture-tool-library', version: 99, tools: [] };
    await writeFile(backend, 8, foreign);
    await backend.write(path('notes.txt'), encoder.encode('ignored'));
    expect(await ids(lib)).toEqual(['a']);
    expect(warn).toHaveBeenCalledTimes(2);
    // Reading changes nothing.
    expect(files(backend)).toEqual([path('notes.txt'), libFile(1), libFile(7), libFile(8)]);
    // A save keeps both, byte for byte, under names the loader ignores.
    await lib.put(mine('b'));
    expect(files(backend)).toEqual([
      path('notes.txt'),
      path(rejectedName(7)),
      path(rejectedName(8)),
      libFile(9),
    ]);
    expect(decoder.decode((await backend.read(path(rejectedName(7))))!)).toBe('{"format":');
    expect(JSON.parse(decoder.decode((await backend.read(path(rejectedName(8))))!))).toEqual(
      foreign,
    );
    expect(await ids(lib)).toEqual(['a', 'b']);
    // And the next save does not touch them either.
    await lib.put(mine('c'));
    expect(files(backend)).toContain(path(rejectedName(7)));
    expect(files(backend)).toContain(path(rejectedName(8)));
  });

  it('a newer version-2 file next to two good older ones survives a put', async () => {
    const backend = new MemoryBackend();
    await writeFile(backend, 1, libraryOf([mine('old')]));
    await writeFile(backend, 2, libraryOf([mine('old'), mine('newer')]));
    const v2 = { format: 'manufakture-tool-library', version: 2, tools: [{ future: true }] };
    await writeFile(backend, 3, v2);
    const { lib } = store(backend);
    expect((await lib.put(mine('added'))).ok).toBe(true);
    // The version-2 file is kept; the new file builds on file 2; file 1 is older than that.
    expect(files(backend)).toEqual([path(rejectedName(3)), libFile(4)]);
    expect(JSON.parse(decoder.decode((await backend.read(path(rejectedName(3))))!))).toEqual(v2);
    expect(await ids(lib)).toEqual(['old', 'newer', 'added']);
  });

  it('a lone file this build refuses is never saved over', async () => {
    const backend = new MemoryBackend();
    const tool = libraryOf([mine('big')]) as { tools: Record<string, unknown>[] };
    tool.tools[0]!.diameter = 5000;
    await writeFile(backend, 1, tool);
    const before = new Map(backend.files);
    const { lib } = store(backend);
    const listed = await lib.list();
    expect(listed.ok).toBe(false);
    if (!listed.ok) expect(listed.error).toMatch(/cannot be read.*Nothing is saved over it/);
    for (const r of [
      await lib.put(mine('a')),
      await lib.remove('big'),
      await lib.importJson(serializeToolLibrary([mine('a')]), 'replace'),
      await lib.exportJson(),
    ]) {
      expect(r.ok).toBe(false);
    }
    expect(backend.files).toEqual(before);
  });

  it('never reuses a number, and never overwrites rejected bytes (the double failure)', async () => {
    const backend = new MemoryBackend();
    await writeFile(backend, 1, libraryOf([mine('a')]));
    const v2 = JSON.stringify({ format: 'manufakture-tool-library', version: 2, tools: [] });
    await writeFile(backend, 2, v2);
    // Save A: copies tools-2 aside, removes it, then dies writing the new file.
    const a = new CrashingBackend(backend, 2);
    expect((await new ToolLibraryStore(a, { locks: null }).put(mine('b'))).ok).toBe(false);
    expect(a.ops).toEqual([
      `write ${path(rejectedName(2))}`,
      `remove ${libFile(2)}`,
      `write ${libFile(3)}`,
    ]);
    expect(files(backend)).toEqual([path(rejectedName(2)), libFile(1)]);
    // Save B: numbered past the rejected copy (3, not 2 again), and torn by a crash.
    const b = new CrashingBackend(backend, 0, true);
    expect((await new ToolLibraryStore(b, { locks: null }).put(mine('b'))).ok).toBe(false);
    expect(b.ops).toEqual([`write ${libFile(3)}`]);
    // Even a torn tools-2 (what reusing the number would have left) does not touch the copy.
    await writeFile(backend, 2, v2.slice(0, 10));
    // Save C keeps both bad files and the original bytes of rejected-2.
    const { lib } = store(backend);
    expect((await lib.put(mine('c'))).ok).toBe(true);
    const text = (name: string) => decoder.decode(backend.files.get(path(name))!);
    expect(text(rejectedName(2))).toBe(v2);
    expect(text(rejectedName(2, 1))).toBe(v2.slice(0, 10));
    expect(files(backend).filter((f) => f.includes('rejected'))).toHaveLength(3);
    expect(await ids(lib)).toEqual(['a', 'c']);
  });

  it('a rejected name already holding other bytes gets a free suffix', async () => {
    const backend = new MemoryBackend();
    await writeFile(backend, 1, libraryOf([mine('a')]));
    await writeFile(backend, 2, '{"bad": 2}');
    await backend.write(path(rejectedName(2)), encoder.encode('older rejected bytes'));
    const { lib } = store(backend);
    expect((await lib.put(mine('b'))).ok).toBe(true);
    expect(decoder.decode(backend.files.get(path(rejectedName(2)))!)).toBe('older rejected bytes');
    expect(decoder.decode(backend.files.get(path(rejectedName(2, 1)))!)).toBe('{"bad": 2}');
    expect(files(backend)).toEqual([path(rejectedName(2, 1)), path(rejectedName(2)), libFile(3)]);
    // The same file again, as when a crash came after the copy and before the removal: the
    // retry finds its bytes already kept and does not copy them a second time.
    await writeFile(backend, 2, '{"bad": 2}');
    expect((await lib.put(mine('c'))).ok).toBe(true);
    expect(files(backend).filter((f) => f.includes('rejected'))).toHaveLength(2);
    expect(files(backend)).toEqual([path(rejectedName(2, 1)), path(rejectedName(2)), libFile(4)]);
    expect(await ids(lib)).toEqual(['a', 'b', 'c']);
  });

  it('a crash at any step of a save that moves a rejected file aside loses nothing', async () => {
    const bad = '{"format":"manufakture-tool-library","version":2,"tools":[]}';
    const start = new MemoryBackend();
    await writeFile(start, 1, libraryOf([mine('a')]));
    await writeFile(start, 2, bad);
    const kept = (backend: MemoryBackend) =>
      [...backend.files.entries()].some(
        ([name, bytes]) =>
          /(tools-00000002|rejected-tools-00000002)/.test(name) && decoder.decode(bytes) === bad,
      );
    // The save's steps: copy aside, remove the original, write the new file, delete the old one.
    const probe = new CrashingBackend(cloneBackend(start));
    await new ToolLibraryStore(probe, { locks: null }).put(mine('b'));
    expect(probe.ops).toHaveLength(4);
    for (let crashAt = 0; crashAt < probe.ops.length; crashAt++) {
      for (const torn of [false, true]) {
        const inner = cloneBackend(start);
        await new ToolLibraryStore(new CrashingBackend(inner, crashAt, torn), { locks: null }).put(
          mine('b'),
        );
        expect(kept(inner), `crash at ${crashAt}${torn ? ', torn' : ''}`).toBe(true);
        expect([['a'], ['a', 'b']]).toContainEqual(
          await ids(new ToolLibraryStore(inner, { locks: null })),
        );
        const next = new ToolLibraryStore(inner, { locks: null });
        expect((await next.put(mine('c'))).ok).toBe(true);
        expect(await ids(next)).toContain('c');
        expect(kept(inner)).toBe(true);
        expect(files(inner).some((f) => FILE_RE.test(f) && f.endsWith('00000002.json'))).toBe(
          false,
        );
      }
    }
  });

  it('refuses a save that would need a number past eight digits, changing nothing', async () => {
    for (const hostile of [
      rejectedName(99_999_999, 99_999),
      rejectedName(99_999_999),
      'tools-99999999.json',
    ]) {
      const backend = new MemoryBackend();
      await writeFile(backend, 1, libraryOf([mine('a')]));
      await backend.write(path(hostile), encoder.encode('{"hostile": true}'));
      const before = new Map([...backend.files].map(([k, v]) => [k, v.slice()]));
      const { lib } = store(backend);
      const r = await lib.put(mine('b'));
      expect(r.ok, hostile).toBe(false);
      if (!r.ok)
        expect(r.error).toContain(`highest number a library file can have is ${MAX_FILE_NUMBER}`);
      expect(backend.files, hostile).toEqual(before);
      expect(await ids(lib)).toEqual(['a']);
    }
  });

  it('pruning never deletes a copy this save made, even below stale higher copies', async () => {
    const backend = new MemoryBackend();
    await writeFile(backend, 1, libraryOf([mine('a')]));
    for (let n = 50; n <= 55; n++)
      await backend.write(path(rejectedName(n)), encoder.encode(`r${n}`));
    await writeFile(backend, 2, '{"bad": 2}');
    const { lib } = store(backend);
    expect((await lib.put(mine('b'))).ok).toBe(true);
    expect(decoder.decode(backend.files.get(path(rejectedName(2)))!)).toBe('{"bad": 2}');
    // This save's copy plus the four newest older ones.
    expect(files(backend).filter((f) => f.includes('rejected'))).toEqual(
      [2, 52, 53, 54, 55].map((n) => path(rejectedName(n))),
    );
    expect(files(backend)).toContain(libFile(56));
  });

  it('a save that sets more than five files aside keeps them all', async () => {
    const backend = new MemoryBackend();
    await writeFile(backend, 1, libraryOf([mine('a')]));
    const bad = (n: number) => `{"bad": ${n}}`;
    for (let n = 2; n <= 7; n++) await writeFile(backend, n, bad(n));
    const { lib } = store(backend);
    expect((await lib.put(mine('b'))).ok).toBe(true);
    for (let n = 2; n <= 7; n++) {
      expect(decoder.decode(backend.files.get(path(rejectedName(n)))!)).toBe(bad(n));
    }
    expect(files(backend).filter((f) => f.includes('rejected'))).toHaveLength(6);
    expect(await ids(lib)).toEqual(['a', 'b']);
  });

  it('a new copy beside five older ones replaces the oldest of them', async () => {
    const backend = new MemoryBackend();
    await writeFile(backend, 1, libraryOf([mine('a')]));
    for (let n = 10; n <= 14; n++)
      await backend.write(path(rejectedName(n)), encoder.encode(`r${n}`));
    await writeFile(backend, 3, '{"bad": 3}');
    const { lib } = store(backend);
    expect((await lib.put(mine('b'))).ok).toBe(true);
    expect(decoder.decode(backend.files.get(path(rejectedName(3)))!)).toBe('{"bad": 3}');
    expect(files(backend).filter((f) => f.includes('rejected'))).toEqual(
      [11, 12, 13, 14, 3].map((n) => path(rejectedName(n))).sort(),
    );
    expect(files(backend)).toContain(libFile(15));
  });

  it('keeps the newest five rejected copies', async () => {
    const backend = new MemoryBackend();
    await writeFile(backend, 1, libraryOf([mine('a')]));
    for (let n = 2; n <= 8; n++)
      await backend.write(path(rejectedName(n)), encoder.encode(`r${n}`));
    const { lib } = store(backend);
    expect((await lib.put(mine('b'))).ok).toBe(true);
    expect(files(backend).filter((f) => f.includes('rejected'))).toEqual(
      [4, 5, 6, 7, 8].map((n) => path(rejectedName(n))),
    );
    expect(files(backend)).toContain(libFile(9));
    expect(MAX_REJECTED).toBe(5);
  });

  it('a crash at any step of a save leaves the old or the new library', async () => {
    const start = store();
    await start.lib.put(mine('a'));
    for (let crashAt = 0; crashAt < 3; crashAt++) {
      for (const torn of [false, true]) {
        const inner = cloneBackend(start.backend);
        const crashing = new CrashingBackend(inner, crashAt, torn);
        const lib = new ToolLibraryStore(crashing, { locks: null });
        const r = await lib.put(mine('b'));
        if (r.ok) expect(crashing.ops.length).toBeGreaterThan(0);
        const after = await ids(new ToolLibraryStore(inner, { locks: null }));
        expect([['a'], ['a', 'b']]).toContainEqual(after);
        // And the next save works.
        const next = new ToolLibraryStore(inner, { locks: null });
        expect((await next.put(mine('c'))).ok).toBe(true);
        expect(await ids(next)).toContain('c');
      }
    }
  });

  it('a write error (a full quota) is a value, and the library is unchanged', async () => {
    const { backend, lib } = store();
    await lib.put(mine('a'));
    const write = vi
      .spyOn(backend, 'write')
      .mockRejectedValue(new DOMException('quota', 'QuotaExceededError'));
    const r = await lib.put(mine('b'));
    expect(r).toEqual({ ok: false, error: 'The tool library could not be saved: quota' });
    write.mockRestore();
    expect(await ids(lib)).toEqual(['a']);
  });

  it('a read error is a value, not a rejection', async () => {
    const { backend, lib } = store();
    vi.spyOn(backend, 'list').mockRejectedValue(new Error('storage gone'));
    const r = await lib.list();
    expect(r).toEqual({ ok: false, error: 'The tool library could not be read: storage gone' });
  });

  it('lists again when every listed file vanished meanwhile', async () => {
    const { backend, lib } = store();
    await lib.put(mine('a'));
    // Another tab saves between this store's listing and its read: file 1 is gone, 2 is new.
    const list = backend.list.bind(backend);
    let calls = 0;
    vi.spyOn(backend, 'list').mockImplementation(async (dir) => {
      const names = await list(dir);
      if (calls++ === 0) {
        await writeFile(backend, 2, libraryOf([mine('a'), mine('other-tab')]));
        await backend.remove(libFile(1));
      }
      return names;
    });
    expect(await ids(lib)).toEqual(['a', 'other-tab']);
  });

  it('refuses to save a library larger than the limit', async () => {
    const { backend, lib } = store();
    await lib.put(mine('a'));
    // Compact JSON under the import limit that is over it once saved (indented): the save's own
    // size check refuses it and nothing is written.
    const base = mine('b');
    const big: LibraryTool = {
      ...base,
      note: 'x'.repeat(2000),
      source: 'y'.repeat(2000),
      presets: base.presets.map((p) => ({ ...p, note: 'z'.repeat(2000) })),
    };
    const one = (id: string) => ({ ...big, id });
    const compact = JSON.stringify(one('t0')).length + 1;
    const pretty = serializeToolLibrary([one('t0')]).length;
    const n = Math.floor((MAX_LIBRARY_JSON - 200) / compact);
    expect(n * pretty).toBeGreaterThan(MAX_LIBRARY_JSON);
    expect(n).toBeLessThanOrEqual(999);
    const tools = Array.from({ length: n }, (_, i) => one(`t${i}`));
    const json = JSON.stringify({ format: 'manufakture-tool-library', version: 1, tools });
    expect(json.length).toBeLessThanOrEqual(MAX_LIBRARY_JSON);
    const r = await lib.importJson(json, 'replace');
    expect(r).toEqual({ ok: false, error: 'The tool library would be too large to save' });
    expect(files(backend)).toEqual([libFile(1)]);
    expect(await ids(lib)).toEqual(['a']);
  });

  it('two puts at once in one tab without Web Locks both survive', async () => {
    const { lib } = store();
    const results = await Promise.all([lib.put(mine('a')), lib.put(mine('b')), lib.remove('x')]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await ids(lib)).sort()).toEqual(['a', 'b']);
  });

  it('holds the library lock for every change', async () => {
    const names: string[] = [];
    const locks = {
      request: <T>(name: string, callback: () => Promise<T>) => {
        names.push(name);
        return callback();
      },
    };
    const lib = new ToolLibraryStore(new MemoryBackend(), { locks });
    await lib.put(mine('a'));
    await lib.remove('a');
    await lib.importJson(serializeToolLibrary([]));
    expect(names).toEqual(Array(3).fill('manufakture-tool-library'));
  });
});
