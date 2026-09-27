// `.mfk` files: a document as one file, to move between machines. A zip holding
// `document.json` (the document in its storage form: imports point at blobs, see blobs.ts) and
// `blobs/<sha256>` (each imported file, once). Loaded on first use, with fflate.
//
// A file from elsewhere is untrusted. Nothing is inflated before the zip's directory is read
// here and checked as a whole: the file's own size, the number of entries, and that every entry
// (local header through its compressed data) lies inside the file, before the directory, and
// overlaps no other entry. So no two entries can alias one compressed stream, and all the
// compressed input read is bounded by the file's size. Then, for each entry read, its size and the
// total are checked against the limits (every entry counts as the larger of its two sizes, and a
// stored entry whose two sizes differ is refused), and only stored and deflate are read.
// Inflation cannot trust the claimed size either: fflate's one-shot inflate into a buffer of that
// size drops what does not fit but still decodes the whole stream, which a small file can make
// take minutes. So a deflated entry is inflated as a stream, 64 KiB of input at a time, counting
// its output, and refused as soon as it passes the size it claims (or if it ends short of it).
// Only `document.json` and well-formed blob names are read; every other entry, including names
// like `../x` or `/etc/x`, is ignored and never inflated.

import { Inflate, zipSync, type Zippable } from 'fflate';
import { formatBytes } from '../io/files';
import { isSha256 } from './blobs';
import { MAX_MFK_FILE_BYTES } from './limits';

export const DOCUMENT_ENTRY = 'document.json';
export const BLOB_PREFIX = 'blobs/';

/** Zip compression methods: the only two read. */
const STORED = 0;
const DEFLATE = 8;

export interface MfkLimits {
  /** The `.mfk` file itself. */
  maxFileBytes: number;
  /** Entries in the zip directory, read or not. */
  maxEntries: number;
  /** `document.json`, uncompressed. */
  maxDocumentBytes: number;
  /** One blob, uncompressed. */
  maxBlobBytes: number;
  /** Everything read, uncompressed. */
  maxTotalBytes: number;
}

const MiB = 1024 * 1024;

export const MFK_LIMITS: MfkLimits = {
  maxFileBytes: MAX_MFK_FILE_BYTES,
  maxEntries: 1000,
  // Imports are at most 20 MiB each (core's MAX_IMPORT_BYTES); a document holding them inline
  // as base64 (the plain document format) is about 4/3 of that per import.
  maxDocumentBytes: 64 * MiB,
  maxBlobBytes: 20 * MiB,
  maxTotalBytes: 512 * MiB,
};

export interface MfkContents {
  /** `document.json` as text. */
  document: string;
  /** Blob bytes by SHA-256 name (unchecked here: the loader checks each against its import). */
  blobs: Map<string, Uint8Array>;
}

export class MfkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MfkError';
  }
}

/** Write a `.mfk`: the document text and its blobs. */
export function packMfk(document: string, blobs: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const files: Zippable = { [DOCUMENT_ENTRY]: new TextEncoder().encode(document) };
  // Imported files are mostly STEP text, which deflates well; STL is binary, and gains less.
  for (const [sha, bytes] of blobs) files[`${BLOB_PREFIX}${sha}`] = bytes;
  return zipSync(files, { level: 6 });
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

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_BYTES = 22;
const CENTRAL_BYTES = 46;
const LOCAL_BYTES = 30;
/** Compressed input handed to the inflater at a time. */
const INFLATE_CHUNK = 64 * 1024;

const unreadable = (why: string) =>
  new MfkError(`This is not a manufakture file (.mfk): the zip cannot be read (${why}).`);

/** Bytes as Latin-1: names the reader accepts are ASCII, which reads the same either way. */
const latin1 = (b: Uint8Array) => String.fromCharCode(...b);

/**
 * The zip's central directory, every entry checked to lie within the file, before the
 * directory, without overlapping another entry. Reads no compressed data.
 */
function readDirectory(bytes: Uint8Array, limits: MfkLimits): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const lowest = Math.max(0, bytes.length - EOCD_BYTES - 0xffff);
  for (let i = bytes.length - EOCD_BYTES; i >= lowest; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw unreadable('it has no end of central directory');
  const count = view.getUint16(eocd + 10, true);
  const directoryBytes = view.getUint32(eocd + 12, true);
  const directoryStart = view.getUint32(eocd + 16, true);
  if (count === 0xffff || directoryBytes === 0xffffffff || directoryStart === 0xffffffff) {
    throw unreadable('ZIP64 is not supported');
  }
  if (count > limits.maxEntries) {
    throw new MfkError(`The file has more than ${limits.maxEntries} entries.`);
  }
  const directoryEnd = directoryStart + directoryBytes;
  if (directoryEnd > eocd) throw unreadable('its directory lies outside the file');

  const entries: ZipEntry[] = [];
  let p = directoryStart;
  for (let i = 0; i < count; i++) {
    if (p + CENTRAL_BYTES > directoryEnd || view.getUint32(p, true) !== CENTRAL_SIGNATURE) {
      throw unreadable('its directory is damaged');
    }
    const nameBytes = view.getUint16(p + 28, true);
    const next =
      p + CENTRAL_BYTES + nameBytes + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    if (next > directoryEnd) throw unreadable('its directory is damaged');
    const name = latin1(bytes.subarray(p + CENTRAL_BYTES, p + CENTRAL_BYTES + nameBytes));
    const size = view.getUint32(p + 20, true);
    const start = view.getUint32(p + 42, true);
    if (start + LOCAL_BYTES > directoryStart || view.getUint32(start, true) !== LOCAL_SIGNATURE) {
      throw new MfkError(`The file is damaged: the entry ${name} lies outside it.`);
    }
    const dataStart =
      start + LOCAL_BYTES + view.getUint16(start + 26, true) + view.getUint16(start + 28, true);
    const end = dataStart + size;
    if (end > directoryStart) {
      throw new MfkError(`The file is damaged: the entry ${name} lies outside it.`);
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
      throw new MfkError(
        `The file is damaged: the entries ${placed[i - 1]!.name} and ${placed[i]!.name} overlap.`,
      );
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
      throw new MfkError(
        `${name} is damaged: it inflates to more than the ${formatBytes(originalSize)} it claims.`,
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
    if (e instanceof MfkError) throw e;
    throw new MfkError(
      `${name} is damaged: it cannot be inflated (${e instanceof Error ? e.message : String(e)}).`,
    );
  }
  if (written !== originalSize) {
    throw new MfkError(`${name} is damaged: it inflates to less than it claims.`);
  }
  return out;
}

/** Read a `.mfk` within `limits`. Throws an `MfkError` saying what is wrong. */
export function unpackMfk(bytes: Uint8Array, limits: MfkLimits = MFK_LIMITS): MfkContents {
  if (bytes.length > limits.maxFileBytes) {
    throw new MfkError(`The file is larger than ${formatBytes(limits.maxFileBytes)}.`);
  }
  const entries = readDirectory(bytes, limits);
  const wanted: ZipEntry[] = [];
  let total = 0;
  for (const entry of entries) {
    const { name, method, size, originalSize } = entry;
    const isDocument = name === DOCUMENT_ENTRY;
    const isBlob = name.startsWith(BLOB_PREFIX) && isSha256(name.slice(BLOB_PREFIX.length));
    if (!isDocument && !isBlob) continue;
    if (method !== STORED && method !== DEFLATE) {
      throw new MfkError(`${name} uses an unsupported compression method.`);
    }
    if (entry.flags & 1) throw new MfkError(`${name} is encrypted.`);
    if (method === STORED && size !== originalSize) {
      throw new MfkError(`${name} is damaged: its sizes do not agree.`);
    }
    // What reading it produces: a stored entry is copied at `size`, a deflated one inflates to
    // at most `originalSize` bytes (more is refused).
    const produced = Math.max(size, originalSize);
    const max = isDocument ? limits.maxDocumentBytes : limits.maxBlobBytes;
    if (produced > max) {
      throw new MfkError(`${name} is larger than ${formatBytes(max)} uncompressed.`);
    }
    total += produced;
    if (total > limits.maxTotalBytes) {
      throw new MfkError(
        `The file holds more than ${formatBytes(limits.maxTotalBytes)} uncompressed.`,
      );
    }
    wanted.push(entry);
  }

  let document: Uint8Array | null = null;
  const blobs = new Map<string, Uint8Array>();
  for (const entry of wanted) {
    const data = bytes.subarray(entry.dataStart, entry.end);
    const read =
      entry.method === STORED ? data.slice() : inflateEntry(data, entry.originalSize, entry.name);
    if (entry.name === DOCUMENT_ENTRY) document = read;
    else blobs.set(entry.name.slice(BLOB_PREFIX.length), read);
  }
  if (!document) throw new MfkError(`This is not a manufakture file: it has no ${DOCUMENT_ENTRY}.`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(document);
  } catch {
    throw new MfkError(`${DOCUMENT_ENTRY} is not UTF-8 text.`);
  }
  return { document: text, blobs };
}
