// The Tools dialog (M5 plan, T5.3a; T5.1d): the tools in the document (edit their sizes and feed
// presets, delete one no operation cuts with, make a new one) and the libraries to copy from: the
// built-in Carbide 3D tools and the user's own library in the browser's storage. Numbers that were
// not checked against their source are marked (`unverifiedToolFields`), on document tools copied
// from a built-in one too (by their `source`). Copying a library tool into the document is one
// `addCamTool`; the copy is independent of the library afterwards.
//
// The user library can be wedged: when its files cannot be read (a newer build wrote them, or they
// are damaged) nothing is ever saved over them. The dialog says so, says how many files are kept
// aside, and offers Reset library, which sets the files aside and starts an empty library.

import type { CamTool, Command, ManufaktureDocument } from '@manufakture/core';
import {
  BUILTIN_LIBRARY_ID,
  BUILTIN_TOOLS,
  findFeedCategory,
  type LibraryTool,
} from '@manufakture/cam/library';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { ExpressionField } from '../components/ExpressionField';
import { downloadBytes } from '../io/files';
import type { DocumentStoreApi } from '../state/document';
import { deleteToolCommand } from './commands';
import { MAX_REJECTED, USER_LIBRARY_ID, type ToolLibraryStore } from './library/store';
import { useToolInDocument as toolIntoDocument } from './library/use-in-document';
import {
  PRESET_KEYS,
  PRESET_SPECS,
  TOOL_KIND_LABELS,
  buildTool,
  newToolForm,
  toolFields,
  toolFormOf,
  unverifiedText,
  type ToolForm,
  type ToolKindId,
} from './toolForms';
import { camVariables, validator } from './values';

export interface ToolsDialogProps {
  documents: DocumentStoreApi;
  /** Opens the user's tool library; null: no user library (tests, no storage). */
  openLibrary: (() => Promise<ToolLibraryStore>) | null;
  onClose: () => void;
}

export function ToolsDialog({ documents, openLibrary, onClose }: ToolsDialogProps) {
  const doc = useStore(documents, (s) => s.document);
  const [editing, setEditing] = useState<{ toolId: string | null } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const execute = (command: Command, label: string) => {
    const r = documents.getState().execute(command, label);
    setMessage(r.ok ? null : r.error.message);
    return r.ok;
  };

  return (
    <aside
      className="selection-panel cam-tools"
      role="dialog"
      aria-label="Tools"
      data-testid="cam-tools-dialog"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (editing) setEditing(null);
          else onClose();
        }
      }}
    >
      <div className="cam-head">
        <h2>Tools</h2>
        <button type="button" data-testid="cam-tools-close" onClick={onClose}>
          Close
        </button>
      </div>
      {message && (
        <p className="field-error" role="alert" data-testid="cam-tools-message">
          {message}
        </p>
      )}
      {editing ? (
        <ToolEditor
          key={editing.toolId ?? 'new'}
          doc={doc}
          tool={
            editing.toolId === null ? undefined : doc.cam.tools.find((t) => t.id === editing.toolId)
          }
          editsExisting={editing.toolId !== null}
          onCancel={() => setEditing(null)}
          onApply={(command, label) => {
            if (execute(command, label)) setEditing(null);
          }}
        />
      ) : (
        <>
          <h3>In this document</h3>
          {doc.cam.tools.length === 0 ? (
            <p className="field-note" data-testid="cam-tools-empty">
              No tools yet. Copy one from a library below, or make a new one.
            </p>
          ) : (
            <ul className="cam-tool-list" data-testid="cam-doc-tools">
              {doc.cam.tools.map((t) => (
                <li key={t.id} data-testid={`cam-tool-${t.id}`}>
                  <span className="cam-tool-name">
                    {t.number !== undefined ? `#${t.number} ` : ''}
                    {t.name}
                  </span>
                  <span className="cam-tool-detail">
                    {TOOL_KIND_LABELS[t.kind]}, {t.diameter.source}, {t.flutes} flute
                    {t.flutes === 1 ? '' : 's'}
                  </span>
                  {sourceUnverified(t) && (
                    <span className="cam-unverified" data-testid={`cam-doc-unverified-${t.id}`}>
                      Copied from a built-in tool. {sourceUnverified(t)}
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={`Edit ${t.name}`}
                    onClick={() => setEditing({ toolId: t.id })}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${t.name}`}
                    data-testid={`cam-tool-delete-${t.id}`}
                    onClick={() => execute(deleteToolCommand(t.id), `Delete tool ${t.name}`)}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            data-testid="cam-tool-new"
            onClick={() => setEditing({ toolId: null })}
          >
            New tool
          </button>
          <LibraryList
            title="Built-in tools (Carbide 3D)"
            testId="cam-builtin-tools"
            tools={BUILTIN_TOOLS}
            onUse={(t) =>
              execute(
                toolIntoDocument(documents.getState().document, t, BUILTIN_LIBRARY_ID),
                `Add tool ${t.name}`,
              )
            }
          />
          {openLibrary && (
            <UserLibrary
              openLibrary={openLibrary}
              onUse={(t) =>
                execute(
                  toolIntoDocument(documents.getState().document, t, USER_LIBRARY_ID),
                  `Add tool ${t.name}`,
                )
              }
            />
          )}
        </>
      )}
    </aside>
  );
}

/** Built-in tools by id (ids in a document's `source` are data: a Map, not an object lookup). */
const BUILTIN_BY_ID: ReadonlyMap<string, LibraryTool> = new Map(
  BUILTIN_TOOLS.map((t) => [t.id, t]),
);

/**
 * The unverified fields of the built-in tool a document tool was copied from (its `source`), as
 * text; null for a tool from elsewhere, or one whose built-in is fully checked.
 */
function sourceUnverified(tool: CamTool): string | null {
  if (tool.source?.library !== BUILTIN_LIBRARY_ID) return null;
  const builtin = BUILTIN_BY_ID.get(tool.source.id);
  return builtin ? unverifiedText(builtin) : null;
}

function LibraryList({
  title,
  testId,
  tools,
  onUse,
}: {
  title: string;
  testId: string;
  tools: readonly LibraryTool[];
  onUse: (tool: LibraryTool) => void;
}) {
  return (
    <details className="cam-library" data-testid={testId} open>
      <summary>{title}</summary>
      {tools.length === 0 ? (
        <p className="field-note">No tools.</p>
      ) : (
        <ul className="cam-tool-list">
          {tools.map((t) => {
            const unverified = unverifiedText(t);
            return (
              <li key={t.id} data-testid={`cam-library-tool-${t.id}`}>
                <span className="cam-tool-name">
                  {t.vendor ? `#${t.vendor.number} ` : ''}
                  {t.name}
                </span>
                <span className="cam-tool-detail">
                  {TOOL_KIND_LABELS[t.kind]}, {t.diameter} {t.unit}
                </span>
                {unverified && (
                  <span className="cam-unverified" data-testid={`cam-unverified-${t.id}`}>
                    {unverified}
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`Use ${t.name} in this document`}
                  data-testid={`cam-use-${t.id}`}
                  onClick={() => onUse(t)}
                >
                  Use in document
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}

type LibraryState =
  | { state: 'loading' }
  | {
      state: 'ready';
      store: ToolLibraryStore;
      tools: readonly LibraryTool[] | null;
      error: string | null;
      keptAside: number;
    };

function UserLibrary({
  openLibrary,
  onUse,
}: {
  openLibrary: () => Promise<ToolLibraryStore>;
  onUse: (tool: LibraryTool) => void;
}) {
  const [lib, setLib] = useState<LibraryState>({ state: 'loading' });
  const [revision, setRevision] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const store = await openLibrary();
        const [list, kept] = await Promise.all([store.list(), store.keptAside()]);
        if (!live) return;
        setLib({
          state: 'ready',
          store,
          tools: list.ok ? list.value : null,
          error: list.ok ? null : list.error,
          keptAside: kept.ok ? kept.value : 0,
        });
      } catch (e) {
        if (live) setNote(`The tool library could not be opened: ${String(e)}`);
      }
    })();
    return () => {
      live = false;
    };
  }, [openLibrary, revision]);

  if (lib.state === 'loading') {
    return (
      <p className="field-note" data-testid="cam-user-library-loading">
        {note ?? 'Opening your tool library...'}
      </p>
    );
  }
  const reload = () => setRevision((r) => r + 1);
  return (
    <section className="cam-user-library" data-testid="cam-user-library">
      {lib.tools ? (
        <LibraryList title="Your library" testId="cam-user-tools" tools={lib.tools} onUse={onUse} />
      ) : (
        <p className="field-error" role="alert" data-testid="cam-user-library-error">
          {lib.error}
        </p>
      )}
      {lib.keptAside > 0 && (
        <p className="field-note" data-testid="cam-kept-aside">
          {lib.keptAside} library {lib.keptAside === 1 ? 'file is' : 'files are'} kept aside, by a
          reset or because this version could not read {lib.keptAside === 1 ? 'it' : 'them'}.
        </p>
      )}
      <div className="cam-library-actions">
        <label className="cam-import">
          Import...
          <input
            type="file"
            accept=".json,application/json"
            data-testid="cam-library-import"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              void lib.store.importJson(file).then((r) => {
                setNote(
                  r.ok
                    ? `Imported ${r.value.added} new and ${r.value.replaced} replaced.`
                    : r.error,
                );
                reload();
              });
            }}
          />
        </label>
        <button
          type="button"
          data-testid="cam-library-export"
          disabled={!lib.tools}
          onClick={() =>
            void lib.store.exportJson().then((r) => {
              if (!r.ok) setNote(r.error);
              else
                downloadBytes(new TextEncoder().encode(r.value), 'tools.json', 'application/json');
            })
          }
        >
          Export
        </button>
        {confirmReset ? (
          <span className="cam-confirm" role="alert" data-testid="cam-library-reset-confirm">
            Start an empty library? Its files are set aside under other names, not deleted; but only
            the newest {MAX_REJECTED} set-aside files are kept, so older ones are removed.
            <button
              type="button"
              data-testid="cam-library-reset-yes"
              onClick={() => {
                setConfirmReset(false);
                void lib.store.reset().then((r) => {
                  setNote(
                    r.ok
                      ? `Started an empty library; ${r.value.keptAside} ${r.value.keptAside === 1 ? 'file' : 'files'} kept aside.`
                      : r.error,
                  );
                  reload();
                });
              }}
            >
              Reset
            </button>
            <button type="button" onClick={() => setConfirmReset(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            data-testid="cam-library-reset"
            title="Set the library's files aside and start an empty one"
            onClick={() => setConfirmReset(true)}
          >
            Reset library
          </button>
        )}
      </div>
      {note && (
        <p className="field-note" role="status" data-testid="cam-library-note">
          {note}
        </p>
      )}
    </section>
  );
}

function ToolEditor({
  doc,
  tool,
  editsExisting,
  onCancel,
  onApply,
}: {
  doc: ManufaktureDocument;
  tool: CamTool | undefined;
  /** The editor opened on a document tool: if that tool is gone, OK must not add a new one. */
  editsExisting: boolean;
  onCancel: () => void;
  onApply: (command: Command, label: string) => void;
}) {
  const [form, setForm] = useState<ToolForm>(() => (tool ? toolFormOf(tool) : newToolForm()));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const units = doc.units;
  const variables = useMemo(() => camVariables(doc), [doc]);
  const names = useMemo(() => doc.variables.map((v) => v.name), [doc]);
  const set = <K extends keyof ToolForm>(key: K, value: ToolForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const fields = toolFields(form.kind);
  const apply = () => {
    if (editsExisting && !tool) {
      setErrors({ form: 'The tool is gone (undone or deleted meanwhile).' });
      return;
    }
    const r = buildTool(form, {
      doc,
      ...(tool ? { existing: tool } : {}),
      units,
      variables,
    });
    if (!r.ok) setErrors(r.errors);
    else onApply(r.command, r.label);
  };
  const text = (key: 'number' | 'flutes', label: string) => (
    <div className="dialog-field">
      <label>
        {label}
        <input
          type="text"
          inputMode="numeric"
          data-testid={`cam-tool-${key}`}
          value={form[key]}
          aria-invalid={errors[key] !== undefined}
          onChange={(e) => set(key, e.target.value)}
        />
      </label>
      {errors[key] && <span className="field-error">{errors[key]}</span>}
    </div>
  );
  return (
    <form
      className="cam-tool-editor"
      data-testid="cam-tool-editor"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <h3>{tool ? `Edit ${tool.name}` : editsExisting ? 'Edit tool' : 'New tool'}</h3>
      {tool?.source && (
        <p className="field-note">
          Copied from the {tool.source.library === BUILTIN_LIBRARY_ID ? 'built-in' : 'your'} library
          ({tool.source.id}); editing it here does not change the library.
        </p>
      )}
      <div className="dialog-field">
        <label>
          Name
          <input
            type="text"
            data-testid="cam-tool-name"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
          />
        </label>
        {errors.name && <span className="field-error">{errors.name}</span>}
      </div>
      <div className="dialog-field">
        <label>
          Kind
          <select
            data-testid="cam-tool-kind"
            value={form.kind}
            onChange={(e) => set('kind', e.target.value as ToolKindId)}
          >
            {Object.entries(TOOL_KIND_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {text('number', 'Tool number (optional)')}
      <ExpressionField
        label="Diameter"
        testId="cam-tool-diameter"
        value={form.diameter}
        kind="length"
        units={units}
        variables={variables}
        names={names}
        validate={validator('positive')}
        error={errors.diameter}
        onChange={(v) => set('diameter', v)}
      />
      <ExpressionField
        label="Flute length"
        testId="cam-tool-fluteLength"
        value={form.fluteLength}
        kind="length"
        units={units}
        variables={variables}
        names={names}
        validate={validator('positive')}
        error={errors.fluteLength}
        onChange={(v) => set('fluteLength', v)}
      />
      {text('flutes', 'Flutes')}
      {fields.includes('cornerRadius') && (
        <ExpressionField
          label="Corner radius"
          testId="cam-tool-cornerRadius"
          value={form.cornerRadius}
          kind="length"
          units={units}
          variables={variables}
          names={names}
          validate={validator('positive')}
          error={errors.cornerRadius}
          onChange={(v) => set('cornerRadius', v)}
        />
      )}
      {fields.includes('angle') && (
        <ExpressionField
          label={form.kind === 'drill' ? 'Point angle (optional)' : 'Included angle'}
          testId="cam-tool-angle"
          value={form.angle}
          kind="angle"
          units={units}
          variables={variables}
          names={names}
          error={errors.angle}
          onChange={(v) => set('angle', v)}
        />
      )}
      {fields.includes('tipDiameter') && (
        <ExpressionField
          label="Tip diameter (optional)"
          testId="cam-tool-tipDiameter"
          value={form.tipDiameter}
          kind="length"
          units={units}
          variables={variables}
          names={names}
          validate={validator('nonNegative')}
          error={errors.tipDiameter}
          onChange={(v) => set('tipDiameter', v)}
        />
      )}
      {form.presets.length > 0 && <h4>Feeds and speeds per material</h4>}
      {form.presets.map((p, i) => (
        <fieldset
          key={`${p.material}/${i}`}
          className="cam-preset"
          data-testid={`cam-preset-${p.material}`}
        >
          <legend>{findFeedCategory(p.material)?.name ?? p.material}</legend>
          {PRESET_KEYS.map((k) => (
            <ExpressionField
              key={k}
              label={PRESET_SPECS[k].label}
              testId={`cam-preset-${p.material}-${k}`}
              value={p.values[k]}
              kind={PRESET_SPECS[k].kind}
              units={units}
              variables={variables}
              names={names}
              validate={validator(PRESET_SPECS[k].rule)}
              error={errors[`presets.${i}.${k}`]}
              onChange={(v) =>
                setForm((f) => ({
                  ...f,
                  presets: f.presets.map((x, j) =>
                    j === i ? { ...x, values: { ...x.values, [k]: v } } : x,
                  ),
                }))
              }
            />
          ))}
        </fieldset>
      ))}
      {errors.form && (
        <p className="field-error" role="alert" data-testid="cam-tool-form-error">
          {errors.form}
        </p>
      )}
      <div className="dialog-buttons">
        <button type="submit" className="primary" data-testid="cam-tool-ok">
          OK
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
