import type { BuildName } from '../loaders.ts';
import type { ScenarioReport, ScenarioTimings } from '../scenario.ts';

export type CandidateName =
  'own-libcascade' | 'replicad' | 'replicad-libcascade' | 'occt-wasm' | 'brepjs';

export interface RunOptions {
  /** Mesh both parts and copy the meshes out (skipped where the build cannot). */
  mesh: boolean;
  /** Use the history-returning variants of fillet and cut, where they exist. */
  history: boolean;
  /** Mesh at the fine setting (0.01 mm, 0.1 rad) instead of the normal one. */
  fine?: boolean;
}

/**
 * What an operation's history accounts for, normalised across candidates so
 * index-based (own wrapper) and hash-based (occt-wasm, brepjs) history compare.
 */
export interface HistorySummary {
  /** Faces over all operands. */
  inputFaces: number;
  /** Input faces reported as modified into one or more result faces. */
  modifiedFaces: number;
  /** Input faces reported as deleted. */
  deletedFaces: number;
  /** Input faces present unchanged in the result. */
  keptFaces: number;
  /** Input sub-shapes (by kind) that generated result faces. */
  generatedFrom: { face: number; edge: number; vertex: number };
  resultFaces: number;
  /** Result faces that some input maps to (modified, generated or kept). */
  tracedResultFaces: number;
}

export interface RunResult {
  report: ScenarioReport;
  timings: ScenarioTimings;
  history: { fillet: HistorySummary; cut: HistorySummary } | null;
}

export interface Candidate {
  name: CandidateName;
  build: BuildName;
  /** Whether this candidate can mesh (replicad on libcascade cannot). */
  canMesh: boolean;
  /** Whether history is reachable through the candidate's own API. */
  historyApi: 'full' | 'faces-by-hash' | 'none';
  run(options: RunOptions): RunResult;
  /**
   * Per-call overhead probe: n times make a 10 mm cube, query its volume and
   * release it. Returns the summed volume so the work cannot be skipped.
   */
  boxLoop(n: number): number;
  /** Linear memory size in bytes. */
  heapBytes(): number;
  /** Bytes in use (allocator probe); disturbs the allocator, call last. */
  usedHeapBytes(): number;
  /** Shapes or handles the wrapper still tracks, where it can say. */
  liveHandles(): number | null;
}

/** Summarise hash-keyed history: maps from an input face hash to result hashes. */
export function summariseHashHistory(
  inputHashes: number[],
  resultHashes: number[],
  modified: ReadonlyMap<number, readonly number[]>,
  generated: ReadonlyMap<number, readonly number[]>,
  deleted: ReadonlySet<number>,
): HistorySummary {
  const result = new Set(resultHashes);
  const traced = new Set<number>();
  let modifiedFaces = 0;
  let generatedFaces = 0;
  let keptFaces = 0;
  let deletedFaces = 0;
  for (const h of new Set(inputHashes)) {
    const m = (modified.get(h) ?? []).filter((x) => result.has(x));
    const g = (generated.get(h) ?? []).filter((x) => result.has(x));
    if (m.length) modifiedFaces++;
    if (g.length) generatedFaces++;
    if (deleted.has(h)) deletedFaces++;
    if (result.has(h)) {
      keptFaces++;
      traced.add(h);
    }
    for (const x of [...m, ...g]) traced.add(x);
  }
  return {
    inputFaces: new Set(inputHashes).size,
    modifiedFaces,
    deletedFaces,
    keptFaces,
    generatedFrom: { face: generatedFaces, edge: 0, vertex: 0 },
    resultFaces: result.size,
    tracedResultFaces: traced.size,
  };
}

/** Parse occt-wasm's flat [inputHash, count, output...] vectors into a map. */
export function parseFlatHistory(raw: ArrayLike<number>): Map<number, number[]> {
  const map = new Map<number, number[]>();
  let i = 0;
  while (i + 1 < raw.length) {
    const input = raw[i]!;
    const count = raw[i + 1]!;
    i += 2;
    const outputs: number[] = [];
    for (let j = 0; j < count && i < raw.length; j++, i++) outputs.push(raw[i]!);
    map.set(input, outputs);
  }
  return map;
}

export function elapsed(t: number): number {
  return performance.now() - t;
}
