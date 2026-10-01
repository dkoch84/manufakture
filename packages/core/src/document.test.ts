import { evaluate } from '@manufakture/units';
import { describe, expect, it } from 'vitest';
import { applyCommand } from './commands';
import {
  bareUnits,
  createDocument,
  findFeature,
  findPart,
  isFeatureActive,
  storedExpression,
} from './document';
import type { DisplayUnits } from './schema';
import { PART, bracket, unwrap } from './test-helpers';
import { validateDocument } from './validate';

describe('bareUnits', () => {
  it.each<[DisplayUnits['length'], DisplayUnits['angle'], string, string]>([
    [{ unit: 'mm' }, { unit: 'deg' }, 'mm', 'deg'],
    [{ unit: 'cm', decimals: 2 }, { unit: 'rad' }, 'cm', 'rad'],
    [{ unit: 'm' }, { unit: 'deg' }, 'm', 'deg'],
    [{ unit: 'in' }, { unit: 'deg' }, 'in', 'deg'],
    [{ unit: 'ft' }, { unit: 'deg' }, 'ft', 'deg'],
    [{ unit: 'ft-in' }, { unit: 'deg' }, 'in', 'deg'],
    [{ unit: 'in-fraction', denominator: 64 }, { unit: 'rad' }, 'in', 'rad'],
  ])('%j and %j -> %s, %s', (length, angle, lengthUnit, angleUnit) => {
    expect(bareUnits({ length, angle })).toEqual({ lengthUnit, angleUnit });
  });

  it('stores what a bare number meant, so later unit changes do not change it', () => {
    const ftIn: DisplayUnits = { length: { unit: 'ft-in' }, angle: { unit: 'deg' } };
    const e = storedExpression('12', ftIn);
    expect(e).toEqual({ source: '12', lengthUnit: 'in', angleUnit: 'deg' });
    // Evaluated with its stored units, 12 is 12 inches, whatever the document shows now.
    const r = evaluate(e.source, { expected: 'length', lengthUnit: e.lengthUnit });
    expect(r.ok && r.value).toBeCloseTo(304.8, 9);
  });
});

describe('createDocument', () => {
  it('makes a valid, empty document at the current version', () => {
    const doc = createDocument({ id: 'abc', name: 'New' });
    expect(validateDocument(doc)).toEqual([]);
    expect(doc).toMatchObject({
      format: 'manufakture',
      version: 9,
      namingScheme: 1,
      variables: [],
      assemblies: [],
      print: { setups: [], nextIds: {} },
      fonts: [],
      nextIds: { part: 2 },
    });
    expect(doc.parts).toEqual([
      { id: PART, name: 'Part 1', features: [], rollbackIndex: null, nextIds: {}, bodies: [] },
    ]);
    expect(doc.units).toEqual({ length: { unit: 'mm' }, angle: { unit: 'deg' } });
  });

  it('takes display units', () => {
    const units: DisplayUnits = {
      length: { unit: 'in-fraction', denominator: 16 },
      angle: { unit: 'deg' },
    };
    expect(createDocument({ id: 'a', name: 'b', units }).units).toBe(units);
  });
});

describe('lookups and activity', () => {
  it('finds parts and features', () => {
    const doc = bracket();
    const part = findPart(doc, PART)!;
    expect(findFeature(part, 'extrude#2')?.kind).toBe('extrude');
    expect(findFeature(part, 'extrude#9')).toBeUndefined();
    expect(findPart(doc, 'part#2')).toBeUndefined();
  });

  it('treats suppressed features and features past the bar as inactive', () => {
    const doc = unwrap(
      applyCommand(bracket(), {
        type: 'batch',
        commands: [
          { type: 'suppressFeature', partId: PART, featureId: 'sketch#2', suppressed: true },
          { type: 'setRollback', partId: PART, index: 4 },
        ],
      }),
    ).document;
    const part = doc.parts[0]!;
    expect([0, 1, 2, 3, 4, 5].map((i) => isFeatureActive(part, i))).toEqual([
      true,
      true,
      false,
      true,
      false,
      false,
    ]);
  });
});
