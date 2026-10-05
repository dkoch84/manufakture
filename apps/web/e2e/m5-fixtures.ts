// The verifier's parser ships no types; its declarations live with the cam package's post tests.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../../../packages/cam/src/post/gcode-toolpath.d.ts" />
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, platform, release } from 'node:os';
import { expect, type Page } from '@playwright/test';
import { findBuiltinTool, findMachine } from '@manufakture/cam/library';
import type { Dialect, ToolChangeStyle } from '../../../packages/cam/src/post/dialect';
import {
  verifyGcode,
  type GcodeReport,
  type VerifyTool,
} from '../../../packages/cam/test/verify-gcode';
import { regenerated } from './bracket';
import { settle } from './helpers';
import { execute } from './m2-fixtures';

// The M5 acceptance model, a plywood sign (docs/m5-acceptance.md), and what the m5-sign spec
// checks its G-code against. A millimetre document. World axes: the sign lies on Top (XY), its
// front left corner on the origin, X along its width, Y along its height, Z up through the
// sheet, from z = 0 (the spoilboard side) to z = #thickness (the face that is carved).
//
// One part, one body:
// - a 400 x 200 mm plate with 15 mm rounded corners (one sketch of four lines and four arcs),
//   extruded #thickness, the sheet as measured; larger than the plan's 300 x 150 example, so that
//   the lettering can be big enough for a 1/8" end mill to clear the V-carve's floors;
// - a recessed border: a 6 mm wide groove 3 mm deep, 10 to 16 mm in from the edge, its corners
//   rounded (a ring between two rounded rectangles in a sketch on the top face, cut);
// - two mounting holes, 8 mm through, as a hole feature on two points of a sketch on the top face;
// - the lettering: "WOODSHOP" (packages/io/src/fixtures/svg/word.svg, Inter Bold converted to
//   paths) imported through the SVG import dialog into a sketch on the top face at twice its size
//   (40 mm capitals, 8.2 mm stems), centred, and cut 2 mm deep with straight walls. The V-carve
//   leaves sloped walls where the model has straight ones, so the simulation reports material
//   left along the letters; never a gouge, since the V-bit stays inside the outline and above the
//   letters' floor.
//
// The sketches are made with commands, as the M3 and M4 walkthroughs do (the sketcher is M1's and
// its own specs cover it); the lettering goes through the SVG import dialog (T5.8). Every CAM
// step goes through the Manufacture workspace.

export const SIGN = {
  name: 'Plywood sign',
  width: 400,
  height: 200,
  corner: 15,
  /** 12 mm plywood as measured with calipers: the value of #thickness. */
  thickness: 11.6,
  /** The groove: in from the edge, mm, its width and depth. */
  border: { inset: 10, width: 6, depth: 3 },
  /** Hole centres in model X and Y, and their diameter (through). */
  holes: [
    [40, 160],
    [360, 160],
  ] as [number, number][],
  hole: 8,
  /** The lettering: the SVG fixture's scale, where its centre goes, and the cut's depth. */
  lettering: { scale: 2, centre: [200, 100] as [number, number], depth: 2 },
  /** Stock margins round the part, mm (sheet stock, so none above or below). */
  margin: 10,
} as const;

export const SVG_WORD = new URL('../../../packages/io/src/fixtures/svg/word.svg', import.meta.url);

/** The M5 target machine (T5.1d), in its default configuration. */
export const MACHINE = findMachine('shapeoko-5-pro-4x4')!;
export const TRAVEL: [number, number, number] = [
  MACHINE.travel.x.value,
  MACHINE.travel.y.value,
  MACHINE.travel.z.value,
];

const IN = 25.4;
function libraryTool(id: string): VerifyTool & { id: string } {
  const t = findBuiltinTool(id)!;
  return { id, number: t.vendor!.number!, name: t.name, diameter: t.diameter * IN };
}

/** The tools, in the order the walkthrough copies them into the document (tool#1, #2, #3). */
export const TOOLS = {
  vbit: libraryTool('c3d-301'),
  eighth: libraryTool('c3d-102'),
  quarter: libraryTool('c3d-201'),
};

/**
 * The stock in WCS coordinates: the part's box with the margins at the sides and none above or
 * below, the origin on its top front-left corner.
 */
export const STOCK: { min: [number, number, number]; max: [number, number, number] } = {
  min: [0, 0, -SIGN.thickness],
  max: [SIGN.width + 2 * SIGN.margin, SIGN.height + 2 * SIGN.margin, 0],
};

/**
 * How far below the stock bottom a cut may go: the bores' breakthrough (packages/cam
 * `DRILL_BREAKTHROUGH_MARGIN`, 0.5 mm) and the profile's 0.2 mm below the stock bottom.
 */
export const THROUGH_ALLOWANCE = 0.5;

/** Check one exported file with the G-code verifier (T5.4d); its report, with no issue. */
export function verifySignFile(
  text: string,
  dialect: Dialect,
  toolChange: ToolChangeStyle,
  tools: VerifyTool[],
): GcodeReport {
  const report = verifyGcode(text, {
    dialect,
    toolChange,
    stock: STOCK,
    machine: { travel: TRAVEL },
    tools,
    throughCutAllowance: THROUGH_ALLOWANCE,
  });
  if (!report.ok) throw new Error(report.error.message);
  expect(report.value.issues).toEqual([]);
  return report.value;
}

// --- The model -----------------------------------------------------------------------------

type V2 = [number, number];
const mm = (source: string) => ({ source, lengthUnit: 'mm', angleUnit: 'deg' });

const TOP_PLANE = { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] };
const onTopFace = (ref: string) => ({
  type: 'face',
  face: { id: ref, ref: { face: 'extrude#1:cap:end' } },
});

/**
 * A rounded rectangle from (x0, y0) to (x1, y1), corner radius r: lines and counter-clockwise
 * arcs, ids e`first` upwards, in order round the loop.
 */
function roundedRectangle(
  first: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
) {
  const id = (k: number) => `e${first + k}`;
  const line = (k: number, start: V2, end: V2) => ({
    id: id(k),
    kind: 'line',
    construction: false,
    start,
    end,
  });
  const arc = (k: number, center: V2, start: V2, end: V2) => ({
    id: id(k),
    kind: 'arc',
    construction: false,
    center,
    start,
    end,
  });
  return [
    line(0, [x0 + r, y0], [x1 - r, y0]),
    arc(1, [x1 - r, y0 + r], [x1 - r, y0], [x1, y0 + r]),
    line(2, [x1, y0 + r], [x1, y1 - r]),
    arc(3, [x1 - r, y1 - r], [x1, y1 - r], [x1 - r, y1]),
    line(4, [x1 - r, y1], [x0 + r, y1]),
    arc(5, [x0 + r, y1 - r], [x0 + r, y1], [x0, y1 - r]),
    line(6, [x0, y1 - r], [x0, y0 + r]),
    arc(7, [x0 + r, y0 + r], [x0, y0 + r], [x0 + r, y0]),
  ];
}

const sketch = (id: string, name: string, plane: unknown, entities: unknown[]) => ({
  id,
  kind: 'sketch',
  name,
  suppressed: false,
  plane,
  entities,
  constraints: [],
});

const { width: W, height: H, corner: R, border } = SIGN;
const grooveOuter = roundedRectangle(
  9,
  border.inset,
  border.inset,
  W - border.inset,
  H - border.inset,
  R - border.inset,
);
const inner = border.inset + border.width;
const grooveInner = roundedRectangle(17, inner, inner, W - inner, H - inner, 3);

/** The plate and the sketches on its top face, before the lettering: one undo step. */
export function plateCommands(): unknown[] {
  return [
    { type: 'renameDocument', name: SIGN.name },
    {
      type: 'addFeature',
      partId: 'part#1',
      feature: sketch('sketch#1', 'Outline', TOP_PLANE, roundedRectangle(1, 0, 0, W, H, R)),
    },
    {
      type: 'addFeature',
      partId: 'part#1',
      feature: {
        id: 'extrude#1',
        kind: 'extrude',
        name: 'Plate',
        suppressed: false,
        profile: { sketch: 'sketch#1' },
        operation: 'new',
        extent: { type: 'blind', distance: mm('#thickness') },
        reverse: false,
      },
    },
    {
      type: 'addFeature',
      partId: 'part#1',
      feature: sketch('sketch#2', 'Border', onTopFace('r1'), [...grooveOuter, ...grooveInner]),
    },
    {
      type: 'addFeature',
      partId: 'part#1',
      feature: sketch(
        'sketch#3',
        'Mounting holes',
        onTopFace('r2'),
        SIGN.holes.map((position, i) => ({
          id: `e${25 + i}`,
          kind: 'point',
          construction: false,
          position,
        })),
      ),
    },
  ];
}

/**
 * The cuts, once the lettering's sketch (`sketch#4`, named here) exists: the border groove (the
 * ring between the two rounded rectangles: the region whose outer loop is the outer one), the
 * holes and the letters.
 */
export function cutCommands(): unknown[] {
  return [
    { type: 'renameFeature', partId: 'part#1', featureId: 'sketch#4', name: 'Lettering' },
    {
      type: 'addFeature',
      partId: 'part#1',
      feature: {
        id: 'extrude#2',
        kind: 'extrude',
        name: 'Border recess',
        suppressed: false,
        profile: { sketch: 'sketch#2', entities: grooveOuter.map((e) => e.id) },
        operation: 'cut',
        extent: { type: 'blind', distance: mm(`${border.depth} mm`) },
        reverse: true,
      },
    },
    {
      type: 'addFeature',
      partId: 'part#1',
      feature: {
        id: 'hole#1',
        kind: 'hole',
        name: 'Mounting holes',
        suppressed: false,
        sketch: 'sketch#3',
        points: ['e25', 'e26'],
        diameter: mm(`${SIGN.hole} mm`),
        extent: { type: 'throughAll' },
        head: { type: 'simple' },
      },
    },
    {
      type: 'addFeature',
      partId: 'part#1',
      feature: {
        id: 'extrude#3',
        kind: 'extrude',
        name: 'Lettering recess',
        suppressed: false,
        profile: { sketch: 'sketch#4' },
        operation: 'cut',
        extent: { type: 'blind', distance: mm(`${SIGN.lettering.depth} mm`) },
        reverse: true,
      },
    },
  ];
}

/** Run `commands` as one undo step and wait until every feature regenerates without errors. */
export async function build(page: Page, commands: unknown[], label: string): Promise<void> {
  await execute(page, { type: 'batch', commands }, label);
  const results = await regenerated(page);
  for (const [id, r] of Object.entries(results)) {
    expect(r, id).toMatchObject({ status: 'ok', errors: [] });
  }
  await settle(page);
}

/** The plate's volume before any cut: the rectangle less the corner squares plus quarter discs. */
export function plateVolume(): number {
  return (W * H - (4 - Math.PI) * R * R) * SIGN.thickness;
}

/** The border groove's volume: the ring between the two rounded rectangles, times its depth. */
export function grooveVolume(): number {
  const area = (w: number, h: number, r: number) => w * h - (4 - Math.PI) * r * r;
  const o = border.inset;
  return (area(W - 2 * o, H - 2 * o, R - o) - area(W - 2 * inner, H - 2 * inner, 3)) * border.depth;
}

/** The holes' volume. */
export function holesVolume(): number {
  return SIGN.holes.length * Math.PI * (SIGN.hole / 2) ** 2 * SIGN.thickness;
}

// --- Numbers ---------------------------------------------------------------------------------

/** The computer a run measured on, for the numbers file. */
export function host(): { cpu: string; cores: number; os: string } {
  const c = cpus();
  return {
    cpu: c[0]?.model.trim() ?? 'unknown',
    cores: c.length,
    os: `${platform()} ${release()}`,
  };
}

// --- The lettering's area, from the font itself -------------------------------------------------

interface FontCommand {
  type: 'M' | 'L' | 'Q' | 'C' | 'Z';
  x: number;
  y: number;
  x1: number;
  y1: number;
}
interface Opentype {
  parse(buffer: ArrayBuffer): {
    tables: { os2: { sCapHeight: number } };
    charToGlyph(c: string): { path: { commands: FontCommand[] } };
  };
}

/**
 * Square millimetres of `text`'s letters in Inter Bold at a cap height of `size` mm: each glyph's
 * outline read from the bundled font with opentype.js and integrated exactly (Green's theorem
 * over its lines and quadratic Beziers), as svg-import.spec.ts does for the same fixture.
 */
export function wordArea(text: string, size: number): number {
  const textDir = new URL('../../../packages/text/', import.meta.url);
  const opentype = createRequire(new URL('package.json', textDir))('opentype.js') as Opentype;
  const bytes = readFileSync(new URL('fonts/Inter-Bold.ttf', textDir));
  const font = opentype.parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
  );
  const k = size / font.tables.os2.sCapHeight;
  let total = 0;
  for (const c of text) {
    let a = 0;
    let start = [0, 0];
    let at = [0, 0];
    const cross = (p: number[], q: number[]) => p[0]! * q[1]! - q[0]! * p[1]!;
    for (const cmd of font.charToGlyph(c).path.commands) {
      const to = [cmd.x, cmd.y];
      if (cmd.type === 'M') start = to;
      else if (cmd.type === 'L') a += cross(at, to);
      else if (cmd.type === 'Q') {
        const q = [cmd.x1, cmd.y1];
        a += (2 * cross(at, q) + 2 * cross(q, to) + cross(at, to)) / 3;
      } else if (cmd.type === 'Z') {
        a += cross(at, start);
        at = start;
        continue;
      } else throw new Error('Inter Bold has quadratic outlines only');
      at = to;
    }
    total += Math.abs(a / 2);
  }
  return total * k * k;
}

/** The word in the SVG fixture and its cap height there, mm. */
export const SVG_WORD_TEXT = 'WOODSHOP';
export const SVG_WORD_CAP_HEIGHT = 20;
