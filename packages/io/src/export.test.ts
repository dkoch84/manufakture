import { describe, expect, it } from 'vitest';
import { MAX_FILE_NAME_BYTES, fileName } from './export';

describe('fileName', () => {
  it('replaces path separators, reserved and control characters', () => {
    expect(fileName('Demo part', 'stl')).toBe('Demo part.stl');
    expect(fileName('a/b\\c:d*e?"<>|f', 'stl')).toBe('a_b_c_d_e_f.stl');
    expect(fileName('tab\there\u007f', '3mf')).toBe('tab_here_.3mf');
    expect(fileName('  ', 'step')).toBe('export.step');
  });

  it('removes bidirectional controls, so a name cannot disguise its extension', () => {
    expect(fileName('invoice‮exe.stl', 'stl')).toBe('invoiceexe.stl.stl');
    const every = '‪‫‬‭‮⁦⁧⁨⁩‎‏؜';
    expect(fileName(`a${every}b`, 'stl')).toBe('ab.stl');
    expect(fileName(every, 'stl')).toBe('export.stl');
  });

  it('caps the name in UTF-8 bytes on a character boundary, without trailing dots', () => {
    const long = fileName('x'.repeat(1000), 'stl');
    expect(long).toBe(`${'x'.repeat(MAX_FILE_NAME_BYTES)}.stl`);
    // Four-byte characters: 50 fit, the 51st would split.
    const emoji = fileName('\u{1F600}'.repeat(60), 'stl');
    expect([...emoji.slice(0, -4)]).toHaveLength(MAX_FILE_NAME_BYTES / 4);
    expect(new TextEncoder().encode(emoji).length).toBe(MAX_FILE_NAME_BYTES + 4);
    expect(fileName(`${'y'.repeat(MAX_FILE_NAME_BYTES - 2)}. z`, 'stl')).toBe(
      `${'y'.repeat(MAX_FILE_NAME_BYTES - 2)}.stl`,
    );
    // An unpaired surrogate is not a character any file system name holds.
    expect(fileName('a\uD800b', 'stl')).toBe('a_b.stl');
  });
});
