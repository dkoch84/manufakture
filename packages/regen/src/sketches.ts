// Sketches at regen: solved as stored, statelessly (a fresh solver system per solve, ADR 0007
// decision 4), then split into regions (`detectRegions`). A sketch makes no geometry of its
// own; extrudes, revolves and holes read its solved entities, regions and placement.
//
// Outline entities (text, ADR 0012 decision 7) are expanded after the solve, once their anchors
// are placed: each text is laid out in its font and its glyphs turned into region loops by the
// text outliner (`text.ts`, in a text worker under a watchdog), placed at the anchor and angle
// (`placeOutline`), and handed to `detectRegions` with the sketch's own curves. Glyph geometry
// never reaches the solver.

import type { DocumentFont, OutlineEntity, SketchFeature, SketchPlane } from '@manufakture/core';
import {
  detectRegions,
  outlinePartsSize,
  placeOutline,
  placementFromNormal,
  regionProfile,
  type OutlineShape,
  type Region,
  type RegionDiagnostic,
  type SketchEntity,
  type SketchPlacement,
  type SketchSolverApi,
  type SolveResult,
} from '@manufakture/sketch';
import type { SketchProfile } from '@manufakture/kernel';
import {
  TextCancelled,
  type TextBudget,
  type TextOutliner,
  type TextReply,
  type TextRequest,
} from './text';
import { pathKey, type VariableValues } from './values';
import type { RegenError, RegenWarning } from './types';

/** What the regen solver needs: the stateless `solve` of the solver worker's API. */
export type RegenSolver = Pick<SketchSolverApi, 'solve'>;

/** A solved sketch, as its dependents read it. Plain data; cached per sketch key. */
export interface SketchResult {
  placement: SketchPlacement;
  /** Entities with solved coordinates. */
  entities: SketchEntity[];
  /** Filled regions (even nesting depth, and every outline region), sorted by id. */
  regions: Region[];
  /** Regions inside holes; selectable by listing their entities. */
  voids: Region[];
  diagnostics: RegionDiagnostic[];
  /**
   * The loops of every outline entity (construction ones too, which bound no region), placed in
   * the sketch: what the sketcher draws for a text. Empty without outlines.
   */
  outlines: OutlineShape[];
}

/** An explicit plane as a normalised placement. */
export function explicitPlacement(plane: Extract<SketchPlane, { type: 'plane' }>): SketchPlacement {
  return placementFromNormal(plane.origin, plane.normal, plane.xDir);
}

export type SolveOutcome =
  | { ok: true; sketch: SketchResult; warnings: RegenWarning[] }
  | {
      ok: false;
      errors: RegenError[];
      /** The failure may not happen again (see `OutlineExpansion.transient`): do not cache it. */
      transient?: boolean;
    };

/** The expanded outlines of a solved sketch: see `expandOutlines`. */
export interface OutlineExpansion {
  /** The shapes of every outline, construction ones included, in entity order. */
  shapes: OutlineShape[];
  /** The ids of construction outlines: their shapes bound no region. */
  construction: Set<string>;
  errors: RegenError[];
  warnings: RegenWarning[];
  /**
   * An error may not happen again (a bundled font that could not be fetched in time, a time
   * budget used up): the sketch's result must not be cached.
   */
  transient: boolean;
}

/**
 * Most curves the texts of one sketch may place in all: one text at its limit
 * (`MAX_TEXT_CURVES`), three times what the 10,000 characters core allows a sketch's texts make in
 * Inter Bold (about 167,000). Bounds what `detectRegions` and the kernel get from text, however
 * many texts a sketch has and whatever font they use.
 */
export const MAX_SKETCH_OUTLINE_CURVES = 500_000;

/** What expanding outlines needs besides the sketch: the document's fonts and the outliner. */
export interface OutlineContext {
  fonts: readonly DocumentFont[];
  /** The feature's evaluated expressions, by `pathKey` (sizes and spacings among them). */
  values: ReadonlyMap<string, number>;
  outliner: TextOutliner;
  /** Aborted when a newer regen supersedes this one: the text in flight stops. */
  signal?: AbortSignal;
  /** The regen's time budget for text (`TextBudget`). */
  budget?: TextBudget;
  /**
   * Throws when a newer regen supersedes this one; called between texts, so a sketch of many
   * texts stops at the next one.
   */
  checkStale?: () => void;
  /** Default `MAX_SKETCH_OUTLINE_CURVES`. */
  maxCurves?: number;
}

/**
 * The character at a code point position of a text (line breaks counted), as glyph indices are,
 * from the text's code points (`[...text]`, made once per text).
 */
function charAt(codePoints: readonly string[], index: number): string {
  return codePoints[index] ?? '?';
}

/**
 * Lays out every outline entity of a solved sketch and turns it into placed shapes. A font the
 * document does not have, a size that is not above 0, a font that could not be read and a glyph
 * that could not be converted are errors (the sketch fails rather than lose letters silently);
 * missing characters, kerning that could not be read, touching loops and a bundled font that is
 * not the file the text was made with are warnings.
 */
export async function expandOutlines(
  feature: SketchFeature,
  solved: readonly SketchEntity[],
  context: OutlineContext,
): Promise<OutlineExpansion> {
  const out: OutlineExpansion = {
    shapes: [],
    construction: new Set(),
    errors: [],
    warnings: [],
    transient: false,
  };
  const byId = new Map(solved.map((e) => [e.id, e]));
  const maxCurves = context.maxCurves ?? MAX_SKETCH_OUTLINE_CURVES;
  let curves = 0;
  for (const [i, stored] of feature.entities.entries()) {
    if (stored.kind !== 'outline') continue;
    context.checkStale?.();
    const entity = (byId.get(stored.id) ?? stored) as OutlineEntity;
    const field = (...rest: string[]) => ['entities', i, 'source', ...rest];
    const { source } = entity;
    const font = context.fonts.find((f) => f.id === source.font);
    if (!font) {
      out.errors.push({
        code: 'invalid',
        field: field('font'),
        message: `The text ${entity.id} uses font ${source.font}, which the document does not have`,
      });
      continue;
    }
    const value = (name: string, fallback: number) =>
      context.values.get(pathKey(field(name))) ?? fallback;
    const size = value('size', Number.NaN);
    if (!(size > 0) || !Number.isFinite(size)) {
      out.errors.push({
        code: 'invalid',
        field: field('size'),
        message: `The text size of ${entity.id} must be above 0`,
      });
      continue;
    }
    const letterSpacing = value('letterSpacing', 0);
    const lineSpacing = value('lineSpacing', 1);
    if (!Number.isFinite(letterSpacing) || !Number.isFinite(lineSpacing)) {
      out.errors.push({
        code: 'invalid',
        field: field(Number.isFinite(letterSpacing) ? 'lineSpacing' : 'letterSpacing'),
        message: `The spacing of ${entity.id} must be a finite number`,
      });
      continue;
    }
    const request: TextRequest = {
      font:
        font.source.kind === 'bundled'
          ? { kind: 'bundled', id: font.source.id }
          : {
              kind: 'file',
              fileName: font.source.fileName,
              size: font.source.size,
              sha256: font.source.sha256,
              data: font.source.data,
            },
      text: source.text,
      size,
      align: source.align,
      letterSpacing,
      lineSpacing,
    };
    let reply: TextReply;
    try {
      reply = await context.outliner.outline(request, {
        ...(context.signal ? { signal: context.signal } : {}),
        ...(context.budget ? { budget: context.budget } : {}),
      });
    } catch (error) {
      // Cancelled because a newer regen superseded this one: say so the engine's way.
      if (error instanceof TextCancelled) context.checkStale?.();
      throw error;
    }
    context.checkStale?.();
    if (!reply.ok) {
      if (reply.transient) out.transient = true;
      out.errors.push(
        reply.code === 'font'
          ? { code: 'font', fontId: font.id, field: field('font'), message: reply.message }
          : { code: 'invalid', field: field('text'), message: `${entity.id}: ${reply.message}` },
      );
      continue;
    }
    const warn = (message: string, extra: { missing?: string[] } = {}) =>
      out.warnings.push({ code: 'text', message, entityId: entity.id, ...extra });
    if (font.source.kind === 'bundled' && reply.sha256 !== font.source.sha256) {
      out.warnings.push({
        code: 'font-changed',
        message: `The bundled font ${font.family} ${font.style} is not the file ${entity.id} was made with (an app update changed it); the text may look different`,
        fontId: font.id,
      });
    }
    if (reply.missing.length > 0) {
      warn(
        `${font.family} ${font.style} has no glyph for ${reply.missing.map((c) => `"${c}"`).join(', ')}; ${reply.missing.length === 1 ? 'it is' : 'they are'} left out of ${entity.id}`,
        { missing: [...reply.missing] },
      );
    }
    for (const w of reply.warnings) warn(`${entity.id}: ${w}`);
    let failed = false;
    const codePoints = reply.result.issues.length > 0 ? [...source.text] : [];
    for (const issue of reply.result.issues) {
      const chars = issue.parts.map((p) => `"${charAt(codePoints, reply.glyphs[p] ?? -1)}"`);
      const what = `${chars.join(', ')} in ${entity.id}`;
      if (issue.severity === 'error') {
        failed = true;
        out.errors.push({
          code: 'invalid',
          field: field('text'),
          message: `The outline of ${what} could not be converted: ${issue.message}`,
        });
      } else if (issue.severity === 'warning') {
        warn(`${what}: ${issue.message}`);
      }
    }
    if (failed) continue;
    const placing = outlinePartsSize(reply.result).curves;
    if (curves + placing > maxCurves) {
      out.errors.push({
        code: 'invalid',
        field: field('text'),
        message: `The texts of this sketch are too complex: with ${entity.id} they make ${curves + placing} curves, and a sketch's texts may make at most ${maxCurves}; shorten them, or put some in another sketch`,
      });
      continue;
    }
    curves += placing;
    const shapes = placeOutline(entity, reply.glyphs, reply.result);
    out.shapes.push(...shapes);
    if (entity.construction) out.construction.add(entity.id);
  }
  return out;
}

/** Turn a solver result (and the sketch's expanded outlines) into regions, or into feature errors. */
export function sketchOutcome(
  feature: SketchFeature,
  placement: SketchPlacement,
  result: SolveResult,
  outlines?: OutlineExpansion,
): SolveOutcome {
  if (result.status !== 'solved') {
    if (result.status === 'invalid' && result.issues.length > 0) {
      return {
        ok: false,
        errors: result.issues.map((issue): RegenError => {
          if (issue.code === 'expression' && issue.error && issue.constraintId !== undefined) {
            const i = feature.constraints.findIndex((c) => c.id === issue.constraintId);
            return {
              code: 'expression',
              message: issue.message,
              field: ['constraints', i, 'value'],
              error: issue.error,
            };
          }
          return {
            code: 'sketch',
            message: issue.message,
            conflicting: [],
            redundant: [],
          };
        }),
      };
    }
    const { conflicting, redundant } = result.diagnosis;
    const message =
      result.message ??
      (result.status === 'conflicting'
        ? `Conflicting constraints: ${conflicting.join(', ')}`
        : `The sketch did not solve (${result.status})`);
    return {
      ok: false,
      errors: [
        { code: 'sketch', message, conflicting: [...conflicting], redundant: [...redundant] },
      ],
    };
  }
  if (outlines && outlines.errors.length > 0) {
    return {
      ok: false,
      errors: outlines.errors,
      ...(outlines.transient ? { transient: true } : {}),
    };
  }
  const warnings: RegenWarning[] = [];
  if (result.diagnosis.redundant.length > 0) {
    warnings.push({
      code: 'redundant',
      message: `Redundant constraints (ignored): ${result.diagnosis.redundant.join(', ')}`,
      constraints: [...result.diagnosis.redundant],
    });
  }
  if (outlines) warnings.push(...outlines.warnings);
  const shapes = outlines?.shapes ?? [];
  const found = detectRegions(result.entities, {
    outlines: shapes.filter((s) => !outlines!.construction.has(s.entityId)),
  });
  for (const d of found.diagnostics) {
    if (d.severity !== 'warning') continue;
    warnings.push({
      code: 'sketch',
      message: d.message,
      diagnostic: d.code,
      entityIds: d.entityIds,
    });
  }
  return {
    ok: true,
    sketch: {
      placement,
      entities: result.entities,
      regions: found.regions,
      voids: found.voids,
      diagnostics: found.diagnostics,
      outlines: shapes,
    },
    warnings,
  };
}

/**
 * Solve a stored sketch with the document's variables. A sketch with outline entities needs
 * `text` (the document's fonts, the feature's evaluated values and the outliner); without it,
 * its outlines bound nothing.
 */
export async function solveSketch(
  solver: RegenSolver,
  feature: SketchFeature,
  placement: SketchPlacement,
  variables: VariableValues,
  text?: OutlineContext,
): Promise<SolveOutcome> {
  const result = await solver.solve(
    { entities: feature.entities, constraints: feature.constraints },
    variables.record,
  );
  const hasOutlines = feature.entities.some((e) => e.kind === 'outline');
  const outlines =
    result.status === 'solved' && hasOutlines && text
      ? await expandOutlines(feature, result.entities, text)
      : undefined;
  return sketchOutcome(feature, placement, result, outlines);
}

/**
 * The fonts a sketch's outlines use, for its cache key: each font's id, where it is and its
 * SHA-256, and for a bundled font the SHA-256 of the file this build ships under its id, so a
 * changed bundled file is a cache miss.
 */
export function sketchFontKey(
  feature: SketchFeature,
  fonts: readonly DocumentFont[],
  bundledSha256: (id: string) => string | undefined,
): unknown[] {
  const used = new Set<string>();
  for (const e of feature.entities) if (e.kind === 'outline') used.add(e.source.font);
  return [...used].sort().map((id) => {
    const font = fonts.find((f) => f.id === id);
    if (!font) return [id, null];
    const { source } = font;
    return source.kind === 'bundled'
      ? [id, 'bundled', source.id, source.sha256, bundledSha256(source.id) ?? null]
      : [id, 'file', source.sha256, source.size];
  });
}

/**
 * The regions a profile uses. Without `entities`, every filled region. With `entities`, every
 * region or void whose outer loop runs only along listed entities: a rectangle's four lines pick
 * the rectangle (with any holes in it), and listing a hole's circle as well picks the disk inside
 * it too. A text's id picks its letters; the counters of letters inside a face (the inside of an
 * "O") go with that face's entities (`Region.selectedWith`), so a plate's lines pick the plate
 * with letter-shaped holes and the counters, as a stencil that does not lose them.
 */
export function selectRegions(
  sketch: SketchResult,
  entities: readonly string[] | undefined,
): { ok: true; regions: Region[] } | { ok: false; error: RegenError } {
  if (entities === undefined) return { ok: true, regions: sketch.regions };
  const known = new Set(sketch.entities.map((e) => e.id));
  const missing = entities.filter((id) => !known.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      error: {
        code: 'reference-lost',
        referenceId: 'profile',
        missing,
        message: `The profile uses ${missing.join(', ')}, which the sketch no longer has: re-pick the profile`,
      },
    };
  }
  const listed = new Set(entities);
  // The counter of a letter goes with the face around the text (`selectedWith`), not the text.
  const picks = [...sketch.regions, ...sketch.voids].filter((r) =>
    r.selectedWith
      ? r.selectedWith.every((id) => listed.has(id))
      : r.outer.curves.every((c) => listed.has(c.entityId)),
  );
  return { ok: true, regions: picks };
}

/**
 * The kernel profile of a sketch's selected regions: one region's loops as they are, several as
 * `regions`, each with its holes, in region id order (the kernel numbers their caps by its own
 * edge id order, so the order here does not change any name).
 */
export function profileOf(
  sketchId: string,
  sketch: SketchResult,
  entities: readonly string[] | undefined,
): { ok: true; profile: SketchProfile } | { ok: false; error: RegenError } {
  const picked = selectRegions(sketch, entities);
  if (!picked.ok) return picked;
  const { regions } = picked;
  if (regions.length === 0) {
    return {
      ok: false,
      error: {
        code: 'invalid',
        field: ['profile'],
        message: `${sketchId} has no closed region${entities ? ' bounded by the chosen entities' : ''}`,
      },
    };
  }
  const profiles = regions.map((r) => regionProfile(r, sketch.placement));
  const frame = profiles[0]!.frame;
  if (profiles.length === 1) return { ok: true, profile: { frame, loops: profiles[0]!.loops } };
  return { ok: true, profile: { frame, regions: profiles.map((p) => ({ loops: p.loops })) } };
}
