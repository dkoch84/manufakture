// The Export menu (STL, 3MF, STEP, with the mesh tolerance and, in a part of
// several bodies, which bodies to write: the shown ones unless changed) and the
// Import button (a STEP or STL file picker), in the app header.

import { EXPORT_TOLERANCES, type ExportTolerancePreset } from '@manufakture/io';
import { useEffect, useRef, useState } from 'react';
import type { ExportFormat } from './actions';

const FORMATS: readonly [ExportFormat, string, string][] = [
  ['stl', 'STL', 'Binary STL, every body in one file'],
  ['stl-each', 'STL, one file per body', 'Binary STL, a file for each body'],
  ['3mf', '3MF', '3MF for slicers: millimetres, one named object per body'],
  ['step', 'STEP', 'STEP AP214: the exact B-rep, one named product per body'],
];

const TOLERANCE_LABELS: Record<ExportTolerancePreset, string> = {
  draft: 'Draft',
  normal: 'Normal',
  fine: 'Fine',
};

function toleranceTitle(preset: ExportTolerancePreset): string {
  const t = EXPORT_TOLERANCES[preset];
  const degrees = ((t.angular * 180) / Math.PI).toFixed(1);
  return `Chordal ${t.chordal} mm, angular ${degrees} degrees`;
}

/** A body the menu offers: its viewport id, its name, and whether it is hidden in the view. */
export interface ExportableBody {
  id: string;
  name: string;
  hidden: boolean;
}

export interface ExportMenuProps {
  disabled?: boolean;
  /** The bodies of the part; with several, the menu lets the user choose (default: none known). */
  bodies?: readonly ExportableBody[];
  /** `ids`: the bodies chosen, in body order. */
  onExport: (format: ExportFormat, tolerance: ExportTolerancePreset, ids: string[]) => void;
}

const NO_BODIES: readonly ExportableBody[] = [];

export function ExportMenu({ disabled = false, bodies = NO_BODIES, onExport }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [tolerance, setTolerance] = useState<ExportTolerancePreset>('normal');
  // The bodies chosen while the menu is open; it opens with the shown ones.
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const several = bodies.length > 1;
  const ids = several
    ? bodies.filter((b) => chosen.has(b.id)).map((b) => b.id)
    : bodies.map((b) => b.id);
  const root = useRef<HTMLDivElement>(null);
  // A press anywhere else closes the menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node | null)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);
  return (
    <div className="sketch-menu io-menu" ref={root}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (!open) setChosen(new Set(bodies.filter((b) => !b.hidden).map((b) => b.id)));
          setOpen(!open);
        }}
        title="Export the bodies as STL, 3MF or STEP"
      >
        Export
      </button>
      {open && (
        <div
          className="menu"
          role="menu"
          aria-label="Export format"
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        >
          {FORMATS.map(([format, label, title]) => (
            <button
              key={format}
              type="button"
              role="menuitem"
              title={title}
              data-testid={`export-${format}`}
              disabled={several && ids.length === 0}
              onClick={() => {
                setOpen(false);
                onExport(format, tolerance, ids);
              }}
            >
              {label}
            </button>
          ))}
          {several && (
            <fieldset className="io-bodies" data-testid="export-bodies">
              <legend>Bodies</legend>
              {bodies.map((b) => (
                <label key={b.id} title={b.hidden ? 'Hidden in the view' : undefined}>
                  <input
                    type="checkbox"
                    checked={chosen.has(b.id)}
                    onChange={(e) => {
                      const next = new Set(chosen);
                      if (e.target.checked) next.add(b.id);
                      else next.delete(b.id);
                      setChosen(next);
                    }}
                  />
                  {b.name}
                  {b.hidden ? ' (hidden)' : ''}
                </label>
              ))}
            </fieldset>
          )}
          <label className="io-tolerance" title={toleranceTitle(tolerance)}>
            Mesh tolerance
            <select
              value={tolerance}
              onChange={(e) => setTolerance(e.target.value as ExportTolerancePreset)}
            >
              {(Object.keys(EXPORT_TOLERANCES) as ExportTolerancePreset[]).map((p) => (
                <option key={p} value={p} title={toleranceTitle(p)}>
                  {TOLERANCE_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}

export interface ImportButtonProps {
  disabled?: boolean;
  onFile: (file: File) => void;
}

export function ImportButton({ disabled = false, onFile }: ImportButtonProps) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
        title="Import a STEP or STL file as a reference body"
      >
        Import
      </button>
      <input
        ref={input}
        type="file"
        accept=".step,.stp,.stl,model/step,model/stl"
        hidden
        data-testid="import-input"
        aria-label="Import file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Clear it, so picking the same file again fires a change.
          e.target.value = '';
          if (file) onFile(file);
        }}
      />
    </>
  );
}
