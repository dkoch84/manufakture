// The drivetrain panel (ADR 0017 decision 9, T9.3a): the chain from the motor to the output, stage
// by stage, tied to the assembly (each stage names its instances and the motor its revolute mate),
// and what it gives: the overall ratio and efficiency, every turning element's inertia with where
// it came from, the inertia reflected to the motor and to the output, and the motor torque for a
// torque and an acceleration at the output. The numbers are regen's (the kernel measures the
// instances); a stage naming something that is not there is listed, and the records that need it
// say what is missing. Numbers only: nothing here calls a design safe.

import {
  mechItems,
  storedExpression,
  type Assembly,
  type ManufaktureDocument,
} from '@manufakture/core';
import {
  DISCLAIMER_SHORT,
  OUTPUT_KIND_TEXT,
  STAGE_KIND_TEXT,
  analyseDrivetrain,
  drivetrainChain,
  drivetrainProblemText,
  entryItem,
  formatSI,
  mechEvaluationOf,
  motorTorque,
  resolveEntry,
  siValue,
  type DrivetrainAnalysis,
  type InertiaElement,
  type OutputKind,
  type PowerFlow,
  type StageKind,
} from '@manufakture/domain-mech';
import {
  formatQuantity,
  makeDimension,
  resolveDisplayUnit,
  type PhysicalKind,
  type VariableLookup,
} from '@manufakture/units';
import { useState } from 'react';
import { useStore } from 'zustand';
import type { ModelStore } from '../../model/model';
import { evaluateVariables } from '../../sketcher/values';
import type { DocumentStoreApi } from '../../state/document';
import '../mech.css';
import {
  drivetrainDraft,
  drivetrainFromDraft,
  newDrivetrainDraft,
  newOutputDraft,
  withKind,
  withStage,
  type DrivetrainDraft,
  type OutputDraft,
  type StageDraft,
} from './draft';
import './drivetrain.css';

const STAGE_KINDS = Object.keys(STAGE_KIND_TEXT) as StageKind[];
const OUTPUT_KINDS = Object.keys(OUTPUT_KIND_TEXT) as OutputKind[];
const ANGULAR_ACCELERATION = { dimension: makeDimension({ time: -2 }), unit: 'rad/s^2' };

type Message = { error: boolean; text: string } | null;

function lookup(doc: ManufaktureDocument): VariableLookup {
  const values = evaluateVariables(doc);
  return (n) => (Object.hasOwn(values, n) ? values[n] : undefined);
}

/** A value of a physical kind in the document's display unit for it. */
function shown(doc: ManufaktureDocument, si: number, kind: PhysicalKind): string {
  const unit = resolveDisplayUnit(kind, doc.units.quantities, doc.units.length.unit);
  return formatQuantity(si, kind, { unit });
}

const number = (v: number) => String(Number(v.toPrecision(5)));

function speedText(n: number | undefined): string {
  if (n === undefined) return 'not known';
  return n === 1 ? 'motor speed' : `motor speed / ${number(n)}`;
}

/** The purchased uses as options: "Drive motor (pp#2)". */
function purchasedOptions(doc: ManufaktureDocument): { id: string; label: string }[] {
  return mechItems(doc.mech, 'purchased').map((u) => {
    const e = resolveEntry(doc, u.entry);
    const item = e.ok ? entryItem(e.entry) : u.entry.id;
    return { id: u.id, label: `${u.name ?? item} (${u.id})` };
  });
}

function Select({
  label,
  testId,
  value,
  options,
  empty,
  onChange,
}: {
  label: string;
  testId: string;
  value: string;
  options: readonly { id: string; label: string }[];
  empty?: string;
  onChange: (v: string) => void;
}) {
  const known = value === '' || options.some((o) => o.id === value);
  return (
    <label className="dialog-field">
      <span>{label}</span>
      <select data-testid={testId} value={value} onChange={(e) => onChange(e.target.value)}>
        {empty !== undefined && <option value="">{empty}</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
        {!known && <option value={value}>{`${value} (missing)`}</option>}
      </select>
    </label>
  );
}

function Text({
  label,
  testId,
  value,
  hint,
  onChange,
}: {
  label: string;
  testId: string;
  value: string;
  hint?: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="dialog-field">
      <span>{label}</span>
      <input
        type="text"
        data-testid={testId}
        value={value}
        placeholder={hint}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function StageFields({
  s,
  i,
  doc,
  assembly,
  set,
}: {
  s: StageDraft;
  i: number;
  doc: ManufaktureDocument;
  assembly: Assembly | undefined;
  set: (next: StageDraft) => void;
}) {
  const instances = (assembly?.instances ?? []).map((x) => ({
    id: x.id,
    label: `${x.name} (${x.id})`,
  }));
  const field = <K extends keyof StageDraft>(k: K) => ({
    value: s[k] as string,
    testId: `dt-stage-${String(k)}-${i}`,
    onChange: (v: string) => set({ ...s, [k]: v }),
  });
  const reduction = s.kind === 'belt' || s.kind === 'gear' || s.kind === 'planetary';
  return (
    <div className="dt-fields">
      {s.kind === 'motor' && (
        <>
          <Select label="Motor" options={purchasedOptions(doc)} empty="choose" {...field('use')} />
          <Select label="Instance" options={instances} empty="none" {...field('instance')} />
          <Select
            label="Revolute mate"
            options={(assembly?.mates ?? [])
              .filter((m) => m.kind === 'revolute')
              .map((m) => ({ id: m.id, label: `${m.name} (${m.id})` }))}
            empty="none"
            {...field('mate')}
          />
          <Text label="Rotor inertia" hint="from the catalog" {...field('inertia')} />
        </>
      )}
      {reduction && (
        <>
          <label className="dialog-field">
            <span>Ratio as</span>
            <select
              data-testid={`dt-stage-ratioBy-${i}`}
              value={s.ratioBy}
              onChange={(e) => set({ ...s, ratioBy: e.target.value as 'ratio' | 'teeth' })}
            >
              <option value="ratio">a number (input speed / output speed)</option>
              <option value="teeth">tooth counts</option>
            </select>
          </label>
          {s.ratioBy === 'ratio' ? (
            <Text label="Ratio" hint="5" {...field('ratio')} />
          ) : (
            <>
              <Text label="Driver teeth" hint="15" {...field('driver')} />
              <Text label="Driven teeth" hint="75" {...field('driven')} />
            </>
          )}
          <Text label="Efficiency" hint="0.95" {...field('efficiency')} />
          {s.kind !== 'belt' && (
            <>
              <Select
                label="Input member"
                options={instances}
                empty="none"
                {...field('inputMember')}
              />
              <Select
                label="Output member"
                options={instances}
                empty="none"
                {...field('outputMember')}
              />
            </>
          )}
          <Text
            label="Inertia, referred to the input"
            hint={s.kind === 'belt' ? 'not counted' : 'measured from the members'}
            {...field('inertia')}
          />
        </>
      )}
      {(s.kind === 'shaft' || s.kind === 'coupling') && (
        <>
          <Select label="Instance" options={instances} empty="none" {...field('instance')} />
          <Text label="Inertia" hint="measured from the instance" {...field('inertia')} />
        </>
      )}
    </div>
  );
}

function OutputFields({
  o,
  doc,
  assembly,
  set,
}: {
  o: OutputDraft;
  doc: ManufaktureDocument;
  assembly: Assembly | undefined;
  set: (next: OutputDraft) => void;
}) {
  const instances = (assembly?.instances ?? []).map((x) => ({
    id: x.id,
    label: `${x.name} (${x.id})`,
  }));
  const field = <K extends keyof OutputDraft>(k: K) => ({
    value: o[k] as string,
    testId: `dt-output-${String(k)}`,
    onChange: (v: string) => set({ ...o, [k]: v }),
  });
  return (
    <div className="dt-fields">
      <label className="dialog-field">
        <span>Output</span>
        <select
          data-testid="dt-output-kind"
          value={o.kind}
          onChange={(e) => {
            const kind = e.target.value as OutputKind;
            set({
              ...newOutputDraft(kind),
              instance: o.instance,
              ...(o.original !== undefined ? { original: o.original } : {}),
            });
          }}
        >
          {OUTPUT_KINDS.map((k) => (
            <option key={k} value={k}>
              {OUTPUT_KIND_TEXT[k]}
            </option>
          ))}
        </select>
      </label>
      <Select label="Instance" options={instances} empty="none" {...field('instance')} />
      {o.kind === 'spool' && (
        <>
          <Text label="Body" hint="every body of the instance" {...field('body')} />
          <Select
            label="Cable"
            options={purchasedOptions(doc)}
            empty="choose"
            {...field('cable')}
          />
          <Text label="Cable length" hint="2.5 m" {...field('length')} />
          <Text label="Core diameter" hint="from the geometry" {...field('core')} />
          <Text label="Flange diameter" hint="from the geometry" {...field('flange')} />
          <Text label="Width" hint="from the geometry" {...field('width')} />
        </>
      )}
      {o.kind === 'linear' && (
        <>
          <Text label="Lead" hint="5 mm" {...field('lead')} />
          <Text label="Efficiency" hint="0.9" {...field('efficiency')} />
        </>
      )}
      {o.kind !== 'linear' && (
        <Text label="Inertia" hint="measured from the instance" {...field('inertia')} />
      )}
    </div>
  );
}

function DrivetrainForm({
  documents,
  initial,
  isNew,
  onDone,
}: {
  documents: DocumentStoreApi;
  initial: DrivetrainDraft;
  isNew: boolean;
  onDone: (m: Message, select?: string | null) => void;
}) {
  const doc = useStore(documents, (s) => s.document);
  const [d, setD] = useState(initial);
  const [addKind, setAddKind] = useState<StageKind>('belt');
  const [problems, setProblems] = useState<string[]>([]);
  const assembly = doc.assemblies?.find((a) => a.id === d.assembly);
  const nextIds = doc.mech?.nextIds ?? {};
  const setStage = (i: number, next: StageDraft) =>
    setD((x) => ({ ...x, stages: x.stages.map((s, j) => (j === i ? next : s)) }));
  const move = (i: number, by: number) =>
    setD((x) => {
      const stages = [...x.stages];
      const [s] = stages.splice(i, 1);
      stages.splice(i + by, 0, s!);
      return { ...x, stages };
    });

  const save = () => {
    const current = documents.getState().document;
    const built = drivetrainFromDraft(d, current.units);
    if (!built.ok) {
      setProblems([built.message]);
      return;
    }
    // Values that do not read and a chain out of order are refused; a reference to something
    // that is not there is the evaluation's warning, shown with the results.
    const chain = drivetrainChain({ document: current, variables: lookup(current) }, built.value);
    const found = chain.problems.filter((p) => p.kind !== 'reference').map(drivetrainProblemText);
    if (found.length > 0) {
      setProblems(found);
      return;
    }
    const done = documents
      .getState()
      .execute(
        { type: 'setDrivetrain', drivetrain: built.value },
        `Drivetrain ${built.value.name}`,
      );
    if (!done.ok) {
      setProblems([done.error.message]);
      return;
    }
    setProblems([]);
    onDone({ error: false, text: `Saved drivetrain ${built.value.name}.` }, built.value.id);
  };

  const remove = () => {
    const done = documents
      .getState()
      .execute({ type: 'deleteDrivetrain', drivetrainId: d.id }, `Delete ${d.name}`);
    onDone(
      done.ok
        ? { error: false, text: `Deleted ${d.name}.` }
        : { error: true, text: done.error.message },
      null,
    );
  };

  return (
    <div className="dt-form" data-testid="dt-form">
      <div className="dt-fields">
        <Text
          label="Name"
          testId="dt-name"
          value={d.name}
          onChange={(v) => setD({ ...d, name: v })}
        />
        <Select
          label="Assembly"
          testId="dt-assembly"
          value={d.assembly}
          options={(doc.assemblies ?? []).map((a) => ({ id: a.id, label: a.name }))}
          empty="none"
          onChange={(v) => setD({ ...d, assembly: v })}
        />
      </div>
      <ol className="dt-stages">
        {d.stages.map((s, i) => (
          <li key={s.id} className="dt-stage" data-testid={`dt-stage-${i}`}>
            <div className="dt-stage-head">
              <select
                aria-label="Stage kind"
                data-testid={`dt-stage-kind-${i}`}
                value={s.kind}
                onChange={(e) => setStage(i, withKind(s, e.target.value as StageKind))}
              >
                {STAGE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {STAGE_KIND_TEXT[k]}
                  </option>
                ))}
              </select>
              <em className="dt-id">{s.id}</em>
              <button
                type="button"
                data-testid={`dt-stage-up-${i}`}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                Up
              </button>
              <button
                type="button"
                data-testid={`dt-stage-down-${i}`}
                disabled={i === d.stages.length - 1}
                onClick={() => move(i, 1)}
              >
                Down
              </button>
              <button
                type="button"
                data-testid={`dt-stage-remove-${i}`}
                onClick={() => setD({ ...d, stages: d.stages.filter((_, j) => j !== i) })}
              >
                Remove
              </button>
            </div>
            <StageFields s={s} i={i} doc={doc} assembly={assembly} set={(n) => setStage(i, n)} />
          </li>
        ))}
      </ol>
      <div className="dt-add">
        <select
          aria-label="Kind of stage to add"
          data-testid="dt-add-kind"
          value={addKind}
          onChange={(e) => setAddKind(e.target.value as StageKind)}
        >
          {STAGE_KINDS.map((k) => (
            <option key={k} value={k}>
              {STAGE_KIND_TEXT[k]}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="dt-add-stage"
          onClick={() => setD(withStage(d, addKind, nextIds))}
        >
          Add stage
        </button>
      </div>
      <OutputFields
        o={d.output}
        doc={doc}
        assembly={assembly}
        set={(o) => setD({ ...d, output: o })}
      />
      {problems.length > 0 && (
        <ul className="text-error" role="alert" data-testid="dt-problems">
          {problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      <div className="dialog-buttons">
        {!isNew && (
          <button type="button" data-testid="dt-delete" onClick={remove}>
            Delete drivetrain
          </button>
        )}
        <button type="button" className="primary" data-testid="dt-save" onClick={save}>
          {isNew ? 'Add drivetrain' : 'Save drivetrain'}
        </button>
      </div>
    </div>
  );
}

function sourceText(e: InertiaElement): string {
  if (e.source === 'none') return 'none given: counted as zero';
  return e.missing !== undefined ? `${e.from}: ${e.missing}` : e.from;
}

/** The motor torque for a torque and an acceleration the user types at the output. */
function TorqueCalc({ doc, analysis }: { doc: ManufaktureDocument; analysis: DrivetrainAnalysis }) {
  const [torque, setTorque] = useState('');
  const [accel, setAccel] = useState('');
  const [flow, setFlow] = useState<PowerFlow>('driving');
  // Nothing typed: no torque asked for; no acceleration typed: a steady speed.
  const t =
    torque.trim() === ''
      ? undefined
      : siValue(storedExpression(torque, doc.units), 'torque', lookup(doc));
  const a =
    accel.trim() === ''
      ? ({ ok: true, value: 0 } as const)
      : siValue(storedExpression(accel, doc.units), 'any', lookup(doc), ANGULAR_ACCELERATION);
  const record =
    t?.ok === true && a.ok
      ? motorTorque(analysis, { outputTorque: t.value, outputAcceleration: a.value, flow })
      : undefined;
  return (
    <div className="dt-torque" data-testid="dt-torque">
      <div className="dt-fields">
        <Text
          label="Torque at the output"
          testId="dt-torque-out"
          value={torque}
          hint="N*m, lbf*ft"
          onChange={setTorque}
        />
        <Text
          label="Acceleration at the output"
          testId="dt-torque-accel"
          value={accel}
          hint="0 rad/s^2 (steady)"
          onChange={setAccel}
        />
        <label className="dialog-field">
          <span>Power flows</span>
          <select
            data-testid="dt-torque-flow"
            value={flow}
            onChange={(e) => setFlow(e.target.value as PowerFlow)}
          >
            <option value="driving">from the motor (it drives the output)</option>
            <option value="back-driven">from the output (it back-drives the motor)</option>
          </select>
        </label>
      </div>
      <p className="field-note" data-testid="dt-torque-signs">
        A positive acceleration speeds the motion up in its own direction; a slowing motion is
        negative. Driving, the motor torque is in the direction of motion; back-driven, it is
        against it.
      </p>
      {t?.ok === false && <p className="text-error">Torque: {t.message}</p>}
      {!a.ok && <p className="text-error">Acceleration: {a.message}</p>}
      {record !== undefined && (
        <>
          <p data-testid="dt-torque-result">
            <strong>Motor torque:</strong>{' '}
            {record.result !== null ? shown(doc, record.result, 'torque') : 'not known'}
            {record.note !== undefined && ` (${record.note})`}
          </p>
          <p className="field-note">
            {record.method}. <code>{record.formula}</code>
          </p>
          {record.derived.length > 0 && (
            <ul className="dt-notes" data-testid="dt-torque-working">
              {record.derived.map((v) => (
                <li key={v.symbol}>
                  {v.name} <em>{v.symbol}</em> = {formatSI(v.value, v.unit)}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function Results({
  doc,
  analysis,
  measured,
}: {
  doc: ManufaktureDocument;
  analysis: DrivetrainAnalysis;
  measured: boolean;
}) {
  const [working, setWorking] = useState(false);
  const inertia = analysis.records.find((r) => r.check === 'drivetrain.inertia');
  return (
    <section className="dt-results" data-testid="dt-results">
      <h3>What it gives</h3>
      {!measured && (
        <p className="field-note" data-testid="dt-not-measured">
          Not regenerated yet: measured inertias appear after the next regen.
        </p>
      )}
      {analysis.problems.length > 0 && (
        <ul className="text-error" data-testid="dt-warnings">
          {analysis.problems.map((p, i) => (
            <li key={i}>{drivetrainProblemText(p)}</li>
          ))}
        </ul>
      )}
      <table className="dt-table">
        <tbody>
          <tr>
            <th>Overall ratio</th>
            <td data-testid="dt-ratio">
              {analysis.ratio !== undefined ? `${number(analysis.ratio)} : 1` : 'not known'}
            </td>
          </tr>
          <tr>
            <th>Overall efficiency</th>
            <td data-testid="dt-efficiency">
              {analysis.efficiency !== undefined ? number(analysis.efficiency) : 'not known'}
            </td>
          </tr>
          <tr>
            <th>Inertia at the motor</th>
            <td data-testid="dt-inertia-motor">
              {analysis.inertiaAtMotor !== undefined
                ? shown(doc, analysis.inertiaAtMotor, 'inertia')
                : 'not known'}
            </td>
          </tr>
          <tr>
            <th>Inertia at the output</th>
            <td data-testid="dt-inertia-output">
              {analysis.inertiaAtOutput !== undefined
                ? shown(doc, analysis.inertiaAtOutput, 'inertia')
                : 'not known'}
            </td>
          </tr>
        </tbody>
      </table>
      <table className="dt-table" data-testid="dt-elements">
        <thead>
          <tr>
            <th>Element</th>
            <th>Speed</th>
            <th>Inertia</th>
            <th>At the motor</th>
            <th>From</th>
          </tr>
        </thead>
        <tbody>
          {analysis.elements.map((e, k) => (
            <tr key={k} data-testid={`dt-element-${k}`}>
              <td>{e.name}</td>
              <td>{speedText(e.n)}</td>
              <td>
                {e.value !== undefined
                  ? shown(doc, e.value, 'inertia')
                  : e.source === 'none'
                    ? '0'
                    : 'not known'}
              </td>
              <td>
                {e.value !== undefined && e.n !== undefined
                  ? shown(doc, e.value / e.n ** 2, 'inertia')
                  : ''}
              </td>
              <td>{sourceText(e)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {inertia !== undefined && (
        <>
          <button
            type="button"
            aria-expanded={working}
            data-testid="dt-working-toggle"
            onClick={() => setWorking((w) => !w)}
          >
            {working ? 'Hide working' : 'Working'}
          </button>
          {working && (
            <div className="dt-working" data-testid="dt-working">
              {analysis.records.map((r) => (
                <div key={r.id}>
                  <p>
                    <strong>{r.title}:</strong>{' '}
                    {r.result !== null ? formatSI(r.result, r.unit) : 'not known'}
                  </p>
                  <p className="field-note">
                    {r.method}. <code>{r.formula}</code>
                  </p>
                  {r.note !== undefined && <p className="field-note">{r.note}</p>}
                  {r.assumptions.length > 0 && (
                    <ul className="dt-notes">
                      {r.assumptions.map((s) => (
                        <li key={s}>{s}</li>
                      ))}
                    </ul>
                  )}
                  {r.sources.length > 0 && (
                    <p className="field-note">
                      Sources: {r.sources.map((s) => `${s.title}, ${s.locator}`).join('; ')}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <TorqueCalc doc={doc} analysis={analysis} />
    </section>
  );
}

export function DrivetrainPanel({
  documents,
  model,
  onClose,
}: {
  documents: DocumentStoreApi;
  model: ModelStore;
  onClose: () => void;
}) {
  const doc = useStore(documents, (s) => s.document);
  const evaluations = useStore(model, (s) => s.evaluations);
  const pending = useStore(model, (s) => s.pending);
  const evaluated = useStore(model, (s) => s.document);
  const drivetrains = mechItems(doc.mech, 'drivetrains');
  const [selected, setSelected] = useState<string | null>(drivetrains[0]?.id ?? null);
  const [message, setMessage] = useState<Message>(null);
  const nextIds = doc.mech?.nextIds ?? {};
  const fresh = newDrivetrainDraft(nextIds);
  const stored = drivetrains.find((d) => d.id === selected);
  const isNew = selected === fresh.id && stored === undefined;
  const draft = stored !== undefined ? drivetrainDraft(stored) : isNew ? fresh : undefined;

  const fromRegen = mechEvaluationOf(evaluations)?.drivetrains?.find((a) => a.id === selected);
  // Regen's result when it was built from this document (after a failed regen the evaluations
  // are an older document's); else read here, with nothing measured, until the next regen.
  const current =
    !pending &&
    evaluated !== null &&
    (evaluated === doc || JSON.stringify(evaluated) === JSON.stringify(doc));
  const analysis =
    stored === undefined
      ? undefined
      : fromRegen !== undefined && current
        ? { analysis: fromRegen, measured: true }
        : {
            analysis: analyseDrivetrain({ document: doc, variables: lookup(doc) }, stored),
            measured: false,
          };

  return (
    <div className="mech-start-backdrop">
      <section
        className="mech-start dt-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dt-title"
        data-testid="dt-panel"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <h2 id="dt-title">Drivetrain</h2>
        <p className="field-note" data-testid="dt-disclaimer">
          {DISCLAIMER_SHORT}
        </p>
        <p className="field-note">
          The chain from the motor to the output, in order. A ratio is input speed over output speed
          (a 5:1 reduction is 5). Inertia comes from what you type, else the motor’s catalog entry,
          else the kernel’s measurement of the instance a stage names. Physical values need their
          units: <code>4e-5 kg*m^2</code>, <code>20 g*cm^2</code>.
        </p>
        <div className="dt-tabs" role="tablist" aria-label="Drivetrains">
          {drivetrains.map((d) => (
            <button
              key={d.id}
              type="button"
              role="tab"
              aria-selected={d.id === selected}
              data-testid={`dt-select-${d.id}`}
              onClick={() => setSelected(d.id)}
            >
              {d.name}
            </button>
          ))}
          <button type="button" data-testid="dt-new" onClick={() => setSelected(fresh.id)}>
            New drivetrain
          </button>
        </div>
        {draft !== undefined && (
          <DrivetrainForm
            // Another drivetrain, or this one changed elsewhere, starts a fresh draft.
            key={`${draft.id}:${JSON.stringify(stored ?? null)}`}
            documents={documents}
            initial={draft}
            isNew={isNew}
            onDone={(m, select) => {
              setMessage(m);
              setSelected(select ?? null);
            }}
          />
        )}
        {analysis !== undefined && (
          <Results doc={doc} analysis={analysis.analysis} measured={analysis.measured} />
        )}
        {message !== null && (
          <p
            className={message.error ? 'text-error' : 'field-note'}
            role={message.error ? 'alert' : 'status'}
            data-testid="dt-message"
          >
            {message.text}
          </p>
        )}
        <div className="dialog-buttons">
          <button type="button" data-testid="dt-close" onClick={onClose}>
            Close
          </button>
        </div>
      </section>
    </div>
  );
}

/** The Drivetrain button of the part studio's toolbar, with the count of drivetrain warnings. */
export function MechDrivetrainButton({
  documents,
  model,
  disabled,
}: {
  documents: DocumentStoreApi;
  model: ModelStore;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const count = useStore(
    model,
    (s) =>
      mechEvaluationOf(s.evaluations)?.drivetrains?.reduce((n, a) => n + a.problems.length, 0) ?? 0,
  );
  return (
    <div className="toolbar-group" role="toolbar" aria-label="Drivetrain">
      <button
        type="button"
        aria-pressed={open}
        disabled={disabled}
        data-testid="dt-open"
        title="The drivetrain: stages from the motor to the output, ratios, efficiencies and reflected inertia"
        onClick={() => setOpen(true)}
      >
        {count > 0 ? `Drivetrain (${count})` : 'Drivetrain'}
      </button>
      {open && (
        <DrivetrainPanel documents={documents} model={model} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}
