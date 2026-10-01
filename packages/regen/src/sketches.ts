// Sketches at regen: solved as stored, statelessly (a fresh solver system per solve, ADR 0007
// decision 4), then split into regions (`detectRegions`). A sketch makes no geometry of its
// own; extrudes, revolves and holes read its solved entities, regions and placement.

import type { SketchFeature, SketchPlane } from '@manufakture/core';
import {
  detectRegions,
  placementFromNormal,
  regionProfile,
  type Region,
  type RegionDiagnostic,
  type SketchEntity,
  type SketchPlacement,
  type SketchSolverApi,
  type SolveResult,
} from '@manufakture/sketch';
import type { SketchProfile } from '@manufakture/kernel';
import type { VariableValues } from './values';
import type { RegenError, RegenWarning } from './types';

/** What the regen solver needs: the stateless `solve` of the solver worker's API. */
export type RegenSolver = Pick<SketchSolverApi, 'solve'>;

/** A solved sketch, as its dependents read it. Plain data; cached per sketch key. */
export interface SketchResult {
  placement: SketchPlacement;
  /** Entities with solved coordinates. */
  entities: SketchEntity[];
  /** Filled regions (even nesting depth), sorted by id. */
  regions: Region[];
  /** Regions inside holes; selectable by listing their entities. */
  voids: Region[];
  diagnostics: RegionDiagnostic[];
}

/** An explicit plane as a normalised placement. */
export function explicitPlacement(plane: Extract<SketchPlane, { type: 'plane' }>): SketchPlacement {
  return placementFromNormal(plane.origin, plane.normal, plane.xDir);
}

export type SolveOutcome =
  | { ok: true; sketch: SketchResult; warnings: RegenWarning[] }
  | { ok: false; errors: RegenError[] };

/** Turn a solver result into regions, or into feature errors. */
export function sketchOutcome(
  feature: SketchFeature,
  placement: SketchPlacement,
  result: SolveResult,
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
  const warnings: RegenWarning[] = [];
  if (result.diagnosis.redundant.length > 0) {
    warnings.push({
      code: 'redundant',
      message: `Redundant constraints (ignored): ${result.diagnosis.redundant.join(', ')}`,
      constraints: [...result.diagnosis.redundant],
    });
  }
  const found = detectRegions(result.entities);
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
    },
    warnings,
  };
}

/** Solve a stored sketch with the document's variables. */
export async function solveSketch(
  solver: RegenSolver,
  feature: SketchFeature,
  placement: SketchPlacement,
  variables: VariableValues,
): Promise<SolveOutcome> {
  const result = await solver.solve(
    { entities: feature.entities, constraints: feature.constraints },
    variables.record,
  );
  return sketchOutcome(feature, placement, result);
}

/**
 * The regions a profile uses. Without `entities`, every filled region. With `entities`, every
 * region or void whose outer loop runs only along listed entities: a rectangle's four lines pick
 * the rectangle (with any holes in it), and listing a hole's circle as well picks the disk inside
 * it too.
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
  const picks = [...sketch.regions, ...sketch.voids].filter((r) =>
    r.outer.curves.every((c) => listed.has(c.entityId)),
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
