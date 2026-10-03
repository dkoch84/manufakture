// G-code export (M5 plan, T5.4e), kept free of React: what a setup needs before it can be
// exported (every operation generated from its current inputs, none with an error), the export
// settings (post, units, multi-tool mode, grouping by tool), and the export itself: the
// generation linked into one job (`assembleJob`), written by the chosen post, named through
// `@manufakture/io`'s `fileName`, with the summary and setup sheet data the operator reads before
// saving. An operation with an error, or a post that refuses the job, refuses the export with
// the reason; nothing is ever dropped silently.

import {
  GCODE_FILE_EXTENSION,
  assembleJob,
  dialComment,
  jobOperations,
  postCarbideMotion,
  postFileStem,
  postGrbl,
  postGrblHal,
  postLinuxCnc,
  postMach3,
  stockTopZ,
  toolpathBounds,
  toolpathStats,
  type Box3,
  type CamResult,
  type Feeds,
  type Job,
  type JobOperation,
  type OperationInput,
  type PostJob,
  type PostOutput,
  type PostUnits,
  type Setup,
  type Tool,
  type Toolpath,
  type ToolpathStats,
  type Vec3,
  type WcsCorner,
} from '@manufakture/cam';
import { machineDial, type MachineProfile } from '@manufakture/cam/library';
import type { CamOperation, CamSetup } from '@manufakture/core';
import type { CamGeometryResult } from '@manufakture/regen';
import { fileName } from '@manufakture/io';
import { MM_PER_INCH } from '@manufakture/units';
import { zipSync, strToU8, type Zippable } from 'fflate';
import type { ExportedFile } from '../../io/actions';
import { POST_IDS, postName } from '../commands';
import { documentOperation } from '../generate';
import type { GeneratedToolpaths } from '../preview/job';
import { operationStatus, type GeneratedOutcome } from '../status';

/**
 * How a job with several tools is written: one file per tool, one file with an `M0` pause at each
 * change, or one file with `M6 T<n>` at each change.
 */
export type MultiToolMode = 'files' | 'pause' | 'm6';

export const MULTI_TOOL_LABELS: Readonly<Record<MultiToolMode, string>> = {
  files: 'One file per tool',
  pause: 'One file, M0 pause at each tool change',
  m6: 'One file, M6 at each tool change',
};

/**
 * The multi-tool modes each built-in post writes, its default first (the cam README's dialect
 * table): Grbl fails an `M6`, so it splits files or pauses; Carbide Motion, LinuxCNC and Mach3
 * write `M6 T<n>`; grblHAL does either, splitting by default.
 */
export const POST_MULTI_TOOL: Readonly<Record<string, readonly MultiToolMode[]>> = {
  grbl: ['files', 'pause'],
  'carbide-motion': ['m6'],
  grblhal: ['files', 'pause', 'm6'],
  linuxcnc: ['m6'],
  mach3: ['m6'],
};

/** The multi-tool modes `post` writes; none for a post this build does not know. */
export function multiToolModes(post: string): readonly MultiToolMode[] {
  return Object.hasOwn(POST_MULTI_TOOL, post) ? POST_MULTI_TOOL[post]! : [];
}

export interface ExportSettings {
  /** A built-in post id. */
  readonly post: string;
  /** `mm` writes G21, `inch` G20. */
  readonly units: PostUnits;
  readonly multiTool: MultiToolMode;
  /** Group operations by tool (fewer tool changes; may change the order material comes off). */
  readonly groupByTool: boolean;
}

/**
 * The settings an export starts with: the setup's post (which a new setup takes from its machine
 * profile), or the machine's default post when this build does not write the setup's; millimetres;
 * the post's default multi-tool mode; the user's operation order.
 */
export function defaultExportSettings(
  setup: Pick<CamSetup, 'post'>,
  machine: MachineProfile | undefined,
): ExportSettings {
  const post = POST_IDS.includes(setup.post)
    ? setup.post
    : (machine?.posts.find((p) => POST_IDS.includes(p)) ?? POST_IDS[0]!);
  return { post, units: 'mm', multiTool: multiToolModes(post)[0] ?? 'files', groupByTool: false };
}

/** `settings` with another post, keeping the multi-tool mode when the post writes it. */
export function withPost(settings: ExportSettings, post: string): ExportSettings {
  const modes = multiToolModes(post);
  return {
    ...settings,
    post,
    multiTool: modes.includes(settings.multiTool) ? settings.multiTool : (modes[0] ?? 'files'),
  };
}

// ---------------------------------------------------------------------------------------------
// Readiness: what has to happen before the setup can be exported.

/** An operation that stops the export, and why. */
export interface ExportBlocker {
  readonly id: string;
  readonly name: string;
  readonly message: string;
}

export interface ExportReadiness {
  /** Operations with an error: the export refuses until they are fixed or suppressed. */
  readonly blocked: readonly ExportBlocker[];
  /** Operations to generate first: never generated, or generated from inputs that changed. */
  readonly stale: readonly string[];
  /** Why the export cannot run at all (no operation to cut, say); null when it can. */
  readonly message: string | null;
  /**
   * The geometry is not known to be the current document's (an edit since, or no reply yet):
   * every operation counts as stale until a reply for the document as it is now arrives.
   */
  readonly pending: boolean;
}

/**
 * What the setup needs before it can be exported, from the workspace's state: the last geometry
 * reply, the last generation's outcomes and toolpaths, and whether there is a geometry stage at
 * all (`available`). Suppressed operations are left out. `current` says whether `geometry` was
 * resolved for the document as it is now; when it was not (the document changed since, and the
 * reply for the edit has not come), every operation is pending: an edit to the stock, heights,
 * feeds or model may change any of them, and their keys cannot tell until the new reply.
 */
export function exportReadiness(
  setup: Pick<CamSetup, 'id' | 'operations'>,
  geometry: CamGeometryResult | null,
  generated: ReadonlyMap<string, GeneratedOutcome>,
  toolpaths: GeneratedToolpaths | null,
  available: boolean,
  current = true,
): ExportReadiness {
  const active = setup.operations.filter((op) => !op.suppressed);
  if (active.length === 0) {
    return {
      blocked: [],
      stale: [],
      pending: false,
      message:
        setup.operations.length === 0
          ? 'This setup has no operations to export.'
          : 'Every operation of this setup is suppressed: nothing to export.',
    };
  }
  const unavailable =
    'Toolpaths need the geometry kernel and the CAM worker, which are not running here.';
  if (!current) {
    return {
      blocked: [],
      stale: active.map((op) => op.id),
      message: available ? null : unavailable,
      pending: true,
    };
  }
  const shownGeometry = geometry?.setupId === setup.id ? geometry : null;
  const results = toolpaths?.setupId === setup.id ? toolpaths.operations : [];
  const blocked: ExportBlocker[] = [];
  const stale: string[] = [];
  for (const op of active) {
    const status = operationStatus(op, shownGeometry, generated, available);
    if (status.state === 'error') {
      blocked.push(blocker(op, status.errors.join(' ') || 'Its geometry has an error.'));
      continue;
    }
    const result = results.find((r) => r.id === op.id);
    if (status.toolpath === 'failed' && !status.stale) {
      const outcome = generated.get(op.id);
      blocked.push(blocker(op, outcome?.message ?? 'Its toolpath could not be generated.'));
    } else if (
      status.state === 'pending' ||
      status.toolpath === 'none' ||
      status.stale ||
      result === undefined
    ) {
      stale.push(op.id);
    } else if (!result.ok) {
      blocked.push(blocker(op, result.error.message));
    }
  }
  const message = stale.length > 0 && !available ? unavailable : null;
  return { blocked, stale, message, pending: false };
}

function blocker(op: CamOperation, message: string): ExportBlocker {
  return { id: op.id, name: op.name, message };
}

// ---------------------------------------------------------------------------------------------
// The export.

/** One posted file. */
export interface PostedFile {
  /** From 1. */
  readonly index: number;
  /** The file name, extension included, made safe by `fileName`. */
  readonly name: string;
  readonly text: string;
  /** The tool ids it uses, in order. */
  readonly tools: readonly string[];
}

/** A tool as the summary and setup sheet list it. */
export interface ExportTool {
  readonly id: string;
  readonly number?: number;
  readonly name: string;
  readonly kind: Tool['kind'];
  readonly diameter: number;
  readonly flutes: number;
  /** Names of the operations that use it, in job order. */
  readonly operations: readonly string[];
}

/** One tool change, in the order the program makes them (the first tool loaded included). */
export interface ToolChangeStep {
  /** From 1. */
  readonly index: number;
  readonly tool: ExportTool;
  /** The operation the change is made for. */
  readonly operation: string;
  /** Spindle speed after the change, rpm. */
  readonly rpm: number;
  /** The router dial setting nearest to `rpm`, as the post's comment writes it; null for a VFD. */
  readonly dial: string | null;
  /** The file it happens in, from 1. */
  readonly file: number;
}

/** One operation as the setup sheet lists it, in job order. */
export interface SheetOperation {
  readonly id: string;
  readonly name: string;
  readonly kind: OperationInput['kind'];
  readonly tool: ExportTool;
  readonly feeds: Feeds;
  /** The router dial setting nearest to the spindle speed; null for a VFD. */
  readonly dial: string | null;
  /** Machine (WCS) Z of the top of the cut and of the deepest cut, mm. */
  readonly zTop: number | null;
  readonly zBottom: number | null;
  /** Depth per pass, mm, for the operations that step down. */
  readonly stepdown: number | null;
  /** Cuts through the stock's bottom. */
  readonly through: boolean;
  /** Its own estimated time, minutes (links and tool changes not counted). */
  readonly minutes: number | null;
}

/** Everything the summary and the setup sheet show, and the files to save. */
export interface ExportPlan {
  readonly settings: ExportSettings;
  readonly postName: string;
  readonly multiTool: MultiToolMode;
  readonly jobName: string;
  readonly setupName: string;
  readonly date: string;
  readonly machine: MachineProfile;
  readonly files: readonly PostedFile[];
  readonly tools: readonly ExportTool[];
  readonly toolChanges: readonly ToolChangeStep[];
  readonly operations: readonly SheetOperation[];
  /** The whole program's statistics (links and dwells included). */
  readonly stats: ToolpathStats | null;
  /** Where the tool tip goes, WCS mm: every move, and the feed moves only. */
  readonly extents: { readonly all: Box3; readonly feed: Box3 | undefined };
  /** The stock: its size (X, Y, Z, mm), material, and box in WCS coordinates. */
  readonly stock: { readonly size: Vec3; readonly material?: string; readonly box: Box3 };
  readonly origin: { readonly xy: WcsCorner; readonly z: 'top' | 'bottom'; readonly text: string };
  /** The heights the job used, machine Z, mm. */
  readonly heights: { readonly clearance: number; readonly retract: number };
  /** The job's, the operations' and the post's warnings, as sentences. */
  readonly warnings: readonly string[];
}

export type ExportBuild =
  | { readonly ok: true; readonly plan: ExportPlan }
  | { readonly ok: false; readonly reasons: readonly string[] };

export interface ExportInput {
  readonly data: GeneratedToolpaths;
  /** The setup's operations as the document has them (names, suppression, order). */
  readonly operations: readonly Pick<CamOperation, 'id' | 'name' | 'suppressed'>[];
  readonly settings: ExportSettings;
  readonly jobName: string;
  readonly setupName: string;
  readonly machine: MachineProfile;
  /** Date text for the files and the sheet; the caller formats it. */
  readonly date: string;
}

const CORNER_WORDS: Readonly<Record<WcsCorner, string>> = {
  'front-left': 'front left corner',
  'front-right': 'front right corner',
  'back-left': 'back left corner',
  'back-right': 'back right corner',
  centre: 'centre',
};

/** Where to zero X, Y and Z in words, as the posts write it: `stock top, front left corner`. */
export function originText(origin: { xy: WcsCorner; z: 'top' | 'bottom' }): string {
  return `stock ${origin.z}, ${CORNER_WORDS[origin.xy]}`;
}

/** Height under which a cut counts as reaching the stock's bottom, mm. */
const THROUGH_EPS = 1e-3;

/** Tools in the order of first use, and with `groupByTool`, operations by tool (stable). */
function groupedOrder<T extends { tool: { id: string } }>(ops: readonly T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const op of ops) {
    const g = groups.get(op.tool.id);
    if (g) g.push(op);
    else groups.set(op.tool.id, [op]);
  }
  return [...groups.values()].flat();
}

/**
 * Warnings for through-cuts that grouping by tool moves ahead of other cuts: in the user's order
 * the other cuts came first, so the part was still held by the stock while they ran.
 */
export function groupingWarnings(
  ops: readonly { id: string; name: string; tool: { id: string }; through: boolean }[],
): string[] {
  const grouped = groupedOrder(ops);
  const out: string[] = [];
  ops.forEach((op, i) => {
    if (!op.through) return;
    const before = new Set(ops.slice(0, i).map((o) => o.id));
    const at = grouped.indexOf(op);
    const overtaken = grouped.slice(at + 1).filter((o) => before.has(o.id));
    if (overtaken.length > 0) {
      out.push(
        `Grouping by tool runs ${op.name}, which cuts through the stock, before ${overtaken.map((o) => o.name).join(', ')}: the part may come loose before it is finished.`,
      );
    }
  });
  return out;
}

function runPost(
  post: string,
  job: PostJob,
  units: PostUnits,
  mode: MultiToolMode,
): CamResult<PostOutput> | null {
  switch (post) {
    case 'grbl':
      return postGrbl(job, { units, multiTool: mode === 'pause' ? 'pause' : 'files' });
    case 'grblhal':
      return postGrblHal(job, { units, multiTool: mode });
    case 'carbide-motion':
      return postCarbideMotion(job, { units });
    case 'linuxcnc':
      return postLinuxCnc(job, { units });
    case 'mach3':
      return postMach3(job, { units });
    default:
      return null;
  }
}

function depthOf(op: OperationInput): { stepdown: number | null } {
  switch (op.kind) {
    case 'facing':
    case 'profile':
    case 'pocket':
    case 'vcarveClearing':
      return { stepdown: op.stepdown };
    default:
      return { stepdown: null };
  }
}

const spanOf = (box: Box3): Vec3 => [
  box.max[0] - box.min[0],
  box.max[1] - box.min[1],
  box.max[2] - box.min[2],
];

/**
 * The export of a generation: every operation of the document's setup that is not suppressed
 * must have a generated toolpath (`exportReadiness` says which do not). Refuses, with every
 * reason, when an operation has an error, the job cannot be assembled, or the post refuses.
 */
export function buildExport(input: ExportInput): ExportBuild {
  const { data, settings, machine } = input;
  const setup: Setup = data.setup;
  const suppressed = new Set(input.operations.filter((o) => o.suppressed).map((o) => o.id));
  const docNames = new Map(input.operations.map((o) => [o.id, o.name]));
  // A V-carve's clearing (generated as an operation of its own) goes with its V-carve: suppressed
  // with it, cut just before it, named after it.
  for (const op of data.setup.operations) {
    const parent = documentOperation(op.id);
    if (parent === op.id) continue;
    if (suppressed.has(parent)) suppressed.add(op.id);
    const name = docNames.get(parent);
    if (name !== undefined) docNames.set(op.id, `${name} (clearing)`);
  }

  // Every active operation of the document must be in the generation, generated.
  const reasons: string[] = [];
  const inSetup = new Set(setup.operations.map((o) => o.id));
  for (const op of input.operations) {
    if (op.suppressed) continue;
    if (!inSetup.has(op.id)) reasons.push(`${op.name}: its geometry did not resolve.`);
  }
  // The document's list is the authority: an operation deleted since the generation is left
  // out, and the job cuts in the document's order (a reorder does not make a toolpath stale).
  const docOrder = new Map(input.operations.map((o, i) => [o.id, i]));
  for (const op of setup.operations) {
    const parent = docOrder.get(documentOperation(op.id));
    if (op.id !== documentOperation(op.id) && parent !== undefined)
      docOrder.set(op.id, parent - 0.5);
  }
  for (const op of setup.operations) if (!docOrder.has(op.id)) suppressed.add(op.id);
  const ops: JobOperation[] = jobOperations(setup, data.operations, suppressed).sort(
    (a, b) => (docOrder.get(a.id) ?? Infinity) - (docOrder.get(b.id) ?? Infinity),
  );
  for (const op of ops) {
    if (op.suppressed || op.result.ok) continue;
    reasons.push(`${docNames.get(op.id) ?? op.name ?? op.id}: ${op.result.error.message}`);
  }
  if (reasons.length > 0) return { ok: false, reasons };

  const assembled = assembleJob(setup, ops, {
    groupByTool: settings.groupByTool,
    rapidRate: data.rapidRate,
  });
  if (!assembled.ok) {
    const failures = assembled.error.failures.map(
      (f) => `${docNames.get(f.op) ?? f.op}: ${f.message}`,
    );
    return { ok: false, reasons: failures.length > 0 ? failures : [assembled.error.message] };
  }
  const job: Job = assembled.value;

  const modes = multiToolModes(settings.post);
  const multiTool = modes.includes(settings.multiTool) ? settings.multiTool : modes[0];
  if (multiTool === undefined) {
    return { ok: false, reasons: [`This version has no post ${settings.post}.`] };
  }
  const origin = { xy: setup.wcs.origin.xy, z: setup.wcs.origin.z };
  const dial = machineDial(machine);
  const postJob: PostJob = {
    toolpath: job.toolpath,
    job: input.jobName,
    setup: input.setupName,
    date: input.date,
    origin: originText(origin),
    ...(dial ? { spindleDial: dial } : {}),
    heights: { clearance: job.clearance, retract: job.retract },
  };
  const posted = runPost(settings.post, postJob, settings.units, multiTool);
  if (posted === null)
    return { ok: false, reasons: [`This version has no post ${settings.post}.`] };
  if (!posted.ok) {
    return {
      ok: false,
      reasons: [`The ${postName(settings.post)} post refuses the job: ${posted.error.message}`],
    };
  }
  const count = posted.value.files.length;
  const files: PostedFile[] = posted.value.files.map((f) => ({
    index: f.index,
    name: fileName(postFileStem(postJob, f, count), GCODE_FILE_EXTENSION),
    text: f.text,
    tools: f.tools,
  }));

  // Operations, in job order, with their own extents and times.
  const byId = new Map(ops.map((o) => [o.id, o]));
  const inputs = new Map(setup.operations.map((o) => [o.id, o]));
  const top = stockTopZ(setup);
  const stockSize = spanOf(setup.stock);
  const bottom = top - stockSize[2];
  const toolUse = new Map<string, string[]>();
  const toolOf = (t: Tool): ExportTool => ({
    id: t.id,
    ...(t.number !== undefined ? { number: t.number } : {}),
    name: t.name,
    kind: t.kind,
    diameter: t.diameter,
    flutes: t.flutes,
    operations: toolUse.get(t.id) ?? [],
  });
  const nameOf = (id: string) => docNames.get(id) ?? byId.get(id)?.name ?? id;
  for (const span of job.operations) {
    const list = toolUse.get(span.tool) ?? [];
    list.push(nameOf(span.op));
    toolUse.set(span.tool, list);
  }
  const tools = new Map<string, ExportTool>();
  for (const span of job.operations) {
    const op = byId.get(span.op)!;
    if (!tools.has(op.tool.id)) tools.set(op.tool.id, toolOf(op.tool));
  }
  const dialFor = (rpm: number) => (dial && dial.length > 0 ? dialComment(dial, rpm) : null);

  const operations: SheetOperation[] = job.operations.map((span) => {
    const op = byId.get(span.op)!;
    const own = op.result.ok ? op.result.toolpath : null;
    const feedBox = own ? toolpathBounds(own).feed : undefined;
    const stats = own ? statsOf(own, data.rapidRate) : null;
    const opInput = inputs.get(span.op)!;
    const zBottom = feedBox ? feedBox.min[2] : null;
    return {
      id: span.op,
      name: nameOf(span.op),
      kind: opInput.kind,
      tool: tools.get(op.tool.id)!,
      feeds: opInput.feeds,
      dial: dialFor(opInput.feeds.spindle),
      zTop: feedBox ? Math.min(feedBox.max[2], top) : null,
      zBottom,
      stepdown: depthOf(opInput).stepdown,
      through: zBottom !== null && zBottom <= bottom + THROUGH_EPS,
      minutes: stats ? stats.estimate.totalMinutes : null,
    };
  });

  // Every tool change, the first tool loaded included, and the file it happens in: with one file
  // per tool, change k starts file k.
  const toolChanges: ToolChangeStep[] = [];
  let current: string | null = null;
  for (const span of job.operations) {
    if (span.tool === current) continue;
    current = span.tool;
    const op = operations.find((o) => o.id === span.op)!;
    const index = toolChanges.length + 1;
    toolChanges.push({
      index,
      tool: tools.get(span.tool)!,
      operation: op.name,
      rpm: op.feeds.spindle,
      dial: op.dial,
      file: files.length === job.toolChanges.length ? index : 1,
    });
  }

  const warnings: string[] = [];
  for (const w of job.warnings) {
    warnings.push(w.op ? `${nameOf(w.op)}: ${w.message}` : w.message);
  }
  if (settings.groupByTool) {
    const userOrder = job.operations
      .map((s) => operations.find((o) => o.id === s.op)!)
      .sort((a, b) => docOrder.get(a.id)! - docOrder.get(b.id)!);
    warnings.push(...groupingWarnings(userOrder));
  }
  const { arcsAsLines } = posted.value.stats;
  if (arcsAsLines > 0) {
    warnings.push(
      `${postName(settings.post)}: ${arcsAsLines} ${arcsAsLines === 1 ? 'arc was' : 'arcs were'} written as straight lines (too small, or would fail the controller's arc check).`,
    );
  }
  if (multiTool === 'pause' && toolChanges.length > 1) {
    warnings.push(
      'Grbl does not jog while held by an M0, so re-zeroing Z at a pause needs a sender that allows it; one file per tool is the safer choice.',
    );
  }
  const extents = toolpathBounds(job.toolpath);
  const travel: Vec3 = [machine.travel.x.value, machine.travel.y.value, machine.travel.z.value];
  const span = spanOf(extents.all);
  const axes = (['X', 'Y', 'Z'] as const).filter((_, i) => span[i]! > travel[i]!);
  if (axes.length > 0) {
    warnings.push(
      `The program spans more than the ${machine.name}'s travel along ${axes.join(', ')}.`,
    );
  }

  const origin3 = wcsOrigin(setup);
  return {
    ok: true,
    plan: {
      settings,
      postName: postName(settings.post),
      multiTool,
      jobName: input.jobName,
      setupName: input.setupName,
      date: input.date,
      machine,
      files,
      tools: [...tools.values()],
      toolChanges,
      operations,
      stats: job.stats ?? null,
      extents,
      stock: {
        size: stockSize,
        ...(setup.stock.material ? { material: setup.stock.material } : {}),
        box: {
          min: [
            setup.stock.min[0] - origin3[0],
            setup.stock.min[1] - origin3[1],
            setup.stock.min[2] - origin3[2],
          ],
          max: [
            setup.stock.max[0] - origin3[0],
            setup.stock.max[1] - origin3[1],
            setup.stock.max[2] - origin3[2],
          ],
        },
      },
      origin: { ...origin, text: originText(origin) },
      heights: { clearance: job.clearance, retract: job.retract },
      warnings,
    },
  };
}

/** The WCS origin in the setup frame (the stock's corner or centre, its top or bottom). */
function wcsOrigin(setup: Setup): Vec3 {
  const { min, max } = setup.stock;
  const { xy, z } = setup.wcs.origin;
  const x = xy === 'centre' ? (min[0] + max[0]) / 2 : xy.endsWith('left') ? min[0] : max[0];
  const y = xy === 'centre' ? (min[1] + max[1]) / 2 : xy.startsWith('front') ? min[1] : max[1];
  return [x, y, z === 'top' ? max[2] : min[2]];
}

function statsOf(toolpath: Toolpath, rapidRate: number): ToolpathStats | null {
  const r = toolpathStats(toolpath, { rapidRate });
  return r.ok ? r.value : null;
}

// ---------------------------------------------------------------------------------------------
// Files.

export const GCODE_MIME = 'text/plain';
export const ZIP_MIME = 'application/zip';
export const HTML_MIME = 'text/html';

/**
 * What Save writes: the one G-code file, or for a job written as several files a zip of them
 * with the setup sheet, so they arrive together and in order.
 */
export function exportFiles(plan: ExportPlan, sheetHtml: string): ExportedFile[] {
  if (plan.files.length === 1) {
    const f = plan.files[0]!;
    return [{ name: f.name, bytes: strToU8(f.text), type: GCODE_MIME }];
  }
  const entries: Zippable = {};
  for (const f of plan.files) entries[f.name] = strToU8(f.text);
  entries[sheetFileName(plan)] = strToU8(sheetHtml);
  return [
    {
      name: fileName(`${plan.jobName} - ${plan.setupName}`, 'zip'),
      bytes: zipSync(entries, { level: 6 }),
      type: ZIP_MIME,
    },
  ];
}

/** The setup sheet's file name. */
export function sheetFileName(plan: Pick<ExportPlan, 'jobName' | 'setupName'>): string {
  return fileName(`${plan.jobName} - ${plan.setupName} - setup sheet`, 'html');
}

// ---------------------------------------------------------------------------------------------
// Numbers as the summary and the sheet write them.

const trimZeros = (s: string): string => {
  const t = s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  return t === '-0' ? '0' : t;
};

/** A length in the export's units: `12.5 mm`, `0.492 in`. */
export function formatLength(mm: number, units: PostUnits): string {
  return units === 'inch'
    ? `${trimZeros((mm / MM_PER_INCH).toFixed(3))} in`
    : `${trimZeros(mm.toFixed(2))} mm`;
}

/** A feed in the export's units: `1500 mm/min`, `59.1 in/min`. */
export function formatFeed(mmPerMin: number, units: PostUnits): string {
  return units === 'inch'
    ? `${trimZeros((mmPerMin / MM_PER_INCH).toFixed(1))} in/min`
    : `${Math.round(mmPerMin)} mm/min`;
}

/** A size as `60 x 40 x 12 mm`. */
export function formatSize(size: Vec3, units: PostUnits): string {
  const unit = units === 'inch' ? ' in' : ' mm';
  return size.map((v) => formatLength(v, units).replace(unit, '')).join(' x ') + unit;
}

/** A tool as `T201 #201 1/4" flat end mill`, or its name alone when it has no number. */
export function toolLabel(tool: Pick<ExportTool, 'number' | 'name'>): string {
  return tool.number !== undefined ? `T${tool.number} ${tool.name}` : tool.name;
}
