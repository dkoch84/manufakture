// The Comlink-facing API of the print-analysis worker (ADR 0012 decision 5, ADR 0007 as amended
// by T3.1c): one coarse call per setup, `analyze`, which runs the thickness and gap rays on the
// setup's oriented meshes and returns per-triangle values and issues as transferred arrays. It has
// no dependency on a real worker, so tests expose it on a MessageChannel.
//
// Cancellation by generation (ADR 0007 decision 4): every request carries a `generation`, and a
// newer request supersedes every older one. The analysis runs in chunks and yields to the event
// loop between them, so a newer request (or `cancel`) arriving meanwhile is seen and the stale
// one returns `cancelled`. Expected failures (a malformed mesh) come back as `failed` values,
// never as exceptions through Comlink.

import * as Comlink from 'comlink';
import {
  ThicknessJob,
  type BodyThickness,
  type ThicknessBody,
  type ThicknessIssue,
  type ThicknessOptions,
} from './thickness';
import type { PrintThresholds } from './thresholds';

/** One body of a setup, as the main thread has it: copied into the worker, not transferred. */
export interface PrintAnalysisBody extends ThicknessBody {
  /** The caller's id for the body (`part/body`, say); echoed in the reply. */
  id: string;
}

export interface PrintAnalysisRequest {
  generation: number;
  bodies: PrintAnalysisBody[];
  thresholds: Pick<PrintThresholds, 'minFeature' | 'minWall' | 'minGap'>;
  /** Range, sample spacing and split; defaults as in `analyzeThickness`. */
  options?: Omit<ThicknessOptions, 'thresholds'>;
}

export interface PrintAnalysisBodyResult extends BodyThickness {
  id: string;
}

export type PrintAnalysisReply =
  | {
      status: 'done';
      generation: number;
      /** In request order; the per-triangle arrays are transferred. */
      bodies: PrintAnalysisBodyResult[];
      /** `body` is the index in `bodies`. */
      issues: ThicknessIssue[];
      /** Time spent in the worker, ms. */
      ms: number;
    }
  | { status: 'cancelled'; generation: number }
  | { status: 'failed'; generation: number; message: string };

export interface PrintWorkerApi {
  /**
   * Thickness and gaps of a setup's bodies at `generation`. Supersedes every older request still
   * running; resolves `cancelled` when a newer request or `cancel` superseded it.
   */
  analyze(request: PrintAnalysisRequest): Promise<PrintAnalysisReply>;
  /**
   * Cancel running analyses: every one with a generation up to `generation`, or all of them
   * without one.
   */
  cancel(generation?: number): Promise<void>;
}

export interface PrintWorkerApiOptions {
  /** Triangles per step between checks of the clock; default 1024. */
  chunk?: number;
  /** Longest run between two yields to the event loop, ms; default 8. */
  slice?: number;
  /** How to yield; default `createYield()`, a macrotask that lets other messages and timers run. */
  yieldNow?: () => Promise<void>;
}

/** The parts of a Node `MessagePort` that a browser port lacks. */
interface RefPort {
  ref?: () => void;
  unref?: () => void;
}

/**
 * A yield to the event loop that runs as a real macrotask, so a request or `cancel` arriving on
 * another port gets a chance to run before the analysis goes on. The order is React's
 * scheduler's: `setImmediate` where it exists (Node), then a message posted to a private
 * `MessageChannel` (browsers), then `setTimeout(r, 0)`. Node gets `setImmediate` because a woken
 * Node `MessagePort` drains up to 1000 messages in one go, including ones posted meanwhile, so a
 * chain of yields on a channel would starve other ports and timers for about 1000 yields; an
 * immediate runs once per turn of the loop, after the poll phase that delivers port messages. In
 * browsers a posted message is not clamped, while nested timers are clamped to at least 4 ms,
 * which would idle a worker about 4 ms for every 8 ms slice of work. Neither promises strict
 * ordering against messages on other ports: a newer request or `cancel` is seen within about one
 * slice.
 */
export function createYield(): () => Promise<void> {
  // Read off globalThis so the file also typechecks without Node's types (the web app's config).
  const immediate = (globalThis as { setImmediate?: (callback: () => void) => unknown })
    .setImmediate;
  if (typeof immediate === 'function') {
    return () => new Promise<void>((r) => immediate(r));
  }
  if (typeof MessageChannel === 'undefined') {
    return () => new Promise<void>((r) => setTimeout(r, 0));
  }
  let channel: MessageChannel | undefined;
  const waiting: Array<() => void> = [];
  return () =>
    new Promise<void>((resolve) => {
      if (!channel) {
        channel = new MessageChannel();
        const port = channel.port1;
        port.onmessage = () => {
          waiting.shift()?.();
          // In Node an open port with a listener keeps the process alive; hold it only while a
          // yield is pending.
          if (waiting.length === 0) (port as unknown as RefPort).unref?.();
        };
      }
      waiting.push(resolve);
      (channel.port1 as unknown as RefPort).ref?.();
      channel.port2.postMessage(null);
    });
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** The transferable buffers of a reply. */
export function replyTransferables(reply: PrintAnalysisReply): ArrayBuffer[] {
  if (reply.status !== 'done') return [];
  const out: ArrayBuffer[] = [];
  for (const b of reply.bodies) {
    for (const a of [b.thickness, b.gap, b.flags]) out.push(a.buffer as ArrayBuffer);
  }
  return out;
}

/** Build the API object; `worker.ts` passes it to `Comlink.expose`. */
export function createPrintWorkerApi(options: PrintWorkerApiOptions = {}): PrintWorkerApi {
  const chunk = options.chunk ?? 1024;
  const slice = options.slice ?? 8;
  const yieldNow = options.yieldNow ?? createYield();
  /** The newest generation seen; anything older is stale. */
  let latest = -Infinity;
  /** Analyses with a generation up to this one were cancelled. */
  let cancelledUpTo = -Infinity;

  const stale = (generation: number) => generation < latest || generation <= cancelledUpTo;

  return {
    async analyze(request) {
      const { generation } = request;
      if (generation > latest) latest = generation;
      if (stale(generation)) return { status: 'cancelled', generation };
      const started = now();
      let job: ThicknessJob;
      try {
        job = new ThicknessJob(request.bodies, {
          ...request.options,
          thresholds: request.thresholds,
        });
      } catch (error) {
        return { status: 'failed', generation, message: (error as Error).message };
      }
      let sliceStart = now();
      while (!job.step(chunk)) {
        if (now() - sliceStart >= slice) {
          await yieldNow();
          sliceStart = now();
          if (stale(generation)) return { status: 'cancelled', generation };
        }
      }
      // A request that arrived during the last slice still wins.
      await yieldNow();
      if (stale(generation)) return { status: 'cancelled', generation };
      const result = job.result();
      const reply: PrintAnalysisReply = {
        status: 'done',
        generation,
        bodies: result.bodies.map((b, i) => ({ ...b, id: request.bodies[i]!.id })),
        issues: result.issues,
        ms: now() - started,
      };
      return Comlink.transfer(reply, replyTransferables(reply));
    },
    async cancel(generation) {
      cancelledUpTo = Math.max(cancelledUpTo, generation ?? latest);
    },
  };
}
