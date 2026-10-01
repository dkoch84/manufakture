import { describe, expect, it } from 'vitest';
import {
  MAX_FILE_NAME_BYTES,
  NotWatertightError,
  export3mfAssembly,
  exportStlAssembly,
  fileName,
  type ExportAssembly,
} from './export';
import { checkManifold, type ManifoldReport } from './manifold';
import { meshProperties } from './mesh';
import { parseStl } from './stl';
import { boxMesh, soupOf } from './test-helpers';
import { buildMeshes, validate3mf } from './threemf';

describe('fileName', () => {
  it('replaces path separators, reserved and control characters', () => {
    expect(fileName('Demo part', 'stl')).toBe('Demo part.stl');
    expect(fileName('a/b\\c:d*e?"<>|f', 'stl')).toBe('a_b_c_d_e_f.stl');
    expect(fileName('tab\there\u007f', '3mf')).toBe('tab_here_.3mf');
    expect(fileName('  ', 'step')).toBe('export.step');
  });

  it('removes bidirectional controls, so a name cannot disguise its extension', () => {
    expect(fileName('invoice‮exe.stl', 'stl')).toBe('invoiceexe.stl.stl');
    const every = '‪‫‬‭‮⁦⁧⁨⁩‎‏؜';
    expect(fileName(`a${every}b`, 'stl')).toBe('ab.stl');
    expect(fileName(every, 'stl')).toBe('export.stl');
  });

  it('caps the name in UTF-8 bytes on a character boundary, without trailing dots', () => {
    const long = fileName('x'.repeat(1000), 'stl');
    expect(long).toBe(`${'x'.repeat(MAX_FILE_NAME_BYTES)}.stl`);
    // Four-byte characters: 50 fit, the 51st would split.
    const emoji = fileName('\u{1F600}'.repeat(60), 'stl');
    expect([...emoji.slice(0, -4)]).toHaveLength(MAX_FILE_NAME_BYTES / 4);
    expect(new TextEncoder().encode(emoji).length).toBe(MAX_FILE_NAME_BYTES + 4);
    expect(fileName(`${'y'.repeat(MAX_FILE_NAME_BYTES - 2)}. z`, 'stl')).toBe(
      `${'y'.repeat(MAX_FILE_NAME_BYTES - 2)}.stl`,
    );
    // An unpaired surrogate is not a character any file system name holds.
    expect(fileName('a\uD800b', 'stl')).toBe('a_b.stl');
  });
});

/** A base of two bodies, twice (once turned and moved), and a lid of one, lifted. */
const assembly = (): ExportAssembly => ({
  // Kernel-style meshes (a vertex per face corner): export welds them.
  bodies: [
    { name: 'Plate', mesh: soupOf(boxMesh([0, 0, 0], [10, 10, 2])) },
    { name: 'Peg', mesh: soupOf(boxMesh([4, 4, 2], [2, 2, 6])) },
    { name: 'Lid', mesh: soupOf(boxMesh([0, 0, 0], [10, 10, 1])) },
  ],
  parts: [
    { name: 'Base', bodies: [0, 1] },
    { name: 'Lid', bodies: [2] },
  ],
  instances: [
    { part: 0, name: 'Base <1>', placement: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] } },
    {
      part: 0,
      name: 'Base <2>',
      placement: { translation: [100, 0, 0], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
    },
    { part: 1, name: 'Lid <1>', placement: { translation: [0, 0, 50], rotation: [0, 0, 0, 1] } },
  ],
});

describe('assembly exports', () => {
  it('3MF: an object per body per instance, each placed by its own build item', () => {
    const r = validate3mf(export3mfAssembly(assembly(), { title: 'Fixture' }));
    expect(r.problems).toEqual([]);
    const parsed = r.parsed!;
    expect(parsed.metadata.Title).toBe('Fixture');
    // A part of several bodies: its bodies by their names; a part of one: the part's name.
    expect(parsed.objects.map((o) => [o.id, o.name, o.components.length])).toEqual([
      [1, 'Plate', 0],
      [2, 'Peg', 0],
      [3, 'Plate', 0],
      [4, 'Peg', 0],
      [5, 'Lid', 0],
    ]);
    expect(parsed.modelSettings).toBeNull();
    // The first base is unmoved: no transform is written for it.
    expect(parsed.items.map((i) => [i.objectId, i.transform === null])).toEqual([
      [1, true],
      [2, true],
      [3, false],
      [4, false],
      [5, false],
    ]);
    expect(parsed.items[2]!.transform).toEqual(parsed.items[3]!.transform);
    const built = buildMeshes(parsed);
    const volume = built.reduce((v, m) => v + meshProperties(m.mesh).volume, 0);
    expect(volume).toBeCloseTo(2 * (200 + 24) + 100, 3);
    const turnedPlate = meshProperties(built[2]!.mesh).boundingBox!;
    turnedPlate.min.forEach((v, i) => expect(v).toBeCloseTo([90, 0, 0][i]!, 4));
  });

  it('3MF: body colours become colour groups, one per colour, shared by every copy', () => {
    const a = assembly();
    const coloured: ExportAssembly = {
      ...a,
      bodies: [
        { ...a.bodies[0]!, color: '#1f77b4' },
        { ...a.bodies[1]!, color: '#d62728' },
        { ...a.bodies[2]!, color: '#1f77b4' },
      ],
    };
    const r = validate3mf(export3mfAssembly(coloured));
    expect(r.problems).toEqual([]);
    const parsed = r.parsed!;
    expect(parsed.colorGroups.map((g) => [g.id, g.colors])).toEqual([
      [1, ['#1F77B4']],
      [2, ['#D62728']],
    ]);
    expect(parsed.objects.map((o) => [o.name, o.pid, o.pindex])).toEqual([
      ['Plate', 1, 0],
      ['Peg', 2, 0],
      ['Plate', 1, 0],
      ['Peg', 2, 0],
      ['Lid', 1, 0],
    ]);
    expect(buildMeshes(parsed).map((m) => m.color)).toEqual([
      '#1F77B4',
      '#D62728',
      '#1F77B4',
      '#D62728',
      '#1F77B4',
    ]);
  });

  it('3MF: a part kept as one object is a components object per instance, with its settings', () => {
    const a = assembly();
    const together: ExportAssembly = {
      ...a,
      bodies: [
        { ...a.bodies[0]!, color: '#ff0000' },
        { ...a.bodies[1]!, color: '#0000ff' },
        a.bodies[2]!,
      ],
      parts: [{ ...a.parts[0]!, oneObject: true }, a.parts[1]!],
    };
    const r = validate3mf(export3mfAssembly(together));
    expect(r.problems).toEqual([]);
    const parsed = r.parsed!;
    // Groups 1 and 2, then per base instance two mesh objects and the base; then the lid.
    expect(parsed.objects.map((o) => [o.id, o.name, o.components.map((c) => c.objectId)])).toEqual([
      [3, 'Plate', []],
      [4, 'Peg', []],
      [5, 'Base', [3, 4]],
      [6, 'Plate', []],
      [7, 'Peg', []],
      [8, 'Base', [6, 7]],
      [9, 'Lid', []],
    ]);
    expect(parsed.items.map((i) => i.objectId)).toEqual([5, 8, 9]);
    expect(
      parsed.modelSettings!.map((o) => [
        o.id,
        o.metadata,
        o.parts.map((p) => [p.id, p.metadata.name, p.metadata.extruder]),
      ]),
    ).toEqual([
      [
        5,
        { name: 'Base', extruder: '1' },
        [
          [3, 'Plate', '1'],
          [4, 'Peg', '2'],
        ],
      ],
      [
        8,
        { name: 'Base', extruder: '1' },
        [
          [6, 'Plate', '1'],
          [7, 'Peg', '2'],
        ],
      ],
      [9, { name: 'Lid' }, []],
    ]);
    const built = buildMeshes(parsed);
    expect(built.map((m) => m.name)).toEqual(['Plate', 'Peg', 'Plate', 'Peg', 'Lid']);
    const turnedPlate = meshProperties(built[2]!.mesh).boundingBox!;
    turnedPlate.min.forEach((v, i) => expect(v).toBeCloseTo([90, 0, 0][i]!, 4));
  });

  it('STL: every instance moved into place, all merged into one file', () => {
    const file = exportStlAssembly(assembly(), { fileName: 'Fixture' });
    expect(file.name).toBe('Fixture.stl');
    const back = parseStl(file.bytes);
    const p = meshProperties(back.mesh);
    expect(p.volume).toBeCloseTo(2 * (200 + 24) + 100, 3);
    p.boundingBox!.min.forEach((v, i) => expect(v).toBeCloseTo([0, 0, 0][i]!, 4));
    p.boundingBox!.max.forEach((v, i) => expect(v).toBeCloseTo([100, 10, 51][i]!, 4));
    // Separate closed shells (pegs stand on plates without being fused): still closed.
    const report: ManifoldReport = checkManifold(back.mesh);
    expect(report.boundaryEdges).toBe(0);
  });

  it('refuses an assembly whose parts, bodies or instances do not add up', () => {
    const a = assembly();
    expect(() => export3mfAssembly({ ...a, instances: [] })).toThrow(/no instances/);
    expect(() => exportStlAssembly({ ...a, parts: [a.parts[0]!] })).toThrow(
      /every body must belong/,
    );
    expect(() => export3mfAssembly({ ...a, instances: a.instances.slice(0, 2) })).toThrow(
      /every part needs an instance/,
    );
    expect(() => export3mfAssembly({ ...a, instances: [{ ...a.instances[0]!, part: 5 }] })).toThrow(
      /names part 5/,
    );
    expect(() =>
      export3mfAssembly({
        ...a,
        bodies: [
          a.bodies[0]!,
          { name: 'Open', mesh: { positions: [], indices: [] } },
          a.bodies[2]!,
        ],
      }),
    ).toThrow(NotWatertightError);
  });
});
