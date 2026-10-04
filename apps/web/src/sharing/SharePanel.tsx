import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ShareError,
  checkServerUrl,
  checkToken,
  createShare,
  forgetServerSettings,
  listShares,
  loadServerSettings,
  revokeShare,
  saveServerSettings,
  shareLink,
  type ServerSettings,
  type ShareInfo,
  type ShareLimits,
} from './client';
import './sharing.css';

/** A bundle of what is shown, or why there is none. */
export type BundleResult =
  { ok: true; bytes: Uint8Array; name: string } | { ok: false; message: string };

export interface SharePanelProps {
  disabled?: boolean;
  /** Publishes what is shown as a `.mfkview`, with the document inside when `includeSource`. */
  makeBundle: (includeSource: boolean) => Promise<BundleResult>;
  /** The viewer page the links open. */
  viewerUrl: string;
  /** For tests. */
  storage?: Storage;
  fetch?: typeof fetch;
  appHostname?: string;
}

/** The expiry choices, in days; the server's default is added when it is not one of them. */
const EXPIRY_DAYS = [1, 7, 30, 90, 365];

function sizeText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function dateText(iso: string | null): string {
  if (iso === null) return 'never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '?' : d.toLocaleDateString();
}

function messageOf(e: unknown): string {
  return e instanceof ShareError ? e.message : 'Something went wrong while sharing.';
}

/**
 * The Share button and its panel: the server to share through (saved in this browser), a new
 * link for what is shown, and the active links with Revoke.
 */
export function SharePanel({
  disabled = false,
  makeBundle,
  viewerUrl,
  storage,
  fetch: doFetch,
  appHostname,
}: SharePanelProps) {
  const store = storage ?? localStorage;
  const host = appHostname ?? location.hostname;
  const [open, setOpen] = useState(false);
  const [server, setServer] = useState<ServerSettings | null>(() =>
    loadServerSettings(store, host),
  );
  const [editing, setEditing] = useState(server === null);
  const [urlInput, setUrlInput] = useState(server?.url ?? '');
  const [tokenInput, setTokenInput] = useState('');
  const [shares, setShares] = useState<ShareInfo[] | null>(null);
  const [limits, setLimits] = useState<ShareLimits | null>(null);
  const [expiry, setExpiry] = useState<string>('');
  const [includeSource, setIncludeSource] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ error: boolean; text: string } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const opts = doFetch ? { fetch: doFetch } : {};

  const refresh = useCallback(
    async (s: ServerSettings) => {
      try {
        const r = await listShares(s, doFetch ? { fetch: doFetch } : {});
        setShares(r.shares);
        setLimits(r.limits);
      } catch (e) {
        setShares(null);
        setStatus({ error: true, text: messageOf(e) });
      }
    },
    [doFetch],
  );

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
      setEditing(false);
      setTokenInput('');
      setStatus(null);
      void refresh(s);
    } catch (e) {
      setStatus({ error: true, text: messageOf(e) });
    }
  };

  const forget = () => {
    forgetServerSettings(store);
    setServer(null);
    setShares(null);
    setLimits(null);
    setLink(null);
    setUrlInput('');
    setTokenInput('');
    setEditing(true);
  };

  const copy = (text: string) => {
    const done = () => setStatus({ error: false, text: 'Link copied.' });
    const failed = () => setStatus({ error: false, text: 'Copy the link from the box above.' });
    if (!navigator.clipboard) return failed();
    navigator.clipboard.writeText(text).then(done, failed);
  };

  const share = async () => {
    if (server === null) return;
    setBusy(true);
    setLink(null);
    setStatus({ error: false, text: 'Publishing...' });
    try {
      const bundle = await makeBundle(includeSource);
      if (!bundle.ok) {
        setStatus({ error: true, text: bundle.message });
        return;
      }
      if (limits && bundle.bytes.length > limits.maxBytes) {
        setStatus({
          error: true,
          text: `The view is ${sizeText(bundle.bytes.length)}; this server takes at most ${sizeText(limits.maxBytes)}.`,
        });
        return;
      }
      setStatus({ error: false, text: 'Uploading...' });
      const chosen = expiry === '' ? undefined : expiry === 'never' ? 'never' : Number(expiry);
      const made = await createShare(
        server,
        bundle.bytes,
        { name: bundle.name, ...(chosen !== undefined && { expires: chosen }) },
        opts,
      );
      const url = shareLink(viewerUrl, server, made.id);
      setLink(url);
      setStatus({ error: false, text: 'Link made.' });
      copy(url);
      await refresh(server);
    } catch (e) {
      setStatus({ error: true, text: messageOf(e) });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    if (server === null) return;
    setBusy(true);
    try {
      await revokeShare(server, id, opts);
      if (link?.endsWith(`/shares/${id}`)) setLink(null);
      setStatus({ error: false, text: 'Link revoked.' });
      await refresh(server);
    } catch (e) {
      setStatus({ error: true, text: messageOf(e) });
    } finally {
      setBusy(false);
    }
  };

  const defaultDays = limits?.defaultExpiryDays ?? 30;
  const days = [...new Set([...EXPIRY_DAYS, defaultDays])].sort((a, b) => a - b);
  const full = limits !== null && shares !== null && shares.length >= limits.maxShares;

  return (
    <div className="sketch-menu share-menu" ref={root}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        data-testid="share-button"
        title="Share a read-only view of what is shown, as a link, through your manufakture server"
        onClick={() => {
          // The list is read each time the panel opens.
          if (!open && server !== null && !editing) void refresh(server);
          setOpen(!open);
        }}
      >
        Share
      </button>
      {open && (
        <div
          className="share-panel"
          role="dialog"
          aria-label="Share"
          data-testid="share-panel"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <h4>Share a view</h4>
          {editing || server === null ? (
            <form
              className="share-server"
              onSubmit={(e) => {
                e.preventDefault();
                saveServer();
              }}
            >
              <p className="field-note">
                Links are served by your own manufakture server. Its address and token are kept in
                this browser only.
              </p>
              <label>
                Server address
                <input
                  type="url"
                  value={urlInput}
                  placeholder="https://"
                  autoComplete="off"
                  data-testid="share-server-url"
                  onChange={(e) => setUrlInput(e.target.value)}
                />
              </label>
              <label>
                Token
                <input
                  type="password"
                  value={tokenInput}
                  autoComplete="off"
                  placeholder={server ? 'unchanged' : ''}
                  data-testid="share-token"
                  onChange={(e) => setTokenInput(e.target.value)}
                />
              </label>
              <div className="dialog-buttons">
                {server && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(false);
                      void refresh(server);
                    }}
                  >
                    Cancel
                  </button>
                )}
                <button type="submit" className="primary" data-testid="share-save-server">
                  Save
                </button>
              </div>
            </form>
          ) : (
            <>
              <p className="share-server-line">
                <span title={server.url}>Server: {server.url}</span>
                <button type="button" onClick={() => setEditing(true)}>
                  Change
                </button>
                <button type="button" data-testid="share-forget" onClick={forget}>
                  Forget
                </button>
              </p>
              <label>
                Expires
                <select
                  value={expiry === '' ? String(defaultDays) : expiry}
                  data-testid="share-expiry"
                  onChange={(e) => setExpiry(e.target.value)}
                >
                  {days.map((d) => (
                    <option key={d} value={String(d)}>
                      {d === 1 ? 'in 1 day' : `in ${d} days`}
                    </option>
                  ))}
                  {(limits?.allowNever ?? true) && <option value="never">never</option>}
                </select>
              </label>
              <label className="share-check">
                <input
                  type="checkbox"
                  checked={includeSource}
                  data-testid="share-include-source"
                  onChange={(e) => setIncludeSource(e.target.checked)}
                />
                Include the document, so whoever opens the link can edit a copy
              </label>
              <div className="dialog-buttons">
                <button
                  type="button"
                  className="primary"
                  disabled={busy || full}
                  data-testid="share-create"
                  title={full ? 'Revoke a link first: the server keeps no more' : undefined}
                  onClick={() => void share()}
                >
                  Create link
                </button>
              </div>
              {link && (
                <div className="share-link">
                  <input
                    readOnly
                    value={link}
                    aria-label="Share link"
                    data-testid="share-link"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <button type="button" data-testid="share-copy" onClick={() => copy(link)}>
                    Copy
                  </button>
                </div>
              )}
              <h5>
                Active links{limits ? ` (${shares?.length ?? 0} of ${limits.maxShares})` : ''}
              </h5>
              {shares === null ? null : shares.length === 0 ? (
                <p className="field-note">None.</p>
              ) : (
                <ul className="share-list" data-testid="share-list">
                  {shares.map((s) => (
                    <li key={s.id} data-testid="share-item" data-share-id={s.id}>
                      <span className="share-name" title={s.name}>
                        {s.name}
                      </span>
                      <span className="share-meta">
                        {sizeText(s.size)}, expires {dateText(s.expiresAt)}
                      </span>
                      <button
                        type="button"
                        title="Copy this link"
                        onClick={() => copy(shareLink(viewerUrl, server, s.id))}
                      >
                        Copy
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        data-testid="share-revoke"
                        title="Delete it from the server: the link stops working"
                        onClick={() => void revoke(s.id)}
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {status && (
            <p
              className={status.error ? 'share-status share-error' : 'share-status'}
              role={status.error ? 'alert' : 'status'}
              data-testid="share-status"
            >
              {status.text}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
