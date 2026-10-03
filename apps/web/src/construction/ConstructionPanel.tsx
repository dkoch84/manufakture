// The Construction panel (ADR 0015: construction is a toolbar group and panels in the part studio,
// not a workspace of its own): the "not an engineering tool" notice once per document, help,
// levels, wall types, framing settings and header rules, the walls, floors and roofs with what
// regen framed for them, and actions on a picked member.
// A document without construction settings is offered to start them (one level, no wall types,
// no header rules).

import { lazy, Suspense, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import type { ModelStore } from '../model/model';
import type { DocumentStoreApi } from '../state/document';
import type { SelectionStore } from '../state/selection';
import type { MemberStore } from '../viewport/memberStore';
import { ConstructionHelp, DisclaimerNotice } from './Disclaimer';
import { FloorsRoofsList } from './FloorsRoofsList';
import { FramingSettingsPanel } from './framing/FramingSettingsPanel';
import { LevelsPanel } from './LevelsPanel';
import { MemberActions } from './MemberActions';
import { documentConstruction, startCommand, type Outcome } from './settings';
import type { ConstructionUiStore } from './state';
import { WallsList } from './WallsList';
import { WallTypesEditor } from './WallTypesEditor';
import './construction.css';

// The Takeoff panel (T6.3b) beside this one, loaded when first opened (it carries the PDF writer).
const TakeoffPanel = lazy(() =>
  import('./takeoff/TakeoffPanel').then((m) => ({ default: m.TakeoffPanel })),
);

export interface ConstructionPanelProps {
  documents: DocumentStoreApi;
  model: ModelStore;
  members: MemberStore;
  selection: SelectionStore;
  ui: ConstructionUiStore;
  partId: string;
  disabled?: boolean;
}

function ConstructionAside({
  documents,
  model,
  members,
  selection,
  ui,
  partId,
  disabled = false,
  takeoff,
}: ConstructionPanelProps & { takeoff: { open: boolean; toggle: () => void } }) {
  const doc = useStore(documents, (s) => s.document);
  const data = useMemo(() => documentConstruction(doc), [doc]);
  const [failure, setFailure] = useState<string | null>(null);

  const run = (r: Outcome): boolean => {
    if (!r.ok) {
      setFailure(r.message);
      return false;
    }
    if (r.command) {
      const done = documents.getState().execute(r.command, r.label);
      if (!done.ok) {
        setFailure(done.error.message);
        return false;
      }
    }
    setFailure(null);
    return true;
  };

  return (
    <aside
      className="selection-panel construction-panel"
      aria-label="Construction"
      data-testid="construction-panel"
    >
      <div className="variables-head">
        <h2>Construction</h2>
        <button
          type="button"
          data-testid="takeoff-open"
          aria-pressed={takeoff.open}
          onClick={takeoff.toggle}
        >
          Takeoff
        </button>
        <button
          type="button"
          data-testid="construction-close"
          onClick={() => ui.getState().setOpen(false)}
        >
          Close
        </button>
      </div>
      <DisclaimerNotice ui={ui} documentId={doc.id} />
      <ConstructionHelp />
      {!data.ok ? (
        <p className="field-error" role="alert">
          The construction settings cannot be read, so they are kept as they are: {data.message}
        </p>
      ) : data.data === undefined ? (
        <div className="construction-section">
          <p className="field-note">
            This document has no construction settings yet. Starting them adds one level; wall types
            and header rules are yours to make.
          </p>
          <button
            type="button"
            className="primary"
            data-testid="construction-start"
            disabled={disabled}
            onClick={() => run(startCommand(documents.getState().document))}
          >
            Start construction
          </button>
        </div>
      ) : (
        <>
          <LevelsPanel
            documents={documents}
            ui={ui}
            levels={data.data.stored.levels}
            disabled={disabled}
            run={run}
          />
          <WallTypesEditor
            documents={documents}
            types={data.data.stored.wallTypes}
            disabled={disabled}
            run={run}
          />
          <FramingSettingsPanel
            documents={documents}
            framing={data.data.stored.framing}
            headerRules={data.data.stored.headerRules}
            disabled={disabled}
            run={run}
          />
          <WallsList
            documents={documents}
            model={model}
            members={members}
            ui={ui}
            partId={partId}
            settings={data.data.settings}
            disabled={disabled}
            onRun={run}
          />
          <FloorsRoofsList
            documents={documents}
            model={model}
            members={members}
            ui={ui}
            partId={partId}
            disabled={disabled}
          />
        </>
      )}
      <MemberActions
        documents={documents}
        selection={selection}
        partId={partId}
        disabled={disabled}
      />
      {failure && (
        <p className="field-error" role="alert" data-testid="construction-error">
          {failure}
        </p>
      )}
    </aside>
  );
}

/** The Construction panel, and the Takeoff panel beside it when opened. */
export function ConstructionPanel(props: ConstructionPanelProps) {
  const [takeoffOpen, setTakeoffOpen] = useState(false);
  return (
    <>
      <ConstructionAside
        {...props}
        takeoff={{ open: takeoffOpen, toggle: () => setTakeoffOpen((o) => !o) }}
      />
      {takeoffOpen && (
        <Suspense fallback={<aside className="selection-panel" aria-busy="true" />}>
          <TakeoffPanel
            documents={props.documents}
            model={props.model}
            members={props.members}
            selection={props.selection}
            partId={props.partId}
            disabled={props.disabled ?? false}
            onClose={() => setTakeoffOpen(false)}
          />
        </Suspense>
      )}
    </>
  );
}
