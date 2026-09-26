// Starting sketches: the Sketch menu (a datum plane, or the selected planar
// face) and the list of the part's sketches to edit again. The feature tree
// (#933) takes the list over.

import type { SketchFeature } from '@manufakture/core';
import type { SketchPlacement } from '@manufakture/sketch/model';
import { useEffect, useRef, useState } from 'react';
import type { SketchTarget } from './commit';
import { DATUM_PLANES } from './planes';

export interface SketchMenuProps {
  /** The selected planar face's placement, when there is one. */
  face: SketchPlacement | null;
  disabled?: boolean;
  onPick: (target: SketchTarget) => void;
}

export function SketchMenu({ face, disabled = false, onPick }: SketchMenuProps) {
  const [open, setOpen] = useState(false);
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
  const pick = (placement: SketchPlacement) => {
    setOpen(false);
    onPick({ kind: 'new', placement });
  };
  return (
    <div className="sketch-menu" ref={root}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        title="Start a sketch on a plane or on the selected face"
      >
        New sketch
      </button>
      {open && (
        <div
          className="menu"
          role="menu"
          aria-label="Sketch plane"
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        >
          {DATUM_PLANES.map((p) => (
            <button key={p.id} type="button" role="menuitem" onClick={() => pick(p.placement)}>
              {p.label}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            disabled={!face}
            title={face ? 'Sketch on the selected face' : 'Select a planar face first'}
            onClick={() => face && pick(face)}
          >
            Selected face
          </button>
        </div>
      )}
    </div>
  );
}

export interface SketchListProps {
  sketches: readonly SketchFeature[];
  disabled?: boolean;
  onEdit: (featureId: string) => void;
}

export function SketchList({ sketches, disabled = false, onEdit }: SketchListProps) {
  return (
    <section className="sketch-list" aria-label="Sketches">
      <h2>Sketches</h2>
      {sketches.length === 0 ? (
        <p>No sketches yet. Start one with New sketch.</p>
      ) : (
        <ul data-testid="sketch-list">
          {sketches.map((f) => (
            <li key={f.id} data-feature={f.id} onDoubleClick={() => !disabled && onEdit(f.id)}>
              <span>{f.name}</span>{' '}
              <span className="kind">
                {f.entities.length} {f.entities.length === 1 ? 'entity' : 'entities'}
              </span>
              <button
                type="button"
                disabled={disabled}
                aria-label={`Edit ${f.name}`}
                onClick={() => onEdit(f.id)}
              >
                Edit
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
