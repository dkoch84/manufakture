import { describe, expect, it } from 'vitest';
import { DRILLING_CYCLES, PROFILE, TWO_TOOLS, job, posted } from './golden-jobs';
import { compileDialect } from './dialect';
import { LINUXCNC, LINUXCNC_DIALECT, postLinuxCnc } from './linuxcnc';

// The LinuxCNC post (T5.4c): the fixture jobs every post writes (`golden-jobs.ts`), as golden
// files in `test/linuxcnc/`, checked by the golden runner with `verifyGcode` for this dialect.
// `goldens.test.ts` writes them byte for byte.

describe('linuxcnc post: what each file holds', () => {
  const lines = posted(postLinuxCnc, job(TWO_TOOLS)).files[0]!.lines;

  it('compiles', () => {
    expect(compileDialect(LINUXCNC_DIALECT).ok).toBe(true);
    expect(LINUXCNC.dialect.programDelimiter).toBe(true);
  });

  it('is wrapped in % lines, ends with M30, and sets G91.1, the modes and G64 P', () => {
    expect(lines[0]).toBe('%');
    expect(lines.at(-1)).toBe('%');
    expect(lines.at(-2)).toBe('M30');
    const modes = lines.indexOf('G21 G90 G17 G94');
    expect(modes).toBeGreaterThan(0);
    expect(lines.indexOf('G91.1')).toBeLessThan(modes);
    // The post's tolerance, 0.002 mm, bounds the corner blending.
    expect(lines[modes + 1]).toBe('G64 P0.002');
  });

  it('writes G64 P in inches as the tolerance rounded down', () => {
    const inch = posted(postLinuxCnc, job(PROFILE), { units: 'inch' }).files[0]!.lines;
    // 0.002 mm is 0.0000787 in; P is never over it.
    expect(inch).toContain('G64 P0.000078');
    const coarse = posted(postLinuxCnc, job(PROFILE), { tolerance: 0.01 }).files[0]!.lines;
    expect(coarse).toContain('G64 P0.01');
  });

  it('writes M6 T<n> then G43 H<n> at every tool change, in one file', () => {
    expect(lines.filter((l) => /^M6|^G43/.test(l))).toEqual([
      'M6 T201',
      'G43 H201',
      'M6 T302',
      'G43 H302',
    ]);
    const i = lines.indexOf('M6 T302');
    expect(lines[i - 1]).toBe('(Spindle 24500 rpm, cutting feed 800 mm/min)');
    expect(lines[i + 2]).toBe('G0 Z15');
  });

  it('writes the drill cycles as G81 and G83 when asked', () => {
    const cycles = posted(postLinuxCnc, job(DRILLING_CYCLES), { cannedCycles: true }).files[0]!;
    expect(cycles.lines).toContain('G99 G81 X70 Y35 Z-4 R1 F150');
    expect(cycles.lines).toContain('G99 G83 X10 Y10 Z-8 R1 Q3');
    expect(posted(postLinuxCnc, job(DRILLING_CYCLES)).files[0]!.text).not.toMatch(/G8[13]/);
  });
});
