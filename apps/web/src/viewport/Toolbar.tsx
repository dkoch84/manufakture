import { useStore } from 'zustand';
import { GEOMETRY_KINDS, selectionStore, type SelectionStore } from '../state/selection';
import { viewSettingsStore, type Axis, type ViewSettingsStore } from '../state/viewSettings';
import { PRESETS, isPresetId } from './navigation';
import type { StandardView } from './viewMath';
import type { ViewportApi } from './Viewport';

const VIEWS: readonly [StandardView, string][] = [
  ['front', 'Front'],
  ['top', 'Top'],
  ['right', 'Right'],
  ['iso', 'Iso'],
];

const KIND_LABELS = { face: 'Faces', edge: 'Edges', vertex: 'Vertices' } as const;

export interface ToolbarProps {
  viewport: ViewportApi | null;
  selection?: SelectionStore;
  settings?: ViewSettingsStore;
}

export function Toolbar({
  viewport,
  selection = selectionStore,
  settings = viewSettingsStore,
}: ToolbarProps) {
  const s = useStore(settings);
  const disabledKinds = useStore(selection, (st) => st.disabledKinds);
  const setKindEnabled = useStore(selection, (st) => st.setKindEnabled);
  const off = !viewport;

  return (
    <div className="toolbar" role="toolbar" aria-label="View">
      <div className="toolbar-group" aria-label="Standard views">
        {VIEWS.map(([view, label]) => (
          <button
            key={view}
            type="button"
            disabled={off}
            onClick={() => viewport?.setStandardView(view)}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          disabled={off}
          onClick={() => viewport?.fitAll()}
          title="Zoom to fit (F)"
        >
          Fit
        </button>
      </div>

      <div className="toolbar-group">
        <button
          type="button"
          aria-pressed={s.projection === 'orthographic'}
          onClick={s.toggleProjection}
          title="Switch between perspective and orthographic projection"
        >
          {s.projection === 'perspective' ? 'Perspective' : 'Orthographic'}
        </button>
        <label>
          Mouse
          <select
            value={s.preset}
            onChange={(e) => {
              if (isPresetId(e.target.value)) s.setPreset(e.target.value);
            }}
            title={PRESETS[s.preset].summary.join('\n')}
          >
            {Object.values(PRESETS).map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <fieldset className="toolbar-group">
        <legend>Select</legend>
        {GEOMETRY_KINDS.map((kind) => (
          <label key={kind}>
            <input
              type="checkbox"
              checked={!disabledKinds.includes(kind)}
              onChange={(e) => setKindEnabled(kind, e.target.checked)}
            />
            {KIND_LABELS[kind]}
          </label>
        ))}
      </fieldset>

      <fieldset className="toolbar-group">
        <legend>Section</legend>
        <label>
          <input
            type="checkbox"
            checked={s.section.enabled}
            onChange={(e) => s.setSection({ enabled: e.target.checked })}
          />
          On
        </label>
        <select
          aria-label="Section axis"
          value={s.section.axis}
          onChange={(e) => s.setSection({ axis: e.target.value as Axis })}
        >
          <option value="x">X</option>
          <option value="y">Y</option>
          <option value="z">Z</option>
        </select>
        <input
          type="range"
          aria-label="Section position"
          min={0}
          max={1}
          step={0.01}
          value={s.section.position}
          onChange={(e) => s.setSection({ position: Number(e.target.value) })}
        />
        <label>
          <input
            type="checkbox"
            checked={s.section.flipped}
            onChange={(e) => s.setSection({ flipped: e.target.checked })}
          />
          Flip
        </label>
      </fieldset>

      <div className="toolbar-group">
        <label>
          <input
            type="checkbox"
            checked={s.showEdges}
            onChange={(e) => s.setShowEdges(e.target.checked)}
          />
          Show edges
        </label>
        <label>
          <input
            type="checkbox"
            checked={s.showGrid}
            onChange={(e) => s.setShowGrid(e.target.checked)}
          />
          Show grid
        </label>
      </div>
    </div>
  );
}

/** Hovered and selected geometry, by name. */
export function SelectionPanel({ selection = selectionStore }: { selection?: SelectionStore }) {
  const selected = useStore(selection, (st) => st.selected);
  const hovered = useStore(selection, (st) => st.hovered);
  const clear = useStore(selection, (st) => st.clear);
  return (
    <aside className="selection-panel" aria-label="Selection">
      <h2>Selection</h2>
      <p className="hovered" data-testid="hovered">
        {hovered ? `${hovered.kind}: ${nameOf(hovered)}` : 'Nothing under the cursor'}
      </p>
      {selected.length === 0 ? (
        <p>Nothing selected. Click a face, edge or vertex.</p>
      ) : (
        <>
          <ol data-testid="selected">
            {selected.map((item) => (
              <li key={`${item.kind}:${item.id}`} data-kind={item.kind} data-name={nameOf(item)}>
                <span className="kind">{item.kind}</span> <code>{nameOf(item)}</code>
                {'placeholder' in item && item.placeholder === true && (
                  <span className="badge" title="Not named by the naming layer yet">
                    placeholder
                  </span>
                )}
                {'fragile' in item && item.fragile === true && (
                  <span className="badge warn" title="Positional name: may move after an edit">
                    fragile
                  </span>
                )}
              </li>
            ))}
          </ol>
          <button type="button" onClick={clear}>
            Clear
          </button>
        </>
      )}
    </aside>
  );
}

function nameOf(item: { id: string; name?: unknown }): string {
  return typeof item.name === 'string' ? item.name : item.id;
}
