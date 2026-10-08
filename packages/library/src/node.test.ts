import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile, mkdir } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DocumentLibrary } from './library';
import { MemoryBranchLocks, type BranchLocks } from './locks';
import {
  NodeBackend,
  NodeBranchLocks,
  confinedSegments,
  linuxProcessStart,
  type LockRecord,
  type NodeLockOptions,
} from './node';
import { partDocument } from './test-fixtures';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'manufakture-node-'));
  dirs.push(dir);
  return dir;
}

/** Every file under `dir`, relative, sorted. */
async function allFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .sort();
}

describe('NodeBackend: confinement', () => {
  const attempts = [
    '..',
    '../x',
    '../../etc/passwd',
    'documents/../../x',
    'documents/..',
    '/etc/passwd',
    '/abs',
    './x',
    'a/./b',
    'a//b',
    'a/',
    '',
    'a\\..\\..\\x',
    '..\\x',
    'C:\\x',
    'C:',
    'a:b',
    'a\0b',
    'documents/\0',
  ];

  it('refuses every path that is not plain segments under the root', async () => {
    const outer = await tempDir();
    const root = path.join(outer, 'root');
    const b = new NodeBackend(root);
    for (const p of attempts) {
      expect(() => confinedSegments(p), JSON.stringify(p)).toThrow('Invalid storage path');
      expect(() => b.resolve(p)).toThrow('Invalid storage path');
      await expect(b.write(p, new Uint8Array([1]))).rejects.toThrow('Invalid storage path');
      await expect(b.read(p)).rejects.toThrow('Invalid storage path');
      await expect(b.remove(p)).rejects.toThrow('Invalid storage path');
      await expect(b.removeTree(p)).rejects.toThrow('Invalid storage path');
      await expect(b.list(p)).rejects.toThrow('Invalid storage path');
    }
    // Nothing was written anywhere, inside or beside the root.
    expect(await allFiles(outer)).toEqual([]);
    expect(confinedSegments('documents/doc-1/head.json')).toEqual([
      'documents',
      'doc-1',
      'head.json',
    ]);
    expect(b.resolve('documents/x')).toBe(path.join(root, 'documents', 'x'));
  });

  it('keeps a relative root inside itself', async () => {
    const dir = await tempDir();
    const b = new NodeBackend(path.relative(process.cwd(), dir));
    expect(b.root).toBe(dir);
    await b.write('documents/a', new Uint8Array([1]));
    expect(await allFiles(dir)).toEqual([path.join('documents', 'a')]);
  });
});

describe('NodeBackend: directories', () => {
  it('removes emptied directories and never lists empty ones', async () => {
    const root = await tempDir();
    const b = new NodeBackend(root);
    await b.write('documents/a/branches/x/head.json', new Uint8Array([1]));
    await b.write('documents/b/head.json', new Uint8Array([2]));
    await b.remove('documents/a/branches/x/head.json');
    expect(await b.list('documents')).toEqual(['b']);
    expect(await readdir(path.join(root, 'documents'))).toEqual(['b']);
    // One left behind (a crash between steps) is not listed either.
    await mkdir(path.join(root, 'documents', 'c', 'blobs'), { recursive: true });
    expect(await b.list('documents')).toEqual(['b']);
    await b.removeTree('documents/b');
    expect(await b.list('documents')).toEqual([]);
    // The root itself stays.
    expect(await readdir(root)).toEqual(['documents']);
  });

  it('treats a directory as no file, and a file as no tree', async () => {
    const b = new NodeBackend(await tempDir());
    await b.write('documents/a/head.json', new Uint8Array([1]));
    expect(await b.read('documents/a')).toBeNull();
    expect(await b.read('documents/a/head.json/x')).toBeNull();
    await b.remove('documents/a');
    await b.removeTree('documents/a/head.json');
    expect(await b.read('documents/a/head.json')).toEqual(new Uint8Array([1]));
    expect(b.kind).toBe('node');
  });

  it('holds a library that a second process (here, a second library) reads', async () => {
    const root = await tempDir();
    const lib = new DocumentLibrary(new NodeBackend(root), { locks: null });
    await lib.save(partDocument());
    const other = new DocumentLibrary(new NodeBackend(root), { locks: null });
    const opened = await other.open('doc-1');
    expect(opened.ok && opened.value.document.name).toBe('Bracket');
    expect(other.kind).toBe('node');
  });
});

/** The suite every `BranchLocks` passes. */
function lockSuite(name: string, make: () => Promise<BranchLocks>) {
  describe(`${name}: one holder per branch`, () => {
    it('refuses a second holder until the first releases', async () => {
      const locks = await make();
      const a = await locks.acquire('doc-1', 'b-1', 'session-a');
      expect(a).not.toBeNull();
      expect(await a!.held()).toBe(true);
      expect(await locks.acquire('doc-1', 'b-1', 'session-b')).toBeNull();
      // Other branches and documents are separate.
      const main = await locks.acquire('doc-1', 'main');
      const other = await locks.acquire('doc-2', 'b-1');
      expect(main && other).toBeTruthy();
      await a!.release();
      expect(await a!.held()).toBe(false);
      await a!.release();
      const b = await locks.acquire('doc-1', 'b-1', 'session-b');
      expect(b).not.toBeNull();
      expect(await locks.acquire('doc-1', 'b-1')).toBeNull();
      for (const l of [b, main, other]) await l!.release();
    });

    it('gives a lock asked for many times at once to exactly one', async () => {
      const locks = await make();
      const got = await Promise.all(
        Array.from({ length: 16 }, (_, i) => locks.acquire('doc-1', 'b-1', `s${i}`)),
      );
      expect(got.filter((l) => l !== null)).toHaveLength(1);
    });

    it('refuses ids that are not storable', async () => {
      const locks = await make();
      for (const [doc, branch] of [
        ['../x', 'b'],
        ['doc', '../x'],
        ['doc', 'a/b'],
        ['', 'b'],
        ['doc', ''],
        ['doc', '.'],
      ]) {
        await expect(locks.acquire(doc!, branch!)).rejects.toThrow(/Cannot lock/);
      }
    });
  });
}

lockSuite('MemoryBranchLocks', async () => new MemoryBranchLocks());
lockSuite('NodeBranchLocks', async () => new NodeBranchLocks(await tempDir(), { heartbeatMs: 0 }));
lockSuite('NodeBranchLocks, two instances on one directory', async () => {
  // Two instances, as two processes would have, sharing the lock files.
  const root = await tempDir();
  const instances = [new NodeBranchLocks(root), new NodeBranchLocks(root)];
  let n = 0;
  return { acquire: (d, b, h) => instances[n++ % 2]!.acquire(d, b, h) };
});

describe('NodeBranchLocks: lock files', () => {
  const record = (over: Partial<LockRecord>): LockRecord => ({
    format: 'manufakture-lock',
    token: 'someone-else',
    host: hostname(),
    pid: process.pid,
    processStart: 0,
    holder: 'old session',
    takenAt: new Date().toISOString(),
    ...over,
  });

  async function planted(over: Partial<LockRecord> | string, options: NodeLockOptions = {}) {
    const root = await tempDir();
    const locks = new NodeBranchLocks(root, { heartbeatMs: 0, ...options });
    const file = locks.file('doc-1', 'b-1');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof over === 'string' ? over : JSON.stringify(record(over)));
    return { root, locks, file };
  }

  const age = async (file: string, ms: number) => {
    const t = new Date(Date.now() - ms);
    await utimes(file, t, t);
  };

  it('records who holds it, under locks/<document>/<branch>.lock', async () => {
    const root = await tempDir();
    const locks = new NodeBranchLocks(root, { heartbeatMs: 0 });
    const lock = await locks.acquire('doc-1', 'b-1', 'session-7');
    expect(locks.file('doc-1', 'b-1')).toBe(path.join(root, 'locks', 'doc-1', 'b-1.lock'));
    expect(await locks.holder('doc-1', 'b-1')).toMatchObject({
      holder: 'session-7',
      pid: process.pid,
      host: hostname(),
    });
    await lock!.release();
    expect(await locks.holder('doc-1', 'b-1')).toBeNull();
    expect(await allFiles(root)).toEqual([]);
  });

  it('breaks the lock of a process on this machine that is gone', async () => {
    const { locks } = await planted({ pid: 99_999_999 }, { isAlive: () => false });
    const lock = await locks.acquire('doc-1', 'b-1', 'new');
    expect(lock).not.toBeNull();
    expect((await locks.holder('doc-1', 'b-1'))?.holder).toBe('new');
  });

  it('keeps the lock of a live process, and breaks it once that process ends', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    });
    try {
      const { locks, file } = await planted({
        pid: child.pid!,
        processStart: linuxProcessStart(child.pid!) ?? 0,
      });
      expect(await locks.acquire('doc-1', 'b-1')).toBeNull();
      // However old its file: a live holder on this machine is never broken by age.
      await age(file, 3_600_000);
      expect(await locks.acquire('doc-1', 'b-1')).toBeNull();
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
      expect(await locks.acquire('doc-1', 'b-1')).not.toBeNull();
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('never breaks a live process’s lock on this machine by age', async () => {
    const { locks, file } = await planted(
      { pid: 4242, processStart: 1_000_000 },
      { staleAfterMs: 60_000, isAlive: () => true, processStart: () => 1_000_500 },
    );
    await age(file, 3_600_000);
    expect(await locks.acquire('doc-1', 'b-1')).toBeNull();
    // Unknown start time (no /proc): taken for the holder, still not broken.
    const unknown = new NodeBranchLocks(path.dirname(path.dirname(path.dirname(file))), {
      heartbeatMs: 0,
      isAlive: () => true,
      processStart: () => null,
    });
    expect(await unknown.acquire('doc-1', 'b-1')).toBeNull();
  });

  it('breaks a lock whose pid now runs a process that started at another time', async () => {
    const { locks } = await planted(
      { pid: 4242, processStart: 1_000_000 },
      { isAlive: () => true, processStart: () => 1_000_000 + 60_000 },
    );
    expect(await locks.acquire('doc-1', 'b-1')).not.toBeNull();
  });

  it.runIf(process.platform === 'linux')(
    'reads a live process’s start time from /proc, as the process itself records it',
    async () => {
      const root = await tempDir();
      const lock = await new NodeBranchLocks(root, { heartbeatMs: 0 }).acquire('doc-1', 'b-1');
      const record = await new NodeBranchLocks(root).holder('doc-1', 'b-1');
      expect(record?.processStart).toBe(linuxProcessStart(process.pid));
      expect(Math.abs(record!.processStart - (Date.now() - process.uptime() * 1000))).toBeLessThan(
        2000,
      );
      expect(linuxProcessStart(99_999_999)).toBeNull();
      expect(linuxProcessStart(0)).toBeNull();
      await lock!.release();
    },
  );

  it('breaks a lock left by an earlier process that had this pid', async () => {
    const { locks } = await planted({ pid: process.pid, processStart: 1 });
    expect(await locks.acquire('doc-1', 'b-1')).not.toBeNull();
  });

  it('keeps another machine’s lock until nobody refreshed it for staleAfterMs', async () => {
    const { locks, file } = await planted({ host: 'elsewhere', pid: 1 }, { staleAfterMs: 60_000 });
    expect(await locks.acquire('doc-1', 'b-1')).toBeNull();
    await age(file, 61_000);
    expect(await locks.acquire('doc-1', 'b-1')).not.toBeNull();
  });

  it('keeps a lock file that does not read until it is stale', async () => {
    const { locks, file } = await planted('', { staleAfterMs: 60_000 });
    expect(await locks.acquire('doc-1', 'b-1')).toBeNull();
    await age(file, 61_000);
    expect(await locks.acquire('doc-1', 'b-1')).not.toBeNull();
  });

  it('a holder whose lock was broken no longer holds it, and its release spares the new one', async () => {
    const root = await tempDir();
    const locks = new NodeBranchLocks(root, { heartbeatMs: 0, staleAfterMs: 60_000 });
    const first = await locks.acquire('doc-1', 'b-1', 'first');
    // As if taken on another machine sharing the directory, where it hung: nothing refreshed it.
    const file = locks.file('doc-1', 'b-1');
    await writeFile(file, (await readFile(file, 'utf8')).replace(hostname(), 'elsewhere'));
    await age(file, 61_000);
    const second = await locks.acquire('doc-1', 'b-1', 'second');
    expect(second).not.toBeNull();
    expect(await first!.held()).toBe(false);
    await first!.release();
    expect(await second!.held()).toBe(true);
    expect((await locks.holder('doc-1', 'b-1'))?.holder).toBe('second');
  });

  it('refreshes a held lock, so it never goes stale while its holder lives', async () => {
    const root = await tempDir();
    const options = { heartbeatMs: 10, staleAfterMs: 60_000 };
    const lock = await new NodeBranchLocks(root, options).acquire('doc-1', 'b-1', 'live');
    const other = new NodeBranchLocks(root, options);
    // Judged as another machine's lock, by its age alone, and made to look long unrefreshed.
    const file = other.file('doc-1', 'b-1');
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace(hostname(), 'elsewhere'));
    await age(file, 3_600_000);
    // Wait (however long the machine takes) until the heartbeat refreshed it.
    const deadline = Date.now() + 10_000;
    while (Date.now() - (await stat(file)).mtimeMs > 30_000 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await other.acquire('doc-1', 'b-1')).toBeNull();
    expect(await lock!.held()).toBe(true);
    await lock!.release();
  });

  it('waits out a break in progress, and clears one left by a crash', async () => {
    const { locks, file } = await planted({ pid: 99_999_999 }, { isAlive: () => false });
    await writeFile(`${file}.break`, '1\n');
    expect(await locks.acquire('doc-1', 'b-1')).toBeNull();
    await age(`${file}.break`, 11_000);
    // The first try clears the stale break; the next one breaks the lock.
    expect(await locks.acquire('doc-1', 'b-1')).toBeNull();
    expect(await locks.acquire('doc-1', 'b-1')).not.toBeNull();
  });

  it('of two breakers of one stale lock, the late one leaves the lock the other took', async () => {
    const root = await tempDir();
    const file = new NodeBranchLocks(root).file('doc-1', 'b-1');
    let late: Promise<unknown> | null = null;
    let fast: Awaited<ReturnType<NodeBranchLocks['acquire']>> = null;
    const slow = new NodeBranchLocks(root, {
      heartbeatMs: 0,
      isAlive: () => false,
      // Between its read and its unlink, it stalls: its break looks dead, and another process
      // clears that break, breaks the lock and takes it.
      beforeBreak: async () => {
        late ??= (async () => {
          await age(`${file}.break`, 11_000);
          const other = new NodeBranchLocks(root, { heartbeatMs: 0, isAlive: () => false });
          expect(await other.acquire('doc-1', 'b-1', 'fast')).toBeNull();
          fast = await other.acquire('doc-1', 'b-1', 'fast');
        })();
        await late;
      },
    });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(record({ pid: 99_999_999, processStart: 0 })));
    expect(await slow.acquire('doc-1', 'b-1', 'slow')).toBeNull();
    expect(fast).not.toBeNull();
    expect(await fast!.held()).toBe(true);
    expect((await slow.holder('doc-1', 'b-1'))?.holder).toBe('fast');
    // The slow one's break file was taken away; it removed nobody else's.
    expect(await allFiles(root)).toEqual([path.join('locks', 'doc-1', 'b-1.lock')]);
  });

  it('leaves a lock file that was written again after it was judged stale', async () => {
    const { locks, file } = await planted({ pid: 99_999_999 }, { isAlive: () => false });
    let rewritten = false;
    const racing = new NodeBranchLocks(path.dirname(path.dirname(path.dirname(file))), {
      heartbeatMs: 0,
      isAlive: () => false,
      beforeBreak: async () => {
        if (rewritten) return;
        rewritten = true;
        await writeFile(file, JSON.stringify(record({ pid: 99_999_999, holder: 'refreshed' })));
      },
    });
    expect(await racing.acquire('doc-1', 'b-1')).toBeNull();
    expect((await locks.holder('doc-1', 'b-1'))?.holder).toBe('refreshed');
    expect(await racing.acquire('doc-1', 'b-1')).not.toBeNull();
  });

  it.runIf(process.platform === 'linux')('never waits on a FIFO planted as a lock', async () => {
    const root = await tempDir();
    const locks = new NodeBranchLocks(root, { heartbeatMs: 0 });
    const file = locks.file('doc-1', 'b-1');
    await mkdir(path.dirname(file), { recursive: true });
    expect(spawnSync('mkfifo', [file]).status).toBe(0);
    expect(await locks.holder('doc-1', 'b-1')).toBeNull();
    expect(await locks.acquire('doc-1', 'b-1')).toBeNull();
  });

  it('reads at most a few KB of a lock file', async () => {
    const { locks, file } = await planted('x'.repeat(1_000_000), { staleAfterMs: 60_000 });
    expect(await locks.holder('doc-1', 'b-1')).toBeNull();
    expect(await locks.acquire('doc-1', 'b-1')).toBeNull();
    await age(file, 61_000);
    expect(await locks.acquire('doc-1', 'b-1')).not.toBeNull();
  });
});
