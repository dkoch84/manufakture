import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDocument, findPart } from '@manufakture/core';
import { writeBinaryStl } from '@manufakture/io';
import { App } from './App';
import type { Exchanger } from './io/exchange';
import { createSketchSession } from './sketcher/session';
import { immediateSolver } from './sketcher/testSolver';
import { twoFaces } from './measure/fixtures';
import type { Measurer } from './measure/measurer';
import { createDocumentStore } from './state/document';
import { createMeasureStore } from './state/measure';
import { createSelectionStore, geometryRef } from './state/selection';
import { createViewSettingsStore } from './state/viewSettings';
import type { BodyInput } from './viewport/bodies';
import type { LoadStatus, SceneLoader } from './viewport/scenes';
import { boxBody } from './viewport/testMeshes';
import type { EngineFactory, ViewportApi } from './viewport/Viewport';

/** A loader the test drives by hand. */
function manualLoader(measurer?: Measurer, exchanger?: Exchanger) {
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
    ...(measurer ? { measurer } : {}),
    ...(exchanger ? { exchanger } : {}),
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
    projectToCanvas: vi.fn(() => ({ x: 0, y: 0 })),
    canvasToPlane: vi.fn(() => null),
    alignView: vi.fn(),
    setPointerDelegate: vi.fn(),
    onViewChange: vi.fn(() => () => {}),
    requestRender: vi.fn(),
    dispose: vi.fn(),
  };
  const factory: EngineFactory = vi.fn(() => api as unknown as ViewportApi);
  return { api, factory };
}

function setup(options: { measurer?: Measurer; exchanger?: Exchanger } = {}) {
  const manual = manualLoader(options.measurer, options.exchanger);
  const engine = fakeEngine();
  const selection = createSelectionStore();
  const settings = createViewSettingsStore();
  const documents = createDocumentStore(createDocument({ id: 'doc', name: 'Test' }));
  const solver = immediateSolver({ dof: 0 });
  const sketchSession = createSketchSession(solver.solver);
  const measure = createMeasureStore();
  const view = render(
    <App
      loader={manual.loader}
      createEngine={engine.factory}
      selection={selection}
      settings={settings}
      documents={documents}
      sketchSession={sketchSession}
      measure={measure}
    />,
  );
  return {
    ...manual,
    engine,
    selection,
    settings,
    documents,
    sketchSession,
    solver,
    measure,
    view,
  };
}

/** A kernel exchange with one box body, for the Export menu. */
function boxExchanger(): Exchanger {
  return {
    bodies: () => [{ id: 'box', name: 'Box' }],
    tessellate: vi.fn(async () => ({
      ok: true as const,
      value: [{ name: 'Box', mesh: boxBody().mesh }],
    })),
    exportStep: vi.fn(async () => ({ ok: true as const, value: new TextEncoder().encode('ISO') })),
    importStep: vi.fn(async () => ({ ok: false as const, message: 'not in this test' })),
    retain: vi.fn(() => []),
  };
}

/** Capture downloads: jsdom has no object URLs and does not navigate. */
function captureDownloads() {
  const saved: { name: string; blob: Blob }[] = [];
  const blobs = new Map<string, Blob>();
  let n = 0;
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: (b: Blob) => {
        const url = `blob:test/${++n}`;
        blobs.set(url, b);
        return url;
      },
      revokeObjectURL: () => {},
    }),
  );
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push({ name: this.download, blob: blobs.get(this.href)! });
  });
  return { saved, restore: () => click.mockRestore() };
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

  describe('measuring', () => {
    function measurerReplying() {
      const measurer: Measurer = {
        measure: vi.fn(async () => ({ ok: true as const, result: twoFaces() })),
      };
      return measurer;
    }

    it('measures the body at once, then the selection, and draws the witness points', async () => {
      const measurer = measurerReplying();
      const t = setup({ measurer });
      await act(async () => t.resolve([boxBody()]));
      await waitFor(() => expect(measurer.measure).toHaveBeenCalledWith('box', [], true));
      expect(screen.getByText(/Select faces, edges or vertices/)).toBeDefined();
      await act(async () =>
        t.selection
          .getState()
          .select([
            geometryRef('face', 'box', 'box/top'),
            geometryRef('face', 'box', 'placeholder:face:5', { placeholder: true }),
          ]),
      );
      await waitFor(() =>
        expect(measurer.measure).toHaveBeenLastCalledWith(
          'box',
          [
            { kind: 'face', name: 'box/top' },
            { kind: 'face', index: 5 },
          ],
          true,
        ),
      );
      expect((await screen.findByTestId('measure-value-distance')).textContent).toBe('20.00 mm');
      expect(screen.getByTestId('measure-value-body.volume').textContent).toBe('44000.00 mm³');
      // The witness line, projected by the viewport.
      expect(screen.getByTestId('measure-witness')).toBeDefined();
      expect(t.engine.api.projectToCanvas).toHaveBeenCalledWith([10, 10, 20]);
      expect(t.engine.api.projectToCanvas).toHaveBeenCalledWith([10, 10, 0]);
    });

    it('shows values in the display units, and copies them', async () => {
      const t = setup({ measurer: measurerReplying() });
      const writeText = vi.fn(async () => {});
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      await act(async () => t.resolve([boxBody()]));
      act(() => {
        t.documents.getState().execute({
          type: 'setDisplayUnits',
          units: { length: { unit: 'ft-in', denominator: 16 }, angle: { unit: 'deg' } },
        });
      });
      expect((await screen.findByTestId('measure-value-distance')).textContent).toBe('13/16"');
      fireEvent.click(screen.getByRole('button', { name: 'Copy Distance' }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('13/16"'));
      fireEvent.click(screen.getByRole('button', { name: 'Copy all' }));
      await waitFor(() =>
        expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining('Distance: 13/16"')),
      );
    });

    it('sets the body material as one undoable command, and shows the mass', async () => {
      const t = setup({ measurer: measurerReplying() });
      await act(async () => t.resolve([boxBody()]));
      const select = await screen.findByRole('combobox', { name: 'Material' });
      expect(screen.queryByTestId('measure-value-body.mass')).toBeNull();
      fireEvent.change(select, { target: { value: 'pla' } });
      expect(t.documents.getState().document.parts[0]!.material).toBe('pla');
      expect(t.documents.getState().undoLabel).toBe('Set material to PLA');
      // 44000 mm3 of PLA at 1240 kg/m3.
      expect(screen.getByTestId('measure-value-body.mass').textContent).toBe('54.56 g');
      act(() => {
        t.documents.getState().undo();
      });
      expect(t.documents.getState().document.parts[0]!.material).toBeUndefined();
      expect(screen.queryByTestId('measure-value-body.mass')).toBeNull();
    });

    it('explains a scene without a kernel, and shows measuring errors', async () => {
      const t = setup();
      await act(async () => t.resolve([boxBody()]));
      expect(await screen.findByText(/needs the geometry kernel/)).toBeDefined();
      const failing = setup({
        measurer: { measure: async () => ({ ok: false, message: 'unknown shape id 9' }) },
      });
      await act(async () => failing.resolve([boxBody()]));
      expect((await screen.findByText('unknown shape id 9')).getAttribute('role')).toBe('alert');
    });

    it('registers the measure store as a test hook', async () => {
      const t = setup({ measurer: measurerReplying() });
      await act(async () => t.resolve([boxBody()]));
      expect(window.__manufakture?.measure).toBe(t.measure);
      t.view.unmount();
      expect(window.__manufakture?.measure).toBeUndefined();
    });
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

  describe('sketching', () => {
    async function ready() {
      const t = setup();
      await act(async () => t.resolve([boxBody()]));
      await waitFor(() => expect(t.engine.api.onViewChange).toHaveBeenCalled());
      return t;
    }
    const features = (t: ReturnType<typeof setup>) =>
      t.documents.getState().document.parts[0]!.features;

    it('starts a sketch on a datum plane and looks straight at it', async () => {
      const t = await ready();
      fireEvent.click(screen.getByRole('button', { name: 'New sketch' }));
      expect(
        (screen.getByRole('menuitem', { name: 'Selected face' }) as HTMLButtonElement).disabled,
      ).toBe(true);
      fireEvent.click(screen.getByRole('menuitem', { name: 'Front (XZ)' }));
      expect(t.engine.api.alignView).toHaveBeenCalledWith([0, -1, 0], [0, 0, 1], [0, 0, 0]);
      expect(t.sketchSession.getState()).toMatchObject({
        active: true,
        source: { featureId: 'sketch#1', name: 'Sketch 1' },
      });
      expect(screen.getByRole('toolbar', { name: 'Sketch' })).toBeDefined();
      expect(t.engine.api.setPointerDelegate).toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'New sketch' })).toHaveProperty('disabled', true);
    });

    it('offers the selected planar face as a sketch plane', async () => {
      const t = await ready();
      act(() => t.selection.getState().select([geometryRef('face', 'box', 'box/top')]));
      fireEvent.click(screen.getByRole('button', { name: 'New sketch' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Selected face' }));
      expect(t.sketchSession.getState().source?.placement.normal).toEqual([0, 0, 1]);
    });

    it('commits the sketch on finish as one undoable step, and edits it again', async () => {
      const t = await ready();
      fireEvent.click(screen.getByRole('button', { name: 'New sketch' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Top (XY)' }));
      act(() => {
        const s = t.sketchSession.getState();
        s.setTool('circle');
        s.click({ at: [0, 0], tolerance: 0.1 });
        s.click({ at: [3, 0], tolerance: 0.1 });
      });
      await act(() => t.sketchSession.getState().idle());
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Finish sketch' }));
      });
      await waitFor(() => expect(features(t)).toHaveLength(1));
      expect(features(t)[0]).toMatchObject({ id: 'sketch#1', entities: [{ kind: 'circle' }] });
      expect(screen.queryByRole('toolbar', { name: 'Sketch' })).toBeNull();
      expect(screen.getByTestId('sketch-list').textContent).toContain('Sketch 1');

      // Ctrl+Z undoes the commit, Ctrl+Y brings it back.
      fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
      expect(features(t)).toHaveLength(0);
      fireEvent.keyDown(window, { key: 'y', ctrlKey: true });
      expect(features(t)).toHaveLength(1);

      fireEvent.click(screen.getByRole('button', { name: 'Edit Sketch 1' }));
      expect(t.sketchSession.getState().source).toMatchObject({
        featureId: 'sketch#1',
        isNew: false,
      });
      // While sketching, Ctrl+Z is the sketch's: the document keeps its history.
      fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
      expect(features(t)).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(t.sketchSession.getState().active).toBe(false);
    });
  });
});

describe('App export and import', () => {
  it('exports STL from the Export menu as a download', async () => {
    const downloads = captureDownloads();
    const exchanger = boxExchanger();
    const t = setup({ exchanger });
    await act(async () => t.resolve([boxBody()]));
    fireEvent.click(await screen.findByRole('button', { name: 'Export' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Mesh tolerance' }), {
      target: { value: 'fine' },
    });
    fireEvent.click(screen.getByRole('menuitem', { name: 'STL' }));
    await waitFor(() =>
      expect(screen.getByTestId('io-status').textContent).toMatch(/^Exported Box\.stl/),
    );
    expect(exchanger.tessellate).toHaveBeenCalledWith(['box'], { linear: 0.005, angular: 0.1 });
    expect(downloads.saved.map((d) => [d.name, d.blob.type])).toEqual([['Box.stl', 'model/stl']]);
    expect(downloads.saved[0]!.blob.size).toBe(84 + 12 * 50);
    downloads.restore();
  });

  it('has no Export without a kernel', async () => {
    const t = setup();
    await act(async () => t.resolve([boxBody()]));
    expect((await screen.findByRole('button', { name: 'Export' })).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('imports an STL as a reference body; undo hides it and redo shows it again', async () => {
    const t = setup();
    const loaded = [boxBody()];
    await act(async () => t.resolve(loaded));
    const mesh = boxBody({ id: 'x', min: [20, 0, 0] }).mesh;
    const bytes = writeBinaryStl({
      positions: new Float32Array(mesh.positions),
      indices: new Uint32Array(mesh.indices),
    });
    const file = new File([bytes], 'bracket.stl', { type: 'model/stl' });
    fireEvent.change(await screen.findByTestId('import-input'), { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByTestId('io-status').textContent).toBe(
        'Imported bracket.stl as bracket (STL mesh, a reference body).',
      ),
    );
    const last = () => t.engine.api.setBodies.mock.lastCall![0] as BodyInput[];
    expect(last().map((b) => b.id)).toEqual(['box', 'import#1']);
    const part = () => findPart(t.documents.getState().document, 'part#1')!;
    expect(part().features.map((f) => f.id)).toEqual(['import#1']);

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(last()).toBe(loaded));
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    await waitFor(() => expect(last().map((b) => b.id)).toEqual(['box', 'import#1']));
  });

  it('keeps an undone STEP import for redo, and drops it once it cannot come back', async () => {
    const exchanger = boxExchanger();
    vi.mocked(exchanger.importStep).mockImplementation(async (_bytes, featureId) => ({
      ok: true,
      value: boxBody({ id: featureId, min: [20, 0, 0] }),
    }));
    const t = setup({ exchanger });
    const loaded = [boxBody()];
    await act(async () => t.resolve(loaded));
    const file = new File(['ISO-10303-21;\nDATA;\nENDSEC;\n'], 'ref.step', {
      type: 'model/step',
    });
    fireEvent.change(await screen.findByTestId('import-input'), { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByTestId('io-status').textContent).toMatch(/^Imported ref\.step/),
    );
    const retained = () => [...vi.mocked(exchanger.retain).mock.lastCall![0]];
    await waitFor(() => expect(retained()).toEqual(['import#1']));
    const last = () => t.engine.api.setBodies.mock.lastCall![0] as BodyInput[];

    // Undone: hidden, but kept, since redo brings it back.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(last()).toBe(loaded));
    expect(retained()).toEqual(['import#1']);
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    await waitFor(() => expect(last().map((b) => b.id)).toEqual(['box', 'import#1']));

    // Undone, then a new edit clears the redo stack: the body is dropped for good.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    act(() => {
      t.documents.getState().execute({
        type: 'setDisplayUnits',
        units: { length: { unit: 'in' }, angle: { unit: 'deg' } },
      });
    });
    await waitFor(() => expect(retained()).toEqual([]));
    expect(last()).toBe(loaded);
  });

  it('reports a file it cannot import', async () => {
    const t = setup();
    await act(async () => t.resolve([boxBody()]));
    const file = new File(['hello'], 'notes.txt');
    fireEvent.change(await screen.findByTestId('import-input'), { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('notes.txt is not a STEP or STL file.'),
    );
    expect(findPart(t.documents.getState().document, 'part#1')!.features).toEqual([]);
  });
});
