import { describe, expect, it } from 'vitest';
import { DRILLING, DRILLING_CYCLES, TWO_TOOLS, job, posted } from './golden-jobs';
import { compileDialect } from './dialect';
import { GRBL, postGrbl } from './grbl';
import { GRBLHAL, GRBLHAL_DIALECT, postGrblHal } from './grblhal';

// The grblHAL post (T5.4c): the fixture jobs every post writes (`golden-jobs.ts`), as golden
// files in `test/grblhal/`, checked by the golden runner with `verifyGcode` for this dialect. The
// files without M6 also pass the grblHAL Simulator's `grblHAL_validator`
// (`test/firmware-validate.sh`). `goldens.test.ts` writes them byte for byte.

const code = (lines: readonly string[]): string[] => lines.filter((l) => !l.startsWith('('));

describe('grblhal post: the dialect', () => {
  it('compiles: Grbl 1.1 codes plus canned cycles, G43, G98, G99 and M6; no G64', () => {
    expect(compileDialect(GRBLHAL_DIALECT).ok).toBe(true);
    for (const g of GRBL.gCodes) expect(GRBLHAL.gCodes.has(g), g).toBe(true);
    for (const g of ['G43', 'G81', 'G83', 'G98', 'G99'])
      expect(GRBLHAL.gCodes.has(g), g).toBe(true);
    expect(GRBLHAL.mCodes.has('M6')).toBe(true);
    // Path blending is off in a default grblHAL build.
    expect(GRBLHAL.gCodes.has('G64')).toBe(false);
  });
});

describe('grblhal post: tool changes', () => {
  it("writes Grbl's files and pauses by default: the same code lines as the grbl post", () => {
    for (const multiTool of ['files', 'pause'] as const) {
      const hal = posted(postGrblHal, job(TWO_TOOLS), { multiTool });
      const grbl = posted(postGrbl, job(TWO_TOOLS), { multiTool });
      expect(hal.files.map((f) => code(f.lines))).toEqual(grbl.files.map((f) => code(f.lines)));
    }
  });

  it('writes M6 T<n> with multiTool: m6, and G43 H<n> only when asked', () => {
    const m6 = posted(postGrblHal, job(TWO_TOOLS), { multiTool: 'm6' }).files[0]!.lines;
    expect(m6.filter((l) => /^M6|^G43/.test(l))).toEqual(['M6 T201', 'M6 T302']);
    const tlo = posted(postGrblHal, job(TWO_TOOLS), {
      multiTool: 'm6',
      toolLengthOffset: true,
    }).files[0]!.lines;
    expect(tlo.filter((l) => /^M6|^G43/.test(l))).toEqual([
      'M6 T201',
      'G43 H201',
      'M6 T302',
      'G43 H302',
    ]);
    // A length offset without M6 has no tool to name.
    const r = postGrblHal(job(TWO_TOOLS), { toolLengthOffset: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/G43/);
  });
});

describe('grblhal post: canned cycles', () => {
  const lines = posted(postGrblHal, job(DRILLING_CYCLES), { cannedCycles: true }).files[0]!.lines;

  it('writes straight holes as G81 and peck holes as G83, each cancelled by G80', () => {
    expect(lines.filter((l) => /G8\d/.test(l))).toEqual([
      'G99 G81 X70 Y35 Z-4 R1 F150',
      'G80',
      'G99 G81 X90 Y35 Z-4 R1',
      'G80',
      'G99 G81 X110 Y35 Z-4 R1',
      'G80',
      'G99 G83 X10 Y10 Z-8 R1 Q3',
      'G80',
      'G99 G83 X50 Y10 Z-8 R1 Q3',
      'G80',
      'G99 G83 X30 Y30 Z-8 R1 Q3',
      'G80',
    ]);
    // No feed move of the drilling is written: the cycle makes it.
    expect(lines.filter((l) => /^G1|^Z-/.test(l))).toEqual([]);
  });

  it('writes the moves without the option, and a cycle with a dwell always', () => {
    const plain = posted(postGrblHal, job(DRILLING_CYCLES)).files[0]!.text;
    expect(plain).not.toMatch(/G8\d/);
    const dwell = posted(postGrblHal, job(DRILLING), { cannedCycles: true }).files[0]!.text;
    expect(dwell).not.toMatch(/G8\d/);
    expect(dwell).toContain('G4 P0.5');
  });

  it('starts every cycle over its hole on the R plane, and the next move with G0', () => {
    for (const [i, l] of lines.entries()) {
      if (!l.startsWith('G99')) continue;
      const [, x, y] = /X(\S+) Y(\S+)/.exec(l)!;
      // The rapids before it put the tool there (only words that change are written).
      const before = lines.slice(0, i).filter((b) => /^(G0 )?[XYZ]/.test(b));
      expect(before.at(-1)).toBe('Z1');
      expect(lines[i + 1]).toBe('G80');
      expect(code(lines.slice(i + 2))[0]).toMatch(/^G0 /);
      expect(x).toBeDefined();
      expect(y).toBeDefined();
    }
  });
});
