// What the preview plays (M5 plan, T5.3b): the last generation's toolpaths, as the CAM worker
// returned them (packed, buffers transferred; nothing is generated again here), linked into the
// job the posts would write (`assembleJob`), with statistics per operation and for the job.
//
// Operations that failed, were not generated or are suppressed are left out of the preview's job
// so the rest still shows. When the job cannot be assembled even so (an operation starts below
// the stock top, say), the operations' own toolpaths are played one after another, joined by
// straight rapids, and the reason is reported.

import {
  JOB_LINK_OP,
  assembleJob,
  jobOperations,
  toolpathStats,
  type CamOperationResult,
  type IrEntry,
  type Setup,
  type Tool,
  type Toolpath,
  type ToolpathStats,
} from '@manufakture/cam';
import { documentOperation } from '../generate';

/** One generation of a setup, kept for the preview. */
export interface GeneratedToolpaths {
  /** The setup id. */
  readonly setupId: string;
  /** The evaluated setup the toolpaths were generated for (stock, WCS frame, operations). */
  readonly setup: Setup;
  /** The machine's rapid rate, mm/min, for the time estimates. */
  readonly rapidRate: number;
  /** The CAM worker's results, in the setup's order; toolpaths packed. */
  readonly operations: readonly CamOperationResult[];
}

/** One operation's line in the statistics. */
export interface PreviewOperation {
  readonly id: string;
  readonly name: string;
  readonly tool: Tool;
  /** In the job (generated, not suppressed). */
  readonly included: boolean;
  /** Its own toolpath's statistics, when it was generated. */
  readonly stats: ToolpathStats | null;
}

export interface PreviewJob {
  /** The program played: the linked job, or the operations in a row (see `message`). */
  readonly toolpath: Toolpath;
  readonly operations: readonly PreviewOperation[];
  /** The whole program's statistics, links included. */
  readonly stats: ToolpathStats | null;
  /** Why the program is not the linked job, or null when it is. */
  readonly message: string | null;
  /** Tools by id, for the tool marker. */
  readonly tools: ReadonlyMap<string, Tool>;
}

function statsOf(toolpath: Toolpath, rapidRate: number): ToolpathStats | null {
  const r = toolpathStats(toolpath, { rapidRate });
  return r.ok ? r.value : null;
}

/**
 * The preview's program and statistics from a generation; `suppressed` ids are left out (with a
 * V-carve, its clearing).
 */
export function previewJob(
  data: GeneratedToolpaths,
  suppressed: ReadonlySet<string> = new Set(),
): PreviewJob {
  const results = new Map(data.operations.map((r) => [r.id, r]));
  // A V-carve's clearing goes with its V-carve (`documentOperation`).
  const leftOut = data.setup.operations
    .filter((o) => suppressed.has(documentOperation(o.id)) || !results.get(o.id)?.ok)
    .map((o) => o.id);
  const jobOps = jobOperations(data.setup, data.operations, leftOut);
  const tools = new Map(data.setup.operations.map((o) => [o.tool.id, o.tool]));
  const operations: PreviewOperation[] = jobOps.map((op) => ({
    id: op.id,
    name: op.name ?? op.id,
    tool: op.tool,
    included: !op.suppressed,
    stats: op.result.ok ? statsOf(op.result.toolpath, data.rapidRate) : null,
  }));
  const included = jobOps.filter((o) => !o.suppressed);
  if (included.length === 0) {
    return {
      toolpath: { start: [0, 0, 0], entries: [] },
      operations,
      stats: null,
      message: 'No generated operation to show.',
      tools,
    };
  }
  const job = assembleJob(data.setup, jobOps, { rapidRate: data.rapidRate });
  if (job.ok) {
    return {
      toolpath: job.value.toolpath,
      operations,
      stats: job.value.stats ?? statsOf(job.value.toolpath, data.rapidRate),
      message: null,
      tools,
    };
  }
  // The operations one after another, each after its tool change, joined by rapids.
  const entries: IrEntry[] = [];
  let start: Toolpath['start'] | null = null;
  let tool: string | null = null;
  for (const op of included) {
    if (!op.result.ok) continue;
    const tp = op.result.toolpath;
    if (start === null) start = tp.start;
    else entries.push({ kind: 'rapid', op: JOB_LINK_OP, pass: 0, to: tp.start });
    if (op.tool.id !== tool) {
      tool = op.tool.id;
      entries.push({ kind: 'toolChange', tool: op.tool.id, name: op.tool.name, op: op.id });
    }
    for (const e of tp.entries) entries.push(e);
  }
  const toolpath: Toolpath = { start: start ?? [0, 0, 0], entries };
  return {
    toolpath,
    operations,
    stats: statsOf(toolpath, data.rapidRate),
    message: `Shown unlinked: ${job.error.message}`,
    tools,
  };
}
