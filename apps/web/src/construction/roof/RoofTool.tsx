// The Roof tool (side panel): a gable or hip roof on the walls of a level (picked in a list; their
// framing must close a rectangle) or on a level (a rectangle typed by a corner, its sides and a
// rotation). The pitch is a slope field (`6/12`, `30deg`, `25%`), shown back as `p/12` and
// degrees, and previewed in the view at the plates' top. Overhangs and spacing override the roof
// type's; rafter, ridge and hip stock come from the roof type, chosen or made here. OK adds or
// edits one `construction.roof`, one undo step. Sizes are the user's: nothing is checked for
// strength (ADR 0015 decision 8).

import {
  DEFAULT_ROOF_SETTINGS,
  MAX_TIE_EVERY,
  readWallMetadata,
  type ConstructionSettings,
  type WallMetadata,
} from '@manufakture/domain-construction';
import { formatLength } from '@manufakture/units';
import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { featureResult, type ModelStore } from '../../model/model';
import { evaluateVariables, lengthFormat } from '../../sketcher/values';
import type { DocumentStoreApi } from '../../state/document';
import type { ViewportApi } from '../../viewport/Viewport';
import { Select } from '../../wood/Select';
import { StockPicker } from '../../wood/StockPicker';
import { Field } from '../LevelsPanel';
import { checkLength } from '../lengths';
import type { ConstructionUiStore } from '../state';
import { optionalAngle, stockName, wallsOnLevel } from '../tools';
import { OptionalSheet } from '../WallTypesEditor';
import { checkPitch } from './pitch';
import { PitchField } from './PitchField';
import { PitchPreview } from './PitchPreview';
import {
  buildRoof,
  levelFootprint,
  newRoofForm,
  roofFormOf,
  roofPreviewLines,
  wallsFootprint,
  type RoofForm,
  type RoofKind,
  type TiesKind,
} from './roofs';

const EVERY = Array.from({ length: MAX_TIE_EVERY }, (_, i) => {
  const n = String(i + 1);
  return [n, i === 0 ? 'Every pair' : `Every ${n} pairs`] as const;
});

export function RoofTool({
  documents,
  model,
  ui,
  partId,
  settings,
  featureId,
  viewport,
  onClose,
}: {
  documents: DocumentStoreApi;
  model: ModelStore;
  ui: ConstructionUiStore;
  partId: string;
  settings: ConstructionSettings | undefined;
  featureId: string | null;
  viewport: ViewportApi | null;
  onClose: () => void;
}) {
  const doc = useStore(documents, (s) => s.document);
  const units = doc.units;
  const part = doc.parts.find((p) => p.id === partId);
  const existing = featureId ? part?.features.find((f) => f.id === featureId) : undefined;
  const levels = useMemo(() => settings?.levels ?? [], [settings]);
  const types = settings?.roofTypes ?? [];
  const [form, setForm] = useState<RoofForm>(() => {
    if (existing?.kind === 'extension') return roofFormOf(doc, partId, existing, units);
    const level = ui.getState().level ?? levels[0]?.id ?? '';
    return newRoofForm(doc, partId, level, units);
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (patch: Partial<RoofForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    if (Object.keys(patch).some((k) => errors[k] !== undefined)) {
      setErrors((e) => {
        const next = { ...e };
        for (const k of Object.keys(patch)) delete next[k];
        return next;
      });
    }
  };
  const setType = (patch: Partial<RoofForm['newType']>) =>
    set({ newType: { ...form.newType, ...patch } });
  const variables = useMemo(() => evaluateVariables(doc), [doc]);
  const fmt = (mm: number) => formatLength(mm, lengthFormat(units));
  const type = types.find((t) => t.id === form.roofType);
  const walls = wallsOnLevel(part, form.level);
  const gable = form.kind === 'gable';

  // The preview: the walls as regen built them, or the typed rectangle.
  const parts = useStore(model, (s) => s.parts);
  const pitch = checkPitch(form.pitch, units, variables);
  const footprint = useMemo(() => {
    if (form.bearing === 'walls') {
      const metas: WallMetadata[] = [];
      for (const id of form.walls) {
        const m = readWallMetadata(featureResult({ parts }, partId, id)?.metadata);
        if (m) metas.push(m);
      }
      return wallsFootprint(metas);
    }
    const level = levels.find((l) => l.id === form.level);
    if (!level) return null;
    const len = (t: string, sign: 'any' | 'positive' = 'positive') => {
      if (t.trim() === '') return undefined;
      const r = checkLength(t, units, variables, { sign });
      return r.ok ? r.value : undefined;
    };
    const plate = level.elevation + (len(form.plate) ?? level.height);
    return levelFootprint(
      {
        x: len(form.x, 'any'),
        y: len(form.y, 'any'),
        length: len(form.length),
        width: len(form.width),
        rotation: optionalAngle(form.rotation, 'rotation', {
          units,
          variables,
          out: {},
          errors: {},
        }),
      },
      plate,
    );
  }, [form, parts, partId, levels, units, variables]);
  const preview =
    footprint && pitch.ok ? roofPreviewLines(footprint, form.kind, form.ridge, pitch.value) : null;

  const apply = () => {
    const current = documents.getState().document;
    const r = buildRoof(form, {
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

  const placeholder = (mm: number | undefined) => (mm === undefined ? '' : fmt(mm));
  const title = existing ? existing.name : 'New roof';
  return (
    <aside
      className="selection-panel feature-dialog construction-tool"
      role="dialog"
      aria-label={`Roof: ${title}`}
      data-testid="roof-tool"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <h2>Roof: {title}</h2>
      <PitchPreview
        viewport={viewport}
        lines={preview?.lines ?? null}
        apex={preview?.apex ?? null}
        pitch={pitch.ok ? pitch.value : null}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <Select
          label="Level"
          name="roof-level"
          value={form.level}
          options={levels.map((l) => [l.id, l.name] as const)}
          error={errors.level}
          onChange={(level) =>
            set({ level, walls: existing ? [] : newRoofForm(doc, partId, level, units).walls })
          }
        />
        <Select
          label="Bears on"
          name="roof-bearing"
          value={form.bearing}
          options={[
            ['walls', 'Walls on the level'],
            ['level', 'A rectangle on the level'],
          ]}
          onChange={(v) => set({ bearing: v as RoofForm['bearing'] })}
        />
        {form.bearing === 'walls' ? (
          <fieldset className="construction-header" data-testid="roof-walls">
            <legend>Walls (their framing closes a rectangle)</legend>
            {walls.length === 0 && <p className="field-note">No walls on this level.</p>}
            {walls.map((w) => (
              <label key={w.id} className="dialog-check">
                <input
                  type="checkbox"
                  checked={form.walls.includes(w.id)}
                  data-testid={`roof-wall-${w.id}`}
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
        ) : (
          <>
            <div className="construction-row">
              <Field
                label="Corner X"
                testId="roof-x"
                value={form.x}
                error={errors.x}
                onChange={(x) => set({ x })}
              />
              <Field
                label="Corner Y"
                testId="roof-y"
                value={form.y}
                error={errors.y}
                onChange={(y) => set({ y })}
              />
            </div>
            <div className="construction-row">
              <Field
                label="Length"
                testId="roof-length"
                value={form.length}
                error={errors.length}
                onChange={(length) => set({ length })}
              />
              <Field
                label="Width"
                testId="roof-width"
                value={form.width}
                error={errors.width}
                onChange={(width) => set({ width })}
              />
            </div>
            <Field
              label="Rotation in plan (optional)"
              testId="roof-rotation"
              value={form.rotation}
              error={errors.rotation}
              onChange={(rotation) => set({ rotation })}
            />
            <Field
              label="Plate height above the level (default the level's wall height)"
              testId="roof-plate"
              value={form.plate}
              error={errors.plate}
              onChange={(plate) => set({ plate })}
            />
            <Field
              label="Wall thickness under the rafters (the birdsmouth seat)"
              testId="roof-wall-thickness"
              value={form.wallThickness}
              error={errors.wallThickness}
              onChange={(wallThickness) => set({ wallThickness })}
            />
          </>
        )}
        <Select
          label="Roof type"
          name="roof-type"
          value={form.roofType}
          options={[...types.map((t) => [t.id, t.name] as const), ['', 'New roof type'] as const]}
          error={errors.roofType}
          onChange={(roofType) => set({ roofType })}
        />
        {form.roofType === '' ? (
          <fieldset className="construction-header" data-testid="roof-type-form">
            <legend>New roof type</legend>
            <Field
              label="Name"
              testId="roof-type-name"
              value={form.newType.name}
              error={errors.typeName}
              onChange={(name) => setType({ name })}
            />
            <StockPicker
              value={form.newType.rafterStock}
              units={units}
              only="lumber"
              label="Rafter stock"
              testId="roof-type-rafter"
              error={errors.rafterStock}
              onChange={(rafterStock) => setType({ rafterStock })}
            />
            <StockPicker
              value={form.newType.ridgeStock}
              units={units}
              only="lumber"
              label="Ridge stock"
              testId="roof-type-ridge"
              error={errors.ridgeStock}
              onChange={(ridgeStock) => setType({ ridgeStock })}
            />
            <label className="dialog-check">
              <input
                type="checkbox"
                checked={form.newType.hipStock !== null}
                data-testid="roof-type-hip-on"
                onChange={(e) => setType({ hipStock: e.target.checked ? '' : null })}
              />
              Hip rafters (for hip roofs)
            </label>
            {form.newType.hipStock !== null && (
              <StockPicker
                value={form.newType.hipStock}
                units={units}
                only="lumber"
                label="Hip rafter stock"
                testId="roof-type-hip"
                error={errors.hipStock}
                onChange={(hipStock) => setType({ hipStock })}
              />
            )}
            {form.newType.hipStock === null && errors.hipStock && (
              <p className="field-error">{errors.hipStock}</p>
            )}
            <OptionalSheet
              label="Roof sheathing"
              testId="roof-type-sheathing"
              value={form.newType.sheathing}
              fallback={units.length.unit === 'ft-in' ? 'us-osb-7-16' : 'mm-ply-18'}
              units={units}
              onChange={(sheathing) => setType({ sheathing })}
            />
          </fieldset>
        ) : (
          type && (
            <p className="field-note" data-testid="roof-type-summary">
              Rafters {stockName(type.rafterStock)}, ridge {stockName(type.ridgeStock)}
              {type.hipStock ? `, hips ${stockName(type.hipStock)}` : ''}
              {type.sheathing ? `, sheathing ${stockName(type.sheathing)}` : ''}.
            </p>
          )
        )}
        <Select
          label="Kind"
          name="roof-kind"
          value={form.kind}
          options={[
            ['gable', 'Gable'],
            ['hip', 'Hip'],
          ]}
          onChange={(v) => set({ kind: v as RoofKind })}
        />
        {form.kind === 'hip' && type && type.hipStock === undefined && (
          <StockPicker
            value={form.hipStock}
            units={units}
            only="lumber"
            label={`Hip rafter stock (added to ${type.name})`}
            testId="roof-hip-stock"
            error={errors.hipStock}
            onChange={(hipStock) => set({ hipStock })}
          />
        )}
        {gable && (
          <Select
            label="Ridge"
            name="roof-ridge"
            value={form.ridge}
            options={[
              ['long', 'Along the longer side'],
              ['short', 'Along the shorter side'],
            ]}
            onChange={(v) => set({ ridge: v as RoofForm['ridge'] })}
          />
        )}
        <PitchField
          value={form.pitch}
          units={units}
          variables={variables}
          error={errors.pitch}
          onChange={(p) => set({ pitch: p })}
        />
        <Field
          label="Eave overhang"
          testId="roof-overhang"
          value={form.overhang}
          error={errors.overhang}
          placeholder={placeholder(type?.overhang ?? DEFAULT_ROOF_SETTINGS.overhang)}
          onChange={(overhang) => set({ overhang })}
        />
        {gable && (
          <Field
            label="Rake overhang"
            testId="roof-rake-overhang"
            value={form.rakeOverhang}
            error={errors.rakeOverhang}
            placeholder={placeholder(type?.rakeOverhang ?? DEFAULT_ROOF_SETTINGS.rakeOverhang)}
            onChange={(rakeOverhang) => set({ rakeOverhang })}
          />
        )}
        <Field
          label="Rafter spacing"
          testId="roof-spacing"
          value={form.spacing}
          error={errors.spacing}
          placeholder={placeholder(type?.spacing ?? DEFAULT_ROOF_SETTINGS.spacing)}
          onChange={(spacing) => set({ spacing })}
        />
        <Select
          label="Ties"
          name="roof-ties"
          value={form.ties}
          options={[
            ['none', 'None'],
            ['ceiling-joists', 'Ceiling joists'],
            ['rafter-ties', 'Rafter ties'],
          ]}
          onChange={(v) => set({ ties: v as TiesKind })}
        />
        {form.ties !== 'none' && (
          <>
            <StockPicker
              value={form.tieStock}
              units={units}
              only="lumber"
              label="Tie stock"
              testId="roof-tie-stock"
              error={errors.tieStock}
              onChange={(tieStock) => set({ tieStock })}
            />
            <Select
              label="On"
              name="roof-tie-every"
              value={form.tieEvery}
              options={EVERY}
              error={errors.tieEvery}
              onChange={(tieEvery) => set({ tieEvery })}
            />
            {form.ties === 'rafter-ties' && (
              <Field
                label="Height above the plates"
                testId="roof-tie-height"
                value={form.tieHeight}
                error={errors.tieHeight}
                onChange={(tieHeight) => set({ tieHeight })}
              />
            )}
          </>
        )}
        {gable && (
          <label className="dialog-check">
            <input
              type="checkbox"
              checked={form.gableStuds}
              data-testid="roof-gable-studs"
              onChange={(e) => set({ gableStuds: e.target.checked })}
            />
            Gable studs on the gable walls&apos; layout
          </label>
        )}
        {errors.form && (
          <p className="field-error" role="alert" data-testid="roof-error">
            {errors.form}
          </p>
        )}
        <div className="dialog-buttons">
          <button type="submit" className="primary" data-testid="roof-ok">
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
