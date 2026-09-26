// What the Measure panel lists for a measurement: sections of labelled rows,
// every value already formatted in the document's display units. Pure, so
// the panel and its copy-to-clipboard text come from one place.

import type { DisplayUnits, Material } from '@manufakture/core';
import { massGrams } from '@manufakture/core';
import type { MeasureItemReport, MeasureResult } from '@manufakture/kernel';
import {
  formatAngleIn,
  formatAreaIn,
  formatDensityIn,
  formatLengthIn,
  formatMassIn,
  formatPointIn,
  formatVolumeIn,
} from './format';

export interface MeasureRow {
  /** Stable within the panel, for tests and React keys. */
  key: string;
  label: string;
  value: string;
  /** Extra explanation (a tooltip). */
  note?: string;
}

export interface MeasureSection {
  key: string;
  title: string;
  rows: MeasureRow[];
}

const KIND: Record<MeasureItemReport['kind'], string> = {
  face: 'Face',
  edge: 'Edge',
  vertex: 'Vertex',
};

const FULL_TURN = 2 * Math.PI;

function itemRows(item: MeasureItemReport, units: DisplayUnits, key: string): MeasureRow[] {
  const L = (mm: number) => formatLengthIn(mm, units);
  if (!item.ok) return [{ key: `${key}.error`, label: 'Not measured', value: item.message }];
  switch (item.kind) {
    case 'vertex':
      return [{ key: `${key}.point`, label: 'Position', value: formatPointIn(item.point, units) }];
    case 'edge': {
      const rows: MeasureRow[] = [{ key: `${key}.length`, label: 'Length', value: L(item.length) }];
      if (item.circle) {
        const c = item.circle;
        rows.push(
          { key: `${key}.radius`, label: 'Radius', value: L(c.radius) },
          { key: `${key}.diameter`, label: 'Diameter', value: L(2 * c.radius) },
          { key: `${key}.center`, label: 'Centre', value: formatPointIn(c.center, units) },
        );
        if (c.sweep < FULL_TURN - 1e-9) {
          rows.push({
            key: `${key}.sweep`,
            label: 'Arc angle',
            value: formatAngleIn(c.sweep, units),
          });
        }
      }
      return rows;
    }
    case 'face': {
      const rows: MeasureRow[] = [
        { key: `${key}.area`, label: 'Area', value: formatAreaIn(item.area, units) },
      ];
      if (item.radius !== null && (item.surface === 'cylinder' || item.surface === 'sphere')) {
        rows.push(
          { key: `${key}.radius`, label: 'Radius', value: L(item.radius) },
          { key: `${key}.diameter`, label: 'Diameter', value: L(2 * item.radius) },
        );
      }
      return rows;
    }
  }
}

function itemTitle(item: MeasureItemReport, n: number): string {
  const base = `${KIND[item.kind]} ${n}`;
  if (!item.ok) return base;
  if (item.kind === 'face') return `${base} (${item.surface})`;
  if (item.kind === 'edge') {
    const curve =
      item.curve === 'circle' && item.circle && item.circle.sweep < FULL_TURN - 1e-9
        ? 'arc'
        : item.curve;
    return `${base} (${curve})`;
  }
  return base;
}

export interface BodyContext {
  /** The body's material, when one is set. */
  material: Material | null;
}

/** Every section for a measurement: each item, what is between two, and the body. */
export function measureSections(
  result: MeasureResult,
  units: DisplayUnits,
  context: BodyContext = { material: null },
): MeasureSection[] {
  const L = (mm: number) => formatLengthIn(mm, units);
  const sections: MeasureSection[] = result.items.map((item, i) => ({
    key: `item${i + 1}`,
    title: itemTitle(item, i + 1),
    rows: itemRows(item, units, `item${i + 1}`),
  }));

  const between: MeasureRow[] = [];
  if (result.distance) {
    const d = result.distance;
    between.push({
      key: 'distance',
      label: 'Distance',
      value: L(d.value),
      note: 'Minimum distance, from the exact geometry',
    });
    if (d.value > 0) {
      const axes = ['X', 'Y', 'Z'] as const;
      axes.forEach((axis, i) =>
        between.push({
          key: `distance.${axis.toLowerCase()}`,
          label: `${axis} distance`,
          value: L(Math.abs(d.to[i]! - d.from[i]!)),
        }),
      );
    }
  }
  if (result.angle) {
    between.push({ key: 'angle', label: 'Angle', value: formatAngleIn(result.angle.value, units) });
    if (result.angle.normals !== null) {
      between.push({
        key: 'angle.normals',
        label: 'Between normals',
        value: formatAngleIn(result.angle.normals, units),
        note: 'The angle between the outward normals of the two faces',
      });
    }
  }
  if (between.length > 0) sections.push({ key: 'between', title: 'Between', rows: between });

  if (result.body) {
    const b = result.body;
    const rows: MeasureRow[] = [
      { key: 'body.volume', label: 'Volume', value: formatVolumeIn(b.volume, units) },
      { key: 'body.area', label: 'Surface area', value: formatAreaIn(b.area, units) },
    ];
    const m = context.material;
    if (m) {
      rows.push({
        key: 'body.mass',
        label: 'Mass',
        value: formatMassIn(massGrams(b.volume, m.density), units),
        note: `Estimate: ${m.name} at a typical ${formatDensityIn(m.density, units)} (${m.source})`,
      });
    }
    if (b.centerOfMass) {
      rows.push({
        key: 'body.com',
        label: 'Centre of mass',
        value: formatPointIn(b.centerOfMass, units),
      });
    }
    if (b.boundingBox) {
      const { min, max } = b.boundingBox;
      rows.push(
        {
          key: 'body.size',
          label: 'Size',
          value: [0, 1, 2].map((i) => L(max[i]! - min[i]!)).join(' x '),
          note: 'Bounding box, along X, Y and Z',
        },
        { key: 'body.min', label: 'Box min', value: formatPointIn(min, units) },
        { key: 'body.max', label: 'Box max', value: formatPointIn(max, units) },
      );
    }
    sections.push({ key: 'body', title: 'Body', rows });
  }
  return sections;
}

/** Every row as `Title: label value` lines, for the clipboard. */
export function sectionsText(sections: readonly MeasureSection[]): string {
  return sections
    .map((s) => [s.title, ...s.rows.map((r) => `  ${r.label}: ${r.value}`)].join('\n'))
    .join('\n');
}
