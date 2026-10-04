// The script editor's code area: CodeMirror 6 with JavaScript or TypeScript highlighting, line
// numbers, undo history and the errors regen reported as markers (a gutter dot and an underline,
// with the message on hover). This module is the only one that imports CodeMirror, and it is
// loaded on first use (the script editor imports it lazily), so the app's main chunk carries none
// of it. CodeMirror injects its styles as constructed style sheets, which the Content-Security-
// Policy (`style-src 'self'`) allows.

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import { Compartment, EditorState } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { useEffect, useRef } from 'react';
import type { CodeEditorProps } from './editorTypes';
import { toDiagnostic } from './markers';

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '0.85rem', background: '#fff' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
  '&.cm-focused': { outline: '2px solid #2f6fe4' },
});

export default function CodeEditor({ value, language, markers, label, onChange }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const languageSlot = useRef(new Compartment());
  const changed = useRef(onChange);
  useEffect(() => {
    changed.current = onChange;
  }, [onChange]);

  // The view lives as long as the component.
  useEffect(() => {
    const parent = host.current;
    if (parent === null) return;
    const v = new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          bracketMatching(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          lintGutter(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          languageSlot.current.of(javascript({ typescript: language === 'ts' })),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) changed.current(u.state.doc.toString());
          }),
          theme,
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // Made once; later values arrive through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A value from outside (reverting, loading another script) replaces the text.
  useEffect(() => {
    const v = view.current;
    if (v === null || v.state.doc.toString() === value) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: languageSlot.current.reconfigure(javascript({ typescript: language === 'ts' })),
    });
  }, [language]);

  useEffect(() => {
    const v = view.current;
    if (v === null) return;
    v.dispatch(
      setDiagnostics(
        v.state,
        markers.map((m) => toDiagnostic(v.state.doc, m)),
      ),
    );
  }, [markers]);

  return <div ref={host} className="code-editor" data-testid="script-source" />;
}
