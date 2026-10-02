// The built-in starter tool library (T5.1d): Carbide 3D's numbered cutters where one exists, and
// generic metric end mills and a drill where none does. Each tool cites its geometry, each preset
// its feeds, with `verified` flags as in the kernel's `HOLE_SIZES`.
//
// Geometry sources (read 2026-10-02): the spec tables of Carbide 3D's product pages, linked per
// tool (`vendor.url`). The pages print inch values ("Flute Diameter", "Cutting Length", "Number of
// Flutes", "Included Angle"). They give no cutting length for the V-bits; a V-bit's `fluteLength`
// here is the height of its cone, (diameter / 2) / tan(angle / 2), computed from the printed
// diameter and angle. The metric end mills and the drill have no vendor: their dimensions are
// typical ones, unverified, to check against the cutter in hand.
//
// Feed source: Carbide 3D's "Shapeoko 3 Feeds & Speeds" chart for "#201 .25" Square" and
// "#202 .25" Ball" (S3_feeds_250.pdf, dated 2019-07-29; archived at CHART_URL), columns DOC (in),
// RPM, the router dial, FEED and PLUNGE (in/min). Carbide 3D measured it slotting, "100%
// engagement" (https://community.carbide3d.com/t/shapeoko-nomad-feeds-speeds-charts/2402). The
// #201's presets are its rows as printed. Every other tool's presets are DERIVED from those rows
// and unverified: chip load scaled by diameter (chip load = feed / (rpm x flutes), times
// diameter / 0.25") at the same rpm, plunge scaled alike, depth of cut scaled by diameter and
// capped at the flute length. The chart's rows for the categories: Plywood, MDF, Pine (softwood),
// Mahogany (hardwood: the chart has no oak, which is harder; go gentler), ABS (plastics; PLA and
// PETG soften sooner), 6061 AL (aluminium), Steel ("Use Coolant"). The chart's stepover is 100%
// (a slot); the stepovers here are this library's defaults, unverified: 40% for flat end mills and
// V-bits, 10% for ball end mills (a finishing scallop), and 50% for the drill (unused by drilling).

import { toMm } from './feeds';
import type { LibraryPreset, LibraryTool, LibraryUnit } from './types';

const IN = 25.4;

/** Carbide 3D's #201 / #202 chart for the Shapeoko 3, archived. */
export const CHART_URL =
  'https://web.archive.org/web/20200922022604/https://docs.carbide3d.com/support/supportfiles/S3_feeds_250.pdf';

/** The library id of the built-in tools, written to a copied tool's `source.library`. */
export const BUILTIN_LIBRARY_ID = 'builtin';

interface ChartRow {
  readonly category: string;
  /** The chart's material name. */
  readonly row: string;
  /** Depth of cut, inches. */
  readonly doc: number;
  readonly rpm: number;
  /** The chart's router dial column, as printed (the chart's own dial table differs from the product page's). */
  readonly dial: string;
  /** in/min. */
  readonly feed: number;
  /** in/min. */
  readonly plunge: number;
}

/** The chart's rows used here, as printed: `MATERIAL DOC RPM Carbide/Makita Dewalt FEED PLUNGE`. */
const CHART_201: readonly ChartRow[] = [
  {
    category: 'plywood',
    row: 'Plywood',
    doc: 0.25,
    rpm: 18950,
    dial: '3.5',
    feed: 100,
    plunge: 50,
  },
  { category: 'mdf', row: 'MDF', doc: 0.3, rpm: 17000, dial: '3', feed: 80, plunge: 30 },
  { category: 'softwood', row: 'Pine', doc: 0.4, rpm: 21000, dial: '3.75', feed: 75, plunge: 40 },
  {
    category: 'hardwood',
    row: 'Mahogany',
    doc: 0.1,
    rpm: 18950,
    dial: '3.5',
    feed: 65,
    plunge: 32,
  },
  { category: 'plastics', row: 'ABS', doc: 0.07, rpm: 17000, dial: '3', feed: 65, plunge: 22 },
  {
    category: 'aluminium',
    row: '6061 AL',
    doc: 0.03,
    rpm: 17500,
    dial: '3.25',
    feed: 30,
    plunge: 10,
  },
  {
    category: 'steel',
    row: 'Steel (Use Coolant)',
    doc: 0.02,
    rpm: 17500,
    dial: '3.25',
    feed: 12,
    plunge: 5,
  },
];

const BASE_DIAMETER_MM = 0.25 * IN;
const BASE_FLUTES = 3;

function chartQuote(r: ChartRow): string {
  return `${CHART_URL}: #201 row "${r.row} ${r.doc}in ${r.rpm} (dial ${r.dial}) feed ${r.feed} plunge ${r.plunge}" (in/min)`;
}

/** The #201's presets: the chart rows as printed. */
function chartPresets(stepover: number): LibraryPreset[] {
  return CHART_201.map((r) => ({
    category: r.category,
    unit: 'in',
    rpm: r.rpm,
    feed: r.feed,
    plunge: r.plunge,
    stepdown: r.doc,
    stepover,
    source: chartQuote(r),
    verified: { feeds: true, stepdown: true, stepover: false },
    note: `Measured slotting (100% engagement); the chart's dial ${r.dial} follows the chart's own dial table, which differs from the product page's, so set the dial from the machine's own table. Stepover is this library's default.`,
  }));
}

/** Rounds to a step the source's precision supports: whole in/min, 10 mm/min, 0.001 in, 0.1 mm. */
function roundTo(value: number, step: number): number {
  const r = Math.round(value / step) * step;
  const rounded = Math.max(step, r);
  // Clean binary noise (0.30000000000000004) without claiming more digits than `step` has.
  return Number(rounded.toFixed(Math.max(0, -Math.floor(Math.log10(step)))));
}

interface Shape {
  readonly unit: LibraryUnit;
  readonly diameter: number;
  readonly flutes: number;
  readonly fluteLength: number;
}

/**
 * Presets derived from the #201 chart for another tool: chip load scaled by diameter at the same
 * rpm, depth by diameter (capped at the flute length). `drill`: feed equals plunge and the depth
 * is a peck of one diameter.
 */
function derivedPresets(
  shape: Shape,
  stepover: number,
  options: { drill?: boolean; effectiveDiameter?: number; why?: string } = {},
): LibraryPreset[] {
  const d = toMm(options.effectiveDiameter ?? shape.diameter, shape.unit);
  const ratio = d / BASE_DIAMETER_MM;
  const feedScale = (shape.flutes / BASE_FLUTES) * ratio;
  const scale = shape.unit === 'in' ? IN : 1;
  const feedStep = shape.unit === 'in' ? 1 : 10;
  const lengthStep = shape.unit === 'in' ? 0.001 : 0.1;
  return CHART_201.map((r) => {
    const plunge = roundTo((r.plunge * IN * feedScale) / scale, feedStep);
    const feed = options.drill ? plunge : roundTo((r.feed * IN * feedScale) / scale, feedStep);
    const depthMm = options.drill
      ? toMm(shape.diameter, shape.unit)
      : Math.min(r.doc * IN * ratio, toMm(shape.fluteLength, shape.unit));
    return {
      category: r.category,
      unit: shape.unit,
      rpm: r.rpm,
      feed,
      plunge,
      stepdown: roundTo(depthMm / scale, lengthStep),
      stepover,
      source: chartQuote(r),
      verified: { feeds: false, stepdown: false, stepover: false },
      note: options.drill
        ? `Derived from the #201 row: the plunge scaled by diameter and flutes; feed equals plunge; pecks of one diameter.${options.why ? ` ${options.why}` : ''}`
        : `Derived from the #201 row: chip load scaled by diameter (x ${ratio.toFixed(3)}) and flutes (${shape.flutes} of 3) at the same rpm; depth scaled by diameter.${options.why ? ` ${options.why}` : ''}`,
    };
  });
}

function c3dUrl(handle: string): string {
  return `https://shop.carbide3d.com/products/${handle}`;
}

function c3dSource(handle: string, spec: string): string {
  return `${c3dUrl(handle)}: ${spec}`;
}

const FLAT_STEPOVER = 0.4;
const BALL_STEPOVER = 0.1;
const DRILL_STEPOVER = 0.5;

function tool(t: Omit<LibraryTool, 'presets'>, presets: (shape: Shape) => LibraryPreset[]) {
  return { ...t, presets: presets(t) } satisfies LibraryTool;
}

/** The built-in tools, in display order. Ids are permanent (copied tools name them). */
export const BUILTIN_TOOLS: readonly LibraryTool[] = [
  tool(
    {
      id: 'c3d-201',
      name: '#201 1/4" flat end mill',
      kind: 'flat',
      vendor: { maker: 'Carbide 3D', number: 201, url: c3dUrl('201-25-end-mill-cutter') },
      unit: 'in',
      diameter: 0.25,
      fluteLength: 0.75,
      flutes: 3,
      shankDiameter: 0.25,
      source: c3dSource(
        '201-25-end-mill-cutter',
        'Flute Diameter 0.25 in, Cutting Length 0.75 in, Number of Flutes 3, Shank Diameter 0.25 in',
      ),
      verified: true,
    },
    () => chartPresets(FLAT_STEPOVER),
  ),
  tool(
    {
      id: 'c3d-102',
      name: '#102 1/8" flat end mill',
      kind: 'flat',
      vendor: { maker: 'Carbide 3D', number: 102, url: c3dUrl('102-125-end-mill-cutter') },
      unit: 'in',
      diameter: 0.125,
      fluteLength: 0.5,
      flutes: 2,
      shankDiameter: 0.125,
      source: c3dSource(
        '102-125-end-mill-cutter',
        'Flute Diameter 0.125 in, Cutting Length 0.5 in, Number of Flutes 2, Shank Diameter 0.125 in',
      ),
      verified: true,
    },
    (s) => derivedPresets(s, FLAT_STEPOVER),
  ),
  tool(
    {
      id: 'c3d-251',
      name: '#251 1/4" downcut flat end mill',
      kind: 'flat',
      vendor: { maker: 'Carbide 3D', number: 251, url: c3dUrl('251-25-downcut-flat-cutter') },
      unit: 'in',
      diameter: 0.25,
      fluteLength: 0.75,
      flutes: 2,
      shankDiameter: 0.25,
      source: c3dSource(
        '251-25-downcut-flat-cutter',
        'Flutes Down-cut, Flute Diameter 0.25 in, Cutting Length 0.75 in, Number of Flutes 2',
      ),
      verified: true,
      note: 'Down-cut: a clean top face, but chips pack in deep slots; keep passes shallow.',
    },
    (s) => derivedPresets(s, FLAT_STEPOVER),
  ),
  tool(
    {
      id: 'flat-3mm-2f',
      name: '3 mm flat end mill, 2 flutes',
      kind: 'flat',
      unit: 'mm',
      diameter: 3,
      fluteLength: 12,
      flutes: 2,
      shankDiameter: 3,
      source:
        'Generic: no vendor; a typical 3 mm two-flute carbide end mill (3 mm shank, 12 mm flutes).',
      verified: false,
      note: 'Check the flute length against the cutter in hand.',
    },
    (s) => derivedPresets(s, FLAT_STEPOVER),
  ),
  tool(
    {
      id: 'flat-6mm-2f',
      name: '6 mm flat end mill, 2 flutes',
      kind: 'flat',
      unit: 'mm',
      diameter: 6,
      fluteLength: 17,
      flutes: 2,
      shankDiameter: 6,
      source:
        'Generic: no vendor; a typical 6 mm two-flute carbide end mill (6 mm shank, 17 mm flutes).',
      verified: false,
      note: 'Check the flute length against the cutter in hand; a 6 mm shank needs a 6 mm collet.',
    },
    (s) => derivedPresets(s, FLAT_STEPOVER),
  ),
  tool(
    {
      id: 'c3d-101',
      name: '#101 1/8" ball end mill',
      kind: 'ball',
      vendor: { maker: 'Carbide 3D', number: 101, url: c3dUrl('101-125-ball-cutter') },
      unit: 'in',
      diameter: 0.125,
      fluteLength: 0.5,
      flutes: 2,
      shankDiameter: 0.125,
      source: c3dSource(
        '101-125-ball-cutter',
        'Shape Ball, Flute Diameter 0.125 in, Cutting Length 0.5 in, Corner Radius 0.0625 in, Number of Flutes 2',
      ),
      verified: true,
    },
    (s) => derivedPresets(s, BALL_STEPOVER),
  ),
  tool(
    {
      id: 'c3d-302',
      name: '#302 60 deg V-bit',
      kind: 'vbit',
      vendor: { maker: 'Carbide 3D', number: 302, url: c3dUrl('302-v-bit-cutter-60') },
      unit: 'in',
      diameter: 0.5,
      fluteLength: 0.433,
      flutes: 2,
      shankDiameter: 0.25,
      angleDeg: 60,
      source: c3dSource(
        '302-v-bit-cutter-60',
        'Shape V-bit, Flute Diameter 0.5 in, Included Angle 60 degrees, Number of Flutes 2, Shank Diameter 0.25 in',
      ),
      verified: true,
      note: 'Flute length is the cone height, 0.25 / tan(30 deg), computed; the page prints none.',
    },
    (s) =>
      derivedPresets(s, FLAT_STEPOVER, {
        effectiveDiameter: 0.125,
        why: 'A V-bit cuts mostly near its tip, so it is fed as a 1/8" two-flute cutter.',
      }),
  ),
  tool(
    {
      id: 'c3d-301',
      name: '#301 90 deg V-bit',
      kind: 'vbit',
      vendor: { maker: 'Carbide 3D', number: 301, url: c3dUrl('301-v-bit-cutter-90') },
      unit: 'in',
      diameter: 0.5,
      fluteLength: 0.25,
      flutes: 2,
      shankDiameter: 0.25,
      angleDeg: 90,
      source: c3dSource(
        '301-v-bit-cutter-90',
        'Shape V-bit, Flute Diameter 0.5 in, Included Angle 90 degrees, Number of Flutes 2, Shank Diameter 0.25 in',
      ),
      verified: true,
      note: 'Flute length is the cone height, 0.25 / tan(45 deg), computed; the page prints none.',
    },
    (s) =>
      derivedPresets(s, FLAT_STEPOVER, {
        effectiveDiameter: 0.125,
        why: 'A V-bit cuts mostly near its tip, so it is fed as a 1/8" two-flute cutter.',
      }),
  ),
  tool(
    {
      id: 'drill-1-8in',
      name: '1/8" drill',
      kind: 'drill',
      unit: 'in',
      diameter: 0.125,
      fluteLength: 1.625,
      flutes: 2,
      shankDiameter: 0.125,
      angleDeg: 118,
      source:
        'Generic: no vendor; a typical 1/8" jobber-length twist drill (about 1-5/8" of flutes, 118 deg point), not checked against a standard.',
      verified: false,
      note: 'Router speeds are high for a twist drill; a carbide drill copes better than HSS.',
    },
    (s) =>
      derivedPresets(s, DRILL_STEPOVER, {
        drill: true,
        why: 'Stepover is unused by drilling.',
      }),
  ),
];

export function findBuiltinTool(id: string): LibraryTool | undefined {
  return BUILTIN_TOOLS.find((t) => t.id === id);
}

/**
 * Paths of the numbers in a library tool that were not checked against their source, for the UI
 * to flag: `geometry` when the tool's dimensions are unverified, then `presets.<category>.feeds`,
 * `.stepdown` and `.stepover` per preset.
 */
export function unverifiedToolFields(t: LibraryTool): string[] {
  const out: string[] = [];
  if (!t.verified) out.push('geometry');
  for (const p of t.presets) {
    if (!p.verified.feeds) out.push(`presets.${p.category}.feeds`);
    if (!p.verified.stepdown) out.push(`presets.${p.category}.stepdown`);
    if (!p.verified.stepover) out.push(`presets.${p.category}.stepover`);
  }
  return out;
}
