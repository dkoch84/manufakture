// The Mate dialog (M2 plan, T2.3e): the kind, two connectors picked on instances in the
// viewport (each a face, edge or vertex with the point inferred on it, which the user may
// change), a flip and quarter turns of the second connector, an offset along the first
// connector's axes, and limits for a revolute or a slider. Once both connectors are picked,
// every change is solved in the regen worker (`Assembler.solve` on the document with the mate
// in it) and the instances are shown where the solve puts them. OK adds the mate (or edits it)
// together with the poses the solve moved, as one undo step.

import {
  applyCommand,
  MATE_KINDS,
  type Assembly,
  type ManufaktureDocument,
} from '@manufakture/core';
import type { AssemblyResult } from '@manufakture/regen';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { ExpressionField } from '../components/ExpressionField';
import type { Referencer } from '../io/exchange';
import { evaluateVariables } from '../sketcher/values';
import type { DocumentStoreApi } from '../state/document';
import { isGeometryRef, itemKey, type SelectionStore } from '../state/selection';
import { fitsFirst } from '../variables/fits';
import type { BodyInput } from '../viewport/bodies';
import {
  INFERENCE_LABELS,
  MATE_KIND_HINTS,
  MATE_KIND_LABELS,
  assemblySummary,
  buildMate,
  choiceFromPick,
  choiceLabel,
  hasLimits,
  instanceOf,
  mateFormOf,
  movedPoses,
  newMateForm,
  withPoses,
  type Assembler,
  type ConnectorChoice,
  type MateForm,
  type MateKind,
} from './assembly';

export interface MateDialogProps {
  documents: DocumentStoreApi;
  assemblyId: string;
  /** The mate to edit; null for a new one. */
  mateId: string | null;
  selection: SelectionStore;
  /** The bodies the viewport shows for the assembly (instance view ids). */
  bodies: readonly BodyInput[];
  /** Solves previews; without one the mate is added unsolved and regen places it. */
  assembler?: Assembler | undefined;
  /** Stored references for picked edges and vertices. */
  referencer?: Referencer | undefined;
  /** Show where a preview solve puts the instances (null: where the last regen put them). */
  onPreview: (result: AssemblyResult | null) => void;
  /** The connectors picked so far (first, second), for the view to mark them. */
  onConnectors?: (chosen: readonly (ConnectorChoice | null)[]) => void;
  /** The dialog is done; `committed` is the document the mate made, if it made one. */
  onClose: (committed: ManufaktureDocument | null) => void;
}

type Slot = 'a' | 'b';

/** How long the form must stay still before a preview is solved. */
const PREVIEW_DELAY_MS = 120;

export function MateDialog({
  documents,
  assemblyId,
  mateId,
  selection,
  bodies,
  assembler,
  referencer,
  onPreview,
  onConnectors,
  onClose,
}: MateDialogProps) {
  const doc = useStore(documents, (s) => s.document);
  const assembly = doc.assemblies.find((a) => a.id === assemblyId);
  const existing = mateId === null ? undefined : assembly?.mates.find((m) => m.id === mateId);
  const [form, setFormState] = useState<MateForm>(() =>
    existing ? mateFormOf(existing, assemblyId, bodies) : newMateForm(),
  );
  // Read by picks, which resolve asynchronously.
  const formRef = useRef(form);
  const setForm = (update: (f: MateForm) => MateForm) => {
    formRef.current = update(formRef.current);
    setFormState(formRef.current);
  };
  const [slot, setSlot] = useState<Slot | null>(existing ? null : 'a');
  const slotRef = useRef(slot);
  useEffect(() => {
    slotRef.current = slot;
  }, [slot]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pickMessage, setPickMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ form: MateForm; result: AssemblyResult } | null>(null);
  const variables = useMemo(() => evaluateVariables(doc), [doc]);
  useEffect(() => {
    onConnectors?.([form.a, form.b]);
  }, [onConnectors, form.a, form.b]);
  useEffect(() => () => onConnectors?.([]), [onConnectors]);

  // Picks on instances go to the slot that is active when they arrive.
  const context = useRef({ bodies, referencer });
  useEffect(() => {
    context.current = { bodies, referencer };
  }, [bodies, referencer]);
  useEffect(() => {
    let previous = selection.getState().selected;
    return selection.subscribe((s) => {
      if (s.selected === previous) return;
      const before = new Set(previous.map(itemKey));
      previous = s.selected;
      const fresh = s.selected.filter((i) => isGeometryRef(i) && !before.has(itemKey(i)));
      const geo = fresh.at(-1);
      if (!geo || !isGeometryRef(geo)) return;
      const target = slotRef.current;
      if (target === null) {
        setPickMessage('Choose which connector to pick first.');
        return;
      }
      if (instanceOf(geo.bodyId, assemblyId) === null) {
        setPickMessage('Pick a face, edge or vertex of an instance.');
        return;
      }
      const { bodies: shown, referencer: refs } = context.current;
      void choiceFromPick(geo, {
        assemblyId,
        bodies: shown,
        edge: (viewId, index) =>
          refs
            ? refs.reference(viewId, 'edge', index)
            : Promise.resolve({ ok: false, message: 'Edges need the geometry kernel.' }),
        vertex: (viewId, index) =>
          refs?.vertex
            ? refs.vertex(viewId, index)
            : Promise.resolve({ ok: false, message: 'Vertices need the geometry kernel.' }),
      }).then((r) => {
        if (!r.ok) {
          setPickMessage(r.message);
          return;
        }
        setPickMessage(null);
        setErrors((e) => {
          const { [target]: _gone, form: _form, ...rest } = e;
          void _gone;
          void _form;
          return rest;
        });
        const next = { ...formRef.current, [target]: r.choice };
        formRef.current = next;
        setFormState(next);
        setSlot(target === 'a' && next.b === null ? 'b' : null);
        // The pick is the connector's now, not a selection.
        selection.getState().clear();
      });
    });
  }, [selection, assemblyId]);

  // Solve a preview once the form has both connectors and stays still for a moment.
  const built = useMemo(
    () =>
      assembly
        ? buildMate(form, {
            assembly,
            units: doc.units,
            variables,
            ...(existing ? { existing } : {}),
          })
        : null,
    [form, assembly, doc.units, variables, existing],
  );
  useEffect(() => {
    if (!assembler || !built?.ok) return;
    const draft = applyCommand(doc, built.command);
    if (!draft.ok) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void assembler.solve(draft.value.document, assemblyId).then(
        (result) => {
          if (cancelled || result === null) return;
          setPreview({ form, result });
          onPreview(result);
        },
        () => undefined,
      );
    }, PREVIEW_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [assembler, built, doc, assemblyId, form, onPreview]);

  const close = (committed: ManufaktureDocument | null) => {
    // A committed mate's preview stays shown until its regen places the instances there.
    if (committed === null) onPreview(null);
    onClose(committed);
  };

  const apply = () => {
    if (!assembly || !built) return;
    if (!built.ok) {
      setErrors(built.errors as Record<string, string>);
      return;
    }
    // The poses the preview of exactly this form moved go with the mate.
    const moved = preview?.form === form ? movedPoses(preview.result) : {};
    const done = documents
      .getState()
      .execute(withPoses(built.command, assemblyId, moved), built.label);
    if (!done.ok) {
      setErrors({ form: done.error.message });
      return;
    }
    close(documents.getState().document);
  };

  if (!assembly) return null;
  const set = <K extends keyof MateForm>(key: K, value: MateForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const setOffset = (key: keyof MateForm['offset'], value: string) =>
    setForm((f) => ({ ...f, offset: { ...f.offset, [key]: value } }));
  const setLimit = (key: keyof MateForm['limits'], value: string) =>
    setForm((f) => ({ ...f, limits: { ...f.limits, [key]: value } }));
  const previewed = preview?.form === form ? preview.result : null;
  const previewedId = built?.ok ? built.mate.id : null;
  const thisMate = previewed?.mates.find((m) => m.mateId === previewedId);
  const title = existing ? existing.name : 'New mate';
  const limitKind = form.kind === 'revolute' ? 'angle' : 'length';

  return (
    <aside
      className="selection-panel feature-dialog mate-dialog"
      role="dialog"
      aria-label={`Mate: ${title}`}
      data-testid="mate-dialog"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          close(null);
        } else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
          e.preventDefault();
          apply();
        }
      }}
    >
      <h2>Mate: {title}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <div className="dialog-field">
          <label>
            Kind
            <select
              value={form.kind}
              data-testid="mate-kind"
              onChange={(e) => set('kind', e.target.value as MateKind)}
            >
              {MATE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {MATE_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <span className="field-note">{MATE_KIND_HINTS[form.kind]}</span>
        </div>
        <div className="dialog-field">
          <label>
            Name
            <input
              value={form.name}
              placeholder={existing?.name ?? `${MATE_KIND_LABELS[form.kind]}`}
              data-testid="mate-name"
              onChange={(e) => set('name', e.target.value)}
            />
          </label>
        </div>
        {(['a', 'b'] as const).map((side) => (
          <ConnectorField
            key={side}
            side={side}
            choice={form[side]}
            assembly={assembly}
            active={slot === side}
            error={errors[side]}
            onActivate={() => setSlot(side)}
            onInference={(inference) =>
              setForm((f) => (f[side] ? { ...f, [side]: { ...f[side], inference } } : f))
            }
          />
        ))}
        <div className="dialog-field mate-adjust">
          <label className="dialog-check">
            <input
              type="checkbox"
              checked={form.flip}
              data-testid="mate-flip"
              onChange={(e) => set('flip', e.target.checked)}
            />
            Flip the second connector
          </label>
          <button
            type="button"
            data-testid="mate-rotate"
            onClick={() => set('rotate', ((form.rotate + 1) % 4) as MateForm['rotate'])}
            title="Turn the second connector a quarter turn about its z axis"
          >
            Rotate 90 degrees (turned: {form.rotate * 90} degrees)
          </button>
        </div>
        <fieldset className="dialog-field mate-offset">
          <legend>Offset, along the first connector's axes</legend>
          {(['x', 'y', 'z'] as const).map((axis) => (
            <ExpressionField
              key={axis}
              label={axis.toUpperCase()}
              value={form.offset[axis]}
              onChange={(v) => setOffset(axis, v)}
              kind="length"
              units={doc.units}
              variables={variables}
              names={fitsFirst(Object.keys(variables))}
              error={errors[`offset.${axis}`]}
              testId={`mate-offset-${axis}`}
            />
          ))}
          <ExpressionField
            label="Angle about z"
            value={form.offset.angle}
            onChange={(v) => setOffset('angle', v)}
            kind="angle"
            units={doc.units}
            variables={variables}
            error={errors['offset.angle']}
            testId="mate-offset-angle"
          />
        </fieldset>
        {hasLimits(form.kind) && (
          <fieldset className="dialog-field mate-limits">
            <legend>Limits (optional)</legend>
            <ExpressionField
              label="Minimum"
              value={form.limits.min}
              onChange={(v) => setLimit('min', v)}
              kind={limitKind}
              units={doc.units}
              variables={variables}
              error={errors['limits.min']}
              testId="mate-limit-min"
            />
            <ExpressionField
              label="Maximum"
              value={form.limits.max}
              onChange={(v) => setLimit('max', v)}
              kind={limitKind}
              units={doc.units}
              variables={variables}
              error={errors['limits.max']}
              testId="mate-limit-max"
            />
          </fieldset>
        )}
        <p className="mate-preview" role="status" data-testid="mate-preview">
          {previewed
            ? `${assemblySummary(previewed)}${
                thisMate && thisMate.status !== 'ok'
                  ? `. This mate: ${thisMate.errors[0]?.message ?? thisMate.message ?? thisMate.status}`
                  : ''
              }`
            : form.a && form.b
              ? assembler
                ? 'Solving...'
                : 'Placed when the mate is added.'
              : 'Pick two connectors in the view.'}
        </p>
        {pickMessage && (
          <p className="field-error" role="status" data-testid="mate-pick-message">
            {pickMessage}
          </p>
        )}
        {errors.form && (
          <p className="field-error" role="alert">
            {errors.form}
          </p>
        )}
        <div className="dialog-buttons">
          <button type="submit" className="primary" data-testid="mate-ok">
            OK
          </button>
          <button type="button" data-testid="mate-cancel" onClick={() => close(null)}>
            Cancel
          </button>
        </div>
      </form>
    </aside>
  );
}

function ConnectorField({
  side,
  choice,
  assembly,
  active,
  error,
  onActivate,
  onInference,
}: {
  side: Slot;
  choice: ConnectorChoice | null;
  assembly: Assembly;
  active: boolean;
  error: string | undefined;
  onActivate: () => void;
  onInference: (inference: ConnectorChoice['inference']) => void;
}) {
  const label = side === 'a' ? 'First connector' : 'Second connector';
  return (
    <fieldset
      className={`dialog-field ref-field${active ? ' active' : ''}`}
      data-testid={`mate-connector-${side}`}
    >
      <legend>{label}</legend>
      <button
        type="button"
        aria-pressed={active}
        data-testid={`mate-pick-${side}`}
        onClick={onActivate}
      >
        {active
          ? 'Picking: click a face, edge or vertex of an instance'
          : choice
            ? 'Pick again'
            : 'Pick a face, edge or vertex'}
      </button>
      {choice && (
        <p className="mate-connector-label" data-testid={`mate-connector-label-${side}`}>
          {choiceLabel(choice, assembly)}
        </p>
      )}
      {choice && choice.inferences.length > 1 && (
        <label>
          Point
          <select
            value={choice.inference}
            data-testid={`mate-inference-${side}`}
            onChange={(e) => onInference(e.target.value as ConnectorChoice['inference'])}
          >
            {choice.inferences.map((i) => (
              <option key={i} value={i}>
                {INFERENCE_LABELS[i]}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <span className="field-error">{error}</span>}
    </fieldset>
  );
}
