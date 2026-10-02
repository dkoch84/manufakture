import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GRBL, GRBL_DIALECT } from '../src/post/grbl';
import type { Dialect } from '../src/post/dialect';
import {
  DRILL_3,
  FIXTURE_ORIGIN,
  FLAT_201,
  GOLDEN_STOCK,
  SHAPEOKO_5_PRO_4X4_FIXTURE,
  VBIT_302,
} from './gcode-fixtures';
import { verifyGcode } from './verify-gcode';
import type { GcodeReport, VerifyOptions } from './verify-gcode';

// The verifier's own tests (T5.4d): every check fires on a seeded fault, at the right line, and
// stays quiet on the fault's legal neighbour.

const GRBL_DIR = fileURLToPath(new URL('./grbl/', import.meta.url));
const PROFILE = readFileSync(`${GRBL_DIR}profile-tabs.nc`, 'utf8');

const BASE: VerifyOptions = {
  dialect: GRBL,
  stock: GOLDEN_STOCK,
  machine: SHAPEOKO_5_PRO_4X4_FIXTURE,
  origin: FIXTURE_ORIGIN,
  tools: [FLAT_201],
};

function verify(text: string, over: Partial<VerifyOptions> = {}): GcodeReport {
  const r = verifyGcode(text, { ...BASE, ...over });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** The issue codes with their line numbers, as `code@line`. */
function found(report: GcodeReport): string[] {
  return report.issues.map((i) => `${i.code}@${i.line}`);
}

/** The profile golden with `lines` inserted just before its spindle stop (`M5`). */
function seeded(...lines: string[]): { text: string; at: number } {
  const all = PROFILE.split('\n');
  const i = all.indexOf('M5');
  all.splice(i, 0, ...lines);
  return { text: all.join('\n'), at: i + 1 };
}

/** A short program around the given body: header, spindle on at a safe height, footer. */
function program(...body: string[]): string {
  return [
    'G21 G90 G17 G94',
    'G0 Z15',
    'M3 S18000',
    'G0 X10 Y10',
    ...body,
    'G0 Z15',
    'M5',
    'M30',
    '',
  ].join('\n');
}
const BODY_START = 5;

describe('verifyGcode: the seeded faults of the acceptance', () => {
  it('passes the unchanged golden', () => {
    expect(found(verify(PROFILE))).toEqual([]);
  });

  it('catches a move past the machine travel', () => {
    // From the fixture origin at X 100, the travel ends at X 1145.
    const { text, at } = seeded('G0 Z15', 'X1146 Y20');
    expect(found(verify(text))).toEqual([`travel@${at + 1}`]);
    expect(found(verify(seeded('G0 Z15', 'X1145 Y20').text))).toEqual([]);
    // And past the low end: the origin is 100 mm from the left.
    expect(found(verify(seeded('G0 Z15', 'X-101').text))).toEqual([`travel@${at + 1}`]);
    // Z too: the stock top is 60 mm above the lowest Z, 120 mm of travel.
    expect(found(verify(seeded('G0 Z61').text))).toEqual([`travel@${at}`]);
  });

  it('catches a cut below the spoilboard allowance', () => {
    // The stock is 12 mm thick; with a 0.5 mm through-cut allowance the floor is Z -12.5.
    const through = { throughCutAllowance: 0.5 };
    const deep = seeded('G1 Z-12.6 F300');
    expect(found(verify(deep.text, through))).toEqual([`depth@${deep.at}`]);
    expect(found(verify(seeded('G1 Z-12.5 F300').text, through))).toEqual([]);
    // With no allowance, any cut below the stock bottom is one.
    expect(found(verify(seeded('G1 Z-12.1 F300').text))).toEqual([`depth@${deep.at}`]);
  });

  it('catches an M6 in a Grbl file', () => {
    const { text, at } = seeded('M6');
    expect(found(verify(text))).toEqual([`word@${at}`, `tool-change@${at}`]);
    // With a T word, the T is wrong too.
    const t = verify(seeded('M6 T1').text);
    expect(found(t)).toEqual([`word@${at}`, `word@${at}`, `tool-change@${at}`]);
    expect(t.issues[0]!.message).toBe("M6 is not in the dialect's M codes.");
  });

  it('catches an 81-character line, and passes 79 for Grbl', () => {
    const comment = (n: number): string => `(${'x'.repeat(n - 2)})`;
    const { text, at } = seeded(comment(81));
    expect(found(verify(text))).toEqual([`line-length@${at}`]);
    expect(verify(text).issues[0]!.message).toBe("81 characters, over the dialect's 79.");
    expect(found(verify(seeded(comment(80)).text))).toEqual([`line-length@${at}`]);
    expect(found(verify(seeded(comment(79)).text))).toEqual([]);
  });

  it('catches an arc failing the radius rule', () => {
    // From (10, 10) about (15, 10): radius 5 at the start, 5.2 at the end (error 33 in Grbl).
    const bad = verify(program('G1 Z-1 F300', 'G2 X20.2 Y10 I5 J0 F1000'));
    expect(found(bad)).toEqual([`arc-radius@${BODY_START + 1}`]);
    expect(bad.issues[0]!.message).toMatch(/differs from the start's by 0\.2 mm/);
    // 0.004 mm off passes (0.005 mm or 0.1% of the radius is allowed); 0.006 mm fails.
    expect(found(verify(program('G1 Z-1 F300', 'G2 X20.004 Y10 I5 J0 F1000')))).toEqual([]);
    expect(found(verify(program('G1 Z-1 F300', 'G2 X20.006 Y10 I5 J0 F1000')))).toEqual([
      `arc-radius@${BODY_START + 1}`,
    ]);
  });
});

describe('verifyGcode: the other checks', () => {
  it('catches cutting with the spindle off or at 0 rpm', () => {
    const off = program('M5', 'G1 Z-1 F300');
    expect(found(verify(off))).toEqual([`spindle@${BODY_START + 1}`]);
    const zero = program('M3 S0', 'G1 Z-1 F300');
    expect(found(verify(zero))).toEqual([`spindle@${BODY_START + 1}`]);
    // M2 and M30 end the program and stop the spindle.
    for (const end of ['M30', 'M2']) {
      expect(found(verify(program(end, 'G1 Z-1 F300')))).toEqual([`spindle@${BODY_START + 1}`]);
    }
    // A rapid with the spindle off is fine.
    expect(found(verify(program('M5', 'G0 X20', 'M3 S18000')))).toEqual([]);
  });

  it('catches an F that is not positive, and a feed move before any F', () => {
    expect(found(verify(program('G1 Z-1 F0')))).toEqual([
      `feed@${BODY_START}`,
      `feed@${BODY_START}`,
    ]);
    expect(found(verify(program('G1 Z-1')))).toEqual([`feed@${BODY_START}`]);
  });

  it('catches words outside the dialect, repeated letters and long numbers', () => {
    expect(found(verify(program('G64 P0.01')))).toEqual([`word@${BODY_START}`]);
    expect(found(verify(program('G81 X1 Y1 Z-1')))).toEqual([`word@${BODY_START}`]);
    expect(found(verify(program('G0 X1 X2')))).toEqual([`word@${BODY_START}`]);
    expect(found(verify(program('G0 X1 R2')))).toEqual([`word@${BODY_START}`]);
    expect(found(verify(program('G0 X1.12345678')))).toEqual([`number@${BODY_START}`]);
    expect(found(verify(program('G0 X1 = 2')))).toEqual([`syntax@${BODY_START}`]);
    expect(found(verify(program('G91')))).toEqual([`unsupported@${BODY_START}`]);
  });

  it('reports every G code it does not model as unsupported, even when the dialect has it', () => {
    // All of these are in Grbl's list, so only the verifier's own set catches them.
    for (const code of [
      'G28',
      'G30',
      'G53 G0 X0',
      'G93',
      'G18',
      'G19',
      'G10 L20 P1 X0',
      'G43.1 Z1',
      'G38.2 Z-5 F100',
      'G92 X0',
      'G92.1',
      'G55',
    ]) {
      const r = verify(program(code), { dialect: GRBL });
      expect(
        found(r).filter((f) => f.startsWith('unsupported')),
        code,
      ).toEqual([`unsupported@${BODY_START}`]);
    }
    // The modelled ones, as the engine writes them, pass.
    expect(found(verify(program('G54 G17 G90 G91.1 G94', 'G4 P0.5')))).toEqual([]);
  });

  it('catches bad comments and characters', () => {
    // The first ) closes the comment, so the rest is neither a comment nor words.
    expect(found(verify(program('(a (nested) comment)')))).toEqual([
      `comment@${BODY_START}`,
      `comment@${BODY_START}`,
      `syntax@${BODY_START}`,
    ]);
    expect(found(verify(program('G0 X1 ; note')))).toEqual([`comment@${BODY_START}`]);
    expect(found(verify(program('(MSG, hello)')))).toEqual([`comment@${BODY_START}`]);
    expect(found(verify(program('(what?)')))).toEqual([`character@${BODY_START}`]);
    expect(found(verify(program('(café)')))).toEqual([`character@${BODY_START}`]);
    expect(found(verify(program('%')))).toEqual([`syntax@${BODY_START}`]);
    // An inline comment between words is read as a comment, not as text.
    expect(found(verify(program('G0 X1 (move) Y2')))).toEqual([]);
  });

  it('checks tool changes in the dialect style', () => {
    // An M0 in a one-tool-per-file Grbl file, and a T word.
    expect(found(verify(program('G0 Z15', 'M5', 'M0', 'M3 S18000')))).toEqual([
      `tool-change@${BODY_START + 2}`,
    ]);
    expect(found(verify(program('T1')))).toEqual([
      `word@${BODY_START}`,
      `tool-change@${BODY_START}`,
    ]);
    // As an m0-pause file: the M0 is a change to the next tool, with the spindle off.
    const pause = { toolChange: 'm0-pause' as const, tools: [FLAT_201, VBIT_302] };
    const ok = verify(program('G0 Z15', 'M5', 'M0', 'M3 S24500'), pause);
    expect(found(ok)).toEqual([]);
    expect(ok.toolChanges).toBe(1);
    expect(found(verify(program('G0 Z15', 'M0', 'M3 S24500'), pause))).toEqual([
      `tool-change@${BODY_START + 1}`,
    ]);
    expect(found(verify(program('G0 Z15', 'M5', 'M0', 'M3 S1', 'M5', 'M0'), pause))).toEqual([
      `tool-change@${BODY_START + 5}`,
    ]);
  });

  it('checks M6 tool changes in an m6 dialect', () => {
    const m6: Dialect = {
      ...GRBL_DIALECT,
      id: 'grbl-m6',
      mCodes: [...GRBL_DIALECT.mCodes, 'M6'],
      toolChange: 'm6',
    };
    const options = { dialect: m6, tools: [FLAT_201, DRILL_3] };
    const text = (...change: string[]): string =>
      [
        'G21 G90 G17 G94',
        'G0 Z15',
        ...change,
        'M3 S18000',
        'G0 X10 Y10',
        'G1 Z-1 F300',
        'G0 Z15',
        'M5',
        'M30',
      ].join('\n');
    const good = verify(text('M6 T201'), options);
    expect(found(good)).toEqual([]);
    expect(good.toolChanges).toBe(1);
    // The 1/4" tool is active: a cut 3.175 mm beyond the stock edge is inside the grown outline.
    expect(found(verify(text('M6 T201').replace('X10 Y10', 'X-8.175 Y10'), options))).toEqual([]);
    expect(found(verify(text('M6 T3').replace('X10 Y10', 'X-8.175 Y10'), options))).toEqual([
      'stock@6',
    ]);
    expect(found(verify(text('M6'), options))).toEqual(['tool-change@3']);
    expect(found(verify(text('M6 T7'), options))).toEqual(['tool-change@3']);
    expect(found(verify(text('M6 T300'), options))).toEqual(['tool-change@3', 'tool-change@3']);
    expect(found(verify(text('M3 S1000', 'M6 T201'), options))).toEqual(['tool-change@4']);
  });

  it('keeps feed moves inside the stock grown by the tool radius and the lead-in allowance', () => {
    // The stock starts at X -5; the 1/4" tool's centre may go to -8.175.
    expect(found(verify(program('G1 Z-1 F300', 'X-8.175')))).toEqual([]);
    expect(found(verify(program('G1 Z-1 F300', 'X-8.2')))).toEqual([`stock@${BODY_START + 1}`]);
    expect(found(verify(program('G1 Z-1 F300', 'X-10.175'), { leadInAllowance: 2 }))).toEqual([]);
    // Above the stock top, a feed move is in the air.
    expect(found(verify(program('G1 Z1 F300', 'X-30')))).toEqual([]);
    // Arcs by their true extremes: from (-5, 10) clockwise about (-4, 12) to (-5, 14), the arc
    // bulges left to X -4 - sqrt(5), inside -8.175; from (-7, 10) about (-6, 12) it reaches
    // -8.236, outside, though both ends are inside.
    expect(found(verify(program('G1 Z-1 F300', 'X-5', 'G2 Y14 I1 J2')))).toEqual([]);
    expect(found(verify(program('G1 Z-1 F300', 'X-7', 'G2 Y14 I1 J2')))).toEqual([
      `stock@${BODY_START + 2}`,
    ]);
    const ext = verify(program('G1 Z-1 F300', 'X-5', 'G2 Y14 I1 J2')).cuttingExtents!;
    expect(ext.min[0]).toBeCloseTo(-4 - Math.sqrt(5), 9);
  });

  it('checks full circles against the dialect', () => {
    const full = program('G1 Z-1 F300', 'G2 X10 Y10 I5 J0');
    expect(found(verify(full))).toEqual([`full-circle@${BODY_START + 1}`]);
    const single = { ...GRBL_DIALECT, id: 'grbl-single', fullCircles: 'single' as const };
    const r = verify(full, { dialect: single });
    expect(found(r)).toEqual([]);
    // The circle's extremes: X 10 to 20, Y 5 to 15; the plunge starts at Z 15.
    expect(r.cuttingExtents).toEqual({ min: [10, 5, -1], max: [20, 15, 15] });
  });

  it('catches an arc whose angular travel is not its geometry', () => {
    // A zero radius: the radius rule passes (both radii within 0.005 mm), but Grbl turns the
    // zero travel into a full turn.
    expect(found(verify(program('G1 Z-1 F300', 'G2 X10.003 Y10 I0 J0')))).toEqual([
      `arc-travel@${BODY_START + 1}`,
    ]);
  });

  it('catches an arc from an unknown position, and an arc without I or J', () => {
    const noStart = ['G21 G90', 'M3 S18000', 'G2 X1 Y1 I1 J0 F100', 'M5'].join('\n');
    expect(found(verify(noStart))).toEqual(['arc@3']);
    // With a start position the arc is checked from it: a quarter circle from (0, 0) about
    // (1, 0) passes, one from (0, 0.1) fails the radius rule.
    expect(found(verify(noStart, { start: [0, 0, 0] }))).toEqual([]);
    expect(found(verify(noStart, { start: [0, 0.1, 0] }))).toEqual(['arc-radius@3']);
    expect(found(verify(program('G1 Z-1 F300', 'G2 X12 Y12')))).toEqual([`arc@${BODY_START + 1}`]);
  });

  it('checks the span on each axis when no origin is given', () => {
    const noOrigin: VerifyOptions = { ...BASE };
    delete (noOrigin as { origin?: unknown }).origin;
    const span = (...body: string[]): string[] => {
      const r = verifyGcode(program(...body), noOrigin);
      if (!r.ok) throw new Error(r.error.message);
      return found(r.value);
    };
    // 1300 mm in X is over the fixture's 1245 mm, wherever the origin is; 1200 mm is not.
    expect(span('G0 X1000', 'X-300')).toEqual([`travel@${BODY_START + 1}`]);
    expect(span('G0 X1000', 'X-200')).toEqual([]);
  });

  it('converts inch files, and checks inch arcs at their written precision', () => {
    const inch = [
      'G20 G90 G17 G94',
      'G0 Z0.5',
      'M3 S18000',
      'G0 X1 Y1',
      'G1 Z-0.04 F40',
      'G2 X2 Y1 I0.5 J0',
      'G0 Z0.5',
      'M5',
      'M30',
    ].join('\n');
    const r = verify(inch);
    expect(found(r)).toEqual([]);
    expect(r.units).toBe('inch');
    expect(r.cuttingExtents!.max[0]).toBeCloseTo(50.8, 9);
    expect(r.cuttingExtents!.max[1]).toBeCloseTo(38.1, 9);
    // On a 12.7 mm radius Grbl allows 0.1%, 0.0127 mm: 0.0004 inch (0.0102 mm) off passes,
    // 0.0006 inch (0.0152 mm) fails.
    expect(found(verify(inch.replace('X2 Y1', 'X2.0004 Y1')))).toEqual([]);
    expect(found(verify(inch.replace('X2 Y1', 'X2.0006 Y1')))).toEqual(['arc-radius@6']);
  });

  it('refuses bad options', () => {
    const bad = (over: Partial<VerifyOptions>): boolean =>
      verifyGcode(PROFILE, { ...BASE, ...over }).ok;
    expect(bad({ dialect: { ...GRBL_DIALECT, toolChange: 'm6' } })).toBe(false);
    expect(bad({ machine: { travel: [0, 100, 100] } })).toBe(false);
    expect(bad({ stock: { min: [0, 0, 0], max: [-1, 1, 1] } })).toBe(false);
    expect(bad({ tools: [] })).toBe(false);
    expect(bad({ throughCutAllowance: -1 })).toBe(false);
  });
});
