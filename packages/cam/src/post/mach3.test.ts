import { describe, expect, it } from 'vitest';
import { DRILLING, PROFILE, TWO_TOOLS, TWO_TOOLS_VBIT_2, job, posted } from './golden-jobs';
import { compileDialect } from './dialect';
import { postLinuxCnc } from './linuxcnc';
import { MACH3, MACH3_DIALECT, postMach3 } from './mach3';

// The Mach3 post (T5.4c): the fixture jobs every post writes (`golden-jobs.ts`), as golden
// files in `test/mach3/`, checked by the golden runner with `verifyGcode` for this dialect (with
// Mach3's 0.002 mm arc rule). Mach3's T stops at 255, so its two-tool job numbers the V-bit 2.
// `goldens.test.ts` writes them byte for byte.

describe('mach3 post: what each file holds', () => {
  const lines = posted(postMach3, job(TWO_TOOLS_VBIT_2)).files[0]!.lines;

  it('compiles', () => {
    expect(compileDialect(MACH3_DIALECT).ok).toBe(true);
    expect(MACH3.maxToolNumber).toBe(255);
  });

  it('is wrapped in % lines, sets G91.1, and writes no G64 (Mach3 has no tolerance for it)', () => {
    expect(lines[0]).toBe('%');
    expect(lines.at(-1)).toBe('%');
    expect(lines).toContain('G91.1');
    expect(lines.some((l) => l.startsWith('G64'))).toBe(false);
  });

  it('writes M6 T<n> then G43 H<n>, and refuses a tool number above 255', () => {
    expect(lines.filter((l) => /^M6|^G43/.test(l))).toEqual([
      'M6 T201',
      'G43 H201',
      'M6 T2',
      'G43 H2',
    ]);
    const r = postMach3(job(TWO_TOOLS));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/302.*255/);
  });

  it('writes dwells in seconds', () => {
    expect(posted(postMach3, job(DRILLING)).files[0]!.lines).toContain('G4 P0.5');
  });

  it("keeps every arc within Mach3's radius rule, as lines where it cannot", () => {
    // Mach3 refuses radii more than 0.002 mm (0.0002 in) apart, where Grbl and LinuxCNC allow
    // 0.005 mm or 0.1% of the radius; the post keeps within 0.8 of it, writing lines otherwise.
    // The golden runner checks every Mach3 arc against the rule itself.
    const mach3 = posted(postMach3, job(PROFILE), { units: 'inch' });
    const linuxcnc = posted(postLinuxCnc, job(PROFILE), { units: 'inch' });
    expect(mach3.stats.arcs + mach3.stats.arcsAsLines).toBe(
      linuxcnc.stats.arcs + linuxcnc.stats.arcsAsLines,
    );
    expect(mach3.stats.arcs).toBeLessThanOrEqual(linuxcnc.stats.arcs);
  });
});
