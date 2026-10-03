// The Floors and roofs section of the Construction panel: each floor and roof of the part studio
// with what regen framed for it (its member count by role), a roof's kind and pitch (`p/12` and
// degrees), any error, and Edit, which opens the Floor or Roof tool on it.

import type { ExtensionFeature } from '@manufakture/core';
import { useMemo } from 'react';
import { useStore } from 'zustand';
import { featureResult, type ModelStore } from '../model/model';
import type { DocumentStoreApi } from '../state/document';
import { roleLabel } from '../viewport/members';
import { shownMemberView, type MemberStore } from '../viewport/memberStore';
import { isFloor, isRoof } from './kinds';
import { checkPitch, pitchSummary } from './roof/pitch';
import type { ConstructionUiStore } from './state';
import { roleCounts } from './walls';

export function FloorsRoofsList({
  documents,
  model,
  members,
  ui,
  partId,
  disabled,
}: {
  documents: DocumentStoreApi;
  model: ModelStore;
  members: MemberStore;
  ui: ConstructionUiStore;
  partId: string;
  disabled: boolean;
}) {
  const doc = useStore(documents, (s) => s.document);
  const part = doc.parts.find((p) => p.id === partId);
  const features = useMemo(
    () => (part?.features ?? []).filter((f): f is ExtensionFeature => isFloor(f) || isRoof(f)),
    [part],
  );
  const view = useStore(members, shownMemberView);
  const parts = useStore(model, (s) => s.parts);
  if (features.length === 0) {
    return (
      <section className="construction-section" aria-label="Floors and roofs">
        <h3>Floors and roofs</h3>
        <p className="field-note">
          None yet. Use Floor and Roof in the Construction tools to add them.
        </p>
      </section>
    );
  }
  const sets = new Map(view.sets.map((s) => [s.group, s]));
  return (
    <section
      className="construction-section"
      aria-label="Floors and roofs"
      data-testid="floors-roofs-list"
    >
      <h3>Floors and roofs</h3>
      <ul className="construction-list">
        {features.map((f) => {
          const set = sets.get(f.id);
          const counts = roleCounts(set);
          const result = featureResult({ parts }, partId, f.id);
          const problem = result?.errors[0]?.message;
          const roof = isRoof(f);
          const pitch =
            roof && f.expressions.pitch ? checkPitch(f.expressions.pitch.source, doc.units) : null;
          return (
            <li key={f.id} data-testid={`construction-feature-${f.id}`}>
              <div className="construction-row">
                <strong>{f.name}</strong>
                <span data-testid={`construction-members-${f.id}`} className="wall-count">
                  {set ? `${counts.total} members` : result ? 'not framed' : 'building...'}
                </span>
                <button
                  type="button"
                  data-testid={`construction-edit-${f.id}`}
                  disabled={disabled}
                  onClick={() =>
                    ui.getState().startTool({ kind: roof ? 'roof' : 'floor', featureId: f.id })
                  }
                >
                  Edit
                </button>
              </div>
              {roof && (
                <p className="field-note" data-testid={`roof-summary-${f.id}`}>
                  {f.params.kind === 'hip' ? 'Hip' : 'Gable'}
                  {pitch?.ok ? `, ${pitchSummary(pitch.value)}` : ''}
                </p>
              )}
              {problem && (
                <p className="field-error" data-testid={`construction-error-${f.id}`}>
                  {problem}
                </p>
              )}
              {counts.roles.length > 0 && (
                <ul className="role-counts" data-testid={`construction-roles-${f.id}`}>
                  {counts.roles.map(([role, n]) => (
                    <li key={role} data-testid={`construction-role-${f.id}-${role}`} data-count={n}>
                      {roleLabel(role)}: {n}
                    </li>
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
