import { act, fireEvent, render, screen } from '@testing-library/react';
import type { MeshData } from '@manufakture/kernel';
import type { InstanceInterference, InterferenceReport } from '@manufakture/regen';
import { describe, expect, it, vi } from 'vitest';
import { createDocumentStore } from '../state/document';
import { boxBody } from '../viewport/testMeshes';
import { assemblyBodies, type Assembler } from './assembly';
import { A, model, result, twoInstances } from './assembly.test-fixture';
import {
  finishedView,
  instanceFaces,
  interferenceRows,
  interferenceSummary,
  overlapSegments,
  pairKey,
  startedView,
} from './interference';
import { InterferencePanel } from './InterferencePanel';
import { createAssemblyUiStore } from './state';

const overlap: MeshData = boxBody({ id: 'overlap', size: [10, 5, 2] }).mesh;

function pair(volume: number, mesh: MeshData | null = null): InstanceInterference {
  return { a: 'inst#1', b: 'inst#2', volume, mesh };
}

function report(extra: Partial<InterferenceReport> = {}): InterferenceReport {
  return {
    generation: 3,
    assemblyId: A,
    instances: ['inst#1', 'inst#2'],
    pairs: [],
    candidates: 0,
    booleans: 0,
    failures: [],
    status: 'done',
    ms: 1,
    ...extra,
  };
}

/** An assembler whose check the test finishes by hand. */
function controlled() {
  let finish!: (r: InterferenceReport | null) => void;
  let send!: (p: InstanceInterference) => void;
  const interference = vi.fn(
    (_assemblyId: string, onPair: (p: InstanceInterference) => void) =>
      new Promise<InterferenceReport | null>((resolve) => {
        finish = resolve;
        send = onPair;
      }),
  );
  const cancelInterference = vi.fn<(assemblyId: string) => void>();
  const assembler: Assembler = {
    solve: vi.fn(),
    drag: vi.fn(),
    interference,
    cancelInterference,
  };
  return {
    assembler,
    interference,
    cancelInterference,
    send: (p: InstanceInterference) => act(() => send(p)),
    finish: async (r: InterferenceReport | null) => {
      await act(async () => finish(r));
    },
  };
}

function setup(assembler: Assembler | undefined) {
  const documents = createDocumentStore(twoInstances());
  const ui = createAssemblyUiStore();
  ui.getState().open({ kind: 'interference' });
  const onClose = vi.fn();
  const current = result();
  const view = render(
    <InterferencePanel
      documents={documents}
      assemblyId={A}
      assemblyUi={ui}
      assembler={assembler}
      result={current}
      onClose={onClose}
    />,
  );
  return { ui, onClose, view, documents, current };
}

describe('the Interference panel', () => {
  it('lists pairs as they arrive, then the report; a click highlights a pair', async () => {
    const c = controlled();
    const { ui } = setup(c.assembler);
    expect(screen.getByTestId('interference-status').textContent).toContain(
      'Check which instances overlap',
    );
    fireEvent.click(screen.getByTestId('interference-check'));
    expect(c.interference).toHaveBeenCalledWith(A, expect.any(Function));
    expect(screen.getByTestId('interference-status').textContent).toContain('Checking...');
    // Checking: the button stops it instead.
    expect(screen.queryByTestId('interference-check')).toBeNull();

    c.send(pair(1500, overlap));
    expect(screen.getByTestId('interference-status').textContent).toContain(
      'Checking... 1 pair overlaps so far.',
    );
    const row = screen.getByTestId('interference-pair-inst#1/inst#2');
    expect(row.textContent).toContain('Box 1 and Lid 1');
    expect(row.textContent).toContain('1500.00 mm³');
    expect(row.getAttribute('data-volume')).toBe('1500');

    await c.finish(report({ pairs: [pair(1500)], candidates: 1, booleans: 1 }));
    expect(screen.getByTestId('interference-status').textContent).toContain('1 pair overlaps.');
    expect(screen.getByTestId('interference-status').getAttribute('data-status')).toBe('done');
    // The streamed pair (with its mesh) is kept, not the report's copy.
    expect(ui.getState().interference!.pairs[0]!.mesh).toBe(overlap);

    fireEvent.click(row);
    expect(ui.getState().highlight).toBe('inst#1/inst#2');
    expect(row.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(row);
    expect(ui.getState().highlight).toBeNull();
  });

  it('says when nothing overlaps, and when the assembly changed since', async () => {
    const c = controlled();
    const { view, documents, ui, current } = setup(c.assembler);
    fireEvent.click(screen.getByTestId('interference-check'));
    await c.finish(report());
    const status = screen.getByTestId('interference-status');
    expect(status.textContent).toContain('No interference between the 2 instances.');
    expect(status.getAttribute('data-changed')).toBe('false');
    expect(screen.queryByTestId('interference-list')).toBeNull();
    // A regen gave the assembly a new result.
    view.rerender(
      <InterferencePanel
        documents={documents}
        assemblyId={A}
        assemblyUi={ui}
        assembler={c.assembler}
        result={{ ...current }}
        onClose={() => undefined}
      />,
    );
    expect(status.getAttribute('data-changed')).toBe('true');
    expect(status.textContent).toContain('The assembly changed since: check again.');
    expect(screen.getByTestId('interference-check').textContent).toContain('Check again');
  });

  it('stops a check, and stops it when the panel goes', async () => {
    const c = controlled();
    const { ui, view } = setup(c.assembler);
    fireEvent.click(screen.getByTestId('interference-check'));
    fireEvent.click(screen.getByTestId('interference-stop'));
    expect(c.cancelInterference).toHaveBeenCalledWith(A);
    await c.finish(report({ status: 'cancelled', candidates: 2 }));
    expect(screen.getByTestId('interference-status').textContent).toContain(
      'Stopped: no pair overlaps so far.',
    );

    fireEvent.click(screen.getByTestId('interference-check'));
    c.cancelInterference.mockClear();
    act(() => ui.getState().close());
    view.unmount();
    expect(c.cancelInterference).toHaveBeenCalledWith(A);
  });

  it('drops pairs of a check that was replaced; a superseded check asks for another', async () => {
    const c = controlled();
    const { ui } = setup(c.assembler);
    fireEvent.click(screen.getByTestId('interference-check'));
    const firstRun = ui.getState().interference!.run;
    await c.finish(null);
    expect(screen.getByTestId('interference-status').textContent).toContain(
      'The assembly changed while it was checked: check again.',
    );
    fireEvent.click(screen.getByTestId('interference-check'));
    expect(ui.getState().interference!.run).toBeGreaterThan(firstRun);
    ui.getState().updateInterference(firstRun, (v) => ({ ...v, pairs: [pair(1)] }));
    expect(ui.getState().interference!.pairs).toEqual([]);
  });

  it('reports a failed check, and cannot check without a kernel', async () => {
    const failing: Assembler = {
      solve: vi.fn(),
      drag: vi.fn(),
      interference: vi.fn(async () => {
        throw new Error('worker gone');
      }),
    };
    setup(failing);
    fireEvent.click(screen.getByTestId('interference-check'));
    await act(async () => undefined);
    expect(screen.getByTestId('interference-status').textContent).toContain(
      'The check failed: worker gone.',
    );
  });

  it('is disabled without an assembler', () => {
    setup(undefined);
    expect((screen.getByTestId('interference-check') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/needs the geometry kernel/)).toBeTruthy();
  });
});

describe('interference views', () => {
  it('rows name both instances and give the volume in the document units', () => {
    const doc = twoInstances();
    const rows = interferenceRows(doc.assemblies[0], [pair(1236)], {
      ...doc.units,
      length: { unit: 'cm', decimals: 3 },
    } as typeof doc.units);
    expect(rows).toEqual([
      {
        key: 'inst#1/inst#2',
        a: 'inst#1',
        b: 'inst#2',
        label: 'Box 1 and Lid 1',
        volume: 1236,
        volumeText: '1.236 cm³',
      },
    ]);
    expect(pairKey(pair(1))).toBe('inst#1/inst#2');
  });

  it('summaries for every state', () => {
    const v = startedView(A, 1);
    expect(interferenceSummary(null, false)).toMatch(/^Check which/);
    expect(interferenceSummary(v, false)).toBe('Checking...');
    expect(interferenceSummary({ ...v, status: 'stale' }, false)).toMatch(/kernel restarted/);
    const two = finishedView(v, report({ pairs: [pair(1), pair(2)] }), undefined);
    expect(interferenceSummary(two, false)).toBe('2 pairs overlap.');
    expect(two.instances).toBe(2);
  });

  it('a highlighted pair selects every face of both instances; the overlap is outlined edge by edge', () => {
    const bodies = assemblyBodies(twoInstances(), A, model());
    const faces = instanceFaces(bodies, A, ['inst#2']);
    expect(faces).toHaveLength(6);
    expect(new Set(faces.map((f) => f.bodyId))).toEqual(new Set(['assembly#1/inst#2/extrude#1']));
    expect(instanceFaces(bodies, A, ['inst#1', 'inst#2'])).toHaveLength(12);
    const lines = overlapSegments(overlap);
    expect(lines).toHaveLength(12);
    for (const line of lines) expect(line.length).toBeGreaterThanOrEqual(2);
  });
});
