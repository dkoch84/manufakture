// The feature dialogs: extrude, revolve, fillet, chamfer, shell, hole, pattern, mirror and thread
// (and the derived part, which has a dialog of its own: DerivedDialog.tsx). One
// panel edits one feature, new or existing; faces and edges are picked in the viewport into the
// active reference field; OK applies the whole dialog as one core command (one undo step), and
// Cancel or Escape leaves the document alone. The dialog takes focus when it opens (so Escape
// works at once) and gives it back to where it was when it closes. The form logic is in forms.ts.

import { defaultFeatureName, findPart, previewIds } from '@manufakture/core';
import { holeSize, threadSize } from '@manufakture/kernel';
import { FIT_DESCRIPTIONS, FIT_KINDS, FIT_VARIABLES, heatSetInsert } from '@manufakture/print';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { partBodies } from '../model/bodies';
import { featureResult, modelBodies, type ModelStore } from '../model/model';
import type { DocumentStoreApi } from '../state/document';
import {
  isGeometryRef,
  itemKey,
  type GeometryRef,
  type SelectableItem,
  type SelectionStore,
} from '../state/selection';
import { ExpressionField } from '../components/ExpressionField';
import { evaluateVariables } from '../sketcher/values';
import { KIND_LABELS } from '../tree/tree';
import { fitsFirst } from '../variables/fits';
import {
  addRef,
  applyStandard,
  availableSketches,
  buildFeature,
  checkExpression,
  chooseHoleStandard,
  formOf,
  lostReferences,
  newForm,
  refFields,
  refsOf,
  removeRef,
  repeatableFeatures,
  scopeBodies,
  scopeOf,
  takesScope,
  withScope,
  type DialogKind,
  type FeatureForm,
  type FormKind,
  type HoleForm,
  type HoleFormFit,
  type HoleFormTip,
  HOLE_FORM_SIZES,
  type Operation,
  type RefField,
  type RefKind,
  type ThreadForm,
} from './forms';
import type { CreateVersion } from '../history/history';
import type { PinLibrary } from './derived';
import { DerivedDialog } from './DerivedDialog';
import { Check, RefFieldView, Select } from './fields';
import { ProfileRegions } from './ProfileRegions';
import type { PickOutcome } from './references';
import { ScopePicker } from './ScopePicker';
import { ScriptedDialog, type ScriptedServices } from './ScriptedDialog';
import {
  bestSize,
  cylinderLabel,
  pickedCylinder,
  sizeFits,
  sizeLabel,
  threadSizesFor,
  type PickedCylinder,
} from './threads';

export interface DialogRequest {
  kind: DialogKind;
  /** Edit this feature; absent for a new one. */
  featureId?: string;
  /** A reference to pick again (from the feature tree's re-pick action). */
  repick?: string;
}

export interface FeatureDialogProps {
  request: DialogRequest;
  documents: DocumentStoreApi;
  model: ModelStore;
  selection: SelectionStore;
  /** Turns a viewport pick into a reference for a field that accepts `accepts`. */
  resolve: (geo: GeometryRef, accepts: readonly RefKind[]) => Promise<PickOutcome>;
  /** The part studio the feature is in; default: the active one when the dialog opens. */
  partId?: string;
  onClose: () => void;
  /** Where a derived part's source is chosen from; without it, derived parts cannot be made. */
  library?: PinLibrary | null;
  /** Name the open document's current state (a derived part pinning a version of it). */
  createVersion?: CreateVersion | null;
  /** Reading scripts' parameters and whether they may run; without it, scripted features cannot be edited. */
  scripts?: ScriptedServices | null;
}

const OPERATIONS: readonly [Operation, string][] = [
  ['new', 'New body'],
  ['add', 'Add'],
  ['cut', 'Remove'],
  ['intersect', 'Intersect'],
];

export function FeatureDialog(props: FeatureDialogProps) {
  const { request, library = null, createVersion = null, scripts = null, ...rest } = props;
  if (request.kind === 'scripted') {
    return (
      <ScriptedDialog
        {...rest}
        request={{
          kind: 'scripted',
          ...(request.featureId !== undefined ? { featureId: request.featureId } : {}),
          ...(request.repick !== undefined ? { repick: request.repick } : {}),
        }}
        scripts={scripts}
      />
    );
  }
  if (request.kind === 'derived') {
    return (
      <DerivedDialog
        {...rest}
        request={{
          kind: 'derived',
          ...(request.featureId !== undefined ? { featureId: request.featureId } : {}),
        }}
        library={library}
        createVersion={createVersion}
      />
    );
  }
  return <PartFeatureDialog {...rest} request={{ ...request, kind: request.kind }} />;
}

type PartFeatureDialogProps = Omit<
  FeatureDialogProps,
  'request' | 'library' | 'createVersion' | 'scripts'
> & {
  request: DialogRequest & { kind: FormKind };
};

function PartFeatureDialog({
  request,
  documents,
  model,
  selection,
  resolve,
  partId: givenPartId,
  onClose,
}: PartFeatureDialogProps) {
  // The part is fixed for the dialog's life: the tabs are disabled while it is open.
  const [partId] = useState(() => givenPartId ?? documents.getState().activePartId);
  const doc = documents.getState().document;
  const part = findPart(doc, partId)!;
  const existing = request.featureId
    ? part.features.find((f) => f.id === request.featureId)
    : undefined;
  const units = doc.units;
  const variables = useMemo(() => evaluateVariables(doc), [doc]);
  const variableNames = useMemo(() => doc.variables.map((v) => v.name), [doc]);
  // Fields that take a clearance offer the fit variables first (ADR 0012 decision 10).
  const fitNames = useMemo(() => fitsFirst(variableNames), [variableNames]);

  const [form, setForm] = useState<FeatureForm>(() => {
    if (existing) {
      const result = featureResult(model.getState(), partId, existing.id);
      const lost = lostReferences(result?.errors ?? []);
      if (request.repick) lost.add(request.repick);
      return formOf(existing, lost, units) ?? newForm(request.kind, { doc, partId });
    }
    const selectedFeatures = selection
      .getState()
      .selected.filter((i) => i.kind === 'feature')
      .map((i) => i.id);
    return newForm(request.kind, { doc, partId, selectedFeatures });
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pickMessage, setPickMessage] = useState<string | null>(null);
  const fields = refFields(form);
  const [activeKey, setActiveKey] = useState<string | null>(() => {
    const all = refFields(form);
    const lost = all.find((f) => refsOf(form, f.key).some((r) => r.lost));
    return (lost ?? all[0])?.key ?? null;
  });
  const active = fields.find((f) => f.key === activeKey) ?? fields[0] ?? null;
  // Picks resolve asynchronously; they go to the field that is active when they arrive.
  const activeRef = useRef<RefField | null>(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const index = existing
    ? part.features.indexOf(existing)
    : (part.rollbackIndex ?? part.features.length);
  const id = existing?.id ?? previewIds(part.nextIds, request.kind)[0]!;
  const title = existing?.name ?? defaultFeatureName(request.kind, id);

  const pick = useCallback(
    (geo: GeometryRef) => {
      const field = activeRef.current;
      if (!field) {
        setPickMessage('Nothing in this dialog is picked in the viewport.');
        return;
      }
      void resolve(geo, field.accepts).then((r) => {
        if (!r.ok) {
          setPickMessage(r.message);
          return;
        }
        setPickMessage(null);
        setForm((f) => addRef(f, field, r.item));
        setErrors((e) => {
          const { [field.key]: _gone, form: _form, ...rest } = e;
          void _gone;
          void _form;
          return rest;
        });
      });
    },
    [resolve],
  );

  // Faces and edges picked in the viewport while the dialog is open go to the active field; so
  // do the ones already selected when a new feature's dialog opens (pick first, then the tool).
  useEffect(() => {
    let previous: readonly SelectableItem[] = selection.getState().selected;
    if (!existing) for (const item of previous) if (isGeometryRef(item)) pick(item);
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

  // Focus moves in on open and goes back on close, unless the user has put it somewhere else
  // meanwhile (the viewport, to pick).
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

  // A thread: the picked cylinder as the last regen made it, and the clearance as typed (mm), so
  // the size list offers only sizes that can be cut into it.
  const threadFace = form.kind === 'thread' ? form.face[0]?.ref : undefined;
  // Editing a thread, its own face may be gone from the model (a cosmetic thread renames it): the
  // cylinder its last regen reported stands in for it.
  const cylinder = useMemo<PickedCylinder | null>(() => {
    if (threadFace === undefined || !('face' in threadFace)) return null;
    const picked = pickedCylinder(modelBodies(model.getState()), threadFace.face);
    if (picked !== null || !existing) return picked;
    const built = featureResult(model.getState(), partId, existing.id)?.thread;
    return built ? { side: built.side, radius: built.radius } : null;
  }, [threadFace, model, existing, partId]);
  const threadClearance = form.kind === 'thread' ? form.clearance : '';
  const clearanceMm = useMemo(() => {
    const r = checkExpression(threadClearance, 'length', units, variables, { nonNegative: true });
    return r.ok ? r.value : 0;
  }, [threadClearance, units, variables]);
  // A newly picked cylinder that the chosen size does not fit gets the size it was most likely
  // made for. Not the face an edited thread opened with: its stored size stays, shown as not
  // fitting, until the user picks a size or another face.
  const sizedFace = useRef<string | undefined>(
    existing && threadFace !== undefined && 'face' in threadFace ? threadFace.face : undefined,
  );
  useEffect(() => {
    if (cylinder === null) return;
    const face = threadFace !== undefined && 'face' in threadFace ? threadFace.face : undefined;
    if (face === sizedFace.current) return;
    sizedFace.current = face;
    setForm((f) => {
      if (f.kind !== 'thread') return f;
      const chosen = f.size === '' ? undefined : threadSize(f.system, f.size);
      if (chosen && sizeFits(chosen, cylinder, clearanceMm)) return f;
      const best = bestSize(f.system, cylinder, clearanceMm);
      return best ? { ...f, size: best.size } : f;
    });
    // Only when the cylinder changes: a size the user then picks stays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cylinder]);

  const apply = () => {
    const current = documents.getState().document;
    const r = buildFeature(
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

  const set = <K extends string>(key: K, value: unknown) =>
    setForm((f) => ({ ...f, [key]: value }) as FeatureForm);

  // The bodies a scope can name, as the last regen made them.
  const modelParts = model.getState().parts;
  const candidates = useMemo(
    () =>
      scopeBodies(
        part,
        index,
        partBodies(
          part,
          modelParts.find((p) => p.partId === partId),
        ),
        scopeOf(form) ?? [],
      ),
    [part, index, modelParts, partId, form],
  );

  const sketches = availableSketches(part, index);
  const repeatable = repeatableFeatures(part, index);
  const expression = (
    key: string,
    label: string,
    kind: 'length' | 'angle' | 'number',
    value: string,
    suggestFits = false,
  ) => (
    <ExpressionField
      key={key}
      label={label}
      testId={`field-${key}`}
      value={value}
      kind={kind}
      units={units}
      variables={variables}
      names={suggestFits ? fitNames : variableNames}
      error={errors[key]}
      onChange={(v) => set(key, v)}
    />
  );
  const refField = (key: string) => {
    const field = fields.find((f) => f.key === key);
    return field ? (
      <RefFieldView
        key={key}
        field={field}
        refs={refsOf(form, key)}
        active={active?.key === key}
        error={errors[key]}
        onActivate={() => setActiveKey(key)}
        onRemove={(i) => setForm((f) => removeRef(f, key, i))}
      />
    ) : null;
  };

  const body: ReactNode[] = [];
  switch (form.kind) {
    case 'extrude':
    case 'revolve':
      body.push(
        <SketchSelect
          key="sketch"
          value={form.sketch}
          sketches={sketches}
          error={errors.sketch}
          onChange={(v) => {
            // Another sketch: its regions, all of them, not the old sketch's entities.
            const { entities: _old, ...rest } = form;
            void _old;
            if (rest.kind === 'revolve') {
              const line = sketches
                .find((s) => s.id === v)
                ?.entities.find((e) => e.kind === 'line');
              setForm({ ...rest, sketch: v, axisLine: line?.id ?? '' });
            } else setForm({ ...rest, sketch: v });
          }}
        />,
        <ProfileRegions
          key="regions"
          sketch={sketches.find((s) => s.id === form.sketch)}
          entities={form.entities}
          onChange={(entities) =>
            setForm((f) => {
              if (f.kind !== 'extrude' && f.kind !== 'revolve') return f;
              const { entities: _old, ...rest } = f;
              void _old;
              return entities ? { ...rest, entities } : rest;
            })
          }
        />,
        <Select
          key="operation"
          label="Result"
          name="operation"
          value={form.operation}
          options={OPERATIONS}
          onChange={(v) => set('operation', v)}
        />,
      );
      if (form.kind === 'extrude') {
        body.push(
          <Select
            key="extent"
            label="End"
            name="extent"
            value={form.extent}
            options={[
              ['blind', 'Blind'],
              ['symmetric', 'Symmetric'],
              ['throughAll', 'Through all'],
              ['upToFace', 'Up to face'],
            ]}
            onChange={(v) => set('extent', v)}
          />,
        );
        if (form.extent === 'blind' || form.extent === 'symmetric') {
          body.push(expression('distance', 'Depth', 'length', form.distance));
        }
        body.push(
          refField('upToFace'),
          <Check
            key="reverse"
            label="Opposite direction"
            checked={form.reverse}
            onChange={(v) => set('reverse', v)}
          />,
          expression('draft', 'Draft angle (optional)', 'angle', form.draft),
        );
      } else {
        const lines =
          sketches
            .find((s) => s.id === form.sketch)
            ?.entities.filter((e) => e.kind === 'line')
            .map((e): [string, string] => [
              e.id,
              `Line ${e.id}${e.construction ? ' (construction)' : ''}`,
            ]) ?? [];
        body.push(
          <Select
            key="axisType"
            label="Axis"
            name="axisType"
            value={form.axisType}
            options={[
              ['sketchLine', 'A line of the sketch'],
              ['edge', 'An edge of the part'],
            ]}
            onChange={(v) => set('axisType', v)}
          />,
        );
        if (form.axisType === 'sketchLine') {
          body.push(
            <Select
              key="axisLine"
              label="Axis line"
              name="axisLine"
              value={form.axisLine}
              options={lines}
              error={errors.axisLine}
              onChange={(v) => set('axisLine', v)}
            />,
          );
        }
        body.push(
          refField('axisEdge'),
          <Check
            key="flip"
            label="Flip the axis"
            checked={form.flip}
            onChange={(v) => set('flip', v)}
          />,
          expression('angle', 'Angle', 'angle', form.angle),
          <Check
            key="symmetric"
            label="Symmetric about the sketch"
            checked={form.symmetric}
            onChange={(v) => set('symmetric', v)}
          />,
        );
      }
      break;
    case 'fillet':
      body.push(refField('edges'), expression('radius', 'Radius', 'length', form.radius));
      break;
    case 'chamfer':
      body.push(
        refField('edges'),
        <Select
          key="mode"
          label="Type"
          name="mode"
          value={form.mode}
          options={[
            ['equal', 'Equal distance'],
            ['two', 'Two distances'],
            ['angle', 'Distance and angle'],
          ]}
          onChange={(v) => set('mode', v)}
        />,
        expression('distance', 'Distance', 'length', form.distance),
      );
      if (form.mode === 'two') {
        body.push(expression('secondDistance', 'Second distance', 'length', form.secondDistance));
      }
      if (form.mode === 'angle') body.push(expression('angle', 'Angle', 'angle', form.angle));
      break;
    case 'shell':
      body.push(
        refField('faces'),
        expression('thickness', 'Thickness', 'length', form.thickness),
        <Check
          key="outward"
          label="Grow the wall outward"
          checked={form.outward}
          onChange={(v) => set('outward', v)}
        />,
      );
      break;
    case 'hole': {
      const sketch = sketches.find((s) => s.id === form.sketch);
      const points = sketch?.entities.filter((e) => e.kind === 'point') ?? [];
      const hole = (patch: Partial<HoleForm>) =>
        setForm((f) => applyStandard({ ...(f as HoleForm), ...patch }, units));
      const standard = (patch: Pick<Partial<HoleForm>, 'standard' | 'fit'>) =>
        setForm((f) => chooseHoleStandard(f as HoleForm, patch, units));
      const insert = form.standard === '' ? undefined : heatSetInsert(form.standard);
      const clearance = form.standard !== '' && holeSize(form.standard) !== undefined;
      body.push(
        <SketchSelect
          key="sketch"
          value={form.sketch}
          sketches={sketches}
          error={errors.sketch}
          onChange={(v) =>
            setForm({
              ...form,
              sketch: v,
              points:
                sketches
                  .find((s) => s.id === v)
                  ?.entities.filter((e) => e.kind === 'point')
                  .map((e) => e.id) ?? [],
            })
          }
        />,
        <fieldset key="points" className="dialog-field checks" data-testid="field-points">
          <legend>Hole centres</legend>
          {points.length === 0 && <p className="field-note">The sketch has no points.</p>}
          {points.map((p) => (
            <Check
              key={p.id}
              label={`Point ${p.id}`}
              checked={form.points.includes(p.id)}
              onChange={(on) =>
                set('points', on ? [...form.points, p.id] : form.points.filter((x) => x !== p.id))
              }
            />
          ))}
          {errors.points && <span className="field-error">{errors.points}</span>}
        </fieldset>,
        <Select
          key="standard"
          label="Size"
          name="standard"
          value={form.standard}
          options={[
            ['', 'Custom'],
            ...HOLE_FORM_SIZES.map((size): [string, string] => [
              size,
              size.startsWith('M') || size.startsWith('#') ? size : `${size}"`,
            ]),
          ]}
          onChange={(v) => standard({ standard: v })}
        />,
      );
      if (form.standard !== '') {
        const printed = FIT_KINDS.find((k) => k === form.fit);
        const missing = printed && !variableNames.includes(FIT_VARIABLES[printed]);
        body.push(
          <Select
            key="fit"
            label="Fit"
            name="fit"
            value={form.fit}
            options={[
              ...(clearance
                ? ([
                    ['close', 'Close'],
                    ['normal', 'Normal'],
                    ['loose', 'Loose'],
                    ...FIT_KINDS.map((k): [string, string] => [
                      k,
                      `Printed fit: ${k} (#${FIT_VARIABLES[k]})`,
                    ]),
                  ] as [string, string][])
                : []),
              ...(insert ? ([['insert', 'Heat-set insert']] as [string, string][]) : []),
            ]}
            onChange={(v) => standard({ fit: v as HoleFormFit })}
          />,
        );
        if (form.fit === 'insert' && insert) {
          body.push(
            <p key="fit-note" className="field-note" data-testid="field-fit-note">
              {`${insert.size} heat-set insert: a ${insert.hole} mm hole at least ${insert.length} mm deep, with ${insert.minWall} mm of wall around it (CNC Kitchen standard; other brands differ).`}
            </p>,
          );
        }
        if (printed) {
          body.push(
            <p key="fit-note" className="field-note" data-testid="field-fit-note">
              {missing
                ? `#${FIT_VARIABLES[printed]} is not in the variables table yet: use Insert fit variables in the Variables panel.`
                : `The nominal size plus #${FIT_VARIABLES[printed]} (${printed}: ${FIT_DESCRIPTIONS[printed]}).`}
            </p>,
          );
        }
      }
      body.push(
        expression('diameter', 'Diameter', 'length', form.diameter, true),
        <Select
          key="extent"
          label="End"
          name="extent"
          value={form.extent}
          options={[
            ['throughAll', 'Through all'],
            ['blind', 'Blind'],
          ]}
          onChange={(v) => set('extent', v)}
        />,
      );
      if (form.extent === 'blind') {
        body.push(
          expression('depth', 'Depth', 'length', form.depth),
          <Select
            key="tip"
            label="Bottom"
            name="tip"
            value={form.tip}
            options={[
              ['drill', 'Drill point (118°)'],
              ['flat', 'Flat'],
              ['angle', 'Tip angle'],
            ]}
            onChange={(v) => set('tip', v as HoleFormTip)}
          />,
        );
        if (form.tip === 'angle') {
          body.push(expression('tipAngle', 'Tip angle', 'angle', form.tipAngle));
        }
      }
      body.push(
        <Select
          key="head"
          label="Head"
          name="head"
          value={form.head}
          options={[
            ['simple', 'Simple'],
            ['counterbore', 'Counterbore'],
            ['countersink', 'Countersink'],
          ]}
          onChange={(v) => hole({ head: v as HoleForm['head'] })}
        />,
      );
      if (form.head !== 'simple') {
        body.push(expression('headDiameter', 'Head diameter', 'length', form.headDiameter, true));
      }
      if (form.head === 'counterbore') {
        body.push(expression('headDepth', 'Head depth', 'length', form.headDepth));
      }
      if (form.head === 'countersink') {
        body.push(expression('headAngle', 'Countersink angle', 'angle', form.headAngle));
      }
      break;
    }
    case 'pattern':
    case 'mirror':
      body.push(
        <Select
          key="source"
          label="Repeat"
          name="source"
          value={form.source}
          options={[
            ['features', 'Features'],
            ['body', 'The whole body'],
          ]}
          onChange={(v) => set('source', v)}
        />,
      );
      if (form.source === 'features') {
        body.push(
          <fieldset key="features" className="dialog-field checks" data-testid="field-features">
            <legend>Features</legend>
            {repeatable.length === 0 && (
              <p className="field-note">No extrusion, revolve or hole to repeat.</p>
            )}
            {repeatable.map((f) => (
              <Check
                key={f.id}
                label={f.name}
                checked={form.features.includes(f.id)}
                onChange={(on) =>
                  set(
                    'features',
                    on ? [...form.features, f.id] : form.features.filter((x) => x !== f.id),
                  )
                }
              />
            ))}
            {errors.features && <span className="field-error">{errors.features}</span>}
          </fieldset>,
        );
      }
      if (form.kind === 'mirror') {
        body.push(refField('plane'));
        break;
      }
      body.push(
        <Select
          key="layout"
          label="Layout"
          name="layout"
          value={form.layout}
          options={[
            ['linear', 'Linear'],
            ['circular', 'Circular'],
          ]}
          onChange={(v) => set('layout', v)}
        />,
        refField('direction'),
        <Check
          key="flip"
          label="Flip the direction"
          checked={form.flip}
          onChange={(v) => set('flip', v)}
        />,
        expression('count', 'Instances (with the original)', 'number', form.count),
        form.layout === 'linear'
          ? expression('spacing', 'Spacing', 'length', form.spacing)
          : expression('angle', 'Total angle', 'angle', form.angle),
      );
      break;
  }

  if (form.kind === 'thread') {
    const t = form;
    const thread = (patch: Partial<ThreadForm>) =>
      setForm((f) => ({ ...(f as ThreadForm), ...patch }));
    const sizes = threadSizesFor(t.system, cylinder, clearanceMm);
    const options: [string, string][] = sizes.map((x) => [x.size, sizeLabel(x)]);
    if (t.size !== '' && !sizes.some((x) => x.size === t.size)) {
      const known = threadSize(t.system, t.size);
      options.unshift([t.size, `${known ? sizeLabel(known) : t.size} (does not fit)`]);
    }
    if (t.size === '') options.unshift(['', options.length > 0 ? 'Choose a size' : 'No size fits']);
    body.push(
      refField('face'),
      cylinder !== null ? (
        <p key="cylinder" className="field-note" data-testid="field-cylinder">
          {cylinderLabel(cylinder)}: {cylinder.side === 'external' ? 'an external' : 'an internal'}{' '}
          thread.
        </p>
      ) : threadFace !== undefined ? (
        <p key="cylinder" className="field-note" data-testid="field-cylinder">
          Not the round face of a shaft or a hole as the part is now: pick another face.
        </p>
      ) : null,
      <Select
        key="system"
        label="Standard"
        name="system"
        value={t.system}
        options={[
          ['iso-metric', 'ISO metric coarse'],
          ['unc', 'UNC'],
        ]}
        onChange={(v) => {
          const system = v as ThreadForm['system'];
          const best = cylinder ? bestSize(system, cylinder, clearanceMm) : undefined;
          thread({ system, size: best?.size ?? '' });
        }}
      />,
      <Select
        key="size"
        label="Size"
        name="size"
        value={t.size}
        options={options}
        error={errors.size}
        onChange={(v) => thread({ size: v })}
      />,
      <Check
        key="full"
        label="The whole length of the face"
        checked={t.full}
        onChange={(v) => thread({ full: v })}
      />,
    );
    if (!t.full) body.push(expression('length', 'Length', 'length', t.length));
    body.push(
      refField('start'),
      <Select
        key="hand"
        label="Hand"
        name="hand"
        value={t.hand}
        options={[
          ['right', 'Right hand'],
          ['left', 'Left hand'],
        ]}
        onChange={(v) => thread({ hand: v as ThreadForm['hand'] })}
      />,
      expression('clearance', 'Clearance (across)', 'length', t.clearance, true),
      <Select
        key="representation"
        label="Representation"
        name="representation"
        value={t.representation}
        options={[
          ['modelled', 'Modelled (real thread)'],
          ['cosmetic', 'Cosmetic (resized, drawn)'],
        ]}
        onChange={(v) => thread({ representation: v as ThreadForm['representation'] })}
      />,
    );
  }

  // Which bodies it acts on, when there is a choice to make.
  if (takesScope(form) && (candidates.length > 1 || scopeOf(form) !== undefined)) {
    body.push(
      <ScopePicker
        key="scope"
        bodies={candidates}
        scope={scopeOf(form)}
        error={errors.scope}
        onChange={(scope) => setForm((f) => withScope(f, scope))}
      />,
    );
  }

  return (
    <aside
      ref={dialogRef}
      tabIndex={-1}
      className="selection-panel feature-dialog"
      role="dialog"
      aria-label={`${KIND_LABELS[request.kind]}: ${title}`}
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
      <h2>
        {KIND_LABELS[request.kind]}: {title}
      </h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        {body}
        {pickMessage && (
          <p className="field-error" role="status" data-testid="pick-message">
            {pickMessage}
          </p>
        )}
        {errors.form && (
          <p className="field-error" role="alert">
            {errors.form}
          </p>
        )}
        <div className="dialog-buttons">
          <button type="submit" className="primary" data-testid="dialog-ok">
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

function SketchSelect({
  value,
  sketches,
  error,
  onChange,
}: {
  value: string;
  sketches: readonly { id: string; name: string }[];
  error: string | undefined;
  onChange: (value: string) => void;
}) {
  const options: [string, string][] = sketches.map((s) => [s.id, s.name]);
  if (!sketches.some((s) => s.id === value))
    options.unshift([value, value ? value : 'Choose a sketch']);
  return (
    <Select
      label="Sketch"
      name="sketch"
      value={value}
      options={options}
      error={error}
      onChange={onChange}
    />
  );
}
