import { describe, expect, it } from 'vitest';
import { ScriptHandle } from './host';
import { parseParamDeclarations, resolveParams, type ParamSpec } from './params';

function specs(value: Parameters<typeof parseParamDeclarations>[0]): ParamSpec[] {
  const out = parseParamDeclarations(value);
  if (!out.ok) throw new Error(out.error.message);
  return out.value;
}

describe('parameter declarations', () => {
  it('reads every kind in declaration order', () => {
    const list = specs({
      width: { kind: 'length', default: 40, min: 1, max: 500, label: 'Width' },
      count: { kind: 'number', default: 6, integer: true },
      tilt: { kind: 'angle', default: 0.5 },
      rounded: { kind: 'boolean', default: true, description: 'Round the edges' },
      style: { kind: 'choice', options: ['round', 'square'], default: 'square' },
      face: { kind: 'reference', select: 'face', optional: true },
    });
    expect(list.map((p) => [p.name, p.kind])).toEqual([
      ['width', 'length'],
      ['count', 'number'],
      ['tilt', 'angle'],
      ['rounded', 'boolean'],
      ['style', 'choice'],
      ['face', 'reference'],
    ]);
    expect(list[0]).toEqual({
      name: 'width',
      kind: 'length',
      default: 40,
      min: 1,
      max: 500,
      label: 'Width',
    });
  });

  it('treats a missing params export as no parameters', () => {
    expect(specs(undefined)).toEqual([]);
  });

  it.each([
    [[1], 'must be an object'],
    [{ 'bad name': { kind: 'number', default: 1 } }, 'identifier'],
    [{ a: { kind: 'vector', default: 1 } }, 'kind must be one of'],
    [{ a: { kind: 'number', default: 1, step: 2 } }, 'unknown field step'],
    [{ a: { kind: 'length', default: 1, integer: true } }, 'unknown field integer'],
    [{ a: { kind: 'number', default: Number.NaN } }, 'finite'],
    [{ a: { kind: 'number', default: 5, min: 10 } }, 'default does not fit'],
    [{ a: { kind: 'number', default: 5, min: 10, max: 1 } }, 'min is greater than max'],
    [{ a: { kind: 'number', default: 1.5, integer: true } }, 'whole number'],
    [{ a: { kind: 'boolean', default: 1 } }, 'true or false'],
    [{ a: { kind: 'choice', options: [], default: 'x' } }, 'options'],
    [{ a: { kind: 'choice', options: ['x', 'x'], default: 'x' } }, 'distinct'],
    [{ a: { kind: 'choice', options: ['x'], default: 'y' } }, 'one of the options'],
    [{ a: { kind: 'reference', select: 'solid' } }, 'select'],
    [{ a: { kind: 'number', default: 1, label: 'x'.repeat(501) } }, 'short strings'],
  ])('refuses %j', (value, message) => {
    const out = parseParamDeclarations(value as never);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('bad-declaration');
      expect(out.error.message).toContain(message);
    }
  });
});

describe('resolving values', () => {
  const list = specs({
    width: { kind: 'length', default: 40, min: 1 },
    count: { kind: 'number', default: 6, integer: true },
    style: { kind: 'choice', options: ['round', 'square'], default: 'round' },
    face: { kind: 'reference', select: 'face', optional: true },
    edges: { kind: 'reference', select: 'edge', multiple: true, optional: true },
  });

  it('fills defaults and drops names the script no longer declares', () => {
    const h = new ScriptHandle('face', 1);
    const out = resolveParams(list, { width: 12, face: h, removed: 3 });
    expect(out.ok && out.value).toEqual({
      width: 12,
      count: 6,
      style: 'round',
      face: h,
      edges: [],
    });
  });

  it.each([
    [{ width: 0 }, 'less than 1'],
    [{ width: Number.NaN }, 'not a finite number'],
    [{ count: 2.5 }, 'not a whole number'],
    [{ style: 'oval' }, 'not one of the options'],
    [{ face: 'f1' }, 'not a reference'],
    [{ edges: [1] }, 'not a list of references'],
  ])('refuses %j', (values, message) => {
    const out = resolveParams(list, values);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatchObject({ code: 'bad-param' });
    if (!out.ok) expect(out.error.message).toContain(message);
  });

  it('requires a reference that is not optional', () => {
    const required = specs({ face: { kind: 'reference', select: 'face' } });
    expect(resolveParams(required, {}).ok).toBe(false);
  });
});
