import { describe, expect, it } from 'vitest';
import type { ArcMove, IrEntry, Toolpath } from './ir';
import { sampleToolpath } from './test-helpers';
import { DEFAULT_ARC_TOLERANCE, validateToolpath } from './validate';

const op = 'pocket#1';
const PREAMBLE: IrEntry[] = [
  { kind: 'toolChange', tool: 'tool#1', name: '6mm flat', op },
  { kind: 'spindle', state: 'cw', rpm: 16000, op },
];

/** A program of the preamble, a rapid to (10, 0, 0), then `entries`. */
function program(...entries: IrEntry[]): Toolpath {
  return {
    start: [0, 0, 10],
    entries: [...PREAMBLE, { kind: 'rapid', to: [10, 0, 0], op, pass: 0 }, ...entries],
  };
}

function arcTo(to: [number, number, number], extra: Partial<ArcMove> = {}): ArcMove {
  return {
    kind: 'arc',
    to,
    center: [0, 0],
    direction: 'ccw',
    fullCircle: false,
    feed: 1000,
    feedClass: 'cut',
    op,
    pass: 0,
    ...extra,
  };
}

const codes = (t: Toolpath) => validateToolpath(t).map((i) => i.code);

describe('validateToolpath', () => {
  it('accepts a valid program, helical full circle included', () => {
    expect(validateToolpath(sampleToolpath())).toEqual([]);
  });

  it('accepts rapids before the tool change and with the spindle off', () => {
    const t: Toolpath = {
      start: [0, 0, 10],
      entries: [{ kind: 'rapid', to: [0, 0, 20], op: 'link', pass: 0 }, ...PREAMBLE],
    };
    expect(validateToolpath(t)).toEqual([]);
  });

  it('a feed of zero or less', () => {
    const issues = validateToolpath(
      program(
        { kind: 'linear', to: [20, 0, 0], feed: 0, feedClass: 'cut', op, pass: 0 },
        arcTo([0, 20, 0], { feed: -5 }),
      ),
    );
    expect(issues.map((i) => [i.code, i.index, i.op])).toEqual([
      ['zero-feed', 3, op],
      ['zero-feed', 4, op],
    ]);
  });

  it('a feed move with the spindle off, before it starts and after it stops', () => {
    const before: Toolpath = {
      start: [0, 0, 0],
      entries: [
        { kind: 'toolChange', tool: 'tool#1', name: 't', op },
        { kind: 'linear', to: [1, 0, 0], feed: 100, feedClass: 'cut', op, pass: 0 },
      ],
    };
    expect(codes(before)).toEqual(['spindle-off']);
    const after = program(
      { kind: 'spindle', state: 'off', op },
      { kind: 'linear', to: [20, 0, 0], feed: 100, feedClass: 'cut', op, pass: 0 },
    );
    expect(codes(after)).toEqual(['spindle-off']);
  });

  it('a feed move before any tool change', () => {
    const t: Toolpath = {
      start: [0, 0, 0],
      entries: [
        { kind: 'spindle', state: 'cw', rpm: 10000, op },
        { kind: 'linear', to: [1, 0, 0], feed: 100, feedClass: 'cut', op, pass: 0 },
      ],
    };
    expect(codes(t)).toEqual(['no-tool']);
  });

  it('a spindle start at 0 rpm leaves the spindle off', () => {
    const t: Toolpath = {
      start: [0, 0, 0],
      entries: [
        { kind: 'toolChange', tool: 'tool#1', name: 't', op },
        { kind: 'spindle', state: 'cw', rpm: 0, op },
        { kind: 'linear', to: [1, 0, 0], feed: 100, feedClass: 'plunge', op, pass: 0 },
      ],
    };
    expect(codes(t)).toEqual(['spindle-rpm', 'spindle-off']);
  });

  it('a tool change with the spindle on', () => {
    expect(codes(program({ kind: 'toolChange', tool: 'tool#2', name: 'v', op }))).toEqual([
      'tool-change-spindle-on',
    ]);
  });

  it('a negative dwell', () => {
    expect(codes(program({ kind: 'dwell', seconds: -1, op }))).toEqual(['dwell']);
  });

  it('non-finite targets, feeds and centres', () => {
    expect(
      codes(
        program(
          { kind: 'linear', to: [Number.NaN, 0, 0], feed: 100, feedClass: 'cut', op, pass: 0 },
          { kind: 'linear', to: [20, 0, 0], feed: Infinity, feedClass: 'cut', op, pass: 0 },
          arcTo([0, 20, 0], { center: [Number.NaN, 0] }),
        ),
      ),
    ).toEqual(['non-finite', 'non-finite', 'non-finite']);
    expect(codes({ start: [0, Number.NaN, 0], entries: [] })).toEqual(['non-finite']);
  });

  it('a move without an operation id or with a bad pass', () => {
    expect(
      codes(
        program(
          { kind: 'rapid', to: [1, 1, 1], op: '', pass: 0 },
          { kind: 'rapid', to: [1, 1, 2], op, pass: 1.5 },
          { kind: 'rapid', to: [1, 1, 3], op, pass: -1 },
        ),
      ),
    ).toEqual(['bad-tag', 'bad-tag', 'bad-tag']);
  });

  describe('arcs', () => {
    it('a quarter arc is valid; a radius error within the tolerance passes', () => {
      expect(codes(program(arcTo([0, 10, 0])))).toEqual([]);
      const within = 10 + DEFAULT_ARC_TOLERANCE * 0.9;
      expect(codes(program(arcTo([0, within, 0])))).toEqual([]);
    });

    it('start and end radius differ by more than the tolerance', () => {
      const issues = validateToolpath(program(arcTo([0, 10.01, 0])));
      expect(issues.map((i) => i.code)).toEqual(['arc-radius']);
      expect(issues[0]!.index).toBe(3);
      // A looser tolerance accepts it.
      expect(validateToolpath(program(arcTo([0, 10.01, 0])), { arcTolerance: 0.02 })).toEqual([]);
    });

    it('an arc starting on its centre', () => {
      expect(codes(program(arcTo([0, 10, 0], { center: [10, 0] })))).toEqual(['arc-zero-radius']);
    });

    it('a tiny arc whose ends coincide is degenerate unless marked full circle', () => {
      // 1e-6 rad on radius 10: the ends are 1e-5 mm apart; Grbl would cut a whole turn.
      const a = 1e-6;
      const to: [number, number, number] = [10 * Math.cos(a), 10 * Math.sin(a), 0];
      expect(codes(program(arcTo(to)))).toEqual(['arc-degenerate']);
      expect(codes(program(arcTo([10, 0, 0])))).toEqual(['arc-degenerate']);
      expect(codes(program(arcTo([10, 0, 0], { fullCircle: true })))).toEqual([]);
    });

    it('a full circle that does not close', () => {
      expect(codes(program(arcTo([0, 10, 0], { fullCircle: true })))).toEqual([
        'arc-full-circle-open',
      ]);
    });

    it('a helical full circle closes in XY whatever its Z', () => {
      expect(
        codes(
          program(arcTo([10, 0, -2], { fullCircle: true, feedClass: 'ramp', direction: 'cw' })),
        ),
      ).toEqual([]);
    });

    it('a helical arc is checked against its XY radius', () => {
      expect(codes(program(arcTo([0, 10, -3])))).toEqual([]);
      expect(codes(program(arcTo([0, 11, -3])))).toEqual(['arc-radius']);
    });
  });
});
