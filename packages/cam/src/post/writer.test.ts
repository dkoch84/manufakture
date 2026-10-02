import { describe, expect, it } from 'vitest';
import type { ArcMove, IrEntry, ToolChange, Toolpath } from '../ir';
import { sampleToolpath } from '../test-helpers';
import type { Vec3 } from '../types';
import { compileDialect, isCompiledDialect } from './dialect';
import type { CompiledDialect, Dialect } from './dialect';
import { testDialect } from './test-helpers';
import { postProcess } from './writer';
import type { PostJob, PostOptions, PostOutput } from './writer';

const op = 'profile#1';

/** A dialect with no comment templates, so expected texts stay short. */
function plain(over: Partial<Dialect> = {}): Dialect {
  return testDialect({
    templates: { header: [], tool: [], toolChange: [], footer: ['M30'] },
    ...over,
  });
}

const START: IrEntry[] = [
  { kind: 'toolChange', tool: 'tool#1', number: 1, name: '6mm flat', diameter: 6, op },
  { kind: 'spindle', state: 'cw', rpm: 16000, op },
  { kind: 'rapid', to: [10, 0, 5], op, pass: 0 },
  { kind: 'linear', to: [10, 0, -1], feed: 300, feedClass: 'plunge', op, pass: 0 },
];
const END: IrEntry[] = [
  { kind: 'rapid', to: [0, 0, 10], op, pass: 0 },
  { kind: 'spindle', state: 'off', op },
];

/** START, `moves`, END: the tool at (10, 0, -1) when `moves` begin. */
function program(...moves: IrEntry[]): Toolpath {
  return { start: [0, 0, 10], entries: [...START, ...moves, ...END] };
}

function arc(to: Vec3, center: [number, number], extra: Partial<ArcMove> = {}): ArcMove {
  return {
    kind: 'arc',
    to,
    center,
    direction: 'ccw',
    fullCircle: false,
    feed: 1000,
    feedClass: 'cut',
    op,
    pass: 0,
    ...extra,
  };
}

/** `e` without its tool number, when it is a tool change. */
function withoutToolNumber(e: IrEntry): IrEntry {
  if (e.kind !== 'toolChange') return e;
  const copy: { number?: number } & ToolChange = { ...e };
  delete copy.number;
  return copy;
}

function job(toolpath: Toolpath, over: Partial<PostJob> = {}): PostJob {
  return {
    toolpath,
    job: 'Sign',
    setup: 'Top',
    date: '2026-10-02',
    heights: { clearance: 15, retract: 5 },
    ...over,
  };
}

function post(
  toolpath: Toolpath,
  dialect: Dialect | CompiledDialect = plain(),
  options: PostOptions = {},
): PostOutput {
  const r = postProcess(job(toolpath), dialect, options);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

/** The single file's lines between the plunge and the final retract. */
function body(out: PostOutput): string[] {
  const lines = out.files[0]!.lines;
  const from = lines.indexOf('G1 Z-1 F300') + 1;
  // The final retract to the clearance (G0 Z15) comes after END's rapid.
  const to = lines.findLastIndex((l) => l.startsWith('G0 ') && l !== 'G0 Z15');
  return lines.slice(from, to);
}

function refusal(
  toolpath: Toolpath,
  dialect: Dialect = plain(),
  options: PostOptions = {},
  over: Partial<PostJob> = {},
): { code: string; message: string } {
  const r = postProcess(job(toolpath, over), dialect, options);
  if (r.ok) throw new Error('expected a refusal');
  return r.error;
}

describe('postProcess: a whole program', () => {
  it('writes the sample toolpath exactly', () => {
    const out = post(sampleToolpath(), testDialect());
    expect(out.files).toHaveLength(1);
    expect(out.files[0]!.text).toBe(
      [
        '(Sign / Top, 2026-10-02)',
        '(Post Test Grbl, mm, file 1 of 1)',
        '(T201 1/4in flat Dunknown)',
        'G21 G90 G17 G94',
        '(Profile)',
        '(Tool 201: 1/4in flat, 18000 rpm, F1000)',
        'G0 Z15',
        'M3 S18000',
        'X0 Y0',
        'Z5',
        'G1 Z-1 F300',
        'X30 Y40 F1000',
        'G3 X30 Y20 I0 J-10',
        'G1 X40 F500',
        'X50 Z-2 F400',
        'G4 P1.5',
        'G2 X46 Y20 Z-2.5 I-2 J0',
        'G2 X50 Y20 Z-3 I2 J0',
        'G0 Z10',
        'M5',
        'G0 Z15',
        'M30',
        '',
      ].join('\n'),
    );
    expect(out.stats).toEqual({ arcs: 3, arcsAsLines: 0, fullCirclesSplit: 1 });
  });

  it('writes inches under G20, coordinates to 4 decimals and feeds in in/min', () => {
    const out = post(sampleToolpath(), plain(), { units: 'inch' });
    expect(out.files[0]!.lines).toEqual([
      'G20 G90 G17 G94',
      '(Profile)',
      'G0 Z0.5906',
      'M3 S18000',
      'X0 Y0',
      'Z0.1969',
      'G1 Z-0.0394 F11.8',
      'X1.1811 Y1.5748 F39.4',
      'G3 X1.1811 Y0.7874 I0 J-0.3937',
      'G1 X1.5748 F19.7',
      'X1.9685 Z-0.0787 F15.7',
      'G4 P1.5',
      // I and J chosen so the rounded radii agree (J0.0001 rather than J0).
      'G2 X1.811 Y0.7874 Z-0.0984 I-0.0787 J0.0001',
      'G2 X1.9685 Y0.7874 Z-0.1181 I0.0787 J0.0001',
      'G0 Z0.3937',
      'M5',
      'G0 Z0.5906',
      'M30',
    ]);
  });

  it('is deterministic', () => {
    expect(post(sampleToolpath(), testDialect()).files[0]!.text).toBe(
      post(sampleToolpath(), testDialect()).files[0]!.text,
    );
  });
});

describe('postProcess: modal state', () => {
  it('omits repeated G0/G1 and F words and unchanged axes, and drops moves that round to nothing', () => {
    const out = post(
      program(
        { kind: 'linear', to: [20, 0, -1], feed: 1000, feedClass: 'cut', op, pass: 0 },
        { kind: 'linear', to: [20, 10, -1], feed: 1000, feedClass: 'cut', op, pass: 0 },
        { kind: 'linear', to: [20.0001, 10.0002, -1], feed: 1000, feedClass: 'cut', op, pass: 0 },
        { kind: 'linear', to: [20, 10, -2], feed: 400, feedClass: 'plunge', op, pass: 1 },
        { kind: 'rapid', to: [20, 10, 2], op, pass: 1 },
        { kind: 'rapid', to: [30, 10, 2], op, pass: 1 },
        { kind: 'linear', to: [30, 10, -2], feed: 400, feedClass: 'plunge', op, pass: 1 },
      ),
    );
    expect(body(out)).toEqual(['X20 F1000', 'Y10', 'Z-2 F400', 'G0 Z2', 'X30', 'G1 Z-2']);
  });

  it('writes the preamble words the header has not set', () => {
    const d = plain({
      templates: { header: ['G21 G90'], tool: [], toolChange: [], footer: ['M30'] },
    });
    expect(post(program(), d).files[0]!.lines.slice(0, 3)).toEqual([
      'G21 G90',
      'G17 G94',
      'G0 Z15',
    ]);
    const all = plain({
      templates: { header: ['{units_code} G90 G17 G94'], tool: [], toolChange: [], footer: [] },
    });
    expect(post(program(), all, { units: 'inch' }).files[0]!.lines.slice(0, 2)).toEqual([
      'G20 G90 G17 G94',
      'G0 Z0.5906',
    ]);
  });

  it('leaves out G94 for a dialect without it', () => {
    const d = plain({ gCodes: ['G0', 'G1', 'G2', 'G3', 'G4', 'G17', 'G21', 'G90'] });
    expect(post(program(), d).files[0]!.lines[0]).toBe('G21 G90 G17');
  });

  it('refuses a header that writes the other units', () => {
    const d = plain({ templates: { header: ['G20'], tool: [], toolChange: [], footer: [] } });
    expect(refusal(program(), d)).toMatchObject({ code: 'invalid-dialect' });
  });
});

describe('postProcess: safe start', () => {
  it('rises to the clearance first, then goes across and down to a lower rapid target', () => {
    const lines = post(program()).files[0]!.lines;
    expect(lines.slice(1, 6)).toEqual(['G0 Z15', 'M3 S16000', 'X10 Y0', 'Z5', 'G1 Z-1 F300']);
  });

  it('goes up before across when the first rapid is above the clearance', () => {
    const tp = program();
    const entries = tp.entries.map((e) =>
      e.kind === 'rapid' && e.to[2] === 5 ? { ...e, to: [10, 0, 20] as Vec3 } : e,
    );
    const lines = post({ ...tp, entries }).files[0]!.lines;
    expect(lines.slice(1, 5)).toEqual(['G0 Z15', 'M3 S16000', 'Z20', 'X10 Y0']);
  });

  it('refuses a feed move before the first rapid of a file', () => {
    const tp: Toolpath = {
      start: [0, 0, 10],
      entries: [
        START[0]!,
        START[1]!,
        { kind: 'linear', to: [10, 0, -1], feed: 300, feedClass: 'plunge', op, pass: 0 },
      ],
    };
    expect(refusal(tp).message).toMatch(/first move must be a rapid/);
  });

  it('stops the spindle before the footer when the IR leaves it running', () => {
    const tp = program();
    const lines = post({ ...tp, entries: tp.entries.slice(0, -1) }).files[0]!.lines;
    expect(lines.slice(-4)).toEqual(['G0 X0 Z10', 'G0 Z15', 'M5', 'M30']);
  });
});

describe('postProcess: arcs', () => {
  it('writes an arc as G2/G3 with X, Y, incremental I and J', () => {
    const out = post(program(arc([0, 10, -1], [0, 0])));
    expect(body(out)).toEqual(['G3 X0 Y10 I-10 J0 F1000']);
    const cw = post(program(arc([0, -10, -1], [0, 0], { direction: 'cw' })));
    expect(body(cw)).toEqual(['G2 X0 Y-10 I-10 J0 F1000']);
  });

  it('writes Z on a helical arc', () => {
    const out = post(program(arc([0, 10, -2], [0, 0])));
    expect(body(out)).toEqual(['G3 X0 Y10 Z-2 I-10 J0 F1000']);
  });

  it('writes an arc with a chord under ten steps as a line', () => {
    // Radius 10, chord 0.008 mm: 8 steps at 3 decimals.
    const a = 0.0008;
    const out = post(program(arc([10 * Math.cos(a), 10 * Math.sin(a), -1], [0, 0])));
    expect(body(out)).toEqual(['Y0.008 F1000']);
    expect(out.stats.arcsAsLines).toBe(1);
  });

  it('writes an arc with a sagitta at most tol / 20 as a line', () => {
    // Radius 1000, chord 0.5 mm: sagitta 3.1e-5 mm, under 0.0001.
    const c: [number, number] = [10, -1000];
    const a = Math.asin(0.5 / 1000);
    const to: Vec3 = [c[0] + 1000 * Math.sin(-a), c[1] + 1000 * Math.cos(a), -1];
    const out = post(program(arc(to, c)));
    expect(body(out)).toEqual(['X9.5 F1000']);
    // A larger sweep on the same circle stays an arc.
    const b = Math.asin(20 / 1000);
    const far: Vec3 = [c[0] + 1000 * Math.sin(-b), c[1] + 1000 * Math.cos(b), -1];
    expect(body(post(program(arc(far, c))))[0]).toMatch(/^G3 /);
  });

  it('never writes an arc whose rounded start and end coincide, unless a full circle is meant', () => {
    // About (5, 0) from (10, 0.0004) round to (10, -0.0004): 0.0008 mm apart, both written
    // as X10 Y0.
    const r = Math.hypot(5, 0.0004);
    const a = Math.atan2(-0.0004, 5);
    const out = post(
      program(
        { kind: 'linear', to: [10, 0.0004, -1], feed: 1000, feedClass: 'cut', op, pass: 0 },
        arc([5 + r * Math.cos(a), r * Math.sin(a), -1], [5, 0]),
      ),
    );
    const lines = body(out);
    expect(lines.every((l) => !/G[23]/.test(l))).toBe(true);
    expect(lines.length).toBeGreaterThan(20);
    expect(out.stats).toMatchObject({ arcs: 0, arcsAsLines: 1 });
    // Every point within the tolerance (and half a step per axis) of the circle.
    for (const l of lines) {
      const x = Number(/X(-?[\d.]+)/.exec(l)?.[1] ?? NaN);
      const y = Number(/Y(-?[\d.]+)/.exec(l)?.[1] ?? NaN);
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      expect(Math.abs(Math.hypot(x - 5, y) - 5)).toBeLessThan(0.002);
    }
  });

  it('writes an arc below the minimum radius as lines', () => {
    // Radius 0.008 mm, a quarter turn: chord 0.0113 mm is over ten steps, but r is under.
    const out = post(
      program(
        { kind: 'linear', to: [10.008, 0, -1], feed: 1000, feedClass: 'cut', op, pass: 0 },
        arc([10, 0.008, -1], [10, 0]),
      ),
    );
    expect(body(out).some((l) => /G[23]/.test(l))).toBe(false);
    expect(out.stats.arcsAsLines).toBe(1);
  });

  it('writes an arc that fails the Grbl check as lines within the tolerance', () => {
    // Ten metres away single precision steps are 1 mm, so this arc fails there.
    const out = post(program(arc([0.123, 9.877, -1], [0.123, 0])), plain(), {
      checkOffsets: [[-9999999.7, -9999999.7]],
    });
    const lines = body(out);
    expect(lines.some((l) => /G[23]/.test(l))).toBe(false);
    expect(out.stats.arcsAsLines).toBe(1);
    // A quarter turn of radius 9.877 with chords within 0.002 mm: 40 of them.
    expect(lines).toHaveLength(40);
    for (const l of lines) {
      const x = Number(/X(-?[\d.]+)/.exec(l)![1]);
      const y = Number(/Y(-?[\d.]+)/.exec(l)![1]);
      expect(Math.abs(Math.hypot(x - 0.123, y) - 9.877)).toBeLessThan(0.0008);
    }
    expect(lines.at(-1)).toMatch(/X0.123 Y9.877$/);
  });

  it('splits a full circle into two halves by default', () => {
    const out = post(program(arc([10, 0, -1], [0, 0], { fullCircle: true, direction: 'cw' })));
    expect(body(out)).toEqual(['G2 X-10 Y0 I-10 J0 F1000', 'X10 Y0 I10 J0'.replace(/^/, 'G2 ')]);
    expect(out.stats.fullCirclesSplit).toBe(1);
  });

  it('writes a full circle as one arc when the dialect asks', () => {
    const out = post(
      program(arc([10, 0, -2], [0, 0], { fullCircle: true })),
      plain({ fullCircles: 'single' }),
    );
    expect(body(out)).toEqual(['G3 X10 Y0 Z-2 I-10 J0 F1000']);
    expect(out.stats.fullCirclesSplit).toBe(0);
  });

  it('writes a full circle as two halves when the single arc fails the check', () => {
    // A clockwise turn of radius 5 about (0, 0) from (4.998, 0.137) as written. With the work
    // offset at (-1499.873, -1499.873), single precision puts Grbl's travel for every rounding of
    // I and J within the 5e-7 rad full-turn threshold on the wrong side, so one arc would be a
    // tiny arc, not a turn. The halves pass.
    const a = 0.0274;
    const from: Vec3 = [5 * Math.cos(a), 5 * Math.sin(a), -1];
    const tp = program(
      { kind: 'linear', to: from, feed: 1000, feedClass: 'cut', op, pass: 0 },
      arc(from, [0, 0], { fullCircle: true, direction: 'cw' }),
    );
    const single = plain({ fullCircles: 'single' });
    const at = (x: number): PostOptions => ({ checkOffsets: [[x, x]] });
    // At offset zero the one arc passes.
    const zero = post(tp, single, at(0));
    expect(body(zero)).toHaveLength(2);
    expect(body(zero)[1]).toMatch(/^G2 X4.998 Y0.137 I-4.998 J-0.13[67]$/);
    const out = post(tp, single, at(-1499.873));
    expect(body(out)).toEqual([
      'X4.998 Y0.137 F1000',
      'G2 X-4.998 Y-0.137 I-4.998 J-0.137',
      'G2 X4.998 Y0.137 I4.998 J0.137',
    ]);
    expect(out.stats).toEqual({ arcs: 2, arcsAsLines: 0, fullCirclesSplit: 1 });
    // The default offsets include that one, so the default output is the halves too.
    expect(body(post(tp, single))).toEqual(body(out));
  });

  it('writes a full circle below the minimum radius as lines', () => {
    const tiny = post(
      program(
        { kind: 'linear', to: [10.005, 0, -1], feed: 1000, feedClass: 'cut', op, pass: 0 },
        arc([10.005, 0, -1], [10, 0], { fullCircle: true }),
      ),
      plain({ fullCircles: 'single' }),
    );
    // Radius 0.005 mm: under the minimum, so neither one arc nor halves; lines.
    expect(body(tiny).some((l) => /G[23]/.test(l))).toBe(false);
    expect(tiny.stats.arcsAsLines).toBe(2);
  });

  it('picks I and J so the written radii agree', () => {
    // Centre (0.9991, 0.0015), a quarter turn from (10, 0): rounding I and J to the nearest
    // step gives radii 0.001 mm apart; rounding I the other way makes them agree.
    const c: [number, number] = [0.9991, 0.0015];
    const r = Math.hypot(10 - c[0], c[1]);
    const line = body(post(program(arc([c[0], c[1] + r, -1], c))))[0]!;
    expect(line).toBe('G3 X0.999 Y9.002 I-9.001 J0.001 F1000');
    const n = (k: string): number => Number(new RegExp(`${k}(-?[\\d.]+)`).exec(line)![1]);
    const r0 = Math.hypot(n('I'), n('J'));
    const r1 = Math.hypot(n('X') - 10 - n('I'), n('Y') - n('J'));
    expect(Math.abs(r1 - r0)).toBeLessThan(1e-6);
  });
});

describe('postProcess: comments and line length', () => {
  it('sanitises IR comments', () => {
    const tp = program({ kind: 'comment', text: 'Pocket (rough)! 50%; café', op });
    expect(body(post(tp))).toEqual(['(Pocket [rough] 50 cafe)']);
  });

  it('wraps long comments and refuses a code line over the limit', () => {
    const d = plain({ maxLineLength: 40 });
    const tp = program({ kind: 'comment', text: 'a long comment '.repeat(6), op });
    const lines = body(post(tp, d));
    expect(lines.length).toBeGreaterThan(2);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(40);

    const wide = program({
      kind: 'linear',
      to: [-12345.678, -12345.678, -1234.567],
      feed: 12345,
      feedClass: 'cut',
      op,
      pass: 0,
    });
    expect(refusal(wide, d)).toMatchObject({ code: 'unsupported' });
    expect(refusal(wide, d).message).toMatch(/longer than 40/);
  });
});

describe('postProcess: tool changes and files', () => {
  const twoTools = (): Toolpath => ({
    start: [0, 0, 10],
    entries: [
      ...START,
      ...END,
      { kind: 'comment', text: 'Pocket', op: 'pocket#1' },
      {
        kind: 'toolChange',
        tool: 'tool#2',
        number: 2,
        name: '3mm flat',
        diameter: 3,
        op: 'pocket#1',
      },
      { kind: 'spindle', state: 'cw', rpm: 20000, op: 'pocket#1' },
      { kind: 'rapid', to: [5, 5, 3], op: 'pocket#1', pass: 0 },
      { kind: 'linear', to: [5, 5, -2], feed: 200, feedClass: 'plunge', op: 'pocket#1', pass: 0 },
      { kind: 'rapid', to: [5, 5, 10], op: 'pocket#1', pass: 0 },
      { kind: 'spindle', state: 'off', op: 'pocket#1' },
    ],
  });

  it('writes one file per tool, each complete, comments going with the next tool', () => {
    const out = post(twoTools(), testDialect());
    expect(out.files.map((f) => f.tools)).toEqual([['tool#1'], ['tool#2']]);
    expect(out.files[0]!.lines.slice(-4)).toEqual(['G0 X0 Z10', 'M5', 'G0 Z15', 'M30']);
    expect(out.files[0]!.lines.at(-1)).toBe('M30');
    expect(out.files[0]!.lines.join('\n')).not.toMatch(/Pocket/);
    expect(out.files[1]!.lines).toEqual([
      '(Sign / Top, 2026-10-02)',
      '(Post Test Grbl, mm, file 2 of 2)',
      '(T2 3mm flat D3)',
      'G21 G90 G17 G94',
      '(Pocket)',
      '(Tool 2: 3mm flat, 20000 rpm, F200)',
      'G0 Z15',
      'M3 S20000',
      'X5 Y5',
      'Z3',
      'G1 Z-2 F200',
      'G0 Z10',
      'M5',
      'G0 Z15',
      'M30',
    ]);
  });

  it('refuses several tools in one file without a tool change style', () => {
    expect(refusal(twoTools(), plain(), { splitPerTool: false })).toMatchObject({
      code: 'unsupported',
    });
  });

  it('pauses with M0 between tools, then starts again from the clearance', () => {
    const out = post(twoTools(), plain(), { splitPerTool: false, toolChange: 'm0-pause' });
    expect(out.files).toHaveLength(1);
    const lines = out.files[0]!.lines;
    expect(lines.filter((l) => l === 'M0')).toHaveLength(1);
    const i = lines.indexOf('M0');
    // Up to the clearance before the pause, and again after it: the machine may have moved.
    expect(lines.slice(i - 3, i + 6)).toEqual([
      'M5',
      '(Pocket)',
      'G0 Z15',
      'M0',
      'G0 Z15',
      'M3 S20000',
      'X5 Y5',
      'Z3',
      'G1 Z-2 F200',
    ]);
  });

  it('writes M6 T<n> at every tool change, and repeats G and F words after it', () => {
    const d = plain({ mCodes: ['M3', 'M5', 'M6', 'M30'], toolChange: 'm6', splitPerTool: false });
    const lines = post(twoTools(), d).files[0]!.lines;
    expect(lines.filter((l) => l.startsWith('M6'))).toEqual(['M6 T1', 'M6 T2']);
    const i = lines.indexOf('M6 T2');
    expect(lines.slice(i, i + 6)).toEqual([
      'M6 T2',
      'G0 Z15',
      'M3 S20000',
      'X5 Y5',
      'Z3',
      'G1 Z-2 F200',
    ]);
  });

  it('refuses M6 for a tool with no number', () => {
    const d = plain({ mCodes: ['M3', 'M5', 'M6', 'M30'], toolChange: 'm6' });
    const tp = program();
    const entries = tp.entries.map(withoutToolNumber);
    expect(refusal({ ...tp, entries }, d).message).toMatch(/needs a tool number/);
  });

  it('refuses a style whose codes the dialect lacks', () => {
    expect(refusal(program(), plain(), { toolChange: 'm6' }).message).toMatch(/needs M6/);
  });

  it('fills template variables, in output units, and refuses a missing one in a code line', () => {
    const d = plain({
      mCodes: ['M3', 'M5', 'M30'],
      templates: {
        header: ['(Tools: {tool_count})'],
        tool: ['(T{tool} {tool_name} D{tool_diameter} {rpm} rpm F{feed})'],
        toolChange: ['T{tool}'],
        footer: ['M30'],
      },
    });
    const lines = post(program(arc([0, 10, -1], [0, 0])), d, { units: 'inch' }).files[0]!.lines;
    expect(lines.slice(0, 4)).toEqual([
      '(Tools: 1)',
      '(T1 6mm flat D0.2362 16000 rpm F39.4)',
      'G20 G90 G17 G94',
      'T1',
    ]);
    const tp = program();
    const entries = tp.entries.map(withoutToolNumber);
    expect(refusal({ ...tp, entries }, d).message).toMatch(/needs \{tool\}/);
  });
});

describe('postProcess: other words', () => {
  it('writes dwells in the dialect unit and drops zero dwells', () => {
    const tp = program({ kind: 'dwell', seconds: 0.25, op }, { kind: 'dwell', seconds: 0, op });
    expect(body(post(tp))).toEqual(['G4 P0.25']);
    expect(body(post(tp, plain({ dwellUnit: 'milliseconds' })))).toEqual(['G4 P250']);
  });

  it('wraps the program in % lines when the dialect asks', () => {
    const lines = post(program(), plain({ programDelimiter: true })).files[0]!.lines;
    expect(lines[0]).toBe('%');
    expect(lines.at(-1)).toBe('%');
  });
});

describe('postProcess: refusals', () => {
  it('refuses codes the dialect lacks', () => {
    const ccw: Toolpath = {
      start: [0, 0, 10],
      entries: [START[0]!, { kind: 'spindle', state: 'ccw', rpm: 10000, op }],
    };
    expect(refusal(ccw)).toMatchObject({ code: 'unsupported' });
    expect(refusal(ccw).message).toMatch(/M4/);
    const noDwell = plain({ gCodes: ['G0', 'G1', 'G2', 'G3', 'G17', 'G21', 'G90'] });
    expect(refusal(program({ kind: 'dwell', seconds: 1, op }), noDwell).message).toMatch(/G4/);
    const noInch = plain({ gCodes: ['G0', 'G1', 'G2', 'G3', 'G17', 'G21', 'G90'] });
    expect(refusal(program(), noInch, { units: 'inch' }).message).toMatch(/G20/);
  });

  it('refuses an invalid toolpath, naming the entry', () => {
    const bad = program({ kind: 'linear', to: [1, 1, -1], feed: 0, feedClass: 'cut', op, pass: 0 });
    expect(refusal(bad)).toMatchObject({ code: 'invalid-input' });
    expect(refusal(bad).message).toMatch(/entry 4/);
    const degenerate = program(arc([10, 0, -1], [0, 0]));
    expect(refusal(degenerate).message).toMatch(/full turn/);
  });

  it('refuses bad options, a bad clearance, a bad tool diameter and a bad dialect', () => {
    expect(refusal(program(), plain(), { tolerance: 0 })).toMatchObject({ code: 'invalid-input' });
    expect(refusal(program(), plain(), { tolerance: Number.NaN })).toMatchObject({
      code: 'invalid-input',
    });
    expect(refusal(program(), plain(), { arcTolerance: -1 })).toMatchObject({
      code: 'invalid-input',
    });
    expect(refusal(program(), plain(), { checkOffsets: [] })).toMatchObject({
      code: 'invalid-input',
    });
    expect(
      refusal(program(), plain(), {}, { heights: { clearance: Number.NaN, retract: 5 } }),
    ).toMatchObject({ code: 'invalid-input' });
    expect(
      refusal(program(), plain(), {}, { heights: { clearance: 15, retract: 20 } }).message,
    ).toMatch(/retract height 20 mm is above the clearance 15 mm/);
    const tp = program();
    const entries = tp.entries.map((e) => (e.kind === 'toolChange' ? { ...e, diameter: -1 } : e));
    expect(refusal({ ...tp, entries }).message).toMatch(/diameter/);
    expect(refusal(program(), plain({ maxLineLength: 3 }))).toMatchObject({
      code: 'invalid-dialect',
    });
  });

  it('refuses a coordinate or feed it cannot write', () => {
    const far = program({
      kind: 'linear',
      to: [1e8, 0, -1],
      feed: 1000,
      feedClass: 'cut',
      op,
      pass: 0,
    });
    expect(refusal(far).message).toMatch(/coordinate/);
    const slow = program({
      kind: 'linear',
      to: [20, 0, -1],
      feed: 0.4,
      feedClass: 'cut',
      op,
      pass: 0,
    });
    expect(refusal(slow).message).toMatch(/positive F/);
  });
});

describe('postProcess: templates never leave the engine with a stale position', () => {
  const rapidFirst = (): Toolpath => ({
    start: [0, 0, 10],
    entries: [
      { kind: 'rapid', to: [10, 0, 5], op, pass: 0 },
      START[0]!,
      START[1]!,
      { kind: 'rapid', to: [10, 0, 5], op, pass: 0 },
      START[3]!,
      ...END,
    ],
  });

  it('starts again from the clearance after a template code line (G80 cancels the motion mode)', () => {
    const d = plain({
      gCodes: ['G0', 'G1', 'G2', 'G3', 'G4', 'G17', 'G21', 'G80', 'G90', 'G94'],
      templates: { header: [], tool: [], toolChange: ['G80'], footer: ['M30'] },
    });
    expect(post(rapidFirst(), d).files[0]!.lines.slice(1, 13)).toEqual([
      'G0 Z15',
      'X10 Y0',
      'Z5',
      'G0 Z15', // up before the tool change
      'G80',
      'G0 Z15', // G80 cancelled G0, so every word is written again
      'M3 S16000',
      'X10 Y0',
      'Z5',
      'G1 Z-1 F300',
      'G0 X0 Z10',
      'M5',
    ]);
  });

  it('allows a work offset only in the header', () => {
    const gCodes = ['G0', 'G1', 'G2', 'G3', 'G4', 'G17', 'G21', 'G55', 'G90', 'G94'];
    const late = plain({
      gCodes,
      templates: { header: [], tool: [], toolChange: ['G55'], footer: ['M30'] },
    });
    expect(refusal(rapidFirst(), late)).toMatchObject({ code: 'invalid-dialect' });
    expect(refusal(rapidFirst(), late).message).toMatch(/G55 changes the work offset/);
    const early = plain({
      gCodes,
      templates: { header: ['G55'], tool: [], toolChange: [], footer: [] },
    });
    expect(post(program(), early).files[0]!.lines.slice(0, 3)).toEqual([
      'G55',
      'G21 G90 G17 G94',
      'G0 Z15',
    ]);
  });

  it('caps G64 P at the tolerance in output units', () => {
    const d = (p: string): Dialect =>
      plain({
        gCodes: ['G0', 'G1', 'G2', 'G3', 'G4', 'G17', 'G20', 'G21', 'G64', 'G90', 'G94'],
        templates: { header: [`G64 P${p}`], tool: [], toolChange: [], footer: [] },
      });
    expect(post(program(), d('0.001')).files[0]!.lines[0]).toBe('G64 P0.001');
    expect(refusal(program(), d('0.01')).message).toMatch(/at most 0.002/);
    expect(post(program(), d('0.01'), { tolerance: 0.02 }).files[0]!.lines[0]).toBe('G64 P0.01');
    // 0.0001 in is 0.00254 mm: over the 0.002 mm tolerance.
    expect(refusal(program(), d('0.0001'), { units: 'inch' })).toMatchObject({
      code: 'invalid-dialect',
    });
  });
});

describe('postProcess: comments cannot become controller commands', () => {
  it('neutralises keywords in IR comments, on wrapped continuation lines too', () => {
    const text = 'Pocket for padding padding padding LOGOPEN,/home/cnc/.bashrc then py,x=1';
    const lines = body(post(program({ kind: 'comment', text, op }), plain({ maxLineLength: 40 })));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.some((l) => l.startsWith('(_LOGOPEN,'))).toBe(true);
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(40);
      // Every line that could be read as a command carries the leading underscore.
      expect(l, l).not.toMatch(/^\((?!_)\s*(?:msg|debug|print|log|probe|abort|py|\w+\s*,)/i);
    }
  });

  it('neutralises a tool name in a template comment', () => {
    const tp = program();
    const entries = tp.entries.map((e) =>
      e.kind === 'toolChange' ? { ...e, name: 'MSG,Remove the clamps' } : e,
    );
    const d = plain({
      templates: { header: [], tool: ['({tool_name})'], toolChange: [], footer: [] },
    });
    expect(post({ ...tp, entries }, d).files[0]!.lines[0]).toBe('(_MSG,Remove the clamps)');
  });
});

describe('postProcess: only dialects compileDialect made are trusted', () => {
  it('recompiles anything else, so a forged compiled dialect is refused', () => {
    const forged = {
      dialect: plain({ toolChange: 'm6' }),
      gCodes: new Set(['G0', 'G1', 'G2', 'G3', 'G17', 'G21', 'G90']),
      mCodes: new Set(['M3', 'M5', 'M6']),
      templates: { header: [], tool: [], toolChange: [], footer: [] },
    } as unknown as CompiledDialect;
    expect(refusal(program(), forged as unknown as Dialect)).toMatchObject({
      code: 'invalid-dialect',
    });
  });

  it('uses a compiled dialect as is, frozen and independent of its input', () => {
    const input = plain();
    const compiled = compileDialect(input);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(isCompiledDialect(compiled.value)).toBe(true);
    expect(Object.isFrozen(compiled.value.dialect.templates.footer)).toBe(true);
    (input.templates.footer as string[]).push('M2');
    expect(post(program(), compiled.value).files[0]!.lines.at(-1)).toBe('M30');
  });

  it('returns an error value for a bad record, never throws', () => {
    const d = plain();
    for (const bad of [
      plain({ maxLineLength: 1e9 }),
      plain({ decimals: { ...d.decimals, mm: { coordinate: 1e9, feed: 0 } } }),
      plain({ decimals: null as never }),
      plain({ templates: null as never }),
    ]) {
      expect(refusal(program(), bad)).toMatchObject({ code: 'invalid-dialect' });
    }
    const hostile = {
      ...plain(),
      get name(): string {
        throw new Error('boom');
      },
    };
    expect(() => postProcess(job(program()), hostile)).not.toThrow();
    expect(refusal(program(), hostile)).toMatchObject({ code: 'invalid-dialect' });
  });
});

describe('postProcess: spindle states', () => {
  it('refuses an unknown spindle state instead of writing M4', () => {
    const tp = program();
    const entries = tp.entries.map((e) =>
      e.kind === 'spindle' && e.state === 'cw'
        ? ({ ...e, state: 'reverse' } as unknown as IrEntry)
        : e,
    );
    expect(refusal({ ...tp, entries })).toMatchObject({ code: 'invalid-input' });
    expect(refusal({ ...tp, entries }).message).toMatch(/Unknown spindle state 'reverse'/);
  });
});
