import type { DisplayUnits } from '@manufakture/core';
import { findMaterial } from '@manufakture/core';
import type { MeasureResult } from '@manufakture/kernel';
import { describe, expect, it } from 'vitest';
import { TOP_AREA, twoFaces } from './fixtures';
import { measureSections, sectionsText, type MeasureSection } from './rows';

const MM: DisplayUnits = { length: { unit: 'mm' }, angle: { unit: 'deg' } };
const FT_IN: DisplayUnits = { length: { unit: 'ft-in', denominator: 16 }, angle: { unit: 'deg' } };

function values(sections: readonly MeasureSection[]): Record<string, string> {
  return Object.fromEntries(sections.flatMap((s) => s.rows.map((r) => [r.key, r.value])));
}

describe('measure sections', () => {
  it('lists each face, what is between them and the body', () => {
    const sections = measureSections(twoFaces(), MM);
    expect(sections.map((s) => s.title)).toEqual([
      'Face 1 (plane)',
      'Face 2 (plane)',
      'Between',
      'Body',
    ]);
    expect(values(sections)).toMatchObject({
      'item1.area': `${TOP_AREA.toFixed(2)} mm²`,
      distance: '20.00 mm',
      'distance.x': '0.00 mm',
      'distance.z': '20.00 mm',
      angle: '0.00°',
      'angle.normals': '180.00°',
      'body.volume': '44000.00 mm³',
      'body.area': '9000.00 mm²',
      'body.com': '(0.00 mm, 0.00 mm, 10.00 mm)',
      'body.size': '60.00 mm x 40.00 mm x 20.00 mm',
    });
    // No material, no mass.
    expect(values(sections)['body.mass']).toBeUndefined();
  });

  it('adds the mass for a material, as an estimate with its source', () => {
    const plywood = findMaterial('plywood')!;
    const sections = measureSections(twoFaces(), MM, { material: plywood });
    const mass = sections.at(-1)!.rows.find((r) => r.key === 'body.mass')!;
    // 44000 mm3 at 680 kg/m3 is 29.92 g.
    expect(mass.value).toBe('29.92 g');
    expect(mass.note).toContain('typical 680 kg/m³');
    expect(mass.note).toContain(plywood.source);
  });

  it('shows an open mesh as having no volume, with the reason, and no mass', () => {
    const r = twoFaces();
    const open = { ...r, body: { ...r.body!, volume: null, note: 'The mesh is not closed' } };
    const sections = measureSections(open, MM, { material: findMaterial('plywood')! });
    const body = sections.at(-1)!.rows;
    expect(body.find((row) => row.key === 'body.volume')).toEqual({
      key: 'body.volume',
      label: 'Volume',
      value: 'None',
      note: 'The mesh is not closed',
    });
    expect(body.find((row) => row.key === 'body.mass')).toBeUndefined();
  });

  it('follows the display units: feet, inches and fractions for a woodworking document', () => {
    const v = values(measureSections(twoFaces(), FT_IN, { material: findMaterial('oak')! }));
    expect(v.distance).toBe('13/16"');
    expect(v['body.size']).toBe(`2-3/8" x 1-9/16" x 13/16"`);
    expect(v['body.volume']).toBe('2.685 in³');
    // 44000 mm3 of oak at 700 kg/m3 is 30.8 g, 1.09 oz.
    expect(v['body.mass']).toBe('1.09 oz');
  });

  it('shows radius, diameter and centre of arcs and cylinders, and a vertex position', () => {
    const result: MeasureResult = {
      items: [
        {
          ok: true,
          kind: 'edge',
          index: 1,
          name: null,
          curve: 'circle',
          length: Math.PI * 10,
          start: [40, 10, 5],
          end: [20, 10, 5],
          midpoint: [30, 20, 5],
          direction: null,
          circle: { center: [30, 10, 5], radius: 10, axis: [0, 0, 1], sweep: Math.PI },
        },
        {
          ok: true,
          kind: 'face',
          index: 2,
          name: 'hole',
          surface: 'cylinder',
          area: 100,
          centroid: [0, 0, 0],
          normal: null,
          axis: { origin: [0, 0, 0], direction: [0, 0, 1] },
          radius: 8,
        },
        { ok: true, kind: 'vertex', index: 3, name: null, point: [1, 2, 3] },
        { ok: false, kind: 'edge', status: 'not-found', message: 'no edge is named X' },
      ],
      distance: null,
      angle: null,
      body: null,
    };
    const sections = measureSections(result, MM);
    expect(sections.map((s) => s.title)).toEqual([
      'Edge 1 (arc)',
      'Face 2 (cylinder)',
      'Vertex 3',
      'Edge 4',
    ]);
    expect(values(sections)).toEqual({
      'item1.length': '31.42 mm',
      'item1.radius': '10.00 mm',
      'item1.diameter': '20.00 mm',
      'item1.center': '(30.00 mm, 10.00 mm, 5.00 mm)',
      'item1.sweep': '180.00°',
      'item2.area': '100.00 mm²',
      'item2.radius': '8.00 mm',
      'item2.diameter': '16.00 mm',
      'item3.point': '(1.00 mm, 2.00 mm, 3.00 mm)',
      'item4.error': 'no edge is named X',
    });
  });

  it('a full circle is a circle, with no arc angle', () => {
    const [section] = measureSections(
      {
        items: [
          {
            ok: true,
            kind: 'edge',
            index: 1,
            name: null,
            curve: 'circle',
            length: 2 * Math.PI * 5,
            start: [5, 0, 0],
            end: [5, 0, 0],
            midpoint: [-5, 0, 0],
            direction: null,
            circle: { center: [0, 0, 0], radius: 5, axis: [0, 0, 1], sweep: 2 * Math.PI },
          },
        ],
        distance: null,
        angle: null,
        body: null,
      },
      MM,
    );
    expect(section!.title).toBe('Edge 1 (circle)');
    expect(section!.rows.map((r) => r.label)).toEqual(['Length', 'Radius', 'Diameter', 'Centre']);
  });

  it('gives the clipboard text of every row', () => {
    const text = sectionsText(measureSections(twoFaces(), MM));
    expect(text.split('\n')).toContain('  Distance: 20.00 mm');
    expect(text.startsWith('Face 1 (plane)\n  Area: ')).toBe(true);
  });
});
