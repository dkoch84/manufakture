import { Text } from '@codemirror/state';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import CodeEditor from './CodeEditor';
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
    const content = container.querySelector('.cm-content')!;
    expect(content.getAttribute('aria-label')).toBe('Source of Box');
    expect(content.textContent).toContain('export function run() {}');
  });
});
