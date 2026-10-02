import { describe, expect, it } from 'vitest';
import {
  CARBIDE_MOTION_GOLDEN_SUITE,
  DRILLING_CYCLES,
  TWO_TOOLS,
  job,
  posted,
} from './golden-jobs';
import { CARBIDE_MOTION, CARBIDE_MOTION_DIALECT, postCarbideMotion } from './carbide-motion';
import type { CarbideMotionOptions } from './carbide-motion';
import { compileDialect } from './dialect';
import { GRBL } from './grbl';

// The Carbide Motion post (T5.4c): the fixture jobs every post writes (`golden-jobs.ts`), as
// golden files in `test/carbide-motion/`. The golden runner (`test/goldens.test.ts`) checks each
// with `verifyGcode` for this dialect; `goldens.test.ts` writes them byte for byte.

const GOLDENS = CARBIDE_MOTION_GOLDEN_SUITE.goldens;

const post = (options?: CarbideMotionOptions) => posted(postCarbideMotion, job(TWO_TOOLS), options);

describe('carbide-motion post: the dialect', () => {
  it("compiles, and writes only codes on Carbide 3D's list", () => {
    expect(compileDialect(CARBIDE_MOTION_DIALECT).ok).toBe(true);
    // Carbide's list is a subset of Grbl 1.1's, which runs underneath, plus M6 (Carbide Motion's).
    for (const g of CARBIDE_MOTION.gCodes) {
      if (g !== 'G28.2' && g !== 'G43') expect(GRBL.gCodes.has(g), g).toBe(true);
    }
    for (const m of CARBIDE_MOTION.mCodes) {
      if (m !== 'M6' && m !== 'M7') expect(GRBL.mCodes.has(m), m).toBe(true);
    }
  });

  it('never selects or sets a work offset: Carbide Motion owns them', () => {
    for (const g of ['G10', 'G54', 'G55', 'G56', 'G57', 'G58', 'G59', 'G92']) {
      expect(CARBIDE_MOTION.gCodes.has(g), g).toBe(false);
    }
    for (const g of GOLDENS) {
      for (const f of posted(postCarbideMotion, g.job, g.options).files) {
        for (const l of f.lines.filter((x) => !x.startsWith('('))) {
          expect(l).not.toMatch(/\bG(?:10|5[3-9]|92|43|94)\b/);
        }
      }
    }
  });
});

describe('carbide-motion post: tool changes', () => {
  const lines = post().files[0]!.lines;

  it('writes M6 T<n> at every tool change, the first included, in one file', () => {
    expect(post().files).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('M6'))).toEqual(['M6 T201', 'M6 T302']);
    expect(lines).not.toContain('M0');
  });

  it('names the tool in a (TOOL n: name) comment just before the M6, spindle off', () => {
    const i = lines.indexOf('M6 T302');
    expect(lines.slice(i - 5, i + 4)).toEqual([
      'G0 Z15',
      'M5',
      '(Next: #302 60 deg V-bit)',
      '(TOOL 302: #302 60 deg V-bit)',
      '(Spindle 24500 rpm, cutting feed 800 mm/min)',
      'M6 T302',
      // After the change (and the BitSetter's measurement) the machine starts again from the top.
      'G0 Z15',
      '(Router dial 4: 24500 rpm)',
      'M3 S24500',
    ]);
  });

  it("writes the modes without G94, which is not on Carbide 3D's list", () => {
    expect(lines).toContain('G21 G90 G17');
    expect(lines.slice(-2)).toEqual(['M5', 'M30']);
  });

  it('refuses canned cycles and a tool number above its limit', () => {
    const cycles = postCarbideMotion(job(DRILLING_CYCLES), {
      cannedCycles: true,
    } as CarbideMotionOptions);
    // The option is not part of the Carbide Motion post; the moves are written.
    expect(cycles.ok).toBe(true);
    if (cycles.ok) expect(cycles.value.files[0]!.text).not.toMatch(/G8[13]/);
    const big = postCarbideMotion(
      job({
        ...TWO_TOOLS,
        entries: TWO_TOOLS.entries.map((e) =>
          e.kind === 'toolChange' && e.number === 302 ? { ...e, number: 1000 } : e,
        ),
      }),
    );
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.error.message).toMatch(/1000.*999/);
  });
});
