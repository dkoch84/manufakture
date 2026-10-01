import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { meshProperties } from './mesh';
import { placementMatrix } from './placement';
import {
  CORE_NAMESPACE,
  MATERIALS_NAMESPACE,
  MODEL_PATH,
  MODEL_SETTINGS_PATH,
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

  it('never claims to be Bambu Studio or OrcaSlicer', () => {
    for (const application of ['BambuStudio-02.08.02.61', 'OrcaSlicer 2.4.2', 'orca']) {
      expect(() => write3mf(bodies(), { application })).toThrow(/must not claim/);
    }
    expect(parse3mf(write3mf(bodies(), { application: 'manufakture 0.3' })).metadata).toEqual({
      Application: 'manufakture 0.3',
    });
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

describe('colours', () => {
  const box = (x: number) => boxMesh([x, 0, 0], [10, 10, 10]);
  const text = (bytes: Uint8Array, path = MODEL_PATH) =>
    new TextDecoder().decode(unzipSync(bytes)[path]);

  it('two bodies with two colours: two colour groups, prefix m, pid and pindex 0 on each', () => {
    const bytes = write3mf([
      { name: 'Red', mesh: box(0), color: '#ff0000' },
      { name: 'Blue', mesh: box(20), color: '#0000FF' },
    ]);
    const model = text(bytes);
    expect(model).toContain(
      `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NAMESPACE}" xmlns:m="${MATERIALS_NAMESPACE}">`,
    );
    expect(model).toContain(
      ' <resources>\n  <m:colorgroup id="1">\n   <m:color color="#FF0000"/>\n  </m:colorgroup>\n' +
        '  <m:colorgroup id="2">\n   <m:color color="#0000FF"/>\n  </m:colorgroup>\n',
    );
    expect(model).toContain('<object id="3" name="Red" type="model" pid="1" pindex="0">');
    expect(model).toContain('<object id="4" name="Blue" type="model" pid="2" pindex="0">');
    expect(model).not.toContain('requiredextensions');
    expect(Object.keys(unzipSync(bytes))).not.toContain(MODEL_SETTINGS_PATH);

    const r = validate3mf(bytes);
    expect(r.problems).toEqual([]);
    const parsed = r.parsed!;
    expect(parsed.colorGroups).toEqual([
      { id: 1, colors: ['#FF0000'], namespace: MATERIALS_NAMESPACE },
      { id: 2, colors: ['#0000FF'], namespace: MATERIALS_NAMESPACE },
    ]);
    expect(parsed.objects.map((o) => [o.id, o.name, o.pid, o.pindex, o.color])).toEqual([
      [3, 'Red', 1, 0, '#FF0000'],
      [4, 'Blue', 2, 0, '#0000FF'],
    ]);
    expect(parsed.items.map((i) => i.objectId)).toEqual([3, 4]);
  });

  it('three bodies in two colours: two groups, in first-use order; uncoloured bodies stay plain', () => {
    const parsed = parse3mf(
      write3mf([
        { name: 'A', mesh: box(0), color: '#00ff00' },
        { name: 'Plain', mesh: box(20) },
        { name: 'B', mesh: box(40), color: '#ff00ff' },
        { name: 'C', mesh: box(60), color: '#00FF00' },
      ]),
    );
    expect(parsed.colorGroups.map((g) => [g.id, g.colors])).toEqual([
      [1, ['#00FF00']],
      [2, ['#FF00FF']],
    ]);
    expect(parsed.objects.map((o) => [o.name, o.pid, o.pindex, o.color])).toEqual([
      ['A', 1, 0, '#00FF00'],
      ['Plain', null, null, null],
      ['B', 2, 0, '#FF00FF'],
      ['C', 1, 0, '#00FF00'],
    ]);
  });

  it('writes no materials namespace without colours, and refuses what is not #rrggbb', () => {
    expect(text(write3mf(bodies()))).not.toContain('xmlns:m');
    for (const color of ['red', '#f00', '#ff000080', 'ff0000', '#gg0000']) {
      expect(() => write3mf([{ name: 'x', mesh: box(0), color }])).toThrow(/is not #rrggbb/);
    }
  });
});

describe('transform round trips', () => {
  const box = boxMesh([0, 0, 0], [20, 20, 10]);
  // A quarter turn about x and a move, a half turn about z, and an arbitrary rotation.
  const quarter = [1, 0, 0, 0, 0, 1, 0, -1, 0, 90, 135, 0];
  const half = [-1, 0, 0, 0, -1, 0, 0, 0, 1, 12.5, -7.25, 0.001];
  const odd = placementMatrix({ translation: [1 / 3, 200, -5], rotation: [0.1, 0.2, 0.3, 0.9] });
  const write = (items: { object: number; transform: readonly number[] }[]) =>
    write3mf([{ name: 'Box', mesh: box, color: '#123456' }], { items });

  it('reads back exactly what was written', () => {
    const parsed = parse3mf(
      write([
        { object: 0, transform: quarter },
        { object: 0, transform: half },
      ]),
    );
    expect(parsed.items.map((i) => i.transform)).toEqual([quarter, half]);
  });

  it('keeps any rigid transform to 1e-9, and writing it again changes nothing', () => {
    const once = write([{ object: 0, transform: odd }]);
    const back = parse3mf(once).items[0]!.transform!;
    back.forEach((v, i) => expect(Math.abs(v - odd[i]!)).toBeLessThanOrEqual(5e-10));
    const twice = write([{ object: 0, transform: back }]);
    expect(new TextDecoder().decode(unzipSync(twice)[MODEL_PATH])).toBe(
      new TextDecoder().decode(unzipSync(once)[MODEL_PATH]),
    );
    expect(validate3mf(once).problems).toEqual([]);
  });

  it('refuses a transform that scales or shears', () => {
    const scaled = [2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0];
    const sheared = [1, 0, 0, 0.5, 1, 0, 0, 0, 1, 0, 0, 0];
    expect(() => write([{ object: 0, transform: scaled }])).toThrow(/not rigid/);
    expect(() => write([{ object: 0, transform: sheared }])).toThrow(/not rigid/);
  });
});

describe('components with model settings', () => {
  /** A two-colour part kept as one object, placed twice, and a plain lid. */
  const objects = (): ThreeMfObjectInput[] => [
    { name: 'Plate', mesh: boxMesh([0, 0, 0], [10, 10, 2]), color: '#ff0000' },
    { name: 'Peg', mesh: boxMesh([4, 4, 2], [2, 2, 6]), color: '#0000ff' },
    { name: 'Base', components: [{ object: 0 }, { object: 1 }] },
    { name: 'Lid & "top"', mesh: boxMesh([0, 0, 0], [10, 10, 1]) },
  ];
  const turned = placementMatrix({
    translation: [100, 0, 0],
    rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
  });
  const items = [{ object: 2 }, { object: 2, transform: turned }, { object: 3 }];

  it('writes a model_settings.config naming every built object and each part, with slots', () => {
    const files = unzipSync(write3mf(objects(), { items }));
    expect(Object.keys(files).sort()).toEqual([
      '3D/3dmodel.model',
      MODEL_SETTINGS_PATH,
      '[Content_Types].xml',
      '_rels/.rels',
    ]);
    expect(new TextDecoder().decode(files['[Content_Types].xml'])).toContain(
      '<Default Extension="config" ContentType="text/xml"/>',
    );
    expect(new TextDecoder().decode(files[MODEL_SETTINGS_PATH])).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<config>',
        '  <object id="5">',
        '    <metadata key="name" value="Base"/>',
        '    <metadata key="extruder" value="1"/>',
        '    <part id="3" subtype="normal_part">',
        '      <metadata key="name" value="Plate"/>',
        '      <metadata key="extruder" value="1"/>',
        '    </part>',
        '    <part id="4" subtype="normal_part">',
        '      <metadata key="name" value="Peg"/>',
        '      <metadata key="extruder" value="2"/>',
        '    </part>',
        '  </object>',
        '  <object id="6">',
        '    <metadata key="name" value="Lid &amp; &quot;top&quot;"/>',
        '  </object>',
        '</config>',
        '',
      ].join('\n'),
    );
  });

  it('round-trips: objects, colours, components, settings, transforms and placed meshes', () => {
    const bytes = write3mf(objects(), { items, title: 'Two-colour base' });
    const r = validate3mf(bytes);
    expect(r.problems).toEqual([]);
    const parsed = r.parsed!;
    expect(parsed.metadata).toEqual({ Application: 'manufakture', Title: 'Two-colour base' });
    expect(
      parsed.objects.map((o) => [o.id, o.name, o.color, o.components.map((c) => c.objectId)]),
    ).toEqual([
      [3, 'Plate', '#FF0000', []],
      [4, 'Peg', '#0000FF', []],
      [5, 'Base', null, [3, 4]],
      [6, 'Lid & "top"', null, []],
    ]);
    expect(parsed.items.map((i) => [i.objectId, i.transform])).toEqual([
      [5, null],
      [5, turned.map((v) => Number(v.toFixed(9)))],
      [6, null],
    ]);
    expect(parsed.modelSettings).toEqual([
      {
        id: 5,
        metadata: { name: 'Base', extruder: '1' },
        parts: [
          { id: 3, subtype: 'normal_part', metadata: { name: 'Plate', extruder: '1' } },
          { id: 4, subtype: 'normal_part', metadata: { name: 'Peg', extruder: '2' } },
        ],
      },
      { id: 6, metadata: { name: 'Lid & "top"' }, parts: [] },
    ]);
    const built = buildMeshes(parsed);
    expect(built.map((m) => [m.name, m.color])).toEqual([
      ['Plate', '#FF0000'],
      ['Peg', '#0000FF'],
      ['Plate', '#FF0000'],
      ['Peg', '#0000FF'],
      ['Lid & "top"', null],
    ]);
    const min = meshProperties(built[2]!.mesh).boundingBox!.min;
    min.forEach((v, i) => expect(v).toBeCloseTo([90, 0, 0][i]!, 4));

    // Rewriting what was read gives the same model and settings.
    const rewritten = write3mf(
      [
        { name: 'Plate', mesh: parsed.objects[0]!.mesh, color: parsed.objects[0]!.color! },
        { name: 'Peg', mesh: parsed.objects[1]!.mesh, color: parsed.objects[1]!.color! },
        { name: 'Base', components: [{ object: 0 }, { object: 1 }] },
        { name: parsed.objects[3]!.name, mesh: parsed.objects[3]!.mesh },
      ],
      {
        title: 'Two-colour base',
        items: parsed.items.map((i) => ({
          object: i.objectId - 3,
          ...(i.transform ? { transform: i.transform } : {}),
        })),
      },
    );
    const files = (b: Uint8Array) => unzipSync(b);
    for (const path of [MODEL_PATH, MODEL_SETTINGS_PATH]) {
      expect(new TextDecoder().decode(files(rewritten)[path])).toBe(
        new TextDecoder().decode(files(bytes)[path]),
      );
    }
  });
});

describe('validate3mf: colours, transforms, components and settings', () => {
  const objects = (): ThreeMfObjectInput[] => [
    { name: 'Plate', mesh: boxMesh([0, 0, 0], [10, 10, 2]), color: '#ff0000' },
    { name: 'Peg', mesh: boxMesh([4, 4, 2], [2, 2, 6]), color: '#0000ff' },
    { name: 'Base', components: [{ object: 0 }, { object: 1 }] },
  ];
  const lifted = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 50];
  const base = () => unzipSync(write3mf(objects(), { items: [{ object: 2, transform: lifted }] }));
  const decode = (b: Uint8Array) => new TextDecoder().decode(b);
  /** The package with the model (and optionally the settings) text edited. */
  const edit = (model: (t: string) => string, settings: (t: string) => string = (t) => t) => {
    const files = base();
    return zipSync({
      ...files,
      [MODEL_PATH]: strToU8(model(decode(files[MODEL_PATH]!))),
      [MODEL_SETTINGS_PATH]: strToU8(settings(decode(files[MODEL_SETTINGS_PATH]!))),
    });
  };
  const problems = (bytes: Uint8Array) => validate3mf(bytes).problems;

  it('passes the unedited file', () => {
    expect(problems(edit((t) => t))).toEqual([]);
  });

  it('finds a dangling pid, a pindex outside its group and a pid without a pindex', () => {
    expect(problems(edit((t) => t.replace('pid="2" pindex="0"', 'pid="9" pindex="0"')))).toContain(
      'object 4: pid 9 names no property group',
    );
    expect(problems(edit((t) => t.replace('pid="2" pindex="0"', 'pid="2" pindex="1"')))).toContain(
      'object 4: pindex 1 is outside colour group 2',
    );
    expect(problems(edit((t) => t.replace('pid="2" pindex="0"', 'pid="2"')))).toContain(
      'object 4 has a pid without a pindex',
    );
    expect(problems(edit((t) => t.replace('pid="2" pindex="0"', 'pindex="0"')))).toContain(
      'object 4 has a pindex without a pid',
    );
  });

  it('accepts a pid naming base materials, which are core', () => {
    const withBase = edit((t) =>
      t
        .replace(
          ' <resources>\n',
          ' <resources>\n  <basematerials id="7">\n   <base name="PLA" displaycolor="#FFFFFF"/>\n  </basematerials>\n',
        )
        .replace('pid="2" pindex="0"', 'pid="7" pindex="0"'),
    );
    expect(problems(withBase)).toEqual([]);
  });

  it('finds a colour group outside the materials namespace, a bad colour and a reused id', () => {
    expect(
      problems(edit((t) => t.replace(`xmlns:m="${MATERIALS_NAMESPACE}"`, 'xmlns:m="urn:other"'))),
    ).toEqual([
      'colour group 1 is not in the materials namespace',
      'colour group 2 is not in the materials namespace',
    ]);
    expect(problems(edit((t) => t.replace('color="#0000FF"', 'color="blue"')))).toContain(
      'colour group 2: blue is not a colour',
    );
    expect(
      problems(edit((t) => t.replace('<m:colorgroup id="2">', '<m:colorgroup id="3">'))),
    ).toContain('resource id 3 is used twice (object 3)');
  });

  it('finds a non-rigid transform', () => {
    const scaled = edit((t) =>
      t.replace('transform="1 0 0 0 1 0 0 0 1 0 0 50"', 'transform="1.5 0 0 0 1 0 0 0 1 0 0 50"'),
    );
    expect(problems(scaled)).toEqual([
      'the build item of object 5: the transform scales or shears the object (it is not rigid)',
    ]);
  });

  it('finds a missing component', () => {
    expect(
      problems(edit((t) => t.replace('<component objectid="4"/>', '<component objectid="8"/>'))),
    ).toContain('object 5: a component names object 8, which does not exist');
  });

  it('finds settings naming a missing object, a part that is not a component, a bad slot', () => {
    expect(
      problems(
        edit(
          (t) => t,
          (c) => c.replace('<object id="5">', '<object id="6">'),
        ),
      ),
    ).toEqual(['Metadata/model_settings.config names object 6, which does not exist']);
    expect(
      problems(
        edit(
          (t) => t,
          (c) => c.replace('<part id="4"', '<part id="2"'),
        ),
      ),
    ).toEqual(['Metadata/model_settings.config: object 5 has no component object 2']);
    expect(
      problems(
        edit(
          (t) => t,
          (c) => c.replace('value="2"', 'value="0"'),
        ),
      ),
    ).toEqual([
      'Metadata/model_settings.config: part 4 of object 5 has extruder 0, not a slot number from 1',
    ]);
  });
});
