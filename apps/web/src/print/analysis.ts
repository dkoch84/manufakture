// Wall thickness and gaps of the active setup, from the print-analysis worker (ADR 0012 decision
// 5). One coarse call per setup: every body of copy 0 of every item, placed. The call is debounced
// on the main thread after a regen or an orientation change, and each call supersedes the one
// before (the client numbers them by generation and resolves superseded ones to null), so a quick
// series of edits runs one analysis. The worker starts on the first call: a document that never
// opens the print workspace never starts it.

import type { MeshData } from '@manufakture/kernel';
import type { PrintAnalysisBody, PrintThresholds } from '@manufakture/print';
import type { PrintAnalysisResult } from '@manufakture/print/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ThicknessReply } from './issues';
import { printViewId, type ResolvedSetup } from './resolve';

/** Wait this long after the last change before asking the worker (ms). */
export const ANALYSIS_DEBOUNCE_MS = 250;

/** What the workspace needs of `PrintAnalysisClient`. */
export interface PrintAnalyzer {
  analyze(
    bodies: PrintAnalysisBody[],
    thresholds: Pick<PrintThresholds, 'minFeature' | 'minWall' | 'minGap'>,
  ): Promise<PrintAnalysisResult | null>;
  cancel(): Promise<void>;
  terminate(): void;
}

/**
 * The latest analysis: its reply while a newer one runs (wall thickness does not change with the
 * orientation, so the list does not flicker), `running` while one is on its way.
 */
export interface AnalysisState {
  running: boolean;
  reply: ThicknessReply | null;
  /** Time spent in the worker for `reply`, ms. */
  ms: number | null;
  /** Why the last analysis failed (a malformed mesh), or null. */
  message: string | null;
}

export const IDLE_ANALYSIS: AnalysisState = {
  running: false,
  reply: null,
  ms: null,
  message: null,
};

export interface AnalysisRequest {
  /** Changes whenever the bodies, their placements or the thresholds do. */
  key: string;
  bodies: PrintAnalysisBody[];
  /** Per body, in order: the mesh object it was cut from, which the reply's values belong to. */
  meshes: MeshData[];
  thresholds: Pick<PrintThresholds, 'minFeature' | 'minWall' | 'minGap'>;
}

// Mesh identity as a number, for request keys.
const meshIds = new WeakMap<object, number>();
let nextMeshId = 1;
function meshId(mesh: object): number {
  let id = meshIds.get(mesh);
  if (id === undefined) meshIds.set(mesh, (id = nextMeshId++));
  return id;
}

/** Only what the ray casting reads, so the copy into the worker stays small. */
function analysisMesh(mesh: MeshData): PrintAnalysisBody['mesh'] {
  return {
    positions: mesh.positions,
    normals: mesh.normals,
    indices: mesh.indices,
    triangleFaces: mesh.triangleFaces,
  };
}

/** The analysis a resolved setup asks for; null when there is nothing to check. */
export function analysisRequest(resolved: ResolvedSetup | null): AnalysisRequest | null {
  if (!resolved?.printer) return null;
  const bodies: PrintAnalysisBody[] = [];
  const meshes: MeshData[] = [];
  const key: (string | number)[] = [];
  for (const item of resolved.items) {
    const copy = item.copies[0];
    if (!copy) continue;
    for (const b of item.bodies) {
      const id = printViewId(item.item.id, copy.copy, b.sourceId);
      bodies.push({ id, mesh: analysisMesh(b.input.mesh), placement: copy.placement });
      meshes.push(b.input.mesh);
      key.push(id, meshId(b.input.mesh), ...copy.placement.rotation, ...copy.placement.translation);
    }
  }
  if (bodies.length === 0) return null;
  const { minFeature, minWall, minGap } = resolved.thresholds;
  key.push(minFeature, minWall, minGap);
  return { key: key.join('|'), bodies, meshes, thresholds: { minFeature, minWall, minGap } };
}

/**
 * Run the analysis for `request` (debounced, superseding), and keep the latest reply. A request
 * with the same key as the one before changes nothing.
 */
export function useThicknessAnalysis(
  analyzer: PrintAnalyzer | null,
  request: AnalysisRequest | null,
  debounceMs = ANALYSIS_DEBOUNCE_MS,
): AnalysisState {
  // The last analysis that finished, with the key it was for: running is "the current key has no
  // result yet", so an unrelated edit (same key) starts nothing and changes nothing.
  const [finished, setFinished] = useState<(AnalysisState & { key: string }) | null>(null);
  const key = analyzer && request ? request.key : null;
  const requestRef = useRef(request);
  useEffect(() => {
    requestRef.current = request;
  }, [request]);

  useEffect(() => {
    const asked = requestRef.current;
    if (!analyzer || key === null || !asked) return;
    let live = true;
    const timer = setTimeout(() => {
      analyzer.analyze(asked.bodies, asked.thresholds).then(
        (reply) => {
          if (!live || reply === null) return;
          setFinished(
            reply.status === 'done'
              ? {
                  key,
                  running: false,
                  reply: { bodies: reply.bodies, issues: reply.issues, meshes: asked.meshes },
                  ms: reply.ms,
                  message: null,
                }
              : { key, running: false, reply: null, ms: null, message: reply.message },
          );
        },
        (e: unknown) => {
          if (!live) return;
          const message = e instanceof Error ? e.message : String(e);
          setFinished({ key, running: false, reply: null, ms: null, message });
        },
      );
    }, debounceMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [analyzer, key, debounceMs]);

  return useMemo(() => {
    if (key === null) return IDLE_ANALYSIS;
    const running = finished?.key !== key;
    if (!finished) return { ...IDLE_ANALYSIS, running };
    return {
      running,
      reply: finished.reply,
      ms: finished.ms,
      message: running ? null : finished.message,
    };
  }, [key, finished]);
}

/**
 * Per drawn body id, the per-triangle thickness to shade with; copies share copy 0's values. A
 * body gets values only when the reply was computed for the mesh it draws now (the same mesh
 * object, not just the same view id or triangle count): after an edit, or when the export mesh
 * replaces the coarse one, it has none, and shades as unknown until the new reply arrives.
 */
export function thicknessValues(
  resolved: ResolvedSetup | null,
  state: AnalysisState,
): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  if (!resolved || !state.reply) return out;
  const reply = state.reply;
  const byId = new Map(reply.bodies.map((b, i) => [b.id, i] as const));
  for (const item of resolved.items) {
    const first = item.copies[0];
    if (!first) continue;
    for (const b of item.bodies) {
      const index = byId.get(printViewId(item.item.id, first.copy, b.sourceId));
      if (index === undefined || reply.meshes[index] !== b.input.mesh) continue;
      const values = reply.bodies[index]!.thickness;
      for (const copy of item.copies)
        out.set(printViewId(item.item.id, copy.copy, b.sourceId), values);
    }
  }
  return out;
}
