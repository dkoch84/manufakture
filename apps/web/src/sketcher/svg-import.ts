// SVG import into a sketch (M5 T5.8). `@manufakture/io` reads the file once (`parseSvg`); the
// dialog then makes one of two things from it, each added by the session as one undoable edit:
//
// - **An outline** (the default, ADR 0012 decision 7): one `outline` entity with an `svg` source
//   holding the file's shapes as paths of lines and Beziers (`svgOutlinePaths`, elliptical arcs as
//   cubics within 0.001 mm), placed by its anchor. The solver sees the anchor only, so a whole
//   sign fits in a sketch; regen turns the paths into regions by each shape's fill rule, and its
//   `scale` may be an expression.
// - **Sketch geometry**, for small artwork the user wants to edit: lines, circular arcs and
//   circles (`fitSvg`, curves to arcs within a tolerance), with no constraints. Geometry no
//   constraint touches is never moved by a solve. A `fix` per point would pin it, but it costs
//   equations the published planegcs cannot hold: its 16 MiB heap and dense diagnosis abort with
//   Aborted(OOM) from about 160 fixed lines in one sketch (measured), and an arc pinned at its
//   centre and both ends is redundant. Arcs cost equations even unconstrained (four each, to keep
//   their ends on the circle), and the diagnosis is dense over all of a sketch's unknowns: 110
//   free arcs solve, 120 abort; 50 arcs beside 500 free lines solve, beside 1,000 they abort.
//   So this mode is refused when the sketch would be past `MAX_SOLVER_LOAD` (equations times
//   unknowns, which is what the abort follows), and the dialog offers an outline, lines only or
//   a coarser tolerance instead.

import {
  DEFAULT_SVG_OUTLINE_TOLERANCE,
  DEFAULT_SVG_TOLERANCE,
  SvgImportError,
  fitSvg,
  parseSvg,
  placeSvgImport,
  svgAnchorPoint,
  svgImportCounts,
  svgOutlinePaths,
  type ParsedSvg,
  type SvgAnchor,
  type SvgImport,
  type SvgOutlineCommand,
  type SvgOutlinePaths,
  type SvgSegment,
} from '@manufakture/io';
import {
  MAX_SKETCH_SVG_COMMANDS,
  MAX_SVG_OUTLINE_COMMANDS,
  MAX_SVG_OUTLINE_PATHS,
  svgCommandCount,
} from '@manufakture/core';
import type {
  OutlineEntity,
  PathCommand,
  SketchConstraint,
  SketchEntity,
  SketchInput,
  StoredExpression,
  SvgOutlinePath,
  Vec2,
} from '@manufakture/sketch/model';
import { tempId, type Draft } from './draft';

/** The most entities one import as sketch geometry may add: past this every solve slows down. */
export const MAX_IMPORT_ENTITIES = 3000;

/**
 * Equations times unknowns a sketch may reach (`solverLoad`). Measured aborts start at about
 * 500,000 (120 free arcs, or 50 arcs and 1,000 lines); this keeps a margin.
 */
export const MAX_SOLVER_LOAD = 400_000;

/** Larger files are refused before they are read. */
export const MAX_SVG_FILE_BYTES = 16 * 1024 * 1024;

/** The stored name of the file is cut to this many UTF-16 units (core allows 255). */
const MAX_FILE_NAME = 255;

/**
 * The largest coordinate (mm, either sign) artwork may have: a 2 km sign is past any machine, and
 * the bound keeps every shift, rounding and scale of the coordinates finite.
 */
export const MAX_ARTWORK_MM = 1e6;

/** `s` cut to at most `max` UTF-16 units, never between the two halves of a surrogate pair. */
export function truncateUtf16(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export type SvgImportMode = 'outline' | 'entities';

export interface SvgImportSettings {
  /** Multiplies the file's own size. */
  scale: number;
  /** Largest distance between a curve and its arcs, mm (sketch geometry only). */
  tolerance: number;
  anchor: SvgAnchor;
  /** Where the anchor goes, sketch millimetres. */
  at: Vec2;
  /** Curves as arcs and lines, or as lines only (sketch geometry only). */
  curves: 'arcs' | 'lines';
}

export const DEFAULT_SVG_SETTINGS: SvgImportSettings = {
  scale: 1,
  tolerance: DEFAULT_SVG_TOLERANCE,
  anchor: 'bottom-left',
  at: [0, 0],
  curves: 'arcs',
};

export type Outcome<T> = { ok: true; value: T } | { ok: false; message: string };

/** Read a file once, or say why it cannot be imported. */
export function readSvg(text: string): Outcome<ParsedSvg> {
  try {
    const parsed = parseSvg(text);
    if (parsed.shapes.length === 0) {
      return { ok: false, message: 'The file has no shapes to import.' };
    }
    return { ok: true, value: parsed };
  } catch (e) {
    if (e instanceof SvgImportError) return { ok: false, message: e.message };
    throw e;
  }
}

// Outline ------------------------------------------------------------------------------------

/** The artwork as an outline source's paths, in the file's millimetres (scale 1), with its extent. */
export interface SvgArtwork {
  paths: readonly { fillRule: 'nonzero' | 'evenodd'; commands: readonly SvgOutlineCommand[] }[];
  bounds: { min: Vec2; max: Vec2 };
  page: ParsedSvg['page'];
  commands: number;
}

/**
 * The parsed file as outline paths (no fit: Beziers stay Beziers), or why not. The caps (shapes,
 * path commands, coordinates) are checked by `svgOutlinePaths` while it builds the paths, so a
 * hostile file stops at the first command past them.
 */
export function svgArtwork(parsed: ParsedSvg): Outcome<SvgArtwork> {
  let out: SvgOutlinePaths;
  try {
    out = svgOutlinePaths(parsed, {
      tolerance: DEFAULT_SVG_OUTLINE_TOLERANCE,
      maxCommands: MAX_SVG_OUTLINE_COMMANDS,
      maxPaths: MAX_SVG_OUTLINE_PATHS,
      // Every coordinate within MAX_ARTWORK_MM, so moving and rounding them stays finite.
      maxCoordinate: MAX_ARTWORK_MM,
    });
  } catch (e) {
    if (!(e instanceof SvgImportError)) throw e;
    switch (e.limit) {
      case 'paths':
        return {
          ok: false,
          message: `The drawing has more than the ${MAX_SVG_OUTLINE_PATHS.toLocaleString('en')} shapes one outline holds. Simplify it, or import it in parts.`,
        };
      case 'commands':
        return {
          ok: false,
          message: `The drawing makes more than the ${MAX_SVG_OUTLINE_COMMANDS.toLocaleString('en')} path commands one outline holds. Simplify it, or import it in parts.`,
        };
      case 'coordinates':
        return {
          ok: false,
          message: `The drawing reaches past ${MAX_ARTWORK_MM.toLocaleString('en')} mm from the page's corner: check its size and units.`,
        };
      default:
        return { ok: false, message: e.message };
    }
  }
  if (!out.bounds || out.paths.length === 0) {
    return { ok: false, message: 'The file has no shapes to import.' };
  }
  return {
    ok: true,
    value: { paths: out.paths, bounds: out.bounds, page: parsed.page, commands: out.commands },
  };
}

/**
 * Why adding the artwork to `sketch` would break the sketch's cap on SVG path commands
 * (`MAX_SKETCH_SVG_COMMANDS`, over all its SVG outlines), or null.
 */
export function outlineProblem(
  sketch: Pick<SketchInput, 'entities'>,
  art: Pick<SvgArtwork, 'commands'>,
): string | null {
  let used = 0;
  for (const e of sketch.entities) {
    if (e.kind === 'outline' && e.source.kind === 'svg') used += svgCommandCount(e.source.paths);
  }
  if (used + art.commands <= MAX_SKETCH_SVG_COMMANDS) return null;
  return `This sketch already has ${used.toLocaleString('en')} path commands of SVG artwork; with this drawing's ${art.commands.toLocaleString('en')} it would have more than the ${MAX_SKETCH_SVG_COMMANDS.toLocaleString('en')} a sketch holds. Import it into a sketch of its own.`;
}

/** Coordinates to a nanometre: far below any tolerance, and about half the size in a file. */
const round = (v: number) => Math.round(v * 1e6) / 1e6 + 0;

/**
 * The artwork as one outline entity (temporary id): its paths moved so the anchor point
 * (`settings.anchor` of the artwork at scale 1) is their origin, the entity's anchor at
 * `settings.at`, and `scale` stored unless it is 1.
 */
export function svgOutlineDraft(
  art: SvgArtwork,
  fileName: string,
  anchor: SvgAnchor,
  at: Vec2,
  scale: StoredExpression | null,
): Draft {
  const [ox, oy] = svgAnchorPoint(art.bounds, art.page, anchor);
  const p = (v: Vec2): Vec2 => [round(v[0] - ox), round(v[1] - oy)];
  const paths: SvgOutlinePath[] = art.paths.map((path) => ({
    fillRule: path.fillRule,
    commands: path.commands.map((c): PathCommand => {
      switch (c.kind) {
        case 'close':
          return { kind: 'close' };
        case 'moveTo':
        case 'lineTo':
          return { kind: c.kind, to: p(c.to) };
        case 'quadTo':
          return { kind: 'quadTo', control: p(c.control), to: p(c.to) };
        case 'cubicTo':
          return {
            kind: 'cubicTo',
            control1: p(c.control1),
            control2: p(c.control2),
            to: p(c.to),
          };
      }
    }),
  }));
  const entity: OutlineEntity = {
    id: tempId(0),
    kind: 'outline',
    construction: false,
    anchor: at,
    angle: 0,
    source: {
      kind: 'svg',
      fileName: truncateUtf16(fileName, MAX_FILE_NAME),
      paths,
      ...(scale && scale.source.trim() !== '1' ? { scale } : {}),
    },
  };
  return { entities: [entity], constraints: [] };
}

// Sketch geometry ----------------------------------------------------------------------------

/**
 * The parsed file as lines, arcs and circles at a scale (the page's bottom left corner at the
 * origin), or why it cannot be. Placing it is `placeSvgImport`, which needs no new fit.
 */
export function fitArtwork(
  parsed: ParsedSvg,
  settings: Pick<SvgImportSettings, 'scale' | 'tolerance' | 'curves'>,
): Outcome<SvgImport> {
  let result: SvgImport;
  try {
    result = fitSvg(parsed, {
      scale: settings.scale,
      tolerance: settings.tolerance,
      maxSegments: MAX_IMPORT_ENTITIES,
      curves: settings.curves,
    });
  } catch (e) {
    if (e instanceof SvgImportError) {
      const message =
        e.code === 'too-complex' && e.message.includes('lines and arcs')
          ? `The drawing makes more than ${MAX_IMPORT_ENTITIES.toLocaleString('en')} lines and arcs, more than a sketch takes at once. Import it as an outline, raise the tolerance, or simplify the drawing.`
          : e.message;
      return { ok: false, message };
    }
    if (e instanceof RangeError) return { ok: false, message: e.message };
    throw e;
  }
  if (result.contours.length === 0 && result.circles.length === 0) {
    return { ok: false, message: 'The file has no shapes to import.' };
  }
  return { ok: true, value: result };
}

/** `fitArtwork`, then placed: what the sketch-geometry import adds. */
export function fitAndPlace(parsed: ParsedSvg, settings: SvgImportSettings): Outcome<SvgImport> {
  const fitted = fitArtwork(parsed, settings);
  return fitted.ok
    ? { ok: true, value: placeSvgImport(fitted.value, settings.anchor, settings.at) }
    : fitted;
}

/** A sketch entity for one imported segment; arcs run counter-clockwise, as sketch arcs do. */
function segmentEntity(s: SvgSegment, id: string): SketchEntity {
  if (s.kind === 'line') {
    return { id, kind: 'line', construction: false, start: s.start, end: s.end };
  }
  return s.clockwise
    ? { id, kind: 'arc', construction: false, center: s.center, start: s.end, end: s.start }
    : { id, kind: 'arc', construction: false, center: s.center, start: s.start, end: s.end };
}

/** The import as a draft: lines, arcs and circles with temporary ids and no constraints. */
export function svgDraft(result: SvgImport): Draft {
  const entities: SketchEntity[] = [];
  // io drops anything not finite; checked again here, since a sketch must never hold it.
  const finite = (...v: number[]) => v.every(Number.isFinite);
  for (const contour of result.contours) {
    for (const s of contour.segments) {
      if (!finite(...s.start, ...s.end, ...(s.kind === 'arc' ? s.center : []))) continue;
      entities.push(segmentEntity(s, tempId(entities.length)));
    }
  }
  for (const c of result.circles) {
    if (!finite(...c.center, c.radius) || !(c.radius > 0)) continue;
    entities.push({
      id: tempId(entities.length),
      kind: 'circle',
      construction: false,
      center: c.center,
      radius: c.radius,
    });
  }
  return { entities, constraints: [] };
}

/** "12 lines, 30 arcs and 1 circle", for the dialog and the status bar. */
export function describeCounts(result: SvgImport): string {
  const { lines, arcs, circles } = svgImportCounts(result);
  const parts = [
    [lines, 'line', 'lines'],
    [arcs, 'arc', 'arcs'],
    [circles, 'circle', 'circles'],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  if (parts.length <= 1) return parts[0] ?? 'nothing';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Equations a constraint adds to planegcs (what `packages/sketch/src/ops.ts` compiles it to). */
function constraintEquations(c: SketchConstraint): number {
  switch (c.kind) {
    case 'coincident':
    case 'fix':
    case 'midpoint':
    case 'symmetric':
      return 2;
    case 'tangent':
      return c.at ? 3 : 1;
    default:
      return 1;
  }
}

/**
 * An estimate of what solving a sketch costs planegcs's memory: its equations (constraints, and
 * four per arc) times its unknowns (every coordinate, the fixed origin and axes included).
 */
export function solverLoad(sketch: Pick<SketchInput, 'entities' | 'constraints'>): number {
  let equations = 0;
  let unknowns = 6;
  for (const e of sketch.entities) {
    switch (e.kind) {
      case 'point':
      case 'outline':
        unknowns += 2;
        break;
      case 'line':
        unknowns += 4;
        break;
      case 'circle':
        unknowns += 3;
        break;
      case 'arc':
        unknowns += 9;
        equations += 4;
        break;
    }
  }
  for (const c of sketch.constraints) equations += constraintEquations(c);
  return equations * unknowns;
}

/**
 * Why adding `draft` to `sketch` would be too much for the solver, or null. The message says
 * what to do instead.
 */
export function importProblem(
  sketch: Pick<SketchInput, 'entities' | 'constraints'>,
  draft: Draft,
  curves: SvgImportSettings['curves'],
): string | null {
  const after = {
    entities: [...sketch.entities, ...draft.entities],
    constraints: sketch.constraints,
  };
  if (solverLoad(after) <= MAX_SOLVER_LOAD) return null;
  const arcs = after.entities.filter((e) => e.kind === 'arc').length;
  const advice =
    curves === 'arcs'
      ? 'Import it as an outline, import curves as lines, or raise the tolerance.'
      : 'Import it as an outline, or simplify the drawing.';
  return `With this drawing the sketch would have ${after.entities.length.toLocaleString('en')} entities (${arcs} arcs), more than the sketch solver can hold in one sketch. ${advice}`;
}
