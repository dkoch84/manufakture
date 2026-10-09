// Writing exports into the output directory, and nowhere else (the security review's "path
// confinement"). A file's name comes from the agent (`fileName`, already limited by its schema)
// or from the document (a body, drawing or document name, which anyone who wrote the document
// chose), so every name is reduced to one plain file name here before it is used:
//
// - only letters, digits, space and `. _ ( ) + -` are kept, everything else becomes `_`, so no
//   name holds a separator, a drive, a NUL or a control character;
// - no name starts with a dot (no `..`, no hidden files) or ends with a dot or a space, names
//   Windows reserves get a `_`;
// - two files of one export never get one name (compared without case);
// - the directory is the configured one, resolved with `realpath` on every call, and the joined
//   path must sit directly in it;
// - a file is written under a temporary name with `O_CREAT | O_EXCL` (which never follows a
//   symbolic link), then given its name: without `overwrite` by a hard link, which fails when
//   anything has that name, so a file that appears after the check is never replaced; with
//   `overwrite` by a rename, which replaces a link rather than writing through it. An existing
//   symbolic link, directory or other non-file at the name is refused, and an existing file is
//   replaced only with `overwrite`;
// - when one file of an export cannot be written, the ones it already wrote are removed.

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, lstat, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serverError, type ServerError } from './results';

/** Bytes one export may write in all (the `.mfk` total limit). */
export const MAX_EXPORT_BYTES = 512 * 1024 * 1024;
/** Files one export may write. */
export const MAX_EXPORT_FILES = 500;
const MAX_NAME = 120;

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

const TRAILING = /[.\s]+$/;

/** `name` as one safe file name (see the header). */
export function safeFileName(name: string, fallback = 'export'): string {
  let out = [...name.normalize('NFC')]
    .map((c) => (/^[A-Za-z0-9 ._()+-]$/.test(c) ? c : '_'))
    .join('')
    .replace(/_+/g, '_')
    .replace(/^[.\s]+/, '')
    .replace(TRAILING, '');
  if (out.length === 0 || /^[._ ]*$/.test(out)) out = fallback;
  if (out.length > MAX_NAME) {
    const ext = path.extname(out).slice(0, 12);
    out = out.slice(0, MAX_NAME - ext.length).replace(TRAILING, '') + ext;
    out = out.replace(TRAILING, '');
  }
  if (RESERVED.test(out)) out = `_${out}`;
  return out;
}

/** The extension of a produced file name, kept when the agent names the file. */
function extension(name: string): string {
  const ext = path.extname(name);
  return /^\.[A-Za-z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : '';
}

export interface OutFile {
  name: string;
  bytes: Uint8Array;
  type: string;
}

export interface Written {
  name: string;
  bytes: number;
  type: string;
}

/** The names the files are written under: the agent's base, or each file's own name, made safe. */
export function outputNames(files: readonly OutFile[], base: string | undefined): string[] {
  const names = files.map((f, i) => {
    if (base === undefined) return safeFileName(f.name);
    const suffix = files.length === 1 ? '' : `-${i + 1}`;
    return safeFileName(`${base}${suffix}${extension(f.name)}`);
  });
  // Two files of one export never land on one name, after the name is made safe (which may cut
  // a long name) and whatever the file system's case rules.
  const taken = new Set<string>();
  return names.map((n) => {
    let name = n;
    const ext = extension(n);
    const stem = n.slice(0, n.length - ext.length);
    for (let count = 2; taken.has(name.toLowerCase()); count++) {
      const suffix = ` (${count})`;
      name = safeFileName(`${stem.slice(0, MAX_NAME - ext.length - suffix.length)}${suffix}${ext}`);
    }
    taken.add(name.toLowerCase());
    return name;
  });
}

const code = (e: unknown): string | null => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(c) ? c : null;
};

const failure = (e: unknown): ServerError => {
  const c = code(e);
  return serverError('storage', c === null ? 'Writing failed.' : `Writing failed (${c}).`);
};

/**
 * Write `files` into `outputDir` (a real path from the configuration) under `names`. Every
 * target is checked before anything is written. Returns what was written, or why nothing (or not
 * everything) was.
 */
export async function writeOutputs(
  outputDir: string,
  files: readonly OutFile[],
  names: readonly string[],
  overwrite: boolean,
): Promise<{ ok: true; written: Written[] } | { ok: false; error: ServerError }> {
  if (files.length === 0) {
    return { ok: false, error: serverError('export', 'The export made no file.') };
  }
  if (files.length > MAX_EXPORT_FILES) {
    return {
      ok: false,
      error: serverError('too-large', `An export writes at most ${MAX_EXPORT_FILES} files.`, {
        limit: MAX_EXPORT_FILES,
      }),
    };
  }
  const total = files.reduce((n, f) => n + f.bytes.length, 0);
  if (total > MAX_EXPORT_BYTES) {
    return {
      ok: false,
      error: serverError(
        'too-large',
        `The export is ${total} bytes; at most ${MAX_EXPORT_BYTES} are written.`,
        { limit: MAX_EXPORT_BYTES },
      ),
    };
  }
  let dir: string;
  try {
    dir = await realpath(outputDir);
    if (dir !== outputDir || !(await stat(dir)).isDirectory()) {
      return {
        ok: false,
        error: serverError('path', 'The output directory changed since the server started.'),
      };
    }
  } catch (e) {
    return { ok: false, error: failure(e) };
  }
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) {
    return { ok: false, error: serverError('path', 'Two files would have one name.') };
  }
  const targets: string[] = [];
  for (const name of names) {
    if (name !== safeFileName(name) || name.includes(path.sep) || name.includes('/')) {
      return { ok: false, error: serverError('path', 'A file name is not a plain file name.') };
    }
    const target = path.join(dir, name);
    if (path.dirname(target) !== dir) {
      return { ok: false, error: serverError('path', 'A file would leave the output directory.') };
    }
    try {
      const there = await lstat(target);
      if (!there.isFile()) {
        return {
          ok: false,
          error: serverError('path', 'Something other than a file has that name.'),
        };
      }
      if (!overwrite) {
        return {
          ok: false,
          error: serverError('exists', 'A file of that name is there: pass overwrite: true.'),
        };
      }
    } catch (e) {
      if (code(e) !== 'ENOENT') return { ok: false, error: failure(e) };
    }
    targets.push(target);
  }
  const written: Written[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const temp = path.join(dir, `.${randomUUID()}.part`);
    try {
      await writeFile(temp, file.bytes, { flag: 'wx', mode: 0o644 });
      if (overwrite) await rename(temp, targets[i]!);
      else await place(temp, targets[i]!);
    } catch (e) {
      await rm(temp, { force: true }).catch(() => undefined);
      const error =
        code(e) === 'EEXIST'
          ? serverError('exists', 'A file of that name is there: pass overwrite: true.')
          : failure(e);
      // Nothing half done: the files this export already wrote are removed (and named when one
      // cannot be).
      const left: string[] = [];
      for (const w of written) {
        await rm(path.join(dir, w.name)).catch(() => left.push(w.name));
      }
      return {
        ok: false,
        error:
          left.length > 0 ? { ...error, details: left.map((n) => `Left behind: ${n}`) } : error,
      };
    }
    written.push({ name: names[i]!, bytes: file.bytes.length, type: file.type });
  }
  return { ok: true, written };
}

/** Errors of a file system that has no hard links. */
const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

/**
 * Give the finished `temp` the name `target` only if nothing has that name: a hard link (which
 * fails with EEXIST), then `temp` is removed. Where the file system has no hard links, a copy
 * opened with `O_EXCL` (`COPYFILE_EXCL`), which fails the same way.
 */
export async function place(temp: string, target: string): Promise<void> {
  try {
    await link(temp, target);
  } catch (e) {
    if (!NO_LINKS.has(code(e) ?? '')) throw e;
    await copyFile(temp, target, constants.COPYFILE_EXCL);
  }
  await rm(temp, { force: true });
}
