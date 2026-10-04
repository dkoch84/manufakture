// Regen's error positions as CodeMirror diagnostics (types only from CodeMirror, so this module
// costs nothing where the editor is not loaded).

import type { Diagnostic } from '@codemirror/lint';
import type { Text } from '@codemirror/state';
import type { EditorMarker } from './editorTypes';

/** A marker as a CodeMirror diagnostic: from its position to the end of the token or line. */
export function toDiagnostic(doc: Text, marker: EditorMarker): Diagnostic {
  const lineNo = Math.min(Math.max(marker.line ?? 1, 1), doc.lines);
  const line = doc.line(lineNo);
  const column = Math.min(Math.max((marker.column ?? 1) - 1, 0), line.length);
  const from = line.from + column;
  // Underline the word at the position, or the rest of the line when there is none.
  const rest = line.text.slice(column);
  const word = /^[\w$]+/.exec(rest)?.[0].length ?? 0;
  const to = word > 0 ? from + word : line.to;
  return {
    from,
    to,
    severity: 'error',
    message: marker.message,
    ...(marker.source !== undefined ? { source: marker.source } : {}),
  };
}
