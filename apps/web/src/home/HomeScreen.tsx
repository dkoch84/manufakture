// The home screen: the documents stored in this browser, most recent first, with new, open,
// rename, duplicate, export (.mfk), delete and import (file picker, or a file dropped anywhere
// on the page), and how much storage they use.

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatBytes } from '../io/files';
import type { BackendKind } from '../persistence/backend';
import type { DocumentSummary } from '../persistence/library';
import type { StorageInfo } from '../persistence/storage';
import type { ActionOutcome, HomeActions } from './actions';
import './home.css';

export interface HomeScreenProps {
  actions: HomeActions;
  /** Where documents are stored. */
  kind: BackendKind;
  /** The open document's id, and its name for the Back button. */
  current: { id: string; name: string } | null;
  onClose(): void;
  storage?: () => Promise<StorageInfo>;
  /** Ask the browser to keep this site's data; resolves to whether it will. */
  onPersist?: () => Promise<boolean>;
  /** A message from outside (a dropped file). */
  outcome?: ActionOutcome | null;
  /** Changes when the list must be read again (a file dropped and imported). */
  revision?: number;
}

const WHERE: Record<BackendKind, string> = {
  opfs: 'Documents are stored in this browser (Origin Private File System).',
  indexeddb: 'Documents are stored in this browser (IndexedDB).',
  memory: 'This browser offers no storage: documents are lost when the page is closed or reloaded.',
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

export function HomeScreen({
  actions,
  kind,
  current,
  onClose,
  storage,
  onPersist,
  outcome: given = null,
  revision = 0,
}: HomeScreenProps) {
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(given);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [refresh, setRefresh] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  // A new message from outside replaces the shown one.
  const [lastGiven, setLastGiven] = useState(given);
  if (given !== lastGiven) {
    setLastGiven(given);
    setOutcome(given);
  }
  useEffect(() => {
    let live = true;
    void actions.list().then((d) => live && setDocs(d));
    void storage?.().then((i) => live && setInfo(i));
    return () => {
      live = false;
    };
  }, [actions, storage, refresh, revision]);

  const run = useCallback(async (action: () => Promise<ActionOutcome>) => {
    setBusy(true);
    try {
      setOutcome(await action());
    } catch (e) {
      setOutcome({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      setRefresh((n) => n + 1);
    }
  }, []);

  const submitRename = () => {
    if (!renaming) return;
    const { id, name } = renaming;
    setRenaming(null);
    if (name.trim().length > 0) void run(() => actions.rename(id, name));
  };

  return (
    <div className="home" data-testid="home">
      <header className="home-header">
        <h1>manufakture</h1>
        <div className="home-actions">
          <button type="button" disabled={busy} onClick={() => void run(actions.create)}>
            New document
          </button>
          <button type="button" disabled={busy} onClick={() => input.current?.click()}>
            Import .mfk
          </button>
          <input
            ref={input}
            type="file"
            accept=".mfk"
            hidden
            data-testid="mfk-input"
            aria-label="Import a manufakture file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              void run(() => actions.importPicked(file));
            }}
          />
          {current && (
            <button type="button" onClick={onClose} data-testid="home-back">
              Back to {current.name}
            </button>
          )}
        </div>
      </header>
      <main className="home-main">
        <h2>Documents</h2>
        {outcome && (
          <p
            className={outcome.ok ? 'home-status' : 'home-status home-error'}
            role={outcome.ok ? 'status' : 'alert'}
            data-testid="home-status"
          >
            {outcome.message}
            {outcome.unsaved && (
              <>
                {' '}
                <button
                  type="button"
                  disabled={busy}
                  data-testid="retry-save"
                  onClick={() => void run(actions.retrySave)}
                >
                  Save again
                </button>{' '}
                <button
                  type="button"
                  disabled={busy}
                  data-testid="export-current"
                  title="Download the open document, unsaved changes included, as a .mfk file"
                  onClick={() => void run(actions.exportCurrent)}
                >
                  Export the open document
                </button>
              </>
            )}
          </p>
        )}
        {docs === null ? (
          <p aria-busy="true">Reading documents...</p>
        ) : docs.length === 0 ? (
          <p className="home-empty">
            No saved documents yet. Start with <strong>New document</strong>, or import a .mfk file
            (you can also drop one on this page).
          </p>
        ) : (
          <table className="home-list" aria-label="Documents">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Saved</th>
                <th scope="col">Size</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} data-testid={`doc-${d.id}`} aria-current={d.id === current?.id}>
                  <td>
                    {renaming?.id === d.id ? (
                      <input
                        autoFocus
                        aria-label="New name"
                        data-testid="rename-input"
                        value={renaming.name}
                        maxLength={200}
                        onChange={(e) => setRenaming({ id: d.id, name: e.target.value })}
                        onBlur={submitRename}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') submitRename();
                          if (e.key === 'Escape') setRenaming(null);
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="home-open"
                        disabled={busy || d.damaged !== undefined}
                        onClick={() => void run(() => actions.open(d.id))}
                        title={d.damaged ?? `Open ${d.name}`}
                      >
                        {d.name}
                      </button>
                    )}
                    {d.id === current?.id && <span className="home-tag">open</span>}
                    {d.damaged && <span className="home-tag home-error">damaged: {d.damaged}</span>}
                  </td>
                  <td>{formatDate(d.savedAt)}</td>
                  <td>{d.damaged ? '' : formatBytes(d.bytes)}</td>
                  <td className="home-row-actions">
                    {confirming === d.id ? (
                      <>
                        <span>Delete {d.name}?</span>
                        <button
                          type="button"
                          className="home-danger"
                          disabled={busy}
                          onClick={() => {
                            setConfirming(null);
                            void run(() => actions.remove(d.id));
                          }}
                        >
                          Delete
                        </button>
                        <button type="button" onClick={() => setConfirming(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={busy || d.damaged !== undefined}
                          onClick={() => setRenaming({ id: d.id, name: d.name })}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          disabled={busy || d.damaged !== undefined}
                          onClick={() => void run(() => actions.duplicate(d.id))}
                        >
                          Duplicate
                        </button>
                        <button
                          type="button"
                          disabled={busy || d.damaged !== undefined}
                          title="Download as a .mfk file"
                          onClick={() => void run(() => actions.exportFile(d.id))}
                        >
                          Export
                        </button>
                        <button type="button" disabled={busy} onClick={() => setConfirming(d.id)}>
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <footer className="home-storage" data-testid="storage-info">
          <p className={kind === 'memory' ? 'home-error' : undefined}>{WHERE[kind]}</p>
          {info && info.usage !== null && (
            <p>
              Using {formatBytes(info.usage)}
              {info.quota !== null ? ` of ${formatBytes(info.quota)} available` : ''}.
            </p>
          )}
          {kind !== 'memory' && info && info.persisted !== null && (
            <p>
              {info.persisted
                ? 'The browser keeps these documents even when space runs low.'
                : 'The browser may clear these documents when space runs low.'}{' '}
              {!info.persisted && onPersist && (
                <button
                  type="button"
                  onClick={() => void onPersist().then(() => setRefresh((n) => n + 1))}
                >
                  Keep my documents
                </button>
              )}
            </p>
          )}
        </footer>
      </main>
    </div>
  );
}
