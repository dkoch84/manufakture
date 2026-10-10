// What the Measure panel lists for a measurement: sections of labelled rows,
// every value already formatted in the document's display units. Pure, so
// the panel and its copy-to-clipboard text come from one place.

import type { DisplayUnits, Material } from '@manufakture/core';
import { massGrams } from '@manufakture/core';
import { bodyMassProperties, principalInertia } from '@manufakture/kernel/inertia';
import type { MeasureItemReport } from '@manufakture/kernel';
import {
  formatAngleIn,
  formatAreaIn,
  formatDensityIn,
  formatInertiaIn,
  formatLengthIn,
  formatMassIn,
  formatPointIn,
  formatVolumeIn,
} from './format';
import type { BodyMeasurement, Measurement } from './measurer';

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
  /** The body section's title (default: Body), e.g. the body's name in a part of several. */
  title?: string;
}

/**
 * Volume, area, mass (with a material), centre of mass, moments of inertia (with a material) and
 * bounding box of a body.
 */
export function bodyRows(
  b: BodyMeasurement,
  units: DisplayUnits,
  material: Material | null,
  key: string,
): MeasureRow[] {
  const L = (mm: number) => formatLengthIn(mm, units);
  const rows: MeasureRow[] = [
    b.volume === null
      ? {
          key: `${key}.volume`,
          label: 'Volume',
          value: 'None',
          ...(b.note ? { note: b.note } : {}),
        }
      : { key: `${key}.volume`, label: 'Volume', value: formatVolumeIn(b.volume, units) },
    { key: `${key}.area`, label: 'Surface area', value: formatAreaIn(b.area, units) },
  ];
  const m = material;
  if (m && b.volume !== null) {
    rows.push({
      key: `${key}.mass`,
      label: 'Mass',
      value: formatMassIn(massGrams(b.volume, m.density), units),
      note: `Estimate: ${m.name} at a typical ${formatDensityIn(m.density, units)} (${m.source})`,
    });
  }
  if (b.centerOfMass) {
    rows.push({
      key: `${key}.com`,
      label: 'Centre of mass',
      value: formatPointIn(b.centerOfMass, units),
    });
  }
  if (m && b.volume !== null && b.centerOfMass && b.volumeInertia) {
    rows.push(...inertiaRows(b.volume, b.centerOfMass, b.volumeInertia, m, units, key));
  }
  if (b.boundingBox) {
    const { min, max } = b.boundingBox;
    rows.push(
      {
        key: `${key}.size`,
        label: 'Size',
        value: [0, 1, 2].map((i) => L(max[i]! - min[i]!)).join(' x '),
        note: 'Bounding box, along X, Y and Z',
      },
      { key: `${key}.min`, label: 'Box min', value: formatPointIn(min, units) },
      { key: `${key}.max`, label: 'Box max', value: formatPointIn(max, units) },
    );
  }
  return rows;
}

const AXIS_DIGITS = 3;

/** The moments of inertia about the centre of mass along X, Y and Z, and the principal ones. */
function inertiaRows(
  volume: number,
  centerOfMass: readonly [number, number, number],
  volumeInertia: NonNullable<BodyMeasurement['volumeInertia']>,
  m: Material,
  units: DisplayUnits,
  key: string,
): MeasureRow[] {
  const I = bodyMassProperties(volume, centerOfMass, volumeInertia, m.density).inertia;
  const principal = principalInertia(I);
  const estimate = `Estimate at the ${m.name} density; about the centre of mass`;
  const rows: MeasureRow[] = (['x', 'y', 'z'] as const).map((axis, i) => ({
    key: `${key}.i${axis}${axis}`,
    label: `I${axis}${axis}`,
    value: formatInertiaIn(I[i]![i]!, units),
    note: `${estimate}, about an axis along ${axis.toUpperCase()}`,
  }));
  const direction = (v: readonly number[]) =>
    `(${v.map((c) => (Math.abs(c) < 0.5 * 10 ** -AXIS_DIGITS ? 0 : c).toFixed(AXIS_DIGITS)).join(', ')})`;
  rows.push({
    key: `${key}.principal`,
    label: 'Principal moments',
    value: principal.moments.map((v) => formatInertiaIn(v, units)).join(', '),
    note: `${estimate}, about the principal axes ${principal.axes.map(direction).join(', ')}`,
  });
  return rows;
}

/** One body of a part of several, measured as a whole, for its own section. */
export interface BodySectionInput {
  title: string;
  body: BodyMeasurement | null;
  error?: string;
  material: Material | null;
}

/** A section per body (`body1`, `body2`, ...), titled with the body's name. */
export function bodySections(
  bodies: readonly BodySectionInput[],
  units: DisplayUnits,
): MeasureSection[] {
  return bodies.map((b, i) => {
    const key = `body${i + 1}`;
    return {
      key,
      title: b.title,
      rows: b.body
        ? bodyRows(b.body, units, b.material, key)
        : [{ key: `${key}.error`, label: 'Not measured', value: b.error ?? 'Not measured' }],
    };
  });
}

/** Every section for a measurement: each item, what is between two, and the body. */
export function measureSections(
  result: Measurement,
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
    sections.push({
      key: 'body',
      title: context.title ?? 'Body',
      rows: bodyRows(result.body, units, context.material, 'body'),
    });
  }
  return sections;
}

/** Every row as `Title: label value` lines, for the clipboard. */
export function sectionsText(sections: readonly MeasureSection[]): string {
  return sections
    .map((s) => [s.title, ...s.rows.map((r) => `  ${r.label}: ${r.value}`)].join('\n'))
    .join('\n');
}
