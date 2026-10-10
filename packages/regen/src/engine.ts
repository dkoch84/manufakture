// The regeneration engine: a core document in, geometry out, rebuilding only what changed.
//
// It runs next to the kernel (ADR 0007 decision 1: the regen engine lives in the kernel worker)
// and drives it through the kernel service's batch API: one `feature` op per kernel feature,
// with `applyFeature` semantics, on the bodies the feature reads. A part carries a set of bodies
// (M2 plan, decisions 1 to 3): every feature reads only some of them (its scope, the bodies its
// references lie on, or all of them), and its result is cached under a key that covers its input
// and the keys of those bodies (see `cache.ts`), so an edit to one body is a cache hit for the
// features of the others. A regen walks the whole part but only sends ops for keys it has never
// built.
//
// Batches: the next feature's key depends on what the previous one did to the body set (which
// bodies it made, changed or merged away), so every `feature` op is flushed before the next
// feature is looked at. A sketch placed on a face needs the face's plane, so it adds a `resolve`
// op and flushes too. In the worker a batch costs no structured clone, so flushing is cheap.
//
// Derived parts: a derived feature's pinned source part is regenerated first, in this same
// kernel and by this same engine, with the source document's own variables and under a cache
// namespace of its own (`derived.ts`), then its bodies are copied in by a kernel `derive` op.
// Every derived feature of one pinned part in a regen shares that one build.
//
// Assemblies: after the parts, each assembly's instances are given the bodies of their part (or
// of a pinned part, built like a derived feature's source), their mate connectors are found on
// those bodies by `connector` ops (cached by body key and reference), and the mate solver of
// `packages/assembly` places them (`assembly.ts`). Drags reuse the last regen's solver input and
// never touch the kernel.
//
// Member sets: after a part's features, each registered domain's member stage frames the part's
// built extensions of its namespace into members (ADR 0015 decision 5, `members.ts`): plain data,
// cached per group and meshed once per distinct shape in this worker, never kernel objects, so a
// kernel recycle keeps them. Member B-reps are built only on request (`memberBodies`).
//
// Cancellation: every regen has a generation. A newer regen cancels the kernel batches of the
// older one (`KernelService.cancel`) and the older one stops at its next await, returning null.
// Regens run one at a time, so they never race on the cache.

import {
  drag as dragAssembly,
  solve,
  type AssemblyInput,
  type DragTarget,
  type MateInput,
} from '@manufakture/assembly';
import {
  bodyCreator,
  configurationRow,
  configured,
  featureIdsInName,
  type Assembly,
  type BodyPropsFields,
  type ConfigRow,
  type CoreResult,
  type DerivedFeature,
  type ScriptedFeature,
  type DerivedSource,
  type DocumentChange,
  type DocumentFont,
  type ExplodeStep,
  type ExtensionFeature,
  type Feature,
  type ImportSource,
  type ManufaktureDocument,
  type Measurement,
  type Part,
  type Pose,
  type Vec3,
  type DomainViewSource,
  StoredExpressionSchema,
  isDomainViewSource,
} from '@manufakture/core';
import {
  frameOnPlane,
  measuredDistance,
  yieldToEventLoop,
  type BatchReply,
  type BatchRequest,
  type ConnectorOp,
  type ConnectorReport,
  type Deflection,
  type FeatureInput,
  type FeatureOutcome,
  type HoleWall,
  type BodyMeasure,
  type MeasureResult,
  type InterferenceOp,
  type InterferenceResult,
  type KernelOp,
  type MeshData,
  type OpResult,
  type OpValues,
  type OrientedBox,
  type ReferenceReport,
  type SessionFunction,
  type SessionReply,
  type SessionRequest,
  type ShapeId,
  type TessellateOp,
  type Topology,
  type TopoRef,
} from '@manufakture/kernel';
import { OutlineBudget, type SketchPlacement } from '@manufakture/sketch';
import { bundledFont } from '@manufakture/text/bundled';
import {
  DEFAULT_KERNEL_BUILD,
  DEFAULT_SOLVER_BUILD,
  MemoryCache,
  REGEN_IMPLEMENTATION_VERSION,
  cacheKey,
  holdsShapes,
  type CacheEntry,
  type CachedOutcome,
  type FeatureCache,
  type KeyVersions,
} from './cache';
import {
  applyReport,
  connectorError,
  connectorOrigin,
  connectorPose,
  connectorResolution,
  dragResult,
  emptyAssemblyResult,
  emptyInstanceResult,
  emptyMateResult,
  framePose,
  instanceSourceKey,
  mateInput,
  mateValues,
  pickReport,
  solverInput,
  type MateValues,
} from './assembly';
import { DerivedSources, carriedProps, describeSource, effectiveProps, tooDeep } from './derived';
import {
  MAX_REQUEST_DOMAIN_ITEMS,
  checkDomainView,
  domainViewCost,
  type DomainViewContext,
  type DomainViewOutput,
  type DomainViewSet,
} from './domain-views';
import {
  DrawingStage,
  IDENTITY_POSE,
  findView,
  type DrawingBody,
  type DrawingDiagnostic,
  type DrawingHost,
  type DrawingRequestOptions,
  type DrawingSheetResult,
  type DrawingStats,
  type DrawingViewResult,
} from './drawing';
import { mapFailure, mapOutcome, planeReport } from './errors';
import {
  checkEvaluationOutput,
  checkEvaluationQueries,
  type EvaluatedPart,
  type EvaluationAnswer,
  type EvaluationContext,
} from './evaluation';
import {
  CamStage,
  type CamGeometryOptions,
  type CamGeometryResult,
  type CamHost,
  type CamStats,
} from './cam';
import {
  OrientedCache,
  type OrientedSizesOptions,
  type OrientedSizesResult,
  type OrientedStats,
} from './oriented';
import {
  directionInference,
  explodeWarnings,
  explodedOffsets,
  explodedPose,
  resolveExplodedView,
} from './explode';
import {
  checkOutput,
  checkQueries,
  defaultExtensions,
  evaluateExtension,
  extensionKey,
  extensionNamespace,
  guard,
  readDomainData,
  readParams,
  supported,
  type ExtensionContext,
  type ExtensionRegistry,
  type ExtensionUpstream,
  type GeometryAnswer,
  type GeometryQuery,
  type NamespaceRead,
  type RegisteredDomainDrawings,
  type RegisteredEvaluation,
  type ResolvedReference,
} from './extensions';
import {
  bodyUse,
  buildGraph,
  dirtyFeaturesOf,
  featuresReading,
  readsBody,
  variableReaders,
  routeBodies,
  type RoutedBody,
} from './graph';
import { hashValue, stableStringify } from './hash';
import { shownNamespaces } from './title-notes';
import { importSourceMatches, keyInput } from './imports';
import {
  MemberGroupCache,
  MemberMeshCache,
  checkGroups,
  checkMembers,
  memberFeatureInputs,
  memberFullId,
  memberGroupKey,
  memberInstances,
  memberShapeKey,
  type FramedGroup,
  type ManifoldLoader,
  type MemberData,
  type MemberFeature,
  type MemberMesh,
  type MemberMeshUpdate,
  type MemberSetResult,
} from './members';
import {
  explicitPlacement,
  sketchFontKey,
  sketchKeyDefinition,
  solveSketch,
  type RegenSolver,
  type SketchResult,
} from './sketches';
import { TextBudget, lazyTextOutliner, type TextOutliner } from './text';
import { faceRef, topoRef, translateFeature } from './translate';
import { SCRIPT_APIS, ScriptRun, type ScriptRunOutcome } from './script-api';
import {
  ScriptHost,
  DENY_ALL_SCRIPTS,
  checkScriptPolicy,
  scriptAllowed,
  scriptsNotRunError,
  type ScriptPolicy,
  apiVersionError,
  runawayError,
  scriptParamValues,
  scriptRegenError,
  scriptedKeyParts,
  sessionFatalError,
  type ScriptOptions,
  type ScriptRunEvent,
  type ScriptStats,
} from './scripted';
import {
  QUICKJS_BUILD,
  resolveParams,
  type ParamSpec,
  type ScriptInstance,
  type ScriptValue,
} from '@manufakture/script';
import type {
  AssemblyResult,
  BodyResult,
  ConsumedBody,
  DomainEvaluationResult,
  DragResult,
  FeatureResult,
  InstanceInterference,
  InstanceResult,
  InstanceSourceRef,
  InterferenceReport,
  MateResult,
  MemberBodiesResult,
  MemberBodyResult,
  PartResult,
  RegenCounters,
  RegenError,
  RegenResult,
  ReferenceResolution,
  VariableError,
  RegenWarning,
  SourceResult,
} from './types';
import { evaluateFeature, evaluateField, evaluateVariables, type VariableValues } from './values';
import {
  thinWallWarnings,
  wallMinimum,
  wallRange,
  type HoleFeature,
  type WallMinimum,
} from './wall-check';
import {
  callOwners,
  callPart,
  failedMeasurement,
  measuredCalls,
  stuckMessages,
  variableList,
  type MeasuredCall,
} from './measured';
import { profileOf } from './sketches';

/**
 * What the engine needs from the kernel: the batch API of `KernelService` (which satisfies it
 * as it is), so tests and the worker drive the real service in-process.
 */
export interface RegenKernel {
  run(request: BatchRequest): Promise<BatchReply>;
  /** Release shapes outside any batch; never cancelled (`KernelService.release`). */
  release(shapes: readonly ShapeId[]): Promise<unknown>;
  /** Cancel every batch up to `generation`. */
  cancel(generation?: number): unknown;
  /** Called after every instance recycle, when every shape id is gone. */
  onRecycle?(hook: () => void): () => void;
  /**
   * The newest generation the kernel has seen, and the generation every batch up to which it
   * cancels (`KernelService.cancel` raises it, even past any batch seen; another engine sharing
   * the service may have). A default generation is made newer than both, so an engine never
   * submits batches the kernel would treat as stale.
   */
  stats?(): { generation: number; cancelledThrough?: number };
  /**
   * A synchronous session on the kernel in its exclusive slot (`KernelService.session`), for
   * scripted features: a script's operations are function calls into the kernel, not batches.
   * Without it, scripted features fail with `unsupported`.
   */
  session?<T>(request: SessionRequest, fn: SessionFunction<T>): Promise<SessionReply<T>>;
}

export interface RegenEngineOptions {
  kernel: RegenKernel;
  solver: RegenSolver;
  /** Default: a `MemoryCache`. */
  cache?: FeatureCache;
  /** Kernel build identity for cache keys. */
  kernelBuild?: string;
  /** Sketch solver build identity for sketch cache keys. */
  solverBuild?: string;
  /** Tessellation of the final bodies. */
  deflection?: Partial<Deflection>;
  /**
   * Lays out the text of outline entities. Default: `createTextOutliner()` (loaded on the first
   * text), in this thread with no time limit and refusing user fonts, which suits Node and
   * bundled fonts only. A browser host must pass `createWatchdogOutliner` (the regen worker does,
   * `worker.ts`): untrusted fonts need a worker of their own under a time limit (ADR 0011's
   * amendment). A Node host that trusts its fonts can pass
   * `createTextOutliner({ allowFileFonts: true })`.
   */
  text?: TextOutliner;
  /**
   * The domains extension features are built with (ADR 0013 decision 5). Default:
   * `defaultExtensions`, which the app's regen worker entry fills at start-up.
   */
  extensions?: ExtensionRegistry;
  /**
   * The kernel recycled its instance, so every cached body is gone. The host should regen the
   * current document again (the next regen rebuilds; nothing is lost but time).
   */
  onKernelRecycled?: () => void;
  /**
   * Loads Manifold for meshing members with cuts, once, on the first such member. Default:
   * `loadManifold` (`manifold-3d`'s glue, which finds its `.wasm` next to itself).
   */
  manifold?: ManifoldLoader;
  /**
   * What the domain views of one drawing request may draw together: lines, arcs, string points
   * and marks and pitch symbols (`domainViewCost`). Default `MAX_REQUEST_DOMAIN_ITEMS`.
   */
  domainViewBudget?: number;
  /**
   * Running scripted features (ADR 0010; `scripted.ts`): how to load QuickJS, limits, and the
   * run monitor the main thread's watchdog listens to. Absent: scripted features fail with
   * `unsupported`.
   */
  scripts?: ScriptOptions;
}

export interface RegenOptions {
  /**
   * Increases with every edit (ADR 0007 decision 4). Default: one more than the newest seen,
   * here or by the kernel.
   * A regen whose generation is not newer than one already requested returns null at once.
   */
  generation?: number;
  /** The document before this edit and the store's change, to find the dirty subgraph faster. */
  previous?: ManufaktureDocument;
  change?: DocumentChange;
  /**
   * The document as stored, when `document` is it with its active configuration row applied
   * (the app regenerates `configured(stored)`). Instances of its parts in other rows are built
   * from `configured(stored, row)`, so a parameter their row leaves out keeps the stored value,
   * not the active row's. Absent: `document` is the stored document.
   */
  stored?: ManufaktureDocument;
}

export interface AssemblyOptions {
  /**
   * The generation the request belongs to: the client's current one (regen README,
   * "Cancellation"), so it never cancels a regen. Default: the newest seen. A request older than
   * the newest regen resolves to null.
   */
  generation?: number;
  /** As for `RegenOptions.stored`. */
  stored?: ManufaktureDocument;
}

export interface EngineStats extends RegenCounters {
  regens: number;
  superseded: number;
  retries: number;
}

/** What the member stage did over the engine's lifetime (`RegenEngine.memberStats`). */
export interface MemberStats {
  /** Groups the domain's `frame` ran for. */
  framed: number;
  /** Groups served from the member cache. */
  cacheHits: number;
  /** Member shape meshes made (boxes and cut members). */
  meshesMade: number;
  /** Shape meshes held now, and framed groups held now. */
  meshes: number;
  groups: number;
  /** Manifold objects made and deleted (equal after every mesh). */
  manifoldCreated: number;
  manifoldDeleted: number;
}

/** What `memberBodies` builds besides the bodies. */
export interface MemberBodiesOptions {
  /** As for `AssemblyOptions.generation`. */
  generation?: number;
  /** Measure each body's volume. */
  volumes?: boolean;
  /** Export every member built as one STEP file, each body named by its full member id. */
  step?: boolean;
  /**
   * Bodies the kernel already holds (a part's layer bodies, by the shapes a regen reported),
   * written into the STEP file first, under these names, next to the members. They are only read:
   * never released here.
   */
  with?: readonly { shape: ShapeId; name: string }[];
}

/** One group's members as a regen framed them (from the member cache or just now). */
interface FramedSet {
  entry: FramedGroup;
  members: readonly MemberData[];
  cached: boolean;
  ms: number;
}

class Superseded extends Error {
  constructor() {
    super('superseded by a newer regen');
  }
}

/**
 * A shape id the batch used was not live: the kernel recycled since it was made. The regen
 * starts over without the lost bodies. Thrown before anything from that batch is cached.
 */
class StaleShapes extends Error {
  constructor(readonly instance: number) {
    super('kernel shapes were lost to a recycle');
  }
}

/** A body of the part while a regen walks its features. */
interface LiveBody extends RoutedBody {
  id: string;
  /** The feature that made it. */
  creator: string;
  shape: ShapeId;
  /** The kernel instance `shape` lives in. */
  instance: number | null;
  /** Cache key of the body: the key of the feature that last changed it, and its id. */
  key: string;
  solids: number;
}

/**
 * A regen result's `measurements` and `variableErrors` (#1202): absent unless a variable
 * measures the model.
 */
function measuredResults(
  document: ManufaktureDocument,
  variables: VariableValues,
): Pick<RegenResult, 'measurements' | 'variableErrors'> {
  if (variables.measurements.length === 0) return {};
  const touched = variableReaders(
    document.variables,
    measuredCalls(document.variables).flatMap((c) => c.variables),
  );
  const errors: VariableError[] = [];
  for (const v of document.variables) {
    const e = variables.errors.get(v.name);
    if (e === undefined || !touched.has(v.name)) continue;
    const read = v.expression.source.slice(e.start, e.end).replace(/^#/, '');
    const message =
      e.code === 'unknown-variable' && variables.errors.has(read)
        ? `#${v.name} reads #${read}, which does not evaluate`
        : `#${v.name}: ${e.message}`;
    errors.push({ name: v.name, code: e.code, message });
  }
  return {
    measurements: variables.measurements.map((m) => ({ ...m, faces: [...m.faces] })),
    ...(errors.length === 0 ? {} : { variableErrors: errors }),
  };
}

/** Why a measurement found neither pair of faces: the kernel's word on the first face missing. */
function measureFailure(
  call: MeasuredCall,
  partId: string,
  replies: readonly { r: OpResult | null }[],
): string {
  for (const { r } of replies) {
    if (r === null) continue;
    if (!r.ok) return `${call.fn}() failed on ${partId}: ${r.error.message}`;
    const items = (r.value as MeasureResult).items;
    const i = items.findIndex((x) => !x.ok);
    const item = items[i];
    if (item !== undefined && !item.ok) {
      const face = call.faces[i as 0 | 1].face;
      return item.status === 'ambiguous'
        ? `Face "${face}" is ambiguous on ${partId}: ${item.message}`
        : `Face "${face}" is not found on ${partId}`;
    }
  }
  return `${call.fn}() could not measure on ${partId}`;
}

/** A `shapesFrom` for a batch reading shapes of two instances: one of them is stale. */
const MIXED_INSTANCES = -1;

type Meta =
  | { type: 'feature'; feature: Feature; key: string; result: FeatureResult; started: number }
  /** An op whose result a callback takes: `resolve`, and an extension's `obb` queries. */
  | { type: 'resolve'; take: (r: OpResult) => void }
  | { type: 'mesh'; slot: string }
  | { type: 'topology'; slot: string };

interface Batch {
  ops: KernelOp[];
  metas: Meta[];
  /**
   * The kernel instance the batch's concrete shape ids come from (a cached body, or a body an
   * earlier batch made), or null when it uses none. A reply from another instance means those
   * ids are gone.
   */
  shapesFrom: number | null;
}

interface Run {
  generation: number;
  /** Aborted when a newer regen supersedes this run: stops the text it is laying out. */
  abort: AbortController;
  /** The time this run's texts may take (`TextBudget`). */
  text: TextBudget;
  /** The work this run's SVG outlines may take together (`OutlineBudget`). */
  svg: OutlineBudget;
  counters: RegenCounters;
  used: Set<string>;
  /** Kernel instance of the latest reply. */
  instance: number | null;
  versions: KeyVersions;
  /** Source parts of derived features built in this regen, by `sourceNamespace`. */
  sources: Map<string, PartState>;
  /** The document as stored, which instances in other rows are configured from. */
  stored: ManufaktureDocument;
  /** Each document's variables as this run measured and evaluated them (`#variables`). */
  variables: Map<ManufaktureDocument, VariableValues>;
}

/** Where a part is built: the document being regenerated, or a derived part's source. */
interface BuildScope {
  /** Cache namespace: null for the document's own parts, `sourceNamespace` for a source. */
  ns: string | null;
  /** 0 for the document's own parts, 1 for a source of one of them, and so on. */
  depth: number;
  /** The key versions of the document the part is in (its own naming scheme). */
  versions: KeyVersions;
}

interface PartState extends BuildScope {
  part: Part;
  /** The fonts of the document the part is in, which its sketches' outlines use. */
  fonts: readonly DocumentFont[];
  /** The bodies after the features so far, in creator order. */
  bodies: LiveBody[];
  /** Bodies merged away so far. */
  consumed: ConsumedBody[];
  /** An op-level failure left no usable bodies; kernel features after it are not attempted. */
  broken: boolean;
  batch: Batch;
  results: Map<string, FeatureResult>;
  /** Features whose dependents cannot be built, and why. */
  unavailable: Map<string, 'error' | 'suppressed' | 'upstream-error'>;
  sketches: Map<string, SketchResult>;
  inputs: Map<string, FeatureInput>;
  /** Reference imports seen so far (not part of the body, never in the kernel). */
  references: Set<string>;
  /**
   * What bodies a derived feature makes carry over from their source (name, colour, material),
   * by the body id they would have (`derived#1:from/<source body id>`).
   */
  inherited: Map<string, BodyPropsFields>;
  /** What the extensions built so far translated to, by feature id, for later ones to read. */
  extensions: Map<string, ExtensionUpstream>;
}

const now = (): number => performance.now();

const emptyBatch = (): Batch => ({ ops: [], metas: [], shapesFrom: null });

/**
 * A feature op the kernel passed through because its concrete input body is not a live shape:
 * `applyFeature` reports that as a feature result (`no-body`, nothing created, no names), not
 * as a failed op. A live body always has names (every body the engine uses comes from a
 * feature op), and a `no-body` failure on a live body (an empty one) keeps them.
 */
function staleBody(op: KernelOp, r: OpResult): boolean {
  if (op.op !== 'feature' || !r.ok) return false;
  const outcome = r.value as FeatureOutcome;
  // A derive whose source shape is gone says so on `sources`; the engine only sends live ones.
  if (
    op.feature.kind === 'derive' &&
    outcome.errors.some((e) => e.code === 'no-body' && e.ref === 'sources')
  ) {
    return true;
  }
  if (!Array.isArray(op.bodies) || op.bodies.length === 0) return false;
  return (
    outcome.bodies.some((b) => b.names === null) && outcome.errors.some((e) => e.code === 'no-body')
  );
}

/** The key `#reported` and the mesh batch use for a body of a part. */
const slotOf = (partId: string, bodyId: string): string => `${partId}\n${bodyId}`;

/** The key `#reported` and the mesh batch use for a body of a pinned source an instance shows. */
const sourceSlot = (key: string, bodyId: string): string => `source\n${key}\n${bodyId}`;

/** What a `SourceResult` says about where its bodies come from. */
type SourceInfo = Omit<SourceResult, 'key' | 'bodies'>;

/**
 * What `#assemble` found: results, drag states, the parts shown that are not the document's own
 * builds (pinned parts, and parts of this document in another configuration row), the frames used.
 */
interface Assembled {
  results: AssemblyResult[];
  states: Map<string, DragState>;
  sources: Map<string, { info: SourceInfo; state: PartState }>;
  connectorKeys: Set<string>;
}

/**
 * What a drag or an interference check of an assembly starts from: the last regen's solver input,
 * stored poses and the bodies each instance shows.
 */
interface DragState {
  generation: number;
  input: AssemblyInput;
  /** Where the regen left the instances: what `endDrag` puts `input` back to. */
  solved: AssemblyInput['instances'];
  stored: ReadonlyMap<string, Pose>;
  /**
   * The bodies each instance shows (unsuppressed instances with bodies only), live as long as the
   * regen's cache entries are: an interference check runs on the regen chain, so no later regen
   * can evict them while it runs.
   */
  bodies: ReadonlyMap<string, readonly LiveBody[]>;
}

export interface InterferenceCheckOptions extends AssemblyOptions {
  /** Tessellate each overlap (default false). */
  mesh?: boolean;
  /** Overlaps of at most this volume (mm3) are not reported; default the kernel's 1e-3. */
  tolerance?: number;
  /**
   * Called with each overlapping pair as soon as it is found (the report's then has no mesh). A
   * promise it returns is awaited before the next pair, so pairs reach a caller in another thread
   * before the report does.
   */
  onPair?: (pair: InstanceInterference) => unknown;
}

interface PendingDrag {
  assemblyId: string;
  instanceId: string;
  target: DragTarget;
  generation: number;
  resolve: (result: DragResult | null) => void;
  reject: (error: unknown) => void;
}

/**
 * The warning for features of a pinned source that failed: what uses it is what the source
 * built without them (`consequence` names the user: "the derived bodies are").
 */
function sourceFailures(built: PartState, where: string, consequence: string): RegenWarning[] {
  const failed = built.part.features
    .filter((x) => {
      const s = built.results.get(x.id)?.status;
      return s === 'error' || s === 'upstream-error';
    })
    .map((x) => x.id);
  if (failed.length === 0) return [];
  const notRun = failed.filter((id) =>
    built.results
      .get(id)
      ?.errors.some((e) => e.code === 'script' && e.scriptCode === 'not-allowed'),
  );
  const warning: RegenWarning = {
    code: 'derived-source',
    features: failed,
    message: `${failed.length === 1 ? 'A feature' : `${failed.length} features`} of ${where} failed (${failed.join(', ')}): ${consequence} it built without ${failed.length === 1 ? 'it' : 'them'}${notRun.length > 0 ? ` (scripts not run: ${notRun.join(', ')})` : ''}`,
  };
  if (notRun.length > 0) warning.scriptsNotRun = notRun;
  return [warning];
}

function emptyCounters(): RegenCounters {
  return { featureOps: 0, otherOps: 0, batches: 0, solves: 0, cacheHits: 0, cacheMisses: 0 };
}

/** The lower-case hex SHA-256 of a text's UTF-8 (Web Crypto: the browser worker and Node). */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A deep copy of plain data, frozen all the way down: what domain code is given to read. */
function frozenCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const stack: unknown[] = [copy];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v !== 'object' || v === null || Object.isFrozen(v)) continue;
    if (ArrayBuffer.isView(v)) continue;
    Object.freeze(v);
    for (const x of Object.values(v)) stack.push(x);
  }
  return copy;
}

/** The error of an extension reference that did not resolve (ADR 0004 decision 6). */
function lostReference(
  reference: ExtensionFeature['references'][number],
  target: string,
  report: Extract<ReferenceReport, { ok: false }>,
): RegenError {
  const hint = reference.lastResolved;
  const extra =
    hint === undefined ? {} : { lastResolved: { point: hint.point, direction: hint.direction } };
  if (report.status === 'lost') {
    return {
      code: 'reference-lost',
      referenceId: reference.id,
      target,
      missing: [...report.missing],
      message: `${target} is lost: re-pick it`,
      ...extra,
    };
  }
  if (report.status === 'ambiguous') {
    return {
      code: 'reference-ambiguous',
      referenceId: reference.id,
      target,
      candidates: [...report.candidates],
      message: `${target} is ambiguous: re-pick it`,
      ...extra,
    };
  }
  return { code: 'no-body', referenceId: reference.id, message: report.message };
}

export class RegenEngine {
  readonly #kernel: RegenKernel;
  readonly #solver: RegenSolver;
  readonly #cache: FeatureCache;
  readonly #kernelBuild: string;
  readonly #solverBuild: string;
  readonly #text: TextOutliner;
  readonly #deflection: Partial<Deflection> | undefined;
  readonly #onRecycled: (() => void) | undefined;
  readonly #extensions: ExtensionRegistry;
  /**
   * Import sources whose stored SHA-256 was checked against their data, and the outcome. Keyed by
   * the source object: documents share unchanged objects between edits, so each file is hashed
   * once, not on every regen.
   */
  readonly #checkedSources = new WeakMap<ImportSource, boolean>();
  /** Pinned sources of derived features: checked, read and measured for depth once each. */
  readonly #derived = new DerivedSources();
  /**
   * Stored documents in a configuration row other than their active one, for instances that show
   * a part in that row: by the stored document object (an edit makes a new one) and row id.
   */
  readonly #rowDocuments = new WeakMap<
    ManufaktureDocument,
    Map<string, CoreResult<ManufaktureDocument>>
  >();
  #latest = 0;
  /** The run in progress (or the last one), whose text a newer regen aborts. */
  #running: Run | null = null;
  #chain: Promise<unknown> = Promise.resolve();
  #instance: number | null = null;
  #lastDocument: ManufaktureDocument | null = null;
  /** Body key per part and body (`slotOf`) as last reported, to send meshes only when a body changed. */
  #reported = new Map<string, string>();
  /**
   * Hole walls measured by the last regen (#1210, `wall-check.ts`), by body key, holes and range:
   * a body that did not change is not measured again.
   */
  #walls = new Map<string, HoleWall[]>();
  /** What the evaluation stages had measured in the last regen, by body key (`#evaluate`). */
  #bodyMeasures = new Map<string, BodyMeasure | null>();
  readonly #stats: EngineStats = { ...emptyCounters(), regens: 0, superseded: 0, retries: 0 };
  readonly #unsubscribe: (() => void) | undefined;
  /**
   * Connector frames by body key and reference (`#connectorKey`): plain data, valid for as long
   * as the body key is, whatever the kernel instance. Kept for the frames the last regen used.
   */
  #connectors = new Map<string, ConnectorReport>();
  /** Per assembly id, what drags start from: set by every completed regen. */
  #assemblyStates = new Map<string, DragState>();
  /** The newest drag not started yet; a newer one replaces it (latest target wins). */
  #pendingDrag: PendingDrag | null = null;
  #dragging = false;
  /** Interference checks asked to stop (`cancelInterference`), by assembly id. */
  #stopChecks = new Set<string>();
  /** What the domain views of one drawing request may draw together. */
  readonly #domainBudget: number;
  /** Drawing views, resolved dimension references and picking data, cached by body key. */
  readonly #drawings = new DrawingStage();
  /** Oriented box sizes of bodies, by body key (`orientedSizes`). */
  readonly #oriented = new OrientedCache();
  /** The CAM geometry stage's caches (`camGeometry`). */
  readonly #cam = new CamStage();
  /** Framed member groups by key (plain data: a kernel recycle keeps them). */
  readonly #memberGroups = new MemberGroupCache();
  /** One mesh per distinct member shape, for every part and group (T6.5a recommendation 3). */
  readonly #memberMeshes: MemberMeshCache;
  /** Set key per part and group as last reported, to send a set only when it changed. */
  #reportedSets = new Map<string, string>();
  /** Member shape keys the main thread has the mesh of. */
  #reportedMeshes = new Set<string>();
  /** The members of the last completed regen, per part, by full id (`memberBodies`). */
  #lastMembers = new Map<string, Map<string, MemberData>>();
  #memberCounts = { framed: 0, cacheHits: 0 };
  readonly #scripts: ScriptHost | null;
  /** Which scripts may run (the app's opt-in); null: all of them. */
  #scriptPolicy: ScriptPolicy | null = null;

  constructor(options: RegenEngineOptions) {
    this.#scripts = options.scripts === undefined ? null : new ScriptHost(options.scripts);
    this.#kernel = options.kernel;
    this.#solver = options.solver;
    this.#cache = options.cache ?? new MemoryCache();
    this.#kernelBuild = options.kernelBuild ?? DEFAULT_KERNEL_BUILD;
    this.#solverBuild = options.solverBuild ?? DEFAULT_SOLVER_BUILD;
    this.#text = options.text ?? lazyTextOutliner();
    this.#deflection = options.deflection;
    this.#onRecycled = options.onKernelRecycled;
    this.#extensions = options.extensions ?? defaultExtensions;
    this.#domainBudget = options.domainViewBudget ?? MAX_REQUEST_DOMAIN_ITEMS;
    this.#memberMeshes = new MemberMeshCache(options.manifold);
    this.#unsubscribe = options.kernel.onRecycle?.(() => {
      // Runs inside the service's queue: only forget, never submit from here.
      void this.#cache.dropBodies(null);
      this.#instance = null;
      this.#onRecycled?.();
    });
  }

  /** Cumulative counters over every regen. */
  get stats(): Readonly<EngineStats> {
    return { ...this.#stats };
  }

  /** Member stage counters over every regen, and what its caches hold now. */
  get memberStats(): Readonly<MemberStats> {
    const m = this.#memberMeshes;
    return {
      ...this.#memberCounts,
      meshesMade: m.made,
      meshes: m.size,
      groups: this.#memberGroups.size,
      manifoldCreated: m.manifoldObjects.created,
      manifoldDeleted: m.manifoldObjects.deleted,
    };
  }

  /** What scripted features cost so far: declaration runs, runs, instances. Null without scripts. */
  get scriptStats(): Readonly<ScriptStats> | null {
    return this.#scripts === null ? null : { ...this.#scripts.stats };
  }

  /** Who hears of every script run's start and end (the worker's watchdog channel). */
  setScriptMonitor(monitor: ((event: ScriptRunEvent) => void) | null): void {
    this.#scripts?.setMonitor(monitor);
  }

  /**
   * Cache keys of script runs the main thread's watchdog stopped (it restarted the worker): such
   * a feature fails with `timeout` without running again, until its key changes.
   */
  addRunawayScripts(keys: readonly string[]): void {
    this.#scripts?.addRunaway(keys);
  }

  /**
   * Which documents' scripts may run (`ScriptPolicy`); null lets every script run (an engine a
   * trusted host drives, as in Node; the regen worker never passes null). Applies from the next
   * scripted feature built. Something that is not a policy denies every script, then throws.
   */
  setScriptPolicy(policy: ScriptPolicy | null): void {
    if (policy === null) {
      this.#scriptPolicy = null;
      return;
    }
    const checked = checkScriptPolicy(policy);
    if (checked === null) {
      this.#scriptPolicy = DENY_ALL_SCRIPTS;
      throw new TypeError('not a script policy');
    }
    this.#scriptPolicy = checked;
  }

  /**
   * A script's parameter declarations, for the feature dialog: its top-level code run in the
   * document's instance (no `ctx`), under the run limits and the watchdog like any run. Only
   * when the policy lets script `script.id` of `documentId` run, with this source; otherwise it
   * fails with `scriptsNotRunError` and nothing runs.
   */
  async scriptDeclarations(
    script: { id: string; source: string; language: 'js' | 'ts'; apiVersion: number },
    documentId: string,
  ): Promise<{ ok: true; params: ParamSpec[] } | { ok: false; error: RegenError }> {
    const scripts = this.#scripts;
    const scriptId = script.id;
    if (!(await scriptAllowed(this.#scriptPolicy, documentId, true, script))) {
      return { ok: false, error: scriptsNotRunError(scriptId) };
    }
    if (scripts === null) {
      return {
        ok: false,
        error: { code: 'unsupported', message: 'This build of the app cannot run scripts' },
      };
    }
    const versionError = apiVersionError(scriptId, script.apiVersion);
    if (versionError !== null) return { ok: false, error: versionError };
    const key = `declarations:${hashValue({
      source: script.source,
      language: script.language,
      apiVersion: script.apiVersion,
      quickjs: QUICKJS_BUILD,
    })}`;
    if (scripts.isRunaway(key)) return { ok: false, error: runawayError(scriptId) };
    let instance: ScriptInstance;
    try {
      instance = await scripts.instance('');
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'script',
          scriptCode: 'internal',
          scriptId,
          message: 'The script engine could not be loaded',
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }
    scripts.event('start', 'declarations', key);
    scripts.stats.declarations++;
    try {
      const declared = await instance.readDeclarations({
        source: script.source,
        language: script.language,
        apiVersion: script.apiVersion,
        limits: scripts.limits,
      });
      return declared.ok
        ? { ok: true, params: declared.value.params }
        : { ok: false, error: scriptRegenError(scriptId, declared.error) };
    } finally {
      scripts.event('end', 'declarations', key);
    }
  }

  /** The newest generation requested. */
  get generation(): number {
    return this.#latest;
  }

  /** The document of the last completed regen. */
  get document(): ManufaktureDocument | null {
    return this.#lastDocument;
  }

  /**
   * Regenerate `document`. Resolves to the result, or to null when a newer regen superseded it
   * (drop it: the newer one reports). Rejects only on programming errors.
   */
  regen(document: ManufaktureDocument, options: RegenOptions = {}): Promise<RegenResult | null> {
    const generation = options.generation ?? this.#newestSeen() + 1;
    if (!Number.isSafeInteger(generation)) {
      return Promise.reject(new TypeError('a regen generation must be an integer'));
    }
    if (generation <= this.#latest) return Promise.resolve(null);
    const older = this.#latest;
    this.#latest = generation;
    // Abandon the running regen's batches at the kernel's next op, and its text at once.
    if (older > 0) this.#kernel.cancel(older);
    if (this.#running && this.#running.generation < generation) this.#running.abort.abort();
    const task = this.#chain.then(() => this.#regen(document, generation, options));
    this.#chain = task.catch(() => undefined);
    return task;
  }

  /** Regenerate after a store change (`store.subscribe((e) => engine.update(e))`). */
  update(event: {
    document: ManufaktureDocument;
    previous: ManufaktureDocument;
    change: DocumentChange;
  }): Promise<RegenResult | null> {
    return this.regen(event.document, { previous: event.previous, change: event.change });
  }

  /** Release every cached body and forget everything. */
  async dispose(): Promise<void> {
    this.#unsubscribe?.();
    await this.#chain;
    const dropped = await this.#cache.clear();
    await this.#releaseEntries(dropped);
    this.#reported.clear();
    this.#walls.clear();
    this.#memberGroups.clear();
    this.#memberMeshes.clear();
    this.#reportedSets.clear();
    this.#reportedMeshes.clear();
    this.#lastMembers.clear();
    this.#lastDocument = null;
    await this.#scripts?.dispose();
  }

  // Internals ------------------------------------------------------------------------------

  async #regen(
    document: ManufaktureDocument,
    generation: number,
    options: RegenOptions,
  ): Promise<RegenResult | null> {
    if (generation < this.#latest) {
      this.#stats.superseded++;
      return null;
    }
    const t0 = now();
    const run = this.#newRun(generation, document, options.stored);
    const result = await this.#attempt(run, () => this.#regenOnce(run, document, options));
    if (result === null) return null;
    result.ms = now() - t0;
    this.#stats.regens++;
    return result;
  }

  #newRun(
    generation: number,
    document: ManufaktureDocument,
    stored: ManufaktureDocument = document,
  ): Run {
    // Runs go one at a time on the chain: the newest is the one running.
    this.#running = {
      generation,
      abort: new AbortController(),
      text: new TextBudget(),
      svg: new OutlineBudget(),
      stored,
      counters: emptyCounters(),
      used: new Set(),
      instance: this.#instance,
      versions: {
        kernelBuild: this.#kernelBuild,
        namingScheme: document.namingScheme,
        implementation: REGEN_IMPLEMENTATION_VERSION,
      },
      sources: new Map(),
      variables: new Map(),
    };
    return this.#running;
  }

  /**
   * Run `body`, starting over (at most twice) when kernel shapes it used were lost to a recycle.
   * Null when a newer regen superseded it.
   */
  async #attempt<T>(run: Run, body: () => Promise<T>): Promise<T | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await body();
      } catch (error) {
        if (error instanceof Superseded) {
          this.#stats.superseded++;
          this.#addStats(run.counters);
          return null;
        }
        if (error instanceof StaleShapes && attempt < 2) {
          this.#stats.retries++;
          await this.#cache.dropBodies(error.instance);
          this.#instance = error.instance;
          run.instance = error.instance;
          run.used.clear();
          run.sources.clear();
          run.variables.clear();
          continue;
        }
        throw error;
      }
    }
  }

  #addStats(c: RegenCounters): void {
    for (const k of Object.keys(c) as (keyof RegenCounters)[]) this.#stats[k] += c[k];
  }

  #checkStale(run: Run): void {
    if (run.generation < this.#latest) throw new Superseded();
  }

  async #regenOnce(
    run: Run,
    document: ManufaktureDocument,
    options: RegenOptions,
  ): Promise<RegenResult> {
    const variables = await this.#variables(run, document);
    this.#derived.begin();
    const reuseChange =
      options.change !== undefined &&
      options.previous !== undefined &&
      options.previous === this.#lastDocument;

    const built: { state: PartState; features: FeatureResult[]; dirty: string[] }[] = [];
    for (const part of document.parts) {
      const partChange = reuseChange
        ? options.change!.parts.find((p) => p.partId === part.id)
        : undefined;
      const dirty = dirtyFeaturesOf(this.#lastDocument, document, part.id, {
        ...(reuseChange
          ? {
              firstAffectedIndex: partChange ? partChange.firstAffectedIndex : null,
              domainChanged: options.change!.domainChanged,
            }
          : {}),
        domainReads: (type) => this.#extensions.readsOf(type),
      });
      const state = await this.#buildPart(run, part, document, variables, {
        ns: null,
        depth: 0,
        versions: run.versions,
      });
      const features = part.features.map(
        (f, i) =>
          state.results.get(f.id) ?? {
            featureId: f.id,
            kind: f.kind,
            index: i,
            status: 'rolled-back' as const,
            errors: [],
            warnings: [],
            references: [],
            cached: false,
            ms: 0,
          },
      );
      built.push({ state, features, dirty });
    }

    // Member sets, after each part's features: plain data, no kernel ops.
    const framed = new Map<string, FramedSet[]>();
    for (const { state } of built) {
      const sets = await this.#frameMembers(run, state, document);
      if (sets.length > 0) framed.set(state.part.id, sets);
    }

    // Assemblies, after the parts they show.
    const partStates = new Map(built.map(({ state }) => [state.part.id, state]));
    const assembled = await this.#assemble(run, document, variables, async (id) =>
      partStates.get(id),
    );

    // Every body must come from the kernel instance of the latest reply: a part built only from
    // cache hits can hold a shape id from before a recycle that landed during another part's
    // batch. Its tessellation would fail, or worse, a later pick or measure would.
    this.#checkInstances(run, [
      ...built.map((b) => b.state),
      ...[...assembled.sources.values()].map((x) => x.state),
    ]);

    // Meshes (and topologies, for edge adjacency, vertices and face planes) of the bodies that
    // changed since the last completed regen, in one batch, so they share one name table.
    const meshes = new Map<string, MeshData>();
    const topologies = new Map<string, Topology>();
    const batch = emptyBatch();
    const finalBodies = (state: PartState) => (state.broken ? [] : state.bodies);
    // The wall checks around holes ride along (#1210): their warnings join the features after it.
    const finishWalls = this.#wallChecks(document, variables, built, batch);
    // So do the domains' evaluation stages' measurements (ADR 0017 decision 15).
    const finishEvaluations = this.#evaluate(document, variables, built, assembled.results, batch);
    for (const { state } of built) {
      for (const b of finalBodies(state)) {
        const slot = slotOf(state.part.id, b.id);
        if (this.#reported.get(slot) === b.key) continue;
        const op: TessellateOp = { op: 'tessellate', shape: b.shape };
        if (this.#deflection !== undefined) op.deflection = this.#deflection;
        batch.ops.push(op, { op: 'topology', shape: b.shape });
        batch.metas.push({ type: 'mesh', slot }, { type: 'topology', slot });
        this.#usesBodies(batch, [b]);
      }
    }
    for (const [key, { state }] of assembled.sources) {
      for (const b of finalBodies(state)) {
        const slot = sourceSlot(key, b.id);
        if (this.#reported.get(slot) === b.key) continue;
        const op: TessellateOp = { op: 'tessellate', shape: b.shape };
        if (this.#deflection !== undefined) op.deflection = this.#deflection;
        batch.ops.push(op, { op: 'topology', shape: b.shape });
        batch.metas.push({ type: 'mesh', slot }, { type: 'topology', slot });
        this.#usesBodies(batch, [b]);
      }
    }
    let names: string[] = [];
    if (batch.ops.length > 0) {
      const reply = await this.#submit(run, batch.ops);
      run.counters.otherOps += batch.ops.length;
      this.#checkLive(batch, reply);
      names = reply.names;
      batch.metas.forEach((meta, j) => {
        const r = reply.results[j]!;
        // The wall checks' `holeWalls` ops: an unknown shape among them was already turned into
        // `StaleShapes` by `#checkLive` above, like the meshes' (their bodies are in `shapesFrom`).
        if (meta.type === 'resolve') {
          meta.take(r);
          return;
        }
        if (meta.type !== 'mesh' && meta.type !== 'topology') return;
        if (!r.ok) {
          if (r.error.code === 'unknown-shape') throw new StaleShapes(reply.instance);
          throw new Error(
            `${meta.type} of ${meta.slot.replaceAll('\n', ' body ')} failed: ${r.error.message}`,
          );
        }
        if (meta.type === 'mesh') meshes.set(meta.slot, r.value as MeshData);
        else topologies.set(meta.slot, r.value as Topology);
      });
    }
    this.#checkStale(run);
    finishWalls();
    const evaluations = finishEvaluations();

    // Completed: this is now the state the next edit is compared with.
    const reported = new Map<string, string>();
    const bodyResults = (state: PartState, slotFor: (bodyId: string) => string) =>
      finalBodies(state).map((b): BodyResult => {
        const slot = slotFor(b.id);
        reported.set(slot, b.key);
        const inherited = carriedProps(state.part, b.id, state.inherited.get(b.id));
        return {
          ...(inherited === undefined ? {} : { inherited }),
          bodyId: b.id,
          creator: b.creator,
          shape: b.shape,
          bodyKey: b.key,
          solids: b.solids,
          meshChanged: this.#reported.get(slot) !== b.key,
          mesh: meshes.get(slot) ?? null,
          topology: topologies.get(slot) ?? null,
        };
      });
    const members = this.#memberResults(framed);
    const parts: PartResult[] = built.map(({ state, features, dirty }) => {
      const sets = members.sets.get(state.part.id);
      return {
        partId: state.part.id,
        features,
        dirty,
        bodies: bodyResults(state, (id) => slotOf(state.part.id, id)),
        consumed: state.consumed,
        ...(sets === undefined ? {} : { members: sets }),
      };
    });
    const sources: SourceResult[] = [...assembled.sources].map(([key, { info, state }]) => ({
      key,
      ...info,
      bodies: bodyResults(state, (id) => sourceSlot(key, id)),
    }));
    this.#reported = reported;
    this.#lastDocument = document;
    this.#assemblyStates = assembled.states;
    for (const key of this.#connectors.keys()) {
      if (!assembled.connectorKeys.has(key)) this.#connectors.delete(key);
    }
    this.#derived.retain();
    const dropped = await this.#cache.retain(run.used);
    await this.#releaseEntries(dropped);
    this.#addStats(run.counters);
    return {
      generation: run.generation,
      names,
      parts,
      assemblies: assembled.results,
      sources,
      ...(members.meshes === null ? {} : { memberMeshes: members.meshes }),
      ...measuredResults(document, variables),
      ...(evaluations.length === 0 ? {} : { evaluations }),
      counters: run.counters,
      ms: 0,
    };
  }

  /**
   * The domains' evaluation stages (ADR 0017 decision 15, `evaluation.ts`): each domain's first
   * step runs now and its measurements join `batch` (a body measured in the last regen, by key, is
   * not measured again); the returned function, called once the batch ran, runs each second step
   * and gives the results. A throw, a malformed result or domain data that does not read is an
   * error on that domain's result, never a failed regen.
   */
  #evaluate(
    document: ManufaktureDocument,
    variables: VariableValues,
    built: readonly { state: PartState }[],
    assemblies: readonly AssemblyResult[],
    batch: Batch,
  ): () => DomainEvaluationResult[] {
    const stages = this.#extensions.evaluations();
    if (stages.length === 0) {
      this.#bodyMeasures.clear();
      return () => [];
    }
    const parts: EvaluatedPart[] = built.map(({ state }) => ({
      partId: state.part.id,
      built: !state.broken,
      bodies: state.broken ? [] : state.bodies.map((b) => b.id),
    }));
    const live = new Map<string, LiveBody>();
    for (const { state } of built) {
      if (state.broken) continue;
      for (const b of state.bodies) live.set(slotOf(state.part.id, b.id), b);
    }
    interface Pending {
      stage: RegisteredEvaluation;
      context?: EvaluationContext;
      answers: EvaluationAnswer[];
      error?: RegenError;
      ms: number;
    }
    const pending: Pending[] = [];
    const kept = new Map<string, BodyMeasure | null>();
    const toMeasure = new Map<string, { body: LiveBody; answers: EvaluationAnswer[] }>();
    const domainReads = new Map<string, NamespaceRead>();
    for (const stage of stages) {
      const t0 = now();
      const read = readDomainData(this.#extensions, stage, document.domains, domainReads);
      if (!read.ok) {
        pending.push({ stage, answers: [], error: read.error, ms: now() - t0 });
        continue;
      }
      const context: EvaluationContext = {
        document,
        data: read.data,
        variables: variables.values,
        parts,
        assemblies,
      };
      const evaluation = stage.evaluation;
      let answers: EvaluationAnswer[] = [];
      if (evaluation.measure !== undefined) {
        const asked = guard(stage.namespace, 'evaluation measure step', () =>
          evaluation.measure!(context),
        );
        const queries = asked.ok ? checkEvaluationQueries(stage.namespace, asked.value) : asked;
        if (!queries.ok) {
          pending.push({ stage, answers: [], error: queries.error, ms: now() - t0 });
          continue;
        }
        answers = queries.value.map((q) => {
          const answer: EvaluationAnswer = {
            type: 'body',
            part: q.part,
            body: q.body,
            measure: null,
          };
          const body = live.get(slotOf(q.part, q.body));
          if (body === undefined) {
            answer.message = `${q.part} has no body ${q.body} in this regen`;
            return answer;
          }
          if (this.#bodyMeasures.has(body.key)) {
            answer.measure = this.#bodyMeasures.get(body.key)!;
            kept.set(body.key, answer.measure);
            return answer;
          }
          let entry = toMeasure.get(body.key);
          if (entry === undefined) {
            entry = { body, answers: [] };
            toMeasure.set(body.key, entry);
          }
          entry.answers.push(answer);
          return answer;
        });
      }
      pending.push({ stage, context, answers, ms: now() - t0 });
    }
    for (const [key, entry] of toMeasure) {
      batch.ops.push({ op: 'measure', shape: entry.body.shape, targets: [], body: true });
      batch.metas.push({
        type: 'resolve',
        take: (r) => {
          const measure = r.ok ? (r.value as MeasureResult).body : null;
          if (r.ok) kept.set(key, measure);
          for (const a of entry.answers) {
            a.measure = measure;
            if (!r.ok) a.message = r.error.message;
          }
        },
      });
      this.#usesBodies(batch, [entry.body]);
    }
    return () => {
      this.#bodyMeasures = kept;
      const out: DomainEvaluationResult[] = [];
      for (const p of pending) {
        const namespace = p.stage.namespace;
        if (p.context === undefined) {
          out.push({ namespace, warnings: [], ...(p.error ? { error: p.error } : {}), ms: p.ms });
          continue;
        }
        const t0 = now();
        const context = p.context;
        const given = guard(namespace, 'evaluation', () =>
          p.stage.evaluation.evaluate(context, p.answers),
        );
        const checked = given.ok ? checkEvaluationOutput(namespace, given.value) : given;
        const ms = p.ms + now() - t0;
        if (!checked.ok) {
          out.push({ namespace, warnings: [], error: checked.error, ms });
          continue;
        }
        const { data, warnings } = checked.value;
        if (data === undefined && warnings.length === 0) continue;
        out.push({ namespace, ...(data === undefined ? {} : { data }), warnings, ms });
      }
      return out;
    };
  }

  /**
   * The wall checks around the holes of the document's parts (#1210, `wall-check.ts`): per final
   * body, the holes that built and have a minimum there, measured by one `holeWalls` op added to
   * `batch`, unless that body (by key) was measured for the same holes before. The returned
   * function, called once the batch ran, adds the `thin-wall` warnings to `built`'s feature
   * results and keeps the measurements for the next regen. An op that fails adds no warning.
   */
  #wallChecks(
    document: ManufaktureDocument,
    variables: VariableValues,
    built: readonly { state: PartState; features: FeatureResult[] }[],
    batch: Batch,
  ): () => void {
    interface Check {
      features: FeatureResult[];
      body: LiveBody;
      minimums: Map<string, { hole: HoleFeature; minimum: WallMinimum }>;
      key: string;
      walls: HoleWall[] | null;
    }
    const checks: Check[] = [];
    for (const { state, features } of built) {
      if (state.broken) continue;
      const holes = state.part.features.filter(
        (f): f is HoleFeature => f.kind === 'hole' && state.results.get(f.id)?.status === 'ok',
      );
      if (holes.length === 0) continue;
      for (const body of state.bodies) {
        const minimums: Check['minimums'] = new Map();
        for (const hole of holes) {
          if (!body.carries.has(hole.id)) continue;
          const minimum = wallMinimum(document, state.part, hole, body.id, variables);
          if (minimum !== null) minimums.set(hole.id, { hole, minimum });
        }
        if (minimums.size === 0) continue;
        const holeIds = [...minimums.keys()];
        const range = wallRange([...minimums.values()].map((m) => m.minimum));
        const key = `${body.key}\n${holeIds.join(' ')}\n${range}`;
        const check: Check = { features, body, minimums, key, walls: this.#walls.get(key) ?? null };
        checks.push(check);
        if (check.walls !== null) continue;
        batch.ops.push({ op: 'holeWalls', shape: body.shape, holes: holeIds, range });
        batch.metas.push({
          type: 'resolve',
          take: (r) => {
            if (r.ok) check.walls = (r.value as OpValues['holeWalls']).walls;
          },
        });
        this.#usesBodies(batch, [body]);
      }
    }
    return () => {
      const kept = new Map<string, HoleWall[]>();
      for (const c of checks) {
        if (c.walls === null) continue;
        kept.set(c.key, c.walls);
        for (const { hole, minimum } of c.minimums.values()) {
          const warnings = thinWallWarnings(hole, c.body.id, c.walls, minimum);
          if (warnings.length === 0) continue;
          const i = c.features.findIndex((f) => f.featureId === hole.id);
          const r = c.features[i];
          if (r !== undefined) c.features[i] = { ...r, warnings: [...r.warnings, ...warnings] };
        }
      }
      this.#walls = kept;
    };
  }

  /**
   * The member stage of a part (ADR 0015 decision 5): for each domain with a member stage, its
   * built extensions with their metadata are grouped by the domain, each group framed (or served
   * from the member cache by its key) and its new shapes meshed. A throw, a malformed result or a
   * shape that cannot be meshed is an error on the group's features; layout warnings go on the
   * features they name. Only the document's own parts are framed.
   */
  async #frameMembers(
    run: Run,
    state: PartState,
    document: ManufaktureDocument,
  ): Promise<FramedSet[]> {
    const stages = this.#extensions.memberStages();
    if (stages.length === 0) return [];
    const partId = state.part.id;
    const sets: FramedSet[] = [];
    const domainReads = new Map<string, NamespaceRead>();
    const fail = (ids: readonly string[], error: RegenError) => {
      for (const id of ids) {
        const r = state.results.get(id);
        if (r === undefined) continue;
        r.status = 'error';
        r.cached = false;
        r.errors = [...r.errors, error];
      }
    };
    for (const st of stages) {
      const features: MemberFeature[] = [];
      for (const f of state.part.features) {
        if (f.kind !== 'extension' || extensionNamespace(f.extension) !== st.namespace) continue;
        if (state.results.get(f.id)?.status !== 'ok') continue;
        const metadata = state.extensions.get(f.id)?.metadata;
        features.push({
          id: f.id,
          type: f.extension,
          schemaVersion: f.schemaVersion,
          dependsOn: [...f.dependsOn],
          ...(metadata === undefined ? {} : { metadata }),
        });
      }
      if (features.length === 0) continue;
      const ids = features.map((f) => f.id);
      const data = readDomainData(this.#extensions, st, document.domains, domainReads);
      if (!data.ok) {
        fail(ids, data.error);
        continue;
      }
      let given: { features: MemberFeature[]; data: Record<string, unknown> };
      try {
        given = frozenCopy({ features, data: data.data });
      } catch (error) {
        fail(ids, {
          code: 'extension',
          message: `The "${st.namespace}" member stage got data that is not plain: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      const byId = new Map(given.features.map((f) => [f.id, f]));
      const asked = guard(st.namespace, 'member grouping', () =>
        st.stage.groups({ partId, features: given.features, data: given.data }),
      );
      const groups = asked.ok ? checkGroups(st.namespace, asked.value, new Set(ids)) : asked;
      if (!groups.ok) {
        fail(ids, groups.error);
        continue;
      }
      for (const group of groups.groups) {
        const t0 = now();
        const groupFeatures = group.features.map((id) => byId.get(id)!);
        const key = memberGroupKey({
          partId,
          namespace: st.namespace,
          implementation: st.implementation,
          regen: REGEN_IMPLEMENTATION_VERSION,
          group,
          features: groupFeatures,
          data: given.data,
        });
        let entry = this.#memberGroups.get(key);
        const cached = entry !== undefined;
        if (entry === undefined) {
          const out = guard(st.namespace, `member stage (group ${group.id})`, () =>
            st.stage.frame(
              frozenCopy({ partId, group, features: groupFeatures, data: given.data }),
            ),
          );
          entry = {
            key,
            namespace: st.namespace,
            group,
            result: out.ok
              ? checkMembers(st.namespace, group, out.value)
              : { ok: false, error: out.error },
          };
          this.#memberGroups.set(entry);
          this.#memberCounts.framed++;
        } else {
          this.#memberCounts.cacheHits++;
        }
        const result = entry.result;
        if (!result.ok) {
          fail(group.features, result.error);
          continue;
        }
        for (const w of result.warnings) {
          const r = state.results.get(w.feature);
          if (r === undefined) continue;
          r.warnings = [
            ...r.warnings,
            {
              code: 'members',
              message: w.message,
              group: group.id,
              ...(w.code === undefined ? {} : { domainCode: w.code }),
              ...(w.member === undefined ? {} : { member: w.member }),
            },
          ];
        }
        const failed = await this.#memberMeshes.ensure(result.members);
        this.#checkStale(run);
        if (failed.size > 0) {
          const bad = result.members.filter((m) => failed.has(memberShapeKey(m)));
          const first = bad[0]!;
          fail(group.features, {
            code: 'extension',
            message: `${bad.length === 1 ? 'Member' : `${bad.length} members, the first`} ${memberFullId(first)} could not be meshed: ${failed.get(memberShapeKey(first))}`,
          });
          continue;
        }
        sets.push({ entry, members: result.members, cached, ms: now() - t0 });
      }
    }
    return sets;
  }

  /**
   * The member sets of a completed regen as reported (a set's members and instance lists only
   * when it changed), the shape meshes the main thread lacks and those it can drop. Becomes the
   * state the next regen is compared with; the member caches keep only what this regen used.
   */
  #memberResults(framed: ReadonlyMap<string, readonly FramedSet[]>): {
    sets: Map<string, MemberSetResult[]>;
    meshes: MemberMeshUpdate | null;
  } {
    const sets = new Map<string, MemberSetResult[]>();
    const reported = new Map<string, string>();
    const usedMeshes = new Set<string>();
    const usedGroups = new Set<string>();
    const lastMembers = new Map<string, Map<string, MemberData>>();
    for (const [partId, list] of framed) {
      const byId = new Map<string, MemberData>();
      lastMembers.set(partId, byId);
      sets.set(
        partId,
        list.map(({ entry, members, cached, ms }): MemberSetResult => {
          usedGroups.add(entry.key);
          for (const m of members) {
            usedMeshes.add(memberShapeKey(m));
            byId.set(memberFullId(m), m);
          }
          const slot = slotOf(partId, `members\n${entry.namespace}\n${entry.group.id}`);
          const changed = this.#reportedSets.get(slot) !== entry.key;
          reported.set(slot, entry.key);
          const metadata = entry.result.ok ? entry.result.metadata : undefined;
          return {
            group: entry.group.id,
            namespace: entry.namespace,
            features: [...entry.group.features],
            setKey: entry.key,
            cached,
            changed,
            members: changed ? [...members] : null,
            instances: changed ? memberInstances(members) : null,
            ...(changed && metadata !== undefined ? { metadata } : {}),
            count: members.length,
            ms,
          };
        }),
      );
    }
    const added: MemberMesh[] = [];
    for (const key of usedMeshes) {
      if (this.#reportedMeshes.has(key)) continue;
      const mesh = this.#memberMeshes.get(key)!;
      // Copies: the cache keeps its own, and these are transferred to the main thread.
      added.push({
        key,
        positions: mesh.positions.slice(),
        normals: mesh.normals.slice(),
        indices: mesh.indices.slice(),
      });
    }
    const removed = [...this.#reportedMeshes].filter((key) => !usedMeshes.has(key));
    this.#memberMeshes.retain(usedMeshes);
    this.#memberGroups.retain(usedGroups);
    this.#reportedSets = reported;
    this.#reportedMeshes = usedMeshes;
    this.#lastMembers = lastMembers;
    return {
      sets,
      meshes: added.length === 0 && removed.length === 0 ? null : { added, removed },
    };
  }

  async #releaseEntries(entries: readonly CacheEntry[]): Promise<void> {
    const shapes: ShapeId[] = [];
    for (const e of entries) {
      if (holdsShapes(e) && e.outcome!.instance === this.#instance) {
        for (const b of e.outcome!.bodies) shapes.push(b.shape);
      }
    }
    if (shapes.length > 0) await this.#kernel.release(shapes);
  }

  async #submit(run: Run, ops: KernelOp[]): Promise<BatchReply> {
    this.#checkStale(run);
    const reply = await this.#kernel.run({ generation: run.generation, ops });
    run.counters.batches++;
    if (reply.status === 'cancelled') throw new Superseded();
    if (this.#instance !== reply.instance) {
      // A recycle happened since the cached bodies were made.
      if (this.#instance !== null) await this.#cache.dropBodies(reply.instance);
      this.#instance = reply.instance;
    }
    run.instance = reply.instance;
    return reply;
  }

  /**
   * The variables of `document` as this run evaluates them, measured variables included (#1202;
   * `measured.ts` says what is measured and when). Once per run and document: the parts a
   * measurement needs are built without the features reading still unknown measured variables,
   * which the full build that follows serves from the cache.
   */
  async #variables(
    run: Run,
    document: ManufaktureDocument,
    scope: BuildScope = { ns: null, depth: 0, versions: run.versions },
  ): Promise<VariableValues> {
    const known = run.variables.get(document);
    if (known !== undefined) return known;
    const calls = measuredCalls(document.variables);
    if (calls.length === 0) {
      const values = evaluateVariables(document.variables);
      run.variables.set(document, values);
      return values;
    }
    const done = new Map<string, Measurement>();
    const parts = new Map<string, Part>();
    for (const c of calls) {
      const p = callPart(document, c);
      if (p.ok) parts.set(c.key, p.part);
      else done.set(c.key, failedMeasurement(c, null, p.message));
    }
    for (;;) {
      const waiting = calls.filter((c) => !done.has(c.key));
      if (waiting.length === 0) break;
      // Unknown until measured: the variables making a waiting call, and those reading them.
      const unknown = variableReaders(
        document.variables,
        waiting.flatMap((c) => c.variables),
      );
      let progress = false;
      for (const part of document.parts) {
        const here = waiting.filter((c) => parts.get(c.key) === part);
        if (here.length === 0) continue;
        const graph = buildGraph(part, document.variables);
        const skip = featuresReading(graph, unknown);
        const ready: MeasuredCall[] = [];
        for (const c of here) {
          const blocked = callOwners(c).filter((id) => skip.has(id));
          if (blocked.length === 0) {
            ready.push(c);
            continue;
          }
          // Made by a feature that depends on the very variables making the call: a cycle.
          const own = featuresReading(graph, variableReaders(document.variables, c.variables));
          const cyclic = blocked.find((id) => own.has(id));
          if (cyclic === undefined) continue; // waits for another measured variable
          const face = c.faces.find((f) => featureIdsInName(f.face).includes(cyclic))!.face;
          const who = variableList(c.variables);
          done.set(
            c.key,
            failedMeasurement(
              c,
              part.id,
              `${who} measures face "${face}", which ${cyclic} makes, and ${cyclic} depends on ${who}: a variable cannot measure faces it shapes`,
            ),
          );
          progress = true;
        }
        if (ready.length === 0) continue;
        const values = evaluateVariables(document.variables, [...done.values()]);
        const state = await this.#buildPart(run, part, document, values, scope, skip);
        for (const [key, m] of await this.#measureCalls(run, state, ready)) done.set(key, m);
        progress = true;
      }
      if (!progress) {
        // Every waiting call measures faces made by features reading another waiting variable:
        // some of them read one another, and the rest wait on those.
        const why = stuckMessages(document, waiting, parts);
        for (const c of waiting) {
          done.set(c.key, failedMeasurement(c, parts.get(c.key)?.id ?? null, why.get(c.key)!));
        }
        break;
      }
    }
    const measurements = calls.map((c) => done.get(c.key)!);
    const values = evaluateVariables(document.variables, measurements);
    run.variables.set(document, values);
    return values;
  }

  /**
   * Measure `calls` on the bodies of `state` (one kernel batch): each face on the body carrying
   * it (the two may be different bodies), `distance` the planes' distance of two parallel planar
   * faces, else the minimum distance (`measuredDistance`), `angle` the angle between them.
   */
  async #measureCalls(
    run: Run,
    state: PartState,
    calls: readonly MeasuredCall[],
  ): Promise<Map<string, Measurement>> {
    const out = new Map<string, Measurement>();
    const partId = state.part.id;
    const pending: {
      call: MeasuredCall;
      replies: { a: LiveBody; b: LiveBody; r: OpResult | null }[];
    }[] = [];
    for (const call of calls) {
      if (state.broken) {
        out.set(
          call.key,
          failedMeasurement(call, partId, `${partId} failed to build before the faces measured`),
        );
        continue;
      }
      const candidates = call.faces.map((f) => {
        const ids = featureIdsInName(f.face);
        return state.bodies.filter((b) => ids.every((id) => b.carries.has(id)));
      });
      const lost = call.faces.findIndex((_, i) => candidates[i]!.length === 0);
      if (lost >= 0) {
        out.set(call.key, failedMeasurement(call, partId, this.#lostFace(state, call, lost)));
        continue;
      }
      const replies: { a: LiveBody; b: LiveBody; r: OpResult | null }[] = [];
      for (const a of candidates[0]!.slice(0, 8)) {
        for (const b of candidates[1]!.slice(0, 8)) {
          const reply: { a: LiveBody; b: LiveBody; r: OpResult | null } = { a, b, r: null };
          replies.push(reply);
          state.batch.ops.push({
            op: 'measure',
            shape: a.shape,
            targets: [
              { kind: 'face', name: call.faces[0].face },
              b === a
                ? { kind: 'face', name: call.faces[1].face }
                : { kind: 'face', name: call.faces[1].face, shape: b.shape },
            ],
          });
          state.batch.metas.push({ type: 'resolve', take: (r) => (reply.r = r) });
          this.#usesBodies(state.batch, a === b ? [a] : [a, b]);
        }
      }
      pending.push({ call, replies });
    }
    run.counters.otherOps += pending.reduce((n, p) => n + p.replies.length, 0);
    await this.#flush(run, state);
    for (const { call, replies } of pending) {
      const found = replies.filter(
        (x) => x.r?.ok === true && (x.r.value as MeasureResult).items.every((i) => i.ok),
      );
      if (found.length === 0) {
        out.set(call.key, failedMeasurement(call, partId, measureFailure(call, partId, replies)));
        continue;
      }
      const bodiesOf = (i: 0 | 1) => [...new Set(found.map((x) => (i === 0 ? x.a : x.b).id))];
      const several = ([0, 1] as const).find((i) => bodiesOf(i).length > 1);
      if (several !== undefined) {
        out.set(
          call.key,
          failedMeasurement(
            call,
            partId,
            `Face "${call.faces[several].face}" is on more than one body of ${partId} (${bodiesOf(several).join(', ')})`,
          ),
        );
        continue;
      }
      const result = found[0]!.r!.ok ? (found[0]!.r!.value as MeasureResult) : null;
      const value =
        result === null
          ? null
          : call.fn === 'distance'
            ? measuredDistance(result)
            : (result.angle?.value ?? null);
      out.set(
        call.key,
        value === null
          ? failedMeasurement(
              call,
              partId,
              `angle() needs two faces with a direction (planar, cylindrical or conical): "${call.written[0]}" and "${call.written[1]}"`,
            )
          : { fn: call.fn, faces: call.written, partId, value },
      );
    }
    return out;
  }

  /** Why no body of `state` carries face `i` of `call`. */
  #lostFace(state: PartState, call: MeasuredCall, i: number): string {
    const face = call.faces[i]!.face;
    const partId = state.part.id;
    for (const id of featureIdsInName(face)) {
      const status = state.results.get(id)?.status;
      if (status === undefined && !state.part.features.some((f) => f.id === id)) continue;
      if (status === undefined) {
        return `Face "${face}" is not found on ${partId}: ${id} is rolled back or depends on the variable`;
      }
      if (status !== 'ok') return `Face "${face}" is not found on ${partId}: ${id} is ${status}`;
    }
    return `Face "${face}" is not found on ${partId}: no body has it`;
  }

  /** A cache key of a feature of `state`'s part: its document's versions and namespace. */
  #key(state: BuildScope, parts: Record<string, unknown>): string {
    return cacheKey(state.versions, state.ns === null ? parts : { namespace: state.ns, ...parts });
  }

  /**
   * `skip`: features left out, as if they were not there (no result, no bodies). Only measured
   * variables use it (`#variables`): the part without the features reading them, which never
   * changes what any other feature reads.
   */
  async #buildPart(
    run: Run,
    part: Part,
    document: ManufaktureDocument,
    variables: VariableValues,
    scope: BuildScope,
    skip?: ReadonlySet<string>,
  ): Promise<PartState> {
    const graph = buildGraph(part, document.variables);
    const lookup = (id: string) => graph.byId.get(id);
    const state: PartState = {
      ...scope,
      part,
      fonts: document.fonts,
      bodies: [],
      consumed: [],
      broken: false,
      batch: emptyBatch(),
      results: new Map(),
      unavailable: new Map(),
      sketches: new Map(),
      inputs: new Map(),
      references: new Set(),
      inherited: new Map(),
      extensions: new Map(),
    };
    /** Domain data namespaces as their owners read them, once per part build. */
    const domainReads = new Map<string, NamespaceRead>();

    for (const [i, f] of graph.active.entries()) {
      if (skip?.has(f.id)) continue;
      const started = now();
      const result: FeatureResult = {
        featureId: f.id,
        kind: f.kind,
        index: i,
        status: 'ok',
        errors: [],
        warnings: [],
        references: [],
        cached: false,
        ms: 0,
      };
      state.results.set(f.id, result);
      const fail = (
        status: 'error' | 'upstream-error' | 'suppressed',
        errors: RegenError[] = [],
      ) => {
        result.status = status;
        result.errors = errors;
        result.ms = now() - started;
        state.unavailable.set(f.id, status);
      };

      if (f.suppressed) {
        fail('suppressed');
        continue;
      }
      const deps = graph.depends.get(f.id) ?? [];
      const upstream = deps.filter((d) => state.unavailable.has(d));
      if (upstream.length > 0) {
        const why = upstream.map((d) => {
          const s = state.unavailable.get(d);
          return `${d}, which ${s === 'suppressed' ? 'is suppressed' : s === 'error' ? 'failed' : 'could not be built'}`;
        });
        fail('upstream-error', [
          { code: 'upstream', upstream, message: `Depends on ${why.join('; and on ')}` },
        ]);
        continue;
      }
      if (readsBody(f) && state.broken) {
        fail('upstream-error', [
          {
            code: 'upstream',
            upstream: [],
            message: 'The kernel failed earlier in this regen; nothing after it was built',
          },
        ]);
        continue;
      }
      if (f.kind === 'import' && f.operation === 'reference') {
        // Shown and measured by the app from the file itself; never part of the body.
        state.references.add(f.id);
        result.warnings = [
          {
            code: 'reference-body',
            message: `${f.source.fileName} is a reference body: shown and measured, not part of the part's body`,
          },
        ];
        result.ms = now() - started;
        continue;
      }
      if (f.kind === 'extension') {
        const errors = await this.#extension(run, state, f, {
          domains: document.domains,
          domainReads,
          variables,
          result,
          started,
          lookup,
        });
        if (errors !== null) fail('error', errors);
        continue;
      }

      const values = evaluateFeature(f, variables);
      if (values.errors.length > 0) {
        fail('error', values.errors);
        continue;
      }

      if (f.kind === 'scripted') {
        await this.#scripted(run, state, f, document, variables, {
          result,
          started,
          lookup,
          variablesRead: graph.variables.get(f.id) ?? [],
        });
        continue;
      }

      if (f.kind === 'sketch') {
        await this.#sketch(run, state, f, values.values, variables, result, started, lookup);
        continue;
      }

      if (f.kind === 'import') {
        let matches = this.#checkedSources.get(f.source);
        if (matches === undefined) {
          matches = await importSourceMatches(f.source);
          this.#checkedSources.set(f.source, matches);
        }
        if (!matches) {
          fail('error', [
            {
              code: 'invalid',
              field: ['source', 'sha256'],
              message: `The stored copy of ${f.source.fileName} does not match its SHA-256: the document is damaged; import the file again`,
            },
          ]);
          continue;
        }
      }

      // A derived feature's source part is built first; its bodies are the op's sources.
      let sources: LiveBody[] = [];
      let sourceWarnings: RegenWarning[] = [];
      if (f.kind === 'derived') {
        const got = await this.#derivedBodies(run, state, f);
        if (!got.ok) {
          fail('error', got.errors);
          continue;
        }
        sources = got.bodies;
        sourceWarnings = got.warnings;
        for (const [id, props] of got.props) state.inherited.set(`${f.id}:from/${id}`, props);
      }

      const t = translateFeature(f, {
        values: values.values,
        sketches: state.sketches,
        inputs: state.inputs,
        references: state.references,
        bodies: new Set(state.bodies.map((b) => b.id)),
        sources: new Map([[f.id, sources]]),
      });
      if (!t.ok) {
        fail('error', t.errors);
        continue;
      }
      state.inputs.set(f.id, t.input);
      // Only the bodies the feature reads go to the kernel, and only their keys into its key.
      const read = new Set(routeBodies(bodyUse(f, lookup)!, state.bodies));
      const reads = state.bodies.filter((b) => read.has(b.id));
      // An import is keyed by its (verified) hash and size, not its whole base64 text; a
      // derive by the keys of its source bodies, not their shape ids.
      const key = this.#key(state, {
        input:
          t.input.kind === 'derive'
            ? { ...t.input, sources: sources.map((b) => [b.id, b.key]) }
            : keyInput(t.input, f.kind === 'import' ? f.source : null),
        bodies: reads.map((b) => [b.id, b.key]),
      });
      run.used.add(key);
      result.key = key;
      const hit = await this.#cache.get(key);
      if (hit !== undefined && hit.type === 'body' && hit.outcome !== undefined) {
        run.counters.cacheHits++;
        this.#applyOutcome(state, f.id, key, hit.outcome);
        this.#fill(result, hit, started);
        result.cached = true;
        if (!hit.ok) state.unavailable.set(f.id, 'error');
        if (sourceWarnings.length > 0) result.warnings = [...result.warnings, ...sourceWarnings];
        continue;
      }
      run.counters.cacheMisses++;
      this.#usesBodies(state.batch, [...reads, ...sources]);
      state.batch.ops.push({
        op: 'feature',
        bodies: reads.map((b) => ({ id: b.id, shape: b.shape })),
        feature: t.input,
      });
      state.batch.metas.push({ type: 'feature', feature: f, key, result, started });
      await this.#flush(run, state);
      if (sourceWarnings.length > 0) result.warnings = [...result.warnings, ...sourceWarnings];
    }
    return state;
  }

  /**
   * A scripted feature (ADR 0010; `scripted.ts`, `script-api.ts`): keyed by its script, stored
   * parameter values, seed and the bodies it reads, served from the cache when the key is known;
   * otherwise its declarations are read, its parameters evaluated as declared, and `run` called
   * in one kernel session, whose result is cached and applied like any feature's outcome. A
   * script error is a deterministic result of the key, so it is cached too; a kernel trap is not.
   */
  async #scripted(
    run: Run,
    state: PartState,
    f: ScriptedFeature,
    document: ManufaktureDocument,
    variables: VariableValues,
    context: {
      result: FeatureResult;
      started: number;
      lookup: (id: string) => Feature | undefined;
      variablesRead: readonly string[];
    },
  ): Promise<void> {
    const { result, started, lookup } = context;
    const fail = (errors: RegenError[], references: ReferenceResolution[] = []) => {
      result.status = 'error';
      result.errors = errors;
      result.references = references;
      result.ms = now() - started;
      state.unavailable.set(f.id, 'error');
    };
    const script = document.scripts?.find((s) => s.id === f.script);
    if (script === undefined) {
      fail([
        { code: 'invalid', field: ['script'], message: `The document has no script ${f.script}` },
      ]);
      return;
    }
    // Before the cache: a document the user has not allowed shows no script's work at all.
    if (!(await scriptAllowed(this.#scriptPolicy, run.stored.id, state.ns === null, script))) {
      fail([scriptsNotRunError(script.id)]);
      return;
    }
    const versionError = apiVersionError(script.id, script.apiVersion);
    if (versionError !== null) {
      fail([versionError]);
      return;
    }
    const read = new Set(routeBodies(bodyUse(f, lookup)!, state.bodies));
    const reads = state.bodies.filter((b) => read.has(b.id));
    const key = this.#key(state, {
      scripted: scriptedKeyParts(f, script, variables, context.variablesRead),
      bodies: reads.map((b) => [b.id, b.key]),
    });
    run.used.add(key);
    result.key = key;
    const hit = await this.#cache.get(key);
    if (hit !== undefined && hit.type === 'body' && hit.outcome !== undefined) {
      run.counters.cacheHits++;
      this.#applyOutcome(state, f.id, key, hit.outcome);
      this.#fill(result, hit, started);
      result.cached = true;
      if (!hit.ok) state.unavailable.set(f.id, 'error');
      return;
    }
    const scripts = this.#scripts;
    if (scripts === null || this.#kernel.session === undefined) {
      fail([{ code: 'unsupported', message: 'This build of the app cannot run scripts' }]);
      return;
    }
    if (scripts.isRunaway(key)) {
      fail([runawayError(script.id)]);
      return;
    }
    if (scripts.isSessionFatal(key)) {
      fail([sessionFatalError(script.id)]);
      return;
    }
    run.counters.cacheMisses++;
    await this.#flush(run, state);
    let instance: ScriptInstance;
    try {
      instance = await scripts.instance(state.ns ?? '');
    } catch (error) {
      // QuickJS could not be fetched or compiled (offline before it was cached, say): not cached.
      fail([
        {
          code: 'script',
          scriptCode: 'internal',
          scriptId: script.id,
          message: 'The script engine could not be loaded',
          detail: error instanceof Error ? error.message : String(error),
        },
      ]);
      return;
    }
    this.#checkStale(run);
    const source = {
      source: script.source,
      language: script.language,
      apiVersion: script.apiVersion,
    };
    // Every cached failure below is a deterministic result of the key.
    const store = async (
      ok: boolean,
      errors: RegenError[],
      outcome: CachedOutcome,
      extra: { warnings?: RegenWarning[]; references?: ReferenceResolution[]; ms: number },
    ) => {
      const entry: CacheEntry = {
        key,
        featureId: f.id,
        type: 'body',
        ok,
        errors,
        warnings: extra.warnings ?? [],
        references: extra.references ?? [],
        outcome,
        ms: extra.ms,
      };
      await this.#cache.set(key, entry);
      this.#applyOutcome(state, f.id, key, outcome);
      this.#fill(result, entry, started);
      if (!ok) state.unavailable.set(f.id, 'error');
    };
    const nothing: CachedOutcome = { instance: null, bodies: [], consumed: [] };

    scripts.event('start', f.id, key);
    scripts.stats.declarations++;
    let declared: Awaited<ReturnType<ScriptInstance['readDeclarations']>>;
    try {
      declared = await instance.readDeclarations({ ...source, limits: scripts.limits });
    } finally {
      scripts.event('end', f.id, key);
    }
    if (!declared.ok) {
      await store(false, [scriptRegenError(script.id, declared.error)], nothing, {
        ms: declared.stats.ms,
      });
      return;
    }
    const specs = declared.value.params;
    const values = scriptParamValues(specs, f.params, variables, script.id);
    if (!values.ok) {
      // Expression errors depend on variables, which are in the key; still not worth caching.
      fail(values.errors);
      return;
    }

    type Ran =
      | { type: 'stale' }
      | { type: 'failed'; errors: RegenError[]; references: ReferenceResolution[]; ms: number }
      | ({ type: 'done'; references: ReferenceResolution[]; ms: number } & ScriptRunOutcome);
    const api = SCRIPT_APIS.get(script.apiVersion)!;
    const reply = await this.#session(
      run,
      f.id,
      async (kernel): Promise<{ value: Ran; keep: ShapeId[] }> => {
        if (reads.some((b) => !kernel.has(b.shape))) return { value: { type: 'stale' }, keep: [] };
        const scriptRun = new ScriptRun(kernel, f.id, reads);
        const params: Record<string, ScriptValue> = { ...values.values };
        const references: ReferenceResolution[] = [];
        const errors: RegenError[] = [];
        for (const spec of specs) {
          if (spec.kind !== 'reference') continue;
          const stored = f.params[spec.name];
          if (stored === undefined || stored.kind !== 'reference') continue;
          const handles: ScriptValue[] = [];
          for (const r of stored.references) {
            const got = scriptRun.referenceHandle(topoRef(r.ref), spec.select);
            if (got.ok) {
              handles.push(got.handle);
              references.push({
                referenceId: r.id,
                target: got.target,
                via: got.via,
                fragile: got.fragile,
              });
              continue;
            }
            const target = 'face' in r.ref ? r.ref.face : r.ref.faces.join('|');
            errors.push(
              got.candidates.length > 0
                ? {
                    code: 'reference-ambiguous',
                    referenceId: r.id,
                    candidates: got.candidates,
                    target,
                    message: `Parameter "${spec.label ?? spec.name}": ${target} is ambiguous: re-pick it`,
                  }
                : {
                    code: 'reference-lost',
                    referenceId: r.id,
                    missing: got.missing,
                    target,
                    message: `Parameter "${spec.label ?? spec.name}": ${target} ${got.message}: re-pick it`,
                  },
            );
          }
          params[spec.name] = spec.multiple === true ? handles : (handles[0] ?? null);
        }
        if (errors.length > 0) {
          return { value: { type: 'failed', errors, references, ms: 0 }, keep: [] };
        }
        const resolved = resolveParams(specs, params);
        if (!resolved.ok) {
          const e = [scriptRegenError(script.id, resolved.error)];
          return { value: { type: 'failed', errors: e, references, ms: 0 }, keep: [] };
        }
        scripts.event('start', f.id, key);
        scripts.stats.runs++;
        let out: Awaited<ReturnType<ScriptInstance['run']>>;
        try {
          out = await instance.run({
            ...source,
            seed: f.seed,
            params: resolved.value,
            host: api(scriptRun),
            limits: scripts.limits,
          });
        } finally {
          scripts.event('end', f.id, key);
        }
        if (!out.ok) {
          const e = [scriptRegenError(script.id, out.error)];
          return { value: { type: 'failed', errors: e, references, ms: out.stats.ms }, keep: [] };
        }
        const done = scriptRun.finish();
        return {
          value: { type: 'done', ...done, references, ms: out.stats.ms },
          keep: done.keep,
        };
      },
    );
    if (reply.result === undefined) throw new Superseded();
    if (!reply.result.ok) {
      // The session failed as a whole (a wasm trap): no usable bodies are left. A fatal one
      // recycles the kernel, which makes the host regenerate: remember the key so that regen
      // does not run it again (and recycle again, without end).
      if (reply.result.error.code === 'fatal') scripts.addSessionFatal(key);
      result.status = 'error';
      result.errors = [mapFailure(reply.result.error)];
      result.ms = now() - started;
      state.unavailable.set(f.id, 'error');
      state.broken = true;
      return;
    }
    const ran = reply.result.value;
    if (ran.type === 'stale') throw new StaleShapes(reply.instance);
    if (reads.some((b) => b.instance !== null && b.instance !== reply.instance)) {
      throw new StaleShapes(reply.instance);
    }
    if (ran.type === 'failed') {
      await store(false, ran.errors, nothing, { references: ran.references, ms: ran.ms });
      return;
    }
    run.counters.featureOps++;
    const outcome = ran.outcome;
    const made = new Set([...outcome.created, ...outcome.changed]);
    const stored: CachedOutcome =
      made.size === 0 && outcome.consumed.length === 0
        ? nothing
        : {
            instance: reply.instance,
            bodies: outcome.bodies
              .filter((b) => made.has(b.id))
              .map((b) => ({
                id: b.id,
                shape: b.shape,
                solids: b.solids,
                created: outcome.created.includes(b.id),
              })),
            consumed: [...outcome.consumed],
          };
    await store(true, [], stored, {
      warnings: ran.warnings,
      references: ran.references,
      ms: ran.ms,
    });
  }

  /** Run a kernel session for `run` (see `RegenKernel.session`), like `#submit` for a batch. */
  async #session<T>(run: Run, featureId: string, fn: SessionFunction<T>): Promise<SessionReply<T>> {
    this.#checkStale(run);
    const reply = await this.#kernel.session!({ generation: run.generation, featureId }, fn);
    run.counters.batches++;
    if (reply.status === 'cancelled') throw new Superseded();
    if (this.#instance !== reply.instance) {
      if (this.#instance !== null) await this.#cache.dropBodies(reply.instance);
      this.#instance = reply.instance;
    }
    run.instance = reply.instance;
    return reply;
  }

  /**
   * The source bodies of a derived feature: its pinned source checked and opened, its nesting
   * checked against `MAX_DERIVED_DEPTH` before anything is built, then its part regenerated
   * (once per regen for every derived feature of that part) and the listed bodies picked.
   */
  async #derivedBodies(
    run: Run,
    state: PartState,
    f: DerivedFeature,
  ): Promise<
    | {
        ok: true;
        bodies: LiveBody[];
        warnings: RegenWarning[];
        props: Map<string, BodyPropsFields>;
      }
    | { ok: false; errors: RegenError[] }
  > {
    const source = await this.#pinnedBuild(run, f.source, state.depth + 1);
    if (!source.ok) return source;
    const { state: built, where } = source;
    const all = built.bodies;
    if (f.bodies !== undefined) {
      const missing = f.bodies.filter((id) => !all.some((b) => b.id === id));
      if (missing.length > 0) {
        return {
          ok: false,
          errors: [
            {
              code: 'reference-lost',
              referenceId: 'bodies',
              missing,
              message: `${where} has no body ${missing.join(', ')} (merged into another, or never made in that version): re-pick the bodies`,
            },
          ],
        };
      }
    }
    const bodies = f.bodies === undefined ? all : all.filter((b) => f.bodies!.includes(b.id));
    if (bodies.length === 0) {
      return {
        ok: false,
        errors: [
          {
            code: 'no-body',
            field: ['source'],
            message: `Part ${f.source.partId} of ${where} has no bodies to derive`,
          },
        ],
      };
    }
    const warnings = sourceFailures(built, where, 'the derived bodies are');
    const props = new Map(
      bodies.map((b) => [b.id, effectiveProps(built.part, b.id, built.inherited.get(b.id))]),
    );
    return { ok: true, bodies, warnings, props };
  }

  /**
   * A pinned part of another document, built in this kernel: its data checked and read, its
   * nesting checked against `MAX_DERIVED_DEPTH` before anything is built (`depth`: 1 for a source
   * of this document), then its part regenerated under its own cache namespace, once per regen
   * for every derived feature and instance of that part.
   */
  async #pinnedBuild(
    run: Run,
    source: DerivedSource,
    depth: number,
  ): Promise<
    | { ok: true; state: PartState; where: string; row: ConfigRow | null }
    | { ok: false; errors: RegenError[] }
  > {
    const opened = await this.#derived.open(source);
    this.#checkStale(run);
    if (!opened.ok) return { ok: false, errors: [opened.error] };
    const fits = await this.#derived.fits(source, depth);
    this.#checkStale(run);
    if (!fits) return { ok: false, errors: [tooDeep(source)] };

    const { document, part, row, namespace: ns } = opened;
    let built = run.sources.get(ns);
    if (built === undefined) {
      const scope: BuildScope = {
        ns,
        depth,
        versions: { ...run.versions, namingScheme: document.namingScheme },
      };
      const variables = await this.#variables(run, document, scope);
      built = await this.#buildPart(run, part, document, variables, scope);
      run.sources.set(ns, built);
    }
    const where = describeSource(source, row);
    if (built.broken) {
      return {
        ok: false,
        errors: [
          {
            code: 'source',
            field: ['source'],
            message: `The kernel failed while building ${where}; nothing of it can be used`,
          },
        ],
      };
    }
    return { ok: true, state: built, where, row };
  }

  /**
   * Throw `StaleShapes` when a body of these parts holds a shape id from another kernel instance
   * than the latest reply's (a recycle landed between a cache hit and now).
   */
  #checkInstances(run: Run, states: readonly PartState[]): void {
    for (const state of states) {
      for (const b of state.bodies) {
        if (b.instance !== null && run.instance !== null && b.instance !== run.instance) {
          throw new StaleShapes(run.instance);
        }
      }
    }
  }

  // Assemblies ---------------------------------------------------------------------------------

  /**
   * Solve `assemblyId` of `document` for a preview (a mate dialog shows the result before OK):
   * the parts its instances show are built through the cache (all hits when only the assembly
   * changed), connectors found, and the assembly solved. Nothing is reported to later regens and
   * drags keep the last regen's state. Null when a newer regen superseded it.
   */
  solveAssembly(
    document: ManufaktureDocument,
    assemblyId: string,
    options: AssemblyOptions = {},
  ): Promise<AssemblyResult | null> {
    const generation = this.#currentGeneration(options);
    if (generation < this.#latest) return Promise.resolve(null);
    if (!document.assemblies.some((a) => a.id === assemblyId)) {
      return Promise.reject(new TypeError(`the document has no assembly ${assemblyId}`));
    }
    const task = this.#chain.then(() =>
      this.#solveOnly(document, assemblyId, generation, options.stored),
    );
    this.#chain = task.catch(() => undefined);
    return task;
  }

  /**
   * One step of dragging `instanceId` of `assemblyId` toward `target`, from where the last step
   * (or the last regen) left the assembly. Drags are coalesced: a drag not started when a newer
   * one arrives resolves to null, and only the latest target is solved. Also null when the
   * request is older than the newest regen, or the last regen has no such assembly. Needs no
   * kernel work, so it never waits for a regen.
   */
  drag(
    assemblyId: string,
    instanceId: string,
    target: DragTarget,
    options: AssemblyOptions = {},
  ): Promise<DragResult | null> {
    const generation = this.#currentGeneration(options);
    if (generation < this.#latest) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      this.#pendingDrag?.resolve(null);
      this.#pendingDrag = { assemblyId, instanceId, target, generation, resolve, reject };
      void this.#runDrags();
    });
  }

  /**
   * End a drag of `assemblyId` that was not committed (cancelled, or nothing moved): the next
   * drag starts from where the last regen left the instances again, not from where the last
   * step did. A step not started yet is dropped (resolves to null). A committed drag needs no
   * call: its `setPoses` regen replaces the state.
   */
  endDrag(assemblyId: string): void {
    if (this.#pendingDrag?.assemblyId === assemblyId) {
      this.#pendingDrag.resolve(null);
      this.#pendingDrag = null;
    }
    const state = this.#assemblyStates.get(assemblyId);
    if (state) state.input = { instances: state.solved, mates: state.input.mates };
  }

  /**
   * Which instances of `assemblyId` overlap, and by how much, as the last regen placed them (or
   * where a drag in progress has them). On demand only, never part of a regen: pairwise booleans
   * are the costly part. One kernel batch runs the bounding-box prefilter over every instance,
   * then one batch per candidate pair, so pairs arrive one by one (`onPair`), a newer regen
   * supersedes the check between two pairs (it resolves to null), and `cancelInterference` stops
   * it there (a `cancelled` report with the pairs found so far). Runs on the regen chain, after
   * any regen in flight. Null too when the request is older than the newest regen, or the last
   * regen has no such assembly.
   */
  interference(
    assemblyId: string,
    options: InterferenceCheckOptions = {},
  ): Promise<InterferenceReport | null> {
    const generation = this.#currentGeneration(options);
    if (generation < this.#latest) return Promise.resolve(null);
    // A stop asked for before this check began is not for it.
    this.#stopChecks.delete(assemblyId);
    const task = this.#chain.then(() => this.#interference(assemblyId, generation, options));
    this.#chain = task.catch(() => undefined);
    return task;
  }

  /** Stop a running interference check of `assemblyId` before its next pair. */
  cancelInterference(assemblyId: string): void {
    this.#stopChecks.add(assemblyId);
  }

  async #interference(
    assemblyId: string,
    generation: number,
    options: InterferenceCheckOptions,
  ): Promise<InterferenceReport | null> {
    const state = this.#assemblyStates.get(assemblyId);
    if (generation < this.#latest || state === undefined || generation < state.generation) {
      return null;
    }
    const t0 = now();
    const run = this.#newRun(generation, this.#lastDocument!);
    const placed = state.input.instances.filter((x) => (state.bodies.get(x.id)?.length ?? 0) > 0);
    const report: InterferenceReport = {
      generation,
      assemblyId,
      instances: placed.map((x) => x.id),
      pairs: [],
      candidates: 0,
      booleans: 0,
      failures: [],
      status: 'done',
      ms: 0,
    };
    const items = placed.map((x) => ({
      shapes: state.bodies.get(x.id)!.map((b) => b.shape),
      transform: x.pose,
    }));
    const bodies = placed.flatMap((x) => state.bodies.get(x.id)!);
    const common: InterferenceOp = { op: 'interference', items };
    if (options.tolerance !== undefined) common.tolerance = options.tolerance;
    /** One batch; null when the bodies are gone (a recycle). */
    const check = async (op: InterferenceOp): Promise<InterferenceResult | null> => {
      const batch = emptyBatch();
      batch.ops.push(op);
      this.#usesBodies(batch, bodies);
      const reply = await this.#submit(run, batch.ops);
      run.counters.otherOps++;
      try {
        this.#checkLive(batch, reply);
      } catch (error) {
        if (error instanceof StaleShapes) return null;
        throw error;
      }
      const r = reply.results[0]!;
      if (!r.ok) throw new Error(`interference of ${assemblyId} failed: ${r.error.message}`);
      return r.value as InterferenceResult;
    };
    const finish = (status: InterferenceReport['status']) => {
      report.status = status;
      report.ms = now() - t0;
      this.#stopChecks.delete(assemblyId);
      this.#addStats(run.counters);
      return report;
    };
    try {
      if (items.length < 2) return finish('done');
      const pre = await check({ ...common, prefilterOnly: true });
      if (pre === null) return finish('stale');
      report.candidates = pre.candidates.length;
      for (const [i, j] of pre.candidates) {
        if (this.#stopChecks.has(assemblyId)) return finish('cancelled');
        const op: InterferenceOp = { ...common, pairs: [[i, j]] };
        if (options.mesh) op.mesh = true;
        const one = await check(op);
        if (one === null) return finish('stale');
        report.booleans += one.booleans;
        const a = placed[i]!.id;
        const b = placed[j]!.id;
        for (const f of one.failures) report.failures.push({ a, b, message: f.message });
        for (const p of one.pairs) {
          const pair: InstanceInterference = { a, b, volume: p.volume, mesh: p.mesh ?? null };
          if (options.onPair) {
            await options.onPair(pair);
            report.pairs.push({ ...pair, mesh: null });
          } else {
            report.pairs.push(pair);
          }
        }
      }
      return finish('done');
    } catch (error) {
      if (error instanceof Superseded) {
        this.#stopChecks.delete(assemblyId);
        this.#addStats(run.counters);
        return null;
      }
      throw error;
    }
  }

  #currentGeneration(options: AssemblyOptions): number {
    if (options.generation !== undefined) {
      if (!Number.isSafeInteger(options.generation)) {
        throw new TypeError('a generation must be an integer');
      }
      return options.generation;
    }
    return this.#newestSeen();
  }

  /**
   * The newest generation requested here or seen by the kernel, or cancelled there: a batch at a
   * generation up to the kernel's `cancelledThrough` is cancelled, so a new regen must be newer.
   */
  #newestSeen(): number {
    const stats = this.#kernel.stats?.();
    const finite = (g: number | undefined) => (g !== undefined && Number.isFinite(g) ? g : 0);
    return Math.max(this.#latest, finite(stats?.generation), finite(stats?.cancelledThrough));
  }

  async #runDrags(): Promise<void> {
    if (this.#dragging) return;
    this.#dragging = true;
    try {
      while (this.#pendingDrag !== null) {
        // Let targets already queued behind this one arrive and replace it.
        await yieldToEventLoop();
        const next = this.#pendingDrag;
        this.#pendingDrag = null;
        if (next === null) break;
        try {
          next.resolve(this.#dragNow(next));
        } catch (error) {
          next.reject(error);
        }
      }
    } finally {
      this.#dragging = false;
    }
  }

  #dragNow(request: PendingDrag): DragResult | null {
    const state = this.#assemblyStates.get(request.assemblyId);
    if (request.generation < this.#latest || state === undefined) return null;
    if (request.generation < state.generation) return null;
    const report = dragAssembly(state.input, request.instanceId, request.target);
    // The next step starts where this one ended.
    state.input = {
      instances: state.input.instances.map((x) => ({ ...x, pose: report.poses[x.id] ?? x.pose })),
      mates: state.input.mates,
    };
    return dragResult(
      request.generation,
      request.assemblyId,
      request.instanceId,
      report,
      state.stored,
    );
  }

  async #solveOnly(
    document: ManufaktureDocument,
    assemblyId: string,
    generation: number,
    stored: ManufaktureDocument | undefined,
  ): Promise<AssemblyResult | null> {
    if (generation < this.#latest) {
      this.#stats.superseded++;
      return null;
    }
    const run = this.#newRun(generation, document, stored);
    return this.#attempt(run, async () => {
      const variables = await this.#variables(run, document);
      const states = new Map<string, PartState>();
      const assembled = await this.#assemble(
        run,
        document,
        variables,
        async (id) => {
          let state = states.get(id);
          const part = document.parts.find((p) => p.id === id);
          if (state === undefined && part !== undefined) {
            state = await this.#buildPart(run, part, document, variables, {
              ns: null,
              depth: 0,
              versions: run.versions,
            });
            states.set(id, state);
          }
          return state;
        },
        assemblyId,
      );
      this.#checkInstances(run, [
        ...states.values(),
        ...[...assembled.sources.values()].map((x) => x.state),
      ]);
      this.#checkStale(run);
      this.#addStats(run.counters);
      return assembled.results[0]!;
    });
  }

  // Drawings ----------------------------------------------------------------------------------

  /** The drawing stage's counters: `project` ops sent and served from its cache, and so on. */
  get drawingStats(): Readonly<DrawingStats> {
    return { ...this.#drawings.stats };
  }

  /**
   * One view of a drawing (see `drawing.ts`): its bodies built through the cache and projected in
   * one `project` op (cached by the bodies' keys and poses and the view), its dimensions resolved
   * and laid out as `packages/drawing` inputs, and with `pick` its picking data. On demand only,
   * at the client's current generation (never a new one), on the regen chain. Null when a newer
   * regen superseded it. Rejects for a drawing or view the document does not have.
   */
  drawingView(
    document: ManufaktureDocument,
    drawingId: string,
    viewId: string,
    options: DrawingRequestOptions = {},
  ): Promise<DrawingViewResult | null> {
    const drawing = document.drawings?.find((d) => d.id === drawingId);
    if (drawing === undefined) {
      return Promise.reject(new TypeError(`the document has no drawing ${drawingId}`));
    }
    const found = findView(drawing, viewId);
    if (found === null) {
      return Promise.reject(new TypeError(`drawing ${drawingId} has no view ${viewId}`));
    }
    return this.#drawing(document, options, (host) =>
      this.#drawings.view(host, document, drawing, found.sheet, found.view, options),
    );
  }

  /**
   * Every view of a sheet as `drawingView` gives it, and the sheet laid out by `packages/drawing`
   * (`layoutSheet`): the display list the screen and the writers draw.
   */
  drawingSheet(
    document: ManufaktureDocument,
    drawingId: string,
    sheetId: string,
    options: DrawingRequestOptions = {},
  ): Promise<DrawingSheetResult | null> {
    const drawing = document.drawings?.find((d) => d.id === drawingId);
    if (drawing === undefined) {
      return Promise.reject(new TypeError(`the document has no drawing ${drawingId}`));
    }
    const sheet = drawing.sheets.find((x) => x.id === sheetId);
    if (sheet === undefined) {
      return Promise.reject(new TypeError(`drawing ${drawingId} has no sheet ${sheetId}`));
    }
    return this.#drawing(document, options, (host) =>
      this.#drawings.sheet(host, document, drawing, sheet, options),
    );
  }

  /** A drawing request on the regen chain, with a host over this run's build of `document`. */
  #drawing<T>(
    document: ManufaktureDocument,
    options: DrawingRequestOptions,
    body: (host: DrawingHost) => Promise<T>,
  ): Promise<T | null> {
    return this.#onDemand(document, options, async (run) =>
      body(await this.#drawingHost(run, document)),
    );
  }

  // Oriented sizes ----------------------------------------------------------------------------

  /** The oriented-size counters: `obb` ops sent and bodies answered from the cache. */
  get orientedStats(): Readonly<OrientedStats> {
    return { ...this.#oriented.stats };
  }

  /**
   * B-reps of members of the last completed regen, on request (STEP export of framing, drawings
   * that need hidden lines through members; ADR 0015 decision 4): built in one kernel batch per
   * owner (cancelled between batches by a newer regen), measured and exported as asked, then
   * released at once, whatever happens: member B-reps are never kept between requests (T6.5a
   * memory rule 4). At the client's current generation, on the regen chain; null when a newer
   * regen superseded it. `memberIds` are full ids; ids the last regen has no member for are
   * `missing`. Rejects before any regen has completed.
   */
  memberBodies(
    partId: string,
    memberIds: readonly string[],
    options: MemberBodiesOptions = {},
  ): Promise<MemberBodiesResult | null> {
    const document = this.#lastDocument;
    if (document === null) {
      return Promise.reject(new Error('member bodies need a completed regen'));
    }
    return this.#onDemand(document, options, (run) =>
      this.#memberBodies(run, partId, memberIds, options),
    );
  }

  async #memberBodies(
    run: Run,
    partId: string,
    memberIds: readonly string[],
    options: MemberBodiesOptions,
  ): Promise<MemberBodiesResult> {
    const t0 = now();
    const known = this.#lastMembers.get(partId);
    const missing: string[] = [];
    const byOwner = new Map<string, { member: MemberData; result: MemberBodyResult }[]>();
    const bodies: MemberBodyResult[] = [];
    for (const id of new Set(memberIds)) {
      const member = known?.get(id);
      if (member === undefined) {
        missing.push(id);
        continue;
      }
      const result: MemberBodyResult = { id, ok: false };
      bodies.push(result);
      const list = byOwner.get(member.owner);
      if (list) list.push({ member, result });
      else byOwner.set(member.owner, [{ member, result }]);
    }
    const kept: { shape: ShapeId; name: string }[] = [];
    let instance: number | null = null;
    let batches = 0;
    let step: Uint8Array | null = null;
    let n = 0;
    const submit = async (ops: KernelOp[]): Promise<BatchReply> => {
      const reply = await this.#submit(run, ops);
      batches++;
      run.counters.otherOps += ops.length;
      // Bodies of an earlier batch died with a recycle: start over on the new instance.
      if (instance !== null && reply.instance !== instance) throw new StaleShapes(reply.instance);
      instance = reply.instance;
      return reply;
    };
    try {
      for (const list of byOwner.values()) {
        const ops: KernelOp[] = [];
        const metas: { result: MemberBodyResult; body: string; last: number }[] = [];
        for (const { member, result } of list) {
          let inputs: FeatureInput[];
          try {
            inputs = memberFeatureInputs(member, ++n);
          } catch (error) {
            result.error = error instanceof Error ? error.message : String(error);
            continue;
          }
          inputs.forEach((feature, i) => {
            ops.push({
              op: 'feature',
              featureId: feature.id,
              bodies: i === 0 ? [] : { result: ops.length - 1 },
              feature,
              keep: i === inputs.length - 1,
            });
          });
          const last = ops.length - 1;
          const body = inputs[0]!.id;
          if (options.volumes) {
            ops.push({ op: 'measure', shape: { result: last, body }, targets: [], body: true });
          }
          metas.push({ result, body, last });
        }
        if (ops.length === 0) continue;
        const reply = await submit(ops);
        for (const { result, body, last } of metas) {
          const r = reply.results[last]!;
          if (!r.ok) {
            result.error = r.error.message;
            continue;
          }
          const outcome = r.value as FeatureOutcome;
          if (!outcome.ok) {
            result.error = outcome.errors.map((e) => e.message).join('; ');
            continue;
          }
          const made = outcome.bodies.find((b) => b.id === body);
          for (const b of outcome.bodies) kept.push({ shape: b.shape, name: result.id });
          if (made === undefined) {
            result.error = 'the kernel made no body for it';
            continue;
          }
          result.ok = true;
          if (options.volumes) {
            const m = reply.results[last + 1]!;
            if (m.ok) result.volume = (m.value as MeasureResult).body?.volume ?? 0;
            else result.error = m.error.message;
          }
        }
      }
      const written = [...(options.with ?? []), ...kept];
      if (options.step && written.length > 0) {
        const reply = await submit([{ op: 'exportStep', bodies: written }]);
        const r = reply.results[0]!;
        if (!r.ok) throw new Error(`the STEP export of the members failed: ${r.error.message}`);
        step = (r.value as { data: Uint8Array }).data;
      }
    } finally {
      // Released whatever happened, unless a recycle already took them.
      if (kept.length > 0 && instance !== null && instance === this.#instance) {
        await this.#kernel.release(kept.map((k) => k.shape));
      }
    }
    return {
      generation: run.generation,
      partId,
      bodies,
      missing,
      step,
      batches,
      ms: now() - t0,
    };
  }

  /**
   * The oriented box sizes of bodies of a part (see `oriented.ts`), for the cut list: the part
   * built through the cache, each body not in the cache measured by one `obb` op (all in one
   * batch), the sizes cached by body key. On demand only, at the client's current generation
   * (never a new one), on the regen chain. Null when a newer regen superseded it. Rejects for a
   * part the document does not have.
   */
  orientedSizes(
    document: ManufaktureDocument,
    partId: string,
    options: OrientedSizesOptions = {},
  ): Promise<OrientedSizesResult | null> {
    if (!document.parts.some((p) => p.id === partId)) {
      return Promise.reject(new TypeError(`the document has no part ${partId}`));
    }
    return this.#onDemand(document, options, async (run) => {
      const part = document.parts.find((p) => p.id === partId)!;
      const state = await this.#buildPart(
        run,
        part,
        document,
        await this.#variables(run, document),
        {
          ns: null,
          depth: 0,
          versions: run.versions,
        },
      );
      this.#checkInstances(run, [state]);
      const skip = new Set(options.skipExtensions ?? []);
      const features = new Map(state.part.features.map((f) => [f.id, f]));
      const all = state.broken ? [] : state.bodies;
      const wanted = options.bodies === undefined ? undefined : new Set(options.bodies);
      const missing = (options.bodies ?? []).filter((id) => !all.some((b) => b.id === id));
      const measured = all.filter((b) => {
        if (wanted !== undefined && !wanted.has(b.id)) return false;
        const creator = features.get(b.creator);
        return !(creator?.kind === 'extension' && skip.has(creator.extension));
      });
      const result: OrientedSizesResult = {
        generation: run.generation,
        partId,
        sizes: [],
        missing,
        failures: [],
      };
      const todo = measured.filter((b) => this.#oriented.get(b.key) === undefined);
      if (todo.length > 0) {
        const batch = emptyBatch();
        for (const b of todo) {
          batch.ops.push({ op: 'obb', shape: b.shape });
          if (b.instance === null) continue;
          const from = batch.shapesFrom;
          batch.shapesFrom = from === null || from === b.instance ? b.instance : MIXED_INSTANCES;
        }
        const reply = await this.#submit(run, batch.ops);
        run.counters.otherOps += batch.ops.length;
        this.#oriented.stats.obbOps += batch.ops.length;
        this.#checkLive(batch, reply);
        for (const [i, b] of todo.entries()) {
          const r = reply.results[i]!;
          if (r.ok) this.#oriented.set(b.key, r.value as OrientedBox);
          else result.failures.push({ bodyId: b.id, message: r.error.message });
        }
      }
      for (const b of measured) {
        const hit = this.#oriented.get(b.key);
        if (hit === undefined) continue;
        if (!todo.includes(b)) this.#oriented.stats.obbHits++;
        result.sizes.push({ bodyId: b.id, sizes: [...hit.sizes], source: hit.source });
      }
      return result;
    });
  }

  // CAM geometry ------------------------------------------------------------------------------

  /** The CAM stage's counters: kernel ops sent and whole results served from its cache. */
  get camStats(): Readonly<CamStats> {
    return { ...this.#cam.stats };
  }

  /**
   * The geometry of one CAM setup (see `cam.ts`, M5 plan T5.1f): the part built through the
   * cache, the setup's body, bounds and WCS, its expressions evaluated and its operations'
   * sources resolved on the final body, in model coordinates. On demand only, at the client's
   * current generation, on the regen chain; a generation newer than any the engine or the kernel
   * has seen is lowered to the newest seen, so a wrong number can never make the kernel cancel a
   * regen. Null when a newer regen superseded it. Rejects for a setup the document does not have.
   */
  camGeometry(
    document: ManufaktureDocument,
    setupId: string,
    options: CamGeometryOptions = {},
  ): Promise<CamGeometryResult | null> {
    const setup = document.cam?.setups.find((s) => s.id === setupId);
    if (setup === undefined) {
      return Promise.reject(new TypeError(`the document has no CAM setup ${setupId}`));
    }
    let generation: number;
    try {
      generation = Math.min(this.#currentGeneration(options), this.#newestSeen());
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#onDemand(document, { ...options, generation }, async (run) =>
      this.#cam.geometry(await this.#camHost(run, document), document, setup, options),
    );
  }

  /** What the CAM stage builds and runs through, for one attempt of one request. */
  async #camHost(run: Run, document: ManufaktureDocument): Promise<CamHost> {
    const variables = await this.#variables(run, document);
    const states = new Map<string, PartState>();
    return {
      generation: run.generation,
      versions: run.versions,
      variables,
      part: async (id) => {
        const part = document.parts.find((p) => p.id === id);
        if (part === undefined) return undefined;
        let state = states.get(id);
        if (state === undefined) {
          state = await this.#buildPart(run, part, document, variables, {
            ns: null,
            depth: 0,
            versions: run.versions,
          });
          states.set(id, state);
        }
        this.#checkInstances(run, [state]);
        return {
          part,
          bodies: state.broken ? [] : state.bodies,
          sketches: state.sketches,
          inputs: state.inputs,
          results: state.results,
        };
      },
      run: async (ops, bodies) => {
        if (ops.length === 0) return [];
        const batch = emptyBatch();
        batch.ops.push(...ops);
        for (const b of bodies) {
          if (b.instance === null) continue;
          const from = batch.shapesFrom;
          batch.shapesFrom = from === null || from === b.instance ? b.instance : MIXED_INSTANCES;
        }
        const reply = await this.#submit(run, batch.ops);
        run.counters.otherOps += ops.length;
        this.#checkLive(batch, reply);
        return reply.results;
      },
    };
  }

  /**
   * A request on the regen chain that is not a regen (drawings, oriented sizes): at the client's
   * current generation, superseded (null) by a newer regen, retried on stale shapes.
   */
  #onDemand<T>(
    document: ManufaktureDocument,
    options: { generation?: number; stored?: ManufaktureDocument },
    body: (run: Run) => Promise<T>,
  ): Promise<T | null> {
    let generation: number;
    try {
      generation = this.#currentGeneration(options);
    } catch (error) {
      return Promise.reject(error);
    }
    if (generation < this.#latest) return Promise.resolve(null);
    const task = this.#chain.then(async () => {
      if (generation < this.#latest) {
        this.#stats.superseded++;
        return null;
      }
      const run = this.#newRun(generation, document, options.stored);
      const result = await this.#attempt(run, () => body(run));
      if (result !== null) this.#addStats(run.counters);
      return result;
    });
    this.#chain = task.catch(() => undefined);
    return task;
  }

  /** What the drawing stage builds and runs through, for one attempt of one request. */
  async #drawingHost(run: Run, document: ManufaktureDocument): Promise<DrawingHost> {
    const variables = await this.#variables(run, document);
    const states = new Map<string, PartState>();
    const partFor = async (id: string): Promise<PartState | undefined> => {
      let state = states.get(id);
      const part = document.parts.find((p) => p.id === id);
      if (state === undefined && part !== undefined) {
        state = await this.#buildPart(run, part, document, variables, {
          ns: null,
          depth: 0,
          versions: run.versions,
        });
        states.set(id, state);
      }
      return state;
    };
    const assembled = new Map<string, Assembled>();
    const failedFeatures = (state: PartState) =>
      state.part.features
        .filter((f) => {
          const status = state.results.get(f.id)?.status;
          return status === 'error' || status === 'upstream-error';
        })
        .map((f) => f.id);
    const live = (b: LiveBody, extra: Partial<DrawingBody> & { key: string; pose: Pose }) => ({
      body: b.id,
      shape: b.shape,
      bodyKey: b.key,
      kernelInstance: b.instance,
      ...extra,
    });
    // Domain views (format v15). Per request: each (domain, part) context is built and frozen
    // once, each distinct view drawn once, and one budget bounds what all of them draw.
    type DomainDrawn = {
      output: DomainViewOutput | null;
      bodies: DrawingBody[];
      diagnostics: DrawingDiagnostic[];
      /** What reading the part cost (its members and features), charged when it was drawn. */
      work: number;
      /** Not drawn: the budget could not cover reading the part. Never cached. */
      refused?: boolean;
    };
    type DomainBase = {
      diagnostics: DrawingDiagnostic[];
      /** Members of every set plus features: what one view scans of the part, at most. */
      cost: number;
      base: Omit<DomainViewContext, 'evaluate' | 'params' | 'schemaVersion'>;
      state: PartState;
      all: readonly LiveBody[];
    };
    const domainOutputs = new Map<string, DomainDrawn>();
    const domainBases = new Map<string, DomainBase | DrawingDiagnostic[]>();
    let domainSpent = 0;
    const overBudget = (): DrawingDiagnostic => ({
      code: 'domain-view',
      severity: 'warning',
      subject: '',
      message: `The domain views of this request scan and draw more than ${this.#domainBudget} members, lines, arcs, string points and marks and pitch symbols together: this one is left out`,
    });
    const domainBase = async (
      registered: RegisteredDomainDrawings,
      partId: string,
    ): Promise<DomainBase | DrawingDiagnostic[]> => {
      const key = `${registered.namespace}\n${partId}`;
      const hit = domainBases.get(key);
      if (hit !== undefined) return hit;
      const made = await makeDomainBase(registered, partId);
      domainBases.set(key, made);
      return made;
    };
    const makeDomainBase = async (
      registered: RegisteredDomainDrawings,
      partId: string,
    ): Promise<DomainBase | DrawingDiagnostic[]> => {
      const diagnostics: DrawingDiagnostic[] = [];
      const state = await partFor(partId);
      if (state === undefined) {
        return [
          {
            code: 'unknown-source',
            severity: 'error',
            subject: '',
            message: `The document has no part ${partId}`,
          },
        ];
      }
      this.#checkInstances(run, [state]);
      // The member sets, from the member cache after a regen: plain data, no kernel ops.
      const framed = await this.#frameMembers(run, state, document);
      const failed = failedFeatures(state);
      if (failed.length > 0) {
        diagnostics.push({
          code: 'source-errors',
          severity: 'warning',
          subject: '',
          failed,
          message: `${failed.length === 1 ? 'A feature' : `${failed.length} features`} of ${state.part.name} failed (${failed.join(', ')}): the view shows what was built without ${failed.length === 1 ? 'it' : 'them'}`,
        });
      }
      const features: MemberFeature[] = [];
      for (const f of state.part.features) {
        if (f.kind !== 'extension' || extensionNamespace(f.extension) !== registered.namespace)
          continue;
        if (state.results.get(f.id)?.status !== 'ok') continue;
        const metadata = state.extensions.get(f.id)?.metadata;
        features.push({
          id: f.id,
          type: f.extension,
          schemaVersion: f.schemaVersion,
          dependsOn: [...f.dependsOn],
          ...(metadata === undefined ? {} : { metadata }),
        });
      }
      const sets: DomainViewSet[] = framed
        .filter((x) => x.entry.namespace === registered.namespace && x.entry.result.ok)
        .map((x) => {
          const r = x.entry.result;
          const metadata = r.ok ? r.metadata : undefined;
          return {
            group: x.entry.group.id,
            members: x.members,
            ...(metadata === undefined ? {} : { metadata }),
          };
        });
      const data = readDomainData(this.#extensions, registered, document.domains, new Map());
      if (!data.ok) {
        return [
          ...diagnostics,
          { code: 'domain-view', severity: 'error', subject: '', message: data.error.message },
        ];
      }
      const all = state.broken ? [] : state.bodies;
      try {
        const base = frozenCopy({
          partId: state.part.id,
          features,
          sets,
          data: data.data,
          bodies: all.map((b) => b.id),
        });
        const cost = features.length + sets.reduce((n, x) => n + x.members.length, 0);
        return { diagnostics, base, state, all, cost };
      } catch (error) {
        return [
          ...diagnostics,
          {
            code: 'domain-view',
            severity: 'error',
            subject: '',
            message: `The "${registered.namespace}" view got data that is not plain: ${error instanceof Error ? error.message : String(error)}`,
          },
        ];
      }
    };
    const drawDomainView = async (source: DomainViewSource): Promise<DomainDrawn> => {
      let work = 0;
      const none = (diagnostics: DrawingDiagnostic[]): DomainDrawn => ({
        output: null,
        bodies: [],
        diagnostics,
        work,
      });
      const registered = this.#extensions.domainDrawings(source.domain);
      if (registered === undefined) {
        return none([
          {
            code: 'domain-view',
            severity: 'error',
            subject: '',
            message: `This build draws no "${source.domain}" views: open the document in a build that ships the "${source.domain}" domain`,
          },
        ]);
      }
      if (source.schemaVersion > registered.drawings.schemaVersion) {
        return none([
          {
            code: 'domain-view',
            severity: 'error',
            subject: '',
            message: `This "${source.domain}" view is version ${source.schemaVersion}, newer than this build reads (version ${registered.drawings.schemaVersion}): open the document in a newer build`,
          },
        ]);
      }
      const prepared = await domainBase(registered, source.part);
      if (Array.isArray(prepared)) return none([...prepared]);
      const diagnostics = [...prepared.diagnostics];
      // Refused before the domain scans the part when the budget cannot cover the scan: a view
      // that draws nothing still reads every member (a plan cut above the walls).
      if (domainSpent + prepared.cost > this.#domainBudget) {
        return { ...none([...diagnostics, overBudget()]), refused: true };
      }
      work = prepared.cost;
      let params: DomainViewContext['params'];
      try {
        params = frozenCopy(source.params);
      } catch (error) {
        return none([
          ...diagnostics,
          {
            code: 'domain-view',
            severity: 'error',
            subject: '',
            message: `The "${source.domain}" view's params are not plain: ${error instanceof Error ? error.message : String(error)}`,
          },
        ]);
      }
      const context: DomainViewContext = {
        ...prepared.base,
        params,
        schemaVersion: source.schemaVersion,
        evaluate: (expression, kind) => {
          const parsed = StoredExpressionSchema.safeParse(expression);
          if (!parsed.success) return { ok: false, message: 'not an expression' };
          const r = evaluateField(parsed.data, kind, [], variables);
          return r.ok ? r : { ok: false, message: r.error.message };
        },
      };
      const out = guard(source.domain, 'view', () => registered.drawings.view(context));
      const checked = out.ok
        ? checkDomainView(out.value)
        : { ok: false as const, message: out.error.message };
      if (!checked.ok) {
        return none([
          ...diagnostics,
          {
            code: 'domain-view',
            severity: 'error',
            subject: '',
            message: `The "${source.domain}" view could not be drawn: ${checked.message}`,
          },
        ]);
      }
      const output = checked.view;
      for (const w of output.warnings ?? []) {
        diagnostics.push({
          code: 'domain-view',
          severity: 'warning',
          subject: '',
          message: w.message,
        });
      }
      const listed = new Set(output.bodies);
      const present = new Set(prepared.all.map((b) => b.id));
      const missing = output.bodies.filter((id) => !present.has(id));
      if (missing.length > 0) {
        diagnostics.push({
          code: 'missing-body',
          severity: 'warning',
          subject: '',
          missing,
          message: `${prepared.state.part.name} has no body ${missing.join(', ')}`,
        });
      }
      return {
        output,
        bodies: prepared.all
          .filter((b) => listed.has(b.id))
          .map((b) => live(b, { key: b.id, pose: IDENTITY_POSE })),
        diagnostics,
        work,
      };
    };
    return {
      generation: run.generation,
      variables,
      versions: run.versions,
      deflection: this.#deflection,
      bodies: async (source) => {
        const diagnostics: DrawingDiagnostic[] = [];
        if (isDomainViewSource(source)) {
          // Drawn through `domainView`; as a plain source it shows no bodies.
          return { bodies: [], diagnostics };
        }
        if ('part' in source) {
          const state = await partFor(source.part);
          if (state === undefined) {
            diagnostics.push({
              code: 'unknown-source',
              severity: 'error',
              subject: '',
              message: `The document has no part ${source.part}`,
            });
            return { bodies: [], diagnostics };
          }
          this.#checkInstances(run, [state]);
          const failed = failedFeatures(state);
          if (failed.length > 0) {
            diagnostics.push({
              code: 'source-errors',
              severity: 'warning',
              subject: '',
              failed,
              message: `${failed.length === 1 ? 'A feature' : `${failed.length} features`} of ${state.part.name} failed (${failed.join(', ')}): the view shows what was built without ${failed.length === 1 ? 'it' : 'them'}`,
            });
          }
          const all = state.broken ? [] : state.bodies;
          const listed = source.bodies;
          if (listed !== undefined) {
            const missing = listed.filter((id) => !all.some((b) => b.id === id));
            if (missing.length > 0) {
              diagnostics.push({
                code: 'missing-body',
                severity: 'warning',
                subject: '',
                missing,
                message: `${state.part.name} has no body ${missing.join(', ')} (merged into another, or never made)`,
              });
            }
          }
          const shown = listed === undefined ? all : all.filter((b) => listed.includes(b.id));
          return {
            bodies: shown.map((b) => live(b, { key: b.id, pose: IDENTITY_POSE })),
            diagnostics,
          };
        }
        const assembly = document.assemblies.find((a) => a.id === source.assembly);
        if (assembly === undefined) {
          diagnostics.push({
            code: 'unknown-source',
            severity: 'error',
            subject: '',
            message: `The document has no assembly ${source.assembly}`,
          });
          return { bodies: [], diagnostics };
        }
        let out = assembled.get(assembly.id);
        if (out === undefined) {
          out = await this.#assemble(run, document, variables, partFor, assembly.id);
          assembled.set(assembly.id, out);
        }
        this.#checkInstances(run, [
          ...states.values(),
          ...[...out.sources.values()].map((x) => x.state),
        ]);
        const result = out.results[0]!;
        const state = out.states.get(assembly.id);
        const failed = result.instances
          .filter((x) => x.status === 'error')
          .map((x) => x.instanceId);
        if (failed.length > 0) {
          diagnostics.push({
            code: 'source-errors',
            severity: 'warning',
            subject: '',
            failed,
            message: `${failed.length === 1 ? 'Instance' : 'Instances'} ${failed.join(', ')} of ${assembly.name} could not be built in full: see the assembly`,
          });
        }
        // An exploded view: each instance at its solved pose plus its exploded offset (T4.5a).
        let offsets = new Map<string, Vec3>();
        if (source.explodedView !== undefined) {
          const exploded = result.explodedViews?.find(
            (v) => v.explodedViewId === source.explodedView,
          );
          if (exploded === undefined) {
            diagnostics.push({
              code: 'exploded-view',
              severity: 'warning',
              subject: '',
              message: `${assembly.name} has no exploded view ${source.explodedView}: the view is drawn assembled`,
            });
          } else {
            offsets = explodedOffsets(exploded);
            const warned = explodeWarnings(exploded);
            if (warned.length > 0) {
              diagnostics.push({
                code: 'exploded-view',
                severity: 'warning',
                subject: '',
                message: `${warned.length === 1 ? 'A step' : `${warned.length} steps`} of ${exploded.name} did not resolve in full: ${warned.map((w) => w.warning.message).join('; ')}`,
              });
            }
          }
        }
        const bodies: DrawingBody[] = [];
        for (const x of state?.solved ?? []) {
          const pose = explodedPose(x.pose, offsets.get(x.id));
          for (const b of state!.bodies.get(x.id) ?? []) {
            bodies.push(live(b, { key: `${x.id}/${b.id}`, instance: x.id, pose }));
          }
        }
        return { bodies, diagnostics };
      },
      domainView: async (source) => {
        // Views of a request are drawn one at a time (the stage awaits each): the cache and the
        // budget below assume it.
        // One output per distinct view in a request (copies of a view are drawn once), and one
        // budget across all of them, charged for the members a view scans when it is drawn and
        // for what each copy draws: once spent, later views draw nothing (a warning).
        // The params by the SHA-256 of their canonical text: no collisions to fear, and no 16 KB
        // key kept per view.
        const key = `${source.domain}\n${source.part}\n${source.schemaVersion}\n${await sha256Hex(stableStringify(source.params))}`;
        let drawn = domainOutputs.get(key);
        if (drawn === undefined) {
          if (domainSpent >= this.#domainBudget) {
            return { output: null, bodies: [], diagnostics: [overBudget()] };
          }
          drawn = await drawDomainView(source);
          if (drawn.refused === true)
            return { output: null, bodies: [], diagnostics: drawn.diagnostics };
          domainOutputs.set(key, drawn);
          // The scan happened whether or not the view draws anything; at least 1, so a part with
          // nothing to scan still cannot be drawn without end.
          domainSpent += Math.max(1, drawn.work);
        }
        const diagnostics = [...drawn.diagnostics];
        if (drawn.output === null) return { output: null, bodies: [], diagnostics };
        const cost = domainViewCost(drawn.output);
        if (domainSpent + cost > this.#domainBudget) {
          // Clamped to the budget, not left below it: every later view is refused at once, so a
          // run of views each just over what is left cannot each be computed and dropped.
          domainSpent = this.#domainBudget;
          return { output: null, bodies: [], diagnostics: [...diagnostics, overBudget()] };
        }
        domainSpent += cost;
        return { output: drawn.output, bodies: drawn.bodies, diagnostics };
      },
      titleNotes: (sources) => {
        // Every domain the sheet shows (`title-notes.ts`), drawn or not.
        const namespaces = shownNamespaces(document, sources);
        const notes: string[] = [];
        for (const ns of namespaces) {
          const note = this.#extensions.domainDrawings(ns)?.drawings.titleNote;
          if (note !== undefined && !notes.includes(note)) notes.push(note);
        }
        return notes;
      },
      run: async (ops, bodies) => {
        if (ops.length === 0) return [];
        const batch = emptyBatch();
        batch.ops.push(...ops);
        for (const b of bodies) {
          if (b.kernelInstance === null) continue;
          const from = batch.shapesFrom;
          batch.shapesFrom =
            from === null || from === b.kernelInstance ? b.kernelInstance : MIXED_INSTANCES;
        }
        const reply = await this.#submit(run, batch.ops);
        run.counters.otherOps += ops.length;
        this.#checkLive(batch, reply);
        return reply.results;
      },
    };
  }

  /** Every assembly of `document` (or only `only`), after the parts. */
  async #assemble(
    run: Run,
    document: ManufaktureDocument,
    variables: VariableValues,
    partFor: (partId: string) => Promise<PartState | undefined>,
    only?: string,
  ): Promise<Assembled> {
    const out: Assembled = {
      results: [],
      states: new Map(),
      sources: new Map(),
      connectorKeys: new Set(),
    };
    for (const assembly of document.assemblies) {
      if (only !== undefined && assembly.id !== only) continue;
      out.results.push(await this.#assembly(run, document, assembly, variables, partFor, out));
    }
    return out;
  }

  /**
   * The bodies an instance's source part has, built if needed, with its warnings and where the
   * result reports them (`ref`). A part of this document in the row the document is built in (or
   * with no row) is that part's own build; in another row it is built again from the document in
   * that row and reported as a source. A pinned part is built in its row like a derived source.
   */
  async #instanceSource(
    run: Run,
    document: ManufaktureDocument,
    source: Assembly['instances'][number]['source'],
    partFor: (partId: string) => Promise<PartState | undefined>,
    out: Assembled,
  ): Promise<
    | { ok: true; state: PartState; warnings: RegenWarning[]; ref: InstanceSourceRef }
    | { ok: false; errors: RegenError[] }
  > {
    const warnings: RegenWarning[] = [];
    let state: PartState;
    let where: string;
    let ref: InstanceSourceRef;
    if ('part' in source) {
      const row = source.configuration;
      const own = row === undefined || row === (document.configurations?.active ?? null);
      const found = own
        ? await partFor(source.part)
        : await this.#partInRow(run, source.part, row, out);
      if (found !== undefined && 'errors' in found) return { ok: false, errors: found.errors };
      if (found === undefined) {
        return {
          ok: false,
          errors: [
            {
              code: 'source',
              field: ['source', 'part'],
              message: `This document has no part ${source.part}`,
            },
          ],
        };
      }
      if (found.broken) {
        return {
          ok: false,
          errors: [
            {
              code: 'upstream',
              upstream: [],
              message: `The kernel failed while building part ${source.part}; it has no bodies to show`,
            },
          ],
        };
      }
      state = found;
      if (own) {
        where = `Part ${found.part.name}`;
        ref = { part: source.part };
      } else {
        const name = configurationRow(document, row)?.name ?? row;
        where = `Part ${found.part.name} in configuration ${name}`;
        ref = { source: instanceSourceKey(source) };
        warnings.push(...sourceFailures(state, where, 'the instance shows what'));
      }
    } else {
      const got = await this.#pinnedBuild(run, source, 1);
      if (!got.ok) return got;
      state = got.state;
      where = `Part ${state.part.name} of ${got.where}`;
      const key = instanceSourceKey(source);
      ref = { source: key };
      out.sources.set(key, {
        info: {
          documentId: source.documentId,
          documentName: source.documentName,
          versionId: source.versionId,
          versionName: source.versionName,
          partId: source.partId,
          partName: state.part.name,
          ...(got.row === null ? {} : { row: { id: got.row.id, name: got.row.name } }),
        },
        state,
      });
      warnings.push(...sourceFailures(state, got.where, 'the instance shows what'));
    }
    const bar = state.part.rollbackIndex;
    if (bar !== null && bar < state.part.features.length) {
      warnings.push({
        code: 'rollback',
        partId: state.part.id,
        message: `${where} is rolled back to before feature ${bar + 1} of ${state.part.features.length}: the instance shows it as regenerated so far`,
      });
    }
    return { ok: true, state, warnings, ref };
  }

  /**
   * Part `partId` of this document built in configuration row `rowId`, once per regen for every
   * instance that shows it there. It is built from the stored document in that row
   * (`configured(run.stored, rowId)`; never from `document`, which may have the active row
   * applied already, whose values a partial row would inherit) in the document's own cache
   * namespace: its features' keys hold their evaluated inputs, so whatever
   * the row leaves as it is shares its entries with the part's own build (as switching the active
   * row does), and what the row changes has entries of its own. Undefined when the document has no
   * such part.
   */
  async #partInRow(
    run: Run,
    partId: string,
    rowId: string,
    out: Assembled,
  ): Promise<PartState | { errors: RegenError[] } | undefined> {
    const key = instanceSourceKey({ part: partId, configuration: rowId });
    const known = out.sources.get(key);
    if (known !== undefined) return known.state;
    const stored = run.stored;
    let byRow = this.#rowDocuments.get(stored);
    if (byRow === undefined) this.#rowDocuments.set(stored, (byRow = new Map()));
    let variant = byRow.get(rowId);
    if (variant === undefined) byRow.set(rowId, (variant = configured(stored, rowId)));
    const row = configurationRow(stored, rowId);
    if (!variant.ok || row === undefined) {
      const message =
        row === undefined
          ? `This document has no configuration row ${rowId}; pick another row`
          : `Configuration ${row.name} (${rowId}) cannot be applied: ${variant.ok ? '' : variant.error.message}`;
      return { errors: [{ code: 'source', field: ['source', 'configuration'], message }] };
    }
    const doc = variant.value;
    const part = doc.parts.find((p) => p.id === partId);
    if (part === undefined) return undefined;
    const state = await this.#buildPart(run, part, doc, await this.#variables(run, doc), {
      ns: null,
      depth: 0,
      versions: run.versions,
    });
    out.sources.set(key, {
      info: {
        documentId: '',
        documentName: '',
        versionId: '',
        versionName: '',
        partId,
        partName: part.name,
        row: { id: row.id, name: row.name },
      },
      state,
    });
    return state;
  }

  /** A connector frame's cache key: the body it is on (by content) and what it names. */
  #connectorKey(body: LiveBody, origin: unknown, inference: string): string {
    return `${body.key}\n${stableStringify([origin, inference])}`;
  }

  async #assembly(
    run: Run,
    document: ManufaktureDocument,
    assembly: Assembly,
    variables: VariableValues,
    partFor: (partId: string) => Promise<PartState | undefined>,
    out: Assembled,
  ): Promise<AssemblyResult> {
    const result = emptyAssemblyResult(assembly.id);
    const stored = new Map(assembly.instances.map((x) => [x.id, x.pose]));

    // Instances: the bodies of their source part (connectors resolve on any of them).
    const instances = new Map<string, InstanceResult>();
    const partBodies = new Map<string, LiveBody[]>();
    for (const x of assembly.instances) {
      const r = emptyInstanceResult(x.id, x.source, x.pose, x.suppressed);
      result.instances.push(r);
      instances.set(x.id, r);
      if (x.suppressed) continue;
      const src = await this.#instanceSource(run, document, x.source, partFor, out);
      if (!src.ok) {
        r.status = 'error';
        r.errors = src.errors;
        continue;
      }
      r.source = src.ref;
      r.warnings.push(...src.warnings);
      const all = src.state.bodies;
      if (all.length === 0) {
        r.status = 'error';
        r.errors.push({
          code: 'no-body',
          field: ['source'],
          message: `Part ${src.state.part.name} has no bodies to show`,
        });
        continue;
      }
      const listed = x.bodies;
      if (listed === undefined) {
        partBodies.set(x.id, all);
        r.bodies = all.map((b) => b.id);
        continue;
      }
      const missing = listed.filter((id) => !all.some((b) => b.id === id));
      if (missing.length > 0) {
        r.status = 'error';
        r.errors.push({
          code: 'reference-lost',
          referenceId: 'bodies',
          missing,
          message: `Part ${src.state.part.name} has no body ${missing.join(', ')} (merged into another, or never made): re-pick the bodies`,
        });
      }
      // Connectors sit on what the instance shows: a face of a body it hides is not its own.
      const shown = all.filter((b) => listed.includes(b.id));
      r.bodies = shown.map((b) => b.id);
      if (shown.length > 0) partBodies.set(x.id, shown);
    }

    // Mates: what each needs, then the connector frames not found before, in one batch.
    const started = now();
    const work: { mate: Assembly['mates'][number]; result: MateResult; values: MateValues }[] = [];
    const wanted = new Map<LiveBody, { key: string; op: ConnectorOp['connectors'][number] }[]>();
    for (const mate of assembly.mates) {
      const m = emptyMateResult(mate);
      result.mates.push(m);
      if (mate.suppressed) continue;
      const ends = [mate.a.instance, mate.b.instance];
      const off = ends.find((id) => instances.get(id)?.status === 'suppressed');
      if (off !== undefined) {
        m.status = 'suppressed';
        m.message = `Instance ${off} is suppressed, so ${mate.id} is not solved`;
        continue;
      }
      const broken = ends.filter((id) => !partBodies.has(id));
      if (broken.length > 0) {
        m.status = 'error';
        m.errors.push({
          code: 'upstream',
          upstream: broken,
          message: `Instance ${broken.join(' and ')} could not be built, so ${mate.id} is not solved`,
        });
        continue;
      }
      const values = mateValues(mate, variables);
      if (values.errors.length > 0) {
        m.status = 'error';
        m.errors = values.errors;
        continue;
      }
      for (const side of ['a', 'b'] as const) {
        const c = mate[side];
        for (const body of partBodies.get(c.instance)!) {
          const origin = connectorOrigin(c);
          const key = this.#connectorKey(body, origin, c.inference);
          out.connectorKeys.add(key);
          if (this.#connectors.has(key)) continue;
          const list = wanted.get(body) ?? [];
          if (!list.some((x) => x.key === key))
            list.push({ key, op: { origin, inference: c.inference } });
          wanted.set(body, list);
        }
      }
      work.push({ mate, result: m, values });
    }
    // Exploded steps whose direction is an edge or a face of an instance: the same connector op
    // finds it (the frame's z), on the bodies the instance shows.
    const stepDirection = (step: ExplodeStep) => {
      const d = step.direction;
      const inference = directionInference(step);
      if ('vector' in d || inference === null) return null;
      return { instance: d.instance, origin: topoRef('edge' in d ? d.edge : d.face), inference };
    };
    for (const view of assembly.explodedViews ?? []) {
      for (const step of view.steps) {
        const dir = stepDirection(step);
        if (dir === null) continue;
        for (const body of partBodies.get(dir.instance) ?? []) {
          const key = this.#connectorKey(body, dir.origin, dir.inference);
          out.connectorKeys.add(key);
          if (this.#connectors.has(key)) continue;
          const list = wanted.get(body) ?? [];
          if (!list.some((x) => x.key === key))
            list.push({ key, op: { origin: dir.origin, inference: dir.inference } });
          wanted.set(body, list);
        }
      }
    }
    /** Reports of this regen that are not cached (the op failed as a whole). */
    const uncached = new Map<string, ConnectorReport>();
    if (wanted.size > 0) {
      const batch = emptyBatch();
      const lists = [...wanted];
      for (const [body, list] of lists) {
        batch.ops.push({ op: 'connector', shape: body.shape, connectors: list.map((x) => x.op) });
      }
      this.#usesBodies(
        batch,
        lists.map(([body]) => body),
      );
      const reply = await this.#submit(run, batch.ops);
      run.counters.otherOps += batch.ops.length;
      this.#checkLive(batch, reply);
      lists.forEach(([, list], j) => {
        const r = reply.results[j]!;
        list.forEach((x, i) => {
          if (r.ok) {
            this.#connectors.set(x.key, (r.value as { results: ConnectorReport[] }).results[i]!);
          } else {
            uncached.set(x.key, { ok: false, status: 'no-body', message: r.error.message });
          }
        });
      });
    }

    // Frames, then the solve.
    const mates: MateInput[] = [];
    for (const { mate, result: m, values } of work) {
      const poses: Pose[] = [];
      (['a', 'b'] as const).forEach((side, i) => {
        const c = mate[side];
        const reports = partBodies.get(c.instance)!.flatMap((b) => {
          const key = this.#connectorKey(b, connectorOrigin(c), c.inference);
          const report = this.#connectors.get(key) ?? uncached.get(key);
          return report === undefined ? [] : [{ bodyId: b.id, report }];
        });
        const report = pickReport(reports);
        if (report === undefined || !report.ok) {
          m.errors.push(connectorError(mate, side, report));
          return;
        }
        const found = connectorResolution(mate, side, report);
        const frame = connectorPose(framePose(report.frame), c, values.offsets[side]);
        m.connectors[i]!.reference = found.reference;
        m.connectors[i]!.frame = frame;
        m.warnings.push(...found.warnings);
        poses.push(frame);
      });
      if (m.errors.length > 0) {
        m.status = 'error';
        continue;
      }
      mates.push(mateInput(mate, poses[0]!, poses[1]!, values));
    }
    const input = solverInput(
      assembly.instances.filter((x) => !x.suppressed),
      mates,
    );
    const report = solve(input);
    applyReport(result, report, stored);
    result.ms = now() - started;
    const solved = input.instances.map((x) => ({ ...x, pose: report.poses[x.id] ?? x.pose }));
    // Exploded views, on top of the solved poses (T4.5a); they never change them.
    if (assembly.explodedViews !== undefined) {
      const context = {
        variables,
        instances: new Set(assembly.instances.map((x) => x.id)),
        poses: new Map(solved.map((x) => [x.id, x.pose])),
        direction: (step: ExplodeStep) => {
          const dir = stepDirection(step);
          if (dir === null) return undefined;
          const reports = (partBodies.get(dir.instance) ?? []).flatMap((b) => {
            const key = this.#connectorKey(b, dir.origin, dir.inference);
            const r = this.#connectors.get(key) ?? uncached.get(key);
            return r === undefined ? [] : [{ bodyId: b.id, report: r }];
          });
          return pickReport(reports);
        },
      };
      result.explodedViews = assembly.explodedViews.map((v) => resolveExplodedView(v, context));
    }
    out.states.set(assembly.id, {
      generation: run.generation,
      input: { instances: solved, mates },
      solved,
      stored,
      bodies: partBodies,
    });
    return result;
  }

  /**
   * Apply what a feature did (from the kernel, or from the cache) to the part's bodies: merged
   * bodies go, changed ones take their new shape and key, made ones are added at the end. A
   * body's `carries` follows merges, so a reference to a face that came from a merged body is
   * routed to the body it is now on.
   */
  #applyOutcome(state: PartState, featureId: string, key: string, outcome: CachedOutcome): void {
    if (outcome.bodies.length === 0 && outcome.consumed.length === 0) return;
    const consumed = new Set(outcome.consumed);
    const merged = new Set<string>();
    for (const b of state.bodies) {
      if (!consumed.has(b.id)) continue;
      for (const c of b.carries) merged.add(c);
      state.consumed.push({ bodyId: b.id, featureId });
    }
    state.bodies = state.bodies.filter((b) => !consumed.has(b.id));
    for (const c of outcome.bodies) {
      const next = {
        shape: c.shape,
        instance: outcome.instance,
        solids: c.solids,
        key: `${key}/${c.id}`,
      };
      const at = c.created ? -1 : state.bodies.findIndex((b) => b.id === c.id);
      if (at >= 0) {
        const old = state.bodies[at]!;
        state.bodies[at] = {
          ...old,
          ...next,
          carries: new Set([...old.carries, ...merged, featureId]),
        };
      } else {
        state.bodies.push({ id: c.id, creator: featureId, carries: new Set([featureId]), ...next });
      }
    }
  }

  #fill(result: FeatureResult, entry: CacheEntry, started: number): void {
    result.status = entry.ok ? 'ok' : 'error';
    result.errors = entry.errors;
    result.warnings = entry.warnings;
    result.references = entry.references;
    if (entry.thread !== undefined) result.thread = entry.thread;
    result.ms = now() - started;
  }

  async #sketch(
    run: Run,
    state: PartState,
    f: Extract<Feature, { kind: 'sketch' }>,
    values: ReadonlyMap<string, number>,
    variables: VariableValues,
    result: FeatureResult,
    started: number,
    lookup: (id: string) => Feature | undefined,
  ): Promise<void> {
    const { name: _name, ...definition } = f;
    void _name;
    // A face sketch reads the bodies its face may lie on.
    const owners =
      f.plane.type === 'face'
        ? (() => {
            const read = new Set(routeBodies(bodyUse(f, lookup)!, state.bodies));
            return state.bodies.filter((b) => read.has(b.id));
          })()
        : [];
    const plane =
      f.plane.type === 'plane'
        ? { placement: explicitPlacement(f.plane) }
        : { bodies: owners.map((b) => [b.id, b.key]), ref: f.plane.face.ref };
    const fonts = sketchFontKey(f, state.fonts, (id) => bundledFont(id)?.sha256);
    const key = this.#key(state, {
      solver: this.#solverBuild,
      sketch: sketchKeyDefinition(definition),
      values: [...values.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      plane,
      // Only sketches with text have fonts in their key, so other keys stay as they were.
      ...(fonts.length > 0 ? { fonts } : {}),
    });
    run.used.add(key);
    result.key = key;
    const hit = await this.#cache.get(key);
    if (hit !== undefined && hit.type === 'sketch') {
      run.counters.cacheHits++;
      this.#fill(result, hit, started);
      result.cached = true;
      if (hit.sketch) result.placement = hit.sketch.placement;
      if (hit.sketch && hit.sketch.outlines.length > 0) result.outlines = hit.sketch.outlines;
      if (hit.ok && hit.sketch) state.sketches.set(f.id, hit.sketch);
      else state.unavailable.set(f.id, 'error');
      return;
    }
    run.counters.cacheMisses++;

    let placement: SketchPlacement;
    const warnings: RegenWarning[] = [];
    const references: FeatureResult['references'] = [];
    const store = async (
      entry: Omit<CacheEntry, 'key' | 'featureId' | 'type' | 'ms'>,
      uncached = false,
    ) => {
      const full: CacheEntry = {
        key,
        featureId: f.id,
        type: 'sketch',
        ms: now() - started,
        ...entry,
      };
      if (!uncached) await this.#cache.set(key, full);
      this.#fill(result, full, started);
      if (!full.ok) state.unavailable.set(f.id, 'error');
    };

    if (f.plane.type === 'plane') {
      placement = explicitPlacement(f.plane);
    } else {
      const reference = f.plane.face;
      const target = reference.ref.face;
      if (owners.length === 0) {
        await store({
          ok: false,
          errors: [
            {
              code: 'no-body',
              referenceId: reference.id,
              message: `The sketch is on ${target}, but there is no body yet`,
            },
          ],
          warnings: [],
          references: [],
        });
        return;
      }
      // One resolve per body the face may lie on (usually one); face names are unique across
      // the bodies of a part, so at most one resolves.
      const reports: ReferenceReport[] = [];
      let failure: RegenError | undefined;
      this.#usesBodies(state.batch, owners);
      for (const b of owners) {
        state.batch.ops.push({ op: 'resolve', shape: b.shape, refs: [faceRef(reference.ref)] });
        state.batch.metas.push({
          type: 'resolve',
          take: (r) => {
            if (r.ok) reports.push((r.value as { results: ReferenceReport[] }).results[0]!);
            else failure ??= mapFailure(r.error);
          },
        });
        run.counters.otherOps++;
      }
      await this.#flush(run, state);
      const report = reports.find((r) => r.ok) ?? reports[0];
      if (report === undefined) {
        await store({
          ok: false,
          errors: [failure ?? { code: 'kernel', message: 'resolving the sketch plane failed' }],
          warnings: [],
          references: [],
        });
        return;
      }
      const resolved = planeReport(f, reference.id, target, report);
      if (!resolved.ok) {
        await store({ ok: false, errors: [resolved.error], warnings: [], references: [] });
        return;
      }
      const frame = frameOnPlane(resolved.origin, resolved.normal);
      placement = { origin: frame.origin, normal: frame.normal, xDir: frame.xDir };
      warnings.push(...resolved.warnings);
      references.push(resolved.reference);
    }

    run.counters.solves++;
    const solved = await solveSketch(this.#solver, f, placement, variables, {
      fonts: state.fonts,
      values,
      outliner: this.#text,
      signal: run.abort.signal,
      budget: run.text,
      svgBudget: run.svg,
      checkStale: () => this.#checkStale(run),
    });
    this.#checkStale(run);
    if (!solved.ok) {
      // A failure that may not repeat (a bundled font fetched too slowly, a time budget used
      // up) is reported but not cached, so the next regen tries again.
      await store(
        { ok: false, errors: solved.errors, warnings, references },
        solved.transient === true,
      );
      return;
    }
    state.sketches.set(f.id, solved.sketch);
    result.placement = solved.sketch.placement;
    if (solved.sketch.outlines.length > 0) result.outlines = solved.sketch.outlines;
    await store({
      ok: true,
      errors: [],
      warnings: [...warnings, ...solved.warnings],
      references,
      sketch: solved.sketch,
    });
  }

  // Extensions -----------------------------------------------------------------------------------

  /**
   * Build an extension feature through its domain's translator (ADR 0013 decisions 4 to 6): the
   * type checked against the registry, domain data and params read by the domain, expressions
   * evaluated, references resolved on the bodies before it, the queries of a two-step translator
   * answered, then one kernel `feature` op per input it returns, each cached under a key of that
   * input, the type, its version and the domain's implementation. Translators are pure and
   * cheap, so they run on every regen; only the kernel step is cached. Returns the errors of a
   * failure before the kernel step (the caller fails the feature with them), or null when the
   * result is filled in.
   */
  async #extension(
    run: Run,
    state: PartState,
    stored: ExtensionFeature,
    at: {
      domains: ManufaktureDocument['domains'];
      domainReads: Map<string, NamespaceRead>;
      variables: VariableValues;
      result: FeatureResult;
      started: number;
      lookup: (id: string) => Feature | undefined;
    },
  ): Promise<RegenError[] | null> {
    const { result, started } = at;
    const found = supported(this.#extensions, stored);
    if (!found.ok) return [found.error];
    const extension = found.extension;
    const type = stored.extension;
    // Domain code gets frozen copies: a translator that writes to its input fails (a throw,
    // contained below) instead of changing the document or what later extensions read.
    const f = frozenCopy(stored);
    const data = readDomainData(this.#extensions, extension, at.domains, at.domainReads);
    if (!data.ok) return [data.error];
    const params = readParams(extension, f);
    if (!params.ok) return [params.error];
    const values = evaluateExtension(extension, f, at.variables);
    if (values.errors.length > 0) return values.errors;

    const resolved = await this.#extensionReferences(run, state, f);
    if (!resolved.ok) return resolved.errors;

    const sketches = new Map<string, SketchResult>();
    const upstream = new Map<string, ExtensionUpstream>();
    for (const id of f.dependsOn) {
      const sketch = state.sketches.get(id);
      if (sketch !== undefined) sketches.set(id, frozenCopy(sketch));
      const built = state.extensions.get(id);
      if (built !== undefined && extensionNamespace(built.type) === extension.namespace) {
        upstream.set(id, built);
      }
    }
    let shared: { params: unknown; data: Record<string, unknown> };
    try {
      shared = frozenCopy({ params: params.params, data: data.data });
    } catch (error) {
      return [
        {
          code: 'extension',
          message: `The "${type}" params or domain data are not plain data: ${error instanceof Error ? error.message : String(error)}`,
        },
      ];
    }
    const context: ExtensionContext = {
      feature: f,
      params: shared.params,
      values: Object.freeze(values.values),
      references: Object.freeze(resolved.references),
      data: shared.data,
      sketches,
      upstream,
      bodies: Object.freeze(state.bodies.map((b) => b.id)),
      profile: (sketchId, entities) => {
        const sketch = sketches.get(sketchId);
        if (sketch === undefined) {
          return {
            ok: false,
            message: `${sketchId} is not a solved sketch this feature depends on`,
            field: ['dependsOn'],
          };
        }
        const p = profileOf(sketchId, sketch, entities);
        return p.ok
          ? { ok: true, value: p.profile }
          : { ok: false, message: p.error.message, field: ['dependsOn'] };
      },
    };

    // The two-step form: answer what the translator asks about the part before building.
    let answers: GeometryAnswer[] = [];
    const ask = extension.definition.queries;
    if (ask !== undefined) {
      const asked = guard(type, 'queries', () => ask.call(extension.definition, context));
      if (!asked.ok) return [asked.error];
      const queries = checkQueries(type, asked.value);
      if (!queries.ok) return [queries.error];
      answers = await this.#answerQueries(run, state, queries.queries);
    }
    const translated = guard(type, 'translator', () =>
      extension.definition.translate(context, Object.freeze(answers)),
    );
    if (!translated.ok) return [translated.error];
    // Checked and copied to frozen plain data in one guard: a getter or a value structured clone
    // refuses is the feature's error, and the kernel sees the copy, not the translator's objects.
    const checked = guard(type, 'translator result check', () => {
      const out = checkOutput(f, translated.value, new Set(state.bodies.map((b) => b.id)));
      if (!out.ok) return out;
      const copy: ExtensionUpstream = frozenCopy(
        out.metadata === undefined
          ? { type, inputs: out.inputs }
          : { type, inputs: out.inputs, metadata: out.metadata },
      );
      return { ok: true as const, built: copy };
    });
    if (!checked.ok) return [checked.error];
    if (!checked.value.ok) return checked.value.errors;
    const built = checked.value.built;
    state.extensions.set(f.id, built);
    if (built.metadata !== undefined) result.metadata = built.metadata;

    // One kernel op per input, in order, each reading the bodies as the one before left them.
    const errors: RegenError[] = [];
    const warnings: RegenWarning[] = [...resolved.warnings];
    const references: ReferenceResolution[] = [...resolved.resolutions];
    let cached = built.inputs.length > 0;
    let ok = true;
    // A failed extension changes nothing (ADR 0013 decision 5): what earlier inputs did to the
    // bodies is undone when a later one fails. Their cache entries stay; they are still right.
    const bodiesBefore = [...state.bodies];
    const consumedBefore = state.consumed.length;
    for (const [i, input] of built.inputs.entries()) {
      const read = new Set(routeBodies(bodyUse(f, at.lookup)!, state.bodies));
      // A `new` extension's `tools` input also reads the bodies its items name, when this
      // feature or one it names in dependsOn made them (a wall joining its layers with an earlier
      // wall's): it reads only what it depends on, as every extension does.
      if (f.operation === 'new' && input.kind === 'tools') {
        for (const item of input.items) {
          const creator = bodyCreator(item.body);
          if (creator === f.id || (creator !== undefined && f.dependsOn.includes(creator))) {
            read.add(item.body);
          }
        }
      }
      const reads = state.bodies.filter((b) => read.has(b.id));
      const key = this.#key(state, {
        extension: extensionKey(extension, f, i, built.inputs.length),
        input,
        bodies: reads.map((b) => [b.id, b.key]),
      });
      run.used.add(key);
      const step: FeatureResult = { ...result, errors: [], warnings: [], references: [] };
      const hit = await this.#cache.get(key);
      if (hit !== undefined && hit.type === 'body' && hit.outcome !== undefined) {
        run.counters.cacheHits++;
        this.#applyOutcome(state, f.id, key, hit.outcome);
        this.#fill(step, hit, started);
        if (!hit.ok) state.unavailable.set(f.id, 'error');
      } else {
        cached = false;
        run.counters.cacheMisses++;
        this.#usesBodies(state.batch, reads);
        state.batch.ops.push({
          op: 'feature',
          bodies: reads.map((b) => ({ id: b.id, shape: b.shape })),
          feature: input,
        });
        state.batch.metas.push({ type: 'feature', feature: stored, key, result: step, started });
        await this.#flush(run, state);
      }
      errors.push(...step.errors);
      warnings.push(...step.warnings);
      references.push(...step.references);
      if (step.status !== 'ok') {
        ok = false;
        break;
      }
    }
    result.status = ok ? 'ok' : 'error';
    result.errors = errors;
    result.warnings = warnings;
    result.references = references;
    result.cached = ok && cached;
    result.ms = now() - started;
    if (!ok) {
      state.bodies = bodiesBefore;
      state.consumed.length = consumedBefore;
      state.unavailable.set(f.id, 'error');
    }
    return null;
  }

  /**
   * An extension's references resolved on the bodies before it (the kernel's `resolve` op, one
   * per body a reference may lie on), all in one batch. A reference that does not resolve fails
   * the feature as a lost face fails a built-in one.
   */
  async #extensionReferences(
    run: Run,
    state: PartState,
    f: ExtensionFeature,
  ): Promise<
    | {
        ok: true;
        references: Record<string, ResolvedReference>;
        warnings: RegenWarning[];
        resolutions: ReferenceResolution[];
      }
    | { ok: false; errors: RegenError[] }
  > {
    const out = {
      references: {} as Record<string, ResolvedReference>,
      warnings: [] as RegenWarning[],
      resolutions: [] as ReferenceResolution[],
    };
    if (f.references.length === 0) return { ok: true, ...out };
    const reports = await this.#resolveOnBodies(
      run,
      state,
      f.references.map((r) => topoRef(r.ref)),
    );
    const errors: RegenError[] = [];
    f.references.forEach((reference, i) => {
      const { body, report } = reports[i]!;
      const ref = reference.ref;
      const target = 'face' in ref ? ref.face : ref.faces.join('|');
      if (!report.ok) {
        errors.push(lostReference(reference, target, report));
        return;
      }
      out.references[reference.id] = {
        body: body!,
        target,
        via: report.via,
        fragile: report.fragile,
        geometry: report.geometry,
      };
      out.resolutions.push({
        referenceId: reference.id,
        target,
        via: report.via,
        fragile: report.fragile,
      });
      if (report.via !== 'exact' || report.fragile) {
        out.warnings.push({
          code: 'reference',
          referenceId: reference.id,
          target,
          via: report.via,
          fragile: report.fragile,
          message: `${target} resolved ${report.fragile ? 'by position' : `by ${report.via}`}: check it`,
        });
      }
    });
    return errors.length > 0 ? { ok: false, errors } : { ok: true, ...out };
  }

  /** A two-step translator's queries answered against the part before the feature, in order. */
  async #answerQueries(
    run: Run,
    state: PartState,
    queries: readonly GeometryQuery[],
  ): Promise<GeometryAnswer[]> {
    const refs = queries.flatMap((q) => (q.type === 'resolve' ? [q.ref] : []));
    const resolved = refs.length > 0 ? await this.#resolveOnBodies(run, state, refs) : [];
    const boxes = new Map<number, { box: OrientedBox | null; message?: string }>();
    queries.forEach((q, i) => {
      if (q.type !== 'obb') return;
      const body = state.bodies.find((b) => b.id === q.body);
      if (body === undefined) {
        boxes.set(i, { box: null, message: `${q.body} is not a body at this point` });
        return;
      }
      this.#usesBodies(state.batch, [body]);
      state.batch.ops.push({ op: 'obb', shape: body.shape });
      state.batch.metas.push({
        type: 'resolve',
        take: (r) =>
          boxes.set(
            i,
            r.ok ? { box: r.value as OrientedBox } : { box: null, message: r.error.message },
          ),
      });
      run.counters.otherOps++;
    });
    await this.#flush(run, state);
    let next = 0;
    return queries.map((q, i): GeometryAnswer => {
      if (q.type === 'resolve') return { type: 'resolve', ...resolved[next++]! };
      const got = boxes.get(i) ?? { box: null, message: 'not answered' };
      return { type: 'obb', body: q.body, ...got };
    });
  }

  /**
   * Resolve each reference on the bodies that may carry it (by the feature ids in its names), in
   * one batch: the first body it resolves on, or the first failure. No body at all is `no-body`.
   */
  async #resolveOnBodies(
    run: Run,
    state: PartState,
    refs: readonly TopoRef[],
  ): Promise<{ body: string | null; report: ReferenceReport }[]> {
    const found = refs.map(() => [] as { body: string; report: ReferenceReport }[]);
    const failures: (string | undefined)[] = refs.map(() => undefined);
    refs.forEach((ref, i) => {
      const names = 'face' in ref ? [ref.face] : [...ref.faces, ...(ref.ends ?? [])];
      const read = new Set(routeBodies({ all: false, scope: [], refs: [names] }, state.bodies));
      const owners = state.bodies.filter((b) => read.has(b.id));
      this.#usesBodies(state.batch, owners);
      for (const b of owners) {
        state.batch.ops.push({ op: 'resolve', shape: b.shape, refs: [ref] });
        state.batch.metas.push({
          type: 'resolve',
          take: (r) => {
            if (r.ok) {
              const report = (r.value as { results: ReferenceReport[] }).results[0]!;
              found[i]!.push({ body: b.id, report });
            } else failures[i] ??= r.error.message;
          },
        });
        run.counters.otherOps++;
      }
    });
    await this.#flush(run, state);
    return found.map((list, i) => {
      const hit = list.find((x) => x.report.ok) ?? list[0];
      if (hit !== undefined) return hit;
      const message = failures[i] ?? 'there is no body yet';
      return { body: null, report: { ok: false, status: 'no-body', message } };
    });
  }

  /** The next op reads these bodies: note which instance their shape ids are from. */
  #usesBodies(batch: Batch, bodies: readonly LiveBody[]): void {
    for (const b of bodies) {
      if (b.instance === null) continue;
      const from = batch.shapesFrom;
      batch.shapesFrom = from === null || from === b.instance ? b.instance : MIXED_INSTANCES;
    }
  }

  /**
   * Throw `StaleShapes` when a batch ran on shape ids that are gone, before any of its results
   * are used or cached: a reply from another kernel instance than the ids came from (a recycle
   * was queued after a cache hit and ran before the batch), an op that failed on an unknown
   * shape, or a feature the kernel passed through because its input body is unknown.
   */
  #checkLive(batch: Batch, reply: BatchReply): void {
    if (batch.shapesFrom !== null && batch.shapesFrom !== reply.instance) {
      throw new StaleShapes(reply.instance);
    }
    for (const [j, r] of reply.results.entries()) {
      if ((!r.ok && r.error.code === 'unknown-shape') || staleBody(batch.ops[j]!, r)) {
        throw new StaleShapes(reply.instance);
      }
    }
  }

  /** Run the pending batch and record what each op did. */
  async #flush(run: Run, state: PartState): Promise<void> {
    const batch = state.batch;
    if (batch.ops.length === 0) return;
    state.batch = emptyBatch();
    run.counters.featureOps += batch.metas.filter((m) => m.type === 'feature').length;
    const reply = await this.#submit(run, batch.ops);
    this.#checkLive(batch, reply);

    for (const [j, meta] of batch.metas.entries()) {
      const r = reply.results[j]!;
      if (meta.type === 'resolve') {
        meta.take(r);
        continue;
      }
      if (meta.type !== 'feature') continue;
      const { feature, key, result, started } = meta;
      if (!r.ok) {
        // The op failed as a whole (a wasm trap): no usable bodies are left.
        result.status = 'error';
        result.errors = [mapFailure(r.error)];
        result.ms = now() - started;
        state.unavailable.set(feature.id, 'error');
        state.broken = true;
        continue;
      }
      const outcome = r.value as FeatureOutcome;
      const made = new Set([...outcome.created, ...outcome.changed]);
      const stored: CachedOutcome =
        made.size === 0 && outcome.consumed.length === 0
          ? { instance: null, bodies: [], consumed: [] }
          : {
              instance: reply.instance,
              bodies: outcome.bodies
                .filter((b) => made.has(b.id))
                .map((b) => ({
                  id: b.id,
                  shape: b.shape,
                  solids: b.solids,
                  created: outcome.created.includes(b.id),
                })),
              consumed: [...outcome.consumed],
            };
      const entry: CacheEntry = {
        key,
        featureId: feature.id,
        type: 'body',
        ok: outcome.ok,
        ...mapOutcome(feature, outcome),
        outcome: stored,
        ms: r.ms,
      };
      await this.#cache.set(key, entry);
      this.#applyOutcome(state, feature.id, key, stored);
      this.#fill(result, entry, started);
      if (!outcome.ok) state.unavailable.set(feature.id, 'error');
    }
  }
}
