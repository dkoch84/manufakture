// The electrical panel (ADR 0017 decision 11, T9.7a): the system's components with their terminals,
// catalog parts and places in the assembly, the connections between terminals, and the harness
// segments with their lengths (typed, or measured between instances plus slack). Below the editor,
// what the stored system gives: what is wrong with it (missing parts and instances, terminals
// nothing connects to), each segment's length and the path of each connection's current, which
// stays "not known" until the simulation (T9.4b) runs. Read from the document here: nothing in it
// needs the kernel. Numbers only: nothing here calls a design safe.

import {
  COMPONENT_ROLES,
  mechItems,
  type ComponentRole,
  type ManufaktureDocument,
} from '@manufakture/core';
import {
  DISCLAIMER_SHORT,
  MEASURED_LENGTH_ASSUMPTION,
  ROLE_DEFS,
  TERMINAL_KIND_TEXT,
  analyseElectrical,
  componentTerminals,
  connectionCurrents,
  electricalProblemText,
  electricalTemplateCommand,
  entryItem,
  resolveEntry,
  roleTakesFamily,
  type ConnectionCurrent,
  type ElectricalAnalysis,
} from '@manufakture/domain-mech';
import {
  formatQuantity,
  resolveDisplayUnit,
  type PhysicalKind,
  type VariableLookup,
} from '@manufakture/units';
import { useRef, useState } from 'react';
import { useStore } from 'zustand';
import { formatLengthIn } from '../../measure/format';
import { evaluateVariables } from '../../sketcher/values';
import type { DocumentStoreApi } from '../../state/document';
import '../mech.css';
import {
  electricalDraft,
  electricalFromDraft,
  withComponent,
  withConnection,
  withSegment,
  withoutComponent,
  withoutConnection,
  type ComponentDraft,
  type ConnectionDraft,
  type ElectricalDraft,
  type SegmentDraft,
} from './draft';
import './electrical.css';

type Message = { error: boolean; text: string } | null;
type Option = { id: string; label: string };

function lookup(doc: ManufaktureDocument): VariableLookup {
  const values = evaluateVariables(doc);
  return (n) => (Object.hasOwn(values, n) ? values[n] : undefined);
}

/** A length in metres in the document's length unit. */
const metres = (doc: ManufaktureDocument, m: number) => formatLengthIn(m * 1000, doc.units);

function shown(doc: ManufaktureDocument, si: number, kind: PhysicalKind): string {
  const unit = resolveDisplayUnit(kind, doc.units.quantities, doc.units.length.unit);
  return formatQuantity(si, kind, { unit });
}

/** The document's purchased uses a component of `role` may use (any role: every use). */
function partOptions(doc: ManufaktureDocument, role?: ComponentRole, family?: string): Option[] {
  return mechItems(doc.mech, 'purchased').flatMap((u) => {
    const e = resolveEntry(doc, u.entry);
    if (e.ok) {
      if (role !== undefined && !roleTakesFamily(role, e.entry.family)) return [];
      if (family !== undefined && e.entry.family !== family) return [];
    }
    const item = e.ok ? entryItem(e.entry) : u.entry.id;
    return [{ id: u.id, label: `${u.name ?? item} (${u.id})` }];
  });
}

function Select({
  label,
  testId,
  value,
  options,
  empty,
  unlisted,
  onChange,
}: {
  label: string;
  testId: string;
  value: string;
  options: readonly Option[];
  empty?: string;
  /** How a value that is not among the options is shown; default: as missing. */
  unlisted?: (value: string) => string;
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
        {!known && <option value={value}>{unlisted?.(value) ?? `${value} (missing)`}</option>}
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

const ROLE_OPTIONS: Option[] = COMPONENT_ROLES.map((r) => ({ id: r, label: ROLE_DEFS[r].text }));

/** The terminals a draft component has now: its typed list, else its defaults. */
function draftTerminals(doc: ManufaktureDocument, c: ComponentDraft): Option[] {
  const typed = c.terminals
    .split(',')
    .map((t) => t.trim().split(/\s+/)[0] ?? '')
    .filter((t) => t !== '');
  if (typed.length > 0) return typed.map((t) => ({ id: t, label: t }));
  const defaults = componentTerminals(doc, {
    id: c.id,
    name: c.name,
    role: c.role,
    ...(c.use !== '' ? { use: c.use } : {}),
  }).terminals;
  return defaults.map((t) => ({ id: t.id, label: t.id === t.name ? t.id : `${t.id} (${t.name})` }));
}

function ComponentRow({
  c,
  i,
  doc,
  instances,
  set,
  remove,
}: {
  c: ComponentDraft;
  i: number;
  doc: ManufaktureDocument;
  instances: Option[];
  set: (next: ComponentDraft) => void;
  remove: () => void;
}) {
  const field = <K extends keyof ComponentDraft>(k: K) => ({
    value: c[k] as string,
    testId: `el-component-${String(k)}-${i}`,
    onChange: (v: string) => set({ ...c, [k]: v }),
  });
  const defaults = draftTerminals(doc, { ...c, terminals: '' })
    .map((t) => t.id)
    .join(', ');
  return (
    <li className="el-item" data-testid={`el-component-${i}`}>
      <div className="el-item-head">
        <em className="el-id">{c.id}</em>
        <button type="button" data-testid={`el-component-remove-${i}`} onClick={remove}>
          Remove
        </button>
      </div>
      <div className="el-fields">
        <Text label="Name" {...field('name')} />
        <Select
          label="Role"
          options={ROLE_OPTIONS}
          {...field('role')}
          onChange={(v) => set({ ...c, role: v as ComponentRole })}
        />
        <Select
          label="Part"
          options={partOptions(doc, c.role)}
          empty="generic"
          // A part the design has that this role does not use is shown as such, not as missing.
          unlisted={(v) => {
            const any = partOptions(doc).find((o) => o.id === v);
            return any !== undefined ? `${any.label} (does not fit the role)` : `${v} (missing)`;
          }}
          {...field('use')}
        />
        <Select label="Instance" options={instances} empty="not placed" {...field('instance')} />
        <Text
          label="Terminals (id kind, ...)"
          hint={defaults === '' ? 'none: type them' : `defaults: ${defaults}`}
          {...field('terminals')}
        />
        <Text label="Always-on load" hint="none" {...field('current')} />
        <Text label="at voltage" hint="optional" {...field('voltage')} />
      </div>
      {c.current.trim() !== '' && (
        <p className="field-note" data-testid={`el-component-load-note-${i}`}>
          A typed load: check it against the part’s datasheet. The cable trainer template’s loads
          are estimates.
        </p>
      )}
    </li>
  );
}

function ConnectionRow({
  c,
  i,
  doc,
  components,
  set,
  remove,
}: {
  c: ConnectionDraft;
  i: number;
  doc: ManufaktureDocument;
  components: ComponentDraft[];
  set: (next: ConnectionDraft) => void;
  remove: () => void;
}) {
  const options = components.map((x) => ({ id: x.id, label: `${x.name} (${x.id})` }));
  const terminals = (id: string) => {
    const comp = components.find((x) => x.id === id);
    return comp === undefined ? [] : draftTerminals(doc, comp);
  };
  const field = <K extends keyof ConnectionDraft>(k: K) => ({
    value: c[k] as string,
    testId: `el-connection-${String(k)}-${i}`,
    onChange: (v: string) => set({ ...c, [k]: v }),
  });
  return (
    <li className="el-item" data-testid={`el-connection-${i}`}>
      <div className="el-item-head">
        <em className="el-id">{c.id}</em>
        <button type="button" data-testid={`el-connection-remove-${i}`} onClick={remove}>
          Remove
        </button>
      </div>
      <div className="el-fields">
        <Select
          label="From"
          options={options}
          empty="choose"
          {...field('fromComponent')}
          onChange={(v) => set({ ...c, fromComponent: v, fromTerminal: '' })}
        />
        <Select
          label="terminal"
          options={terminals(c.fromComponent)}
          empty="choose"
          {...field('fromTerminal')}
        />
        <Select
          label="To"
          options={options}
          empty="choose"
          {...field('toComponent')}
          onChange={(v) => set({ ...c, toComponent: v, toTerminal: '' })}
        />
        <Select
          label="terminal"
          options={terminals(c.toComponent)}
          empty="choose"
          {...field('toTerminal')}
        />
        <Select
          label="Wire"
          options={partOptions(doc, undefined, 'wire')}
          empty="not chosen"
          {...field('wire')}
        />
        <Text label="Colour" hint="red" {...field('colour')} />
        <Text label="Wire number" hint="1" {...field('number')} />
      </div>
    </li>
  );
}

function SegmentRow({
  s,
  i,
  ends,
  set,
  remove,
}: {
  s: SegmentDraft;
  i: number;
  ends: Option[];
  set: (next: SegmentDraft) => void;
  remove: () => void;
}) {
  const field = <K extends keyof SegmentDraft>(k: K) => ({
    value: s[k] as string,
    testId: `el-segment-${String(k)}-${i}`,
    onChange: (v: string) => set({ ...s, [k]: v }),
  });
  return (
    <li className="el-item" data-testid={`el-segment-${i}`}>
      <div className="el-item-head">
        <em className="el-id">{s.id}</em>
        <button type="button" data-testid={`el-segment-remove-${i}`} onClick={remove}>
          Remove
        </button>
      </div>
      <div className="el-fields">
        <Select label="From" options={ends} empty="choose" {...field('from')} />
        <Select label="To" options={ends} empty="choose" {...field('to')} />
        <label className="dialog-field">
          <span>Length</span>
          <select
            data-testid={`el-segment-measured-${i}`}
            value={s.measured ? 'measured' : 'typed'}
            onChange={(e) => set({ ...s, measured: e.target.value === 'measured' })}
          >
            <option value="measured">measured between the ends, plus slack</option>
            <option value="typed">typed</option>
          </select>
        </label>
        {s.measured ? (
          <Text label="Slack" hint="100 mm" {...field('slack')} />
        ) : (
          <Text label="Length" hint="300 mm" {...field('length')} />
        )}
        <Text label="Connections it carries" hint="conn#1, conn#2" {...field('connections')} />
      </div>
    </li>
  );
}

function ElectricalForm({
  documents,
  initial,
  onDone,
  onEdit,
}: {
  documents: DocumentStoreApi;
  initial: ElectricalDraft;
  onDone: (m: Message) => void;
  /** Called on every edit of the draft, so the panel knows there are unsaved edits. */
  onEdit: () => void;
}) {
  const doc = useStore(documents, (s) => s.document);
  const [d, setDraft] = useState(initial);
  const setD: typeof setDraft = (next) => {
    setDraft(next);
    onEdit();
  };
  const [addRole, setAddRole] = useState<ComponentRole>('pack');
  const [problems, setProblems] = useState<string[]>([]);
  const nextIds = doc.mech?.nextIds ?? {};
  const assembly = doc.assemblies?.find((a) => a.id === d.assembly);
  const instances = (assembly?.instances ?? []).map((x) => ({
    id: x.id,
    label: `${x.name} (${x.id})`,
  }));
  const ends: Option[] = [
    ...d.components.map((c) => ({ id: `component:${c.id}`, label: `${c.name} (${c.id})` })),
    ...instances.map((x) => ({ id: `instance:${x.id}`, label: `instance ${x.label}` })),
  ];
  const setItem = <K extends 'components' | 'connections' | 'harness'>(
    k: K,
    i: number,
    next: ElectricalDraft[K][number],
  ) => setD((x) => ({ ...x, [k]: x[k].map((v, j) => (j === i ? next : v)) }));

  const save = () => {
    const current = documents.getState().document;
    const built = electricalFromDraft(d, current.units);
    if (!built.ok) {
      setProblems([built.message]);
      return;
    }
    // Values that do not read are refused; a reference to something that is not there and a
    // terminal nothing connects to are the analysis's warnings, shown with the results.
    const trial = {
      ...current,
      mech: { ...(current.mech ?? { nextIds: {} }), electrical: built.value },
    } as ManufaktureDocument;
    const found = analyseElectrical({ document: trial, variables: lookup(current) })
      .problems.filter((p) => p.kind === 'value')
      .map(electricalProblemText);
    if (found.length > 0) {
      setProblems(found);
      return;
    }
    const done = documents
      .getState()
      .execute({ type: 'setElectrical', electrical: built.value }, 'Electrical system');
    if (!done.ok) {
      setProblems([done.error.message]);
      return;
    }
    setProblems([]);
    onDone({ error: false, text: 'Saved the electrical system.' });
  };

  return (
    <div className="el-form" data-testid="el-form">
      <div className="el-fields">
        <Select
          label="Assembly"
          testId="el-assembly"
          value={d.assembly}
          options={(doc.assemblies ?? []).map((a) => ({ id: a.id, label: a.name }))}
          empty="none"
          onChange={(v) => setD({ ...d, assembly: v })}
        />
      </div>
      <h3>Components</h3>
      <ol className="el-list">
        {d.components.map((c, i) => (
          <ComponentRow
            key={c.id}
            c={c}
            i={i}
            doc={doc}
            instances={instances}
            set={(n) => setItem('components', i, n)}
            remove={() => setD(withoutComponent(d, c.id))}
          />
        ))}
      </ol>
      <div className="el-add">
        <select
          aria-label="Role of the component to add"
          data-testid="el-add-role"
          value={addRole}
          onChange={(e) => setAddRole(e.target.value as ComponentRole)}
        >
          {ROLE_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="el-add-component"
          onClick={() => setD(withComponent(d, addRole, nextIds))}
        >
          Add component
        </button>
      </div>
      <h3>Connections</h3>
      <ol className="el-list">
        {d.connections.map((c, i) => (
          <ConnectionRow
            key={c.id}
            c={c}
            i={i}
            doc={doc}
            components={d.components}
            set={(n) => setItem('connections', i, n)}
            remove={() => setD(withoutConnection(d, c.id))}
          />
        ))}
      </ol>
      <div className="el-add">
        <button
          type="button"
          data-testid="el-add-connection"
          onClick={() => setD(withConnection(d, nextIds))}
        >
          Add connection
        </button>
      </div>
      <h3>Harness</h3>
      <ol className="el-list">
        {d.harness.map((s, i) => (
          <SegmentRow
            key={s.id}
            s={s}
            i={i}
            ends={ends}
            set={(n) => setItem('harness', i, n)}
            remove={() => setD({ ...d, harness: d.harness.filter((_, j) => j !== i) })}
          />
        ))}
      </ol>
      <div className="el-add">
        <button
          type="button"
          data-testid="el-add-segment"
          onClick={() => setD(withSegment(d, nextIds))}
        >
          Add segment
        </button>
      </div>
      {problems.length > 0 && (
        <ul className="text-error" role="alert" data-testid="el-problems">
          {problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      <div className="dialog-buttons">
        <button type="button" className="primary" data-testid="el-save" onClick={save}>
          Save electrical system
        </button>
      </div>
    </div>
  );
}

/** A connection's current in words. */
function currentText(
  doc: ManufaktureDocument,
  c: ConnectionCurrent,
  names: Map<string, string>,
): string {
  if (c.unresolved !== undefined) return `not known: ${c.unresolved}`;
  if (c.path === 'signal') return 'negligible (signal)';
  if (c.steady !== undefined) return `${shown(doc, c.steady, 'current')} (always-on loads)`;
  if (c.cases.length === 0) return 'not known: the design has no load case to simulate';
  return c.cases
    .map((k) => {
      const name = names.get(k.loadCase) ?? k.loadCase;
      if (k.peak === undefined || k.rms === undefined) {
        return `${name}: not known (${k.missing[0] ?? 'missing'})`;
      }
      return `${name}: ${shown(doc, k.peak, 'current')} peak, ${shown(doc, k.rms, 'current')} RMS`;
    })
    .join('; ');
}

const PATH_TEXT: Readonly<Record<ConnectionCurrent['path'], string>> = {
  power: 'power',
  phase: 'motor phase',
  signal: 'signal',
  precharge: 'precharge',
};

function partText(c: ConnectionCurrent, names: Map<string, string>): string {
  return c.contributions
    .map((p) => {
      const who = names.get(p.component) ?? p.component;
      return p.kind === 'load' ? `${who} load` : `${who} ${p.quantity.replace('-', ' ')}`;
    })
    .join(' + ');
}

function Results({ doc, analysis }: { doc: ManufaktureDocument; analysis: ElectricalAnalysis }) {
  const currents = connectionCurrents(
    { document: doc, variables: lookup(doc) },
    undefined,
    analysis,
  );
  const names = new Map<string, string>([
    ...analysis.components.map((c) => [c.id, c.name] as [string, string]),
    ...mechItems(doc.mech, 'loadCases').map((lc) => [lc.id, lc.name] as [string, string]),
  ]);
  const ends = new Map(analysis.connections.map((c) => [c.id, `${c.from.text} to ${c.to.text}`]));
  return (
    <section className="el-results" data-testid="el-results">
      <h3>What it gives</h3>
      {analysis.problems.length > 0 && (
        <ul className="text-error" data-testid="el-warnings">
          {analysis.problems.map((p, i) => (
            <li key={i}>{electricalProblemText(p)}</li>
          ))}
        </ul>
      )}
      <table className="el-table" data-testid="el-terminals">
        <thead>
          <tr>
            <th>Component</th>
            <th>Part</th>
            <th>Terminals</th>
          </tr>
        </thead>
        <tbody>
          {analysis.components.map((c) => (
            <tr key={c.id}>
              <td>
                {c.name} ({c.id}), {ROLE_DEFS[c.role].text.toLowerCase()}
              </td>
              <td>
                {c.entry !== undefined
                  ? `${c.entry.item}${c.entry.verified ? '' : ' (catalog data, unverified)'}`
                  : 'generic'}
              </td>
              <td>
                {c.terminals.map((t) => `${t.id} (${TERMINAL_KIND_TEXT[t.kind]})`).join(', ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {analysis.harness.length > 0 && (
        <>
          <table className="el-table" data-testid="el-harness">
            <thead>
              <tr>
                <th>Segment</th>
                <th>From</th>
                <th>To</th>
                <th>Length</th>
              </tr>
            </thead>
            <tbody>
              {analysis.harness.map((s) => (
                <tr key={s.id} data-testid={`el-harness-${s.id}`}>
                  <td>{s.id}</td>
                  <td>{s.fromText}</td>
                  <td>{s.toText}</td>
                  <td data-testid={`el-length-${s.id}`}>
                    {s.length !== undefined
                      ? s.measured !== undefined
                        ? `${metres(doc, s.length)} (${metres(doc, s.measured.straight!)} straight + ${metres(doc, s.measured.slack!)} slack)`
                        : metres(doc, s.length)
                      : `not known: ${s.missing ?? ''}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {analysis.harness.some((s) => s.measured !== undefined) && (
            <p className="field-note">Measured: {MEASURED_LENGTH_ASSUMPTION}.</p>
          )}
        </>
      )}
      {currents.length > 0 && (
        <>
          <table className="el-table" data-testid="el-currents">
            <thead>
              <tr>
                <th>Connection</th>
                <th>Path</th>
                <th>Carries</th>
                <th>Current</th>
              </tr>
            </thead>
            <tbody>
              {currents.map((c) => (
                <tr key={c.connection} data-testid={`el-current-${c.connection}`}>
                  <td>
                    {c.connection}: {ends.get(c.connection)}
                  </td>
                  <td>{PATH_TEXT[c.path]}</td>
                  <td>{partText(c, names)}</td>
                  <td data-testid={`el-current-value-${c.connection}`}>
                    {currentText(doc, c, names)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="field-note">
            Simulated currents appear once the simulation of each load case has run. A line carrying
            several parts adds their peaks, which is an upper bound when they do not peak together;
            running and charging are taken one at a time.
          </p>
        </>
      )}
    </section>
  );
}

export function ElectricalPanel({
  documents,
  onClose,
}: {
  documents: DocumentStoreApi;
  onClose: () => void;
}) {
  const doc = useStore(documents, (s) => s.document);
  const [message, setMessage] = useState<Message>(null);
  const stored = doc.mech?.electrical;
  const analysis = analyseElectrical({ document: doc, variables: lookup(doc) });
  // Whether the draft has edits not saved yet; a fresh draft (after a save, an undo or the
  // template) has none.
  const formKey = JSON.stringify(stored ?? null);
  // The stored system whose draft has unsaved edits; a fresh draft (after a save, an undo or the
  // template, each of which changes the stored system) has none.
  const edited = useRef<string | null>(null);

  const template = () => {
    if (
      edited.current === formKey &&
      !window.confirm(
        'Adding the template starts the editor again from the saved system, so your unsaved edits are lost. Add it anyway?',
      )
    ) {
      return;
    }
    const current = documents.getState().document;
    const t = electricalTemplateCommand(current);
    if (!t.ok) {
      setMessage({ error: true, text: t.message });
      return;
    }
    const done = documents.getState().execute(t.command, t.label);
    setMessage(
      done.ok
        ? {
            error: false,
            text: 'Added the cable trainer’s electrical system. Its loads are estimates: replace them.',
          }
        : { error: true, text: done.error.message },
    );
  };

  return (
    <div className="mech-start-backdrop">
      <section
        className="mech-start el-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="el-title"
        data-testid="el-panel"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <h2 id="el-title">Electrical system</h2>
        <p className="field-note" data-testid="el-disclaimer">
          {DISCLAIMER_SHORT}
        </p>
        <p className="field-note">
          Components with their terminals, the connections between terminals, and the harness that
          carries them. A component takes its role’s terminals unless you type its own as{' '}
          <code>id kind</code> pairs (<code>vin power, gnd ground, sda signal</code>); keep the
          default ids where they apply, as connections and schematics refer to them. A measured
          segment is the straight line between its ends’ instances plus the slack you type for the
          route. Currents need units: <code>80 mA</code>.
        </p>
        <div className="dialog-buttons el-template">
          <button type="button" data-testid="el-template" onClick={template}>
            Add the cable trainer’s system
          </button>
        </div>
        <ElectricalForm
          // A change of the stored system (a save, an undo, the template) starts a fresh draft.
          key={formKey}
          documents={documents}
          initial={electricalDraft(stored)}
          onDone={setMessage}
          onEdit={() => {
            edited.current = formKey;
          }}
        />
        {stored !== undefined && <Results doc={doc} analysis={analysis} />}
        {message !== null && (
          <p
            className={message.error ? 'text-error' : 'field-note'}
            role={message.error ? 'alert' : 'status'}
            data-testid="el-message"
          >
            {message.text}
          </p>
        )}
        <div className="dialog-buttons">
          <button type="button" data-testid="el-close" onClick={onClose}>
            Close
          </button>
        </div>
      </section>
    </div>
  );
}

/** The Electrical button of the part studio's toolbar, with the count of problems. */
export function MechElectricalButton({
  documents,
  disabled,
}: {
  documents: DocumentStoreApi;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const doc = useStore(documents, (s) => s.document);
  const count =
    doc.mech?.electrical === undefined
      ? 0
      : analyseElectrical({ document: doc, variables: lookup(doc) }).problems.length;
  return (
    <div className="toolbar-group" role="toolbar" aria-label="Electrical system">
      <button
        type="button"
        aria-pressed={open}
        disabled={disabled}
        data-testid="el-open"
        title="The electrical system: components, terminals, connections and the harness"
        onClick={() => setOpen(true)}
      >
        {count > 0 ? `Electrical (${count})` : 'Electrical'}
      </button>
      {open && <ElectricalPanel documents={documents} onClose={() => setOpen(false)} />}
    </div>
  );
}
