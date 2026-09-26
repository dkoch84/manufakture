import { describe, expect, it } from 'vitest';
import type { CoreErrorCode } from './result';
import type {
  ExtrudeFeature,
  FilletFeature,
  ManufaktureDocument,
  PointRef,
  SketchFeature,
  StoredExpression,
} from './schema';
import { bracket, clone, mm } from './test-helpers';
import { checkDocument, validateDocument, variableOrder } from './validate';

type Mutation = (doc: ManufaktureDocument) => void;

const part = (doc: ManufaktureDocument) => doc.parts[0]!;
const feature = <T>(doc: ManufaktureDocument, id: string) =>
  part(doc).features.find((f) => f.id === id) as T;
const sketch1 = (doc: ManufaktureDocument) => feature<SketchFeature>(doc, 'sketch#1');
/** A coincident constraint of sketch#1, for editing its point references. */
const constraint = (doc: ManufaktureDocument, i: number) =>
  sketch1(doc).constraints[i] as { a: PointRef; b: PointRef };

describe('validateDocument', () => {
  it('accepts the bracket', () => {
    expect(validateDocument(bracket())).toEqual([]);
  });

  const cases: [string, Mutation, CoreErrorCode, string][] = [
    // ids
    [
      'feature id of another kind',
      (d) => void (part(d).features[1]!.id = 'fillet#1'),
      'invalid-id',
      'parts.0.features.1.id',
    ],
    [
      'feature id never allocated',
      (d) => void (part(d).nextIds.fillet = 1),
      'invalid-id',
      'parts.0.features.4.id',
    ],
    [
      'duplicate feature id',
      (d) => void (feature<ExtrudeFeature>(d, 'extrude#2').id = 'extrude#1'),
      'duplicate',
      'parts.0.features.3.id',
    ],
    [
      'entity id never allocated',
      (d) => void (part(d).nextIds.e = 5),
      'invalid-id',
      'parts.0.features.2',
    ],
    [
      'reference id never allocated',
      (d) => void (part(d).nextIds.r = 2),
      'invalid-id',
      'parts.0.features.4',
    ],
    [
      'entity id used in two sketches',
      (d) => void (feature<SketchFeature>(d, 'sketch#2').entities[0]!.id = 'e1'),
      'duplicate',
      'parts.0.features.2',
    ],
    [
      'reference id shared by two features',
      (d) => void (feature<FilletFeature>(d, 'fillet#1').edges[0]!.id = 'r1'),
      'duplicate',
      'parts.0.features.4',
    ],
    [
      'split of an unallocated id',
      (d) => void (sketch1(d).entities[0]!.id = 'e9#a'),
      'invalid-id',
      'parts.0.features.0',
    ],
    [
      'duplicate part id',
      (d) => void d.parts.push({ ...clone(part(d)), features: [] }),
      'duplicate',
      'parts.1.id',
    ],
    // rollback
    [
      'rollback past the end',
      (d) => void (part(d).rollbackIndex = 6),
      'invalid-index',
      'parts.0.rollbackIndex',
    ],
    // dependencies
    [
      'dependency after the feature',
      (d) => void part(d).features.reverse(),
      'dependency',
      'parts.0.features.0',
    ],
    [
      'profile of a missing sketch',
      (d) => void (feature<ExtrudeFeature>(d, 'extrude#1').profile.sketch = 'sketch#9'),
      'dependency',
      'parts.0.features.1',
    ],
    [
      'reference to a face of a missing feature',
      (d) =>
        void (feature<FilletFeature>(d, 'fillet#1').edges[0]!.ref = {
          faces: ['extrude#7:cap:end', 'extrude#1:side:e1'],
        }),
      'dependency',
      'parts.0.features.4',
    ],
    [
      'profile of a non-sketch',
      (d) => void (feature<ExtrudeFeature>(d, 'extrude#2').profile.sketch = 'extrude#1'),
      'kind-mismatch',
      'parts.0.features.3',
    ],
    // sketch internals
    [
      'a constraint on a missing curve',
      (d) => void (sketch1(d).constraints[1] = { id: 'k2', kind: 'horizontal', line: 'e5' }),
      'sketch',
      'parts.0.features.0.constraints.1.line',
    ],
    [
      'a point of a missing entity',
      (d) => void (constraint(d, 0).a = { entity: 'e9', at: 'end' }),
      'sketch',
      'parts.0.features.0.constraints.0.a',
    ],
    [
      'the center of a line',
      (d) => void (constraint(d, 0).a = { entity: 'e1', at: 'center' }),
      'sketch',
      'parts.0.features.0.constraints.0.a',
    ],
    [
      'a line as a point, without saying which end',
      (d) => void (constraint(d, 0).a = { entity: 'e1' }),
      'sketch',
      'parts.0.features.0.constraints.0.a',
    ],
    [
      'the start of a circle',
      (d) =>
        void (feature<SketchFeature>(d, 'sketch#2').constraints[0] = {
          id: 'k6',
          kind: 'fix',
          point: { entity: 'e5', at: 'start' },
        }),
      'sketch',
      'parts.0.features.2.constraints.0.point',
    ],
    [
      'an end of a point entity',
      (d) => {
        part(d).nextIds.e = 7;
        sketch1(d).entities.push({
          id: 'e6',
          kind: 'point',
          construction: false,
          position: [1, 1],
        });
        constraint(d, 0).a = { entity: 'e6', at: 'end' };
      },
      'sketch',
      'parts.0.features.0.constraints.0.a',
    ],
    [
      'a vertex of the origin',
      (d) => void (constraint(d, 4).b = { entity: '@origin', at: 'end' }),
      'sketch',
      'parts.0.features.0.constraints.4.b',
    ],
    [
      'an axis as a point',
      (d) => void (constraint(d, 4).b = { entity: '@x-axis' }),
      'sketch',
      'parts.0.features.0.constraints.4.b',
    ],
    // expressions
    [
      'unparsable feature expression',
      (d) => void (feature<FilletFeature>(d, 'fillet#1').radius = mm('2 +')),
      'expression',
      'parts.0.features.4.radius.source',
    ],
    [
      'feature expression with an unknown variable',
      (d) => void (feature<FilletFeature>(d, 'fillet#1').radius = mm('#depth / 2')),
      'unknown-variable',
      'parts.0.features.4.radius.source',
    ],
    [
      'sketch dimension with an unknown variable',
      (d) => void ((sketch1(d).constraints[2] as { value: StoredExpression }).value = mm('len')),
      'unknown-variable',
      'parts.0.features.0.constraints.2.value.source',
    ],
    // variables
    [
      'invalid variable name',
      (d) => void (d.variables[0]!.name = '2x'),
      'invalid-name',
      'variables.0.name',
    ],
    [
      'variable named like a function',
      (d) => void (d.variables[0]!.name = 'sqrt'),
      'invalid-name',
      'variables.0.name',
    ],
    [
      'duplicate variable',
      (d) => void (d.variables[1]!.name = 'thickness'),
      'duplicate',
      'variables.1.name',
    ],
    [
      'unparsable variable',
      (d) => void (d.variables[0]!.expression = mm('(')),
      'expression',
      'variables.0.expression.source',
    ],
    [
      'variable cycle',
      (d) => void (d.variables[1]!.expression = mm('height * 2')),
      'variable-cycle',
      'variables',
    ],
    [
      'self-referencing variable',
      (d) => void (d.variables[0]!.expression = mm('#thickness + 1')),
      'variable-cycle',
      'variables',
    ],
  ];

  it.each(cases)('%s', (_label, mutate, code, path) => {
    const doc = clone(bracket());
    mutate(doc);
    const issues = validateDocument(doc);
    expect(issues.map((i) => [i.code, i.path.join('.')])).toContainEqual([code, path]);
    const checked = checkDocument(doc);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.error.issues).toEqual(issues);
  });

  it('accepts built-in axes as curves and the origin as a point', () => {
    const doc = clone(bracket());
    sketch1(doc).constraints.push(
      { id: 'k7', kind: 'angle', a: 'e1', b: '@x-axis', value: mm('0') },
      { id: 'k8', kind: 'pointOnObject', point: { entity: 'e4', at: 'end' }, on: '@y-axis' },
      {
        id: 'k9',
        kind: 'symmetric',
        a: { entity: 'e1', at: 'start' },
        b: { entity: 'e1', at: 'end' },
        center: { entity: '@origin' },
      },
    );
    part(doc).nextIds.k = 10;
    expect(validateDocument(doc)).toEqual([]);
  });

  it('reports every problem, not only the first', () => {
    const doc = clone(bracket());
    feature<FilletFeature>(doc, 'fillet#1').radius = mm('nope');
    feature<ExtrudeFeature>(doc, 'extrude#1').extent = { type: 'blind', distance: mm('*') };
    expect(validateDocument(doc).map((i) => i.code)).toEqual(['expression', 'unknown-variable']);
  });

  it('carries the parser error range for highlighting', () => {
    const doc = clone(bracket());
    feature<FilletFeature>(doc, 'fillet#1').radius = mm('2 + * 3');
    const [issue] = validateDocument(doc);
    expect(issue?.unitsError).toMatchObject({ code: 'syntax' });
    expect(issue!.unitsError!.start).toBeGreaterThanOrEqual(0);
  });
});

describe('variableOrder', () => {
  it('orders variables after the ones they read', () => {
    const vars = [
      { name: 'c', expression: mm('a + b') },
      { name: 'b', expression: mm('a * 2') },
      { name: 'a', expression: mm('3') },
    ];
    expect(variableOrder(vars)).toEqual({ ok: true, value: ['a', 'b', 'c'] });
  });

  it('names the variables on a cycle', () => {
    const vars = [
      { name: 'a', expression: mm('1') },
      { name: 'b', expression: mm('d + a') },
      { name: 'c', expression: mm('b') },
      { name: 'd', expression: mm('c') },
    ];
    const r = variableOrder(vars);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('variable-cycle');
      expect(r.error.blockers).toEqual(['b', 'd', 'c']);
      expect(r.error.message).toBe('Variables reference each other: b -> d -> c -> b');
    }
  });
});
