// The readers scripts/orca-matrix.ts uses on what OrcaSlicer writes, on small hand-made inputs
// (no OrcaSlicer needed): profile flattening, model_settings.config, placed bounds, G-code slots.

import { strToU8 } from 'fflate';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  flattenProfile,
  placedBounds,
  readModelSettings,
  assertOutsideRepo,
  gcodeLabels,
  gcodeSlots,
  slotsPerObject,
} from '../../../scripts/orca-matrix';

describe('orca-matrix readers', () => {
  it('flattens a profile with its parents, child keys winning, without inherits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-profiles-'));
    try {
      mkdirSync(dir, { recursive: true });
      const put = (name: string, body: object) =>
        writeFileSync(join(dir, `${name}.json`), JSON.stringify({ name, ...body }));
      put('common', { printable_height: '100', a: 'common' });
      put('family', { inherits: 'common', printable_height: '250', b: 'family' });
      put('printer', { inherits: 'family', b: 'printer' });
      expect(flattenProfile(dir, 'printer')).toEqual({
        name: 'printer',
        printable_height: '250',
        a: 'common',
        b: 'printer',
      });
      put('loop', { inherits: 'loop' });
      expect(() => flattenProfile(dir, 'loop')).toThrow(/inherits from itself/);
      expect(() => flattenProfile(dir, 'missing')).toThrow(/no profile/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads objects and parts with their names and extruders from model_settings.config', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="3">
    <metadata key="name" value="Two boxes"/>
    <metadata key="extruder" value="1"/>
    <part id="1" subtype="normal_part">
      <metadata key="name" value="Red box"/>
      <metadata key="extruder" value="1"/>
    </part>
    <part id="2" subtype="normal_part">
      <metadata key="name" value="Blue box"/>
    </part>
  </object>
  <plate><metadata key="plater_id" value="1"/></plate>
</config>`;
    expect(readModelSettings(xml)).toEqual([
      {
        id: 3,
        name: 'Two boxes',
        extruder: '1',
        parts: [
          { id: 1, name: 'Red box', subtype: 'normal_part', extruder: '1' },
          { id: 2, name: 'Blue box', subtype: 'normal_part', extruder: null },
        ],
      },
    ]);
  });

  it('places meshes from 3D/Objects through component and item transforms', () => {
    const root = `<model><resources>
  <object id="2" type="model"><components>
    <component p:path="/3D/Objects/a.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
  </components></object>
</resources><build>
  <item objectid="2" transform="1 0 0 0 0 1 0 -1 0 100 50 5" printable="1"/>
</build></model>`;
    const part = `<model><resources><object id="1" type="model"><mesh><vertices>
  <vertex x="-10" y="-10" z="-5"/><vertex x="10" y="10" z="5"/>
</vertices></mesh></object></resources></model>`;
    const bounds = placedBounds({
      '3D/3dmodel.model': strToU8(root),
      '3D/Objects/a.model': strToU8(part),
    });
    // 90 degrees about x: y becomes -z, z becomes y.
    expect(bounds.get(2)).toEqual({ min: [90, 45, -5], max: [110, 55, 15] });
  });

  it('attributes each object block of a Bambu G-code to the AMS slot selected before it', () => {
    const gcode = [
      'M620 S1A   ; switch material if AMS exist',
      '; start printing object, unique label id: 12',
      '; stop printing object Blue box id:0 copy 0',
      'M620 S0A',
      '; stop printing object Red box id:0 copy 0',
      'M620 S1A',
      '; stop printing object Red box id:0 copy 0',
    ].join('\n');
    expect(slotsPerObject(gcode)).toEqual({ 'Blue box': [2], 'Red box': [1, 2] });
  });

  it("names Bambu Studio's object blocks, which carry only a label id, by model order", () => {
    const header = '; model label id: 8,12\n; object max height: 10.00,8.00\n';
    const labels = gcodeLabels(header, ['Red box', 'Blue box']);
    expect([...labels]).toEqual([
      ['8', 'Red box'],
      ['12', 'Blue box'],
    ]);
    expect(gcodeLabels(header, ['Only one'])).toEqual(new Map());
    const gcode = [
      header,
      'M620 S1A',
      '; stop printing object, unique label id: 12',
      'M620 S0A',
      '; stop printing object, unique label id: 8',
      '; stop printing object, unique label id: 99',
    ].join('\n');
    expect(slotsPerObject(gcode, labels)).toEqual({ 'Blue box': [2], 'Red box': [1] });
  });

  it('reports unresolved labels instead of an empty map when the id count differs', () => {
    const gcode = [
      '; model label id: 8,12',
      'M620 S0A',
      '; stop printing object, unique label id: 8',
    ].join('\n');
    expect(gcodeSlots(gcode, ['Only one'])).toBe('labels unresolved');
    expect(gcodeSlots(gcode, ['Red box', 'Blue box'])).toEqual({ 'Red box': [1] });
    expect(gcodeSlots('M620 S0A\n', ['Red box'])).toEqual({});
  });

  it('refuses an output directory inside the repository', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orca-repo-'));
    try {
      expect(() => assertOutsideRepo(repo, repo)).toThrow(/inside the repository/);
      expect(() => assertOutsideRepo(join(repo, 'out', 'new'), repo)).toThrow(/inside/);
      expect(() => assertOutsideRepo(join(tmpdir(), 'orca-out-elsewhere'), repo)).not.toThrow();
      expect(() => assertOutsideRepo(`${repo}-sibling`, repo)).not.toThrow();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
