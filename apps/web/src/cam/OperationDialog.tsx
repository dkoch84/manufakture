// The operation dialogs (M5 plan, T5.3a): one panel per operation kind (facing, profile, pocket,
// drill, V-carve), new or existing, built from `ExpressionField` like the feature dialogs. Faces
// are picked in the viewport (planar faces of the setup's part, named by the kernel's `pick` op);
// sketch regions and hole features are chosen from lists. Every field is checked for its kind and
// range as it is typed; OK applies the whole dialog as one core command (one undo step), Cancel or
// Escape leaves the document alone. A source the last geometry request lost is marked, and with
// `repick` the next face picked takes its place.

import { findPart, type CamOperation } from '@manufakture/core';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { ExpressionField } from '../components/ExpressionField';
import type { DocumentStoreApi } from '../state/document';
import {
  isGeometryRef,
  itemKey,
  type GeometryRef,
  type SelectableItem,
  type SelectionStore,
} from '../state/selection';
import type { CamGeometryResult } from '@manufakture/regen';
import {
  FEED_KEYS,
  FEED_SPECS,
  FIELD_SPECS,
  OPERATION_LABELS,
  acceptedSources,
  activeFields,
  addFace,
  addSource,
  buildOperation,
  formOf,
  newOperationForm,
  newOperationName,
  removeSource,
  sourceLabel,
  suitableTools,
  type OperationForm,
} from './forms';
import { setupFaceReference, type CamFaceResolver } from './picking';
import type { CamDialog } from './state';
import { repicks } from './status';
import { TOOL_KIND_LABELS } from './toolForms';
import { camVariables, validator } from './values';

export interface OperationDialogProps {
  request: Extract<CamDialog, { kind: 'operation' }>;
  documents: DocumentStoreApi;
  setupId: string;
  selection: SelectionStore;
  /** Turns a viewport pick into a stored face. */
  resolveFace: CamFaceResolver;
  /** The last geometry reply for the setup, for the sources it lost. */
  geometry: CamGeometryResult | null;
  onClose: () => void;
  /** Told the operation's id after OK applied it. */
  onApplied?: (operationId: string) => void;
}

export function OperationDialog({
  request,
  documents,
  setupId,
  selection,
  resolveFace,
  geometry,
  onClose,
  onApplied,
}: OperationDialogProps) {
  const doc = useStore(documents, (s) => s.document);
  // The setup and operation as they were when the dialog opened: the form owns the edits.
  const [opened] = useState(() => {
    const d = documents.getState().document;
    const setup = d.cam.setups.find((s) => s.id === setupId);
    const existing =
      request.operationId === undefined
        ? undefined
        : setup?.operations.find((o) => o.id === request.operationId);
    return { setup, existing };
  });
  const { setup, existing } = opened;
  const part = setup ? findPart(doc, setup.part) : undefined;
  const units = doc.units;
  const variables = useMemo(() => camVariables(doc), [doc]);
  const names = useMemo(() => doc.variables.map((v) => v.name), [doc]);

  const [form, setForm] = useState<OperationForm>(() => {
    const d = documents.getState().document;
    if (existing && setup) {
      const result = geometry?.operations.find((o) => o.operationId === existing.id);
      const lost = new Set(result ? repicks(result) : []);
      if (request.repick !== undefined) lost.add(request.repick);
      const f = formOf(d, setup, existing, lost);
      if (f) return f;
    }
    return newOperationForm(d, request.operation, newOperationName(d, request.operation));
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pickMessage, setPickMessage] = useState<string | null>(null);
  const takesFaces = acceptedSources(form.kind).includes('face');
  // Faces picked in the view go to the sources; a re-pick replaces the source it names.
  const [picking, setPicking] = useState(takesFaces);
  const replacing = useRef<number | undefined>(
    request.repick ?? form.sources.findIndex((s) => s.lost && s.kind === 'face'),
  );
  if (replacing.current !== undefined && replacing.current < 0) replacing.current = undefined;
  const pickingRef = useRef(picking);
  useEffect(() => {
    pickingRef.current = picking;
  }, [picking]);

  const pick = useCallback(
    (geo: GeometryRef) => {
      if (!pickingRef.current || !setup) {
        setPickMessage('Faces are not picked for this operation.');
        return;
      }
      void setupFaceReference(resolveFace, geo, setup).then((r) => {
        if (!r.ok) {
          setPickMessage(r.message);
          return;
        }
        setPickMessage(null);
        const at = replacing.current;
        replacing.current = undefined;
        setForm((f) => addFace(f, r.ref, at));
        setErrors(({ sources: _gone, ...rest }) => {
          void _gone;
          return rest;
        });
      });
    },
    [resolveFace, setup],
  );

  // Faces picked while the dialog is open go to the sources; so do faces already selected when a
  // new operation's dialog opens (pick first, then the operation).
  useEffect(() => {
    let previous: readonly SelectableItem[] = selection.getState().selected;
    if (!existing && takesFaces) {
      for (const item of previous) if (isGeometryRef(item) && item.kind === 'face') pick(item);
    }
    return selection.subscribe((s) => {
      if (s.selected === previous) return;
      const before = new Set(previous.map(itemKey));
      previous = s.selected;
      for (const item of s.selected) {
        if (isGeometryRef(item) && !before.has(itemKey(item))) pick(item);
      }
    });
    // Once per dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, pick]);

  // Focus moves in on open and back on close, unless the user put it somewhere else meanwhile.
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

  // An edit whose operation is not in the setup (deleted, moved, or the dialog came back on
  // another setup after an undo) must not turn into an add of a blank operation.
  const gone = !setup
    ? 'The setup is gone.'
    : request.operationId !== undefined && !existing
      ? 'The operation is gone (deleted or moved meanwhile).'
      : null;
  if (!setup || gone) {
    return (
      <aside className="selection-panel cam-dialog" role="dialog" aria-label="CAM operation">
        <p className="field-error" role="alert" data-testid="cam-op-gone">
          {gone}
        </p>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </aside>
    );
  }

  const apply = () => {
    const current = documents.getState().document;
    const currentSetup = current.cam.setups.find((s) => s.id === setup.id);
    if (!currentSetup) {
      setErrors({ form: 'The setup is gone.' });
      return;
    }
    // The faces and sketches were picked on the part (and body) the setup machined when the dialog
    // opened; an undo meanwhile may have pointed the setup elsewhere, where they would resolve on
    // look-alike features.
    if (currentSetup.part !== setup.part || currentSetup.body !== setup.body) {
      setErrors({
        form: 'The setup now machines another part: close the dialog and pick again.',
      });
      return;
    }
    // The operation as it is now: a suppress or rename from the list while the dialog was open
    // stays, unless the dialog changed the name itself.
    const now = existing ? currentSetup.operations.find((o) => o.id === existing.id) : undefined;
    if (existing && !now) {
      setErrors({ form: 'The operation is gone (deleted or moved meanwhile).' });
      return;
    }
    const keepName = now !== undefined && existing !== undefined && form.name === existing.name;
    const r = buildOperation(keepName ? { ...form, name: now.name } : form, {
      doc: current,
      setup: currentSetup,
      ...(now ? { existing: now } : {}),
      units: current.units,
      variables: camVariables(current),
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
    onApplied?.(r.operationId);
    onClose();
  };

  const set = <K extends keyof OperationForm>(key: K, value: OperationForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const fields = new Set(activeFields(form));
  const expression = (key: keyof typeof FIELD_SPECS, label?: string) => {
    if (!fields.has(key)) return null;
    const s = FIELD_SPECS[key];
    return (
      <ExpressionField
        key={key}
        label={label ?? s.label}
        testId={`cam-field-${key}`}
        value={form[key]}
        kind={s.kind}
        units={units}
        variables={variables}
        names={names}
        validate={validator(s.rule)}
        error={errors[key]}
        onChange={(v) => set(key, v)}
      />
    );
  };

  const tools = suitableTools(doc, form.kind);
  const sketches = (part?.features ?? []).filter((f) => f.kind === 'sketch');
  const holes = (part?.features ?? []).filter((f) => f.kind === 'hole');
  const label = OPERATION_LABELS[form.kind];
  const title = existing?.name ?? form.name;

  const body: ReactNode[] = [];
  body.push(
    <div key="name" className="dialog-field">
      <label>
        Name
        <input
          type="text"
          data-testid="cam-op-name"
          value={form.name}
          aria-invalid={errors.name !== undefined}
          onChange={(e) => set('name', e.target.value)}
        />
      </label>
      {errors.name && <span className="field-error">{errors.name}</span>}
    </div>,
    <div key="tool" className="dialog-field">
      <label>
        Tool
        <select
          data-testid="cam-op-tool"
          value={form.tool}
          aria-invalid={errors.tool !== undefined}
          onChange={(e) => set('tool', e.target.value)}
        >
          {!tools.some((t) => t.id === form.tool) && (
            <option value={form.tool}>{form.tool === '' ? 'Choose a tool' : form.tool}</option>
          )}
          {tools.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({TOOL_KIND_LABELS[t.kind]}, {t.diameter.source})
            </option>
          ))}
        </select>
      </label>
      {errors.tool && (
        <span className="field-error" data-testid="cam-op-tool-error">
          {errors.tool}
        </span>
      )}
    </div>,
    <Sources
      key="sources"
      form={form}
      picking={picking}
      takesFaces={takesFaces}
      error={errors.sources}
      sketches={sketches}
      holes={holes}
      onPicking={setPicking}
      onAdd={(draft) => setForm((f) => addSource(f, draft))}
      onRemove={(i) => setForm((f) => removeSource(f, i))}
      onRepick={(i) => {
        replacing.current = i;
        setPicking(true);
        setPickMessage('Pick the face again in the view.');
      }}
      partLabel={(s) => sourceLabel(part, s)}
    />,
  );

  const select = <K extends 'side' | 'entry' | 'leadIn' | 'leadOut' | 'depthMode'>(
    key: K,
    text: string,
    options: readonly (readonly [OperationForm[K], string])[],
  ) => (
    <div key={key} className="dialog-field">
      <label>
        {text}
        <select
          data-testid={`cam-field-${key}`}
          value={form[key]}
          onChange={(e) => set(key, e.target.value as OperationForm[K])}
        >
          {options.map(([v, t]) => (
            <option key={v} value={v}>
              {t}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
  const check = (key: 'climb' | 'tabs', text: string) => (
    <label key={key} className="dialog-check">
      <input
        type="checkbox"
        data-testid={`cam-field-${key}`}
        checked={form[key]}
        onChange={(e) => set(key, e.target.checked)}
      />
      {text}
    </label>
  );
  const depthModes: readonly (readonly [OperationForm['depthMode'], string])[] =
    form.kind === 'drill'
      ? [
          ['own', "Each hole's own depth"],
          ['blind', 'Blind'],
          ['through', 'Through the stock'],
        ]
      : [
          ['blind', 'Blind'],
          ['through', 'Through the stock'],
        ];

  switch (form.kind) {
    case 'facing':
      body.push(
        expression('depth', 'Depth to remove from the stock top'),
        expression('stepdown'),
        expression('stepover'),
        expression('angle'),
      );
      break;
    case 'profile':
      body.push(
        select('side', 'Side', [
          ['outside', 'Outside'],
          ['inside', 'Inside'],
          ['on', 'On the line'],
        ]),
        select('depthMode', 'Depth', depthModes),
        expression('depth'),
        expression('extra'),
        expression('stepdown'),
        expression('finishAllowance'),
        check('tabs', 'Tabs (hold the part when cutting through)'),
        expression('tabCount'),
        expression('tabWidth'),
        expression('tabHeight'),
        select('entry', 'Entry', [
          ['plunge', 'Plunge'],
          ['ramp', 'Ramp'],
          ['helix', 'Helix'],
        ]),
        expression('entryAngle'),
        expression('entryRadius'),
        select('leadIn', 'Lead-in', [
          ['none', 'None'],
          ['line', 'Line'],
          ['arc', 'Arc'],
        ]),
        expression('leadInSize', form.leadIn === 'arc' ? 'Lead-in radius' : 'Lead-in length'),
        select('leadOut', 'Lead-out', [
          ['none', 'None'],
          ['line', 'Line'],
          ['arc', 'Arc'],
        ]),
        expression('leadOutSize', form.leadOut === 'arc' ? 'Lead-out radius' : 'Lead-out length'),
        check('climb', 'Climb milling (off: conventional)'),
      );
      break;
    case 'pocket':
      body.push(
        select('depthMode', 'Depth', depthModes),
        <p key="floor" className="field-note">
          A pocket on a face stops at that face (its floor); the depth applies to sketch regions.
        </p>,
        expression('depth'),
        expression('extra'),
        expression('stepdown'),
        expression('stepover'),
        expression('finishAllowance'),
        select('entry', 'Entry', [
          ['plunge', 'Plunge'],
          ['ramp', 'Ramp'],
          ['helix', 'Helix'],
        ]),
        expression('entryAngle'),
        expression('entryRadius'),
        check('climb', 'Climb milling (off: conventional)'),
      );
      break;
    case 'drill':
      body.push(
        select('depthMode', 'Depth', depthModes),
        expression('depth'),
        expression('extra'),
        expression('peck'),
        expression('dwell'),
      );
      break;
    case 'vcarve':
      body.push(expression('maxDepth'));
      break;
  }

  body.push(
    <details key="feeds" className="cam-feeds" data-testid="cam-feeds">
      <summary>Feeds and speed</summary>
      <p className="field-note">
        Empty fields take the tool&apos;s preset for the stock&apos;s material.
      </p>
      {FEED_KEYS.map((k) => (
        <ExpressionField
          key={k}
          label={FEED_SPECS[k].label}
          testId={`cam-field-feeds-${k}`}
          value={form.feeds[k]}
          kind={FEED_SPECS[k].kind}
          units={units}
          variables={variables}
          names={names}
          validate={validator(FEED_SPECS[k].rule)}
          error={errors[`feeds.${k}`]}
          onChange={(v) => setForm((f) => ({ ...f, feeds: { ...f.feeds, [k]: v } }))}
        />
      ))}
    </details>,
  );

  return (
    <aside
      ref={dialogRef}
      tabIndex={-1}
      className="selection-panel feature-dialog cam-dialog"
      role="dialog"
      aria-label={`${label}: ${title}`}
      data-testid="cam-op-dialog"
      data-kind={form.kind}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        } else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
          e.preventDefault();
          apply();
        }
      }}
    >
      <h2>
        {label}: {title}
      </h2>
      <p className="field-note">In {setup.name}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        {body}
        {pickMessage && (
          <p className="field-error" role="status" data-testid="cam-pick-message">
            {pickMessage}
          </p>
        )}
        {errors.form && (
          <p className="field-error" role="alert" data-testid="cam-op-error">
            {errors.form}
          </p>
        )}
        <div className="dialog-buttons">
          <button type="submit" className="primary" data-testid="cam-op-ok">
            OK
          </button>
          <button type="button" data-testid="cam-op-cancel" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </aside>
  );
}

function Sources({
  form,
  picking,
  takesFaces,
  error,
  sketches,
  holes,
  onPicking,
  onAdd,
  onRemove,
  onRepick,
  partLabel,
}: {
  form: OperationForm;
  picking: boolean;
  takesFaces: boolean;
  error: string | undefined;
  sketches: readonly { id: string; name: string }[];
  holes: readonly { id: string; name: string }[];
  onPicking: (on: boolean) => void;
  onAdd: (draft: OperationForm['sources'][number]) => void;
  onRemove: (index: number) => void;
  onRepick: (index: number) => void;
  partLabel: (source: CamOperation['geometry'][number]) => string;
}) {
  const [sketch, setSketch] = useState(sketches[0]?.id ?? '');
  const [hole, setHole] = useState(holes[0]?.id ?? '');
  const note =
    form.kind === 'facing'
      ? 'None: the whole stock top.'
      : form.kind === 'drill'
        ? 'None: every round hole of the part that can be drilled from above.'
        : form.kind === 'pocket'
          ? 'Floor faces, or sketch regions.'
          : 'Faces (their outlines) or sketch regions.';
  return (
    <fieldset
      className={`dialog-field ref-field${picking ? ' active' : ''}`}
      data-testid="cam-sources"
    >
      <legend>Geometry</legend>
      <p className="field-note">{note}</p>
      {takesFaces && (
        <button
          type="button"
          aria-pressed={picking}
          data-testid="cam-pick-faces"
          onClick={() => onPicking(!picking)}
        >
          {picking ? 'Picking: click planar faces in the view' : 'Pick faces'}
        </button>
      )}
      {form.sources.length > 0 && (
        <ul>
          {form.sources.map((s, i) => (
            <li
              key={`${s.label}/${i}`}
              className={s.lost ? 'lost' : undefined}
              data-testid={`cam-source-${i}`}
            >
              <span title={s.label}>{s.lost ? `${s.label} (not found)` : s.label}</span>
              {s.lost && s.kind === 'face' && (
                <button type="button" data-testid={`cam-repick-${i}`} onClick={() => onRepick(i)}>
                  Pick again
                </button>
              )}
              <button type="button" aria-label={`Remove ${s.label}`} onClick={() => onRemove(i)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {takesFaces && sketches.length > 0 && (
        <div className="cam-add-source">
          <select
            aria-label="Sketch"
            data-testid="cam-region-sketch"
            value={sketch}
            onChange={(e) => setSketch(e.target.value)}
          >
            {sketches.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid="cam-add-region"
            disabled={sketch === ''}
            onClick={() => {
              const source = { kind: 'region' as const, sketch };
              onAdd({ ...source, label: partLabel(source) });
            }}
          >
            Add its regions
          </button>
        </div>
      )}
      {form.kind === 'drill' && holes.length > 0 && (
        <div className="cam-add-source">
          <select
            aria-label="Hole feature"
            data-testid="cam-hole-feature"
            value={hole}
            onChange={(e) => setHole(e.target.value)}
          >
            {holes.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid="cam-add-hole"
            disabled={hole === ''}
            onClick={() => {
              const source = { kind: 'hole' as const, feature: hole };
              onAdd({ ...source, label: partLabel(source) });
            }}
          >
            Add its holes
          </button>
        </div>
      )}
      {error && (
        <span className="field-error" data-testid="cam-sources-error">
          {error}
        </span>
      )}
    </fieldset>
  );
}
