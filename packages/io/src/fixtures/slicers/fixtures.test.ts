// The slicer interop fixtures (M3 plan, T3.0a): the committed files are what
// scripts/slicer-fixtures.ts builds, each is a valid core 3MF, and they say what their names say.
// The slicers' results on them are in docs/research/slicer-handoff.md, "Verified".

import { strFromU8, unzipSync } from 'fflate';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BLUE,
  BLUE_BOX,
  FIXTURES_DIR,
  MATERIALS_NS,
  MODEL_SETTINGS_PATH,
  RED,
  RED_BOX,
  buildSlicerFixtures,
} from '../../../scripts/slicer-fixtures';
import { meshProperties } from '../../mesh';
import { boxMesh } from '../../test-helpers';
import { buildMeshes, parse3mf, validate3mf, write3mf } from '../../threemf';

const fixtures = buildSlicerFixtures();
const byFile = new Map(fixtures.map((f) => [f.file, f]));
const model = (file: string) => strFromU8(unzipSync(byFile.get(file)!.bytes)['3D/3dmodel.model']!);

/** World bounding boxes of what the build makes, by mesh name. */
function placed(file: string) {
  return Object.fromEntries(
    buildMeshes(parse3mf(byFile.get(file)!.bytes)).map(({ name, mesh }) => {
      const b = meshProperties(mesh).boundingBox!;
      const r = (v: readonly number[]) => v.map((x) => Math.round(x * 1e4) / 1e4 + 0);
      return [name, [r(b.min), r(b.max)]];
    }),
  );
}

const SIDE_BY_SIDE = {
  'Red box': [
    [90, 120, 0],
    [110, 140, 10],
  ],
  'Blue box': [
    [130, 122.5, 0],
    [160, 137.5, 8],
  ],
};

describe('slicer fixtures', () => {
  it('are committed exactly as the script builds them', () => {
    const committed = readdirSync(FIXTURES_DIR)
      .filter((f) => f.endsWith('.3mf'))
      .sort();
    expect(committed).toEqual(fixtures.map((f) => f.file).sort());
    for (const f of fixtures) {
      expect(new Uint8Array(readFileSync(new URL(f.file, FIXTURES_DIR))), f.file).toEqual(f.bytes);
    }
  });

  it('build the same bytes every time', () => {
    const again = buildSlicerFixtures();
    fixtures.forEach((f, i) => expect(again[i]!.bytes).toEqual(f.bytes));
  });

  it.each(fixtures.map((f) => f.file))('%s is a valid core 3MF', (file) => {
    const report = validate3mf(byFile.get(file)!.bytes);
    expect(report.problems).toEqual([]);
  });

  it('01-core is what write3mf writes for the two boxes', () => {
    const ours = parse3mf(
      write3mf([
        { name: RED_BOX.name, mesh: boxMesh(RED_BOX.min, RED_BOX.size) },
        { name: BLUE_BOX.name, mesh: boxMesh(BLUE_BOX.min, BLUE_BOX.size) },
      ]),
    );
    const fixture = parse3mf(byFile.get('01-core.3mf')!.bytes);
    expect(fixture.objects).toEqual(ours.objects);
    expect(fixture.items).toEqual(ours.items);
    expect(fixture.metadata).toEqual(ours.metadata);
    expect(fixture.contentTypes).toEqual(ours.contentTypes);
  });

  it('place both boxes side by side, whatever the markup', () => {
    for (const file of [
      '01-core.3mf',
      '02-colorgroups.3mf',
      '03-components.3mf',
      '04-pindex-triangles.3mf',
      '05-model-settings.3mf',
      '07-components-model-settings.3mf',
    ]) {
      expect(placed(file), file).toEqual(SIDE_BY_SIDE);
    }
  });

  it('06 turns the red box onto its side by its build item and moves the blue one', () => {
    expect(placed('06-transforms.3mf')).toEqual({
      'Red box': [
        [90, 125, 0],
        [110, 135, 20],
      ],
      'Blue box': SIDE_BY_SIDE['Blue box'],
    });
    const parsed = parse3mf(byFile.get('06-transforms.3mf')!.bytes);
    expect(parsed.items.every((i) => i.transform !== null)).toBe(true);
  });

  it('08 places the blue box twice, by two build items of one object', () => {
    const parsed = parse3mf(byFile.get('08-instances.3mf')!.bytes);
    expect(parsed.items.map((i) => i.objectId)).toEqual([3, 4, 4]);
    const meshes = buildMeshes(parsed).map(({ name, mesh }) => [
      name,
      meshProperties(mesh).boundingBox!.min.map((x) => Math.round(x * 1e4) / 1e4 + 0),
    ]);
    expect(meshes).toEqual([
      ['Red box', [90, 120, 0]],
      ['Blue box', [130, 122.5, 0]],
      ['Blue box', [130, 150, 0]],
    ]);
  });

  it('declare colours the way each fixture says', () => {
    expect(model('01-core.3mf')).not.toContain('colorgroup');
    expect(model('05-model-settings.3mf')).not.toContain('colorgroup');
    for (const file of [
      '02-colorgroups.3mf',
      '03-components.3mf',
      '06-transforms.3mf',
      '07-components-model-settings.3mf',
      '08-instances.3mf',
    ]) {
      const m = model(file);
      expect(m, file).toContain(`xmlns:m="${MATERIALS_NS}"`);
      expect(m.match(/<m:colorgroup /g), file).toHaveLength(2);
      expect(m, file).toContain(`<m:color color="${RED}"/>`);
      expect(m, file).toContain(`<m:color color="${BLUE}"/>`);
      expect(m.match(/pid="\d+" pindex="0"/g), file).toHaveLength(2);
    }
    const four = model('04-pindex-triangles.3mf');
    expect(four.match(/<m:colorgroup /g)).toHaveLength(1);
    expect(four).toMatch(/name="Blue box" type="model" pid="1" pindex="1"/);
    expect(four.match(/ pid="1" p1="1"\/>/g)).toHaveLength(2);
  });

  it('hold a model_settings.config only where the name says, naming objects and parts by id', () => {
    for (const f of fixtures) {
      const files = unzipSync(f.bytes);
      expect(MODEL_SETTINGS_PATH in files, f.file).toBe(f.file.includes('model-settings'));
    }
    const five = strFromU8(
      unzipSync(byFile.get('05-model-settings.3mf')!.bytes)[MODEL_SETTINGS_PATH]!,
    );
    expect(five).toContain('<object id="2">');
    expect(five).toContain('<metadata key="extruder" value="2"/>');
    const seven = strFromU8(
      unzipSync(byFile.get('07-components-model-settings.3mf')!.bytes)[MODEL_SETTINGS_PATH]!,
    );
    expect(seven).toContain('<object id="5">');
    expect(seven).toContain('<part id="4" subtype="normal_part">');
  });

  it('never claim to be written by Bambu Studio or OrcaSlicer', () => {
    for (const f of fixtures) {
      expect(parse3mf(f.bytes).metadata, f.file).toEqual({ Application: 'manufakture' });
    }
  });
});
