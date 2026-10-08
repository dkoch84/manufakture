// The toolpath preview and playback (M5 plan, T5.3b), under the Manufacture workspace's operation
// list. It draws into the viewport on screen (`liveViewport`) while the workspace is open, and
// takes everything away again when it closes, so the modelling view is unchanged:
//
// - the stock as a translucent box and the WCS gizmo, from the last generation (or, before the
//   first, from the setup's resolved geometry);
// - the last generation's toolpaths, linked into the job (`job.ts`), one line buffer per
//   operation and move class (`geometry.ts`, `scene.ts`);
// - per-operation visibility, statistics per operation and for the job (lengths, estimated time
//   from the machine's rapid rate and the feeds), and a playback scrubber with a tool marker:
//   at move n the tool sits where move n ends, and only the moves up to it are drawn;
// - the material-removal simulation and gouge check (T5.3c, `../sim/`), toggled here and
//   following the scrubber.

import type { CamSetup } from '@manufakture/core';
import { JOB_LINK_OP, toModel, type Mesh, type Vec3 } from '@manufakture/cam';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { testHooksEnabled } from '../../testHooks';
import { liveViewport } from '../../viewport/live';
import type { CamUiStore } from '../state';
import {
  minutesAt,
  movesDoneAt,
  previewGeometry,
  toolPositionAt,
  type PreviewPath,
} from './geometry';
import { PLAYBACK_SPEEDS, formatLength, formatMinutes } from './format';
import { CLEARING_SUFFIX } from '@manufakture/cam/export';
import { previewJob } from './job';
import { previewPlacement } from './placement';
import { MOVE_COLORS, PreviewOverlay, operationColor } from './scene';
import { SimulationPanel, type SimulationSource } from '../sim/SimulationPanel';
import type { SimulationClient } from '../sim/runner';

/** What the test hook reports. */
export interface CamPreviewHookState {
  moveCount: number;
  done: number;
  /** The tool tip, model coordinates, or null without a toolpath. */
  tool: Vec3 | null;
  /** The tool tip, machine coordinates. */
  toolMachine: Vec3 | null;
  /** Where the overlay's tool marker is drawn, world coordinates; null when none is drawn. */
  marker: Vec3 | null;
  buffers: number;
  hidden: string[];
  message: string | null;
}

export interface ToolpathPreviewProps {
  setup: CamSetup;
  camUi: CamUiStore;
  /** The simulation's CAM worker client; default a worker of the simulation's own. */
  simulationClient?: SimulationClient | null;
  /** Fetches the part's mesh (model coordinates) for the gouge check when the geometry has none. */
  loadPartMesh?: () => Promise<Mesh | null>;
}

export function ToolpathPreview({
  setup,
  camUi,
  simulationClient,
  loadPartMesh,
}: ToolpathPreviewProps) {
  const toolpaths = useStore(camUi, (s) => s.toolpaths);
  const geometry = useStore(camUi, (s) => s.geometry);
  const api = useStore(liveViewport, (s) => s.api);
  const data = toolpaths?.setupId === setup.id ? toolpaths : null;
  const shownGeometry = geometry?.setupId === setup.id ? geometry : null;

  const suppressedKey = setup.operations
    .filter((o) => o.suppressed)
    .map((o) => o.id)
    .join('\n');
  // A reply the preview cannot read is reported in the panel, never thrown into the workspace.
  const built = useMemo(() => {
    if (!data) return null;
    try {
      const job = previewJob(data, new Set(suppressedKey.split('\n')));
      return { job, path: previewGeometry(job.toolpath, { rapidRate: data.rapidRate }) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [data, suppressedKey]);
  const job = built && 'job' in built ? built.job : null;
  const path: PreviewPath | null = built && 'path' in built ? built.path : null;
  const placement = useMemo(() => previewPlacement(data, shownGeometry), [data, shownGeometry]);
  const partMesh = shownGeometry?.mesh ?? null;
  const simulation = useMemo((): SimulationSource | null => {
    if (!job || !placement || job.toolpath.entries.length === 0) return null;
    return {
      setupId: setup.id,
      toolpath: job.toolpath,
      tools: [...job.tools.values()],
      stock: placement.stock,
      frame: placement.frame,
      part: partMesh,
    };
  }, [setup.id, job, placement, partMesh]);
  // A V-carve's clearing is generated as an operation of its own, just before it.
  const opOrder = setup.operations
    .flatMap((o) =>
      o.kind === 'vcarve' && o.clearing ? [`${o.id}${CLEARING_SUFFIX}`, o.id] : [o.id],
    )
    .join('\n');
  const colors = useMemo(
    () => new Map(opOrder.split('\n').map((id, i) => [id, operationColor(i)])),
    [opOrder],
  );

  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const moveCount = path?.moveCount ?? 0;
  const [done, setDone] = useState(moveCount);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(20);
  // A new program shows whole, stopped.
  useEffect(() => {
    setDone(moveCount);
    setPlaying(false);
  }, [path, moveCount]);

  // The overlay: made again when what it draws changes, and removed when the preview goes.
  const overlay = useRef<PreviewOverlay | null>(null);
  // The simulated stock replaces the translucent stock box while it is shown.
  const [simShown, setSimShown] = useState(false);
  useEffect(() => {
    if (!api || typeof api.addOverlay !== 'function' || !placement) return;
    const o = new PreviewOverlay({
      frame: placement.frame,
      stock: placement.stock,
      path,
      colors,
      tools: job?.tools ?? new Map(),
    });
    overlay.current = o;
    const remove = api.addOverlay(o.root);
    return () => {
      remove();
      o.dispose();
      if (overlay.current === o) overlay.current = null;
    };
  }, [api, placement, path, colors, job]);
  useEffect(() => {
    overlay.current?.setHidden(hidden);
    overlay.current?.setProgress(done);
    overlay.current?.setStockVisible(!simShown);
    api?.requestRender();
  }, [api, hidden, done, simShown, placement, path, colors, job]);

  // Playback: estimated machine time advances `speed` times faster than real time.
  useEffect(() => {
    if (!playing || !path) return;
    let start: number | null = null;
    const from = done >= path.moveCount ? 0 : minutesAt(path, done);
    const total = minutesAt(path, path.moveCount);
    let handle = requestAnimationFrame(function tick(now) {
      start ??= now;
      const t = from + ((now - start) / 60_000) * speed;
      if (t >= total) {
        setDone(path.moveCount);
        setPlaying(false);
        return;
      }
      setDone(movesDoneAt(path, t));
      handle = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(handle);
    // `done` is read once, where the playback starts; it must not restart the loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, path, speed]);

  // The test hook: the playback state and a scrubber that tests can set.
  const latest = useRef({ path, done, hidden, placement, job });
  latest.current = { path, done, hidden, placement, job };
  useEffect(() => {
    if (!testHooksEnabled) return;
    const hook = {
      state(): CamPreviewHookState {
        const { path: p, done: d, hidden: h, placement: pl, job: j } = latest.current;
        const machine = p && p.moveCount > 0 ? toolPositionAt(p, d) : null;
        return {
          moveCount: p?.moveCount ?? 0,
          done: d,
          toolMachine: machine,
          tool: machine && pl ? toModel(pl.frame, machine) : null,
          marker: overlay.current?.toolMarkerPosition() ?? null,
          buffers: p?.buffers.length ?? 0,
          hidden: [...h],
          message: j?.message ?? null,
        };
      },
      seek(n: number): void {
        const count = latest.current.path?.moveCount ?? 0;
        setPlaying(false);
        setDone(Math.min(Math.max(Math.round(n), 0), count));
      },
    };
    window.__manufakture = { ...window.__manufakture, camPreview: hook };
    return () => {
      if (window.__manufakture?.camPreview === hook) {
        const rest = { ...window.__manufakture };
        delete rest.camPreview;
        window.__manufakture = rest;
      }
    };
  }, []);

  if (!data || !job || !path) {
    return (
      <div className="cam-preview" data-testid="cam-preview">
        <p className="field-note">
          {built && 'error' in built
            ? `The toolpaths cannot be previewed: ${built.error}`
            : placement
              ? 'The stock and WCS are shown in the view. Generate to preview the toolpaths.'
              : 'Generate to preview the toolpaths.'}
        </p>
      </div>
    );
  }

  const toggle = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setHidden(next);
  };
  const current = done > 0 ? path.ops[path.opOf[done - 1]!] : undefined;
  const currentName =
    current === JOB_LINK_OP
      ? 'linking'
      : (job.operations.find((o) => o.id === current)?.name ?? current ?? 'start');
  const hasLinks = path.ops.includes(JOB_LINK_OP);
  const total = job.stats?.estimate.totalMinutes ?? minutesAt(path, path.moveCount);

  return (
    <div className="cam-preview" data-testid="cam-preview">
      <h3>Preview</h3>
      {job.message && (
        <p className="field-note tip-warning" data-testid="cam-preview-message">
          {job.message}
        </p>
      )}
      <table className="cam-preview-stats" data-testid="cam-preview-stats">
        <thead>
          <tr>
            <th scope="col">Show</th>
            <th scope="col">Operation</th>
            <th scope="col">Cut</th>
            <th scope="col">Time</th>
          </tr>
        </thead>
        <tbody>
          {job.operations.map((op) => (
            <tr
              key={op.id}
              data-testid={`cam-preview-op-${op.id}`}
              className={op.included ? '' : 'excluded'}
            >
              <td>
                <input
                  type="checkbox"
                  aria-label={`Show ${op.name}`}
                  data-testid={`cam-preview-show-${op.id}`}
                  checked={!hidden.has(op.id)}
                  disabled={!op.included}
                  onChange={() => toggle(op.id)}
                />
              </td>
              <td>
                <span
                  className="cam-preview-swatch"
                  style={{ background: colors.get(op.id) ?? MOVE_COLORS.link }}
                />
                {op.name}
              </td>
              <td>{op.stats ? formatLength(op.stats.cutLength) : '-'}</td>
              <td>{op.stats ? formatMinutes(op.stats.estimate.totalMinutes) : '-'}</td>
            </tr>
          ))}
          {hasLinks && (
            <tr data-testid="cam-preview-op-link">
              <td>
                <input
                  type="checkbox"
                  aria-label="Show linking moves"
                  data-testid="cam-preview-show-link"
                  checked={!hidden.has(JOB_LINK_OP)}
                  onChange={() => toggle(JOB_LINK_OP)}
                />
              </td>
              <td colSpan={3}>
                <span className="cam-preview-swatch" style={{ background: MOVE_COLORS.rapid }} />
                Linking moves
              </td>
            </tr>
          )}
        </tbody>
        {job.stats && (
          <tfoot>
            <tr data-testid="cam-preview-job">
              <td />
              <th scope="row">Job</th>
              <td>{formatLength(job.stats.cutLength)}</td>
              <td>{formatMinutes(job.stats.estimate.totalMinutes)}</td>
            </tr>
            <tr>
              <td />
              <td colSpan={3} className="field-note">
                Rapids {formatLength(job.stats.rapidLength)}, {job.stats.moveCount} moves,{' '}
                {job.stats.toolChanges} tool {job.stats.toolChanges === 1 ? 'change' : 'changes'}.
                Times are estimates: no acceleration, tool changes or spin-up.
              </td>
            </tr>
          </tfoot>
        )}
      </table>
      <div className="cam-preview-legend" aria-label="Move colours">
        <span>
          <span className="cam-preview-swatch" style={{ background: MOVE_COLORS.plunge }} />
          plunge
        </span>
        <span>
          <span className="cam-preview-swatch" style={{ background: MOVE_COLORS.ramp }} />
          ramp
        </span>
        <span>
          <span className="cam-preview-swatch dashed" />
          rapid
        </span>
      </div>
      <div className="cam-preview-playback">
        <button
          type="button"
          data-testid="cam-preview-play"
          disabled={path.moveCount === 0}
          onClick={() => setPlaying(!playing)}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <select
          aria-label="Playback speed"
          data-testid="cam-preview-speed"
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
        >
          {PLAYBACK_SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </select>
        <input
          type="range"
          aria-label="Move"
          data-testid="cam-preview-scrubber"
          min={0}
          max={path.moveCount}
          step={1}
          value={done}
          onChange={(e) => {
            setPlaying(false);
            setDone(Number(e.target.value));
          }}
        />
      </div>
      <p className="field-note" role="status" data-testid="cam-preview-position">
        Move {done} of {path.moveCount} ({currentName}), {formatMinutes(minutesAt(path, done))} of{' '}
        {formatMinutes(total)}
      </p>
      <SimulationPanel
        source={simulation}
        done={done}
        {...(simulationClient !== undefined ? { client: simulationClient } : {})}
        {...(loadPartMesh ? { loadPartMesh } : {})}
        onShownChange={setSimShown}
      />
    </div>
  );
}
