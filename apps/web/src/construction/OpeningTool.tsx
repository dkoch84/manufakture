// The Opening tool (side panel): a door, window or plain opening in a wall. Pick the wall (in the
// list, or by picking one of its members or layer faces in the view before opening the tool),
// the segment, the kind, the rough opening's size, where it goes (from the segment's start, from
// its end, or centred) and the header. The tool shows which header will be used and why: set on
// this opening, the user's narrowest header rule that covers the width, or the wall type's
// default (ADR 0015 decision 7). OK adds or edits one `construction.opening`, one undo step.

import type { DisplayUnits, ExtensionFeature } from '@manufakture/core';
import { readWallMetadata, type ConstructionSettings } from '@manufakture/domain-construction';
import { formatLength } from '@manufakture/units';
import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { featureResult, type ModelStore } from '../model/model';
import { evaluateVariables, lengthFormat } from '../sketcher/values';
import type { DocumentStoreApi } from '../state/document';
import type { SelectionStore } from '../state/selection';
import { isMemberRef } from '../viewport/members';
import { Select } from '../wood/Select';
import { StockPicker } from '../wood/StockPicker';
import { Field } from './LevelsPanel';
import { checkLength } from './lengths';
import {
  KIND_LABELS,
  buildOpening,
  headerPreview,
  headerSourceText,
  newOpeningForm,
  openingFormOf,
  type HeaderChoice,
  type OpeningForm,
  type OpeningKind,
  type Placement,
} from './openings';
import { isWall } from './settings';
import { segmentLengths, wallsOf } from './walls';

const COUNTS = [
  ['', 'Choose'],
  ['1', '1'],
  ['2', '2'],
  ['3', '3'],
  ['4', '4'],
] as const;

/** The wall a picked member or layer face belongs to, if it is a wall of the part. */
function pickedWall(
  selected: readonly { kind: string; id: string; bodyId?: string }[],
  walls: readonly ExtensionFeature[],
  openings: ReadonlyMap<string, string>,
): string | null {
  for (const item of [...selected].reverse()) {
    const raw = isMemberRef(item as never)
      ? (item as unknown as { owner: string }).owner
      : typeof item.bodyId === 'string'
        ? item.bodyId.slice(item.bodyId.indexOf('/') + 1).split(':')[0]!
        : null;
    if (raw === null) continue;
    const owner = openings.get(raw) ?? raw;
    if (walls.some((w) => w.id === owner)) return owner;
  }
  return null;
}

export function OpeningTool({
  documents,
  model,
  selection,
  partId,
  settings,
  featureId,
  wall: initialWall,
  onClose,
}: {
  documents: DocumentStoreApi;
  model: ModelStore;
  selection: SelectionStore;
  partId: string;
  settings: ConstructionSettings | undefined;
  featureId: string | null;
  wall: string | null;
  onClose: () => void;
}) {
  const doc = useStore(documents, (s) => s.document);
  const part = doc.parts.find((p) => p.id === partId);
  const existing = featureId ? part?.features.find((f) => f.id === featureId) : undefined;
  const walls = useMemo(() => (part ? wallsOf(part).map((w) => w.wall) : []), [part]);
  const [form, setForm] = useState<OpeningForm>(() => {
    if (existing && existing.kind === 'extension') return openingFormOf(existing);
    const hosts = new Map<string, string>();
    for (const { wall, openings } of part ? wallsOf(part) : []) {
      for (const o of openings) hosts.set(o.id, wall.id);
    }
    const picked = pickedWall(selection.getState().selected as never, walls, hosts);
    return newOpeningForm(initialWall ?? picked ?? walls[0]?.id ?? '');
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (patch: Partial<OpeningForm>) => setForm((f) => ({ ...f, ...patch }));
  const units = doc.units;
  const variables = useMemo(() => evaluateVariables(doc), [doc]);

  // The wall's path as regen built it: its segments and their lengths.
  const wallResult = useStore(model, (s) => featureResult(s, partId, form.wall));
  const meta = readWallMetadata(wallResult?.metadata);
  const segments = meta ? segmentLengths(meta.points, meta.closed) : [];
  const wallFeature = walls.find((w) => w.id === form.wall);
  const type = settings?.wallTypes.find((t) => t.id === wallFeature?.params.wallType);

  const width = checkLength(form.width, units, variables);
  const explicit =
    form.header === 'explicit' &&
    form.headerStock !== '' &&
    /^[1-4]$/.test(form.headerPlies) &&
    /^[1-4]$/.test(form.headerJacks)
      ? {
          stock: form.headerStock,
          plies: Number(form.headerPlies),
          jacks: Number(form.headerJacks),
        }
      : undefined;
  const preview = headerPreview(
    settings,
    type,
    width.ok ? width.value : undefined,
    form.header,
    explicit,
  );

  const apply = () => {
    const current = documents.getState().document;
    const r = buildOpening(form, {
      doc: current,
      partId,
      variables: evaluateVariables(current),
      segmentLength: segments[form.segment - 1],
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

  const title = existing ? existing.name : `New ${KIND_LABELS[form.kind].toLowerCase()}`;
  return (
    <aside
      className="selection-panel feature-dialog construction-tool"
      role="dialog"
      aria-label={`Opening: ${title}`}
      data-testid="opening-tool"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <h2>Opening: {title}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        {walls.length === 0 && <p className="field-error">Draw a wall first.</p>}
        <Select
          label="Wall"
          name="opening-wall"
          value={form.wall}
          options={walls.filter(isWall).map((w) => [w.id, w.name] as const)}
          error={errors.wall}
          onChange={(wall) => set({ wall, segment: 1 })}
        />
        <Select
          label="Segment"
          name="opening-segment"
          value={String(form.segment)}
          options={(segments.length > 0 ? segments : [0]).map(
            (len, i) =>
              [
                String(i + 1),
                segments.length > 0 ? `${i + 1} (${formatted(len, units)})` : '1',
              ] as const,
          )}
          onChange={(v) => set({ segment: Number(v) })}
        />
        <Select
          label="Kind"
          name="opening-kind"
          value={form.kind}
          options={(['door', 'window', 'opening'] as const).map(
            (k) => [k, KIND_LABELS[k]] as const,
          )}
          onChange={(v) => set({ kind: v as OpeningKind })}
        />
        <Field
          label="Rough opening width"
          testId="opening-width"
          value={form.width}
          error={errors.width}
          onChange={(width) => set({ width })}
        />
        <Field
          label="Rough opening height"
          testId="opening-height"
          value={form.height}
          error={errors.height}
          onChange={(height) => set({ height })}
        />
        {form.kind !== 'door' && (
          <Field
            label={
              form.kind === 'window'
                ? 'Sill height (above the wall base)'
                : 'Sill height (optional)'
            }
            testId="opening-sill"
            value={form.sill}
            error={errors.sill}
            onChange={(sill) => set({ sill })}
          />
        )}
        <Select
          label="Position"
          name="opening-placement"
          value={form.placement}
          options={[
            ['centre', 'Centred on the segment'],
            ['start', 'From the segment start'],
            ['end', 'From the segment end'],
          ]}
          onChange={(v) => set({ placement: v as Placement })}
        />
        {form.placement !== 'centre' && (
          <Field
            label="Distance to the opening's centre line"
            testId="opening-position"
            value={form.position}
            error={errors.position}
            onChange={(position) => set({ position })}
          />
        )}
        {form.placement === 'centre' && errors.position && (
          <p className="field-error">{errors.position}</p>
        )}
        <Select
          label="Header"
          name="opening-header"
          value={form.header}
          options={[
            ['auto', 'By the header rules, else the wall type default'],
            ['default', "The wall type's default"],
            ['explicit', 'Set on this opening'],
          ]}
          onChange={(v) => set({ header: v as HeaderChoice })}
        />
        {form.header === 'explicit' && (
          <>
            <StockPicker
              value={form.headerStock}
              units={units}
              only="lumber"
              label="Header stock"
              testId="opening-header-stock"
              error={errors.headerStock}
              onChange={(headerStock) => set({ headerStock })}
            />
            <Select
              label="Plies"
              name="opening-header-plies"
              value={form.headerPlies}
              options={COUNTS}
              error={errors.headerPlies}
              onChange={(headerPlies) => set({ headerPlies })}
            />
            <Select
              label="Jack studs each end"
              name="opening-header-jacks"
              value={form.headerJacks}
              options={COUNTS}
              error={errors.headerJacks}
              onChange={(headerJacks) => set({ headerJacks })}
            />
          </>
        )}
        <p className="field-note" data-testid="opening-header-preview" data-source={preview.source}>
          {headerSourceText(preview, units)}
        </p>
        {errors.form && (
          <p className="field-error" role="alert">
            {errors.form}
          </p>
        )}
        <div className="dialog-buttons">
          <button
            type="submit"
            className="primary"
            data-testid="opening-ok"
            disabled={walls.length === 0}
          >
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

function formatted(mm: number, units: DisplayUnits): string {
  return formatLength(mm, lengthFormat(units));
}
