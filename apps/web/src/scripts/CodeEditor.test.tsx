import { EditorSelection, Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import CodeEditor from './CodeEditor';
import { EMPTY_SOURCE_HINT, minimalChange } from './editorText';
import { toDiagnostic } from './markers';

describe('CodeEditor', () => {
  it('turns a 1-based line and column into a marked range: the word there, else the line', () => {
    const doc = Text.of(['export function run(ctx) {', '  boom();', '}']);
    expect(toDiagnostic(doc, { line: 2, column: 3, message: 'm', source: 'Scripted 1' })).toEqual({
      from: 29,
      to: 33,
      severity: 'error',
      message: 'm',
      source: 'Scripted 1',
    });
    // No column: the whole line; out of range: clamped into the text.
    expect(toDiagnostic(doc, { line: 2, message: 'm' })).toMatchObject({ from: 27, to: 36 });
    expect(toDiagnostic(doc, { line: 99, column: 99, message: 'm' })).toMatchObject({
      from: 38,
      to: 38,
    });
  });

  it('shows the source with its accessible name', () => {
    const { container } = render(
      <CodeEditor
        value={'export function run() {}\n'}
        language="ts"
        markers={[]}
        label="Source of Box"
        onChange={() => {}}
      />,
    );
    // In a shadow root, where its styles get past the Content-Security-Policy.
    const host = container.querySelector('[data-testid="script-source"]')!;
    expect(container.querySelector('.cm-content')).toBeNull();
    const content = host.shadowRoot!.querySelector('.cm-content')!;
    expect(content.getAttribute('aria-label')).toBe('Source of Box');
    expect(content.textContent).toContain('export function run() {}');
  });

  it('shows what to write in an empty code area', () => {
    const { container } = render(
      <CodeEditor value="" language="js" markers={[]} label="Source" onChange={() => {}} />,
    );
    const host = container.querySelector('[data-testid="script-source"]')!;
    expect(host.shadowRoot!.querySelector('.cm-placeholder')?.textContent).toBe(EMPTY_SOURCE_HINT);
  });

  it('finds the smallest change between two texts', () => {
    expect(minimalChange('abc', 'abc')).toBeNull();
    expect(minimalChange('abcdef', 'abXYcdef')).toEqual({ from: 2, to: 2, insert: 'XY' });
    expect(minimalChange('abcdef', 'abef')).toEqual({ from: 2, to: 4, insert: '' });
    expect(minimalChange('aaa', 'aaaa')).toEqual({ from: 3, to: 3, insert: 'a' });
    expect(minimalChange('', 'x')).toEqual({ from: 0, to: 0, insert: 'x' });
    expect(minimalChange('x', '')).toEqual({ from: 0, to: 1, insert: '' });
  });

  /** The editor under a parent that holds the value, as the script editor does. */
  function controlled(initial: string) {
    let setOutside: (v: string) => void = () => {};
    const onChange = vi.fn();
    function Parent() {
      const [value, setValue] = useState(initial);
      setOutside = setValue;
      return (
        <CodeEditor
          value={value}
          language="js"
          markers={[]}
          label="Source"
          onChange={(v) => {
            onChange(v);
            setValue(v);
          }}
        />
      );
    }
    const { container } = render(<Parent />);
    const host = container.querySelector('[data-testid="script-source"]')!;
    const view = EditorView.findFromDOM(
      host.shadowRoot!.querySelector('.cm-editor') as HTMLElement,
    )!;
    return { view, onChange, setOutside: (v: string) => act(() => setOutside(v)) };
  }

  it('keeps the caret where it is when its own text comes back as the value', () => {
    const { view, onChange } = controlled('const a = 1;\nconst b = 2;\n');
    const spy = vi.spyOn(view, 'dispatch');
    act(() => {
      view.dispatch({ selection: EditorSelection.cursor(18) });
      view.dispatch(view.state.replaceSelection('xyz'));
    });
    expect(onChange).toHaveBeenLastCalledWith('const a = 1;\nconstxyz b = 2;\n');
    // The value fed back changed nothing: the only change is the one typed.
    const changes = spy.mock.calls.filter(([spec]) => 'changes' in (spec as object));
    expect(changes).toHaveLength(1);
    expect(view.state.selection.main.head).toBe(21);
    expect(view.state.doc.toString()).toBe('const a = 1;\nconstxyz b = 2;\n');
  });

  it('a value from outside changes only what differs, and the caret stays with its text', () => {
    const { view, setOutside } = controlled('const a = 1;\nconst b = 2;\n');
    act(() => view.dispatch({ selection: EditorSelection.cursor(19) }));
    // A line added above the caret: the caret moves down with its text, not to the start.
    setOutside('// note\nconst a = 1;\nconst b = 2;\n');
    expect(view.state.doc.toString()).toBe('// note\nconst a = 1;\nconst b = 2;\n');
    expect(view.state.selection.main.head).toBe(27);
    // An edit after the caret leaves it alone.
    setOutside('// note\nconst a = 1;\nconst b = 3;\n');
    expect(view.state.selection.main.head).toBe(27);
  });
});
