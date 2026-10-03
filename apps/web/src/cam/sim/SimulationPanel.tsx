// The material-removal simulation in the toolpath preview (M5 plan, T5.3c): a toggle, and while it
// is on, the stock as the CAM worker simulates it drawn into the view (`overlay.ts`), following the
// preview's playback scrubber, with what it found: rapids through material, gouges into the part
// and material left on it.
//
// The simulation runs in a CAM worker of its own unless a client is passed, started when the
// toggle is first turned on and stopped when it is turned off (the worker's playback snapshots go
// with it), so generating toolpaths never waits behind a simulation. The gouge and leftover check
// needs the part's mesh: from the preview's geometry when it carries one, else from
// `loadPartMesh` (fetched again when the loader or the setup changes); without either, the panel
// says so and simulates the stock alone. While the simulation is shown, the preview hides its own
// translucent stock box (`onShownChange`), which would veil the simulated stock.

import {
  packToolpath,
  type Box3,
  type CamSimFrame,
  type Mesh,
  type SimReport,
  type Tool,
  type Toolpath,
  type WcsFrame,
} from '@manufakture/cam';
import type { CamClient } from '@manufakture/cam/client';
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { liveViewport } from '../../viewport/live';
import { spawnCamClient } from '../spawn';
import { SIM_COLORS } from './geometry';
import { SimulationOverlay } from './overlay';
import { SimulationRunner, type SimulationClient } from './runner';
import './sim.css';

/** What the preview simulates. */
export interface SimulationSource {
  /** The setup simulated: a part mesh fetched for another setup is never used. */
  readonly setupId: string;
  /** The program the preview plays, machine coordinates. */
  readonly toolpath: Toolpath;
  readonly tools: readonly Tool[];
  /** The stock box, machine coordinates. */
  readonly stock: Box3;
  /** The setup's WCS frame: machine to model. */
  readonly frame: WcsFrame;
  /** The part's mesh in model coordinates, when the preview has it. */
  readonly part: Mesh | null;
}

export interface SimulationPanelProps {
  source: SimulationSource | null;
  /** Moves done in the preview's playback. */
  done: number;
  /** The CAM worker client to simulate on; default one of the panel's own. */
  client?: SimulationClient | null;
  /** Fetches the part's mesh (model coordinates) when `source.part` is null. */
  loadPartMesh?: () => Promise<Mesh | null>;
  /** Told when the simulated stock is shown and hidden. */
  onShownChange?: (shown: boolean) => void;
}

/** A part mesh fetched by `loader` for `setupId`. */
interface LoadedPart {
  readonly loader: () => Promise<Mesh | null>;
  readonly setupId: string;
  readonly mesh: Mesh | null;
}

function mm(v: number): string {
  return `${v.toFixed(2)} mm`;
}

export function SimulationPanel({
  source,
  done,
  client,
  loadPartMesh,
  onShownChange,
}: SimulationPanelProps) {
  const api = useStore(liveViewport, (s) => s.api);
  const [enabled, setEnabled] = useState(false);
  const [report, setReport] = useState<SimReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedPart, setLoadedPart] = useState<LoadedPart | null>(null);
  const [runner, setRunner] = useState<SimulationRunner | null>(null);
  const overlay = useRef<SimulationOverlay | null>(null);
  const lastFrame = useRef<CamSimFrame | null>(null);
  const latest = useRef({ api, done });
  useEffect(() => {
    latest.current = { api, done };
  });

  // The part's mesh when the preview has none: fetched while the toggle is on, once per loader and
  // setup. A mesh fetched by another loader or for another setup is not this part's.
  const setupId = source?.setupId ?? null;
  const needsPart = enabled && source !== null && source.part === null;
  const fetched =
    loadedPart && loadedPart.loader === loadPartMesh && loadedPart.setupId === setupId
      ? loadedPart
      : null;
  useEffect(() => {
    if (!needsPart || !loadPartMesh || setupId === null || fetched) return;
    let live = true;
    const settle = (mesh: Mesh | null) => {
      if (live) setLoadedPart({ loader: loadPartMesh, setupId, mesh });
    };
    loadPartMesh().then(settle, () => settle(null));
    return () => {
      live = false;
    };
  }, [needsPart, loadPartMesh, setupId, fetched]);
  const part = source?.part ?? fetched?.mesh ?? null;

  // Tell the preview while the simulated stock is shown.
  useEffect(() => {
    if (!onShownChange) return;
    onShownChange(enabled);
    return () => onShownChange(false);
  }, [enabled, onShownChange]);

  // The runner, and the worker of the panel's own, live while the toggle is on.
  useEffect(() => {
    if (!enabled) return;
    let own: CamClient | null = null;
    const c = client ?? (own = spawnCamClient());
    const r = new SimulationRunner(c, {
      onFrame: (frame) => {
        lastFrame.current = frame;
        overlay.current?.update(frame.heightmap, frame.classes);
        setReport(frame.report);
        setError(null);
        latest.current.api?.requestRender();
      },
      onError: (message) => setError(message),
    });
    setRunner(r);
    return () => {
      r.stop();
      own?.terminate();
      lastFrame.current = null;
      setRunner(null);
      setReport(null);
      setError(null);
    };
  }, [enabled, client]);

  // A new program (or the part's mesh arriving) loads again, at the playback's move.
  useEffect(() => {
    if (!runner || !source) return;
    runner.setProgram(() => ({
      toolpath: packToolpath(source.toolpath),
      tools: source.tools,
      stock: source.stock,
      ...(part ? { part: { mesh: part, frame: source.frame } } : {}),
    }));
    // The last report stays up until the new program's first frame replaces it.
    lastFrame.current = null;
    runner.request(latest.current.done);
  }, [runner, source, part]);

  // The drawn stock: made again with the program's placement, and removed with the toggle.
  useEffect(() => {
    if (!enabled || !api || typeof api.addOverlay !== 'function' || !source) return;
    const o = new SimulationOverlay(source.frame, source.stock.max[2]);
    overlay.current = o;
    // A frame of this program that came before the view did.
    const frame = lastFrame.current;
    if (frame) o.update(frame.heightmap, frame.classes);
    const remove = api.addOverlay(o.root);
    return () => {
      remove();
      o.dispose();
      if (overlay.current === o) overlay.current = null;
      api.requestRender();
    };
  }, [enabled, api, source]);

  // Follow the scrubber.
  useEffect(() => {
    runner?.request(done);
  }, [runner, done]);

  return (
    <div className="cam-sim" data-testid="cam-sim">
      <label>
        <input
          type="checkbox"
          data-testid="cam-sim-toggle"
          checked={enabled}
          disabled={!source}
          onChange={(e) => setEnabled(e.target.checked)}
        />{' '}
        Simulate material removal
      </label>
      {enabled && (
        <div className="cam-sim-report" data-testid="cam-sim-report">
          {error && (
            <p className="field-note tip-warning" data-testid="cam-sim-error">
              The simulation failed: {error}
            </p>
          )}
          {!report && !error && <p className="field-note">Simulating...</p>}
          {report && (
            <>
              <p className="field-note" data-testid="cam-sim-status">
                Simulated to move {report.done} of {report.moveCount}, on {report.nx} x {report.ny}{' '}
                cells of {mm(report.cell)}.
              </p>
              <p
                className={`field-note${report.collisions.length > 0 ? ' tip-warning' : ''}`}
                data-testid="cam-sim-collisions"
              >
                {report.collisions.length === 0
                  ? 'No rapid runs through material.'
                  : `${report.collisions.length} ${report.collisions.length === 1 ? 'rapid runs' : 'rapids run'} through material: the first at move ${report.collisions[0]!.move + 1}, ${mm(report.collisions[0]!.depth)} deep.`}
              </p>
              {report.gougeCells === null ? (
                <p className="field-note" data-testid="cam-sim-gouges">
                  No part mesh: gouges and leftover material are not checked.
                </p>
              ) : (
                <>
                  <p
                    className={`field-note${report.gougeCells > 0 ? ' tip-warning' : ''}`}
                    data-testid="cam-sim-gouges"
                  >
                    <span className="cam-preview-swatch" style={{ background: SIM_COLORS.gouge }} />
                    {report.gougeCells === 0 || !report.worstGouge
                      ? `No gouge (tolerance ${mm(report.tolerance)}; a cut within ${mm(report.sideAllowance)} of a wall is not checked).`
                      : `Gouges: ${report.gougeCells} cells cut into the part, up to ${mm(report.worstGouge.depth)} deep at X ${report.worstGouge.at[0].toFixed(1)}, Y ${report.worstGouge.at[1].toFixed(1)} (cuts within ${mm(report.sideAllowance)} of a wall are not checked).`}
                  </p>
                  <p className="field-note" data-testid="cam-sim-leftover">
                    <span
                      className="cam-preview-swatch"
                      style={{ background: SIM_COLORS.leftover }}
                    />
                    {report.leftoverCells === 0 || !report.worstLeftover
                      ? 'No material left on the part.'
                      : `Left on the part${report.done < report.moveCount ? ' so far' : ''}: ${report.leftoverCells} cells, up to ${mm(report.worstLeftover.depth)}.`}
                  </p>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
