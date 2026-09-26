import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createSelectionStore, geometryRef } from './state/selection';
import { createViewSettingsStore } from './state/viewSettings';
import type { BodyInput } from './viewport/bodies';
import type { LoadStatus, SceneLoader } from './viewport/scenes';
import { boxBody } from './viewport/testMeshes';
import type { EngineFactory, ViewportApi } from './viewport/Viewport';

/** A loader the test drives by hand. */
function manualLoader() {
  let report!: (s: LoadStatus) => void;
  let resolve!: (b: BodyInput[]) => void;
  let reject!: (e: Error) => void;
  const result = new Promise<BodyInput[]>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const loader: SceneLoader = {
    load(onStatus) {
      report = onStatus;
      onStatus({ label: 'Starting the geometry kernel', fraction: null });
      return result;
    },
    dispose: vi.fn(),
  };
  return { loader, report: (s: LoadStatus) => report(s), resolve, reject };
}

/** WebGL does not exist in jsdom: a recording stand-in for the engine. */
function fakeEngine() {
  const api = {
    setBodies: vi.fn(),
    setStandardView: vi.fn(),
    setViewDirection: vi.fn(),
    fitAll: vi.fn(),
    pickAt: vi.fn(() => null),
    projectToClient: vi.fn(() => ({ x: 0, y: 0 })),
    info: vi.fn(),
    measureFrames: vi.fn(),
    geometrySamples: vi.fn(() => []),
    hiddenDepth: vi.fn(() => []),
    dispose: vi.fn(),
  };
  const factory: EngineFactory = vi.fn(() => api as unknown as ViewportApi);
  return { api, factory };
}

function setup() {
  const manual = manualLoader();
  const engine = fakeEngine();
  const selection = createSelectionStore();
  const settings = createViewSettingsStore();
  const view = render(
    <App
      loader={manual.loader}
      createEngine={engine.factory}
      selection={selection}
      settings={settings}
    />,
  );
  return { ...manual, engine, selection, settings, view };
}

describe('App', () => {
  it('shows a splash with the kernel load progress until the model is ready', async () => {
    const t = setup();
    expect(screen.getByTestId('splash')).toBeDefined();
    expect(screen.getByText('Starting the geometry kernel')).toBeDefined();
    act(() =>
      t.report({ label: 'Downloading the geometry kernel (21.0 of 42.0 MB)', fraction: 0.35 }),
    );
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('35');
    expect(screen.queryByTestId('viewport-canvas')).toBeNull();
  });

  it('hands the loaded bodies to the viewport engine', async () => {
    const t = setup();
    const bodies = [boxBody()];
    await act(async () => t.resolve(bodies));
    await waitFor(() => expect(t.engine.api.setBodies).toHaveBeenCalledWith(bodies));
    expect(screen.queryByTestId('splash')).toBeNull();
    expect(screen.getByTestId('viewport-canvas')).toBeDefined();
  });

  it('reports a load failure on the splash', async () => {
    const t = setup();
    await act(async () => t.reject(new Error('Kernel fillet failed: boom')));
    expect(screen.getByRole('alert').textContent).toContain('Kernel fillet failed: boom');
  });

  it('drives the engine from the toolbar and the settings store', async () => {
    const t = setup();
    await act(async () => t.resolve([boxBody()]));
    fireEvent.click(await screen.findByRole('button', { name: 'Front' }));
    expect(t.engine.api.setStandardView).toHaveBeenCalledWith('front');
    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
    expect(t.engine.api.fitAll).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Perspective' }));
    expect(t.settings.getState().projection).toBe('orthographic');
    fireEvent.change(screen.getByRole('combobox', { name: 'Mouse' }), {
      target: { value: 'freecad' },
    });
    expect(t.settings.getState().preset).toBe('freecad');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show edges' }));
    expect(t.settings.getState().showEdges).toBe(false);
  });

  it('switches geometry kinds off in the selection filter', async () => {
    const t = setup();
    await act(async () => t.resolve([boxBody()]));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Vertices' }));
    expect(t.selection.getState().isKindEnabled('vertex')).toBe(false);
  });

  it('lists the selection by name, flagging placeholders and fragile names', async () => {
    const t = setup();
    await act(async () => t.resolve([boxBody()]));
    act(() =>
      t.selection
        .getState()
        .select([
          geometryRef('face', 'box', 'box/top'),
          geometryRef('edge', 'box', 'placeholder:edge:3', { placeholder: true, fragile: true }),
        ]),
    );
    const items = screen.getByTestId('selected').querySelectorAll('li');
    expect([...items].map((li) => li.dataset.name)).toEqual(['box/top', 'placeholder:edge:3']);
    expect(items[1]!.textContent).toContain('placeholder');
    expect(items[1]!.textContent).toContain('fragile');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(t.selection.getState().selected).toHaveLength(0);
  });

  it('shows the section controls and updates the section settings', async () => {
    const t = setup();
    await act(async () => t.resolve([boxBody()]));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'On' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Section axis' }), {
      target: { value: 'z' },
    });
    fireEvent.change(screen.getByRole('slider', { name: 'Section position' }), {
      target: { value: '0.25' },
    });
    expect(t.settings.getState().section).toMatchObject({
      enabled: true,
      axis: 'z',
      position: 0.25,
    });
  });

  it('explains a viewport that cannot start', async () => {
    const t = manualLoader();
    render(
      <App
        loader={t.loader}
        createEngine={() => {
          throw new Error('Error creating WebGL context.');
        }}
        selection={createSelectionStore()}
        settings={createViewSettingsStore()}
      />,
    );
    await act(async () => t.resolve([boxBody()]));
    expect((await screen.findByRole('alert')).textContent).toContain('WebGL 2');
  });

  it('exposes the viewport to tests and disposes it on unmount', async () => {
    const t = setup();
    await act(async () => t.resolve([boxBody()]));
    await waitFor(() => expect(window.__manufakture?.viewport).toBe(t.engine.api));
    t.view.unmount();
    expect(t.engine.api.dispose).toHaveBeenCalledTimes(1);
    expect(window.__manufakture).toBeUndefined();
  });

  describe('the scene loader (and with it the kernel worker)', () => {
    /** Let the deferred dispose run, if one is pending. */
    const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    function ownLoader() {
      const manual = manualLoader();
      const createLoader = vi.fn(() => manual.loader);
      return { manual, createLoader };
    }

    it('disposes a loader it created itself when it unmounts', async () => {
      const { manual, createLoader } = ownLoader();
      const view = render(<App createLoader={createLoader} createEngine={fakeEngine().factory} />);
      await act(async () => manual.resolve([boxBody()]));
      await tick();
      expect(manual.loader.dispose).not.toHaveBeenCalled();
      view.unmount();
      await tick();
      expect(manual.loader.dispose).toHaveBeenCalledTimes(1);
    });

    it('keeps the live loader through the StrictMode remount', async () => {
      const { manual, createLoader } = ownLoader();
      const view = render(
        <StrictMode>
          <App createLoader={createLoader} createEngine={fakeEngine().factory} />
        </StrictMode>,
      );
      await tick();
      await act(async () => manual.resolve([boxBody()]));
      await tick();
      expect(manual.loader.dispose).not.toHaveBeenCalled();
      expect(screen.getByTestId('viewport-canvas')).toBeDefined();
      view.unmount();
      await tick();
      expect(manual.loader.dispose).toHaveBeenCalledTimes(1);
    });

    it('never disposes a loader it was given', async () => {
      const t = setup();
      await act(async () => t.resolve([boxBody()]));
      t.view.unmount();
      await tick();
      expect(t.loader.dispose).not.toHaveBeenCalled();
    });
  });
});
