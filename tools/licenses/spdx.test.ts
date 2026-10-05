import { describe, expect, it } from 'vitest';
import { judge, PLAIN } from './check.ts';
import { normalizeId, parseSpdx, SpdxSyntaxError } from './spdx.ts';

describe('parseSpdx', () => {
  it('reads a single id, WITH, AND, OR and parentheses', () => {
    expect(parseSpdx('MIT')).toEqual({ type: 'license', id: 'MIT', exception: null });
    expect(parseSpdx('LGPL-2.1-only WITH Open-CASCADE-Exception-1.0')).toEqual({
      type: 'license',
      id: 'LGPL-2.1-only',
      exception: 'Open-CASCADE-Exception-1.0',
    });
    expect(parseSpdx('(MIT OR Apache-2.0)')).toEqual({
      type: 'or',
      left: { type: 'license', id: 'MIT', exception: null },
      right: { type: 'license', id: 'Apache-2.0', exception: null },
    });
  });

  it('binds AND tighter than OR', () => {
    const node = parseSpdx('MIT OR ISC AND GPL-2.0-only');
    expect(node).toMatchObject({ type: 'or', right: { type: 'and' } });
    expect(parseSpdx('(MIT OR ISC) AND Zlib')).toMatchObject({ type: 'and', left: { type: 'or' } });
  });

  it('accepts operators in any case', () => {
    expect(parseSpdx('mit or apache-2.0')).toMatchObject({ type: 'or' });
  });

  it('rewrites deprecated GNU ids', () => {
    expect(normalizeId('GPL-3.0')).toBe('GPL-3.0-only');
    expect(normalizeId('LGPL-2.1+')).toBe('LGPL-2.1-or-later');
    expect(normalizeId('AGPL-3.0')).toBe('AGPL-3.0-only');
    expect(normalizeId('MIT')).toBe('MIT');
    expect(parseSpdx('GPL-2.0+')).toMatchObject({ id: 'GPL-2.0-or-later' });
  });

  it('rejects what is not an expression', () => {
    for (const bad of [
      '',
      '(MIT',
      'MIT)',
      'MIT OR',
      'MIT WITH',
      'OR MIT',
      'MIT Apache-2.0',
      'Apache 2.0',
      'SEE LICENSE IN LICENSE.txt',
    ]) {
      expect(() => parseSpdx(bad), bad).toThrow(SpdxSyntaxError);
    }
  });
});

describe('judge (the ADR 0006 allowlist)', () => {
  it('allows permissive licenses, MPL-2.0 and GPLv3-compatible GPL', () => {
    for (const ok of [
      'MIT',
      'Apache-2.0',
      'BSD-3-Clause',
      'ISC',
      'BSL-1.0',
      'MPL-2.0',
      'GPL-3.0-or-later',
      'GPL-2.0+',
      'GPL-3.0',
    ]) {
      expect(judge(ok).ok, ok).toBe(true);
    }
  });

  it('takes the allowed side of an OR, and needs both sides of an AND', () => {
    expect(judge('(MIT OR Apache-2.0)').ok).toBe(true);
    expect(judge('(AGPL-3.0-only OR MIT)').ok).toBe(true);
    expect(judge('MIT AND AGPL-3.0-only').ok).toBe(false);
    expect(judge('(MIT OR ISC) AND (Apache-2.0 OR GPL-2.0-only)').ok).toBe(true);
    expect(judge('(MIT OR ISC) AND (SSPL-1.0 OR GPL-2.0-only)')).toEqual({
      ok: false,
      reasons: ['SSPL-1.0 is not on the allowlist', 'GPL-2.0-only is not compatible with GPLv3'],
    });
  });

  it('refuses AGPL, GPL-2.0-only and unknown ids', () => {
    expect(judge('AGPL-3.0-only').reasons[0]).toMatch(/not allowed/);
    expect(judge('GPL-2.0').ok).toBe(false);
    expect(judge('UNLICENSED').ok).toBe(false);
    expect(judge('SEE LICENSE IN LICENSE').reasons[0]).toMatch(/not an SPDX expression/);
  });

  it('allows LGPL 2.x only for a separate .wasm module, and never LGPL-3.0', () => {
    expect(judge('LGPL-2.0-or-later').ok).toBe(false);
    const module = { ...PLAIN, separateModule: true };
    expect(judge('LGPL-2.0-or-later', module).ok).toBe(true);
    expect(judge('LGPL-2.1-only WITH Open-CASCADE-Exception-1.0', module).ok).toBe(true);
    expect(judge('LGPL-2.1-only WITH Open-CASCADE-Exception-1.0').ok).toBe(false);
    expect(judge('LGPL-3.0-or-later', module).ok).toBe(false);
  });

  it('checks exceptions against the licenses they modify', () => {
    expect(judge('Apache-2.0 WITH LLVM-exception').ok).toBe(true);
    expect(judge('MIT WITH LLVM-exception').reasons[0]).toMatch(/does not apply to MIT/);
    expect(judge('GPL-3.0-only WITH Made-Up-Exception').reasons[0]).toMatch(/not on the allowlist/);
  });

  it('allows OFL for fonts only', () => {
    expect(judge('OFL-1.1').ok).toBe(false);
    expect(judge('OFL-1.1-no-RFN', { ...PLAIN, font: true }).ok).toBe(true);
  });

  it('refuses MPL-2.0 marked Incompatible With Secondary Licenses unless another side allows', () => {
    const marked = { ...PLAIN, exhibitB: true };
    expect(judge('MPL-2.0', marked).ok).toBe(false);
    expect(judge('MPL-2.0 OR MIT', marked).ok).toBe(true);
  });
});
