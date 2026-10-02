import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Toolpath from 'gcode-toolpath';
import { describe, expect, it } from 'vitest';
import { COMPACT_ROUTER_DIAL } from '../library/machines';
import type { IrEntry, ToolChange } from '../ir';
import {
  CLEARANCE,
  DRILLING,
  DRILLING_CYCLES,
  FLAT,
  H,
  POCKET,
  PROFILE,
  R,
  TWO_TOOLS,
  VBIT,
  job,
  profileOp,
  toolpath,
  vcarveOp,
} from './golden-jobs';
import { compileDialect, normalizeCode } from './dialect';
import { GRBL, GRBL_DIALECT, postGrbl } from './grbl';
import type { GrblOptions } from './grbl';
import { FALLBACK_FILE_STEM, GCODE_FILE_EXTENSION, postFileStem } from './naming';
import type { PostJob, PostOutput } from './writer';

// The GRBL post (T5.4b): golden G-code for fixture jobs written as hand-made IR, so the post does
// not wait for the operations. The goldens live in `packages/cam/test/grbl/`; after a deliberate
// change, rewrite them with `UPDATE_GOLDENS=1` and review the diff line by line. Every golden is
// also checked word by word against what Grbl 1.1 accepts (a whitelist until the T5.4d checker
// lands) and read back with `gcode-toolpath`, a parser we did not write.

const GOLDEN_DIR = fileURLToPath(new URL('../../test/grbl/', import.meta.url));
const UPDATE = process.env.UPDATE_GOLDENS === '1';

// The fixture jobs are shared with the other posts' tests (`golden-jobs.ts`).

function post(j: PostJob, options: GrblOptions = {}): PostOutput {
  const r = postGrbl(j, options);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

// ---------------------------------------------------------------------------------------------
// Goldens

interface Golden {
  readonly name: string;
  readonly job: PostJob;
  readonly options?: GrblOptions;
  readonly files: number;
}

const GOLDENS: readonly Golden[] = [
  { name: 'profile-tabs', job: job(PROFILE), files: 1 },
  { name: 'profile-tabs-inch', job: job(PROFILE), options: { units: 'inch' }, files: 1 },
  // No dial table: the spindle line has no router comment.
  { name: 'pocket', job: job(POCKET, {}, false), files: 1 },
  { name: 'drilling', job: job(DRILLING), files: 1 },
  // Grbl has no canned cycles: the cycle markers are skipped and the moves written.
  { name: 'drilling-cycles', job: job(DRILLING_CYCLES), files: 1 },
  { name: 'two-tools-files', job: job(TWO_TOOLS), files: 2 },
  { name: 'two-tools-pause', job: job(TWO_TOOLS), options: { multiTool: 'pause' }, files: 1 },
];

function goldenPath(name: string, index: number, count: number): string {
  const suffix = count > 1 ? `-${index}` : '';
  return `${GOLDEN_DIR}${name}${suffix}.${GCODE_FILE_EXTENSION}`;
}

describe('grbl post: golden files', () => {
  for (const g of GOLDENS) {
    it(`writes ${g.name} byte for byte`, () => {
      const out = post(g.job, g.options);
      expect(out.files).toHaveLength(g.files);
      for (const f of out.files) {
        const path = goldenPath(g.name, f.index, out.files.length);
        if (UPDATE) {
          mkdirSync(GOLDEN_DIR, { recursive: true });
          writeFileSync(path, f.text);
        }
        expect(existsSync(path), `${path} is missing: run with UPDATE_GOLDENS=1`).toBe(true);
        expect(f.text).toBe(readFileSync(path, 'utf8'));
      }
    });

    it(`writes ${g.name} with only words Grbl 1.1 accepts`, () => {
      for (const f of post(g.job, g.options).files) {
        expect(grblProblems(f.lines)).toEqual([]);
      }
    });

    it(`writes ${g.name} so a parser we did not write finds it inside the job`, () => {
      for (const f of post(g.job, g.options).files) {
        const moves = parse(f.text);
        expect(moves.length).toBeGreaterThan(0);
        for (const m of moves) {
          for (const p of [m.start, m.end]) {
            // Inside the fixtures' extent with the tool radius, never above the clearance, never
            // below the deepest cut (the drill's 8 mm); within the inch rounding.
            expect(p.x).toBeGreaterThanOrEqual(-R - 0.01);
            expect(p.x).toBeLessThanOrEqual(120 + 0.01);
            expect(p.y).toBeGreaterThanOrEqual(-R - 0.01);
            expect(p.y).toBeLessThanOrEqual(H + R + 0.01);
            expect(p.z).toBeGreaterThanOrEqual(-8 - 0.01);
            expect(p.z).toBeLessThanOrEqual(CLEARANCE + 0.01);
          }
          // A rapid never comes down while it moves across.
          if (m.motion === 'G0' && m.end.z < m.start.z - 1e-9) {
            expect(Math.hypot(m.end.x - m.start.x, m.end.y - m.start.y)).toBeLessThan(1e-9);
          }
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Grbl's word list, written from Grbl 1.1's `gcode.c`, independently of the dialect record

/** Modal groups as `gcode.c` assigns them; two of one group on a line fail with error 21. */
const GRBL_GROUPS: Readonly<Record<string, string>> = {
  G4: 'non-modal',
  G10: 'non-modal',
  G28: 'non-modal',
  'G28.1': 'non-modal',
  G30: 'non-modal',
  'G30.1': 'non-modal',
  G53: 'non-modal',
  G92: 'non-modal',
  'G92.1': 'non-modal',
  G0: 'motion',
  G1: 'motion',
  G2: 'motion',
  G3: 'motion',
  'G38.2': 'motion',
  'G38.3': 'motion',
  'G38.4': 'motion',
  'G38.5': 'motion',
  G80: 'motion',
  G17: 'plane',
  G18: 'plane',
  G19: 'plane',
  G90: 'distance',
  G91: 'distance',
  'G91.1': 'arc distance',
  G93: 'feed mode',
  G94: 'feed mode',
  G20: 'units',
  G21: 'units',
  G40: 'cutter compensation',
  'G43.1': 'tool length',
  G49: 'tool length',
  G54: 'wcs',
  G55: 'wcs',
  G56: 'wcs',
  G57: 'wcs',
  G58: 'wcs',
  G59: 'wcs',
  G61: 'control',
  M0: 'stopping',
  M1: 'stopping',
  M2: 'stopping',
  M30: 'stopping',
  M3: 'spindle',
  M4: 'spindle',
  M5: 'spindle',
  M8: 'coolant',
  M9: 'coolant',
};

/** The letters the post may write; Grbl also takes N, L, R and T, which it never needs. */
const LETTERS = new Set(['G', 'M', 'X', 'Y', 'Z', 'I', 'J', 'F', 'S', 'P']);

/** Every reason a Grbl 1.1 controller would refuse or misread a line, as `line n: why`. */
function grblProblems(lines: readonly string[]): string[] {
  const problems: string[] = [];
  let motion: string | undefined;
  for (const [n, line] of lines.entries()) {
    const bad = (why: string): void => void problems.push(`line ${n + 1} '${line}': ${why}`);
    if (line.length > 79) bad('over 79 characters (error 11)');
    if (/[^\x20-\x7e]/.test(line)) bad('not printable ASCII');
    if (/[?!~]/.test(line)) bad('a real-time command character');
    if (line.startsWith('(')) {
      if (!line.endsWith(')') || /[()]/.test(line.slice(1, -1))) bad('a malformed comment');
      continue;
    }
    if (/[();%]/.test(line)) bad('a comment, ; or % on a code line');
    const groups = new Set<string>();
    const letters = new Set<string>();
    let axes = false;
    for (const token of line.split(' ')) {
      const m = /^([A-Z])(-?)(\d*)(?:\.(\d+))?$/.exec(token);
      if (!m || (m[3] === '' && m[4] === undefined)) {
        bad(`'${token}' is not a word`);
        continue;
      }
      const letter = m[1]!;
      // read_float: at most 8 significant digits are read; more are dropped silently.
      if ((m[3]! + (m[4] ?? '')).replace(/^0+/, '').length > 8) bad(`${token}: over 8 digits`);
      if (!LETTERS.has(letter)) bad(`the ${letter} word`);
      if (letter === 'G' || letter === 'M') {
        const code = normalizeCode(token, letter);
        const group = code === undefined ? undefined : GRBL_GROUPS[code];
        if (code === undefined || group === undefined) {
          bad(`${token} is not a Grbl 1.1 code`);
          continue;
        }
        if (groups.has(group)) bad(`two ${group} codes (error 21)`);
        groups.add(group);
        if (group === 'motion') motion = code;
      } else {
        if (letters.has(letter)) bad(`two ${letter} words (error 25)`);
        letters.add(letter);
        if ('XYZ'.includes(letter)) axes = true;
      }
    }
    const words = line.split(' ');
    if (letters.has('S') && !words.some((w) => w === 'M3' || w === 'M4')) bad('S without M3');
    if (letters.has('P') && !words.includes('G4')) bad('P without G4');
    if (words.includes('G4') && !letters.has('P')) bad('G4 without P');
    if (letters.has('F') && !(Number(words.find((w) => w.startsWith('F'))!.slice(1)) > 0)) {
      bad('F not positive');
    }
    if ((letters.has('I') || letters.has('J')) && motion !== 'G2' && motion !== 'G3') {
      bad('I or J outside an arc');
    }
    if ((motion === 'G2' || motion === 'G3') && axes && !(letters.has('I') && letters.has('J'))) {
      bad('an arc without I and J');
    }
  }
  return problems;
}

describe('grbl post: the word whitelist itself', () => {
  it('catches what Grbl would refuse', () => {
    const bad = [
      'M6',
      'T5',
      'G64 P0.01',
      'G81 X1 Y1 Z-1 R1',
      'G21 G21',
      'G0 G1 X1',
      'X1 X2',
      'G4',
      'S1000',
      'G1 X1 F0',
      'G1 X1.123456789',
      'G1 X1 (inline)',
      '(a (nested) comment)',
      'G1 X1 ; note',
      `(${'x'.repeat(80)})`,
      '(what?)',
    ];
    for (const line of bad) expect(grblProblems([line]), line).not.toEqual([]);
    expect(grblProblems(['G21 G90 G17 G94', 'G0 Z15', 'M3 S18000', 'G2 X1 Y1 I1 J0 F100'])).toEqual(
      [],
    );
  });
});

interface Point {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Every move `gcode-toolpath` reports, in millimetres. */
function parse(text: string): { motion: string; start: Point; end: Point }[] {
  const out: { motion: string; start: Point; end: Point }[] = [];
  const reader = new Toolpath({
    // The machine starts above the job; the file's first line moves Z only.
    position: { x: 0, y: 0, z: CLEARANCE },
    addLine: (modal, start, end) => out.push({ motion: modal.motion, start, end }),
    addArcCurve: (modal, start, end) => out.push({ motion: modal.motion, start, end }),
  });
  reader.loadFromStringSync(text);
  return out;
}

// ---------------------------------------------------------------------------------------------
// The post's rules

describe('grbl post: the dialect', () => {
  it('compiles, and its words are all Grbl 1.1 codes', () => {
    expect(compileDialect(GRBL_DIALECT).ok).toBe(true);
    for (const code of [...GRBL_DIALECT.gCodes, ...GRBL_DIALECT.mCodes]) {
      expect(GRBL_GROUPS[code], code).toBeDefined();
    }
    expect(GRBL.maxToolNumber).toBe(255);
  });

  it('has no M6, no G64 and no canned cycles', () => {
    expect(GRBL.mCodes.has('M6')).toBe(false);
    expect(GRBL.gCodes.has('G64')).toBe(false);
    for (const code of ['G73', 'G81', 'G82', 'G83', 'G85', 'G86', 'G89']) {
      expect(GRBL.gCodes.has(code)).toBe(false);
    }
    expect(GRBL_DIALECT.cannedCycles).toBe(false);
    // A G64 template is refused, so a user post based on it cannot add one by accident.
    const g64 = {
      ...GRBL_DIALECT,
      templates: { ...GRBL_DIALECT.templates, header: ['G64 P0.01'] },
    };
    expect(compileDialect(g64).ok).toBe(false);
  });

  it('refuses the m6 style, since Grbl has no M6', () => {
    const r = postGrbl(job(PROFILE), { multiTool: 'pause' });
    expect(r.ok).toBe(true);
    const m6 = { ...GRBL_DIALECT, toolChange: 'm6' as const };
    expect(compileDialect(m6).ok).toBe(false);
  });
});

describe('grbl post: what each file holds', () => {
  const [file] = post(job(PROFILE)).files;
  const lines = file!.lines;

  it('starts with the comment block and then G21 G90 G17 G94, ends with M5 and M30', () => {
    expect(lines.slice(0, 8)).toEqual([
      '(Job: Plywood sign)',
      '(Setup: Top)',
      '(Posted 2026-10-02 for Grbl 1.1, mm, file 1 of 1)',
      '(Zero X, Y and Z at: stock top, front left corner)',
      '(Tools in this file: 1)',
      '(Tool 201: #201 1/4" flat end mill, diameter 6.35 mm)',
      'G21 G90 G17 G94',
      '(Tool 201: #201 1/4" flat end mill)',
    ]);
    expect(lines.slice(-3)).toEqual(['G0 Z15', 'M5', 'M30']);
  });

  it('writes G20 and inch words with units: inch', () => {
    const inch = post(job(PROFILE), { units: 'inch' }).files[0]!.lines;
    expect(inch).toContain('G20 G90 G17 G94');
    expect(inch).not.toContain('G21 G90 G17 G94');
    expect(inch).toContain('(Spindle 18000 rpm, cutting feed 39.4 inch/min)');
  });

  it('writes M3 S<rpm> with the router dial setting in a comment just before it', () => {
    const i = lines.indexOf('M3 S18000');
    expect(i).toBeGreaterThan(0);
    expect(lines[i - 1]).toBe('(Router dial 3: 18250 rpm, nearest to 18000 rpm)');
    expect(lines[i - 2]).toBe('G0 Z15');
    const exact = post(job(PROFILE, { spindleDial: [{ setting: '3', rpm: 18000 }] })).files[0]!;
    expect(exact.lines).toContain('(Router dial 3: 18000 rpm)');
  });

  it('never writes M6, a T word or a G64', () => {
    for (const g of GOLDENS) {
      for (const f of post(g.job, g.options).files) {
        for (const l of f.lines.filter((x) => !x.startsWith('('))) {
          expect(l).not.toMatch(/\bM0?6\b|\bT\d|\bG64\b/);
        }
      }
    }
  });

  it('tells the operator everything before the M0, goes up before across, never climbs', () => {
    const pause = post(job(TWO_TOOLS), { multiTool: 'pause' }).files[0]!.lines;
    const i = pause.indexOf('M0');
    expect(pause.slice(i - 8, i + 7)).toEqual([
      'G0 Z15',
      'M5',
      '(Next: #302 60 deg V-bit)',
      '(Tool 302: #302 60 deg V-bit)',
      '(Spindle 24500 rpm, cutting feed 800 mm/min)',
      // The next tool's dial setting and what to do, while the machine waits.
      '(Router dial 4: 24500 rpm)',
      '(Pause: turn the router off, change the bit, re-zero Z or keep the same)',
      '(stick-out, set the dial, turn the router on, then resume)',
      'M0',
      'G0 Z15',
      '(Router dial 4: 24500 rpm)',
      'M3 S24500',
      '(V-carve: line and arc, 1 mm deep)',
      'X10 Y20',
      'Z5',
    ]);
  });
});

describe('grbl post: several tools', () => {
  it('writes one file per tool by default, each complete', () => {
    const out = post(job(TWO_TOOLS));
    expect(out.files.map((f) => f.tools)).toEqual([['tool#1'], ['tool#2']]);
    for (const f of out.files) {
      expect(f.lines).toContain('G21 G90 G17 G94');
      expect(f.lines.slice(-3)).toEqual(['G0 Z15', 'M5', 'M30']);
      expect(f.lines).not.toContain('M0');
    }
    expect(out.files[1]!.lines[2]).toBe('(Posted 2026-10-02 for Grbl 1.1, mm, file 2 of 2)');
  });

  it('writes one file with an M0 pause per change with multiTool: pause', () => {
    const out = post(job(TWO_TOOLS), { multiTool: 'pause' });
    expect(out.files).toHaveLength(1);
    expect(out.files[0]!.lines.filter((l) => l === 'M0')).toHaveLength(1);
    expect(out.files[0]!.tools).toEqual(['tool#1', 'tool#2']);
  });

  it('names the files by job, setup, order and tool', () => {
    const j = job(TWO_TOOLS);
    const out = post(j);
    expect(out.files.map((f) => postFileStem(j, f, out.files.length))).toEqual([
      'Plywood sign - Top - 1 of 2 - #201 1/4" flat end mill',
      'Plywood sign - Top - 2 of 2 - #302 60 deg V-bit',
    ]);
    const one = post(job(PROFILE));
    expect(postFileStem(job(PROFILE), one.files[0]!, 1)).toBe('Plywood sign - Top');
    expect(GCODE_FILE_EXTENSION).toBe('nc');
  });

  it('falls back to a stem for empty names and escapes Windows device names', () => {
    const file = post(job(PROFILE)).files[0]!;
    const stem = (name: string, setup?: string): string =>
      postFileStem(
        { toolpath: PROFILE, job: name, ...(setup !== undefined ? { setup } : {}) },
        file,
        1,
      );
    expect(stem('')).toBe(FALLBACK_FILE_STEM);
    expect(stem('   ', '  ')).toBe(FALLBACK_FILE_STEM);
    expect(stem('', 'Top')).toBe('Top');
    for (const name of ['CON', 'con', 'Prn', 'AUX', 'nul', 'COM1', 'com9', 'LPT1', 'lpt9']) {
      expect(stem(name)).toBe(`_${name}`);
    }
    expect(stem('nul.tar')).toBe('_nul.tar');
    expect(stem('CON ', '')).toBe('_CON');
    expect(stem('CON', 'Top')).toBe('CON - Top');
    expect(stem('COM10')).toBe('COM10');
    expect(stem('Console')).toBe('Console');
  });
});

describe('grbl post: hostile names', () => {
  it('keeps every line a comment or a whitelisted code line, whatever the names hold', () => {
    const hostile = 'x\r\n$H\r\nM3 S30000\n) G0 Z-50 (!~?%\r$X';
    const named = (change: ToolChange): ToolChange => ({ ...change, name: `${hostile} tool` });
    const tp = toolpath([named(FLAT), 18000, profileOp], [named(VBIT), 24500, vcarveOp]);
    const j = job(tp, {
      job: hostile,
      setup: hostile,
      date: hostile,
      origin: hostile,
      spindleDial: COMPACT_ROUTER_DIAL.map((d) => ({ ...d, setting: `${hostile}${d.setting}` })),
    });
    for (const multiTool of ['files', 'pause'] as const) {
      for (const f of post(j, { multiTool }).files) {
        expect(grblProblems(f.lines)).toEqual([]);
        expect(f.text).not.toMatch(/\r/);
        for (const line of f.lines) {
          expect(line).not.toMatch(/[\r\n$%!~?]/);
          // A code line is never built from a name: only engine words appear outside comments.
          if (!line.startsWith('(')) expect(line).toMatch(/^(?:[GMXYZIJFSP]-?[\d.]+ ?)+$/);
        }
        // Exactly the code lines of the same job with plain names.
        const plain = post(job(toolpath([FLAT, 18000, profileOp], [VBIT, 24500, vcarveOp])), {
          multiTool,
        }).files[f.index - 1]!.lines.filter((l) => !l.startsWith('('));
        expect(f.lines.filter((l) => !l.startsWith('('))).toEqual(plain);
      }
    }
  });
});

describe('grbl post: refusals', () => {
  it('refuses a bad spindle dial', () => {
    for (const spindleDial of [[], [{ setting: '', rpm: 1000 }], [{ setting: '1', rpm: 0 }]]) {
      const r = postGrbl(job(PROFILE, { spindleDial }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/spindle dial/);
    }
  });

  it('refuses a feed move straight after a tool change (the tool is at the clearance)', () => {
    const entries: IrEntry[] = [
      { ...FLAT },
      { kind: 'spindle', state: 'cw', rpm: 18000 },
      { kind: 'linear', to: [0, 0, -1], feed: 300, feedClass: 'plunge', op: 'x', pass: 0 },
    ];
    const r = postGrbl(job({ start: [0, 0, CLEARANCE], entries }));
    expect(r.ok).toBe(false);
  });
});
