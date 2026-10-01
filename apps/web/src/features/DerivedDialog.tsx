// The derived part dialog: a part of a named version of a document (the pinned-part picker), the
// bodies of it to bring in, where they go (a translation and a rotation, as expressions), and how
// they combine with the part's own bodies. OK applies it as one core command (one undo step);
// Cancel or Escape leaves the document alone. Editing an existing derived part keeps its pin
// unless **Change source or version** picks another. **Configuration** picks a row of the source
// document's configuration table to build it in (T2.4c). The logic is in derived.ts.

import { defaultFeatureName, findPart, previewIds, type DerivedFeature } from '@manufakture/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ExpressionField } from '../components/ExpressionField';
import type { CreateVersion } from '../history/history';
import { partBodies } from '../model/bodies';
import type { ModelStore } from '../model/model';
import { evaluateVariables } from '../sketcher/values';
import type { DocumentStoreApi } from '../state/document';
import { KIND_LABELS } from '../tree/tree';
import { ConfigurationPicker } from './ConfigurationPicker';
import {
  buildDerived,
  configurationRows,
  defaultRowLabel,
  derivedFormOf,
  newDerivedForm,
  pinLabel,
  pinnedDocument,
  sourceBodies,
  sourceInRow,
  withRow,
  type DerivedForm,
  type PinLibrary,
  type PinnedPart,
} from './derived';
import { scopeBodies, type Operation } from './forms';
import { PinnedPartPicker } from './PinnedPartPicker';
import { ScopePicker } from './ScopePicker';

export interface DerivedDialogProps {
  request: { kind: 'derived'; featureId?: string };
  documents: DocumentStoreApi;
  model: ModelStore;
  /** The part studio the feature is in; default: the active one when the dialog opens. */
  partId?: string;
  library: PinLibrary | null;
  createVersion?: CreateVersion | null;
  onClose: () => void;
}

const OPERATIONS: readonly [Operation, string][] = [
  ['new', 'New body'],
  ['add', 'Add'],
  ['cut', 'Remove'],
  ['intersect', 'Intersect'],
];

const AXES = ['x', 'y', 'z'] as const;

export function DerivedDialog({
  request,
  documents,
  model,
  partId: givenPartId,
  library,
  createVersion = null,
  onClose,
}: DerivedDialogProps) {
  const [partId] = useState(() => givenPartId ?? documents.getState().activePartId);
  const doc = documents.getState().document;
  const part = findPart(doc, partId)!;
  const found = request.featureId
    ? part.features.find((f) => f.id === request.featureId)
    : undefined;
  const existing = found?.kind === 'derived' ? (found as DerivedFeature) : undefined;
  const units = doc.units;
  // The document cannot change while the dialog is open (the tree, the tabs and the variables
  // step aside), so what it reads of it is read once.
  const [variables] = useState(() => evaluateVariables(doc));
  const [variableNames] = useState(() => doc.variables.map((v) => v.name));

  const [form, setForm] = useState<DerivedForm>(() =>
    existing ? derivedFormOf(existing) : newDerivedForm(),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [changing, setChanging] = useState(!existing);
  const [picked, setPicked] = useState<PinnedPart | null>(null);
  const [existingDoc] = useState(() => (existing ? pinnedDocument(existing.source) : null));
  // The existing pin's document while the pin is the same version (its row may differ).
  const sourceDoc =
    picked?.document ??
    (form.source !== null && form.source.sha256 === existing?.source.sha256 ? existingDoc : null);

  const onPicked = (pin: PinnedPart | null) => {
    setPicked(pin);
    setForm((f) => {
      const row = f.source?.configuration;
      let next = pin?.source ?? (existing ? withRow(existing.source, row) : null);
      // A row the newly picked version does not have is dropped: back to its default.
      if (
        pin &&
        next?.configuration !== undefined &&
        !configurationRows(pin.document).some((r) => r.id === next!.configuration)
      ) {
        next = withRow(next, undefined);
      }
      // Another document or part studio: its bodies are other bodies.
      const same =
        f.source !== null &&
        next !== null &&
        f.source.documentId === next.documentId &&
        f.source.partId === next.partId;
      const { bodies: _bodies, ...rest } = f;
      void _bodies;
      return same ? { ...f, source: next } : { ...rest, source: next };
    });
    if (pin) {
      setErrors((e) => {
        const { source: _gone, ...rest } = e;
        void _gone;
        return rest;
      });
    }
  };

  const index = existing
    ? part.features.indexOf(existing)
    : (part.rollbackIndex ?? part.features.length);
  const id = existing?.id ?? previewIds(part.nextIds, 'derived')[0]!;
  const title = existing?.name ?? defaultFeatureName('derived', id);

  // Focus moves in on open and goes back on close (as the other feature dialogs do).
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const opener = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.focus();
    return () => {
      const now = document.activeElement;
      const inside = now === null || now === document.body || (dialog?.contains(now) ?? false);
      if (inside && opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const apply = () => {
    const current = documents.getState().document;
    const r = buildDerived(
      form,
      existing ? { doc: current, partId, existing } : { doc: current, partId },
    );
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

  const row = form.source?.configuration;
  const bodyChoices = useMemo(() => {
    if (!sourceDoc || !form.source) return [];
    const offered = sourceBodies(sourceInRow(sourceDoc, row), form.source.partId);
    for (const b of form.bodies ?? []) {
      if (!offered.some((o) => o.bodyId === b)) offered.push({ bodyId: b, name: b });
    }
    return offered;
  }, [sourceDoc, form.source, form.bodies, row]);

  const modelParts = model.getState().parts;
  const scopeChoices = useMemo(
    () =>
      scopeBodies(
        part,
        index,
        partBodies(
          part,
          modelParts.find((p) => p.partId === partId),
        ),
        form.scope ?? [],
      ),
    [part, index, modelParts, partId, form.scope],
  );

  const placement = (which: 'translation' | 'rotation', axis: number) => {
    const key = `${which}-${AXES[axis]}`;
    const label =
      which === 'translation'
        ? `Move along ${AXES[axis]!.toUpperCase()}`
        : `Rotate about ${AXES[axis]!.toUpperCase()}`;
    return (
      <ExpressionField
        key={key}
        label={label}
        testId={`field-${key}`}
        value={form[which][axis]!}
        kind={which === 'translation' ? 'length' : 'angle'}
        units={units}
        variables={variables}
        names={variableNames}
        error={errors[key]}
        onChange={(v) =>
          setForm((f) => {
            const next = [...f[which]] as [string, string, string];
            next[axis] = v;
            return { ...f, [which]: next };
          })
        }
      />
    );
  };

  const canPick = library !== null;

  return (
    <aside
      ref={dialogRef}
      tabIndex={-1}
      className="selection-panel feature-dialog derived-dialog"
      role="dialog"
      aria-label={`${KIND_LABELS.derived}: ${title}`}
      data-testid="feature-dialog"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        } else if (
          e.key === 'Enter' &&
          (e.target as HTMLElement).tagName === 'INPUT' &&
          (e.target as HTMLInputElement).type !== 'checkbox'
        ) {
          e.preventDefault();
          apply();
        }
      }}
    >
      <h2>
        {KIND_LABELS.derived}: {title}
      </h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        {existing && (
          <div className="dialog-field derived-pin" data-testid="derived-pin">
            <span>
              From <strong>{pinLabel(form.source ?? existing.source)}</strong>
            </span>
            {!changing && canPick && (
              <button
                type="button"
                data-testid="derived-change-source"
                onClick={() => setChanging(true)}
              >
                Change source or version
              </button>
            )}
          </div>
        )}
        {!canPick && !existing && (
          <p className="field-error" role="alert" data-testid="derived-no-library">
            A derived part comes from a saved document, and nothing is saved here.
          </p>
        )}
        {changing && library && (
          <PinnedPartPicker
            library={library}
            currentDocumentId={doc.id}
            createVersion={createVersion}
            initial={existing ? existing.source : null}
            {...(form.source?.configuration !== undefined
              ? { configuration: form.source.configuration }
              : {})}
            onChange={onPicked}
          />
        )}
        {errors.source && (
          <p className="field-error" data-testid="field-source-error">
            {errors.source}
          </p>
        )}
        {form.source && sourceDoc && (
          <ConfigurationPicker
            rows={configurationRows(sourceDoc)}
            value={row}
            defaultLabel={defaultRowLabel(sourceDoc)}
            onChange={(next) =>
              setForm((f) => (f.source ? { ...f, source: withRow(f.source, next) } : f))
            }
          />
        )}
        {form.source && sourceDoc && (
          <ScopePicker
            legend="Source bodies"
            testId="field-bodies"
            bodies={bodyChoices}
            scope={form.bodies}
            error={errors.bodies}
            onChange={(bodies) =>
              setForm((f) => {
                const { bodies: _old, ...rest } = f;
                void _old;
                return bodies === undefined ? rest : { ...rest, bodies: [...bodies] };
              })
            }
          />
        )}
        <fieldset className="dialog-field derived-placement" data-testid="field-placement">
          <legend>Placement</legend>
          {AXES.map((_, i) => placement('translation', i))}
          {AXES.map((_, i) => placement('rotation', i))}
        </fieldset>
        <div className="dialog-field">
          <label>
            Result
            <select
              value={form.operation}
              data-testid="field-operation"
              onChange={(e) => setForm((f) => ({ ...f, operation: e.target.value as Operation }))}
            >
              {OPERATIONS.map(([v, text]) => (
                <option key={v} value={v}>
                  {text}
                </option>
              ))}
            </select>
          </label>
        </div>
        {form.operation !== 'new' && (scopeChoices.length > 1 || form.scope !== undefined) && (
          <ScopePicker
            legend="Combine with"
            bodies={scopeChoices}
            scope={form.scope}
            error={errors.scope}
            onChange={(scope) =>
              setForm((f) => {
                const { scope: _old, ...rest } = f;
                void _old;
                return scope === undefined ? rest : { ...rest, scope: [...scope] };
              })
            }
          />
        )}
        {errors.form && (
          <p className="field-error" role="alert">
            {errors.form}
          </p>
        )}
        <div className="dialog-buttons">
          <button type="submit" className="primary" data-testid="dialog-ok" disabled={!form.source}>
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
