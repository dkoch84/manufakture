// The Sync button and its panel (T7.1d; docs/user/sync.md): the status of the open document
// (synced, pending n, offline, another tab, refused), its Sync switch, the server (the same
// setting as the share links: address and token, kept in this browser), the documents on the
// server to open here, and the notices for changes a rebase could not keep, each naming the
// branch the work was kept on. When the server needs a newer app, `UpdateNeeded` says so.

import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { UpdateNeeded } from '../pwa/UpdateNeeded';
import {
  ShareError,
  checkServerUrl,
  checkToken,
  forgetServerSettings,
  loadServerSettings,
  saveServerSettings,
  type ServerSettings,
} from '../sharing/client';
import type { ServerDocument } from './api';
import type { SyncController } from './controller';
import { statusDetail, statusText } from './status';
import './sync.css';

export interface SyncPanelProps {
  controller: SyncController;
  /** Opens document `id` (default: loads the page with `?doc=<id>`, on its main branch). */
  openDocument?: (id: string) => void;
  /** For tests. */
  storage?: Storage;
  appHostname?: string;
}

function defaultOpen(id: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('doc', id);
  url.searchParams.delete('branch');
  url.searchParams.delete('part');
  window.location.assign(url.toString());
}

export function SyncPanel({
  controller,
  openDocument = defaultOpen,
  storage,
  appHostname,
}: SyncPanelProps) {
  const store = storage ?? localStorage;
  const host = appHostname ?? location.hostname;
  const state = useStore(controller.state);
  const [open, setOpen] = useState(false);
  const [server, setServer] = useState<ServerSettings | null>(() =>
    loadServerSettings(store, host),
  );
  const [urlInput, setUrlInput] = useState(server?.url ?? '');
  const [tokenInput, setTokenInput] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<ServerDocument[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  // What the switch was set to, shown while switching (sync starts or stops asynchronously).
  const [wanted, setWanted] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // A press anywhere else closes the panel.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node | null)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  const saveServer = () => {
    try {
      const s = {
        url: checkServerUrl(urlInput, host),
        token: tokenInput.trim() === '' && server ? server.token : checkToken(tokenInput),
      };
      saveServerSettings(s, store);
      setServer(s);
      setTokenInput('');
      setFormError(null);
      void controller.refresh();
    } catch (e) {
      setFormError(e instanceof ShareError ? e.message : 'The server could not be saved.');
    }
  };

  const forget = () => {
    forgetServerSettings(store);
    setServer(null);
    setDocuments(null);
    setUrlInput('');
    void controller.refresh();
  };

  const listDocuments = async () => {
    setListError(null);
    try {
      setDocuments(await controller.listServerDocuments());
    } catch (e) {
      setListError(e instanceof Error ? e.message : 'The list could not be read.');
    }
  };

  const openFromServer = async (id: string) => {
    const opened = await controller.openFromServer(id);
    if (opened !== null) openDocument(opened);
  };

  const status = state.status;
  const detail = statusDetail(status);
  const refused = state.notices.length > 0;

  return (
    <div className="sketch-menu sync" ref={root}>
      <button
        type="button"
        className="sync-button"
        aria-haspopup="dialog"
        data-testid="sync-button"
        data-state={status.kind}
        aria-expanded={open}
        title="Sync this document with your server"
        onClick={() => {
          // The server setting may change in the Share panel too: read it again on opening.
          if (!open) setServer(loadServerSettings(store, host));
          setOpen((o) => !o);
        }}
      >
        <span className={`sync-dot sync-dot-${status.kind}`} aria-hidden="true" />
        {statusText(status)}
        {refused && (
          <span className="sync-badge" data-testid="sync-notice-count">
            {state.notices.length}
          </span>
        )}
      </button>
      {open && (
        <div className="sync-panel" role="dialog" aria-label="Sync" data-testid="sync-panel">
          <h4>Sync</h4>
          <p data-testid="sync-status" data-state={status.kind}>
            {statusText(status)}
          </p>
          {detail && <p className="sync-detail">{detail}</p>}
          {status.kind === 'update-app' && <UpdateNeeded reason="sync-protocol" />}

          {server === null ? (
            <div className="sync-server">
              <p>Sync goes through your own manufakture server (the same one share links use).</p>
              <label>
                Server address
                <input
                  data-testid="sync-server-url"
                  value={urlInput}
                  placeholder="https://manufakture.example.org"
                  onChange={(e) => setUrlInput(e.target.value)}
                />
              </label>
              <label>
                Token
                <input
                  data-testid="sync-token"
                  type="password"
                  autoComplete="off"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                />
              </label>
              <button type="button" data-testid="sync-save-server" onClick={saveServer}>
                Save server
              </button>
              {formError && <p className="sync-error">{formError}</p>}
            </div>
          ) : (
            <>
              <div className="sync-server-line">
                <span title={server.url}>{server.url}</span>
                <button type="button" onClick={forget}>
                  Forget
                </button>
              </div>
              <label className="sync-switch">
                <input
                  type="checkbox"
                  data-testid="sync-switch"
                  checked={state.busy ? wanted : state.enabled}
                  disabled={state.busy}
                  onChange={(e) => {
                    setWanted(e.target.checked);
                    void (e.target.checked ? controller.enable() : controller.disable());
                  }}
                />
                Sync this document
              </label>
              <div className="sync-documents">
                <button
                  type="button"
                  data-testid="sync-list-documents"
                  disabled={state.busy}
                  onClick={() => void listDocuments()}
                >
                  Documents on the server
                </button>
                {listError && <p className="sync-error">{listError}</p>}
                {documents && documents.length === 0 && <p>There are none yet.</p>}
                {documents && documents.length > 0 && (
                  <ul>
                    {documents.map((d) => (
                      <li key={d.id}>
                        <span>{d.name}</span>
                        <button
                          type="button"
                          data-testid="sync-open-document"
                          data-document={d.id}
                          disabled={state.busy || d.id === state.documentId}
                          onClick={() => void openFromServer(d.id)}
                        >
                          {d.id === state.documentId ? 'Open' : 'Open here'}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
          {state.error && (
            <p className="sync-error" data-testid="sync-error">
              {state.error}
            </p>
          )}
          {state.notices.length > 0 && (
            <ul className="sync-notices">
              {state.notices.map((n) => (
                <li key={n.id} data-testid="sync-notice">
                  <span>{n.text}</span>
                  {n.branch && (
                    <span data-testid="sync-notice-branch">
                      {' '}
                      Your work before it is kept on the branch "{n.branch.name}".
                    </span>
                  )}
                  {n.branchError && (
                    <span className="sync-error">
                      {' '}
                      It could not be kept as a branch: {n.branchError}
                    </span>
                  )}
                  <button type="button" onClick={() => controller.dismissNotice(n.id)}>
                    Dismiss
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
