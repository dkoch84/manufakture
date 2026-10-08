// Text helpers of the script editor's code area, kept apart from CodeEditor.tsx (which may export
// only its component) and free of CodeMirror, so they cost the main chunk nothing.

/** Shown in an empty code area. */
export const EMPTY_SOURCE_HINT =
  'Write the script here: export params (its parameters) and a function run(ctx, p) that ' +
  'builds the feature. The Scripting guide describes the API.';

/**
 * The change that turns `from` into `to`, touching only the span between their common start and
 * common end, so the caret and selection elsewhere stay where they are. Null when they are equal.
 */
export function minimalChange(
  from: string,
  to: string,
): { from: number; to: number; insert: string } | null {
  if (from === to) return null;
  let start = 0;
  const shorter = Math.min(from.length, to.length);
  while (start < shorter && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  let end = 0;
  while (
    end < shorter - start &&
    from.charCodeAt(from.length - 1 - end) === to.charCodeAt(to.length - 1 - end)
  ) {
    end++;
  }
  return { from: start, to: from.length - end, insert: to.slice(start, to.length - end) };
}
