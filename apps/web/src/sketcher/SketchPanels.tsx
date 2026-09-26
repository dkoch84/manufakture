// Starting sketches: the Sketch menu (a datum plane, or the selected planar
// face). Sketches are opened again from the feature tree.

import type { SketchPlacement } from '@manufakture/sketch/model';
import { useEffect, useRef, useState } from 'react';
import type { SketchTarget } from './commit';
import { DATUM_PLANES, type FaceTarget } from './planes';

export interface SketchMenuProps {
  /** Where a sketch on the selected planar face goes, when there is one. */
  face: FaceTarget | null;
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
  const pick = (placement: SketchPlacement, face?: FaceTarget['face']) => {
    setOpen(false);
    onPick(face ? { kind: 'new', placement, face } : { kind: 'new', placement });
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
            onClick={() => face && pick(face.placement, face.face)}
          >
            Selected face
          </button>
        </div>
      )}
    </div>
  );
}
