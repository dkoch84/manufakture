// The hardware catalog's first purchased parts: drawer slides (#1200). Two families, each a size
// series (by length) with the fit data a slide needs: how much room it takes between the cabinet
// and the drawer (a clearance model per mounting, discriminated by `kind`), the space its two
// members fill, and where their screw holes are. The `wood.slide` feature places one slide of a
// family between two boards from these numbers, and the cut list counts it as a hardware line.
//
// Nothing here is checked against a real part yet: every family is `verified: false`, as the
// print tables' rows are until a print confirms them, and says where its numbers come from. Check
// a real slide (and its maker's current drawing) before drilling. Lengths are millimetres.

/** The room a side-mount slide takes: a gap of its own between the cabinet side and the drawer. */
export interface SideMountClearance {
  kind: 'side-mount';
  /**
   * The gap between the cabinet side's face and the drawer side's outer face, per side: the
   * slide's thickness (`nominal`), and the range it runs in (`min` to `max`).
   */
  side: { nominal: number; min: number; max: number };
  /** The slide's height (both members), centred on the drawer side unless offset. */
  height: number;
}

/**
 * The room an undermount (concealed) slide takes: the runner sits under the drawer side, its
 * moving rail in the recess under the drawer bottom, so the drawer is built around it.
 */
export interface UndermountClearance {
  kind: 'undermount';
  /**
   * From the cabinet side's face to the drawer side's inner face, per side: the gap is this less
   * the drawer side's thickness (the maker's "inside drawer width is the opening less 2 x reach").
   */
  sideReach: number;
  /** How far the gap may be off `sideReach` less the side's thickness: the locking device's play. */
  sideAdjust: number;
  /** The drawer side thicknesses the runner is made for. */
  sideThickness: { min: number; max: number };
  /** The drawer bottom's underside above the drawer side's bottom edge, at least. */
  bottomRecess: number;
  /** Below the drawer side's bottom edge, to the cabinet's bottom: the runner's room. */
  bottomClearance: number;
  /** Above the drawer side, to whatever is over the opening, at least. */
  topClearance: number;
  /** The notch at each bottom corner of the drawer back, so the rail passes under it. */
  backNotch: { width: number; height: number };
  /** How far the runner reaches in from the cabinet side's face, under the drawer. */
  runnerWidth: number;
}

/** How a family's slide fits: one model per mounting. */
export type SlideClearance = SideMountClearance | UndermountClearance;

/** One size of a family: a nominal length, and what that length means for the parts. */
export interface SlideSize {
  /** The size's id in `params.size`: `18in`. */
  id: string;
  /** The nominal length the slide is sold by (18"), mm. */
  nominal: number;
  /** The cabinet member's length, mm (the closed slide's, for a side-mount). */
  cabinetLength: number;
  /** The drawer member's length, mm (the drawer's length, for an undermount). */
  drawerLength: number;
  /** How far the drawer comes out, mm. */
  travel: number;
  /** The least room behind the drawer's front for the cabinet member: the cabinet's depth, mm. */
  minCabinetDepth: number;
  /**
   * Screw holes, mm from the member's front end along its length, on the member's centre line:
   * into the cabinet side through the cabinet member, into the drawer through the drawer member.
   * An undermount's drawer is held by locking devices and rear hooks bored from a template, so
   * its `drawer` list is empty.
   */
  holes: { cabinet: readonly number[]; drawer: readonly number[] };
}

export interface SlideFamily {
  /** The id in `params.family`. */
  id: string;
  /** What the family is, in words. */
  name: string;
  /** The bill of materials line's item: the slides are bought by it. */
  item: string;
  mount: 'side' | 'under';
  extension: 'full';
  clearance: SlideClearance;
  /** Hole diameters, mm, and how the slide is screwed on. */
  screws: { cabinetHole: number; drawerHole: number | null; note: string };
  /** The sizes, shortest first. */
  sizes: readonly SlideSize[];
  /** Where the numbers come from. */
  source: string;
  /** False until checked against a real part (as the print tables' rows). */
  verified: boolean;
}

const IN = 25.4;
const round = (v: number) => Math.round(v * 1e4) / 1e4;

/**
 * The side-mount series, 10" to 28" in 2" steps. Closed length and travel per the drawing's table
 * (an 18" slide is 450 mm closed and travels 457 mm); the cabinet member's holes are its front
 * hole at 35 mm, the 128 mm pitch hole behind it (96 mm on 10" and 12") and the table's rear
 * holes; the drawer member's, the cam hole at 35 mm, 128 mm behind it and the table's.
 */
const SIDE_MOUNT_SIZES: readonly [number, number, number, number[], number[]][] = [
  // [nominal in, closed mm, travel mm, cabinet holes, drawer holes]
  [10, 250, 254, [35, 131, 192], [35, 163]],
  [12, 300, 305, [35, 131, 242], [35, 163, 224]],
  [14, 350, 356, [35, 163, 292], [35, 163, 224]],
  [16, 400, 406, [35, 163, 342], [35, 163, 224, 320]],
  [18, 450, 457, [35, 163, 320, 392], [35, 163, 224, 352]],
  [20, 500, 508, [35, 163, 320, 442], [35, 163, 224, 416]],
  [22, 550, 559, [35, 163, 320, 416, 492], [35, 163, 224, 352, 448]],
  [24, 600, 610, [35, 163, 224, 416, 542], [35, 163, 224, 352, 480]],
  [26, 650, 660, [35, 163, 224, 416, 544, 592], [35, 163, 224, 352, 544]],
  [28, 700, 711, [35, 163, 224, 288, 416, 544, 642], [35, 163, 224, 352, 544]],
];

/**
 * The undermount series (Blum TANDEM plus BLUMOTION 563H style), 9" to 21": the drawer's length
 * is the nominal one, the runner a little longer, the cabinet at least as deep as the table's
 * minimum inside depth, the runner's screws at the table's A and B for panel cabinets.
 */
const UNDERMOUNT_SIZES: readonly [number, number, number, number, number[]][] = [
  // [nominal in, drawer mm, runner mm, min inside depth mm, cabinet holes]
  [9, 229, 259, 266, [133, 229]],
  [12, 305, 319, 328, [165, 261]],
  [15, 381, 395, 404, [165, 357]],
  [18, 457, 471, 480, [261, 453]],
  [21, 533, 548, 557, [261, 517]],
];

export const SLIDE_FAMILIES: readonly SlideFamily[] = [
  {
    id: 'side-mount-ball-bearing',
    name: 'Side-mount ball-bearing slide, full extension (100 lb class)',
    item: 'Drawer slide, side-mount ball-bearing, full extension',
    mount: 'side',
    extension: 'full',
    clearance: {
      kind: 'side-mount',
      side: { nominal: 12.7, min: 12.7, max: 13.5 },
      height: 45.7,
    },
    screws: {
      cabinetHole: 4.4,
      drawerHole: 4.3,
      note: "#8 pan head wood screws or 6 mm Euro system screws; the slide's slots allow some adjustment",
    },
    sizes: SIDE_MOUNT_SIZES.map(([inches, closed, travel, cabinet, drawer]) => ({
      id: `${inches}in`,
      nominal: round(inches * IN),
      cabinetLength: closed,
      drawerLength: closed,
      travel,
      minCabinetDepth: closed,
      holes: { cabinet, drawer },
    })),
    source:
      'Accuride 3832E drawing (3700-9464, 2016): 45.7 mm high, side space 1/2" +1/32" -0 per side, closed lengths and travel from its table, hole positions read from its drawing and table; a generic series in its footprint, not that part',
    verified: false,
  },
  {
    id: 'undermount-concealed',
    name: 'Undermount concealed slide, full extension, for 1/2" to 5/8" drawer sides',
    item: 'Drawer slide, undermount concealed, full extension (with locking devices)',
    mount: 'under',
    extension: 'full',
    clearance: {
      kind: 'undermount',
      sideReach: 21,
      sideAdjust: 1.5,
      sideThickness: { min: 12, max: 16 },
      bottomRecess: 13,
      bottomClearance: 14,
      topClearance: 6,
      backNotch: { width: 35, height: 13 },
      runnerWidth: 37,
    },
    screws: {
      cabinetHole: 2.5,
      drawerHole: null,
      note: "the runner is screwed to the cabinet side; the drawer hangs on locking devices under its front and hooks bored into its back from the maker's template",
    },
    sizes: UNDERMOUNT_SIZES.map(([inches, drawer, runner, depth, cabinet]) => ({
      id: `${inches}in`,
      nominal: round(inches * IN),
      cabinetLength: runner,
      drawerLength: drawer,
      travel: drawer,
      minCabinetDepth: depth,
      holes: { cabinet, drawer: [] },
    })),
    source:
      'Blum TANDEM plus BLUMOTION 563H specifications (2012) and installation instructions (2015): inside drawer width the opening less 42 mm, sides 12 to 16 mm, 13 mm bottom recess, 14 mm bottom clearance, 6 mm top clearance, runner lengths, minimum inside depths and screw positions A and B from their tables; the 35 x 13 mm back notch from their drawer preparation; a generic series in its footprint, not that part',
    verified: false,
  },
];

/** A family by id. */
export function findSlideFamily(id: string): SlideFamily | undefined {
  return SLIDE_FAMILIES.find((f) => f.id === id);
}

/** A size of a family by its id (`18in`). */
export function findSlideSize(family: SlideFamily, id: string): SlideSize | undefined {
  return family.sizes.find((s) => s.id === id);
}
