// A toolpath packed into typed arrays (ADR 0014 decision 7; ADR 0007 decision 6: buffers are
// transferred, never copied). The IR (`ir.ts`) is an array of small objects, which structured
// cloning copies one by one; a pocket can hold a hundred thousand moves. Packed, the moves are two
// typed arrays whose buffers move between threads at no cost, and the few entries that are not
// moves (tool changes, spindle, dwells, comments) travel as plain objects beside them.
//
// Layout, per entry i of the toolpath, in order:
// - `kinds[i]`: the entry kind, `PACKED_KINDS.indexOf(kind)`.
// - `values[6i .. 6i+5]`: for a move, `to` x, y, z, then the arc `center` x, y (0 otherwise), then
//   the feed (0 for a rapid). Unused for other entries (all 0).
// - `ints[3i .. 3i+2]`: for a move, the index of its `op` in `ops`, its `pass`, and flags (bits 0
//   and 1: the feed class's index in `FEED_CLASSES`; bit 2: `ccw`; bit 3: `fullCircle`). For any
//   other entry, its index in `extras`, then -1 and 0.

import { FEED_CLASSES, type IrEntry, type Move, type Toolpath } from '../ir';
import type { Vec3 } from '../types';

export const PACKED_KINDS = [
  'rapid',
  'linear',
  'arc',
  'dwell',
  'toolChange',
  'spindle',
  'comment',
  // Appended, so the indices above stay what they were.
  'cycle',
  'cycleEnd',
] as const satisfies readonly IrEntry['kind'][];

/** Numbers per entry in `values` and `ints`. */
export const VALUE_STRIDE = 6;
export const INT_STRIDE = 3;

const FLAG_CCW = 4;
const FLAG_FULL_CIRCLE = 8;

/** An entry that is not a move: carried as a plain object. */
export type PackedExtra = Exclude<IrEntry, Move>;

export interface PackedToolpath {
  readonly start: Vec3;
  readonly kinds: Uint8Array;
  readonly values: Float64Array;
  readonly ints: Int32Array;
  /** The move tags' `op` ids, each once. */
  readonly ops: readonly string[];
  readonly extras: readonly PackedExtra[];
}

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

/**
 * Pack a toolpath. Throws a `RangeError` on what the layout cannot hold exactly, rather than
 * writing a wrong value: an unknown entry kind or feed class, an arc `direction` other than `cw`
 * or `ccw`, or a `pass` that is not a whole number in the Int32 range.
 */
export function packToolpath(toolpath: Toolpath): PackedToolpath {
  const n = toolpath.entries.length;
  const kinds = new Uint8Array(n);
  const values = new Float64Array(n * VALUE_STRIDE);
  const ints = new Int32Array(n * INT_STRIDE);
  const ops: string[] = [];
  const opIndex = new Map<string, number>();
  const extras: PackedExtra[] = [];
  toolpath.entries.forEach((entry, i) => {
    const kind = PACKED_KINDS.indexOf(entry.kind);
    if (kind < 0) {
      throw new RangeError(`packed toolpath: unknown entry kind '${String(entry.kind)}' at ${i}`);
    }
    kinds[i] = kind;
    const v = i * VALUE_STRIDE;
    const k = i * INT_STRIDE;
    if (entry.kind === 'rapid' || entry.kind === 'linear' || entry.kind === 'arc') {
      values[v] = entry.to[0];
      values[v + 1] = entry.to[1];
      values[v + 2] = entry.to[2];
      let op = opIndex.get(entry.op);
      if (op === undefined) {
        op = ops.length;
        ops.push(entry.op);
        opIndex.set(entry.op, op);
      }
      ints[k] = op;
      if (!Number.isInteger(entry.pass) || entry.pass < INT32_MIN || entry.pass > INT32_MAX) {
        throw new RangeError(`packed toolpath: pass ${entry.pass} at ${i} is not a 32-bit integer`);
      }
      ints[k + 1] = entry.pass;
      if (entry.kind !== 'rapid') {
        values[v + 5] = entry.feed;
        let flags = FEED_CLASSES.indexOf(entry.feedClass);
        if (flags < 0) {
          throw new RangeError(
            `packed toolpath: unknown feed class '${String(entry.feedClass)}' at ${i}`,
          );
        }
        if (entry.kind === 'arc') {
          values[v + 3] = entry.center[0];
          values[v + 4] = entry.center[1];
          if (entry.direction === 'ccw') flags |= FLAG_CCW;
          else if (entry.direction !== 'cw') {
            throw new RangeError(
              `packed toolpath: arc direction '${String(entry.direction)}' at ${i} is not cw or ccw`,
            );
          }
          if (entry.fullCircle) flags |= FLAG_FULL_CIRCLE;
        }
        ints[k + 2] = flags;
      }
    } else {
      ints[k] = extras.length;
      ints[k + 1] = -1;
      extras.push(entry);
    }
  });
  const start: Vec3 = [toolpath.start[0], toolpath.start[1], toolpath.start[2]];
  return { start, kinds, values, ints, ops, extras };
}

/** The toolpath a packed one holds, entry for entry. */
export function unpackToolpath(packed: PackedToolpath): Toolpath {
  const entries: IrEntry[] = [];
  const { kinds, values, ints, ops, extras } = packed;
  for (let i = 0; i < kinds.length; i++) {
    const kind = PACKED_KINDS[kinds[i]!];
    const v = i * VALUE_STRIDE;
    const k = i * INT_STRIDE;
    if (kind === 'rapid' || kind === 'linear' || kind === 'arc') {
      const to: Vec3 = [values[v]!, values[v + 1]!, values[v + 2]!];
      const op = ops[ints[k]!]!;
      const pass = ints[k + 1]!;
      const flags = ints[k + 2]!;
      if (kind === 'rapid') {
        entries.push({ kind, op, pass, to });
        continue;
      }
      const feed = values[v + 5]!;
      const feedClass = FEED_CLASSES[flags & 3]!;
      if (kind === 'linear') {
        entries.push({ kind, op, pass, to, feed, feedClass });
      } else {
        entries.push({
          kind,
          op,
          pass,
          to,
          center: [values[v + 3]!, values[v + 4]!],
          direction: flags & FLAG_CCW ? 'ccw' : 'cw',
          fullCircle: (flags & FLAG_FULL_CIRCLE) !== 0,
          feed,
          feedClass,
        });
      }
    } else if (kind !== undefined) {
      entries.push(extras[ints[k]!]!);
    } else {
      throw new RangeError(`packed toolpath: unknown entry kind ${kinds[i]} at ${i}`);
    }
  }
  return { start: [packed.start[0], packed.start[1], packed.start[2]], entries };
}

/** A copy with buffers of its own, for sending while the original stays usable (the cache's). */
export function clonePacked(packed: PackedToolpath): PackedToolpath {
  return {
    start: [packed.start[0], packed.start[1], packed.start[2]],
    kinds: packed.kinds.slice(),
    values: packed.values.slice(),
    ints: packed.ints.slice(),
    ops: [...packed.ops],
    extras: [...packed.extras],
  };
}

/** The buffers to transfer with a packed toolpath. */
export function packedTransferables(packed: PackedToolpath): ArrayBuffer[] {
  return [packed.kinds, packed.values, packed.ints].map((a) => a.buffer as ArrayBuffer);
}

/**
 * About how many bytes a packed toolpath holds: its arrays exactly, plus an estimate for the op
 * ids and the extras (64 bytes each, plus two per character of a comment). The cache's measure of
 * its size.
 */
export function packedBytes(packed: PackedToolpath): number {
  let bytes = packed.kinds.byteLength + packed.values.byteLength + packed.ints.byteLength;
  for (const op of packed.ops) bytes += 64 + 2 * op.length;
  for (const extra of packed.extras) {
    bytes += 64 + (extra.kind === 'comment' ? 2 * extra.text.length : 0);
  }
  return bytes;
}

/** How many entries a packed toolpath holds. */
export function packedLength(packed: PackedToolpath): number {
  return packed.kinds.length;
}
