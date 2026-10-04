// The host side of the binding fed hostile payloads directly, as a script that broke the glue
// could send them. T7.2e adds a fuzz test over the same functions.

import { describe, expect, it } from 'vitest';
import { CodecError, HandleTable, decodePayload, encodeValue, jsonDepth } from './codec';
import { ScriptHandle } from './host';
import { DEFAULT_LIMITS } from './limits';
import { MARK } from './prelude';

const limits = DEFAULT_LIMITS;
const m = (v: unknown) => JSON.stringify({ [MARK]: v });

function decodeError(json: string, table = new HandleTable()): CodecError {
  try {
    decodePayload(json, table, limits);
  } catch (e) {
    if (e instanceof CodecError) return e;
    throw e;
  }
  throw new Error('expected a CodecError');
}

describe('decoding payloads from a script', () => {
  it('decodes markers into handles and special numbers', () => {
    const table = new HandleTable();
    const h = new ScriptHandle('face', {});
    table.indexOf(h);
    const out = decodePayload(
      `[${m(0)},${m('NaN')},${m('-0')},${m('Infinity')}]`,
      table,
      limits,
    ) as unknown[];
    expect(out[0]).toBe(h);
    expect(out[1]).toBeNaN();
    expect(Object.is(out[2], -0)).toBe(true);
    expect(out[3]).toBe(Infinity);
  });

  it.each([
    [m(0), 'Unknown handle'],
    [m(1.5), 'Unknown handle'],
    [m(-1), 'Unknown handle'],
    [m('Number.MAX_VALUE'), 'Malformed marker'],
    [m(null), 'Malformed marker'],
    [JSON.stringify({ [MARK]: 0, extra: 1 }), 'Malformed marker'],
    ['{"__proto__": {"polluted": 1}}', '__proto__'],
    ['{"a": [{"__proto__": 1}]}', '__proto__'],
    ['not json', 'not valid JSON'],
  ])('refuses %s', (json, message) => {
    const e = decodeError(json);
    expect(e.message).toContain(message);
    expect(e.tooLarge).toBe(false);
    expect('polluted' in {}).toBe(false);
  });

  it('refuses oversized payloads before parsing them', () => {
    expect(decodeError('['.repeat(100_000) + ']'.repeat(100_000)).tooLarge).toBe(true);
    expect(decodeError(`"${'x'.repeat(limits.maxPayloadLength)}"`).tooLarge).toBe(true);
    expect(decodeError(`"${'x'.repeat(limits.maxStringLength + 1)}"`).tooLarge).toBe(true);
    expect(
      decodeError(JSON.stringify(Array.from({ length: limits.maxElements + 1 }, () => 0))).tooLarge,
    ).toBe(true);
  });

  it('counts depth outside strings only', () => {
    expect(jsonDepth('[[1],{"a":"[[[[["}]')).toBe(2);
    expect(jsonDepth('"\\"[["')).toBe(0);
  });
});

describe('encoding host values for a script', () => {
  it('registers handles once and keeps markers for special numbers', () => {
    const table = new HandleTable();
    const h = new ScriptHandle('edge', 1);
    const json = encodeValue({ a: h, b: [h, Number.NaN, -0, undefined] }, table, limits)!;
    expect(table.size).toBe(1);
    expect(JSON.parse(json)).toEqual({
      a: { [MARK]: 0, kind: 'edge' },
      b: [{ [MARK]: 0, kind: 'edge' }, { [MARK]: 'NaN' }, { [MARK]: '-0' }, null],
    });
  });

  it.each([
    [new Map(), 'plain objects'],
    [() => 1, 'cannot cross'],
    [{ [MARK]: 1 }, 'cannot cross'],
    [JSON.parse('{"__proto__": 1}'), '__proto__'],
  ])('refuses %s', (v, message) => {
    expect(() => encodeValue(v, new HandleTable(), limits)).toThrow(message);
  });

  it('refuses cycles through the depth limit', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => encodeValue(a, new HandleTable(), limits)).toThrow(/nested deeper/);
  });
});

describe('handles', () => {
  it('need a short lowercase kind', () => {
    expect(() => new ScriptHandle('Face', 1)).toThrow();
    expect(new ScriptHandle('face-set', 1).kind).toBe('face-set');
  });
});
