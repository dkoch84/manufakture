import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyCommand,
  createDocument,
  findPart,
  type Command,
  type ManufaktureDocument,
} from '@manufakture/core';
import type { FeatureResult, InstanceInterference } from '@manufakture/regen';
import { importSource, writeBinaryStl } from '@manufakture/io';
import { App } from './App';
import { MemoryBackend } from './persistence/backend';
import { DocumentLibrary } from './persistence/library';
import { partDocument, partWithImport } from './persistence/test-fixtures';
import type { Exchanger } from './io/exchange';
import { createSketchSession } from './sketcher/session';
import { immediateSolver } from './sketcher/testSolver';
import { twoFaces } from './measure/fixtures';
import type { Measurer } from './measure/measurer';
import { demoDocument } from './model/demo';
import { createModelStore, type Regenerator, type RegenView } from './model/model';
import { constructionDocument } from './construction/construction.test-fixture';
import { createConstructionUiStore, type ConstructionUiStore } from './construction/state';
import { createDocumentStore } from './state/document';
import { createMeasureStore } from './state/measure';
import { createSelectionStore, geometryRef, type GeometryRef } from './state/selection';
import { createViewSettingsStore } from './state/viewSettings';
import type { BodyInput } from './viewport/bodies';
import type { LoadStatus, SceneLoader } from './viewport/scenes';
import { boxBody } from './viewport/testMeshes';
import { apply, twoInstances } from './assembly/assembly.test-fixture';
import { commitSketch, startSketch } from './sketcher/commit';
import { XZ_PLANE } from '@manufakture/sketch/geometry';
import type { EngineFactory, ViewportApi } from './viewport/Viewport';

/** A loader the test drives by hand. */
function manualLoader(measurer?: Measurer, exchanger?: Exchanger, regenerator?: Regenerator) {
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
    ...(regenerator ? { regenerator } : {}),
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
    setObjectDrag: vi.fn(),
    setTransforms: vi.fn(),
    surfacePoint: vi.fn(() => null),
    viewDirection: vi.fn(() => [0, 0, 1]),
    onViewChange: vi.fn(() => () => {}),
    requestRender: vi.fn(),
    setBuildVolume: vi.fn(),
    setShading: vi.fn(),
    setThreadLines: vi.fn(),
    setGrainLines: vi.fn(),
    setPreviewLines: vi.fn(),
    frameBox: vi.fn(),
    dispose: vi.fn(),
  };
  const factory: EngineFactory = vi.fn(() => api as unknown as ViewportApi);
  return { api, factory };
}

function setup(
  options: {
    measurer?: Measurer;
    exchanger?: Exchanger;
    regenerator?: Regenerator;
    constructionUi?: ConstructionUiStore;
  } = {},
) {
  const manual = manualLoader(options.measurer, options.exchanger, options.regenerator);
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
      {...(options.constructionUi ? { constructionUi: options.constructionUi } : {})}
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
    reimport: vi.fn(async () => []),
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

  it('resets the construction tool, wall and level on every document switch', async () => {
    const ui = createConstructionUiStore();
    const t = setup({ constructionUi: ui });
    await act(async () => t.resolve([]));
    const switchTo = (doc: ReturnType<typeof constructionDocument>) =>
      act(() => {
        ui.setState({ tool: { kind: 'roof', featureId: null }, editingWall: 'w', level: 'l' });
        t.documents.getState().load(doc);
      });
    // To a document with construction: the panel opens, nothing of the last one carries over.
    switchTo({ ...constructionDocument(), id: 'shed-a' });
    await waitFor(() => expect(ui.getState().open).toBe(true));
    expect(ui.getState()).toMatchObject({ tool: null, editingWall: null, level: null });
    // And to another one with construction, too.
    switchTo({ ...constructionDocument(), id: 'shed-b' });
    await waitFor(() => expect(ui.getState().tool).toBeNull());
    expect(ui.getState()).toMatchObject({ open: true, editingWall: null, level: null });
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

    /** A solver whose disposal the test watches. */
    function ownSolver() {
      const solver = { ...immediateSolver({ dof: 0 }).solver, dispose: vi.fn() };
      return { solver, createSolver: vi.fn(() => solver) };
    }

    it('disposes the sketch solver it made when it unmounts, not before', async () => {
      const { manual, createLoader } = ownLoader();
      const { solver, createSolver } = ownSolver();
      const view = render(
        <StrictMode>
          <App
            createLoader={createLoader}
            createSolver={createSolver}
            createEngine={fakeEngine().factory}
          />
        </StrictMode>,
      );
      await tick();
      await act(async () => manual.resolve([boxBody()]));
      await tick();
      // The StrictMode remount keeps it.
      expect(solver.dispose).not.toHaveBeenCalled();
      view.unmount();
      await tick();
      expect(solver.dispose).toHaveBeenCalledTimes(1);
      expect(manual.loader.dispose).toHaveBeenCalledTimes(1);
    });

    it('never disposes the solver of a session it was given', async () => {
      const { solver, createSolver } = ownSolver();
      const manual = manualLoader();
      const view = render(
        <App
          loader={manual.loader}
          createSolver={createSolver}
          sketchSession={createSketchSession(solver)}
          createEngine={fakeEngine().factory}
        />,
      );
      await act(async () => manual.resolve([boxBody()]));
      view.unmount();
      await tick();
      expect(createSolver).not.toHaveBeenCalled();
      expect(solver.dispose).not.toHaveBeenCalled();
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
      expect(screen.getByTestId('feature-tree').textContent).toContain('Sketch 1');

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
    expect(last().map((b) => b.id)).toEqual(['box', 'part#1/import#1']);
    const part = () => findPart(t.documents.getState().document, 'part#1')!;
    expect(part().features.map((f) => f.id)).toEqual(['import#1']);

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(last()).toBe(loaded));
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    await waitFor(() => expect(last().map((b) => b.id)).toEqual(['box', 'part#1/import#1']));
  });

  it('shows the reference imports of a duplicated part studio on its tab', async () => {
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
    const last = () => t.engine.api.setBodies.mock.lastCall![0] as BodyInput[];
    await waitFor(() => expect(last().map((b) => b.id)).toEqual(['box', 'part#1/import#1']));

    // The copy is active, and its import (also import#1) is read from the file it stores.
    fireEvent.click(screen.getByTestId('part-duplicate'));
    expect(t.documents.getState().activePartId).toBe('part#2');
    await waitFor(() => expect(last().map((b) => b.id)).toEqual(['box', 'part#2/import#1']));
    fireEvent.click(screen.getByTestId('part-tab-part#1'));
    await waitFor(() => expect(last().map((b) => b.id)).toEqual(['box', 'part#1/import#1']));

    // Undo drops the copy; redo puts it back with its body.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(t.documents.getState().document.parts).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(t.documents.getState().activePartId).toBe('part#2');
    await waitFor(() => expect(last().map((b) => b.id)).toEqual(['box', 'part#2/import#1']));
  });

  it('keeps an undone STEP import for redo, and drops it once it cannot come back', async () => {
    const exchanger = boxExchanger();
    vi.mocked(exchanger.importStep).mockImplementation(
      async (_bytes, featureId, _name, bodyId) => ({
        ok: true,
        value: boxBody({ id: bodyId ?? featureId, min: [20, 0, 0] }),
      }),
    );
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
    await waitFor(() => expect(retained()).toEqual(['part#1/import#1']));
    const last = () => t.engine.api.setBodies.mock.lastCall![0] as BodyInput[];

    // Undone: hidden, but kept, since redo brings it back.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(last()).toBe(loaded));
    expect(retained()).toEqual(['part#1/import#1']);
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    await waitFor(() => expect(last().map((b) => b.id)).toEqual(['box', 'part#1/import#1']));

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

  it('reads imported STEP bodies again when the kernel lost every shape', async () => {
    const exchanger = boxExchanger();
    vi.mocked(exchanger.importStep).mockImplementation(
      async (_bytes, featureId, _name, bodyId) => ({
        ok: true,
        value: boxBody({ id: bodyId ?? featureId, min: [20, 0, 0] }),
      }),
    );
    const lost = new Set<() => void>();
    const regenerator: Regenerator = {
      regen: () => new Promise(() => {}),
      onInvalidated: (l) => {
        lost.add(l);
        return () => lost.delete(l);
      },
    };
    const t = setup({ exchanger, regenerator });
    await act(async () => t.resolve([boxBody()]));
    const text = 'ISO-10303-21;\nDATA;\nENDSEC;\n';
    const file = new File([text], 'ref.step', { type: 'model/step' });
    fireEvent.change(await screen.findByTestId('import-input'), { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByTestId('io-status').textContent).toMatch(/^Imported ref\.step/),
    );
    expect(exchanger.reimport).not.toHaveBeenCalled();
    // The status shows at the commit, but the app learns of the new import in a passive effect,
    // which React may run a scheduler task later; flush it before the kernel loses its shapes, or
    // a loaded machine sees an invalidation with no import held and nothing to read again.
    await act(async () => {});
    // A recycle (or a restart) of the kernel.
    act(() => lost.forEach((l) => l()));
    await waitFor(() => expect(exchanger.reimport).toHaveBeenCalledTimes(1));
    const files = vi.mocked(exchanger.reimport).mock.lastCall![0];
    expect([...files.keys()]).toEqual(['part#1/import#1']);
    expect(new TextDecoder().decode(files.get('part#1/import#1'))).toBe(text);
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

  describe('the regenerated model, the feature tree and the feature dialogs', () => {
    /** A loader with a regenerator the test answers by hand, opening the demo document. */
    function modelSetup() {
      const requests: { document: ManufaktureDocument; resolve: (v: RegenView | null) => void }[] =
        [];
      const invalidate = new Set<() => void>();
      const regenerator: Regenerator = {
        regen: (document) => new Promise((resolve) => requests.push({ document, resolve })),
        onInvalidated: (l) => {
          invalidate.add(l);
          return () => invalidate.delete(l);
        },
      };
      const loader: SceneLoader = {
        load: async () => [],
        dispose: vi.fn(),
        regenerator,
        initialDocument: demoDocument(),
      };
      const engine = fakeEngine();
      const selection = createSelectionStore();
      const documents = createDocumentStore(createDocument({ id: 'doc', name: 'Test' }));
      const model = createModelStore();
      const solver = immediateSolver({ dof: 0 });
      render(
        <App
          loader={loader}
          createEngine={engine.factory}
          selection={selection}
          settings={createViewSettingsStore()}
          documents={documents}
          sketchSession={createSketchSession(solver.solver)}
          measure={createMeasureStore()}
          model={model}
        />,
      );
      const answer = (i: number, patch: (id: string) => Partial<FeatureResult> = () => ({})) =>
        act(async () => {
          const r = requests[i]!;
          const part = r.document.parts[0]!;
          r.resolve({
            generation: i + 1,
            ms: 1,
            parts: [
              {
                partId: part.id,
                bodies: [
                  {
                    bodyId: 'extrude#1',
                    creator: 'extrude#1',
                    solids: 1,
                    view: boxBody({ id: `${part.id}/extrude#1` }),
                  },
                ],
                features: part.features.map((f, index) => ({
                  featureId: f.id,
                  kind: f.kind,
                  index,
                  status: 'ok' as const,
                  errors: [],
                  warnings: [],
                  references: [],
                  cached: false,
                  ms: 0,
                  ...patch(f.id),
                })),
              },
            ],
          });
        });
      return { requests, invalidate, engine, selection, documents, model, answer };
    }

    it('opens the scene document, regenerates it on every change and after a recycle', async () => {
      const t = modelSetup();
      await waitFor(() => expect(t.requests).toHaveLength(1));
      expect(t.requests[0]!.document.parts[0]!.name).toBe('Demo part');
      await t.answer(0);
      await waitFor(() =>
        expect(t.engine.api.setBodies).toHaveBeenLastCalledWith([
          expect.objectContaining({ id: 'part#1/extrude#1' }),
        ]),
      );
      const tree = screen.getByTestId('feature-tree');
      expect(within(tree).getByTestId('feature-fillet#1').dataset.status).toBe('ok');

      act(() => {
        t.documents.getState().execute({
          type: 'suppressFeature',
          partId: 'part#1',
          featureId: 'fillet#1',
          suppressed: true,
        });
      });
      expect(t.requests).toHaveLength(2);
      expect(within(tree).getByTestId('feature-fillet#1').dataset.status).toBe('suppressed');
      act(() => t.invalidate.forEach((l) => l()));
      expect(t.requests).toHaveLength(3);
    });

    it('opens a feature dialog from the toolbar and from the tree, and applies it', async () => {
      const t = modelSetup();
      await waitFor(() => expect(t.requests).toHaveLength(1));
      await t.answer(0, (id) =>
        id === 'fillet#1'
          ? {
              status: 'error',
              errors: [
                {
                  code: 'reference-lost',
                  message: 'Edge r3 of Fillet 1 is gone; re-pick it',
                  referenceId: 'r3',
                  missing: [],
                },
              ],
            }
          : {},
      );
      // A new chamfer from the toolbar; the tree and the toolbar wait while it is open.
      fireEvent.click(
        within(screen.getByRole('toolbar', { name: 'Features' })).getByRole('button', {
          name: /Chamfer/,
        }),
      );
      // The dialogs load on first use.
      expect(await screen.findByRole('dialog', { name: 'Chamfer: Chamfer 1' })).toBeTruthy();
      expect(
        (screen.getByRole('button', { name: 'Delete Sketch 1' }) as HTMLButtonElement).disabled,
      ).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByTestId('feature-dialog')).toBeNull();

      // Double-click edits: the extrusion's depth.
      fireEvent.doubleClick(screen.getByTestId('feature-extrude#1'));
      const depth = (await screen.findByTestId('field-distance')) as HTMLInputElement;
      expect(depth.value).toBe('20');
      fireEvent.change(depth, { target: { value: '25' } });
      fireEvent.click(screen.getByTestId('dialog-ok'));
      expect(t.documents.getState().undoLabel).toBe('Edit Extrude 1');
      expect(t.requests.at(-1)!.document.parts[0]!.features[1]).toMatchObject({
        extent: { distance: { source: '25' } },
      });

      // Re-pick from the error tooltip opens the fillet with the lost edge marked.
      fireEvent.mouseEnter(screen.getByTestId('status-fillet#1'));
      fireEvent.click(screen.getByRole('button', { name: 'Re-pick r3' }));
      expect(
        within(await screen.findByTestId('ref-edges')).getByText(/not found: pick it again/),
      ).toBeTruthy();
    });
  });
});

describe('App laser export', () => {
  /** Open the laser and plasma export from the Export menu. */
  async function openLaser() {
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(screen.getByTestId('export-laser'));
    expect(await screen.findByTestId('laser-dialog')).toBeTruthy();
  }
  const features = () => within(screen.getByRole('toolbar', { name: 'Features' }));

  it('gives way to a feature dialog, and is not offered while one is open', async () => {
    const t = setup({ exchanger: boxExchanger() });
    await act(async () => t.resolve([boxBody()]));
    await openLaser();
    // The toolbar stays usable: a new feature closes the export rather than hiding behind it.
    fireEvent.click(features().getByRole('button', { name: 'Extrude' }));
    expect(await screen.findByTestId('feature-dialog')).toBeTruthy();
    expect(screen.queryByTestId('laser-dialog')).toBeNull();
    // With the dialog open, the Export menu does not offer the laser export.
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(screen.queryByTestId('export-laser')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    // Closing the dialog does not bring the export back.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('feature-dialog')).toBeNull();
    expect(screen.queryByTestId('laser-dialog')).toBeNull();
    expect(screen.getByTestId('feature-tree')).toBeTruthy();
  });

  it('closes when Print or Manufacture opens, so it never covers their panels', async () => {
    const t = setup({ exchanger: boxExchanger() });
    await act(async () => t.resolve([boxBody()]));
    await openLaser();
    fireEvent.click(screen.getByTestId('open-print'));
    expect(screen.getByTestId('print-panel')).toBeTruthy();
    expect(screen.queryByTestId('laser-dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(screen.queryByTestId('export-laser')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(screen.getByTestId('open-print'));
    expect(screen.queryByTestId('laser-dialog')).toBeNull();

    await openLaser();
    fireEvent.click(screen.getByTestId('open-cam'));
    expect(await screen.findByTestId('cam-panel')).toBeTruthy();
    expect(screen.queryByTestId('laser-dialog')).toBeNull();
    fireEvent.click(screen.getByTestId('open-cam'));
    expect(screen.queryByTestId('laser-dialog')).toBeNull();
    expect(screen.getByTestId('feature-tree')).toBeTruthy();
  });
});

describe('App documents', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  /** The app with a library in memory holding Alpha (a plain part) and Bravo (with an STL import). */
  async function persisted(
    options: {
      initialDocumentId?: string | null;
      empty?: boolean;
      backend?: MemoryBackend;
      exchanger?: Exchanger;
    } = {},
  ) {
    let n = 0;
    let tick = 0;
    const library = new DocumentLibrary(options.backend ?? new MemoryBackend(), {
      locks: null,
      newId: () => `new-${++n}`,
      now: () => new Date(Date.UTC(2026, 8, 26, 12, 0, tick++)),
    });
    if (!options.empty) {
      await library.save(partDocument('a', 'Alpha'));
      await library.save(await partWithImport('b'));
    }
    const manual = manualLoader(undefined, options.exchanger);
    const engine = fakeEngine();
    const documents = createDocumentStore(createDocument({ id: 'scratch', name: 'Scratch' }));
    render(
      <App
        loader={manual.loader}
        createEngine={engine.factory}
        selection={createSelectionStore()}
        settings={createViewSettingsStore()}
        documents={documents}
        sketchSession={createSketchSession(immediateSolver({ dof: 0 }).solver)}
        measure={createMeasureStore()}
        library={Promise.resolve(library)}
        autosaveDelays={{ delayMs: 5, maxDelayMs: 20 }}
        {...(options.initialDocumentId !== undefined
          ? { initialDocumentId: options.initialDocumentId }
          : {})}
      />,
    );
    await act(async () => manual.resolve([]));
    const bodies = () =>
      (engine.api.setBodies.mock.lastCall?.[0] as BodyInput[] | undefined)?.map((b) => b.id) ?? [];
    return { library, documents, engine, bodies };
  }

  it('opens the most recent document with its imported reference body, and names it in the URL', async () => {
    const t = await persisted();
    await waitFor(() => expect(screen.getByTestId('document-name').textContent).toBe('Bracket'));
    expect(t.documents.getState().document.id).toBe('b');
    await waitFor(() => expect(t.bodies()).toEqual(['part#1/import#1']));
    expect(window.location.search).toBe('?doc=b');
  });

  it('opens the document the URL names, and autosaves every change', async () => {
    const t = await persisted({ initialDocumentId: 'a' });
    await waitFor(() => expect(t.documents.getState().document.id).toBe('a'));
    act(() => {
      t.documents.getState().execute({ type: 'renameDocument', name: 'Shelf' }, 'Rename document');
    });
    await waitFor(() => expect(screen.getByTestId('save-status').textContent).toBe('Saved'));
    const opened = await t.library.open('a');
    expect(opened.ok && opened.value.document.name).toBe('Shelf');
    const log = await t.library.readLog('a');
    expect(log.ok && log.value.map((e) => e.label)).toEqual(['Rename document']);
  });

  it('says so when the document it opens at startup was recovered from its last complete save', async () => {
    const backend = new MemoryBackend();
    const seed = new DocumentLibrary(backend, { locks: null });
    await seed.save(partDocument('a', 'Alpha'));
    backend.files.delete('documents/a/head.json');
    const t = await persisted({ initialDocumentId: 'a', backend, empty: true });
    await waitFor(() => expect(t.documents.getState().document.id).toBe('a'));
    expect((await screen.findByTestId('io-status')).textContent).toBe(
      'Opened Alpha (recovered from its last complete save).',
    );
  });

  it('keeps a new document unsaved until its first change', async () => {
    const t = await persisted({ empty: true });
    expect(await screen.findByTestId('document-name')).toBeTruthy();
    expect(await t.library.list()).toEqual([]);
    expect(window.location.search).toBe('');
    act(() => {
      t.documents.getState().execute({ type: 'renameDocument', name: 'Mine' }, 'Rename document');
    });
    await waitFor(() => expect(window.location.search).toBe('?doc=scratch'));
    expect((await t.library.list()).map((d) => d.name)).toEqual(['Mine']);
  });

  it('switches documents from the home screen, dropping the reference bodies of the one before', async () => {
    const t = await persisted();
    await waitFor(() => expect(t.bodies()).toEqual(['part#1/import#1']));
    fireEvent.click(screen.getByTestId('open-home'));
    fireEvent.click(await screen.findByRole('button', { name: 'Alpha' }));
    await waitFor(() => expect(screen.getByTestId('document-name').textContent).toBe('Alpha'));
    await waitFor(() => expect(t.bodies()).toEqual([]));
    expect(window.location.search).toBe('?doc=a');
    // And back: the import is read again.
    fireEvent.click(screen.getByTestId('open-home'));
    fireEvent.click(await screen.findByRole('button', { name: 'Bracket' }));
    await waitFor(() => expect(t.bodies()).toEqual(['part#1/import#1']));
  });

  it('stays on the home screen after deleting the open document, with a new one open', async () => {
    const t = await persisted();
    await waitFor(() => expect(t.documents.getState().document.id).toBe('b'));
    fireEvent.click(screen.getByTestId('open-home'));
    const row = within(await screen.findByTestId('doc-b'));
    fireEvent.click(row.getByRole('button', { name: 'Delete' }));
    fireEvent.click(row.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByTestId('doc-b')).toBeNull());
    expect(screen.getByTestId('home')).toBeTruthy();
    expect(t.documents.getState().document.name).toBe('Untitled');
    expect(window.location.search).toBe('');
    // Back in the editor, the deleted document's reference body is gone.
    fireEvent.click(screen.getByTestId('home-back'));
    await waitFor(() => expect(t.bodies()).toEqual([]));
  });

  it('shows the home screen with the reason when the document cannot be opened', async () => {
    await persisted({ initialDocumentId: 'gone' });
    expect((await screen.findByTestId('home-status')).textContent).toBe(
      'The document could not be opened. There is no document "gone".',
    );
    expect(screen.getByRole('table', { name: 'Documents' })).toBeTruthy();
  });

  it('opens a .mfk file dropped on the page', async () => {
    const t = await persisted();
    await waitFor(() => expect(t.documents.getState().document.id).toBe('b'));
    const exported = await t.library.exportMfk('a');
    if (!exported.ok) throw new Error(exported.message);
    const file = new File([exported.value.bytes as Uint8Array<ArrayBuffer>], 'Alpha.mfk');
    const drop = new Event('drop', { cancelable: true }) as DragEvent;
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [file], types: ['Files'] } });
    act(() => {
      window.dispatchEvent(drop);
    });
    expect(drop.defaultPrevented).toBe(true);
    await waitFor(() => expect(t.documents.getState().document.name).toBe('Alpha'));
    // Alpha is still there, so the dropped copy got a new id.
    expect(t.documents.getState().document.id).toBe('new-1');
  });

  it('asks before the page closes while a change is not saved yet', async () => {
    const t = await persisted({ initialDocumentId: 'a' });
    await waitFor(() => expect(t.documents.getState().document.id).toBe('a'));
    const unload = () => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(unload()).toBe(false);
    act(() => {
      t.documents.getState().execute({ type: 'renameDocument', name: 'Shelf' }, 'Rename document');
    });
    expect(unload()).toBe(true);
    await waitFor(() => expect(screen.getByTestId('save-status').textContent).toBe('Saved'));
    expect(unload()).toBe(false);
  });

  it('shows a conflict with another tab, and keeps this version as a copy', async () => {
    const backend = new MemoryBackend();
    const t = await persisted({ initialDocumentId: 'a', backend });
    await waitFor(() => expect(t.documents.getState().document.id).toBe('a'));
    const other = new DocumentLibrary(backend, { locks: null });
    await other.open('a');
    await other.save(partDocument('a', 'Theirs'));
    act(() => {
      t.documents.getState().execute({ type: 'renameDocument', name: 'Mine' }, 'Rename document');
    });
    const banner = await screen.findByTestId('save-conflict');
    expect(banner.textContent).toMatch(/^Mine was changed in another tab or window/);
    expect(screen.getByTestId('save-status').textContent).toMatch(
      /^Not saved: It was changed in another tab or window/,
    );
    fireEvent.click(screen.getByTestId('conflict-copy'));
    await waitFor(() => expect(t.documents.getState().document.name).toBe('Mine (copy)'));
    expect(screen.queryByTestId('save-conflict')).toBeNull();
    expect(screen.getByTestId('io-status').textContent).toBe(
      'Saved this version as Mine (copy); the other version stays as it was.',
    );
    const theirs = await t.library.open('a');
    expect(theirs.ok && theirs.value.document.name).toBe('Theirs');
  });

  it('names a version in the History panel, views it read-only, goes back, restores and undoes', async () => {
    const t = await persisted({ initialDocumentId: 'a' });
    await waitFor(() => expect(t.documents.getState().document.id).toBe('a'));
    const rename = (name: string) =>
      act(() => {
        t.documents.getState().execute({ type: 'renameDocument', name }, 'Rename document');
      });
    const saved = () =>
      waitFor(() => expect(screen.getByTestId('save-status').textContent).toBe('Saved'));
    rename('Shelf');
    await saved();
    fireEvent.click(screen.getByTestId('open-history'));
    await screen.findByTestId('revision-2');
    fireEvent.click(screen.getByTestId('version-create'));
    fireEvent.change(screen.getByTestId('version-name'), { target: { value: 'Shelf v1' } });
    fireEvent.click(screen.getByTestId('version-save'));
    await screen.findByTestId('version-Shelf v1');
    rename('Later');
    await saved();

    fireEvent.click(screen.getByRole('button', { name: 'View version Shelf v1' }));
    const banner = await screen.findByTestId('history-viewer');
    expect(within(banner).getByTestId('history-viewer-label').textContent).toBe(
      'Viewing Version "Shelf v1"',
    );
    expect(within(banner).getByTestId('history-compare').textContent).toContain(
      'Named "Shelf" here, "Later" now.',
    );
    // Read-only: no feature tools, no undo, no variables; the open document is untouched.
    expect(screen.queryByRole('toolbar', { name: 'Features' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('complementary', { name: 'Variables' })).toBeNull();
    expect(t.documents.getState().document.name).toBe('Later');
    fireEvent.click(screen.getByTestId('history-back'));
    await waitFor(() => expect(screen.queryByTestId('history-viewer')).toBeNull());
    expect(screen.getByRole('toolbar', { name: 'Features' })).toBeDefined();

    // Two views asked for at once: only the later one is shown.
    fireEvent.click(screen.getByRole('button', { name: 'View revision 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'View revision 3' }));
    await waitFor(() =>
      expect(screen.getByTestId('history-viewer-label').textContent).toBe('Viewing Revision 3'),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('history-viewer-label').textContent).toBe('Viewing Revision 3');
    fireEvent.click(screen.getByTestId('history-back'));
    await waitFor(() => expect(screen.queryByTestId('history-viewer')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'View version Shelf v1' }));
    await screen.findByTestId('history-viewer');
    fireEvent.click(screen.getByTestId('history-restore'));
    await waitFor(() => expect(screen.queryByTestId('history-viewer')).toBeNull());
    expect(t.documents.getState().document.name).toBe('Shelf');
    expect(t.documents.getState().undoLabel).toBe('Restore Version "Shelf v1"');
    await saved();
    act(() => {
      t.documents.getState().undo();
    });
    expect(t.documents.getState().document.name).toBe('Later');
    await saved();
    const log = await t.library.readLog('a');
    expect(log.ok && log.value.map((e) => `${e.cause} ${e.command.type}`)).toEqual([
      'execute renameDocument',
      'execute renameDocument',
      'execute replaceDocument',
      'undo replaceDocument',
    ]);
  });

  it('branches from a version in the viewer, works on the branch, switches back and reloads both', async () => {
    const backend = new MemoryBackend();
    const t = await persisted({ initialDocumentId: 'a', backend });
    await waitFor(() => expect(t.documents.getState().document.id).toBe('a'));
    const rename = (name: string) =>
      act(() => {
        t.documents.getState().execute({ type: 'renameDocument', name }, 'Rename document');
      });
    const saved = () =>
      waitFor(() => expect(screen.getByTestId('save-status').textContent).toBe('Saved'));
    // A document with one branch shows the switcher with main alone.
    const select = () => screen.getByTestId('branch-select') as HTMLSelectElement;
    await waitFor(() => expect([...select().options].map((o) => o.textContent)).toEqual(['Main']));
    rename('Six');
    await saved();
    fireEvent.click(screen.getByTestId('open-history'));
    await screen.findByTestId('revision-2');
    fireEvent.click(screen.getByTestId('version-create'));
    fireEvent.change(screen.getByTestId('version-name'), { target: { value: '6 mm' } });
    fireEvent.click(screen.getByTestId('version-save'));
    await screen.findByTestId('version-6 mm');
    rename('Eight');
    await saved();

    // Branch is offered for a version, not for a revision.
    fireEvent.click(screen.getByRole('button', { name: 'View revision 2' }));
    await screen.findByTestId('history-viewer');
    expect(screen.queryByTestId('history-branch')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View version 6 mm' }));
    await waitFor(() =>
      expect(screen.getByTestId('history-viewer-label').textContent).toBe('Viewing Version "6 mm"'),
    );
    fireEvent.click(screen.getByTestId('history-branch'));
    fireEvent.change(screen.getByTestId('branch-name'), { target: { value: 'Ten' } });
    fireEvent.click(screen.getByTestId('branch-create'));
    await waitFor(() => expect(screen.queryByTestId('history-viewer')).toBeNull());
    expect(t.documents.getState().document.name).toBe('Six');
    // The branch's own history: nothing logged yet, so undo has nothing to take back.
    expect(t.documents.getState().undoLabel).toBeNull();
    await waitFor(() => expect(select().selectedOptions[0]!.textContent).toBe('Ten'));
    const branchId = select().value;
    expect(window.location.search).toBe(`?doc=a&branch=${branchId}`);
    expect(screen.getByTestId('io-status').textContent).toBe(
      'Created the branch Ten from Version "6 mm"; changes now go to it.',
    );
    expect(screen.getByTestId('history-branch-name').textContent).toBe('Ten');

    rename('Ten mm');
    await saved();
    const reader = () => new DocumentLibrary(backend, { locks: null });
    const onBranch = await reader().open('a', branchId);
    expect(onBranch.ok && onBranch.value.document.name).toBe('Ten mm');
    const onMain = await reader().open('a');
    expect(onMain.ok && onMain.value.document.name).toBe('Eight');
    await screen.findByTestId('revision-2');
    expect(screen.queryByTestId('revision-3')).toBeNull();
    // A version on the branch; main's shows tagged with its branch.
    expect(screen.getByTestId('version-branch-6 mm').textContent).toBe('Main');
    fireEvent.click(screen.getByTestId('version-create'));
    fireEvent.change(screen.getByTestId('version-name'), { target: { value: '10 mm' } });
    fireEvent.click(screen.getByTestId('version-save'));
    await screen.findByTestId('version-10 mm');
    expect(screen.queryByTestId('version-branch-10 mm')).toBeNull();

    // Back to main: its state and history; the URL names no branch.
    fireEvent.change(select(), { target: { value: 'main' } });
    await waitFor(() => expect(t.documents.getState().document.name).toBe('Eight'));
    expect(window.location.search).toBe('?doc=a');
    await screen.findByTestId('revision-3');
    rename('Eight again');
    await saved();
    const mainAgain = await reader().open('a');
    expect(mainAgain.ok && mainAgain.value.document.name).toBe('Eight again');
    const branchStill = await reader().open('a', branchId);
    expect(branchStill.ok && branchStill.value.document.name).toBe('Ten mm');

    // A version of the branch restores onto main (no merging: its whole state, one undo step).
    await waitFor(() => expect(screen.getByTestId('version-branch-10 mm').textContent).toBe('Ten'));
    fireEvent.click(screen.getByRole('button', { name: 'View version 10 mm' }));
    await screen.findByTestId('history-viewer');
    fireEvent.click(screen.getByTestId('history-restore'));
    await waitFor(() => expect(t.documents.getState().document.name).toBe('Ten mm'));
    await saved();
    const restored = await reader().open('a');
    expect(restored.ok && restored.value.document.name).toBe('Ten mm');
    act(() => {
      t.documents.getState().undo();
    });
    await saved();
    cleanup();

    // Reload on the branch: the URL opens it.
    window.history.replaceState(null, '', `/?doc=a&branch=${branchId}`);
    const again = await persisted({ backend, empty: true });
    await waitFor(() => expect(again.documents.getState().document.name).toBe('Ten mm'));
    await waitFor(() => expect(select().selectedOptions[0]!.textContent).toBe('Ten'));
  });

  it('renames and deletes a branch from the switcher; a link to a deleted branch opens main', async () => {
    const backend = new MemoryBackend();
    const setupLib = new DocumentLibrary(backend, { locks: null, newId: () => 'b-1' });
    await setupLib.save(partDocument('a', 'Alpha'));
    const v = await setupLib.createVersion('a', { name: 'Base' });
    if (!v.ok) throw new Error(v.message);
    const created = await setupLib.createBranch('a', v.value.id, 'Wide');
    expect(created.ok).toBe(true);
    window.history.replaceState(null, '', '/?doc=a&branch=b-1');
    const t = await persisted({ backend, empty: true });
    const select = () => screen.getByTestId('branch-select') as HTMLSelectElement;
    await waitFor(() => expect(select().value).toBe('b-1'));
    expect(window.location.search).toBe('?doc=a&branch=b-1');

    fireEvent.click(screen.getByTestId('branch-rename'));
    fireEvent.change(screen.getByTestId('branch-rename-name'), { target: { value: 'Wider' } });
    fireEvent.click(screen.getByTestId('branch-rename-save'));
    await waitFor(() => expect(select().selectedOptions[0]!.textContent).toBe('Wider'));

    fireEvent.click(screen.getByTestId('branch-delete'));
    fireEvent.click(screen.getByTestId('branch-delete-confirm'));
    await waitFor(() => expect(select().value).toBe('main'));
    expect([...select().options].map((o) => o.textContent)).toEqual(['Main']);
    expect(window.location.search).toBe('?doc=a');
    expect(screen.getByTestId('io-status').textContent).toBe(
      'Deleted the branch Wider; this is the main branch.',
    );
    expect(t.documents.getState().document.name).toBe('Alpha');
    cleanup();

    window.history.replaceState(null, '', '/?doc=a&branch=b-1');
    const again = await persisted({ backend, empty: true });
    await waitFor(() => expect(again.documents.getState().document.name).toBe('Alpha'));
    expect(screen.getByTestId('io-status').textContent).toBe(
      'The branch in the link cannot be opened (There is no such branch.); this is the main branch.',
    );
    await waitFor(() => expect(window.location.search).toBe('?doc=a'));
  });

  it('opens main for a link whose branch is malformed, never repeating it; `main` is main', async () => {
    const backend = new MemoryBackend();
    const setupLib = new DocumentLibrary(backend, { locks: null });
    await setupLib.save(partDocument('a', 'Alpha'));
    for (const odd of ['../a', '<img src=x onerror=alert(1)>', 'x'.repeat(5000), 'a/b', ' ']) {
      window.history.replaceState(null, '', `/?doc=a&branch=${encodeURIComponent(odd)}`);
      const t = await persisted({ backend, empty: true });
      await waitFor(() => expect(t.documents.getState().document.name).toBe('Alpha'));
      const status = screen.getByTestId('io-status').textContent ?? '';
      expect(status).toBe(
        'The branch in the link cannot be opened (There is no such branch.); this is the main branch.',
      );
      await waitFor(() => expect(window.location.search).toBe('?doc=a'));
      expect(backend.files.has('documents/a/branches')).toBe(false);
      expect([...backend.files.keys()].some((f) => f.includes('/branches/'))).toBe(false);
      cleanup();
    }
    // Naming the main branch outright opens it, quietly, and the link loses the parameter.
    window.history.replaceState(null, '', '/?doc=a&branch=main');
    const t = await persisted({ backend, empty: true });
    await waitFor(() => expect(t.documents.getState().document.name).toBe('Alpha'));
    await waitFor(() => expect(window.location.search).toBe('?doc=a'));
    expect(screen.queryByTestId('io-status')?.textContent ?? '').not.toMatch(/branch/);
  });

  it('keeps the STEP bodies a view reads while another view of them is still reading', async () => {
    // A kernel stand-in: a registry of reference bodies, STEP reads the test answers one by one,
    // and every release recorded.
    const registry = new Map<string, number>();
    const released: string[] = [];
    const reads: { bodyId: string; finish: () => void }[] = [];
    let shapes = 0;
    const exchanger = boxExchanger();
    vi.mocked(exchanger.importStep).mockImplementation(
      (_bytes, featureId, _name, bodyId) =>
        new Promise((resolve) => {
          const id = bodyId ?? featureId;
          reads.push({
            bodyId: id,
            finish: () => {
              registry.set(id, ++shapes);
              resolve({ ok: true, value: boxBody({ id }) });
            },
          });
        }),
    );
    vi.mocked(exchanger.retain).mockImplementation((ids) => {
      const dropped = [...registry.keys()].filter((id) => !ids.has(id));
      for (const id of dropped) registry.delete(id);
      released.push(...dropped);
      return dropped;
    });
    // Stored: revision 1 with two STEP reference imports, named as a version; revision 2 without.
    const backend = new MemoryBackend();
    const before = new DocumentLibrary(backend, { locks: null });
    const step = async (id: string, name: string) => ({
      id,
      kind: 'import' as const,
      name,
      suppressed: false,
      operation: 'reference' as const,
      source: await importSource(
        'step',
        `${name}.step`,
        new TextEncoder().encode(`ISO-10303-21; ${name}`),
      ),
    });
    const added = applyCommand(partDocument('b'), {
      type: 'batch',
      commands: [
        { type: 'addFeature', partId: 'part#1', feature: await step('import#1', 'X') },
        { type: 'addFeature', partId: 'part#1', feature: await step('import#2', 'Y') },
      ],
    });
    if (!added.ok) throw new Error(added.error.message);
    await before.save(added.value.document);
    expect((await before.createVersion('b', { name: 'Both' })).ok).toBe(true);
    const removal: Command = {
      type: 'batch',
      commands: [
        { type: 'deleteFeature', partId: 'part#1', featureId: 'import#2' },
        { type: 'deleteFeature', partId: 'part#1', featureId: 'import#1' },
      ],
    };
    const removed = applyCommand(added.value.document, removal);
    if (!removed.ok) throw new Error(removed.error.message);
    await before.save(removed.value.document, [
      { cause: 'execute', label: 'Delete X and Y', command: removal, at: '2026-09-30T10:00:00Z' },
    ]);

    const t = await persisted({ backend, empty: true, initialDocumentId: 'b', exchanger });
    await waitFor(() => expect(t.documents.getState().document.id).toBe('b'));
    fireEvent.click(screen.getByTestId('open-history'));
    const view = await screen.findByRole('button', { name: 'View version Both' });
    const X = 'part#1/import#1';
    const Y = 'part#1/import#2';
    // View A starts reading X; view B, asked for meanwhile, reads X too.
    fireEvent.click(view);
    await waitFor(() => expect(reads.map((r) => r.bodyId)).toEqual([X]));
    fireEvent.click(view);
    await waitFor(() => expect(reads.map((r) => r.bodyId)).toEqual([X, X]));
    // B's X lands and B goes on to Y; then A's X and A's Y land, and A, overtaken, prunes.
    await act(async () => reads[1]!.finish());
    await waitFor(() => expect(reads.map((r) => r.bodyId)).toEqual([X, X, Y]));
    await act(async () => reads[0]!.finish());
    await waitFor(() => expect(reads).toHaveLength(4));
    await act(async () => reads[3]!.finish());
    // B is still reading: neither of its bodies was released.
    expect(released).toEqual([]);
    expect(registry.has(X)).toBe(true);
    await act(async () => reads[2]!.finish());
    await screen.findByTestId('history-viewer');
    await waitFor(() => expect(t.bodies()).toEqual([X, Y]));
    expect(released).toEqual([]);
    expect([...registry.keys()].sort()).toEqual([X, Y]);

    // Back releases the view's bodies.
    fireEvent.click(screen.getByTestId('history-back'));
    await waitFor(() => expect(t.bodies()).toEqual([]));
    await waitFor(() => expect([...registry.keys()]).toEqual([]));
    expect(released.sort()).toEqual([X, Y]);
  });

  it('restores a state equal to the current one without an undo step, and says so', async () => {
    const t = await persisted({ initialDocumentId: 'a' });
    await waitFor(() => expect(t.documents.getState().document.id).toBe('a'));
    fireEvent.click(screen.getByTestId('open-history'));
    fireEvent.click(await screen.findByTestId('version-create'));
    fireEvent.change(screen.getByTestId('version-name'), { target: { value: 'Same' } });
    fireEvent.click(screen.getByTestId('version-save'));
    fireEvent.click(await screen.findByRole('button', { name: 'View version Same' }));
    await screen.findByTestId('history-viewer');
    fireEvent.click(screen.getByTestId('history-restore'));
    await waitFor(() => expect(screen.queryByTestId('history-viewer')).toBeNull());
    expect(screen.getByTestId('io-status').textContent).toBe(
      'Version "Same" is the same as the current state: nothing changed.',
    );
    expect(t.documents.getState().canUndo).toBe(false);
  });

  it('keeps the reference bodies of the current state through a restore and its undo', async () => {
    // Stored: revision 1 with an STL reference import, named as a version; revision 2 without it.
    const backend = new MemoryBackend();
    const before = new DocumentLibrary(backend, { locks: null });
    const withImport = await partWithImport('b');
    await before.save(withImport);
    const version = await before.createVersion('b', { name: 'One import' });
    expect(version.ok).toBe(true);
    const command = { type: 'deleteFeature', partId: 'part#1', featureId: 'import#1' } as const;
    const r = applyCommand(withImport, command);
    if (!r.ok) throw new Error(r.error.message);
    await before.save(r.value.document, [
      { cause: 'execute', label: 'Delete Cube', command, at: '2026-09-30T10:00:00.000Z' },
    ]);
    const t = await persisted({ backend, empty: true, initialDocumentId: 'b' });
    await waitFor(() => expect(t.documents.getState().document.id).toBe('b'));
    fireEvent.click(screen.getByTestId('open-history'));
    await screen.findByTestId('version-One import');
    // Opened after the delete, so this session never read the import: viewing the version reads
    // it for the view, and Back drops it again.
    expect(t.bodies()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'View version One import' }));
    await screen.findByTestId('history-viewer');
    await waitFor(() => expect(t.bodies()).toEqual(['part#1/import#1']));
    fireEvent.click(screen.getByTestId('history-back'));
    await waitFor(() => expect(screen.queryByTestId('history-viewer')).toBeNull());
    await waitFor(() => expect(t.bodies()).toEqual([]));

    // A second STL reference body, which the version does not have.
    const mesh = boxBody({ id: 'x', min: [20, 0, 0] }).mesh;
    const bytes = writeBinaryStl({
      positions: new Float32Array(mesh.positions),
      indices: new Uint32Array(mesh.indices),
    });
    const file = new File([bytes], 'second.stl', { type: 'model/stl' });
    fireEvent.change(screen.getByTestId('import-input'), { target: { files: [file] } });
    await waitFor(() => expect(t.bodies()).toEqual(['part#1/import#2']));

    fireEvent.click(screen.getByRole('button', { name: 'View version One import' }));
    await screen.findByTestId('history-viewer');
    fireEvent.click(screen.getByTestId('history-restore'));
    await waitFor(() => expect(screen.queryByTestId('history-viewer')).toBeNull());
    // The version's import, not held before, is read from its file.
    await waitFor(() => expect(t.bodies()).toEqual(['part#1/import#1']));
    // Undo brings back the state with the second import, still drawn: its body was kept.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(t.bodies()).toEqual(['part#1/import#2']));
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    await waitFor(() => expect(t.bodies()).toEqual(['part#1/import#1']));
  });

  it('views a version with several part studios, switching tabs but not changing them', async () => {
    const t = await persisted({ initialDocumentId: 'a' });
    await waitFor(() => expect(t.documents.getState().document.id).toBe('a'));
    act(() => {
      t.documents.getState().execute({ type: 'addPart', partId: 'part#2', name: 'Lid' }, 'Add Lid');
    });
    await waitFor(() => expect(screen.getByTestId('save-status').textContent).toBe('Saved'));
    fireEvent.click(screen.getByTestId('open-history'));
    fireEvent.click(await screen.findByTestId('version-create'));
    fireEvent.change(screen.getByTestId('version-name'), { target: { value: 'Two tabs' } });
    fireEvent.click(screen.getByTestId('version-save'));
    fireEvent.click(await screen.findByRole('button', { name: 'View version Two tabs' }));
    await screen.findByTestId('history-viewer');
    expect((screen.getByTestId('version-create') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('part-add')).toBeNull();
    const first = screen.getByTestId('part-tab-part#1');
    expect(first.getAttribute('draggable')).toBe('false');
    fireEvent.click(first);
    await waitFor(() =>
      expect(screen.getByTestId('part-tab-part#1').getAttribute('aria-selected')).toBe('true'),
    );
    fireEvent.doubleClick(screen.getByTestId('part-tab-part#1'));
    expect(screen.queryByTestId('part-rename-input')).toBeNull();
    // The open document's active tab is its own.
    expect(t.documents.getState().activePartId).toBe('part#2');
    fireEvent.click(screen.getByTestId('history-back'));
    await waitFor(() => expect(screen.queryByTestId('history-viewer')).toBeNull());
    expect(screen.getByTestId('part-add')).toBeDefined();
  });

  it('says why a dropped .mfk file could not be read', async () => {
    const t = await persisted();
    await waitFor(() => expect(t.documents.getState().document.id).toBe('b'));
    const file = new File([new Uint8Array(4)], 'broken.mfk');
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => Promise.reject(new Error('The file could not be read')),
    });
    const drop = new Event('drop', { cancelable: true }) as DragEvent;
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [file], types: ['Files'] } });
    act(() => {
      window.dispatchEvent(drop);
    });
    expect((await screen.findByTestId('home-status')).textContent).toBe(
      'broken.mfk: The file could not be read',
    );
  });
});

describe('App assemblies', () => {
  /** The box-and-lid assembly, regenerated by hand: every instance where its pose says. */
  function assemblySetup(
    doc: ManufaktureDocument = twoInstances(),
    extra: Partial<SceneLoader> = {},
  ) {
    const requests: { document: ManufaktureDocument; resolve: (v: RegenView | null) => void }[] =
      [];
    const regenerator: Regenerator = {
      regen: (document) => new Promise((resolve) => requests.push({ document, resolve })),
      onInvalidated: () => () => undefined,
    };
    const overlap = boxBody({ id: 'overlap', min: [0, 0, 0], size: [10, 10, 2] }).mesh;
    const assembler = {
      solve: vi.fn(async () => null),
      drag: vi.fn(async () => null),
      interference: vi.fn(
        async (assemblyId: string, onPair: (pair: InstanceInterference) => void) => {
          const pair = { a: 'inst#1', b: 'inst#2', volume: 200, mesh: overlap };
          onPair(pair);
          return {
            generation: 1,
            assemblyId,
            instances: ['inst#1', 'inst#2'],
            pairs: [{ ...pair, mesh: null }],
            candidates: 1,
            booleans: 1,
            failures: [],
            status: 'done' as const,
            ms: 1,
          };
        },
      ),
      cancelInterference: vi.fn(),
    };
    const loader: SceneLoader = {
      load: async () => [],
      dispose: vi.fn(),
      regenerator,
      assembler,
      ...extra,
    };
    const engine = fakeEngine();
    const selection = createSelectionStore();
    const documents = createDocumentStore(doc);
    const model = createModelStore();
    render(
      <App
        loader={loader}
        createEngine={engine.factory}
        selection={selection}
        settings={createViewSettingsStore()}
        documents={documents}
        sketchSession={createSketchSession(immediateSolver({ dof: 0 }).solver)}
        measure={createMeasureStore()}
        model={model}
      />,
    );
    const answer = (i: number) =>
      act(async () => {
        const { document, resolve } = requests[i]!;
        resolve({
          generation: i + 1,
          ms: 1,
          parts: document.parts.map((p) => ({
            partId: p.id,
            features: [],
            bodies: [
              {
                bodyId: 'extrude#1',
                creator: 'extrude#1',
                solids: 1,
                view: boxBody({ id: `${p.id}/extrude#1` }),
              },
            ],
          })),
          assemblies: document.assemblies.map((a) => ({
            assemblyId: a.id,
            outcome: 'solved' as const,
            dof: 6 * a.instances.filter((x) => !x.fixed).length,
            instances: a.instances.map((x) => ({
              instanceId: x.id,
              status: 'ok' as const,
              source: x.source as { part: string },
              bodies: ['extrude#1'],
              transform: x.pose,
              moved: false,
              errors: [],
              warnings: [],
            })),
            mates: [],
            redundant: [],
            conflicting: [],
            issues: [],
            warnings: [],
            ms: 0,
          })),
        });
      });
    const shownIds = () =>
      (engine.api.setBodies.mock.calls.at(-1)![0] as BodyInput[]).map((b) => b.id);
    return { requests, answer, engine, documents, selection, assembler, shownIds };
  }

  it('shows an assembly tab with its tree, tools and instances, and drags only there', async () => {
    const t = assemblySetup();
    await waitFor(() => expect(t.requests).toHaveLength(1));
    await t.answer(0);
    expect(screen.getByRole('toolbar', { name: 'Features' })).toBeDefined();
    expect(t.shownIds()).toEqual(['part#1/extrude#1']);

    fireEvent.click(screen.getByTestId('assembly-tab-assembly#1'));
    expect(screen.queryByRole('toolbar', { name: 'Features' })).toBeNull();
    expect(screen.getByRole('toolbar', { name: 'Assembly' })).toBeDefined();
    expect(screen.getByTestId('assembly-dof').textContent).toBe('6 degrees of freedom');
    expect(document.getElementById('part-studio-panel')!.getAttribute('aria-labelledby')).toBe(
      'assembly-tab-assembly#1',
    );
    // Every instance body, each sharing its part's mesh, placed by its pose.
    await waitFor(() =>
      expect(t.shownIds()).toEqual(['assembly#1/inst#1/extrude#1', 'assembly#1/inst#2/extrude#1']),
    );
    expect(t.engine.api.setObjectDrag).toHaveBeenLastCalledWith(
      expect.objectContaining({ start: expect.any(Function) }),
    );
    expect(screen.queryByRole('complementary', { name: 'Measure' })).toBeNull();

    // Insert another lid: regenerated, then shown.
    fireEvent.click(screen.getByTestId('assembly-insert'));
    fireEvent.click(screen.getByTestId('insert-part-part#2'));
    await waitFor(() => expect(t.requests).toHaveLength(2));
    await t.answer(1);
    await waitFor(() => expect(t.shownIds()).toHaveLength(3));
    expect(screen.getByTestId('assembly-dof').textContent).toBe('12 degrees of freedom');
    fireEvent.click(screen.getByTestId('insert-close'));

    // The Mate dialog holds the tabs while it is open.
    fireEvent.click(screen.getByTestId('assembly-mate'));
    expect(screen.getByTestId('mate-dialog')).toBeDefined();
    expect((screen.getByTestId('part-tab-part#1') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('mate-cancel'));
    expect(screen.queryByTestId('mate-dialog')).toBeNull();

    // Back to the part studio: its tools, its bodies, no instance drags.
    fireEvent.click(screen.getByTestId('part-tab-part#1'));
    expect(screen.getByRole('toolbar', { name: 'Features' })).toBeDefined();
    await waitFor(() => expect(t.shownIds()).toEqual(['part#1/extrude#1']));
    expect(t.engine.api.setObjectDrag).toHaveBeenLastCalledWith(null);
  });
  it('closes the laser export on an assembly tab, and does not offer it there', async () => {
    const t = assemblySetup(twoInstances(), { exchanger: boxExchanger() });
    await waitFor(() => expect(t.requests).toHaveLength(1));
    await t.answer(0);
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(screen.getByTestId('export-laser'));
    expect(await screen.findByTestId('laser-dialog')).toBeTruthy();
    fireEvent.click(screen.getByTestId('assembly-tab-assembly#1'));
    expect(screen.getByRole('toolbar', { name: 'Assembly' })).toBeDefined();
    expect(screen.queryByTestId('laser-dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(screen.queryByTestId('export-laser')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    // Back on the part studio, it stays closed.
    fireEvent.click(screen.getByTestId('part-tab-part#1'));
    expect(screen.getByRole('toolbar', { name: 'Features' })).toBeDefined();
    expect(screen.queryByTestId('laser-dialog')).toBeNull();
  });

  it("draws a part studio's sketches in its own tab only, never over the assembly", async () => {
    // The box's part studio gets a sketch on the XZ plane.
    const base = twoInstances();
    const start = startSketch(base, { kind: 'new', placement: XZ_PLANE }, 'part#1');
    if (!start.ok) throw new Error(start.message);
    const line = { id: 'e1', kind: 'line' as const, construction: false };
    const commit = commitSketch(base, 'part#1', start.value.source, {
      entities: [{ ...line, start: [0, 0] as [number, number], end: [40, 0] as [number, number] }],
      constraints: [],
    })!;
    const t = assemblySetup(apply(base, commit.command));
    await waitFor(() => expect(t.requests).toHaveLength(1));
    await t.answer(0);
    const drawn = () =>
      screen.queryByTestId('committed-sketches')?.querySelectorAll('[data-feature]').length ?? 0;
    expect(drawn()).toBe(1);

    fireEvent.click(screen.getByTestId('assembly-tab-assembly#1'));
    await waitFor(() => expect(t.shownIds()).toHaveLength(2));
    expect(screen.queryByTestId('committed-sketches')).toBeNull();

    fireEvent.click(screen.getByTestId('part-tab-part#1'));
    expect(drawn()).toBe(1);
  });
  it('checks interference from the assembly toolbar; a pair selects both instances and outlines the overlap', async () => {
    const t = assemblySetup();
    await waitFor(() => expect(t.requests).toHaveLength(1));
    await t.answer(0);
    fireEvent.click(screen.getByTestId('assembly-tab-assembly#1'));
    await waitFor(() => expect(t.shownIds()).toHaveLength(2));

    fireEvent.click(screen.getByTestId('assembly-interference'));
    expect(screen.getByTestId('interference-panel')).toBeDefined();
    fireEvent.click(screen.getByTestId('interference-check'));
    await waitFor(() =>
      expect(screen.getByTestId('interference-status').textContent).toBe('1 pair overlaps.'),
    );
    expect(t.assembler.interference).toHaveBeenCalledWith('assembly#1', expect.any(Function));
    const pair = screen.getByTestId('interference-pair-inst#1/inst#2');
    expect(pair.textContent).toContain('Box 1 and Lid 1');
    expect(pair.textContent).toContain('200.00 mm³');

    // The pair: both instances selected, face by face, and the overlap outlined; the view is
    // not rebuilt for it.
    const builds = t.engine.api.setBodies.mock.calls.length;
    fireEvent.click(pair);
    const selected = t.selection.getState().selected as GeometryRef[];
    expect(selected).toHaveLength(12);
    expect(new Set(selected.map((i) => i.bodyId))).toEqual(
      new Set(['assembly#1/inst#1/extrude#1', 'assembly#1/inst#2/extrude#1']),
    );
    expect(screen.getByTestId('interference-overlay').getAttribute('data-edges')).toBe('12');
    expect(t.engine.api.setBodies.mock.calls.length).toBe(builds);
    // Picking it again clears both.
    fireEvent.click(pair);
    expect(t.selection.getState().selected).toEqual([]);
    expect(screen.queryByTestId('interference-overlay')).toBeNull();

    // Closing the panel drops the check.
    fireEvent.click(pair);
    fireEvent.click(screen.getByTestId('interference-close'));
    expect(screen.queryByTestId('interference-panel')).toBeNull();
    expect(screen.queryByTestId('interference-overlay')).toBeNull();
    expect(t.selection.getState().selected).toEqual([]);
  });
});

describe('App print workspace', () => {
  it("shows the setup's items on the bed with the build volume and shading, and closes again", async () => {
    let generation = 0;
    const regenerator: Regenerator = {
      regen: async (document) => ({
        generation: ++generation,
        ms: 1,
        parts: document.parts.map((p) => ({
          partId: p.id,
          features: [],
          bodies: [
            {
              bodyId: 'extrude#1',
              creator: 'extrude#1',
              solids: 1,
              view: boxBody({ id: `${p.id}/extrude#1`, min: [0, 0, 5] }),
            },
          ],
        })),
      }),
      onInvalidated: () => () => undefined,
    };
    // A thin wall on face 1 of every body asked about.
    const analyzer = {
      analyze: vi.fn(async (bodies: { id: string }[]) => ({
        status: 'done' as const,
        generation: 1,
        bodies: bodies.map((b) => ({
          id: b.id,
          thickness: new Float32Array(12).fill(0.5),
          gap: new Float32Array(12),
          flags: new Uint8Array(12),
          faces: [],
          samples: 12,
        })),
        issues: [{ kind: 'thinWall' as const, body: 0, face: 1, value: 0.5, area: 100 }],
        ms: 1,
      })),
      cancel: vi.fn(async () => undefined),
      terminate: vi.fn(),
    };
    const engine = fakeEngine();
    const documents = createDocumentStore(createDocument({ id: 'doc', name: 'Test' }));
    render(
      <App
        loader={{ load: async () => [], dispose: vi.fn(), regenerator }}
        createEngine={engine.factory}
        selection={createSelectionStore()}
        settings={createViewSettingsStore()}
        documents={documents}
        sketchSession={createSketchSession(immediateSolver({ dof: 0 }).solver)}
        measure={createMeasureStore()}
        model={createModelStore()}
        createPrintAnalyzer={() => analyzer}
      />,
    );
    const shownIds = () =>
      (engine.api.setBodies.mock.calls.at(-1)![0] as BodyInput[]).map((b) => b.id);
    await waitFor(() => expect(shownIds()).toEqual(['part#1/extrude#1']));
    expect(engine.api.setBuildVolume).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('open-print'));
    expect(screen.getByTestId('print-panel')).toBeTruthy();
    expect(screen.queryByTestId('feature-tree')).toBeNull();
    fireEvent.click(screen.getByTestId('print-add-setup'));
    fireEvent.click(screen.getByTestId('print-add-item'));
    await waitFor(() => expect(shownIds()).toEqual(['print:item#1:0:part#1/extrude#1']));
    const placed = (engine.api.setBodies.mock.calls.at(-1)![0] as BodyInput[])[0]!;
    // Centred on the X1 Carbon's bed and dropped onto it.
    expect(placed.transform?.translation).toEqual([123, 123, -5]);
    expect(engine.api.setBuildVolume).toHaveBeenLastCalledWith(
      expect.objectContaining({ height: 250 }),
    );
    expect(engine.api.setShading).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'overhang' }),
    );
    fireEvent.click(screen.getByTestId('print-shading-thickness'));
    expect(engine.api.setShading).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'thickness', minWall: 0.84 }),
    );
    // Walls and gaps in the worker, once the edits have stopped.
    await waitFor(() => expect(analyzer.analyze).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const thin = await screen.findByTestId('print-issue-thinWall');

    // Clicking an issue while lay flat is armed selects its faces, and is not the pick.
    fireEvent.click(screen.getByTestId('print-lay-flat'));
    expect(screen.getByTestId('print-lay-flat-hint')).toBeTruthy();
    fireEvent.click(thin);
    expect(screen.queryByTestId('print-lay-flat-hint')).toBeNull();
    const item = () => documents.getState().document.print.setups[0]!.items[0]!;
    expect(item().orientation.kind).toBe('asModelled');

    expect(analyzer.cancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('open-print'));
    // Closing the workspace cancels the analysis.
    expect(analyzer.cancel).toHaveBeenCalled();
    await waitFor(() => expect(shownIds()).toEqual(['part#1/extrude#1']));
    expect(engine.api.setBuildVolume).toHaveBeenLastCalledWith(null);
    expect(engine.api.setShading).toHaveBeenLastCalledWith(null);
    expect(screen.queryByTestId('print-panel')).toBeNull();
    // The setup is the document's, one undo step each.
    expect(documents.getState().document.print.setups[0]!.items).toHaveLength(1);
  });
});

describe('App Manufacture workspace', () => {
  it('replaces the feature tree and tools while open, one workspace at a time, and leaves modelling as it was', async () => {
    const t = setup();
    const { documents } = t;
    await act(async () => t.resolve([boxBody()]));
    expect(await screen.findByTestId('feature-tree')).toBeTruthy();
    expect(screen.getByRole('toolbar', { name: 'Features' })).toBeTruthy();
    const camButton = screen.getByTestId('open-cam');
    expect(camButton.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(camButton);
    expect(await screen.findByTestId('cam-tree')).toBeTruthy();
    expect(await screen.findByTestId('cam-panel')).toBeTruthy();
    expect(screen.queryByTestId('feature-tree')).toBeNull();
    expect(screen.queryByRole('toolbar', { name: 'Features' })).toBeNull();
    expect(camButton.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('cam-add-setup'));
    expect(documents.getState().document.cam.setups.map((s) => s.machine)).toEqual([
      'shapeoko-5-pro-4x4',
    ]);

    // Print takes over, and Manufacture closes; then the other way round.
    fireEvent.click(screen.getByTestId('open-print'));
    expect(screen.getByTestId('print-panel')).toBeTruthy();
    expect(screen.queryByTestId('cam-tree')).toBeNull();
    fireEvent.click(screen.getByTestId('open-cam'));
    expect(await screen.findByTestId('cam-tree')).toBeTruthy();
    expect(screen.queryByTestId('print-panel')).toBeNull();

    // Closed, the modelling UI is back as it was.
    fireEvent.click(screen.getByTestId('open-cam'));
    expect(screen.queryByTestId('cam-tree')).toBeNull();
    expect(screen.getByTestId('feature-tree')).toBeTruthy();
    expect(screen.getByRole('toolbar', { name: 'Features' })).toBeTruthy();
    // The setup is the document's.
    expect(documents.getState().document.cam.setups).toHaveLength(1);
  });
});
