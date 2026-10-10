// Requirements and load cases in the app (ADR 0017 decision 10, T9.4a): the user states the
// outcome (requirements: a quantity, a comparison, a target, an optional tolerance and load case)
// and what the machine sees (load cases: a resistance mode, a force, a motion and a duty cycle of
// sets, reps and rests). A template (cable trainer, winch, linear axis) fills both in for the user
// to change. Each load case's law is plotted from the law itself, force against extension and
// against speed. Targets are the user's: nothing here calls a design safe, and no safety factor is
// filled in.

import {
  MECH_COUNTERS,
  REQUIREMENT_QUANTITIES,
  mechItems,
  peekCounter,
  type LoadCase,
  type ManufaktureDocument,
  type Requirement,
} from '@manufakture/core';
import {
  DISCLAIMER_SHORT,
  MECH_TEMPLATES,
  RESISTANCE_MODES,
  RESISTANCE_MODE_TEXT,
  REQUIREMENT_QUANTITY_TEXT,
  dutyCycle,
  forceCurves,
  itemProblemText,
  loadCaseProblems,
  quantityText,
  requirementProblems,
  resolveDynamic,
  templateCommand,
  type ResistanceModeKind,
} from '@manufakture/domain-mech';
import type { VariableLookup } from '@manufakture/units';
import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { evaluateVariables } from '../../sketcher/values';
import type { DocumentStoreApi } from '../../state/document';
import '../mech.css';
import { LawPlot } from './LawPlot';
import {
  MODE_PARAMS,
  loadCaseDraft,
  loadCaseFromDraft,
  newLoadCaseDraft,
  newRequirementDraft,
  nextRequirementId,
  requirementDraft,
  requirementFromDraft,
  withQuantity,
  type Comparison,
  type LoadCaseDraft,
  type RequirementDraft,
} from './draft';
import './requirements.css';

const COMPARISONS: readonly Comparison[] = ['>=', '<=', '>', '<'];

function lookup(doc: ManufaktureDocument): VariableLookup {
  const values = evaluateVariables(doc);
  return (n) => (Object.hasOwn(values, n) ? values[n] : undefined);
}

function seconds(s: number): string {
  if (s >= 120) return `${(s / 60).toFixed(1)} min`;
  return `${Number(s.toPrecision(3))} s`;
}

type Message = { error: boolean; text: string } | null;

/** The requirements table: edited as a whole and saved as one list. */
function RequirementsTable({
  documents,
  onMessage,
}: {
  documents: DocumentStoreApi;
  onMessage: (m: Message) => void;
}) {
  const doc = useStore(documents, (s) => s.document);
  const stored = doc.mech?.requirements;
  const loadCases = mechItems(doc.mech, 'loadCases');
  const [rows, setRows] = useState<RequirementDraft[]>(() => (stored ?? []).map(requirementDraft));
  const [problems, setProblems] = useState<string[]>([]);
  // A template, an undo or another client replaces the list: start again from what is stored.
  const [seen, setSeen] = useState(stored);
  if (seen !== stored) {
    setSeen(stored);
    setRows((stored ?? []).map(requirementDraft));
    setProblems([]);
  }

  const set = (i: number, next: RequirementDraft) =>
    setRows((r) => r.map((x, j) => (j === i ? next : x)));
  const add = () =>
    setRows((r) => [...r, newRequirementDraft(nextRequirementId(doc.mech?.nextIds ?? {}, r))]);

  const save = () => {
    const current = documents.getState().document;
    const variables = lookup(current);
    const list: Requirement[] = rows.map((d) => requirementFromDraft(d, current.units));
    const found = list.flatMap((r) =>
      requirementProblems(current, r, variables).map(
        (p) => `${r.name || r.id}: ${itemProblemText(p)}`,
      ),
    );
    const unnamed = list.filter((r) => r.name === '').map((r) => `${r.id}: give it a name`);
    if (found.length + unnamed.length > 0) {
      setProblems([...unnamed, ...found]);
      return;
    }
    const done = documents
      .getState()
      .execute({ type: 'setMechRequirements', requirements: list }, 'Requirements');
    if (!done.ok) {
      setProblems([done.error.message]);
      return;
    }
    setProblems([]);
    onMessage({ error: false, text: `Saved ${list.length} requirements.` });
  };

  return (
    <section className="req-section">
      <h3>Requirements</h3>
      {rows.length === 0 ? (
        <p className="field-note">No requirements yet. Add one, or start from a template.</p>
      ) : (
        <table className="req-table" data-testid="req-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Quantity</th>
              <th>
                <span className="req-hidden">Comparison</span>
              </th>
              <th>Target</th>
              <th>Tolerance</th>
              <th>Load case</th>
              <th>
                <span className="req-hidden">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const named = typeof r.quantity === 'string';
              const envelope = r.quantity === 'envelope';
              return (
                <tr key={r.id} data-testid={`req-row-${i}`}>
                  <td>
                    <input
                      type="text"
                      aria-label="Name"
                      data-testid={`req-name-${i}`}
                      value={r.name}
                      onChange={(e) => set(i, { ...r, name: e.target.value })}
                    />
                  </td>
                  <td>
                    {named ? (
                      <select
                        aria-label="Quantity"
                        data-testid={`req-quantity-${i}`}
                        value={r.quantity as string}
                        onChange={(e) => set(i, withQuantity(r, e.target.value))}
                      >
                        {REQUIREMENT_QUANTITIES.map((q) => (
                          <option key={q} value={q}>
                            {REQUIREMENT_QUANTITY_TEXT[q]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      quantityText(r.quantity)
                    )}
                  </td>
                  <td>
                    {envelope ? (
                      'within'
                    ) : (
                      <select
                        aria-label="Comparison"
                        data-testid={`req-comparison-${i}`}
                        value={r.comparison}
                        onChange={(e) => set(i, { ...r, comparison: e.target.value as Comparison })}
                      >
                        {COMPARISONS.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="req-values">
                    {r.value.map((v, k) => (
                      <input
                        key={k}
                        type="text"
                        aria-label={envelope ? ['x', 'y', 'z'][k] : 'Target'}
                        data-testid={`req-value-${i}-${k}`}
                        value={v}
                        onChange={(e) =>
                          set(i, {
                            ...r,
                            value: r.value.map((x, j) => (j === k ? e.target.value : x)),
                          })
                        }
                      />
                    ))}
                  </td>
                  <td>
                    <input
                      type="text"
                      aria-label="Tolerance"
                      data-testid={`req-tolerance-${i}`}
                      value={r.tolerance}
                      placeholder="none"
                      onChange={(e) => set(i, { ...r, tolerance: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      aria-label="Load case"
                      data-testid={`req-loadcase-${i}`}
                      value={r.loadCase}
                      onChange={(e) => set(i, { ...r, loadCase: e.target.value })}
                    >
                      <option value="">any</option>
                      {loadCases.map((lc) => (
                        <option key={lc.id} value={lc.id}>
                          {lc.name}
                        </option>
                      ))}
                      {r.loadCase !== '' && !loadCases.some((l) => l.id === r.loadCase) && (
                        <option value={r.loadCase}>{`${r.loadCase} (missing)`}</option>
                      )}
                    </select>
                  </td>
                  <td>
                    <button
                      type="button"
                      data-testid={`req-remove-${i}`}
                      title="Remove this requirement (saved with the list)"
                      onClick={() => setRows((x) => x.filter((_, j) => j !== i))}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {problems.length > 0 && (
        <ul className="text-error" role="alert" data-testid="req-problems">
          {problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      <div className="dialog-buttons">
        <button type="button" data-testid="req-add" onClick={add}>
          Add requirement
        </button>
        <button type="button" className="primary" data-testid="req-save" onClick={save}>
          Save requirements
        </button>
      </div>
    </section>
  );
}

function Field({
  label,
  name,
  value,
  hint,
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  hint?: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="dialog-field">
      <span>{label}</span>
      <input
        type="text"
        data-testid={`lc-field-${name}`}
        value={value}
        placeholder={hint}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** The plot and duty cycle of a draft, when it reads. */
function DraftLaw({ draft, doc }: { draft: LoadCaseDraft; doc: ManufaktureDocument }) {
  const built = useMemo(() => loadCaseFromDraft(draft, doc.units), [draft, doc.units]);
  const resolved = useMemo(() => {
    if (!built.ok || built.loadCase.dynamic === undefined) return undefined;
    return resolveDynamic(built.loadCase.dynamic, lookup(doc));
  }, [built, doc]);
  if (!draft.dynamic) return null;
  if (!built.ok) return <p className="field-note">{built.message}</p>;
  if (resolved === undefined) return null;
  if (!resolved.ok) {
    return (
      <p className="field-note" data-testid="lc-plot-missing">
        No plot until every value reads: {resolved.problems.map(itemProblemText).join('; ')}
      </p>
    );
  }
  const d = resolved.value;
  const m = d.motion;
  const furthest = m.kind === 'table' ? Math.max(...m.points.map(([, x]) => x)) : 0;
  const curves = forceCurves(
    d.law,
    m.kind === 'half-cosine'
      ? { stroke: m.stroke, pullSpeed: m.pullSpeed, returnSpeed: m.returnSpeed }
      : furthest > 0
        ? { stroke: furthest }
        : {},
  );
  const c = dutyCycle(d);
  return (
    <>
      <LawPlot curves={curves} units={doc.units} />
      <p className="field-note" data-testid="lc-duty">
        {`A rep takes ${seconds(c.repDuration)}; ${c.sets} ${c.sets === 1 ? 'set' : 'sets'} of ${c.reps} ${c.reps === 1 ? 'rep' : 'reps'}`}
        {c.sets > 1 ? ` with ${seconds(c.rest)} rests` : ''}
        {`: ${seconds(c.sessionDuration)} in all, ${seconds(c.workDuration)} of it under way.`}
      </p>
    </>
  );
}

function LoadCaseForm({
  documents,
  initial,
  isNew,
  onDone,
}: {
  documents: DocumentStoreApi;
  initial: LoadCaseDraft;
  isNew: boolean;
  onDone: (m: Message, select?: string) => void;
}) {
  const doc = useStore(documents, (s) => s.document);
  const [d, setD] = useState(initial);
  const [problems, setProblems] = useState<string[]>([]);
  const set = <K extends keyof LoadCaseDraft>(k: K, v: LoadCaseDraft[K]) =>
    setD((x) => ({ ...x, [k]: v }));
  const param = (k: string, v: string) => setD((x) => ({ ...x, params: { ...x.params, [k]: v } }));

  const save = () => {
    const current = documents.getState().document;
    const built = loadCaseFromDraft(d, current.units);
    if (!built.ok) {
      setProblems([built.message]);
      return;
    }
    const lc: LoadCase = built.loadCase;
    const found = loadCaseProblems(current, lc, lookup(current)).map(itemProblemText);
    if (lc.name === '') found.unshift('give it a name');
    if (found.length > 0) {
      setProblems(found);
      return;
    }
    const done = documents
      .getState()
      .execute({ type: 'setMechLoadCase', loadCase: lc }, `Load case ${lc.name}`);
    if (!done.ok) {
      setProblems([done.error.message]);
      return;
    }
    setProblems([]);
    onDone({ error: false, text: `Saved load case ${lc.name}.` }, lc.id);
  };

  const remove = () => {
    const done = documents
      .getState()
      .execute({ type: 'deleteMechLoadCase', loadCaseId: d.id }, `Delete ${d.name}`);
    onDone(
      done.ok
        ? { error: false, text: `Deleted ${d.name}.` }
        : { error: true, text: done.error.message },
    );
  };

  return (
    <div className="lc-form" data-testid="lc-form">
      <Field label="Name" name="name" value={d.name} onChange={(v) => set('name', v)} />
      {!d.dynamic ? (
        <p className="field-note">
          Static loads only.{' '}
          <button
            type="button"
            data-testid="lc-add-motion"
            onClick={() => setD({ ...newLoadCaseDraft(d.id), name: d.name, keep: d.keep })}
          >
            Add a motion
          </button>
        </p>
      ) : (
        <>
          <label className="dialog-field">
            <span>Resistance mode</span>
            <select
              data-testid="lc-field-mode"
              value={d.mode}
              onChange={(e) => set('mode', e.target.value as ResistanceModeKind)}
            >
              {RESISTANCE_MODES.map((m) => (
                <option key={m} value={m}>
                  {RESISTANCE_MODE_TEXT[m].name}
                </option>
              ))}
            </select>
          </label>
          <p className="field-note" data-testid="lc-law">
            {RESISTANCE_MODE_TEXT[d.mode].law}.
          </p>
          <div className="lc-grid">
            <Field
              label={
                d.mode === 'damper' || d.mode === 'rowing' || d.mode === 'table'
                  ? 'Force, at most'
                  : 'Force'
              }
              name="force"
              value={d.force}
              hint="200 lbf"
              onChange={(v) => set('force', v)}
            />
            {MODE_PARAMS[d.mode].map((p) => (
              <Field
                key={p.key}
                label={p.label}
                name={p.key}
                value={d.params[p.key] ?? ''}
                hint={p.hint}
                onChange={(v) => param(p.key, v)}
              />
            ))}
          </div>
          {d.mode === 'table' && (
            <>
              <label className="dialog-field">
                <span>Force by</span>
                <select
                  data-testid="lc-field-tableBy"
                  value={d.tableBy}
                  onChange={(e) => set('tableBy', e.target.value as 'position' | 'speed')}
                >
                  <option value="position">extension (m)</option>
                  <option value="speed">speed (m/s)</option>
                </select>
              </label>
              <label className="dialog-field">
                <span>{`Points: ${d.tableBy === 'position' ? 'extension in m' : 'speed in m/s'}, force in N, one per line`}</span>
                <textarea
                  rows={4}
                  data-testid="lc-field-tablePoints"
                  value={d.tablePoints}
                  placeholder={'0, 100\n0.6, 400'}
                  onChange={(e) => set('tablePoints', e.target.value)}
                />
              </label>
            </>
          )}
          <label className="dialog-field">
            <span>Motion</span>
            <select
              data-testid="lc-field-motion"
              value={d.motion}
              onChange={(e) => set('motion', e.target.value as 'half-cosine' | 'table')}
            >
              <option value="half-cosine">a rep: pull, pause, return, pause (half-cosine)</option>
              <option value="table">a table of time and extension</option>
            </select>
          </label>
          {d.motion === 'half-cosine' ? (
            <div className="lc-grid">
              <Field
                label="Stroke"
                name="stroke"
                value={d.stroke}
                hint="0.6 m"
                onChange={(v) => set('stroke', v)}
              />
              <Field
                label="Peak pull speed"
                name="pullSpeed"
                value={d.pullSpeed}
                hint="1.5 m/s"
                onChange={(v) => set('pullSpeed', v)}
              />
              <Field
                label="Peak return speed"
                name="returnSpeed"
                value={d.returnSpeed}
                hint="1 m/s"
                onChange={(v) => set('returnSpeed', v)}
              />
              <Field
                label="Pause"
                name="pause"
                value={d.pause}
                hint="0.2 s"
                onChange={(v) => set('pause', v)}
              />
            </div>
          ) : (
            <label className="dialog-field">
              <span>Points: time in s, extension in m, one per line</span>
              <textarea
                rows={4}
                data-testid="lc-field-motionPoints"
                value={d.motionPoints}
                placeholder={'0, 0\n1, 0.6'}
                onChange={(e) => set('motionPoints', e.target.value)}
              />
            </label>
          )}
          <div className="lc-grid">
            <Field
              label="Reps"
              name="reps"
              value={d.reps}
              hint="10"
              onChange={(v) => set('reps', v)}
            />
            <Field
              label="Sets"
              name="sets"
              value={d.sets}
              hint="1"
              onChange={(v) => set('sets', v)}
            />
            <Field
              label="Rest between sets"
              name="rest"
              value={d.rest}
              hint="none"
              onChange={(v) => set('rest', v)}
            />
            <Field
              label="Charge at the start"
              name="startCharge"
              value={d.startCharge}
              hint="1 (full)"
              onChange={(v) => set('startCharge', v)}
            />
            <Field
              label="Ambient"
              name="ambient"
              value={d.ambient}
              hint="the setting"
              onChange={(v) => set('ambient', v)}
            />
          </div>
          <DraftLaw draft={d} doc={doc} />
        </>
      )}
      {(d.keep.static ?? []).length > 0 && (
        <p className="field-note">{`${d.keep.static!.length} static loads, kept as they are.`}</p>
      )}
      {problems.length > 0 && (
        <ul className="text-error" role="alert" data-testid="lc-problems">
          {problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      <div className="dialog-buttons">
        {!isNew && (
          <button type="button" data-testid="lc-delete" onClick={remove}>
            Delete load case
          </button>
        )}
        <button type="button" className="primary" data-testid="lc-save" onClick={save}>
          {isNew ? 'Add load case' : 'Save load case'}
        </button>
      </div>
    </div>
  );
}

function LoadCases({
  documents,
  onMessage,
}: {
  documents: DocumentStoreApi;
  onMessage: (m: Message) => void;
}) {
  const doc = useStore(documents, (s) => s.document);
  const cases = mechItems(doc.mech, 'loadCases');
  const [selected, setSelected] = useState<string | null>(null);
  const stored = cases.find((c) => c.id === selected);
  const nextId = `${MECH_COUNTERS.loadCase}#${peekCounter(doc.mech?.nextIds ?? {}, MECH_COUNTERS.loadCase)}`;
  const isNew = selected === nextId && stored === undefined;
  const draft =
    stored !== undefined ? loadCaseDraft(stored) : isNew ? newLoadCaseDraft(nextId) : undefined;

  return (
    <section className="req-section">
      <h3>Load cases</h3>
      <div className="lc-list" role="tablist" aria-label="Load cases">
        {cases.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={c.id === selected}
            data-testid={`lc-select-${c.id}`}
            onClick={() => setSelected(c.id)}
          >
            {c.name}
            {c.dynamic !== undefined && (
              <em className="parts-unit"> {RESISTANCE_MODE_TEXT[c.dynamic.mode.kind].name}</em>
            )}
          </button>
        ))}
        <button type="button" data-testid="lc-new" onClick={() => setSelected(nextId)}>
          New load case
        </button>
      </div>
      {draft !== undefined && (
        <LoadCaseForm
          // A different load case, or the same one changed elsewhere, starts a fresh draft.
          key={`${draft.id}:${JSON.stringify(stored ?? null)}`}
          documents={documents}
          initial={draft}
          isNew={isNew}
          onDone={(m, select) => {
            onMessage(m);
            setSelected(select ?? null);
          }}
        />
      )}
    </section>
  );
}

export function RequirementsDialog({
  documents,
  onClose,
}: {
  documents: DocumentStoreApi;
  onClose: () => void;
}) {
  const [template, setTemplate] = useState<string>(MECH_TEMPLATES[0]!.id);
  const [message, setMessage] = useState<Message>(null);
  const chosen = MECH_TEMPLATES.find((t) => t.id === template);

  const addTemplate = () => {
    const current = documents.getState().document;
    const t = templateCommand(current, template);
    if (!t.ok) {
      setMessage({ error: true, text: t.message });
      return;
    }
    const done = documents.getState().execute(t.command, t.label);
    if (!done.ok) {
      setMessage({ error: true, text: done.error.message });
      return;
    }
    setMessage({
      error: false,
      text: `Added ${t.requirementIds.length} requirements and ${t.loadCaseIds.length} load cases. Change every number to your own.`,
    });
  };

  return (
    <div className="mech-start-backdrop">
      <section
        className="mech-start req-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="req-title"
        data-testid="req-dialog"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <h2 id="req-title">Requirements and load cases</h2>
        <p className="field-note" data-testid="req-disclaimer">
          {DISCLAIMER_SHORT}
        </p>
        <p className="field-note">
          Requirements are your targets; results against them say meets or misses and by how much.
          Load cases are what the machine sees. Physical values need their units:{' '}
          <code>200 lbf</code>, <code>1.5 m/s</code>, <code>30 s</code>.
        </p>
        <div className="req-template">
          <label className="dialog-field">
            <span>Start from a template</span>
            <select
              data-testid="req-template"
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
            >
              {MECH_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" data-testid="req-template-add" onClick={addTemplate}>
            Add template
          </button>
        </div>
        {chosen !== undefined && <p className="field-note">{chosen.description}</p>}
        <RequirementsTable documents={documents} onMessage={setMessage} />
        <LoadCases documents={documents} onMessage={setMessage} />
        {message !== null && (
          <p
            className={message.error ? 'text-error' : 'field-note'}
            role={message.error ? 'alert' : 'status'}
            data-testid="req-message"
          >
            {message.text}
          </p>
        )}
        <div className="dialog-buttons">
          <button type="button" data-testid="req-close" onClick={onClose}>
            Close
          </button>
        </div>
      </section>
    </div>
  );
}

/** The Requirements button of the part studio's toolbar. */
export function MechRequirementsButton({
  documents,
  disabled,
}: {
  documents: DocumentStoreApi;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="toolbar-group" role="toolbar" aria-label="Requirements">
      <button
        type="button"
        aria-pressed={open}
        disabled={disabled}
        data-testid="req-open"
        title="Requirements and load cases: your targets, what the machine sees, templates"
        onClick={() => setOpen(true)}
      >
        Requirements
      </button>
      {open && <RequirementsDialog documents={documents} onClose={() => setOpen(false)} />}
    </div>
  );
}
