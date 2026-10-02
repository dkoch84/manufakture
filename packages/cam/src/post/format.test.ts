import { describe, expect, it } from 'vitest';
import {
  MAX_NUMBER_DIGITS,
  commentLines,
  isCommentCommand,
  formatNumber,
  grblReadFloat,
  sanitizeComment,
} from './format';

describe('formatNumber', () => {
  it('rounds to the decimals and drops trailing zeros and points', () => {
    expect(formatNumber(12.5, 3)).toBe('12.5');
    expect(formatNumber(12, 3)).toBe('12');
    expect(formatNumber(12.34567, 3)).toBe('12.346');
    expect(formatNumber(-0.25, 3)).toBe('-0.25');
    expect(formatNumber(0.1 + 0.2, 3)).toBe('0.3');
    expect(formatNumber(1999.9996, 3)).toBe('2000');
    expect(formatNumber(18000, 0)).toBe('18000');
  });

  it('writes negative zero as 0', () => {
    expect(formatNumber(-0, 3)).toBe('0');
    expect(formatNumber(-0.0004, 3)).toBe('0');
    expect(formatNumber(-1e-12, 4)).toBe('0');
  });

  it('never writes an exponent', () => {
    expect(formatNumber(1e-7, 3)).toBe('0');
    expect(formatNumber(6e-7, 6)).toBe('0.000001');
    expect(formatNumber(1.5e-5, 4)).toBe('0');
    for (let e = -12; e <= 7; e++) {
      const text = formatNumber(1.234 * 10 ** e, 4);
      if (text !== undefined) expect(text).not.toMatch(/e/i);
    }
  });

  it('refuses what Grbl would not read exactly: non-finite, or more than eight digits', () => {
    expect(formatNumber(Number.NaN, 3)).toBeUndefined();
    expect(formatNumber(Number.POSITIVE_INFINITY, 3)).toBeUndefined();
    expect(formatNumber(1e21, 3)).toBeUndefined();
    expect(formatNumber(99999.999, 3)).toBe('99999.999');
    expect(formatNumber(123456.789, 3)).toBeUndefined();
    expect(formatNumber(-12345.6789, 4)).toBeUndefined();
    expect(MAX_NUMBER_DIGITS).toBe(8);
  });
});

describe('grblReadFloat', () => {
  it('reads like Grbl: single precision, in steps of 0.01', () => {
    expect(grblReadFloat('12.5')).toBe(12.5);
    expect(grblReadFloat('-0.25')).toBe(-0.25);
    expect(grblReadFloat('0')).toBe(0);
    expect(grblReadFloat('+3')).toBe(3);
    expect(grblReadFloat('100')).toBe(100);
    // 0.001 as Grbl gets it: 1 * 0.01f * 0.1f, not the double 0.001.
    const f = Math.fround;
    expect(grblReadFloat('0.001')).toBe(f(f(1 * f(0.01)) * f(0.1)));
    expect(grblReadFloat('36.494')).toBe(f(f(36494 * f(0.01)) * f(0.1)));
  });

  it('is within a float step of the decimal value', () => {
    for (const text of ['36.494', '-6.533', '1499.873', '0.0787', '-2.832', '1234.5678']) {
      const v = Number(text);
      expect(Math.abs(grblReadFloat(text) - v)).toBeLessThanOrEqual(Math.abs(v) * 4e-7);
    }
  });

  it('drops digits past the eighth, as Grbl does', () => {
    // Nine digits: the last is dropped, not rounded.
    expect(grblReadFloat('1.23456789')).toBeCloseTo(1.2345678, 6);
    expect(grblReadFloat('123456789')).toBe(Math.fround(123456780));
  });
});

describe('sanitizeComment', () => {
  it('keeps plain text', () => {
    expect(sanitizeComment('Pocket 1, 6.35 mm flat: 2 passes')).toBe(
      'Pocket 1, 6.35 mm flat: 2 passes',
    );
  });

  it('turns parentheses into brackets so comments never nest', () => {
    expect(sanitizeComment('Bit (1/4") (down-cut)')).toBe('Bit [1/4"] [down-cut]');
  });

  it('transliterates accents and drops other non-ASCII', () => {
    expect(sanitizeComment('Café crème 10°, 🙂 ok')).toBe('Cafe creme 10, ok');
  });

  it("never writes Grbl's real-time characters, ; or %", () => {
    const out = sanitizeComment('Ready? Go! ~resume; 50% done\u0018\u0085');
    expect(out).toBe('Ready Go resume 50 done');
    expect(out).not.toMatch(/[?!~;%()\u0080-￿]/);
  });

  it('collapses white space, newlines included', () => {
    expect(sanitizeComment('  a \t b\n\nc  ')).toBe('a b c');
  });
});

describe('commentLines', () => {
  it('wraps long text at spaces into parenthesised lines within the length', () => {
    const text = 'word '.repeat(40);
    const lines = commentLines(text, 30);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(30);
      expect(l).toMatch(/^\([^()]*\)$/);
    }
    expect(lines.map((l) => l.slice(1, -1)).join(' ')).toBe(text.trim());
  });

  it('breaks a word longer than a line', () => {
    expect(commentLines('x'.repeat(10), 6)).toEqual(['(xxx)', '(xxx)', '(xxx)', '(x)']);
  });

  it('writes nothing for an empty or all-unsafe comment', () => {
    expect(commentLines('', 80)).toEqual([]);
    expect(commentLines('?!~', 80)).toEqual([]);
  });
});

describe('controller comment commands', () => {
  it('recognises keywords and word-comma shapes, case-insensitively', () => {
    for (const t of [
      'MSG,hello',
      'msg, hello',
      'DEBUG,x',
      'PRINT,x',
      'LOGOPEN,/home/cnc/.bashrc',
      'logappend,x',
      'PROBEOPEN f',
      'ABORT,stop',
      'py,x=1',
      '  Py,x=1',
      'anything,else',
    ]) {
      expect(isCommentCommand(t), t).toBe(true);
    }
    for (const t of ['Pocket 1, rough', 'Tool 1: 6mm flat', 'T201 1/4in']) {
      expect(isCommentCommand(t), t).toBe(false);
    }
  });

  it('writes such a comment with a leading underscore', () => {
    expect(commentLines('LOGOPEN,/home/cnc/.bashrc', 80)).toEqual(['(_LOGOPEN,/home/cnc/.bashrc)']);
    expect(commentLines('py,x=1', 80)).toEqual(['(_py,x=1)']);
    expect(commentLines('PROBEOPEN f', 80)).toEqual(['(_PROBEOPEN f)']);
    expect(commentLines('Profile outside', 80)).toEqual(['(Profile outside)']);
  });

  it('neutralises a command that lands at the start of a wrapped continuation line', () => {
    const lines = commentLines('Tool name padding padding MSG,owned', 30);
    expect(lines).toEqual(['(Tool name padding padding)', '(_MSG,owned)']);
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(30);
      expect(isCommentCommand(l.slice(1, -1))).toBe(l.startsWith('(_'));
    }
  });
});
