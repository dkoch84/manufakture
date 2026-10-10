// Building a review bundle (ADR 0016 decision 11; M8 plan T8.3a). `buildBundle` makes it from a
// base and a head document, the branch's log and an engine of its own; `bundleBuilder` is the
// session's `BundleBuilder` hook around it, reading the log and the merge preview from the
// library and storing the images as blobs of the document.

import { createHash } from 'node:crypto';
import type { ManufaktureDocument } from '@manufakture/core';
import { MAIN_BRANCH, type MergePlan } from '@manufakture/library';
import type { BundleBuilder, Engine, ErrorLine } from '@manufakture/session';
import { branchLog, commandDiff, type LoggedBatch } from './commands';
import type { AssemblySceneResult } from './assembly';
import { Names } from './describe';
import { assemblyDiffs, documentChanges, partDiffs, scriptDiffs } from './diff';
import { DEFAULT_SUMMARISERS, domainDiffs, summariserMap, type DomainSummariser } from './domains';
import { quantityDeltas } from './quantities';
import {
  DEFAULT_IMAGE_SIZE,
  renderPairs,
  reviewViews,
  type ImageSize,
  type ReviewView,
} from './renders';
import { bounded, round, shown } from './text';
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  LIMITS,
  type AssemblyInterference,
  type AssemblyPoseInfo,
  type AssemblyViewInfo,
  type BodyDelta,
  type BundleKey,
  type ImageRef,
  type MergePreview,
  type RegenIssue,
  type RegenIssues,
  type ReviewBundle,
  type ViewPair,
} from './types';
import { Workbench, type MeasuredBody, type SideReport, type WorkbenchLimits } from './workbench';

export interface BuildInput {
  key: BundleKey;
  base: ManufaktureDocument;
  head: ManufaktureDocument;
  /** The branch's log since its base, oldest first. */
  log: readonly LoggedBatch[];
  /** An engine for the bundle alone: base and head are regenerated on it. The caller closes it. */
  engine: Engine;
  limits?: WorkbenchLimits;
  /** The merge preview against Main's current head, or null when there is none. */
  merge?: MergePreview | null;
  /** Views besides the fixed four (at most four). */
  views?: readonly ReviewView[];
  imageSize?: ImageSize;
  summarisers?: readonly DomainSummariser[];
}

export interface BuiltBundle {
  bundle: ReviewBundle;
  /** The PNGs the bundle names, by SHA-256. */
  images: Map<string, Uint8Array>;
}

export const DEFAULT_WORKBENCH_LIMITS: WorkbenchLimits = { regenMs: 60_000, kernelMs: 30_000 };

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

// Regen issues ----------------------------------------------------------------------------------

function issue(e: ErrorLine): RegenIssue {
  return {
    where: e.where,
    severity: e.severity,
    code: shown(e.code, 64),
    message: shown(e.message),
    ...(e.partId !== undefined ? { partId: shown(e.partId, 120) } : {}),
    ...(e.featureId !== undefined ? { featureId: shown(e.featureId, 120) } : {}),
    ...(e.assemblyId !== undefined ? { assemblyId: shown(e.assemblyId, 120) } : {}),
    ...(e.id !== undefined ? { id: shown(e.id, 120) } : {}),
  };
}

/** Errors and warnings at base and head: new ones first (errors before warnings), by identity. */
export function regenIssues(base: readonly ErrorLine[], head: readonly ErrorLine[]): RegenIssues {
  // Compared by where, what and code, never by message text alone (ADR 0016 decision 4: names
  // and codes, not incidental bytes).
  const id = (e: ErrorLine) =>
    JSON.stringify([
      e.where,
      e.partId,
      e.featureId,
      e.assemblyId,
      e.id,
      e.severity,
      e.code,
      e.message,
    ]);
  const was = new Set(base.map(id));
  const now = new Set(head.map(id));
  const errorsFirst = (list: ErrorLine[]) => [
    ...list.filter((e) => e.severity === 'error'),
    ...list.filter((e) => e.severity === 'warning'),
  ];
  const count = (list: readonly ErrorLine[]) => ({
    errors: list.filter((e) => e.severity === 'error').length,
    warnings: list.filter((e) => e.severity === 'warning').length,
  });
  return {
    new: bounded(errorsFirst(head.filter((e) => !was.has(id(e)))).map(issue), LIMITS.errors),
    remaining: bounded(errorsFirst(head.filter((e) => was.has(id(e)))).map(issue), LIMITS.errors),
    resolved: bounded(errorsFirst(base.filter((e) => !now.has(id(e)))).map(issue), LIMITS.errors),
    counts: { base: count(base), head: count(head) },
  };
}

// Measurements ----------------------------------------------------------------------------------

const ORDER: Record<BodyDelta['change'], number> = {
  added: 0,
  changed: 1,
  deleted: 2,
  unchanged: 3,
};

export function bodyDeltas(
  base: readonly MeasuredBody[],
  head: readonly MeasuredBody[],
): BodyDelta[] {
  const k = (b: MeasuredBody) => `${b.partId}/${b.bodyId}`;
  const was = new Map(base.map((b) => [k(b), b]));
  const now = new Map(head.map((b) => [k(b), b]));
  const out: BodyDelta[] = [];
  for (const key of [...now.keys(), ...[...was.keys()].filter((x) => !now.has(x))]) {
    const a = was.get(key);
    const b = now.get(key);
    const x = (b ?? a)!;
    const ma = a?.measurement ?? null;
    const mb = b?.measurement ?? null;
    const change: BodyDelta['change'] =
      a === undefined
        ? 'added'
        : b === undefined
          ? 'deleted'
          : JSON.stringify(ma) === JSON.stringify(mb)
            ? 'unchanged'
            : 'changed';
    const error = b?.error ?? a?.error;
    out.push({
      partId: shown(x.partId, 120),
      bodyId: shown(x.bodyId, 120),
      name: shown(x.name),
      change,
      base: ma,
      head: mb,
      delta:
        ma !== null && mb !== null
          ? {
              volume: round(mb.volume - ma.volume),
              area: round(mb.area - ma.area),
              mass: ma.mass !== null && mb.mass !== null ? round(mb.mass - ma.mass) : null,
            }
          : null,
      ...(error !== undefined ? { error: shown(error) } : {}),
    });
  }
  return out
    .map((d, i) => ({ d, i }))
    .sort((p, q) => ORDER[p.d.change] - ORDER[q.d.change] || p.i - q.i)
    .map((p) => p.d);
}

function interference(base: SideReport, head: SideReport): AssemblyInterference[] {
  const names = new Names([head.document, base.document]);
  const ids = [...new Set([...head.interference.keys(), ...base.interference.keys()])];
  return ids.map((assemblyId) => {
    const a = base.interference.get(assemblyId);
    const b = head.interference.get(assemblyId);
    const error =
      (b && 'error' in b ? b.error : undefined) ?? (a && 'error' in a ? a.error : undefined);
    return {
      assemblyId: shown(assemblyId, 120),
      name: names.assembly(assemblyId),
      base: a && 'pairs' in a ? a.pairs : null,
      head: b && 'pairs' in b ? b.pairs : null,
      ...(error !== undefined ? { error: shown(error) } : {}),
    };
  });
}

// Merge preview ---------------------------------------------------------------------------------

/** The library's merge plan as the bundle shows it. */
export function mergePreview(plan: MergePlan): MergePreview {
  return {
    ok: true,
    applied: bounded(
      plan.applied.map((s) => shown(s.label)),
      LIMITS.merge,
    ),
    dropped: bounded(
      plan.dropped.map((d) => ({ label: shown(d.label), message: shown(d.message) })),
      LIMITS.merge,
    ),
    renamed: bounded(
      plan.renamed.map((r) => ({ from: shown(r.from, 120), to: shown(r.to, 120) })),
      LIMITS.merge,
    ),
    replaced: bounded(
      plan.replaced.map((r) => shown(r)),
      LIMITS.merge,
    ),
    changed: plan.changed,
  };
}

export function mergeError(message: string): MergePreview {
  const none = { items: [], omitted: 0 };
  return {
    ok: false,
    error: shown(message),
    applied: none,
    dropped: none,
    renamed: none,
    replaced: none,
    changed: false,
  };
}

// Assembly views --------------------------------------------------------------------------------

function poseInfo(r: AssemblySceneResult | undefined): AssemblyPoseInfo | null {
  if (r === undefined || !r.ok) return null;
  const { mates, warnings, skipped } = r.posed;
  return {
    mates: bounded(
      mates.map((m) => ({
        mateId: shown(m.mateId, 120),
        kind: shown(m.kind, 32),
        coordinates: m.coordinates.map((c) => ({
          name: shown(c.name, 32),
          value: round(c.value),
          unit: c.unit,
        })),
      })),
      LIMITS.items,
    ),
    warnings: bounded(
      warnings.map((w) => shown(w.message)),
      LIMITS.errors,
    ),
    skipped: bounded(
      skipped.map((id) => shown(id, 120)),
      LIMITS.items,
    ),
  };
}

function viewInfo(
  view: ReviewView,
  index: number,
  base: SideReport,
  head: SideReport,
): AssemblyViewInfo | undefined {
  const at = view.assembly;
  if (at === undefined) return undefined;
  return {
    assemblyId: shown(at.assemblyId, 120),
    mates: Object.fromEntries(
      Object.entries(at.mates ?? {}).map(([id, v]) => [shown(id, 120), round(v)]),
    ),
    poses: Object.fromEntries(
      Object.entries(at.poses ?? {}).map(([id, p]) => [
        shown(id, 120),
        { translation: p.translation.map(round), rotation: p.rotation.map(round) },
      ]),
    ),
    base: poseInfo(base.assemblyScenes[index]),
    head: poseInfo(head.assemblyScenes[index]),
  };
}

/** One side's scene for a view: the assembly's at its pose for an assembly view. */
function sideScene(side: SideReport) {
  return (view: ReviewView, index: number): SideReport['scene'] => {
    if (view.assembly === undefined) return side.scene;
    const r = side.assemblyScenes[index];
    if (r === undefined) return { ok: false, message: 'The assembly was not posed.' };
    return r.ok ? { ok: true, value: r.scene } : { ok: false, message: r.message };
  };
}

// The bundle ------------------------------------------------------------------------------------

/** The bundle for `head` against `base`, and the images it names. */
export async function buildBundle(input: BuildInput): Promise<BuiltBundle> {
  const summarisers = summariserMap(input.summarisers ?? DEFAULT_SUMMARISERS);
  const views = reviewViews(input.views);
  const workbench = new Workbench(input.engine, input.limits ?? DEFAULT_WORKBENCH_LIMITS);
  // The base first: what the branch did not change is then cached for the head.
  const assemblies = views.map((v) => v.assembly);
  const base = await workbench.side(input.base, assemblies);
  const head = await workbench.side(input.head, assemblies);

  const images = new Map<string, Uint8Array>();
  const ref = (img: { png: Uint8Array; width: number; height: number }): ImageRef => {
    const sha = sha256(img.png);
    images.set(sha, img.png);
    return { sha256: sha, bytes: img.png.length, width: img.width, height: img.height };
  };
  const renders: ViewPair[] = renderPairs(
    sideScene(base),
    sideScene(head),
    views,
    input.imageSize ?? DEFAULT_IMAGE_SIZE,
  ).map((pair, i) => {
    const assembly = viewInfo(views[i]!, i, base, head);
    return {
      name: pair.name,
      camera: pair.camera,
      base: pair.base && 'png' in pair.base ? ref(pair.base) : null,
      head: pair.head && 'png' in pair.head ? ref(pair.head) : null,
      ...(pair.base && 'error' in pair.base ? { baseError: pair.base.error } : {}),
      ...(pair.head && 'error' in pair.head ? { headError: pair.head.error } : {}),
      ...(assembly !== undefined ? { assembly } : {}),
    };
  });

  const names = new Names([input.head, input.base]);
  const bodies = bodyDeltas(base.bodies, head.bodies);
  const bundle: ReviewBundle = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    key: { ...input.key },
    documentName: shown(input.head.name),
    commands: commandDiff(input.base, input.head, input.log, summarisers),
    features: {
      parts: partDiffs(input.base, input.head),
      assemblies: assemblyDiffs(input.base, input.head),
    },
    document: documentChanges(input.base, input.head),
    domains: domainDiffs(input.base, input.head, summarisers),
    scripts: scriptDiffs(input.base, input.head),
    renders,
    regen: regenIssues(base.errors, head.errors),
    measurements: {
      bodies: {
        items: bodies.slice(0, LIMITS.bodies),
        omitted:
          Math.max(0, bodies.length - LIMITS.bodies) +
          Math.max(base.bodiesOmitted, head.bodiesOmitted),
      },
      interference: interference(base, head),
    },
    quantities: quantityDeltas(
      base.quantities,
      head.quantities,
      (id) => names.part(id),
      head.phases,
    ),
    merge: input.merge ?? null,
  };
  return { bundle, images };
}

// The session's hook ----------------------------------------------------------------------------

export interface BundleBuilderOptions {
  /** Views besides the fixed four, as the agent asked at submit (at most four). */
  views?: readonly ReviewView[];
  imageSize?: ImageSize;
  /**
   * Domain summarisers in place of the defaults. The app's Review view replays the log with
   * `DEFAULT_SUMMARISERS` and blocks Approve when the bundle's command list differs, so a bundle
   * built with other summarisers whose lines differ cannot be approved.
   */
  summarisers?: readonly DomainSummariser[];
  /** The branch the merge preview is against (default Main). */
  mergeInto?: string;
}

/**
 * The session's `BundleBuilder`: the bundle for the branch head, with its images stored as blobs
 * of the document. Its engine is started from the context and closed when it is done.
 */
export function bundleBuilder(options: BundleBuilderOptions = {}): BundleBuilder {
  // Checked now, so a bad view is refused before any regen.
  reviewViews(options.views);
  return async (base, head, context) => {
    const log = await branchLog(context.library, context.documentId, head.branch);
    const plan = await context.library.previewMerge(
      context.documentId,
      head.branch,
      options.mergeInto ?? MAIN_BRANCH,
    );
    const merge = plan.ok ? mergePreview(plan.value) : mergeError(plan.message);
    const engine = await context.engine();
    let built: BuiltBundle;
    try {
      built = await buildBundle({
        key: {
          documentId: context.documentId,
          branch: head.branch,
          baseVersion: base.versionId,
          headRevision: head.revision,
        },
        base: base.document,
        head: head.document,
        log,
        engine,
        limits: {
          regenMs: context.limits.regenMsPerBatch,
          kernelMs: context.limits.kernelMsPerCall,
        },
        merge,
        ...(options.views ? { views: options.views } : {}),
        ...(options.imageSize ? { imageSize: options.imageSize } : {}),
        ...(options.summarisers ? { summarisers: options.summarisers } : {}),
      });
    } finally {
      await engine.close();
    }
    for (const [sha, png] of built.images) {
      const stored = await context.putBlob(png);
      if (stored !== sha) throw new Error('An image was not stored under its SHA-256.');
    }
    return built.bundle;
  };
}
