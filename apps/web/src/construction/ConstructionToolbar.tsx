// The Construction toolbar group (ADR 0015: a toolbar group in the part studio, not a workspace):
// the Construction panel (levels, wall types, walls, member actions), the Wall tool and the Opening
// tool. The tools need a level and a wall type, which the panel makes.

import { useStore } from 'zustand';
import type { ConstructionUiStore } from './state';

export function ConstructionToolbar({
  ui,
  disabled,
  ready,
  hasWalls,
}: {
  ui: ConstructionUiStore;
  disabled: boolean;
  /** The document has a level and a wall type, so walls can be drawn. */
  ready: boolean;
  hasWalls: boolean;
}) {
  const open = useStore(ui, (s) => s.open);
  const tool = useStore(ui, (s) => s.tool);
  return (
    <div className="toolbar-group construction-toolbar" role="toolbar" aria-label="Construction">
      <button
        type="button"
        aria-pressed={open}
        disabled={disabled}
        data-testid="construction-open"
        title="Levels, wall types and walls, with what is framed for them"
        onClick={() => ui.getState().setOpen(!open)}
      >
        Construction
      </button>
      <button
        type="button"
        aria-pressed={tool?.kind === 'wall'}
        disabled={disabled || !ready}
        data-testid="construction-wall"
        title={
          ready
            ? 'Draw a wall on the active level: typed lengths in 90 degree steps, or clicked points'
            : 'Make a level and a wall type in the Construction panel first'
        }
        onClick={() => ui.getState().startTool({ kind: 'wall' })}
      >
        Wall
      </button>
      <button
        type="button"
        aria-pressed={tool?.kind === 'opening'}
        disabled={disabled || !hasWalls}
        data-testid="construction-opening"
        title={hasWalls ? 'Put a door or window in a wall' : 'Draw a wall first'}
        onClick={() => ui.getState().startTool({ kind: 'opening', featureId: null, wall: null })}
      >
        Opening
      </button>
    </div>
  );
}
