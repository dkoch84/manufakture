import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { meshProperties } from './mesh';
import { CORE_NAMESPACE, MODEL_PATH, parse3mf, validate3mf, write3mf } from './threemf';
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
