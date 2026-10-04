// The read-only viewer's page (T7.3b): opens a `.mfkview` from a picked or dropped file or from the
// link's fragment, and shows it with the app's viewport engine and view toolbar (standard views,
// projection, section, edges, grid). Beside the 3D view: the bodies with a visibility toggle each,
// the size of what is shown with an optional bounding box, a point-to-point measure, and Open in
// manufakture when the bundle carries its source.
//
// Every string from the bundle is rendered as React text, never as markup, after displayText.ts
// has taken out bidi overrides and control characters.

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Box3, Box3Helper, Color, Vector3 } from 'three';
import type { DisplayUnits } from '@manufakture/core';
import type { Mfkview } from '@manufakture/io/mfkview';
import { formatLengthIn, formatMassIn, formatVolumeIn } from '../measure/format';
import { createSelectionStore } from '../state/selection';
import { createViewSettingsStore } from '../state/viewSettings';
import { testHooksEnabled } from '../testHooks';
import { ViewportEngine } from '../viewport/engine';
import { Toolbar } from '../viewport/Toolbar';
import type { EngineFactory, ViewportApi } from '../viewport/Viewport';
import { displayText } from './displayText';
import { offerSource } from './handoff';
import {
  checkSourceUrl,
  fetchBundle,
  loadErrorMessage,
  openBundle,
  readBundleFile,
  rulesFor,
  sourceFromHash,
} from './load';
import { distanceOf, measureDelegate, nextMeasurement, type Measurement } from './measure';
import { boundsOf, viewerBodies, type ViewerBody } from './scene';
import { viewerUnits } from './units';

const createDefaultEngine: EngineFactory = (canvas, stores) => new ViewportEngine(canvas, stores);

interface Loaded {
  view: Mfkview;
  bodies: ViewerBody[];
  name: string;
  units: DisplayUnits;
}

type Status =
  { kind: 'idle' } | { kind: 'loading'; text: string } | { kind: 'error'; text: string };

export interface ViewerAppProps {
  createEngine?: EngineFactory;
  /** The page's location (tests pass their own). */
  location?: Pick<Location, 'hash' | 'hostname' | 'href'>;
  fetch?: typeof fetch;
  offer?: typeof offerSource;
}

export function ViewerApp({
  createEngine = createDefaultEngine,
  location = window.location,
  fetch: fetchImpl,
  offer = offerSource,
}: ViewerAppProps) {
  const selection = useMemo(() => createSelectionStore(), []);
  const settings = useMemo(() => createViewSettingsStore(), []);
  const [engine, setEngine] = useState<ViewportApi | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [measuring, setMeasuring] = useState(false);
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  const [showBox, setShowBox] = useState(false);
  const [dragging, setDragging] = useState(false);
  const loads = useRef(0);
  const download = useRef<AbortController | null>(null);

  const attach = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas) return;
      let api: ViewportApi;
      try {
        api = createEngine(canvas, { selection, settings });
      } catch (e) {
        setEngineError(e instanceof Error ? e.message : String(e));
        return;
      }
      setEngineError(null);
      setEngine(api);
      if (testHooksEnabled) window.__manufakture = { viewport: api, selection, settings };
      return () => {
        if (window.__manufakture?.viewport === api) delete window.__manufakture;
        api.dispose();
        setEngine(null);
      };
    },
    [createEngine, selection, settings],
  );

  /** Show the bundle `bytes` resolves to; `label` names where it came from in messages. */
  const load = useCallback(async (bytes: () => Promise<Uint8Array>, label: string) => {
    const mine = ++loads.current;
    setStatus({ kind: 'loading', text: `Opening ${label}\u2026` });
    try {
      const view = openBundle(await bytes());
      if (mine !== loads.current) return;
      const units = viewerUnits(view.manifest.units.display);
      setLoaded({
        view,
        bodies: viewerBodies(view),
        name: displayText(view.manifest.name),
        units,
      });
      setHidden(new Set());
      setMeasurement(null);
      setStatus({ kind: 'idle' });
    } catch (e) {
      if (mine !== loads.current) return;
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setStatus({ kind: 'error', text: loadErrorMessage(e) });
    }
  }, []);

  const openFile = useCallback(
    (file: File) => {
      download.current?.abort();
      void load(() => readBundleFile(file), displayText(file.name, 'the file'));
    },
    [load],
  );

  // A link: the bundle's address in the fragment, read on open and whenever it changes.
  const openLink = useCallback(() => {
    const raw = sourceFromHash(location.hash);
    if (raw === null) return;
    download.current?.abort();
    const controller = new AbortController();
    download.current = controller;
    const rules = rulesFor(location);
    void load(async () => {
      const url = checkSourceUrl(raw, rules);
      return fetchBundle(url, {
        rules,
        signal: controller.signal,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
        onProgress: (n, total) =>
          setStatus({
            kind: 'loading',
            text: total
              ? `Downloading\u2026 ${Math.round((n / total) * 100)}%`
              : 'Downloading\u2026',
          }),
      });
    }, 'the linked view');
  }, [load, location, fetchImpl]);

  useEffect(() => {
    // The link the page was opened with is read once mounted, as a later change of it is.
    let live = true;
    queueMicrotask(() => {
      if (live) openLink();
    });
    window.addEventListener('hashchange', openLink);
    return () => {
      live = false;
      window.removeEventListener('hashchange', openLink);
      download.current?.abort();
    };
  }, [openLink]);

  const shown = useMemo(
    () => loaded?.bodies.filter((b) => !hidden.has(b.id)) ?? [],
    [loaded, hidden],
  );
  const box = useMemo(() => boundsOf(shown), [shown]);

  // The viewport follows what is shown; a newly opened view is framed.
  const fitted = useRef<Loaded | null>(null);
  useEffect(() => {
    if (!engine) return;
    const fresh = fitted.current !== loaded;
    fitted.current = loaded;
    engine.setBodies(
      shown.map((b) => b.input),
      fresh,
    );
  }, [engine, loaded, shown]);

  useEffect(() => {
    if (!engine || !showBox || !box) return;
    const helper = new Box3Helper(
      new Box3(new Vector3(...box.min), new Vector3(...box.max)),
      new Color(0x1a6fe0),
    );
    const remove = engine.addOverlay(helper);
    return () => {
      remove();
      helper.geometry.dispose();
      (helper.material as { dispose(): void }).dispose();
    };
  }, [engine, showBox, box]);

  useEffect(() => {
    if (!engine || !measuring) return;
    engine.setPointerDelegate(
      measureDelegate(
        (x, y) => engine.surfacePoint(x, y),
        (p) => setMeasurement((m) => nextMeasurement(m, p)),
      ),
    );
    return () => engine.setPointerDelegate(null);
  }, [engine, measuring]);

  const openInApp = () => {
    if (!loaded) return;
    let source: Uint8Array | null;
    try {
      source = loaded.view.readSource();
    } catch (e) {
      setStatus({
        kind: 'error',
        text: e instanceof Error ? e.message : 'The source in this view cannot be read.',
      });
      return;
    }
    if (!source) return;
    offer(loaded.name, source, { appUrl: new URL('./', location.href).toString() });
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) openFile(file);
  };

  const units = loaded?.units ?? viewerUnits('mm');
  const assembly = loaded?.view.manifest.kind === 'assembly';
  const distance = distanceOf(measurement);

  return (
    <div className="app viewer">
      <header className="app-header viewer-header">
        <h1>manufakture viewer</h1>
        {loaded && (
          <span className="viewer-name" data-testid="viewer-name" title={loaded.name}>
            {loaded.name}
          </span>
        )}
        <label className="viewer-button">
          Open file{'\u2026'}
          <input
            type="file"
            accept=".mfkview,application/vnd.manufakture.view+zip"
            data-testid="viewer-file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) openFile(file);
            }}
          />
        </label>
        {loaded?.view.manifest.source && (
          <button
            type="button"
            className="viewer-button"
            data-testid="viewer-open-app"
            onClick={openInApp}
            title="Open an editable copy of this model in manufakture, in a new tab"
          >
            Open in manufakture
          </button>
        )}
        {engine && <Toolbar viewport={engine} selection={selection} settings={settings} />}
      </header>
      <main className="app-main viewer-main">
        <aside className="viewer-panel" aria-label="Model">
          {status.kind === 'loading' && (
            <p className="viewer-status" data-testid="viewer-status" role="status">
              {status.text}
            </p>
          )}
          {status.kind === 'error' && (
            <p className="viewer-error" data-testid="viewer-error" role="alert">
              {status.text}
            </p>
          )}
          {loaded ? (
            <>
              <section>
                <h2>
                  Bodies <span className="viewer-count">{loaded.bodies.length}</span>
                </h2>
                <ul className="viewer-bodies" data-testid="viewer-bodies">
                  {loaded.bodies.map((b) => (
                    <li key={b.id} data-body={b.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={!hidden.has(b.id)}
                          aria-label={`Show ${b.name}`}
                          onChange={(e) =>
                            setHidden((h) => {
                              const next = new Set(h);
                              if (e.target.checked) next.delete(b.id);
                              else next.add(b.id);
                              return next;
                            })
                          }
                        />
                        <span
                          className="viewer-swatch"
                          style={{ background: b.info.color ?? '#c2cad3' }}
                        />
                        <span className="viewer-body-name">{b.name}</span>
                      </label>
                      {assembly && <span className="viewer-detail">{b.instanceName}</span>}
                      <span className="viewer-detail">
                        {[
                          b.info.material ? displayText(b.info.material.name, '') : '',
                          b.info.volume !== null ? formatVolumeIn(b.info.volume, units) : '',
                          b.info.mass !== null ? formatMassIn(b.info.mass, units) : '',
                        ]
                          .filter((s) => s !== '')
                          .join(', ')}
                      </span>
                    </li>
                  ))}
                </ul>
                {hidden.size > 0 && (
                  <button type="button" onClick={() => setHidden(new Set())}>
                    Show all
                  </button>
                )}
              </section>
              <section>
                <h2>Size</h2>
                <p data-testid="viewer-size">
                  {box
                    ? [0, 1, 2]
                        .map(
                          (k) => `${'XYZ'[k]} ${formatLengthIn(box.max[k]! - box.min[k]!, units)}`,
                        )
                        .join(', ')
                    : 'Nothing shown'}
                </p>
                <label>
                  <input
                    type="checkbox"
                    checked={showBox}
                    onChange={(e) => setShowBox(e.target.checked)}
                  />
                  Show bounding box
                </label>
              </section>
              <section>
                <h2>Measure</h2>
                <button
                  type="button"
                  aria-pressed={measuring}
                  data-testid="viewer-measure"
                  onClick={() => {
                    setMeasuring((m) => !m);
                    setMeasurement(null);
                  }}
                >
                  {measuring ? 'Stop measuring' : 'Measure distance'}
                </button>
                {measuring && (
                  <p className="viewer-detail" data-testid="viewer-distance">
                    {distance
                      ? `${formatLengthIn(distance.value, units)} (X ${formatLengthIn(distance.dx, units)}, Y ${formatLengthIn(distance.dy, units)}, Z ${formatLengthIn(distance.dz, units)})`
                      : measurement
                        ? 'Click a second point on the model.'
                        : 'Click two points on the model.'}
                  </p>
                )}
              </section>
            </>
          ) : (
            status.kind !== 'loading' && (
              <p className="viewer-hint">
                Open a published view (.mfkview): choose Open file, drop one on the page, or follow
                a share link.
              </p>
            )
          )}
        </aside>
        <div
          className={`viewport viewer-stage${dragging ? ' viewer-dragging' : ''}`}
          data-testid="viewer-drop"
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <canvas
            ref={attach}
            className="viewport-canvas"
            tabIndex={0}
            aria-label="3D view"
            data-testid="viewer-canvas"
          />
          {engine && measurement && <MeasureMarks engine={engine} measurement={measurement} />}
          {engineError !== null && (
            <div className="viewport-error" role="alert">
              The 3D view could not start: {engineError}. It needs a browser with WebGL 2.
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

/** The measured points and the line between them, over the canvas, following the camera. */
function MeasureMarks({ engine, measurement }: { engine: ViewportApi; measurement: Measurement }) {
  const [, setVersion] = useState(0);
  useEffect(() => engine.onViewChange(() => setVersion((v) => v + 1)), [engine]);
  const a = engine.projectToCanvas(measurement.from);
  const b = measurement.to ? engine.projectToCanvas(measurement.to) : null;
  return (
    <svg className="viewer-measure-svg" data-testid="viewer-measure-marks" aria-hidden="true">
      {b && <line className="viewer-measure-line" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />}
      <circle className="viewer-measure-point" cx={a.x} cy={a.y} r={4} />
      {b && <circle className="viewer-measure-point" cx={b.x} cy={b.y} r={4} />}
    </svg>
  );
}
