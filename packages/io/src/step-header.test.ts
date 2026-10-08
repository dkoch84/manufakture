import { describe, expect, it } from 'vitest';
import { stepStrings, withStepDescription } from './step-header';

const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

describe('the STEP header description', () => {
  it('writes text as ASCII STEP strings, quotes doubled, split at spaces', () => {
    expect(stepStrings("it's ok")).toEqual(["'it''s ok'"]);
    expect(stepStrings('aéb')).toEqual(["'a?b'"]);
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    const parts = stepStrings(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(202);
    expect(parts.map((p) => p.slice(1, -1)).join(' ')).toBe(long);
  });

  it("replaces the kernel's description, over several lines too, and nothing else", () => {
    const file = [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION(('Open CASCADE Model',",
      "  'second (line)'),'2;1');",
      "FILE_NAME('x','t',(''),(''),'p','o','u');",
      'ENDSEC;',
      'DATA;',
      "#7 = PRODUCT('FILE_DESCRIPTION((''no''),','','',(#8));",
      'ENDSEC;',
    ].join('\n');
    const out = decode(withStepDescription(encode(file), 'Not an engineering tool.'));
    expect(out).toBe(
      file.replace(
        "FILE_DESCRIPTION(('Open CASCADE Model',\n  'second (line)'),",
        "FILE_DESCRIPTION(('Not an engineering tool.'),",
      ),
    );
  });

  it('doubles backslashes before quotes, so no control directive starts in the text', () => {
    expect(stepStrings('a\\b')).toEqual(["'a\\\\b'"]);
    expect(stepStrings("\\X2\\ it's")).toEqual(["'\\\\X2\\\\ it''s'"]);
    // A quote after a backslash is still doubled, not taken as escaped.
    expect(stepStrings("\\'")).toEqual(["'\\\\'''"]);
  });

  it('splices the header bytes and leaves non-UTF-8 bytes in DATA exactly as they were', () => {
    const head = encode(
      "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('Open CASCADE Model'),'2;1');\nENDSEC;\nDATA;\n#1 = PRODUCT('",
    );
    // Latin-1 bytes and a lone continuation byte: invalid UTF-8, lost by a decode and re-encode.
    const raw = new Uint8Array([0xe9, 0x80, 0xff, 0xc3]);
    const tail = encode("');\nENDSEC;\nEND-ISO-10303-21;\n");
    const file = new Uint8Array([...head, ...raw, ...tail]);
    const out = withStepDescription(file, 'Not an engineering tool.');
    const from = "FILE_DESCRIPTION(('Open CASCADE Model'),";
    const to = "FILE_DESCRIPTION(('Not an engineering tool.'),";
    const at = decode(head).indexOf(from);
    expect(out.length).toBe(file.length - from.length + to.length);
    expect(out.subarray(0, at)).toEqual(file.subarray(0, at));
    expect(decode(out.subarray(at, at + to.length))).toBe(to);
    expect(out.subarray(at + to.length)).toEqual(file.subarray(at + from.length));
    expect(out.subarray(out.length - raw.length - tail.length, out.length - tail.length)).toEqual(
      raw,
    );
  });

  it('leaves a file with no description as it is', () => {
    const bytes = encode('ISO-10303-21;\nHEADER;\nENDSEC;\n');
    expect(withStepDescription(bytes, 'x')).toBe(bytes);
  });
});
