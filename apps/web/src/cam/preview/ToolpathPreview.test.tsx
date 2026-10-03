// The preview panel with a stand-in viewport: statistics per operation and for the job, the
// overlay added while the panel is up and removed when it goes (the modelling view is left as it
// was), visibility toggles, and the scrubber putting the tool at the end of the move chosen.

import { SimulationSession, toModel } from '@manufakture/cam';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Object3D } from 'three';
import { liveViewport } from '../../viewport/live';
import type { ViewportApi } from '../../viewport/Viewport';
import { setupDocument } from '../cam.test-fixture';
import { createCamUiStore } from '../state';
import type { SimulationClient } from '../sim/runner';
import { previewGeometry } from './geometry';
import { previewJob } from './job';
import { fixtureGeneration } from './preview.test-fixture';
import { formatLength, formatMinutes } from './format';
import { ToolpathPreview, type CamPreviewHookState } from './ToolpathPreview';

afterEach(() => {
  cleanup();
  liveViewport.setState({ api: null });
});

function fakeViewport() {
  const objects = new Set<Object3D>();
  const api = {
    addOverlay: vi.fn((o: Object3D) => {
      objects.add(o);
      return () => objects.delete(o);
    }),
    requestRender: vi.fn(),
  };
  liveViewport.setState({ api: api as unknown as ViewportApi });
  return { api, objects };
}

function mount(simulationClient?: SimulationClient) {
  const setup = setupDocument().cam.setups[0]!;
  const camUi = createCamUiStore();
  camUi.getState().setSetup('setup#1');
  const view = render(
    <ToolpathPreview
      setup={setup}
      camUi={camUi}
      {...(simulationClient ? { simulationClient } : {})}
    />,
  );
  return { camUi, setup, view };
}

/** A simulation client on an in-process session (no worker), counting its requests. */
function inProcessClient() {
  const session = new SimulationSession();
  const requests: (number | undefined)[] = [];
  const client: SimulationClient = {
    async simulateProgram(request) {
      requests.push(request.upTo);
      const out = await session.run(request, { checkpoint: async () => {} });
      if (out.ok) return { status: 'done', generation: requests.length, frame: out.frame, ms: 0 };
      if (out.needsProgram) {
        return { status: 'needs-program', generation: 1, programId: request.programId };
      }
      return { status: 'failed', generation: 1, ...out.error };
    },
  };
  return { client, requests };
}

const hook = () =>
  window.__manufakture!.camPreview as { state(): CamPreviewHookState; seek(n: number): void };

describe('ToolpathPreview', () => {
  it('asks to generate until there are toolpaths, and draws nothing without a placement', () => {
    const { objects } = fakeViewport();
    mount();
    expect(screen.getByTestId('cam-preview').textContent).toContain('Generate to preview');
    expect(objects.size).toBe(0);
  });

  it('shows statistics, draws the overlay and takes it away again', () => {
    const { objects, api } = fakeViewport();
    const { camUi, view } = mount();
    const data = fixtureGeneration();
    act(() => camUi.getState().setToolpaths(data));
    expect(objects.size).toBe(1);
    const job = previewJob(data);
    const row = screen.getByTestId('cam-preview-op-profile#1');
    expect(row.textContent).toContain(formatLength(job.operations[0]!.stats!.cutLength));
    expect(row.textContent).toContain(
      formatMinutes(job.operations[0]!.stats!.estimate.totalMinutes),
    );
    expect(screen.getByTestId('cam-preview-job').textContent).toContain(
      formatMinutes(job.stats!.estimate.totalMinutes),
    );
    expect(api.requestRender).toHaveBeenCalled();
    view.unmount();
    expect(objects.size).toBe(0);
  });

  it('puts the tool at the end of the move scrubbed to', () => {
    fakeViewport();
    const { camUi } = mount();
    const data = fixtureGeneration();
    act(() => camUi.getState().setToolpaths(data));
    const path = previewGeometry(previewJob(data).toolpath, { rapidRate: data.rapidRate });
    expect(hook().state()).toMatchObject({ moveCount: path.moveCount, done: path.moveCount });
    fireEvent.change(screen.getByTestId('cam-preview-scrubber'), { target: { value: '5' } });
    const state = hook().state();
    expect(state.done).toBe(5);
    const end = [...path.ends.subarray(12, 15)] as [number, number, number];
    expect(state.toolMachine).toEqual(end);
    expect(state.tool).toEqual(toModel(data.setup.frame, end));
    expect(state.marker).toEqual(state.tool!.map((v) => expect.closeTo(v, 9)));
    expect(screen.getByTestId('cam-preview-position').textContent).toMatch(/^Move 5 of /);
    act(() => hook().seek(0));
    expect(hook().state().toolMachine).toEqual([...path.start]);
  });

  it('hides an operation when its box is cleared', () => {
    fakeViewport();
    const { camUi } = mount();
    act(() => camUi.getState().setToolpaths(fixtureGeneration()));
    fireEvent.click(screen.getByTestId('cam-preview-show-pocket#1'));
    expect(hook().state().hidden).toEqual(['pocket#1']);
    fireEvent.click(screen.getByTestId('cam-preview-show-pocket#1'));
    expect(hook().state().hidden).toEqual([]);
  });

  it('drops the toolpaths with the setup', () => {
    const { objects } = fakeViewport();
    const { camUi } = mount();
    act(() => camUi.getState().setToolpaths(fixtureGeneration()));
    act(() => camUi.getState().setSetup('setup#2'));
    expect(camUi.getState().toolpaths).toBeNull();
    expect(objects.size).toBe(0);
  });
});

describe('the simulation toggle', () => {
  it('simulates the job, follows the scrubber, and takes its view away when turned off', async () => {
    const { objects, api } = fakeViewport();
    const { client, requests } = inProcessClient();
    const { camUi } = mount(client);
    const data = fixtureGeneration();
    act(() => camUi.getState().setToolpaths(data));
    expect(objects.size).toBe(1);
    expect(screen.queryByTestId('cam-sim-report')).toBeNull();
    expect([...objects][0]!.getObjectByName('cam-preview-stock')!.visible).toBe(true);
    fireEvent.click(screen.getByTestId('cam-sim-toggle'));
    // The preview overlay and the simulated stock; the translucent stock box steps aside.
    expect(objects.size).toBe(2);
    const stockBox = () =>
      [...objects].find((o) => o.name === 'cam-preview')!.getObjectByName('cam-preview-stock')!;
    expect(stockBox().visible).toBe(false);
    const path = previewGeometry(previewJob(data).toolpath, { rapidRate: data.rapidRate });
    await waitFor(() =>
      expect(screen.getByTestId('cam-sim-status').textContent).toContain(
        `move ${path.moveCount} of ${path.moveCount}`,
      ),
    );
    // The fixture's cuts stay inside the stock and its rapids above it; there is no part mesh.
    expect(screen.getByTestId('cam-sim-collisions').textContent).toBe(
      'No rapid runs through material.',
    );
    expect(screen.getByTestId('cam-sim-gouges').textContent).toMatch(/No part mesh/);
    const grid = [...objects].find((o) => o.name === 'cam-simulation')!;
    expect(grid.children).toHaveLength(1);
    expect(api.requestRender).toHaveBeenCalled();
    // Scrubbing back simulates up to that move.
    fireEvent.change(screen.getByTestId('cam-preview-scrubber'), { target: { value: '3' } });
    await waitFor(() =>
      expect(screen.getByTestId('cam-sim-status').textContent).toContain('move 3 of'),
    );
    expect(requests.at(-1)).toBe(3);
    fireEvent.click(screen.getByTestId('cam-sim-toggle'));
    expect(objects.size).toBe(1);
    expect(stockBox().visible).toBe(true);
    expect(screen.queryByTestId('cam-sim-report')).toBeNull();
  });

  it('is off, and cannot be turned on, without toolpaths', () => {
    fakeViewport();
    mount(inProcessClient().client);
    expect(screen.queryByTestId('cam-sim-toggle')).toBeNull();
  });
});

describe('formatting', () => {
  it('formats times and lengths', () => {
    expect(formatMinutes(0.5)).toBe('0:30');
    expect(formatMinutes(75.25)).toBe('1:15:15');
    expect(formatLength(1234.4)).toBe('1,234 mm');
    expect(formatLength(2.25)).toBe('2.3 mm');
  });
});
