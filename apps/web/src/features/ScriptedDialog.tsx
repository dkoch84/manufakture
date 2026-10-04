// The scripted feature's dialog (ADR 0010 decision 6): which script of the document's library it
// runs, one field per parameter the script declares (expression fields for numbers, lengths and
// angles, a check box, a choice, faces or edges picked in the viewport), and the seed of the
// script's `Math.random` (default 0). The fields come from the script's declarations, which the
// regen worker reads by running the script's top-level code; so they are read only when this
// document's scripts may run on this device (scripts/policy.ts). Otherwise the dialog says so and
// keeps the stored values as they are. OK applies the whole dialog as one core command.

import {
  defaultFeatureName,
  findPart,
  previewIds,
  type ManufaktureDocument,
  type Script,
  type ScriptedFeature,
} from '@manufakture/core';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ExpressionField } from '../components/ExpressionField';
import { featureResult, type ModelStore } from '../model/model';
import { evaluateVariables } from '../sketcher/values';
import type { DocumentStoreApi } from '../state/document';
import {
  isGeometryRef,
  itemKey,
  type GeometryRef,
  type SelectableItem,
  type SelectionStore,
} from '../state/selection';
import { KIND_LABELS } from '../tree/tree';
import { Check, RefFieldView, Select } from './fields';
import { lostReferences, type RefField, type RefKind } from './forms';
import type { PickOutcome } from './references';
import {
  addParamRef,
  buildScripted,
  fieldsFor,
  newScriptedForm,
  ownValue,
  paramKey,
  paramRefField,
  scriptedFormOf,
  type ParamField,
  type ParamSpec,
  type ScriptedForm,
  withValue,
} from './scripted';

/** What the dialog needs of the scripts machinery (the app passes the regen worker's). */
export interface ScriptedServices {
  /**
   * The parameter declarations of a script of `doc`, read in the regen worker (which checks the
   * opt-in again before it runs anything). Null when the worker was stopped before it answered.
   */
  declarations(
    script: Pick<Script, 'id' | 'source' | 'language' | 'apiVersion'>,
    doc: ManufaktureDocument,
  ): Promise<
    | { ok: true; params: ParamSpec[] }
    | { ok: false; message: string; line?: number; column?: number }
    | null
  >;
  /** Whether a script of this document may run on this device (the opt-in). */
  mayRun(doc: ManufaktureDocument, script: Script): Promise<boolean>;
  /** Open a script in the script editor. */
  openScript?(scriptId: string): void;
}

export interface ScriptedDialogProps {
  request: { kind: 'scripted'; featureId?: string; repick?: string };
  documents: DocumentStoreApi;
  model: ModelStore;
  selection: SelectionStore;
  resolve: (geo: GeometryRef, accepts: readonly RefKind[]) => Promise<PickOutcome>;
  partId?: string;
  onClose: () => void;
  scripts: ScriptedServices | null;
}

/** Where reading the declarations stands. */
type Declared =
  | { state: 'loading' }
  | { state: 'ready'; specs: ParamSpec[] }
  | { state: 'blocked' }
  | { state: 'failed'; message: string };

export function ScriptedDialog({
  request,
  documents,
  model,
  selection,
  resolve,
  partId: givenPartId,
  onClose,
  scripts,
}: ScriptedDialogProps) {
  const [partId] = useState(() => givenPartId ?? documents.getState().activePartId);
  const doc = documents.getState().document;
  const part = findPart(doc, partId)!;
  const found = request.featureId
    ? part.features.find((f) => f.id === request.featureId)
    : undefined;
  const existing = found?.kind === 'scripted' ? (found as ScriptedFeature) : undefined;
  const units = doc.units;
  const variables = useMemo(() => evaluateVariables(doc), [doc]);
  const variableNames = useMemo(() => doc.variables.map((v) => v.name), [doc]);
  const library = doc.scripts ?? [];

  const [form, setForm] = useState<ScriptedForm>(() =>
    existing ? scriptedFormOf(existing) : newScriptedForm(doc),
  );
  const [declared, setDeclared] = useState<Declared>({ state: 'loading' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pickMessage, setPickMessage] = useState<string | null>(null);
  const script = library.find((s) => s.id === form.script);

  // Lost references of the last regen, asked for again (and the one the tree's re-pick names).
  const lost = useMemo(() => {
    if (!existing) return new Set<string>();
    const result = featureResult(model.getState(), partId, existing.id);
    const set = lostReferences(result?.errors ?? []);
    if (request.repick) set.add(request.repick);
    return set;
  }, [existing, model, partId, request.repick]);

  // Read the declarations of the chosen script whenever it changes.
  useEffect(() => {
    if (script === undefined || scripts === null) {
      setDeclared(
        scripts === null
          ? { state: 'failed', message: 'Scripts cannot run in this view.' }
          : { state: 'failed', message: 'Choose a script.' },
      );
      return;
    }
    let live = true;
    setDeclared({ state: 'loading' });
    void (async () => {
      const current = documents.getState().document;
      if (!(await scripts.mayRun(current, script))) {
        if (live) setDeclared({ state: 'blocked' });
        return;
      }
      const r = await scripts.declarations(script, current);
      if (!live) return;
      if (r === null) setDeclared({ state: 'failed', message: 'The script could not be read.' });
      else if (!r.ok) {
        const at = r.line !== undefined ? ` (line ${r.line})` : '';
        setDeclared({ state: 'failed', message: `${r.message}${at}` });
      } else {
        setDeclared({ state: 'ready', specs: r.params });
        setForm((f) => ({
          ...f,
          values: fieldsFor(r.params, units, {
            keep: f.values,
            ...(existing && existing.script === f.script ? { stored: existing.params, lost } : {}),
          }),
        }));
      }
    })().catch((e: unknown) => {
      if (live)
        setDeclared({ state: 'failed', message: e instanceof Error ? e.message : String(e) });
    });
    return () => {
      live = false;
    };
    // The script as stored is what is read: its id and source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [script?.id, script?.source, script?.language, scripts]);

  const specs = declared.state === 'ready' ? declared.specs : null;
  const fields = useMemo(() => (specs ?? []).flatMap((s) => paramRefField(s) ?? []), [specs]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const active =
    fields.find((f) => f.key === activeKey) ??
    fields.find((f) => {
      const v = ownValue(form.values, f.key.slice('param:'.length));
      return v?.kind === 'reference' && v.refs.some((r) => r.lost);
    }) ??
    fields[0] ??
    null;
  const activeRef = useRef<RefField | null>(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

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
        const name = field.key.slice('param:'.length);
        setForm((f) => {
          const v = ownValue(f.values, name);
          const refs = v?.kind === 'reference' ? v.refs : [];
          const added = addParamRef(refs, field, r.item);
          return { ...f, values: withValue(f.values, name, { kind: 'reference', refs: added }) };
        });
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

  // Faces and edges picked while the dialog is open go to the active reference field.
  useEffect(() => {
    let previous: readonly SelectableItem[] = selection.getState().selected;
    return selection.subscribe((s) => {
      if (s.selected === previous) return;
      const before = new Set(previous.map(itemKey));
      previous = s.selected;
      for (const item of s.selected) {
        if (isGeometryRef(item) && !before.has(itemKey(item))) pick(item);
      }
    });
  }, [selection, pick]);

  // Focus moves in on open and goes back on close.
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

  const id = existing?.id ?? previewIds(part.nextIds, 'scripted')[0]!;
  const title = existing?.name ?? defaultFeatureName('scripted', id);

  const apply = () => {
    if (declared.state === 'loading') {
      setErrors({ form: 'Wait until the script has been read.' });
      return;
    }
    const current = documents.getState().document;
    const r = buildScripted(
      form,
      specs,
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

  const setValue = (name: string, value: ParamField) =>
    setForm((f) => ({ ...f, values: withValue(f.values, name, value) }));

  const body: ReactNode[] = [];
  body.push(
    <p key="mark" className="field-note scripted-mark" data-testid="scripted-mark">
      A scripted feature: its geometry is computed by a script of this document.
    </p>,
  );
  if (library.length === 0) {
    body.push(
      <p key="none" className="field-error" data-testid="scripted-no-scripts">
        This document has no scripts yet: write one with New script in the Scripts panel.
      </p>,
    );
  } else {
    const options: [string, string][] = library.map((s) => [s.id, s.name]);
    if (script === undefined) options.unshift([form.script, 'Choose a script']);
    body.push(
      <Select
        key="script"
        label="Script"
        name="script"
        value={form.script}
        options={options}
        error={errors.script}
        onChange={(v) => setForm((f) => ({ ...f, script: v }))}
      />,
    );
    if (script && scripts?.openScript) {
      const open = scripts.openScript;
      body.push(
        <button
          key="open"
          type="button"
          className="link"
          data-testid="scripted-open-script"
          onClick={() => open(script.id)}
        >
          Edit the script {script.name}
        </button>,
      );
    }
  }

  if (declared.state === 'loading' && script) {
    body.push(
      <p key="loading" className="field-note" role="status">
        Reading the script&apos;s parameters...
      </p>,
    );
  } else if (declared.state === 'blocked') {
    body.push(
      <p key="blocked" className="field-note" role="status" data-testid="scripted-blocked">
        This document&apos;s scripts have not been allowed on this device, so the script&apos;s
        parameters are not read. Choose Run scripts in the banner to edit them; OK keeps the stored
        values.
      </p>,
    );
  } else if (declared.state === 'failed' && script) {
    body.push(
      <p key="failed" className="field-error" role="alert" data-testid="scripted-failed">
        The script&apos;s parameters could not be read: {declared.message}
      </p>,
    );
  } else if (specs !== null) {
    if (specs.length === 0) {
      body.push(
        <p key="no-params" className="field-note">
          The script declares no parameters.
        </p>,
      );
    }
    for (const spec of specs) {
      const label = spec.label ?? spec.name;
      const value = ownValue(form.values, spec.name);
      const key = paramKey(spec.name);
      const help = spec.description ? (
        <p key={`${key}/help`} className="field-note">
          {spec.description}
        </p>
      ) : null;
      switch (spec.kind) {
        case 'number':
        case 'length':
        case 'angle':
          body.push(
            <ExpressionField
              key={key}
              label={label}
              testId={`field-param-${spec.name}`}
              value={value?.kind === 'expression' ? value.text : ''}
              kind={spec.kind}
              units={units}
              variables={variables}
              names={variableNames}
              error={errors[key]}
              onChange={(text) => setValue(spec.name, { kind: 'expression', text })}
            />,
          );
          break;
        case 'boolean':
          body.push(
            <Check
              key={key}
              label={label}
              checked={value?.kind === 'boolean' ? value.value : spec.default}
              onChange={(on) => setValue(spec.name, { kind: 'boolean', value: on })}
            />,
          );
          break;
        case 'choice':
          body.push(
            <Select
              key={key}
              label={label}
              name={`param-${spec.name}`}
              value={value?.kind === 'choice' ? value.value : spec.default}
              options={spec.options.map((o): [string, string] => [o, o])}
              error={errors[key]}
              onChange={(v) => setValue(spec.name, { kind: 'choice', value: v })}
            />,
          );
          break;
        case 'reference': {
          const field = fields.find((f) => f.key === key);
          if (spec.select === 'vertex') {
            body.push(
              <p key={key} className="field-error">
                {label}: vertices cannot be picked yet.
              </p>,
            );
          } else if (field) {
            body.push(
              <RefFieldView
                key={key}
                field={field}
                refs={value?.kind === 'reference' ? value.refs : []}
                active={active?.key === key}
                error={errors[key]}
                onActivate={() => setActiveKey(key)}
                onRemove={(i) =>
                  setValue(spec.name, {
                    kind: 'reference',
                    refs: (value?.kind === 'reference' ? value.refs : []).filter((_, j) => j !== i),
                  })
                }
              />,
            );
          }
          break;
        }
      }
      if (help) body.push(help);
    }
  }

  body.push(
    <div key="seed" className="dialog-field">
      <label>
        Seed
        <input
          data-testid="field-seed"
          inputMode="numeric"
          value={form.seed}
          aria-invalid={errors.seed !== undefined}
          title="Seeds the script's Math.random: change it for another random variant"
          onChange={(e) => setForm((f) => ({ ...f, seed: e.target.value }))}
        />
      </label>
      {errors.seed && <span className="field-error">{errors.seed}</span>}
    </div>,
  );

  return (
    <aside
      ref={dialogRef}
      tabIndex={-1}
      className="selection-panel feature-dialog"
      role="dialog"
      aria-label={`${KIND_LABELS.scripted}: ${title}`}
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
        {KIND_LABELS.scripted}: {title}
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
          <button
            type="submit"
            className="primary"
            data-testid="dialog-ok"
            disabled={library.length === 0}
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
