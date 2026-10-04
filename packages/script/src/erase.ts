// TypeScript erasure (ADR 0010 decision 7, sucrase 3.35.1 chosen by T7.0c) and the source checks
// that come before running anything:
//
// - `namespace` and `module` blocks and `import x = require()` (or `= A.B`) are refused before
//   erasing, because sucrase drops them silently and later uses would fail far from the cause.
//   Ambient `declare namespace` / `declare module` blocks are types only and are allowed.
// - `import` of any kind is refused after erasing: scripts have no module loading, and QuickJS's
//   own error for it carries no position. Type-only imports (`import type { X } from '...'`,
//   or an import whose names are only used as types) are erased by sucrase first, so editor
//   typings keep working.
//
// Sucrase keeps every line but deletes annotations instead of blanking them, so columns after an
// annotation move; the source map it emits maps them back (`PositionMap`).
//
// The token checks read sucrase's public `getFormattedTokens` (its own tokenizer, so strings,
// templates, comments and regular expressions are handled exactly as the transform sees them)
// rather than deep-importing its parser: the package's ESM build uses extensionless imports that
// Node cannot load, and a CommonJS deep import would put a second copy of the parser in the app's
// bundle.

import { getFormattedTokens, transform } from 'sucrase';
import { scriptError, type ScriptError } from './errors';
import { PositionMap, type SourcePosition } from './sourcemap';

export type ScriptLanguage = 'js' | 'ts';

/**
 * Longest source accepted, in UTF-16 code units (256 Ki). Checked before sucrase sees it, as
 * defence in depth behind core's own size limit on stored scripts (T7.2a).
 */
export const MAX_SOURCE_LENGTH = 256 * 1024;

export interface PreparedSource {
  /** JavaScript QuickJS evaluates as a module. */
  code: string;
  /** File name in backtraces. */
  filename: string;
  /** Maps a position in `code` to the source as written. */
  toSource(position: SourcePosition): SourcePosition;
}

export type PrepareResult = { ok: true; value: PreparedSource } | { ok: false; error: ScriptError };

interface Token {
  label: string;
  raw: string;
  start: SourcePosition;
}

/** Erases types (for `ts`) and checks the source. Never throws. */
export function prepareSource(source: string, language: ScriptLanguage): PrepareResult {
  if (language !== 'js' && language !== 'ts') {
    return { ok: false, error: scriptError('bad-declaration', `Unknown script language.`) };
  }
  if (typeof source !== 'string' || source.length > MAX_SOURCE_LENGTH) {
    return {
      ok: false,
      error: scriptError(
        'value-too-large',
        `A script source may be at most ${MAX_SOURCE_LENGTH} characters long.`,
      ),
    };
  }
  const filename = language === 'ts' ? 'script.ts' : 'script.js';
  let code = source;
  let toSource = (p: SourcePosition): SourcePosition => p;
  try {
    if (language === 'ts') {
      const refused = refusedTypeScript(tokens(source, ['typescript']));
      if (refused !== null) return { ok: false, error: refused };
      const out = transform(source, {
        transforms: ['typescript'],
        disableESTransforms: true,
        filePath: filename,
        sourceMapOptions: { compiledFilename: 'script.js' },
      });
      code = out.code;
      const map = new PositionMap(out.sourceMap?.mappings ?? '');
      toSource = (p) => map.toSource(p);
    }
    for (const t of tokens(code, [])) {
      if (t.label === 'import') {
        return {
          ok: false,
          error: scriptError(
            'unsupported-syntax',
            'Scripts cannot import modules: everything a script uses comes from the ctx argument of run().',
            toSource(t.start),
          ),
        };
      }
    }
  } catch (e) {
    return { ok: false, error: syntaxError(source, e) };
  }
  return { ok: true, value: { code, filename, toSource } };
}

function refusedTypeScript(list: Token[]): ScriptError | null {
  for (let i = 0; i < list.length; i++) {
    const t = list[i]!;
    const next = list[i + 1];
    const after = list[i + 2];
    if (t.label === 'name' && (t.raw === 'namespace' || t.raw === 'module')) {
      const declared = list[i - 1]?.label === 'declare';
      const named =
        next !== undefined &&
        (next.label === 'name' || (t.raw === 'module' && next.label === 'string'));
      const opens = after !== undefined && (after.label === '{' || after.label === '.');
      if (!declared && named && opens) {
        return scriptError(
          'unsupported-syntax',
          `TypeScript ${t.raw} blocks are not supported in scripts; use plain objects or functions.`,
          t.start,
        );
      }
    }
    if (t.label === 'import') {
      let j = i + 1;
      if (list[j]?.label === 'name' && list[j]?.raw === 'type' && list[j + 1]?.label === 'name') {
        j++;
      }
      if (list[j]?.label === 'name' && list[j + 1]?.label === '=') {
        return scriptError(
          'unsupported-syntax',
          '`import x = require()` and import aliases are not supported in scripts.',
          t.start,
        );
      }
    }
  }
  return null;
}

/** Sucrase's tokens: location, label and (truncated) raw text of each. */
function tokens(code: string, transforms: 'typescript'[]): Token[] {
  const text = getFormattedTokens(code, { transforms });
  const rows = text.split('\n');
  const header = rows[0] ?? '';
  const labelAt = header.indexOf('Label');
  const rawAt = header.indexOf('Raw');
  const afterRaw = header.indexOf('contextualKeyword');
  const out: Token[] = [];
  for (const row of rows.slice(1)) {
    // A raw token text containing a newline (a template or string) splits its row; the first
    // part still starts with the location, the rest does not and is skipped.
    const m = /^(\d+):(\d+)-/.exec(row);
    if (m === null) continue;
    out.push({
      start: { line: Number(m[1]), column: Number(m[2]) },
      label: row.slice(labelAt, rawAt).trim(),
      raw: row.slice(rawAt, afterRaw < 0 ? undefined : afterRaw).trim(),
    });
  }
  return out;
}

function syntaxError(source: string, e: unknown): ScriptError {
  const message = e instanceof Error ? e.message.replace(/\s*\(\d+:\d+\)$/, '') : String(e);
  const pos = (e as { pos?: unknown } | null)?.pos;
  if (typeof pos !== 'number') return scriptError('syntax', message);
  return scriptError('syntax', message, positionAt(source, pos));
}

/** 1-based line and column of a UTF-16 offset. */
export function positionAt(source: string, offset: number): SourcePosition {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}
