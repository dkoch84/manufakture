// Text as a bundle shows it: the JSON of a command keeps hidden characters visible as escapes.

import { describe, expect, it } from 'vitest';
import { jsonText, shown } from './text';

describe('jsonText', () => {
  it('writes control, format and lone surrogate characters as \\u escapes', () => {
    const name = 'a\u202Eb\u200Bc\u0085d\u007Fe\u{E0041}f\uD800g';
    const { json, truncated } = jsonText({ name }, 1000);
    expect(truncated).toBe(false);
    expect(json).toBe('{"name":"a\\u202eb\\u200bc\\u0085d\\u007fe\\udb40\\udc41f\\ud800g"}');
    expect(/[\p{Cc}\p{Cf}\p{Cs}]/u.test(json)).toBe(false);
    // Still the same JSON value.
    expect(JSON.parse(json)).toEqual({ name });
  });

  it('leaves ordinary text, and JSON escapes it already made, as they are', () => {
    expect(jsonText({ s: 'Größe "1"\n\t' }, 1000).json).toBe('{"s":"Größe \\"1\\"\\n\\t"}');
  });

  it('cuts at max characters', () => {
    expect(jsonText({ s: 'x'.repeat(20) }, 10)).toEqual({ json: '{"s":"xxxx', truncated: true });
  });
});

describe('shown', () => {
  it('replaces hidden characters and cuts', () => {
    expect(shown('a\u202Eb')).toBe('a\uFFFDb');
    expect(shown('abcdefghij', 6)).toBe('abc...');
  });
});
