import { describe, expect, it } from 'vitest';
import { isJsonObject, mapJson, visitJson, type JsonObject } from './walk';

/** `{ a: { a: ... { leaf: true } } }`, `levels` objects deep. */
function nested(levels: number): JsonObject {
  let v: JsonObject = { leaf: true };
  for (let i = 1; i < levels; i++) v = { a: v };
  return v;
}

describe('isJsonObject', () => {
  it('is true for plain objects only', () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject('x')).toBe(false);
  });
});

describe('visitJson', () => {
  it('visits parents before members, and members inherit the context their parent returns', () => {
    const seen: [string, string][] = [];
    const value = {
      name: 'root',
      tag: 'A',
      items: [{ name: 'x' }, { name: 'y', tag: 'B', inner: { name: 'z' } }],
    };
    visitJson(
      value,
      'none',
      (o, tag) => {
        seen.push([String(o.name), tag]);
        return typeof o.tag === 'string' ? o.tag : tag;
      },
      { maxDepth: 10 },
    );
    expect(seen).toEqual([
      ['root', 'none'],
      ['x', 'A'],
      ['y', 'A'],
      ['z', 'B'],
    ]);
  });

  it('skips what lies past the depth limit when no message is given', () => {
    let leaves = 0;
    const count = (o: JsonObject) => {
      if (o.leaf === true) leaves++;
    };
    // Depth counts arrays and objects: the 4th object is at depth 3.
    visitJson(nested(4), undefined, count, { maxDepth: 3 });
    expect(leaves).toBe(1);
    visitJson(nested(5), undefined, count, { maxDepth: 3 });
    expect(leaves).toBe(1);
  });

  it('throws past the depth limit when given a message', () => {
    expect(() =>
      visitJson(nested(5), undefined, () => undefined, { maxDepth: 3, tooDeep: 'Too deep' }),
    ).toThrow('Too deep');
  });

  it('never walks an own __proto__ key and changes nothing', () => {
    const value = JSON.parse('{"a": {"x": 1}, "__proto__": {"x": 2}}') as JsonObject;
    const before = JSON.stringify(value);
    const xs: unknown[] = [];
    visitJson(value, undefined, (o) => void xs.push(o.x), { maxDepth: 10 });
    expect(xs).toEqual([undefined, 1]);
    expect(JSON.stringify(value)).toBe(before);
  });
});

describe('mapJson', () => {
  it('rebuilds bottom up: leave gets the copy with its members mapped, and the original', () => {
    const value = { n: 1, kids: [{ n: 2 }, { n: 3, kids: [{ n: 4 }] }] };
    const order: number[] = [];
    const out = mapJson(
      value,
      (copy, original) => {
        order.push(original.n as number);
        expect(copy).not.toBe(original);
        return { ...copy, n: (copy.n as number) * 10 };
      },
      { maxDepth: 10 },
    );
    expect(order).toEqual([2, 4, 3, 1]);
    expect(out).toEqual({ n: 10, kids: [{ n: 20 }, { n: 30, kids: [{ n: 40 }] }] });
    // The input is left as it was.
    expect(value).toEqual({ n: 1, kids: [{ n: 2 }, { n: 3, kids: [{ n: 4 }] }] });
  });

  it('leaves leaves as they are and drops own __proto__ keys from the copy', () => {
    const value = JSON.parse('{"s": "text", "n": null, "__proto__": {"polluted": true}}');
    const out = mapJson(value, (copy) => copy, { maxDepth: 10 }) as JsonObject;
    expect(out).toEqual({ s: 'text', n: null });
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false);
    expect(({} as JsonObject).polluted).toBeUndefined();
  });

  it('throws past the depth limit when given a message', () => {
    expect(() =>
      mapJson(nested(5), (c) => c, { maxDepth: 3, tooDeep: 'The document nests too deeply' }),
    ).toThrow('The document nests too deeply');
    // Any value past the limit counts, a leaf too: nested(3)'s `true` is at depth 3.
    expect(mapJson(nested(3), (c) => c, { maxDepth: 3, tooDeep: 'x' })).toEqual(nested(3));
    expect(() => mapJson(nested(4), (c) => c, { maxDepth: 3, tooDeep: 'x' })).toThrow('x');
  });
});
