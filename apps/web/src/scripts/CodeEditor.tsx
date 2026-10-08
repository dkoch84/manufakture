// The script editor's code area: CodeMirror 6 with JavaScript or TypeScript highlighting, line
// numbers, undo history and the errors regen reported as markers (a gutter dot and an underline,
// with the message on hover). This module is the only one that imports CodeMirror, and it is
// loaded on first use (the script editor imports it lazily), so the app's main chunk carries none
// of it.
//
// The editor lives in a shadow root on its host element. CodeMirror styles everything (layout
// included: the gutter beside the text, `white-space: pre`, where the caret and selection are
// drawn) from style modules it injects at run time. In a document it injects them as an inline
// `<style>` element, which the production Content-Security-Policy (`style-src 'self'`) refuses:
// the editor then lost its layout, the line numbers stacked above the text, clicks landed on the
// wrong character and the box scrolled under the caret as you typed. In a shadow root it adopts a
// constructed style sheet instead, which the policy does not govern.

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
  placeholder,
} from '@codemirror/view';
import { useEffect, useRef } from 'react';
import type { CodeEditorProps } from './editorTypes';
import { EMPTY_SOURCE_HINT, minimalChange } from './editorText';
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
    const el = host.current;
    if (el === null) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    // Keys typed in the code are the editor's. Outside the shadow root their target is the host,
    // not the text, so the app's window shortcuts (undo, the sketch tool keys) would no longer see
    // that they come from a text field: they stop at the host. Escape goes on, to close the editor.
    const ownKeys = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') e.stopPropagation();
    };
    el.addEventListener('keydown', ownKeys);
    const v = new EditorView({
      parent: root,
      root,
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
          placeholder(EMPTY_SOURCE_HINT),
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
      el.removeEventListener('keydown', ownKeys);
      v.destroy();
      view.current = null;
    };
    // Made once; later values arrive through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A value from outside changes the text. What the editor reported itself comes back equal and
  // changes nothing; anything else replaces only the span that differs, so the caret stays put.
  useEffect(() => {
    const v = view.current;
    if (v === null) return;
    const change = minimalChange(v.state.doc.toString(), value);
    if (change !== null) v.dispatch({ changes: change });
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
