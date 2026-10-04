// Reading a zip from elsewhere, within limits. The same checks as the app's `.mfk` reader
// (apps/web/src/persistence/mfk.ts), as a package function so that readers of other zip formats
// (`.mfkview`) share them:
//
// Nothing is inflated before the zip's directory is read and checked as a whole: the file's own
// size, the number of entries, and that every entry (local header through its compressed data)
// lies inside the file, before the directory, and overlaps no other entry. So no two entries can
// alias one compressed stream, and all the compressed input read is bounded by the file's size.
// Then, for each entry the caller wants, its size and the total are checked against the limits
// (every entry counts as the larger of its two sizes, and a stored entry whose two sizes differ is
// refused), and only stored and deflate are read. A deflated entry is inflated as a stream, 64 KiB
// of input at a time, counting its output, and refused as soon as it passes the size it claims
// (or if it ends short of it): fflate's one-shot inflate decodes the whole stream whatever the
// buffer, which a small file can make take minutes. Entries the caller does not want are never
// inflated.

import { Inflate } from 'fflate';

export interface ZipReadLimits {
  /** The zip file itself. */
  maxFileBytes: number;
  /** Entries in the zip directory, read or not. */
  maxEntries: number;
  /** Everything read, uncompressed. */
  maxTotalBytes: number;
}

/**
 * Which entries to read: for an entry name, the most bytes it may hold uncompressed, or null to
 * leave it unread.
 */
export type ZipWanted = (name: string) => number | null;

/** A zip problem, worded for the person who opened the file. */
export class ZipReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipReadError';
  }
}

/** One entry of the zip's central directory, placed in the file. */
interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  /** Compressed size. */
  size: number;
  originalSize: number;
  /** Where its local header starts, and where its compressed data starts and ends. */
  start: number;
  dataStart: number;
  end: number;
}

const STORED = 0;
const DEFLATE = 8;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_BYTES = 22;
const CENTRAL_BYTES = 46;
const LOCAL_BYTES = 30;
/** Compressed input handed to the inflater at a time. */
const INFLATE_CHUNK = 64 * 1024;

/** A byte count for messages: `512 B`, `12.3 KB`, `4.5 MB`. */
export function formatByteCount(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const unreadable = (what: string, why: string) =>
  new ZipReadError(`This is not ${what}: the zip cannot be read (${why}).`);

/** Bytes as Latin-1: names a caller wants are ASCII, which reads the same either way. */
function latin1(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i++) out += String.fromCharCode(b[i]!);
  return out;
}

/**
 * The zip's central directory, every entry checked to lie within the file, before the
 * directory, without overlapping another entry. Reads no compressed data.
 */
function readDirectory(bytes: Uint8Array, limits: ZipReadLimits, what: string): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const lowest = Math.max(0, bytes.length - EOCD_BYTES - 0xffff);
  for (let i = bytes.length - EOCD_BYTES; i >= lowest; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw unreadable(what, 'it has no end of central directory');
  const count = view.getUint16(eocd + 10, true);
  const directoryBytes = view.getUint32(eocd + 12, true);
  const directoryStart = view.getUint32(eocd + 16, true);
  if (count === 0xffff || directoryBytes === 0xffffffff || directoryStart === 0xffffffff) {
    throw unreadable(what, 'ZIP64 is not supported');
  }
  if (count > limits.maxEntries) {
    throw new ZipReadError(`The file has more than ${limits.maxEntries} entries.`);
  }
  const directoryEnd = directoryStart + directoryBytes;
  if (directoryEnd > eocd) throw unreadable(what, 'its directory lies outside the file');

  const entries: ZipEntry[] = [];
  let p = directoryStart;
  for (let i = 0; i < count; i++) {
    if (p + CENTRAL_BYTES > directoryEnd || view.getUint32(p, true) !== CENTRAL_SIGNATURE) {
      throw unreadable(what, 'its directory is damaged');
    }
    const nameBytes = view.getUint16(p + 28, true);
    const next =
      p + CENTRAL_BYTES + nameBytes + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    if (next > directoryEnd) throw unreadable(what, 'its directory is damaged');
    const name = latin1(bytes.subarray(p + CENTRAL_BYTES, p + CENTRAL_BYTES + nameBytes));
    const size = view.getUint32(p + 20, true);
    const start = view.getUint32(p + 42, true);
    if (start + LOCAL_BYTES > directoryStart || view.getUint32(start, true) !== LOCAL_SIGNATURE) {
      throw new ZipReadError(`The file is damaged: an entry lies outside it.`);
    }
    const dataStart =
      start + LOCAL_BYTES + view.getUint16(start + 26, true) + view.getUint16(start + 28, true);
    const end = dataStart + size;
    if (end > directoryStart) {
      throw new ZipReadError(`The file is damaged: an entry lies outside it.`);
    }
    entries.push({
      name,
      flags: view.getUint16(p + 8, true),
      method: view.getUint16(p + 10, true),
      size,
      originalSize: view.getUint32(p + 24, true),
      start,
      dataStart,
      end,
    });
    p = next;
  }
  // No two entries may share bytes: aliased entries would inflate one stream many times over.
  const placed = [...entries].sort((a, b) => a.start - b.start);
  for (let i = 1; i < placed.length; i++) {
    if (placed[i]!.start < placed[i - 1]!.end) {
      throw new ZipReadError('The file is damaged: two of its entries overlap.');
    }
  }
  return entries;
}

/**
 * Inflate `data` as a stream, refusing it the moment it produces more than `originalSize` bytes,
 * and when it ends short of them.
 */
function inflateEntry(data: Uint8Array, originalSize: number, name: string): Uint8Array {
  const out = new Uint8Array(originalSize);
  let written = 0;
  const inflater = new Inflate((chunk) => {
    if (chunk.length > originalSize - written) {
      throw new ZipReadError(
        `${name} is damaged: it inflates to more than the ${formatByteCount(originalSize)} it claims.`,
      );
    }
    out.set(chunk, written);
    written += chunk.length;
  });
  try {
    let at = 0;
    do {
      const next = Math.min(data.length, at + INFLATE_CHUNK);
      inflater.push(data.subarray(at, next), next === data.length);
      at = next;
    } while (at < data.length);
  } catch (e) {
    if (e instanceof ZipReadError) throw e;
    throw new ZipReadError(
      `${name} is damaged: it cannot be inflated (${e instanceof Error ? e.message : String(e)}).`,
    );
  }
  if (written !== originalSize) {
    throw new ZipReadError(`${name} is damaged: it inflates to less than it claims.`);
  }
  return out;
}

/**
 * The names of a zip's entries, after the same checks of the file and its directory as `readZip`
 * makes, inflating nothing.
 */
export function listZip(bytes: Uint8Array, limits: ZipReadLimits, what: string): string[] {
  if (bytes.length > limits.maxFileBytes) {
    throw new ZipReadError(`The file is larger than ${formatByteCount(limits.maxFileBytes)}.`);
  }
  if (bytes.length < EOCD_BYTES) throw unreadable(what, 'it is too short');
  return readDirectory(bytes, limits, what).map((e) => e.name);
}

/**
 * Read the entries `wanted` names from a zip, within `limits`; `what` names the format in
 * messages ("a manufakture view (.mfkview)"). Throws a `ZipReadError` saying what is wrong. An
 * entry name that appears twice is refused, so a reader never has to choose between them.
 */
export function readZip(
  bytes: Uint8Array,
  limits: ZipReadLimits,
  wanted: ZipWanted,
  what: string,
): Map<string, Uint8Array> {
  if (bytes.length > limits.maxFileBytes) {
    throw new ZipReadError(`The file is larger than ${formatByteCount(limits.maxFileBytes)}.`);
  }
  if (bytes.length < EOCD_BYTES) throw unreadable(what, 'it is too short');
  const entries = readDirectory(bytes, limits, what);
  const chosen: ZipEntry[] = [];
  const names = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    const max = wanted(entry.name);
    if (max === null) continue;
    const { name, method, size, originalSize } = entry;
    if (names.has(name)) throw new ZipReadError(`The file holds ${name} twice.`);
    names.add(name);
    if (method !== STORED && method !== DEFLATE) {
      throw new ZipReadError(`${name} uses an unsupported compression method.`);
    }
    if (entry.flags & 1) throw new ZipReadError(`${name} is encrypted.`);
    if (method === STORED && size !== originalSize) {
      throw new ZipReadError(`${name} is damaged: its sizes do not agree.`);
    }
    // What reading it produces: a stored entry is copied at `size`, a deflated one inflates to at
    // most `originalSize` bytes (more is refused).
    const produced = Math.max(size, originalSize);
    if (produced > max) {
      throw new ZipReadError(`${name} is larger than ${formatByteCount(max)} uncompressed.`);
    }
    total += produced;
    if (total > limits.maxTotalBytes) {
      throw new ZipReadError(
        `The file holds more than ${formatByteCount(limits.maxTotalBytes)} uncompressed.`,
      );
    }
    chosen.push(entry);
  }
  const out = new Map<string, Uint8Array>();
  for (const entry of chosen) {
    const data = bytes.subarray(entry.dataStart, entry.end);
    out.set(
      entry.name,
      entry.method === STORED ? data.slice() : inflateEntry(data, entry.originalSize, entry.name),
    );
  }
  return out;
}
