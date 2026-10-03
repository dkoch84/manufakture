// The Floor tool (side panel): a floor under a level, its outline from the level's walls (picked in
// a list; their framing must close a ring), from typed points, or from a sketch. Joists span the
// short or long side or run at a typed angle, at a spacing that overrides the floor type's, with
// optional mid-span blocking and skids under them. Joist and rim stock and the subfloor come from
// the floor type, chosen or made here. OK adds or edits one `construction.floor`, one undo step.
// Sizes are the user's: nothing is checked for strength (ADR 0015 decision 8).

import {
  DEFAULT_FLOOR_SETTINGS,
  MAX_OUTLINE_POINTS,
  MAX_SKIDS,
  type ConstructionSettings,
} from '@manufakture/domain-construction';
import { formatLength } from '@manufakture/units';
import { useState } from 'react';
import { useStore } from 'zustand';
import { evaluateVariables, lengthFormat } from '../../sketcher/values';
import type { DocumentStoreApi } from '../../state/document';
import { Select } from '../../wood/Select';
import { StockPicker } from '../../wood/StockPicker';
import { Field } from '../LevelsPanel';
import type { ConstructionUiStore } from '../state';
import { stockName, wallsOnLevel } from '../tools';
import { OptionalSheet } from '../WallTypesEditor';
import {
  buildFloor,
  floorFormOf,
  newFloorForm,
  sketchesOf,
  type FloorForm,
  type OutlineSource,
} from './floors';

const SKID_COUNTS = Array.from({ length: MAX_SKIDS }, (_, i) => {
  const n = String(i + 1);
  return [n, n] as const;
});

export function FloorTool({
  documents,
  ui,
  partId,
  settings,
  featureId,
  onClose,
}: {
  documents: DocumentStoreApi;
  ui: ConstructionUiStore;
  partId: string;
  settings: ConstructionSettings | undefined;
  featureId: string | null;
  onClose: () => void;
}) {
  const doc = useStore(documents, (s) => s.document);
  const units = doc.units;
  const part = doc.parts.find((p) => p.id === partId);
  const existing = featureId ? part?.features.find((f) => f.id === featureId) : undefined;
  const levels = settings?.levels ?? [];
  const types = settings?.floorTypes ?? [];
  const [form, setForm] = useState<FloorForm>(() => {
    if (existing?.kind === 'extension') return floorFormOf(doc, partId, existing, units);
    const level = ui.getState().level ?? levels[0]?.id ?? '';
    return newFloorForm(doc, partId, level, units);
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (patch: Partial<FloorForm>) => setForm((f) => ({ ...f, ...patch }));
  const setType = (patch: Partial<FloorForm['newType']>) =>
    set({ newType: { ...form.newType, ...patch } });
  const fmt = (mm: number) => formatLength(mm, lengthFormat(units));
  const type = types.find((t) => t.id === form.floorType);
  const walls = wallsOnLevel(part, form.level);
  const sketches = sketchesOf(part);

  const apply = () => {
    const current = documents.getState().document;
    const r = buildFloor(form, {
      doc: current,
      partId,
      variables: evaluateVariables(current),
      existing: existing?.kind === 'extension' ? existing : undefined,
    });
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    const done = documents.getState().execute(r.command, r.label);
    if (!done.ok) {
      setErrors({ form: done.error.message });
      return;
    }
    onClose();
  };

  const setPoint = (i: number, patch: Partial<{ x: string; y: string }>) =>
    set({ points: form.points.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const title = existing ? existing.name : 'New floor';
  return (
    <aside
      className="selection-panel feature-dialog construction-tool"
      role="dialog"
      aria-label={`Floor: ${title}`}
      data-testid="floor-tool"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <h2>Floor: {title}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <Select
          label="Level (the top of the subfloor)"
          name="floor-level"
          value={form.level}
          options={levels.map((l) => [l.id, l.name] as const)}
          error={errors.level}
          onChange={(level) =>
            set({ level, walls: existing ? [] : newFloorForm(doc, partId, level, units).walls })
          }
        />
        <Select
          label="Outline"
          name="floor-outline"
          value={form.outline}
          options={[
            ['walls', 'Under the walls on the level'],
            ['points', 'Typed points'],
            ['sketch', 'A sketch'],
          ]}
          onChange={(v) => set({ outline: v as OutlineSource })}
        />
        {form.outline === 'walls' && (
          <fieldset className="construction-header" data-testid="floor-walls">
            <legend>Walls (their framing closes the outline)</legend>
            {walls.length === 0 && <p className="field-note">No walls on this level.</p>}
            {walls.map((w) => (
              <label key={w.id} className="dialog-check">
                <input
                  type="checkbox"
                  checked={form.walls.includes(w.id)}
                  data-testid={`floor-wall-${w.id}`}
                  onChange={(e) =>
                    set({
                      walls: e.target.checked
                        ? [...form.walls, w.id]
                        : form.walls.filter((x) => x !== w.id),
                    })
                  }
                />
                {w.name}
              </label>
            ))}
            {errors.walls && <p className="field-error">{errors.walls}</p>}
          </fieldset>
        )}
        {form.outline === 'points' && (
          <fieldset className="construction-header" data-testid="floor-points">
            <legend>Outline points, in order round the floor</legend>
            {form.points.map((p, i) => (
              <div key={i} className="construction-row">
                <Field
                  label={`X${i + 1}`}
                  testId={`floor-x${i + 1}`}
                  value={p.x}
                  error={errors[`x${i + 1}`]}
                  onChange={(x) => setPoint(i, { x })}
                />
                <Field
                  label={`Y${i + 1}`}
                  testId={`floor-y${i + 1}`}
                  value={p.y}
                  error={errors[`y${i + 1}`]}
                  onChange={(y) => setPoint(i, { y })}
                />
              </div>
            ))}
            <div className="construction-row">
              <button
                type="button"
                data-testid="floor-point-add"
                disabled={form.points.length >= MAX_OUTLINE_POINTS}
                onClick={() => set({ points: [...form.points, { x: '', y: '' }] })}
              >
                Add point
              </button>
              <button
                type="button"
                data-testid="floor-point-remove"
                disabled={form.points.length <= 4}
                onClick={() => set({ points: form.points.slice(0, -1) })}
              >
                Remove last
              </button>
            </div>
            {errors.points && <p className="field-error">{errors.points}</p>}
          </fieldset>
        )}
        {form.outline === 'sketch' && (
          <Select
            label="Sketch (its outer loop of lines)"
            name="floor-sketch"
            value={form.sketch}
            options={
              sketches.length > 0
                ? sketches.map((s) => [s.id, s.name] as const)
                : [['', 'No sketches in this part studio'] as const]
            }
            error={errors.sketch}
            onChange={(sketch) => set({ sketch })}
          />
        )}
        <Select
          label="Floor type"
          name="floor-type"
          value={form.floorType}
          options={[...types.map((t) => [t.id, t.name] as const), ['', 'New floor type'] as const]}
          error={errors.floorType}
          onChange={(floorType) => set({ floorType })}
        />
        {form.floorType === '' ? (
          <fieldset className="construction-header" data-testid="floor-type-form">
            <legend>New floor type</legend>
            <Field
              label="Name"
              testId="floor-type-name"
              value={form.newType.name}
              error={errors.typeName}
              onChange={(name) => setType({ name })}
            />
            <StockPicker
              value={form.newType.joistStock}
              units={units}
              only="lumber"
              label="Joist stock"
              testId="floor-type-joist"
              error={errors.joistStock}
              onChange={(joistStock) => setType({ joistStock })}
            />
            <label className="dialog-check">
              <input
                type="checkbox"
                checked={form.newType.rimStock !== null}
                data-testid="floor-type-rim-on"
                onChange={(e) => setType({ rimStock: e.target.checked ? '' : null })}
              />
              Rim joists of another stock
            </label>
            {form.newType.rimStock !== null && (
              <StockPicker
                value={form.newType.rimStock}
                units={units}
                only="lumber"
                label="Rim joist stock"
                testId="floor-type-rim"
                error={errors.rimStock}
                onChange={(rimStock) => setType({ rimStock })}
              />
            )}
            <OptionalSheet
              label="Subfloor"
              testId="floor-type-subfloor"
              value={form.newType.subfloor}
              fallback={units.length.unit === 'ft-in' ? 'us-osb-23-32' : 'mm-ply-18'}
              units={units}
              onChange={(subfloor) => setType({ subfloor })}
            />
          </fieldset>
        ) : (
          type && (
            <p className="field-note" data-testid="floor-type-summary">
              Joists {stockName(type.joistStock)}
              {type.rimStock ? `, rims ${stockName(type.rimStock)}` : ''}
              {type.subfloor ? `, subfloor ${stockName(type.subfloor)}` : ''}.
            </p>
          )
        )}
        <Select
          label="Joists"
          name="floor-joists"
          value={form.joists}
          options={[
            ['short', 'Across the shorter side'],
            ['long', 'Across the longer side'],
            ['angle', 'At an angle in plan'],
          ]}
          onChange={(v) => set({ joists: v as FloorForm['joists'] })}
        />
        {form.joists === 'angle' && (
          <Field
            label="Joist direction (from +X)"
            testId="floor-direction"
            value={form.direction}
            error={errors.direction}
            placeholder="90deg"
            onChange={(direction) => set({ direction })}
          />
        )}
        <Field
          label="Joist spacing"
          testId="floor-spacing"
          value={form.spacing}
          error={errors.spacing}
          placeholder={fmt(type?.spacing ?? DEFAULT_FLOOR_SETTINGS.spacing)}
          onChange={(spacing) => set({ spacing })}
        />
        <Select
          label="Blocking"
          name="floor-blocking"
          value={form.blocking}
          options={[
            ['none', 'None'],
            ['mid-span', 'One row at mid-span'],
          ]}
          onChange={(v) => set({ blocking: v as FloorForm['blocking'] })}
        />
        <label className="dialog-check">
          <input
            type="checkbox"
            checked={form.skids}
            data-testid="floor-skids"
            onChange={(e) => set({ skids: e.target.checked })}
          />
          On skids
        </label>
        {form.skids && (
          <>
            <StockPicker
              value={form.skidStock}
              units={units}
              only="lumber"
              label="Skid stock"
              testId="floor-skid-stock"
              error={errors.skidStock}
              onChange={(skidStock) => set({ skidStock })}
            />
            <Select
              label="Skids"
              name="floor-skid-count"
              value={form.skidCount}
              options={SKID_COUNTS}
              error={errors.skidCount}
              onChange={(skidCount) => set({ skidCount })}
            />
            <Field
              label="Skid overhang past the floor (optional)"
              testId="floor-skid-overhang"
              value={form.skidOverhang}
              error={errors.skidOverhang}
              onChange={(skidOverhang) => set({ skidOverhang })}
            />
          </>
        )}
        {errors.form && (
          <p className="field-error" role="alert" data-testid="floor-error">
            {errors.form}
          </p>
        )}
        <div className="dialog-buttons">
          <button type="submit" className="primary" data-testid="floor-ok">
            OK
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </aside>
  );
}
