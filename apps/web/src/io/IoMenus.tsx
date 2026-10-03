// The Export menu (STL, 3MF, STEP, with the mesh tolerance and, in a part of
// several bodies, which bodies to write: the shown ones unless changed; a hidden
// body is never written unless ticked; in an assembly, the whole assembly with
// its parts placed), the choice to export every configuration with its
// progress, the laser and plasma export (DXF or SVG outlines, which opens its
// own dialog), IFC of a construction document's building (written in the regen
// worker), and the Import button (a STEP or STL file picker), in the app header.

import { EXPORT_TOLERANCES, type ExportTolerancePreset } from '@manufakture/io';
import { useEffect, useRef, useState } from 'react';
import type { ExportFormat } from './actions';
import { chosenBodies, type ExportableBody } from './chosenBodies';

export type { ExportableBody };

const FORMATS: readonly [ExportFormat, string, string][] = [
  ['stl', 'STL', 'Binary STL, every body in one file'],
  ['stl-each', 'STL, one file per body', 'Binary STL, a file for each body'],
  ['3mf', '3MF', '3MF for slicers: millimetres, one named object per body'],
  ['step', 'STEP', 'STEP AP214: the exact B-rep, one named product per body and framing member'],
];

/** In an assembly: the whole assembly, each part once and placed per instance; one file. */
const ASSEMBLY_FORMATS: readonly [ExportFormat, string, string][] = [
  ['stl', 'STL', 'Binary STL, every instance placed, in one file'],
  ['3mf', '3MF', '3MF for slicers: one object per part, placed once per instance'],
  ['step', 'STEP', 'STEP AP214 assembly: each part once, every instance a placed component'],
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

export interface ExportMenuProps {
  disabled?: boolean;
  /**
   * The tab is an assembly: the menu exports it whole (no body choice, no one file per body, no
   * configurations).
   */
  assembly?: boolean;
  /** The bodies of the part; with several, the menu lets the user choose (default: none known). */
  bodies?: readonly ExportableBody[];
  /** `ids`: the bodies chosen, in body order. */
  onExport: (format: ExportFormat, tolerance: ExportTolerancePreset, ids: string[]) => void;
  /**
   * How many configuration rows the document has; with any, the menu offers to export every
   * configuration, one file per row, through `onExportAll`.
   */
  configurations?: number;
  onExportAll?: (
    format: Exclude<ExportFormat, 'stl-each'>,
    tolerance: ExportTolerancePreset,
    ids: string[],
  ) => void;
  /** Open the laser and plasma export (a part studio only); absent: not offered. */
  onLaser?: () => void;
  /** Export the part studio's building as IFC (a construction document only); absent: not offered. */
  onIfc?: () => void;
}

const NO_BODIES: readonly ExportableBody[] = [];
const NO_TICKS: ReadonlyMap<string, boolean> = new Map();

export function ExportMenu({
  disabled = false,
  assembly = false,
  bodies: givenBodies = NO_BODIES,
  onExport,
  configurations: givenConfigurations = 0,
  onExportAll,
  onLaser,
  onIfc,
}: ExportMenuProps) {
  const bodies = assembly ? NO_BODIES : givenBodies;
  const configurations = assembly ? 0 : givenConfigurations;
  const [open, setOpen] = useState(false);
  const [tolerance, setTolerance] = useState<ExportTolerancePreset>('normal');
  // The ticks the user changed while the menu is open; every other body follows its visibility,
  // so hiding or showing one with the menu open is reflected at once.
  const [ticks, setTicks] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [every, setEvery] = useState(false);
  const several = bodies.length > 1;
  // One body has no tick: it is written unless it is hidden.
  const ids = chosenBodies(bodies, several ? ticks : NO_TICKS);
  // A scene without regen lists no bodies and exports what the kernel holds.
  const nothing = bodies.length > 0 && ids.length === 0;
  const all = every && configurations > 0 && onExportAll !== undefined;
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
          if (!open) setTicks(new Map());
          setOpen(!open);
        }}
        title={
          assembly
            ? 'Export the assembly as STL, 3MF or STEP'
            : 'Export the bodies as STL, 3MF or STEP'
        }
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
          {(assembly ? ASSEMBLY_FORMATS : FORMATS).map(([format, label, title]) => (
            <button
              key={format}
              type="button"
              role="menuitem"
              title={all && format === 'stl-each' ? 'One file per configuration: use STL' : title}
              data-testid={`export-${format}`}
              disabled={nothing || (all && format === 'stl-each')}
              onClick={() => {
                setOpen(false);
                if (all && format !== 'stl-each' && onExportAll)
                  onExportAll(format, tolerance, ids);
                else onExport(format, tolerance, ids);
              }}
            >
              {label}
            </button>
          ))}
          {!assembly && onLaser && (
            <button
              type="button"
              role="menuitem"
              title="DXF or SVG outlines of faces, sketch regions or a section, for laser and plasma cutting, with kerf compensation"
              data-testid="export-laser"
              onClick={() => {
                setOpen(false);
                onLaser();
              }}
            >
              Laser or plasma (DXF, SVG)...
            </button>
          )}
          {!assembly && onIfc && (
            <button
              type="button"
              role="menuitem"
              title="IFC4 for BIM tools: levels, walls, openings, floors, roofs and every framing member"
              data-testid="export-ifc"
              onClick={() => {
                setOpen(false);
                onIfc();
              }}
            >
              IFC (building)
            </button>
          )}
          {nothing && (
            <p className="io-note" role="note" data-testid="export-nothing">
              {several
                ? 'No body is chosen: tick one to export it.'
                : 'The body is hidden: show it to export it.'}
            </p>
          )}
          {several && (
            <fieldset className="io-bodies" data-testid="export-bodies">
              <legend>Bodies</legend>
              {bodies.map((b) => (
                <label key={b.id} title={b.hidden ? 'Hidden in the view' : undefined}>
                  <input
                    type="checkbox"
                    checked={ticks.get(b.id) ?? !b.hidden}
                    onChange={(e) => {
                      const next = new Map(ticks);
                      next.set(b.id, e.target.checked);
                      setTicks(next);
                    }}
                  />
                  {b.name}
                  {b.hidden ? ' (hidden)' : ''}
                </label>
              ))}
            </fieldset>
          )}
          {configurations > 0 && onExportAll && (
            <label
              className="io-every"
              title="One file per configuration row, named <document>-<row>, each regenerated in turn"
            >
              <input
                type="checkbox"
                checked={every}
                data-testid="export-every-configuration"
                onChange={(e) => setEvery(e.target.checked)}
              />
              Every configuration ({configurations} {configurations === 1 ? 'file' : 'files'})
            </label>
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

/** Progress of an export of every configuration, with its Cancel button. */
export function ExportProgress({
  index,
  count,
  row,
  onCancel,
}: {
  index: number;
  count: number;
  row: string;
  onCancel: () => void;
}) {
  return (
    <span className="io-progress" role="status" data-testid="export-progress">
      <progress max={count} value={index} aria-label="Configurations exported" />
      Exporting configuration {index + 1} of {count} ({row})...
      <button type="button" data-testid="export-cancel" onClick={onCancel}>
        Cancel
      </button>
    </span>
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
