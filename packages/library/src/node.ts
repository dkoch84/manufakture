// The library on a Node file system: a `StorageBackend` on a directory, and branch locks as lock
// files beside it. For headless sessions, tests and CI. Imported as `@manufakture/library/node`,
// so nothing in the browser build reaches `node:fs`.
//
// Layout under the root directory:
//
//   documents/...                         the library's files, exactly as in the browser
//   locks/<document id>/<branch>.lock     a held branch lock (NodeBranchLocks)
//
// Every storage path is confined to the root: it is split into segments by `segments` (no empty
// segment, no `.` or `..`, so no absolute path either) and each segment is also refused when it
// holds a backslash, a NUL or a colon, so no segment is a path of its own on any platform. The
// joined path is checked to be under the root once more before any file is touched.

import { randomUUID } from 'node:crypto';
import { constants, readFileSync, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  rmdir,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { segments, type StorageBackend } from './backend';
import { checkLockIds, type BranchLock, type BranchLocks } from './locks';

/** `segments`, also refusing a backslash, NUL or colon in any segment. */
export function confinedSegments(storagePath: string): string[] {
  const parts = segments(storagePath);
  for (const p of parts) {
    if (/[\\\0:]/.test(p)) throw new Error(`Invalid storage path: ${storagePath}`);
  }
  return parts;
}

const errorCode = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : undefined;

/** The file system errors that mean "there is no file there". */
const NOT_THERE = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

/**
 * Files in a directory on disk. Behaves as `MemoryBackend` does: a directory exists only while a
 * file is under it (emptied directories are removed, and `list` leaves out any that are left
 * empty), and writes are plain, not atomic, as the library expects of every backend. Symbolic
 * links are not listed; the library never makes any. No private members, so a test can wrap one
 * with `Object.create` as it does a `MemoryBackend`.
 */
export class NodeBackend implements StorageBackend {
  readonly kind = 'node';
  /** The absolute root directory. */
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** The absolute path of storage path `p`, under the root. */
  resolve(p: string): string {
    const full = path.join(this.root, ...confinedSegments(p));
    if (!full.startsWith(this.root + path.sep)) throw new Error(`Invalid storage path: ${p}`);
    return full;
  }

  async read(p: string): Promise<Uint8Array | null> {
    const full = this.resolve(p);
    try {
      return new Uint8Array(await readFile(full));
    } catch (e) {
      if (NOT_THERE.has(errorCode(e) ?? '')) return null;
      throw e;
    }
  }

  async write(p: string, bytes: Uint8Array): Promise<void> {
    const full = this.resolve(p);
    // Another process may remove an emptied parent directory between the two steps: try again.
    for (let attempt = 0; ; attempt++) {
      await mkdir(path.dirname(full), { recursive: true });
      try {
        await writeFile(full, bytes);
        return;
      } catch (e) {
        if (errorCode(e) !== 'ENOENT' || attempt >= 4) throw e;
      }
    }
  }

  async remove(p: string): Promise<void> {
    const full = this.resolve(p);
    try {
      await unlink(full);
    } catch (e) {
      const code = errorCode(e) ?? '';
      // A directory at `p` is no file: nothing to remove, as in memory (EPERM on macOS).
      if (NOT_THERE.has(code)) return;
      if (code === 'EPERM' && (await isDirectory(full))) return;
      throw e;
    }
    await pruneUp(this.root, path.dirname(full));
  }

  async removeTree(dir: string): Promise<void> {
    const full = this.resolve(dir);
    // Only a directory: a file named `dir` is not a tree under it.
    if (!(await isDirectory(full))) return;
    await rm(full, { recursive: true, force: true });
    await pruneUp(this.root, path.dirname(full));
  }

  async list(dir: string): Promise<string[]> {
    const full = this.resolve(dir);
    let entries;
    try {
      entries = await readdir(full, { withFileTypes: true });
    } catch (e) {
      if (NOT_THERE.has(errorCode(e) ?? '')) return [];
      throw e;
    }
    const names: string[] = [];
    for (const entry of entries) {
      if (entry.isFile()) names.push(entry.name);
      else if (entry.isDirectory() && (await holdsFile(path.join(full, entry.name)))) {
        names.push(entry.name);
      }
    }
    return names.sort();
  }
}

/** Remove `dir` and its parents up to (not including) `root` while they are empty. */
async function pruneUp(root: string, dir: string): Promise<void> {
  for (let d = dir; d.startsWith(root + path.sep); d = path.dirname(d)) {
    try {
      await rmdir(d);
    } catch {
      return; // Not empty (or gone already): its parents are not empty either.
    }
  }
}

async function isDirectory(full: string): Promise<boolean> {
  try {
    return (await stat(full)).isDirectory();
  } catch {
    return false;
  }
}

/** Whether there is a file anywhere under directory `dir`. */
async function holdsFile(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && (await holdsFile(path.join(dir, entry.name)))) return true;
  }
  return false;
}

/** What a lock file holds. */
export interface LockRecord {
  format: 'manufakture-lock';
  /** Unique per acquisition: a holder only ever releases or refreshes its own. */
  token: string;
  host: string;
  pid: number;
  /**
   * When the holding process started (ms since the epoch), to tell a reused pid apart. On Linux
   * from /proc (`linuxProcessStart`), so another process can work out the same value.
   */
  processStart: number;
  holder: string;
  /** ISO 8601. */
  takenAt: string;
}

export interface NodeLockOptions {
  /**
   * A lock file not refreshed for this long is stale, when its holder cannot be asked: one taken
   * on another machine (a shared directory), or a file that does not read as a lock record. A
   * holder refreshes its file every `heartbeatMs`. A record of this machine whose process still
   * runs is never stale by age. Default 2 minutes.
   */
  staleAfterMs?: number;
  /** How often a holder refreshes its lock file. Default 30 seconds; 0: never (tests). */
  heartbeatMs?: number;
  /** Whether process `pid` on this machine is alive. Default: `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
  /**
   * When process `pid` on this machine started (ms since the epoch), or null where that cannot
   * be known. Default: `linuxProcessStart` (null on other systems, where a reused pid is then
   * taken for the holder).
   */
  processStart?: (pid: number) => number | null;
  /** Tests only: runs after a stale lock was read and judged, just before it is removed. */
  beforeBreak?: (file: string) => Promise<void> | void;
}

/** How long a half-made break of a stale lock (`.break` file) blocks others before it is stale. */
const BREAK_STALE_MS = 10_000;

/** A lock file longer than this is not read past it, and does not read as a record. */
const MAX_LOCK_BYTES = 4096;

/**
 * How far a live process's start time may be from the one a record holds and still be the same
 * process: the boot time /proc reports moves by a second when the clock is adjusted, and records
 * from before `linuxProcessStart` measured the start another way.
 */
const PROCESS_START_SLACK_MS = 2000;

/** Clock ticks per second in /proc/<pid>/stat: USER_HZ, 100 on every Linux architecture in use. */
const USER_HZ = 100;

/**
 * When process `pid` started, in ms since the epoch: the boot time (`btime` in /proc/stat) plus
 * field 22 of /proc/<pid>/stat (clock ticks after boot). Null where there is no /proc, or the
 * process is gone.
 */
export function linuxProcessStart(pid: number): number | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Field 2 is the command name in parentheses and may hold spaces or parentheses itself;
    // the fields after the last ')' start at field 3.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[22 - 3]);
    const btime = /^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'));
    if (!btime || !Number.isSafeInteger(ticks)) return null;
    return Number(btime[1]) * 1000 + Math.round((ticks * 1000) / USER_HZ);
  } catch {
    return null;
  }
}

let ownStart: number | undefined;

/** When this process started: from /proc where there is one, else from its uptime. */
function processStarted(): number {
  ownStart ??= linuxProcessStart(process.pid) ?? Math.round(Date.now() - process.uptime() * 1000);
  return ownStart;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists, under another user.
    return errorCode(e) === 'EPERM';
  }
}

function parseLock(bytes: Uint8Array): LockRecord | null {
  if (bytes.length > MAX_LOCK_BYTES) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes)) as Partial<LockRecord> | null;
    if (
      v?.format === 'manufakture-lock' &&
      typeof v.token === 'string' &&
      typeof v.host === 'string' &&
      typeof v.pid === 'number' &&
      typeof v.processStart === 'number'
    ) {
      return v as LockRecord;
    }
  } catch {
    // Torn or not a lock: judged by its age alone.
  }
  return null;
}

/** Whether two stats are of one file, unchanged: same device and inode, same times. */
const sameFile = (a: Stats, b: Stats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/**
 * The bytes of lock file `file` (at most MAX_LOCK_BYTES + 1, so a longer one does not parse)
 * and its stat, both through one open handle, so they are of one file. Opened without blocking
 * (a FIFO planted there does not hang it); anything but a regular file reads as no bytes. Null
 * when there is no file.
 */
async function readLockFile(file: string): Promise<{ bytes: Uint8Array; info: Stats } | null> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    if (NOT_THERE.has(errorCode(e) ?? '')) return null;
    throw e;
  }
  try {
    const info = await handle.stat();
    const buffer = new Uint8Array(MAX_LOCK_BYTES + 1);
    let length = 0;
    while (info.isFile() && length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return { bytes: buffer.subarray(0, length), info };
  } finally {
    await handle.close();
  }
}

/**
 * Remove `file` if it is still the file `info` was taken of (same inode, unchanged), checked
 * just before: never one another process put there meanwhile. True when it was removed.
 */
async function unlinkIfSame(file: string, info: Stats): Promise<boolean> {
  const now = await lstat(file).catch(() => null);
  if (!now || !sameFile(now, info)) return false;
  await unlink(file).catch(() => {});
  return true;
}

/**
 * Branch locks across processes: `locks/<document id>/<branch>.lock` under `root` (the
 * `NodeBackend`'s root), created exclusively (`O_EXCL`), so of two processes asking at once
 * exactly one gets it. `acquire` returns null while another holder has it. A lock is stale, and
 * is broken by the next `acquire`, when its process is gone. For a record of this machine that
 * is when its pid no longer runs, or runs a process that started at another time than the
 * record says (a reused pid); while it runs, the lock is never broken, however old the file. A
 * record of another machine, or a file that does not read as one, is stale when nobody refreshed
 * it for `staleAfterMs`. Breaking happens under a `<branch>.lock.break` file made the same
 * exclusive way. The lock is read and judged through one open handle, and removed only if the
 * path still holds that very file (same inode, unchanged) just before, so two processes breaking
 * at once cannot both end up holding it, nor one remove a lock the other just took.
 */
export class NodeBranchLocks implements BranchLocks {
  readonly #root: string;
  readonly #staleAfterMs: number;
  readonly #heartbeatMs: number;
  readonly #isAlive: (pid: number) => boolean;
  readonly #processStart: (pid: number) => number | null;
  readonly #beforeBreak: ((file: string) => Promise<void> | void) | undefined;

  constructor(root: string, options: NodeLockOptions = {}) {
    this.#root = path.resolve(root);
    this.#staleAfterMs = options.staleAfterMs ?? 120_000;
    this.#heartbeatMs = options.heartbeatMs ?? 30_000;
    this.#isAlive = options.isAlive ?? processAlive;
    this.#processStart = options.processStart ?? linuxProcessStart;
    this.#beforeBreak = options.beforeBreak;
  }

  /** The lock file of a branch. Ids are checked first, so this is always under the root. */
  file(documentId: string, branch: string): string {
    checkLockIds(documentId, branch);
    return path.join(this.#root, 'locks', documentId, `${branch}.lock`);
  }

  /** The record of the lock on a branch, or null when it is free (or its file does not read). */
  async holder(documentId: string, branch: string): Promise<LockRecord | null> {
    const read = await readLockFile(this.file(documentId, branch)).catch(() => null);
    return read ? parseLock(read.bytes) : null;
  }

  async acquire(documentId: string, branch: string, holder = ''): Promise<BranchLock | null> {
    const file = this.file(documentId, branch);
    await mkdir(path.dirname(file), { recursive: true });
    const record: LockRecord = {
      format: 'manufakture-lock',
      token: randomUUID(),
      host: hostname(),
      pid: process.pid,
      processStart: processStarted(),
      holder,
      takenAt: new Date().toISOString(),
    };
    // Twice at most: once, and once more after breaking a stale lock.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await this.#create(file, `${JSON.stringify(record, null, 2)}\n`)) {
        return this.#lock(documentId, branch, file, record);
      }
      if (!(await this.#breakStale(file))) return null;
    }
    return null;
  }

  /** Create `file` holding `text`, only if there is none: its stat, or null when there is one. */
  async #create(file: string, text: string): Promise<Stats | null> {
    let handle;
    try {
      handle = await open(file, 'wx');
    } catch (e) {
      if (errorCode(e) === 'EEXIST') return null;
      throw e;
    }
    try {
      await handle.writeFile(text);
      return await handle.stat();
    } finally {
      await handle.close();
    }
  }

  /** Whether the lock read from a file (`bytes`, and `info` of that same file) is stale. */
  #isStale(bytes: Uint8Array, info: Stats): boolean {
    const lock = parseLock(bytes);
    if (lock && lock.host === hostname()) {
      if (lock.pid === process.pid) return lock.processStart !== processStarted();
      if (!this.#isAlive(lock.pid)) return true;
      const started = this.#processStart(lock.pid);
      return started !== null && Math.abs(started - lock.processStart) > PROCESS_START_SLACK_MS;
    }
    return Date.now() - info.mtimeMs > this.#staleAfterMs;
  }

  /**
   * Remove the lock in `file` if it is stale; true when it is gone (stale, or released
   * meanwhile), so creating it may be tried again.
   */
  async #breakStale(file: string): Promise<boolean> {
    const breaker = `${file}.break`;
    const mine = await this.#create(breaker, `${process.pid}\n`);
    if (!mine) {
      // Someone is breaking it now, or died doing so.
      const info = await lstat(breaker).catch(() => null);
      if (info && Date.now() - info.mtimeMs > BREAK_STALE_MS) await unlinkIfSame(breaker, info);
      return false;
    }
    try {
      const read = await readLockFile(file);
      if (read === null) return true;
      if (!this.#isStale(read.bytes, read.info)) return false;
      await this.#beforeBreak?.(file);
      // Gone meanwhile: creating it again is exclusive, so trying is safe. Another file there
      // now (another breaker took over a break it thought dead, and took the lock): leave it.
      const now = await lstat(file).catch(() => null);
      if (now === null) return true;
      if (!sameFile(now, read.info)) return false;
      await unlink(file).catch(() => {});
      return true;
    } finally {
      await unlinkIfSame(breaker, mine);
    }
  }

  #lock(documentId: string, branch: string, file: string, record: LockRecord): BranchLock {
    let released = false;
    const mine = async (): Promise<boolean> => {
      if (released) return false;
      const read = await readLockFile(file).catch(() => null);
      return read !== null && parseLock(read.bytes)?.token === record.token;
    };
    const timer =
      this.#heartbeatMs > 0
        ? setInterval(() => {
            void mine().then(async (held) => {
              if (held) {
                const now = new Date();
                await utimes(file, now, now).catch(() => {});
              }
            });
          }, this.#heartbeatMs)
        : null;
    // A held lock never keeps the process alive on its own.
    timer?.unref();
    return {
      documentId,
      branch,
      held: mine,
      // Between the check and the unlink the lock could only change hands if it had been
      // broken, which a live holder on this machine never is, and one elsewhere is not while
      // its heartbeat refreshes it.
      release: async () => {
        if (released) return;
        if (timer) clearInterval(timer);
        const held = await mine();
        released = true;
        if (held) await unlink(file).catch(() => {});
      },
    };
  }
}
