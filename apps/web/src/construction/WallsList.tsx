// The Walls section of the Construction panel: each wall of the part studio with what regen
// framed for it (its member count by role: the info the takeoff counts), its openings with the
// header each one used and where that header came from (ADR 0015 decision 7), any error or
// layout warning, each one's construction phase when the model has phases (#1213: how many of its
// members are new and demolished), and the wall's own framing settings (height, spacing, plates, kings, corners,
// blocking), which override its type's and the document's.

import type { DisplayUnits, ExtensionFeature } from '@manufakture/core';
import type { ConstructionSettings } from '@manufakture/domain-construction';
import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { featureResult, type ModelStore } from '../model/model';
import { evaluateVariables } from '../sketcher/values';
import type { DocumentStoreApi } from '../state/document';
import { roleLabel, type MemberSetView } from '../viewport/members';
import { shownMemberView, type MemberStore } from '../viewport/memberStore';
import { Select } from '../wood/Select';
import { Field } from './LevelsPanel';
import { headerSourceText, headerUsed, usedAsPreview, type HeaderChoice } from './openings';
import type { Outcome } from './settings';
import type { ConstructionUiStore } from './state';
import {
  buildWallFraming,
  framingFormOf,
  phaseText,
  roleCounts,
  wallsOf,
  type WallFramingForm,
} from './walls';

export function WallsList({
  documents,
  model,
  members,
  ui,
  partId,
  settings,
  disabled,
  onRun,
}: {
  documents: DocumentStoreApi;
  model: ModelStore;
  members: MemberStore;
  ui: ConstructionUiStore;
  partId: string;
  settings: ConstructionSettings | undefined;
  disabled: boolean;
  onRun: (r: Outcome) => boolean;
}) {
  const doc = useStore(documents, (s) => s.document);
  const part = doc.parts.find((p) => p.id === partId);
  const walls = useMemo(() => (part ? wallsOf(part) : []), [part]);
  const view = useStore(members, shownMemberView);
  const parts = useStore(model, (s) => s.parts);
  const editing = useStore(ui, (s) => s.editingWall);
  const sets = new Map(view.sets.map((s) => [s.group, s]));
  if (walls.length === 0) {
    return (
      <section className="construction-section" aria-label="Walls">
        <h3>Walls</h3>
        <p className="field-note">No walls yet. Use Wall in the Construction tools to draw one.</p>
      </section>
    );
  }
  return (
    <section className="construction-section" aria-label="Walls" data-testid="walls-list">
      <h3>Walls</h3>
      <ul className="construction-list">
        {walls.map(({ wall, openings }) => {
          const set = sets.get(wall.id);
          const counts = roleCounts(set);
          const result = featureResult({ parts }, partId, wall.id);
          const problem = result?.errors[0]?.message;
          const phase = phaseText(wall.id, result?.metadata, set);
          return (
            <li key={wall.id} data-testid={`wall-${wall.id}`}>
              <div className="construction-row">
                <strong>{wall.name}</strong>
                <span data-testid={`wall-members-${wall.id}`} className="wall-count">
                  {set ? `${counts.total} members` : result ? 'not framed' : 'building...'}
                </span>
                <button
                  type="button"
                  data-testid={`wall-framing-${wall.id}`}
                  disabled={disabled}
                  onClick={() => ui.getState().editWall(editing === wall.id ? null : wall.id)}
                >
                  Framing
                </button>
              </div>
              {phase && (
                <p className="field-note" data-testid={`wall-phase-${wall.id}`}>
                  {phase}
                </p>
              )}
              {problem && (
                <p className="field-error" data-testid={`wall-error-${wall.id}`}>
                  {problem}
                </p>
              )}
              {counts.roles.length > 0 && (
                <ul className="role-counts" data-testid={`wall-roles-${wall.id}`}>
                  {counts.roles.map(([role, n]) => (
                    <li key={role} data-testid={`wall-role-${wall.id}-${role}`} data-count={n}>
                      {roleLabel(role)}: {n}
                    </li>
                  ))}
                </ul>
              )}
              {editing === wall.id && (
                <WallFramingEditor
                  key={`${wall.id}/${JSON.stringify(wall.params)}/${JSON.stringify(wall.expressions)}`}
                  wall={wall}
                  onSave={(form) => {
                    const r = buildWallFraming(
                      documents.getState().document,
                      partId,
                      wall.id,
                      form,
                      evaluateVariables(documents.getState().document),
                    );
                    if (!r.ok) return r.errors;
                    if (onRun(r)) ui.getState().editWall(null);
                    return {};
                  }}
                  onCancel={() => ui.getState().editWall(null)}
                />
              )}
              {openings.length > 0 && (
                <ul className="construction-openings">
                  {openings.map((o) => (
                    <OpeningRow
                      key={o.id}
                      opening={o}
                      set={set}
                      settings={settings}
                      units={doc.units}
                      error={featureResult({ parts }, partId, o.id)?.errors[0]?.message}
                      phase={phaseText(o.id, featureResult({ parts }, partId, o.id)?.metadata, set)}
                      disabled={disabled}
                      onEdit={() =>
                        ui.getState().startTool({ kind: 'opening', featureId: o.id, wall: wall.id })
                      }
                    />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function OpeningRow({
  opening,
  set,
  settings,
  units,
  error,
  phase,
  disabled,
  onEdit,
}: {
  opening: ExtensionFeature;
  set: MemberSetView | undefined;
  settings: ConstructionSettings | undefined;
  units: DisplayUnits;
  error: string | undefined;
  phase: string | null;
  disabled: boolean;
  onEdit: () => void;
}) {
  const used = headerUsed(set?.metadata, opening.id);
  const choice = ((opening.params.header as { kind?: HeaderChoice } | undefined)?.kind ??
    'auto') as HeaderChoice;
  const own = set ? set.members.filter((m) => m.owner === opening.id).length : 0;
  return (
    <li data-testid={`opening-${opening.id}`}>
      <div className="construction-row">
        <span>{opening.name}</span>
        <span className="wall-count" data-testid={`opening-members-${opening.id}`}>
          {set ? `${own} members` : ''}
        </span>
        <button
          type="button"
          data-testid={`opening-edit-${opening.id}`}
          disabled={disabled}
          onClick={onEdit}
        >
          Edit
        </button>
      </div>
      {used && (
        <p
          className="field-note"
          data-testid={`opening-header-${opening.id}`}
          data-source={used.source}
        >
          Header: {headerSourceText(usedAsPreview(used, settings, choice), units)}
          {used.framed ? '' : ' Not framed: see the wall.'}
        </p>
      )}
      {phase && (
        <p className="field-note" data-testid={`opening-phase-${opening.id}`}>
          {phase}
        </p>
      )}
      {error && <p className="field-error">{error}</p>}
    </li>
  );
}

const PLATES = [
  ['', 'Default'],
  ['1', '1'],
  ['2', '2'],
  ['3', '3'],
] as const;

function WallFramingEditor({
  wall,
  onSave,
  onCancel,
}: {
  wall: ExtensionFeature;
  onSave: (form: WallFramingForm) => Record<string, string>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState(() => framingFormOf(wall));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (patch: Partial<WallFramingForm>) => setForm((f) => ({ ...f, ...patch }));
  return (
    <form
      className="construction-form"
      data-testid="wall-framing-editor"
      onSubmit={(e) => {
        e.preventDefault();
        setErrors(onSave(form));
      }}
    >
      <p className="field-note">
        Empty fields and Default keep the level&apos;s, wall type&apos;s or document&apos;s setting.
      </p>
      <Field
        label="Height"
        testId="wall-height"
        value={form.height}
        error={errors.height}
        onChange={(height) => set({ height })}
      />
      <Field
        label="Stud spacing on centre"
        testId="wall-spacing"
        value={form.spacing}
        error={errors.spacing}
        onChange={(spacing) => set({ spacing })}
      />
      <Select
        label="Layout from"
        name="wall-layout-from"
        value={form.layoutFrom}
        options={[
          ['', 'Default'],
          ['start', 'Start of the wall'],
          ['end', 'End of the wall'],
        ]}
        onChange={(v) => set({ layoutFrom: v as WallFramingForm['layoutFrom'] })}
      />
      <Select
        label="Bottom plates"
        name="wall-bottom-plates"
        value={form.bottomPlates}
        options={PLATES}
        onChange={(v) => set({ bottomPlates: v as WallFramingForm['bottomPlates'] })}
      />
      <Select
        label="Top plates"
        name="wall-top-plates"
        value={form.topPlates}
        options={PLATES}
        onChange={(v) => set({ topPlates: v as WallFramingForm['topPlates'] })}
      />
      <Select
        label="King studs each side of an opening"
        name="wall-kings"
        value={form.kings}
        options={[...PLATES, ['4', '4']]}
        onChange={(v) => set({ kings: v as WallFramingForm['kings'] })}
      />
      <Select
        label="Corners"
        name="wall-corners"
        value={form.cornerStyle}
        options={[
          ['', 'Default'],
          ['two-stud', 'Two-stud'],
          ['three-stud', 'Three-stud'],
          ['ladder', 'Ladder'],
        ]}
        onChange={(v) => set({ cornerStyle: v as WallFramingForm['cornerStyle'] })}
      />
      <Select
        label="Blocking"
        name="wall-blocking"
        value={form.blocking}
        options={[
          ['', 'Default'],
          ['none', 'None'],
          ['mid-height', 'One row at mid-height'],
        ]}
        onChange={(v) => set({ blocking: v as WallFramingForm['blocking'] })}
      />
      {errors.form && (
        <p className="field-error" role="alert">
          {errors.form}
        </p>
      )}
      <div className="dialog-buttons">
        <button type="submit" className="primary" data-testid="wall-framing-save">
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
