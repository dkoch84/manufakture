import { describe, expect, it } from 'vitest';
import { MAX_DISPLAY_LENGTH, displayText } from './displayText';

describe('displayText', () => {
  it('keeps ordinary names, accents, scripts and emoji', () => {
    for (const name of [
      'Bracket',
      'Halterung f\u00fcr Regal',
      '\u0645\u0644\u0641',
      'Box \u{1f4e6}',
    ]) {
      expect(displayText(name)).toBe(name);
    }
  });

  it('removes bidi overrides, isolates and marks', () => {
    // "bracket" spelled backwards behind a right-to-left override, plus every isolate and mark.
    expect(displayText('\u202etekcarb\u202c')).toBe('tekcarb');
    expect(displayText('a\u2066b\u2067c\u2068d\u2069e\u200ef\u200fg\u061ch')).toBe('abcdefgh');
    expect(displayText('a\u202ab\u202bc\u202dd')).toBe('abcd');
  });

  it('removes control characters and folds whitespace', () => {
    expect(displayText('a\u0000b\u0007c\u001bd\u007fe\u0085f\u009fg')).toBe('abcdefg');
    expect(displayText('  two\n\tlines\u2028here  ')).toBe('two lines here');
    expect(displayText('\ufeffzero\u200bwidth')).toBe('zerowidth');
  });

  it('falls back when nothing visible is left', () => {
    expect(displayText('')).toBe('Untitled');
    expect(displayText('\u202e\u0000 ', 'Body 3')).toBe('Body 3');
  });

  it('cuts long names with an ellipsis, never through a surrogate pair', () => {
    const long = 'x'.repeat(500);
    expect(displayText(long)).toHaveLength(MAX_DISPLAY_LENGTH);
    expect(displayText(long).endsWith('\u2026')).toBe(true);
    const emoji = `${'x'.repeat(8)}\u{1f4e6}tail`;
    expect(displayText(emoji, '', 10)).toBe(`${'x'.repeat(8)}\u2026`);
  });

  it('leaves markup as plain text (React renders it as text)', () => {
    expect(displayText('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });
});
