// Packed toolpaths: every entry kind and flag survives a round trip, and clones own their buffers.

import { describe, expect, it } from 'vitest';
import type { Toolpath } from '../ir';
import { sampleToolpath } from '../test-helpers';
import {
  INT_STRIDE,
  VALUE_STRIDE,
  clonePacked,
  packToolpath,
  packedBytes,
  packedLength,
  packedTransferables,
  unpackToolpath,
} from './pack';

describe('packed toolpaths', () => {
  it('round-trips every entry kind exactly', () => {
    const toolpath = sampleToolpath();
    const packed = packToolpath(toolpath);
    expect(packedLength(packed)).toBe(toolpath.entries.length);
    expect(packed.values).toHaveLength(toolpath.entries.length * VALUE_STRIDE);
    expect(packed.ints).toHaveLength(toolpath.entries.length * INT_STRIDE);
    expect(unpackToolpath(packed)).toEqual(toolpath);
  });

  it('keeps arc directions, full-circle flags, feed classes, passes and op ids', () => {
    const toolpath: Toolpath = {
      start: [1, 2, 3],
      entries: [
        { kind: 'rapid', to: [0, 0, 5], op: 'link', pass: 0 },
        { kind: 'linear', to: [0, 0, -1], feed: 300, feedClass: 'plunge', op: 'pocket#2', pass: 7 },
        {
          kind: 'arc',
          to: [10, 0, -1.5],
          center: [5, 0],
          direction: 'cw',
          fullCircle: false,
          feed: 900,
          feedClass: 'lead',
          op: 'pocket#2',
          pass: 7,
        },
        {
          kind: 'arc',
          to: [10, 0, -2],
          center: [5, 0],
          direction: 'ccw',
          fullCircle: true,
          feed: 450.25,
          feedClass: 'ramp',
          op: 'drill#1',
          pass: 123456,
        },
        { kind: 'comment', text: 'done' },
      ],
    };
    const packed = packToolpath(toolpath);
    expect(packed.ops).toEqual(['link', 'pocket#2', 'drill#1']);
    expect(packed.extras).toEqual([{ kind: 'comment', text: 'done' }]);
    expect(unpackToolpath(packed)).toEqual(toolpath);
  });

  it('packs an empty toolpath', () => {
    const empty: Toolpath = { start: [0, 0, 10], entries: [] };
    expect(unpackToolpath(packToolpath(empty))).toEqual(empty);
  });

  it('clones with buffers of their own', () => {
    const packed = packToolpath(sampleToolpath());
    const copy = clonePacked(packed);
    copy.values[0] = 999;
    expect(packed.values[0]).not.toBe(999);
    const own = packedTransferables(packed);
    expect(own).toHaveLength(3);
    for (const b of packedTransferables(copy)) expect(own).not.toContain(b);
    expect(packedBytes(copy)).toBe(packedBytes(packed));
    expect(packedBytes(packed)).toBeGreaterThan(packed.values.byteLength);
  });

  describe('refuses what the layout cannot hold', () => {
    const move = (patch: Record<string, unknown>) =>
      ({
        start: [0, 0, 0],
        entries: [
          {
            kind: 'arc',
            to: [1, 0, 0],
            center: [0.5, 0],
            direction: 'cw',
            fullCircle: false,
            feed: 100,
            feedClass: 'cut',
            op: 'pocket#1',
            pass: 0,
            ...patch,
          },
        ],
      }) as unknown as Toolpath;

    it('accepts the base case', () => {
      expect(unpackToolpath(packToolpath(move({})))).toEqual(move({}));
      expect(() => packToolpath(move({ pass: 2 ** 31 - 1 }))).not.toThrow();
      expect(() => packToolpath(move({ pass: -(2 ** 31) }))).not.toThrow();
    });

    it('an unknown entry kind', () => {
      expect(() => packToolpath(move({ kind: 'probe' }))).toThrow(/unknown entry kind 'probe'/);
    });

    it('an unknown feed class', () => {
      expect(() => packToolpath(move({ feedClass: 'finish' }))).toThrow(
        /unknown feed class 'finish'/,
      );
    });

    it('a direction other than cw or ccw', () => {
      for (const direction of ['CW', 'ccw ', undefined]) {
        expect(() => packToolpath(move({ direction }))).toThrow(/is not cw or ccw/);
      }
    });

    it('a pass outside Int32 or not whole', () => {
      for (const pass of [2 ** 31, -(2 ** 31) - 1, 1.5, Number.NaN]) {
        expect(() => packToolpath(move({ pass }))).toThrow(/not a 32-bit integer/);
      }
    });
  });

  it('refuses an unknown entry kind when unpacking', () => {
    const packed = packToolpath(sampleToolpath());
    packed.kinds[0] = 200;
    expect(() => unpackToolpath(packed)).toThrow(/unknown entry kind/);
  });
});
