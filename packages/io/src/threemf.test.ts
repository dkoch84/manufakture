import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { meshProperties } from './mesh';
import { placementMatrix } from './placement';
import {
  CORE_NAMESPACE,
  MODEL_PATH,
  buildMeshes,
  parse3mf,
  validate3mf,
  write3mf,
  type ThreeMfObjectInput,
} from './threemf';
import { boxMesh } from './test-helpers';

const bodies = () => [
  { name: 'Bracket & "pin" <v2>', mesh: boxMesh([0, 0, 0], [10, 20, 5]) },
  { name: 'Pin', mesh: boxMesh([30, 0, 0], [2, 2, 8]) },
];

describe('write3mf', () => {
  it('writes the three package parts of the 3MF core spec', () => {
    const files = unzipSync(write3mf(bodies()));
    expect(Object.keys(files).sort()).toEqual([
      '3D/3dmodel.model',
      '[Content_Types].xml',
      '_rels/.rels',
    ]);
    const text = (p: string) => new TextDecoder().decode(files[p]);
    expect(text('[Content_Types].xml')).toContain(
      'Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"',
    );
    expect(text('_rels/.rels')).toContain('Target="/3D/3dmodel.model"');
    const model = text(MODEL_PATH);
    expect(model).toContain(`<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NAMESPACE}">`);
    expect(model).toContain('name="Bracket &amp; &quot;pin&quot; &lt;v2&gt;"');
    expect(model).not.toMatch(/e[+-]\d/);
  });

  it('parses back: unit, names, one object and build item per body, geometry', () => {
    const parsed = parse3mf(write3mf(bodies(), { title: 'Demo' }));
    expect(parsed.unit).toBe('millimeter');
    expect(parsed.metadata).toEqual({ Application: 'manufakture', Title: 'Demo' });
    expect(parsed.objects.map((o) => [o.id, o.name, o.type])).toEqual([
      [1, 'Bracket & "pin" <v2>', 'model'],
      [2, 'Pin', 'model'],
    ]);
    expect(parsed.items).toEqual([
      { objectId: 1, transform: null },
      { objectId: 2, transform: null },
    ]);
    expect(parsed.objects.map((o) => o.components)).toEqual([[], []]);
    expect(meshProperties(parsed.objects[0]!.mesh).volume).toBeCloseTo(1000, 6);
    expect(meshProperties(parsed.objects[1]!.mesh).volume).toBeCloseTo(32, 6);
  });

  it('keeps tabs and newlines in names as references, and drops what XML cannot hold', () => {
    const name = 'a\tb\nc\rd\u0001e\uFFFEf\uFFFFg\uD800h\uDC00i\u{1F600}';
    const bytes = write3mf([{ name, mesh: boxMesh([0, 0, 0], [1, 1, 1]) }], { title: name });
    const model = new TextDecoder().decode(unzipSync(bytes)[MODEL_PATH]);
    expect(model).toContain('name="a&#x9;b&#xA;c&#xD;defghi\u{1F600}"');
    expect(model).toContain('<metadata name="Title">a&#x9;b&#xA;c&#xD;defghi\u{1F600}</metadata>');
    const parsed = parse3mf(bytes);
    expect(parsed.objects[0]!.name).toBe('a\tb\nc\rdefghi\u{1F600}');
    expect(validate3mf(bytes).problems).toEqual([]);
  });

  it('refuses an empty file', () => {
    expect(() => write3mf([])).toThrow(RangeError);
  });
});

describe('validate3mf', () => {
  it('passes what write3mf writes', () => {
    const r = validate3mf(write3mf(bodies()));
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.objects.every((o) => o.manifold.ok)).toBe(true);
  });

  /** A package with the given model text, and the right parts otherwise. */
  const pack = (model: string, contentTypes?: string) => {
    const base = unzipSync(write3mf(bodies()));
    return zipSync({
      '[Content_Types].xml': contentTypes ? strToU8(contentTypes) : base['[Content_Types].xml']!,
      '_rels/.rels': base['_rels/.rels']!,
      [MODEL_PATH]: strToU8(model),
    });
  };
  const model = () => new TextDecoder().decode(unzipSync(write3mf(bodies()))[MODEL_PATH]);

  it('finds a unit that is not millimetres', () => {
    const r = validate3mf(pack(model().replace('unit="millimeter"', 'unit="inch"')));
    expect(r.problems).toContain('the unit is inch, not millimeter');
  });

  it('finds an open mesh and a flipped triangle', () => {
    const open = model().replace(/<triangle [^>]*\/>\n/, '');
    expect(validate3mf(pack(open)).problems.some((p) => /object 1 .*open edge/.test(p))).toBe(true);
    const flipped = model().replace(
      /<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\/>/,
      '<triangle v1="$1" v2="$3" v3="$2"/>',
    );
    expect(validate3mf(pack(flipped)).problems.some((p) => /inconsistent winding/.test(p))).toBe(
      true,
    );
  });

  it('finds build items without an object, a missing content type and a bad index', () => {
    const r = validate3mf(pack(model().replace('<item objectid="2"/>', '<item objectid="7"/>')));
    expect(r.problems).toContain('a build item names object 7, which does not exist');
    const noType = validate3mf(
      pack(
        model(),
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
      ),
    );
    expect(noType.problems).toContain('no 3D model content type');
    const bad = validate3mf(pack(model().replace('v1="0"', 'v1="999"')));
    expect(bad.problems).toContain('object 1: a triangle names a vertex that does not exist');
  });

  it('reports a file that is not a package', () => {
    const r = validate3mf(new TextEncoder().encode('not a zip'));
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/not a zip package/);
  });
});

describe('components and build transforms', () => {
  const turned = placementMatrix({
    translation: [100, 0, 0],
    rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
  });
  const lifted = placementMatrix({ translation: [0, 0, 50], rotation: [0, 0, 0, 1] });
  /** A part of two bodies (a plate and a peg) and a part of one, as an assembly writes them. */
  const objects = (): ThreeMfObjectInput[] => [
    { name: 'Plate', mesh: boxMesh([0, 0, 0], [10, 10, 2]) },
    { name: 'Peg', mesh: boxMesh([4, 4, 2], [2, 2, 6]) },
    { name: 'Base', components: [{ object: 0 }, { object: 1 }] },
    { name: 'Lid', mesh: boxMesh([0, 0, 0], [10, 10, 1]) },
  ];
  const items = [{ object: 2 }, { object: 2, transform: turned }, { object: 3, transform: lifted }];

  it('writes components and one build item per placement, transforms without exponents', () => {
    const bytes = write3mf(objects(), { items });
    const model = new TextDecoder().decode(unzipSync(bytes)[MODEL_PATH]);
    expect(model).toContain(
      '<object id="3" name="Base" type="model">\n   <components>\n    <component objectid="1"/>\n    <component objectid="2"/>\n   </components>',
    );
    expect(model).toContain('<item objectid="3"/>');
    expect(model).toContain('<item objectid="3" transform="0 1 0 -1 0 0 0 0 1 100 0 0"/>');
    expect(model).toContain('<item objectid="4" transform="1 0 0 0 1 0 0 0 1 0 0 50"/>');
    expect(model).not.toMatch(/e[+-]\d/);
  });

  it('parses back components and transforms, and builds the placed meshes', () => {
    const bytes = write3mf(objects(), { items });
    const r = validate3mf(bytes);
    expect(r.problems).toEqual([]);
    const parsed = r.parsed!;
    expect(parsed.objects[2]!.components).toEqual([
      { objectId: 1, transform: null },
      { objectId: 2, transform: null },
    ]);
    expect(parsed.objects[2]!.mesh.indices).toHaveLength(0);
    expect(parsed.items.map((i) => i.objectId)).toEqual([3, 3, 4]);
    parsed.items[1]!.transform!.forEach((v, i) => expect(v).toBeCloseTo(turned[i]!, 9));
    // Only mesh objects are checked for watertightness.
    expect(r.objects.map((o) => o.name)).toEqual(['Plate', 'Peg', 'Lid']);

    const built = buildMeshes(parsed);
    expect(built.map((m) => m.name)).toEqual(['Plate', 'Peg', 'Plate', 'Peg', 'Lid']);
    const box = (i: number) => meshProperties(built[i]!.mesh).boundingBox!;
    box(2).min.forEach((v, i) => expect(v).toBeCloseTo([90, 0, 0][i]!, 4));
    box(2).max.forEach((v, i) => expect(v).toBeCloseTo([100, 10, 2][i]!, 4));
    expect(box(4).min[2]).toBeCloseTo(50, 4);
    expect(meshProperties(built[3]!.mesh).volume).toBeCloseTo(24, 4);
  });

  it('places components inside an object by their own transforms, then the item', () => {
    const shifted = placementMatrix({ translation: [0, 20, 0], rotation: [0, 0, 0, 1] });
    const bytes = write3mf(
      [
        { name: 'Cube', mesh: boxMesh([0, 0, 0], [1, 1, 1]) },
        { name: 'Pair', components: [{ object: 0 }, { object: 0, transform: shifted }] },
      ],
      { items: [{ object: 1, transform: turned }] },
    );
    expect(validate3mf(bytes).problems).toEqual([]);
    const built = buildMeshes(parse3mf(bytes));
    const min = (i: number) => meshProperties(built[i]!.mesh).boundingBox!.min;
    // (0, 20, 0) turned a quarter about z is (-20, 0, 0); then (100, 0, 0).
    min(1).forEach((v, i) => expect(v).toBeCloseTo([79, 0, 0][i]!, 4));
  });

  it('refuses to write a component that is not defined before it, a mirror and a bad item', () => {
    const mirror = [-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    expect(() => write3mf([{ name: 'Loop', components: [{ object: 0 }] }])).toThrow(
      /must be an object before it/,
    );
    expect(() => write3mf([{ name: 'Empty', components: [] }])).toThrow(/no components/);
    expect(() => write3mf(objects(), { items: [{ object: 3, transform: mirror }] })).toThrow(
      /mirrors/,
    );
    expect(() => write3mf(objects(), { items: [{ object: 9 }] })).toThrow(/not in the list/);
    expect(() => write3mf(objects(), { items: [] })).toThrow(/at least one item/);
  });

  it('validate3mf finds bad components and transforms', () => {
    const model = new TextDecoder().decode(unzipSync(write3mf(objects(), { items }))[MODEL_PATH]);
    const pack = (text: string) => {
      const base = unzipSync(write3mf(objects(), { items }));
      return zipSync({ ...base, [MODEL_PATH]: strToU8(text) });
    };
    const forward = validate3mf(
      pack(model.replace('<component objectid="2"/>', '<component objectid="4"/>')),
    );
    expect(forward.problems).toContain(
      'object 3: a component names object 4, which is not defined before it',
    );
    const mirrored = validate3mf(
      pack(
        model.replace(
          'transform="1 0 0 0 1 0 0 0 1 0 0 50"',
          'transform="-1 0 0 0 1 0 0 0 1 0 0 50"',
        ),
      ),
    );
    expect(mirrored.problems).toContain(
      'the build item of object 4: the transform mirrors or flattens the object',
    );
    const short = validate3mf(
      pack(model.replace('transform="1 0 0 0 1 0 0 0 1 0 0 50"', 'transform="1 0 0"')),
    );
    expect(short.problems).toContain('the build item of object 4: the transform is not 12 numbers');
    const cycle = parse3mf(
      pack(model.replace('<component objectid="2"/>', '<component objectid="3"/>')),
    );
    expect(() => buildMeshes(cycle)).toThrow(/contains itself/);
  });
});
