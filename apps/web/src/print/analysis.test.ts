// The print-analysis worker from the workspace: one request per setup state, debounced,
// superseded, and its per-triangle thickness spread over the drawn copies.

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrintAnalysisResult } from '@manufakture/print/client';
import {
  ANALYSIS_DEBOUNCE_MS,
  analysisRequest,
  thicknessValues,
  useThicknessAnalysis,
  type AnalysisRequest,
  type PrintAnalyzer,
} from './analysis';
import { editSetupCommand } from './commands';
import { overhangsOf, printIssues } from './issues';
import { resolveSetup } from './resolve';
import { apply, boxPart, partsDocument, setupOf, withSetup } from './print.test-fixture';

function setup(copies = 1) {
  const { doc, setupId } = withSetup(partsDocument(), [
    { part: 'part#1', edit: (item) => (copies > 1 ? { ...item, copies } : item) },
  ]);
  const model = [boxPart('part#1', [{ bodyId: 'extrude#1' }])];
  return { doc, setupId, model, resolved: resolveSetup(doc, setupOf(doc, setupId), model) };
}

function done(id: string, values: number[]): Extract<PrintAnalysisResult, { status: 'done' }> {
  return {
    status: 'done',
    generation: 1,
    bodies: [
      {
        id,
        thickness: new Float32Array(values),
        gap: new Float32Array(values.length),
        flags: new Uint8Array(values.length),
        faces: [],
        samples: values.length,
      },
    ],
    issues: [],
    ms: 3,
  };
}

describe('analysisRequest', () => {
  it('sends copy 0 of every item, placed, with the thresholds, keyed by what it depends on', () => {
    const { doc, setupId, model, resolved } = setup(3);
    const r = analysisRequest(resolved)!;
    expect(r.bodies.map((b) => b.id)).toEqual(['print:item#1:0:part#1/extrude#1']);
    expect(r.bodies[0]!.placement).toBe(resolved.items[0]!.copies[0]!.placement);
    expect(Object.keys(r.bodies[0]!.mesh).sort()).toEqual([
      'indices',
      'normals',
      'positions',
      'triangleFaces',
    ]);
    expect(r.thresholds).toEqual({ minFeature: 0.1, minWall: 0.84, minGap: 0.2 });
    // The same state gives the same key; another wall threshold another one.
    expect(analysisRequest(resolveSetup(doc, setupOf(doc, setupId), model))!.key).toBe(r.key);
    const thicker = apply(
      doc,
      editSetupCommand(setupId, {
        thresholds: { minWall: { source: '2', lengthUnit: 'mm', angleUnit: 'deg' } },
      }),
    );
    expect(analysisRequest(resolveSetup(thicker, setupOf(thicker, setupId), model))!.key).not.toBe(
      r.key,
    );
  });

  it('asks nothing without items or on an unknown printer', () => {
    const empty = withSetup(partsDocument(), []);
    expect(
      analysisRequest(resolveSetup(empty.doc, setupOf(empty.doc, empty.setupId), [])),
    ).toBeNull();
    expect(analysisRequest(null)).toBeNull();
    const { doc, setupId, model } = setup();
    const unknown = apply(doc, editSetupCommand(setupId, { printer: 'acme-9000' }));
    expect(analysisRequest(resolveSetup(unknown, setupOf(unknown, setupId), model))).toBeNull();
  });
});

describe('thicknessValues', () => {
  const replyFor = (id: string, values: number[], meshes: readonly object[]) => {
    const r = done(id, values);
    return {
      running: false,
      reply: { bodies: r.bodies, issues: r.issues, meshes },
      ms: 1,
      message: null,
    };
  };

  it('gives every copy the values of copy 0', () => {
    const { resolved } = setup(2);
    const mesh = resolved.items[0]!.bodies[0]!.input.mesh;
    const values = thicknessValues(
      resolved,
      replyFor('print:item#1:0:part#1/extrude#1', [1, 2], [mesh]),
    );
    expect([...values.keys()]).toEqual([
      'print:item#1:0:part#1/extrude#1',
      'print:item#1:1:part#1/extrude#1',
    ]);
    expect(values.get('print:item#1:1:part#1/extrude#1')).toEqual(new Float32Array([1, 2]));
  });

  it('drops values computed for another mesh under the same view id', () => {
    const { doc, setupId, model, resolved } = setup();
    const id = 'print:item#1:0:part#1/extrude#1';
    const coarse = resolved.items[0]!.bodies[0]!.input.mesh;
    const state = replyFor(id, [1, 2], [coarse]);
    expect(thicknessValues(resolved, state).has(id)).toBe(true);
    // The export mesh replaces the coarse one: same view id, same triangle count, other mesh.
    const fine = { ...coarse };
    const finer = resolveSetup(doc, setupOf(doc, setupId), model, {
      meshOf: (v) => ({ ...v, mesh: fine }),
    });
    expect(finer.items[0]!.copies[0]!.copy).toBe(0);
    expect(thicknessValues(finer, state).size).toBe(0);
    // And the issues from that reply are not listed against the new mesh either.
    const issues = printIssues(
      finer,
      overhangsOf(finer),
      {
        ...state.reply,
        issues: [{ kind: 'thinWall', body: 0, face: 1, value: 0.5, area: 1 }],
      },
      doc.units,
    );
    expect(issues.map((i) => i.kind)).not.toContain('thinWall');
    // A reply for the new mesh is used again.
    expect(thicknessValues(finer, replyFor(id, [3], [fine])).get(id)).toEqual(
      new Float32Array([3]),
    );
  });

  it('records with each request the mesh objects the reply belongs to', async () => {
    vi.useFakeTimers();
    try {
      const { resolved } = setup();
      const request = analysisRequest(resolved)!;
      expect(request.meshes).toEqual([resolved.items[0]!.bodies[0]!.input.mesh]);
      expect(request.meshes[0]).toBe(resolved.items[0]!.bodies[0]!.input.mesh);
      const a: PrintAnalyzer = {
        analyze: vi.fn(async () => done(request.bodies[0]!.id, [7])),
        cancel: vi.fn(async () => undefined),
        terminate: vi.fn(),
      };
      const { result } = renderHook(() => useThicknessAnalysis(a, request));
      await act(async () => vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS));
      expect(result.current.reply?.meshes[0]).toBe(request.meshes[0]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useThicknessAnalysis', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function analyzer() {
    const calls: { resolve: (r: PrintAnalysisResult | null) => void }[] = [];
    const a: PrintAnalyzer = {
      analyze: vi.fn(
        () =>
          new Promise<PrintAnalysisResult | null>((resolve) => {
            calls.push({ resolve });
          }),
      ),
      cancel: vi.fn(async () => undefined),
      terminate: vi.fn(),
    };
    return { a, calls };
  }

  it('waits for the edits to stop, runs once, and keeps the reply while the next one runs', async () => {
    const { resolved } = setup();
    const request = analysisRequest(resolved)!;
    const { a, calls } = analyzer();
    const { result, rerender } = renderHook(
      ({ r }: { r: AnalysisRequest | null }) => useThicknessAnalysis(a, r),
      { initialProps: { r: request } },
    );
    expect(result.current.running).toBe(true);
    // An unrelated change (a new request object with the same key) starts nothing new.
    rerender({ r: { ...request } });
    act(() => vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS - 1));
    expect(a.analyze).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(a.analyze).toHaveBeenCalledTimes(1);
    await act(async () => calls[0]!.resolve(done(request.bodies[0]!.id, [5])));
    expect(result.current).toMatchObject({ running: false, ms: 3, message: null });
    expect(result.current.reply?.bodies[0]!.thickness).toEqual(new Float32Array([5]));

    // A new state: running again, the old reply kept meanwhile.
    rerender({ r: { ...request, key: `${request.key}+` } });
    expect(result.current.running).toBe(true);
    expect(result.current.reply).not.toBeNull();
    act(() => vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS));
    // A failure is said, and the reply before it is dropped.
    await act(async () =>
      calls[1]!.resolve({ status: 'failed', generation: 2, message: 'bad mesh' }),
    );
    expect(result.current).toMatchObject({ running: false, reply: null, message: 'bad mesh' });
  });

  it('is idle without a request or an analyzer, and drops a reply that arrives too late', async () => {
    const { resolved } = setup();
    const request = analysisRequest(resolved)!;
    const { a, calls } = analyzer();
    const { result, rerender } = renderHook(
      ({ r }: { r: AnalysisRequest | null }) => useThicknessAnalysis(a, r),
      { initialProps: { r: request as AnalysisRequest | null } },
    );
    act(() => vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS));
    rerender({ r: null });
    expect(result.current).toEqual({ running: false, reply: null, ms: null, message: null });
    await act(async () => calls[0]!.resolve(done(request.bodies[0]!.id, [5])));
    expect(result.current.reply).toBeNull();
    const none = renderHook(() => useThicknessAnalysis(null, request));
    expect(none.result.current.running).toBe(false);
  });
});
