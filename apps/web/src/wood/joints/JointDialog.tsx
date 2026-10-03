// The Joint dialog (M4 plan T4.2c): two boards cut against each other. Pick the board that
// receives (A) and the board that enters it (B), the kind of joint and its fields; while the
// dialog is open the view shows the tools the joint would cut, solid on A and dashed on B, and the
// dialog lists what each board loses, the sizes, the hardware and any warning, all computed on the
// main thread by the domain's own translator. A joint the domain refuses says why, in the boards'
// names, and is not applied. OK applies the joint as one core command (one undo step); Cancel or
// Escape leaves the document alone. The logic is in joints.ts.

import { findPart, type DisplayUnits, type ExtensionFeature } from '@manufakture/core';
import {
  JOINT_KINDS,
  KIND_EXPRESSIONS,
  type JointKind,
  type JointMetadata,
} from '@manufakture/domain-wood';
import type { Vec3 } from '@manufakture/kernel';
import type { FeatureResult } from '@manufakture/regen';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ExpressionField } from '../../components/ExpressionField';
import { useModel, type ModelStore } from '../../model/model';
import type { DocumentStoreApi } from '../../state/document';
import type { SelectionStore } from '../../state/selection';
import { evaluateVariables } from '../../sketcher/values';
import { sizeText } from '../catalog';
import { Select } from '../Select';
import {
  boardRole,
  buildJoint,
  isJoint,
  JOINT_LABELS,
  jointBoards,
  jointExpressionKind,
  jointFormOf,
  jointPreviewLines,
  newJointForm,
  previewJoint,
  readable,
  swapBoards,
  toolsByBoard,
  toolSummary,
  type JointForm,
  type JointPreview,
} from './joints';
import '../wood.css';

export interface JointDialogProps {
  /** Edit this joint; absent for a new one. */
  featureId?: string | undefined;
  documents: DocumentStoreApi;
  model: ModelStore;
  selection: SelectionStore;
  /** The part studio the joint is in; default: the active one when the dialog opens. */
  partId?: string;
  /** Draws the joint's tools (polylines in world coordinates); [] clears it. */
  onPreview?: (lines: Vec3[][]) => void;
  onClose: () => void;
}

/** Kinds whose depth is the boards' overlap: B drawn reaching into A. */
const OVERLAP_KINDS: readonly JointKind[] = ['dado', 'rabbet', 'mortise-tenon', 'box-joint'];

/** Each field's label; `A` and `B` are replaced by the boards' names. */
function fieldLabel(kind: JointKind, name: string, a: string, b: string): string {
  const labels: Record<string, string> = {
    clearance:
      kind === 'rabbet'
        ? 'Clearance (optional: none; all of it on the inner side)'
        : 'Clearance (optional: none; the total play, split on both sides)',
    stop: `Stop (how far short of the end of ${a} the dado stops)`,
    thickness: `Tenon thickness (optional: a third of ${b})`,
    width: `Tenon width (optional: ${b}'s width less two thirds of its thickness)`,
    offset:
      kind === 'dowel'
        ? 'Offset across the row (optional: 0, centred)'
        : `Tenon offset across ${b}'s thickness (optional: 0, centred)`,
    diameter: 'Dowel diameter (optional: 8 mm)',
    depthA: `Hole depth into ${a} (optional: 1.5 diameters)`,
    depthB: `Hole depth into ${b} (optional: 2.5 diameters)`,
    count:
      kind === 'box-joint'
        ? 'Number of fingers (optional: from the finger width)'
        : 'How many (optional: or a spacing)',
    spacing: 'Spacing (optional: evenly spread)',
    edge:
      kind === 'dowel'
        ? 'Distance from the ends (optional: 2 diameters)'
        : 'Distance from the ends (optional: 3/4")',
    angle: 'Pocket angle (optional: 15 degrees, the standard jig)',
    screw: `Screw length (optional: the jig chart's for ${b}'s thickness)`,
    finger: "Finger width (optional: the thinner board's thickness, rounded to fit)",
  };
  return labels[name] ?? name;
}

/** The joint's sizes as built, in the document's units. */
function sizesText(meta: JointMetadata, units: DisplayUnits, a: string, b: string): string {
  const d = meta.details;
  const len = (n: string) => sizeText(d[n] ?? 0, units);
  switch (meta.kind) {
    case 'dado':
    case 'rabbet':
      return `Groove ${len('width')} wide and ${len('depth')} deep, ${len('length')} long.`;
    case 'mortise-tenon':
      return `Tenon ${len('thickness')} thick, ${len('width')} wide and ${len('length')} long; mortise ${len('mortiseDepth')} deep.`;
    case 'dowel':
      return `${d.count} holes of ${len('diameter')}: ${len('depthA')} into ${a}, ${len('depthB')} into ${b}.`;
    case 'pocket-screw':
      return `${d.count} pockets at ${Math.round((((d.angle ?? 0) * 180) / Math.PI) * 10) / 10} degrees, for ${len('screw')} screws.`;
    case 'box-joint':
      return `${d.fingers} fingers of ${len('finger')}.`;
  }
}

function hardwareText(meta: JointMetadata, units: DisplayUnits): string[] {
  return meta.hardware.map((h) =>
    h.item === 'dowel'
      ? `${h.quantity} dowel${h.quantity === 1 ? '' : 's'}, ${sizeText(h.diameter, units)} x ${sizeText(h.length, units)}`
      : `${h.quantity} pocket screw${h.quantity === 1 ? '' : 's'}, ${sizeText(h.length, units)} long`,
  );
}

const EMPTY_RESULTS: ReadonlyMap<string, FeatureResult> = new Map();

export function JointDialog({
  featureId,
  documents,
  model,
  selection,
  partId: givenPartId,
  onPreview,
  onClose,
}: JointDialogProps) {
  const [partId] = useState(() => givenPartId ?? documents.getState().activePartId);
  const doc = documents.getState().document;
  const part = findPart(doc, partId)!;
  const found = featureId ? part.features.find((f) => f.id === featureId) : undefined;
  const existing: ExtensionFeature | undefined = found && isJoint(found) ? found : undefined;
  const units = doc.units;
  const variables = evaluateVariables(doc);
  const names = doc.variables.map((v) => v.name);

  const opened = existing ? jointFormOf(existing) : null;
  const [form, setForm] = useState<JointForm>(() => {
    if (opened?.ok) return opened.form;
    return newJointForm(doc, partId, selection.getState().selected);
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const unreadable = opened !== null && !opened.ok ? opened.message : null;

  const index = existing
    ? part.features.indexOf(existing)
    : (part.rollbackIndex ?? part.features.length);
  const boards = jointBoards(part, index);
  const title = existing?.name ?? 'New joint';
  const roleA = form.a ? boardRole(form.a, form, part.features) : 'A';
  const roleB = form.b ? boardRole(form.b, form, part.features) : 'B';
  const nameA = boards.find((x) => x.id === form.a)?.name ?? 'A';
  const nameB = boards.find((x) => x.id === form.b)?.name ?? 'B';

  // The preview, from the board frames regen last reported.
  const modelPart = useModel(model, (s) => s.parts.find((p) => p.partId === partId));
  const results = useMemo(
    () => (modelPart ? new Map(modelPart.features.map((f) => [f.featureId, f])) : EMPTY_RESULTS),
    [modelPart],
  );
  const preview: JointPreview | null = unreadable
    ? null
    : previewJoint(form, { doc, partId, results, existing });
  const lines = preview?.state === 'ok' ? jointPreviewLines(preview.items, form) : ([] as Vec3[][]);
  // Drawn again only when what it shows changes, not on every render.
  const previewKey = JSON.stringify(lines);
  useEffect(() => {
    if (!onPreview) return;
    onPreview(JSON.parse(previewKey) as Vec3[][]);
  }, [onPreview, previewKey]);
  useEffect(() => () => onPreview?.([]), [onPreview]);

  // Focus moves in on open and goes back on close, unless the user put it somewhere else.
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

  const set = (patch: Partial<JointForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(patch)) delete next[k];
      delete next.form;
      return next;
    });
  };
  const setValue = (name: string, value: string) => {
    setForm((f) => ({ ...f, values: { ...f.values, [name]: value } }));
    setErrors((e) => {
      const next = { ...e };
      delete next[name];
      delete next.form;
      return next;
    });
  };

  const apply = () => {
    if (unreadable) return;
    const current = documents.getState().document;
    const r = buildJoint(
      form,
      existing ? { doc: current, partId, existing } : { doc: current, partId },
    );
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    if (preview?.state === 'refused') {
      setErrors({ form: `This joint cannot be built: ${preview.message}` });
      return;
    }
    const done = documents.getState().execute(r.command, r.label);
    if (!done.ok) {
      setErrors({ form: done.error.message });
      return;
    }
    onClose();
  };

  // A refusal on a field marks that field and points at the explanation under the form.
  const refusedField = preview?.state === 'refused' ? preview.field : null;
  const fieldError = (name: string) =>
    errors[name] ??
    (refusedField === name ? 'The joint is refused here: see why below.' : undefined);

  const boardOptions = (value: string): [string, string][] => [
    ...(boards.some((x) => x.id === value)
      ? []
      : ([[value, value || 'Choose a board']] as [string, string][])),
    ...boards.map((x) => [x.id, x.name] as [string, string]),
  ];

  const body: ReactNode[] = [];
  if (unreadable) {
    body.push(
      <p key="unreadable" className="field-error" role="alert">
        This joint cannot be edited here: {unreadable}
      </p>,
    );
  } else {
    body.push(
      <Select
        key="kind"
        label="Joint"
        name="kind"
        value={form.kind}
        error={fieldError('kind')}
        options={JOINT_KINDS.map((k) => [k, JOINT_LABELS[k]] as const)}
        onChange={(v) => set({ kind: v as JointKind })}
      />,
      <Select
        key="a"
        label="Receives (A): the board that is cut where the other enters"
        name="a"
        value={form.a}
        error={fieldError('a')}
        options={boardOptions(form.a)}
        onChange={(v) => set({ a: v })}
      />,
      <Select
        key="b"
        label="Enters (B): the board that goes into A"
        name="b"
        value={form.b}
        error={fieldError('b')}
        options={boardOptions(form.b)}
        onChange={(v) => set({ b: v })}
      />,
      <div key="swap" className="joint-swap">
        <button type="button" data-testid="joint-swap" onClick={() => setForm(swapBoards)}>
          Swap A and B
        </button>
      </div>,
    );
    if (form.kind === 'dado') {
      body.push(
        <Select
          key="stopped"
          label="Dado"
          name="stopped"
          value={form.stopped}
          error={fieldError('stopped')}
          options={[
            ['none', `Through: across the whole of ${nameA}`],
            ['low', 'Stopped short of one end'],
            ['high', 'Stopped short of the other end'],
            ['both', 'Stopped short of both ends'],
          ]}
          onChange={(v) => set({ stopped: v as JointForm['stopped'] })}
        />,
      );
    }
    if (form.kind === 'mortise-tenon') {
      body.push(
        <Select
          key="ends"
          label="Mortise ends"
          name="ends"
          value={form.ends}
          error={fieldError('ends')}
          options={[
            ['square', 'Square (chiselled)'],
            ['rounded', 'Rounded (routed), the tenon rounded to match'],
          ]}
          onChange={(v) => set({ ends: v as JointForm['ends'] })}
        />,
      );
    }
    if (form.kind === 'pocket-screw') {
      body.push(
        <Select
          key="face"
          label={`Pockets on the face of ${nameB}`}
          name="face"
          value={form.face}
          error={fieldError('face')}
          options={[
            ['low', 'One face (shown in the view)'],
            ['high', 'The other face'],
          ]}
          onChange={(v) => set({ face: v as JointForm['face'] })}
        />,
      );
    }
    if (form.kind === 'box-joint') {
      body.push(
        <Select
          key="start"
          label="First finger on"
          name="start"
          value={form.start}
          error={fieldError('start')}
          options={[
            ['a', nameA],
            ['b', nameB],
          ]}
          onChange={(v) => set({ start: v as JointForm['start'] })}
        />,
      );
    }
    for (const name of KIND_EXPRESSIONS[form.kind]) {
      if (name === 'stop' && form.stopped === 'none') continue;
      const kind = jointExpressionKind(name);
      body.push(
        <ExpressionField
          key={`${form.kind}/${name}`}
          label={fieldLabel(form.kind, name, nameA, nameB)}
          testId={`field-${name}`}
          value={form.values[name] ?? ''}
          kind={kind}
          units={units}
          variables={variables}
          names={names}
          error={fieldError(name)}
          onChange={(v) => setValue(name, v)}
        />,
      );
    }
    body.push(
      <p key="depth" className="field-note" data-testid="joint-depth-note">
        {OVERLAP_KINDS.includes(form.kind)
          ? `The depth is how far ${nameB} reaches into ${nameA} in the model: draw ${nameB} overlapping ${nameA} by the depth you want. To change it, move or resize ${nameB}; it is not a field here.`
          : `${nameB} must touch ${nameA} without overlapping it.`}
      </p>,
    );
    body.push(
      <JointPreviewPanel
        key="preview"
        preview={preview}
        form={form}
        units={units}
        roleA={roleA}
        roleB={roleB}
      />,
    );
    // The last rebuild's own errors (a tool that missed its board), when the form is unchanged.
    const result = existing ? results.get(existing.id) : undefined;
    if (
      result &&
      result.errors.length > 0 &&
      preview?.state !== 'refused' &&
      opened?.ok &&
      JSON.stringify(opened.form) === JSON.stringify(form)
    ) {
      body.push(
        <ul key="regen" className="joint-messages field-error" data-testid="joint-regen-errors">
          {result.errors.map((e, i) => (
            <li key={i}>Last rebuild: {readable(e.message, form, part.features)}</li>
          ))}
        </ul>,
      );
    }
  }

  return (
    <aside
      ref={dialogRef}
      tabIndex={-1}
      className="selection-panel feature-dialog joint-dialog"
      role="dialog"
      aria-label={`Joint: ${title}`}
      data-testid="feature-dialog"
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
      <h2>Joint: {title}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        {body}
        {errors.form && (
          <p className="field-error" role="alert">
            {errors.form}
          </p>
        )}
        <div className="dialog-buttons">
          {!unreadable && (
            <button type="submit" className="primary" data-testid="dialog-ok">
              OK
            </button>
          )}
          <button type="button" onClick={onClose}>
            {unreadable ? 'Close' : 'Cancel'}
          </button>
        </div>
      </form>
    </aside>
  );
}

/** What the joint would do: which board loses what, its sizes, hardware, warnings or refusal. */
function JointPreviewPanel({
  preview,
  form,
  units,
  roleA,
  roleB,
}: {
  preview: JointPreview | null;
  form: JointForm;
  units: DisplayUnits;
  roleA: string;
  roleB: string;
}) {
  if (preview === null) return null;
  if (preview.state === 'waiting') {
    return (
      <p className="field-note" data-testid="joint-preview">
        {preview.message}
      </p>
    );
  }
  if (preview.state === 'refused') {
    return (
      <div className="joint-refusal" data-testid="joint-refusal">
        <strong>This joint cannot be built.</strong> {preview.message}
      </div>
    );
  }
  const tools = toolsByBoard(preview.items, form);
  const meta = preview.metadata;
  const hardware = hardwareText(meta, units);
  const nameA = roleA.replace(/ \(A\)$/, '');
  const nameB = roleB.replace(/ \(B\)$/, '');
  return (
    <div className="joint-preview" data-testid="joint-preview">
      <p className="field-note">
        In the view: solid outlines are cut from {roleA}, dashed ones from {roleB}.
      </p>
      <ul className="joint-cuts">
        <li data-testid="joint-cuts-a">
          <span className="joint-line solid" aria-hidden="true" />
          Cut from {roleA}: {tools.a.cut.length > 0 ? toolSummary(tools.a.cut) : 'nothing'}.
        </li>
        <li data-testid="joint-cuts-b">
          <span className="joint-line dashed" aria-hidden="true" />
          Cut from {roleB}: {tools.b.cut.length > 0 ? toolSummary(tools.b.cut) : 'nothing'}.
          {tools.b.added.length > 0 && ` Added to it: ${toolSummary(tools.b.added)}.`}
        </li>
      </ul>
      <p className="field-note" data-testid="joint-sizes">
        {sizesText(meta, units, nameA, nameB)}
      </p>
      {hardware.length > 0 && (
        <p className="field-note" data-testid="joint-hardware">
          Hardware: {hardware.join('; ')}.
        </p>
      )}
      {meta.warnings.length > 0 && (
        <ul className="joint-messages joint-warnings" data-testid="joint-warnings">
          {meta.warnings.map((w, i) => (
            <li key={i} data-code={w.code}>
              {w.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
