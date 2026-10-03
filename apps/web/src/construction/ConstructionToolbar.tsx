// The Construction toolbar group (ADR 0015: a toolbar group in the part studio, not a workspace):
// the Construction panel (levels, wall types, framing settings, walls, floors and roofs, member
// actions) and the Wall, Opening, Floor and Roof tools. Walls need a level and a wall type, which
// the panel makes; floors and roofs need a level (their tools make a floor or roof type).

import { useStore } from 'zustand';
import type { ConstructionUiStore } from './state';

export function ConstructionToolbar({
  ui,
  disabled,
  ready,
  hasLevel,
  hasWalls,
}: {
  ui: ConstructionUiStore;
  disabled: boolean;
  /** The document has a level and a wall type, so walls can be drawn. */
  ready: boolean;
  /** The document has a level, so floors and roofs can be added. */
  hasLevel: boolean;
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
      <button
        type="button"
        aria-pressed={tool?.kind === 'floor'}
        disabled={disabled || !hasLevel}
        data-testid="construction-floor"
        title={
          hasLevel
            ? 'Add a floor: joists under the walls on a level, or under an outline'
            : 'Start construction in the Construction panel first'
        }
        onClick={() => ui.getState().startTool({ kind: 'floor', featureId: null })}
      >
        Floor
      </button>
      <button
        type="button"
        aria-pressed={tool?.kind === 'roof'}
        disabled={disabled || !hasLevel}
        data-testid="construction-roof"
        title={
          hasLevel
            ? 'Add a gable or hip roof on walls, or on a level'
            : 'Start construction in the Construction panel first'
        }
        onClick={() => ui.getState().startTool({ kind: 'roof', featureId: null })}
      >
        Roof
      </button>
    </div>
  );
}
