// The Open in slicer help (M3 plan, T3.3b; ADR 0012 decision 11): shown after the setup's 3MF was
// downloaded, for the chosen slicer and platform. The slicer is a preference kept with the view
// settings; closing the help marks it read for that slicer, so it is shown once per slicer unless
// asked for again. It is guidance, not an error: a region with a plain heading, not an alert.

import { useState } from 'react';
import { useStore } from 'zustand';
import {
  SLICER_IDS,
  isSlicerId,
  viewSettingsStore,
  type ViewSettingsStore,
} from '../state/viewSettings';
import {
  PLATFORMS,
  SLICERS,
  detectPlatform,
  handoffSteps,
  slicerInfo,
  type Platform,
} from './slicers';

export interface SlicerHandoffProps {
  /** The downloaded file's name (already made safe for a file system). */
  fileName: string;
  onClose: () => void;
  settings?: ViewSettingsStore;
  /** Default: the browser's own (`detectPlatform`). */
  platform?: Platform;
}

export function SlicerHandoff({
  fileName,
  onClose,
  settings = viewSettingsStore,
  platform: initialPlatform,
}: SlicerHandoffProps) {
  const slicer = useStore(settings, (s) => s.slicer);
  const [platform, setPlatform] = useState<Platform>(initialPlatform ?? detectPlatform());
  const info = slicerInfo(slicer);
  const close = () => {
    settings.getState().dismissSlicerHelp(slicer);
    onClose();
  };
  return (
    <section
      className="print-handoff"
      role="region"
      aria-label="Open in slicer"
      data-testid="slicer-handoff"
      data-slicer={slicer}
    >
      <h3>Open it in {info.name}</h3>
      <div className="print-handoff-choice">
        <label className="print-field">
          <span>Slicer</span>
          <select
            data-testid="slicer-choice"
            value={slicer}
            onChange={(e) => {
              if (isSlicerId(e.target.value)) settings.getState().setSlicer(e.target.value);
            }}
          >
            {SLICER_IDS.map((id) => (
              <option key={id} value={id}>
                {SLICERS.find((s) => s.id === id)!.name}
              </option>
            ))}
          </select>
        </label>
        <label className="print-field">
          <span>System</span>
          <select
            data-testid="slicer-platform"
            value={platform}
            onChange={(e) => {
              const p = PLATFORMS.find((q) => q.id === e.target.value);
              if (p) setPlatform(p.id);
            }}
          >
            {PLATFORMS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ol className="print-handoff-steps" data-testid="slicer-steps">
        {handoffSteps(fileName, slicer, platform).map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className="field-note">{info.colours}</p>
      <div className="dialog-buttons">
        <button
          type="button"
          className="primary"
          data-testid="slicer-handoff-close"
          onClick={close}
        >
          Got it
        </button>
      </div>
    </section>
  );
}
