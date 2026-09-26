// Kernel outcomes to regen errors and warnings (kernel README: the table mapping kernel codes
// onto ADR 0007's first-cut `FeatureError` union).

import { featureReferences, type Feature } from '@manufakture/core';
import type {
  FeatureError,
  FeatureOutcome,
  FeatureWarning,
  KernelFailure,
  ReferenceReport,
} from '@manufakture/kernel';
import { referenceIdOf } from './translate';
import type { LastResolved, ReferenceResolution, RegenError, RegenWarning } from './types';

function lastResolvedOf(feature: Feature, referenceId: string): LastResolved | undefined {
  const r = featureReferences(feature).find((x) => x.id === referenceId);
  return r?.lastResolved
    ? { point: r.lastResolved.point, direction: r.lastResolved.direction }
    : undefined;
}

export function mapKernelError(feature: Feature, e: FeatureError): RegenError {
  const referenceId = e.ref === undefined ? undefined : referenceIdOf(feature, e.ref);
  switch (e.code) {
    case 'lost':
    case 'ambiguous': {
      const id = referenceId ?? '';
      const hint = lastResolvedOf(feature, id);
      const base = {
        referenceId: id,
        message: `${e.message}: re-pick it`,
        ...(e.target === undefined ? {} : { target: e.target }),
        ...(hint === undefined ? {} : { lastResolved: hint }),
      };
      return e.code === 'lost'
        ? { code: 'reference-lost', missing: e.missing ?? [], ...base }
        : { code: 'reference-ambiguous', candidates: e.candidates ?? [], ...base };
    }
    case 'unnamed':
      return { code: 'unnamed-face', message: e.message };
    case 'kernel':
      return e.occtMessage === undefined
        ? { code: 'kernel', message: e.message }
        : { code: 'kernel', message: e.message, occtMessage: e.occtMessage };
    default:
      return referenceId === undefined
        ? { code: e.code, message: e.message }
        : { code: e.code, message: e.message, referenceId };
  }
}

export function mapKernelWarning(feature: Feature, w: FeatureWarning): RegenWarning {
  switch (w.code) {
    case 'reference':
      return {
        code: 'reference',
        message: w.message,
        referenceId: referenceIdOf(feature, w.ref),
        target: w.target,
        via: w.via,
        fragile: w.fragile,
      };
    case 'missed':
      return { code: 'missed', message: w.message, instances: [...w.instances] };
    case 'direction':
      return {
        code: 'direction',
        message: w.message,
        referenceId: referenceIdOf(feature, w.ref),
        target: w.target,
      };
  }
}

/** What a regen keeps of a `FeatureOutcome`: never its name table, which stays in the worker. */
export function mapOutcome(
  feature: Feature,
  outcome: FeatureOutcome,
): { errors: RegenError[]; warnings: RegenWarning[]; references: ReferenceResolution[] } {
  return {
    errors: outcome.errors.map((e) => mapKernelError(feature, e)),
    warnings: outcome.warnings.map((w) => mapKernelWarning(feature, w)),
    references: outcome.resolved.map((r) => ({
      referenceId: referenceIdOf(feature, r.ref),
      target: r.target,
      via: r.via,
      fragile: r.fragile,
    })),
  };
}

/** A whole op that failed (not a feature that failed inside it): a trap, a stale shape. */
export function mapFailure(failure: KernelFailure): RegenError {
  const message =
    failure.code === 'fatal'
      ? `The kernel instance was lost (${failure.message}); it is being restarted`
      : failure.message;
  const out: RegenError = { code: 'kernel', message };
  if (failure.occtMessage !== undefined) out.occtMessage = failure.occtMessage;
  if (failure.occtType !== undefined) out.occtType = failure.occtType;
  return out;
}

/** How a face-sketch plane resolved: a frame, or the error for the sketch. */
export function planeReport(
  feature: Feature,
  referenceId: string,
  target: string,
  report: ReferenceReport,
):
  | {
      ok: true;
      origin: readonly [number, number, number];
      normal: readonly [number, number, number];
      warnings: RegenWarning[];
      reference: ReferenceResolution;
    }
  | { ok: false; error: RegenError } {
  if (!report.ok) {
    const hint = lastResolvedOf(feature, referenceId);
    const extra = hint === undefined ? {} : { lastResolved: hint };
    if (report.status === 'lost') {
      return {
        ok: false,
        error: {
          code: 'reference-lost',
          referenceId,
          target,
          missing: [...report.missing],
          message: `The sketch plane ${target} is lost: re-pick it`,
          ...extra,
        },
      };
    }
    if (report.status === 'ambiguous') {
      return {
        ok: false,
        error: {
          code: 'reference-ambiguous',
          referenceId,
          target,
          candidates: [...report.candidates],
          message: `The sketch plane ${target} is ambiguous: re-pick it`,
          ...extra,
        },
      };
    }
    return { ok: false, error: { code: 'no-body', referenceId, message: report.message } };
  }
  const g = report.geometry;
  if (g === null || g.kind !== 'plane') {
    return {
      ok: false,
      error: { code: 'invalid', referenceId, message: `The sketch face ${target} is not planar` },
    };
  }
  const reference: ReferenceResolution = {
    referenceId,
    target,
    via: report.via,
    fragile: report.fragile,
  };
  const warnings: RegenWarning[] =
    report.via === 'exact' && !report.fragile
      ? []
      : [
          {
            code: 'reference',
            referenceId,
            target,
            via: report.via,
            fragile: report.fragile,
            message: `The sketch plane ${target} resolved ${report.fragile ? 'by position' : `by ${report.via}`}: check it`,
          },
        ];
  return { ok: true, origin: g.origin, normal: g.direction, warnings, reference };
}
