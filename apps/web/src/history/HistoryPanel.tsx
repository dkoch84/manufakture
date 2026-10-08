// The History panel, in the side panel: the open document's named versions, a form to create
// one, and the timeline of saved revisions from the command log, grouped into sessions. Each
// version and each readable revision can be viewed; viewing, restoring and going back are the
// app's (App.tsx, with the viewer banner). With a `branch`, the timeline is that branch's own;
// the versions are every branch's, each tagged with its branch when it is not this one, so a
// version of another branch can be viewed and restored here. With other branches, another one can
// be merged into the open one (MergeBranch). Versions that came from the sync server (T7.1e) are
// listed with the others; the panel reads the history again whenever the library says the
// document's versions or branches changed. The logic is in history.ts. Agent branches (M8 plan
// T8.3b) are listed with their client, session and review state, each with **Review**.

import { useEffect, useState, type FormEvent } from 'react';
import {
  MAIN_BRANCH,
  MAIN_BRANCH_NAME,
  versionBranch,
  type Branch,
  type LibraryChange,
  type Version,
} from '@manufakture/library';
import {
  formatWhen,
  sameTarget,
  sessionSpan,
  timeline,
  type CreateVersion,
  type HistorySource,
  type HistoryTarget,
  type Session,
} from './history';
import { MergeBranch, type MergeSource } from './MergeBranch';
import { AgentBranches } from '../review/AgentBranches';
import { agentBranches, reviewStateText } from '../review/review';
import { VersionList } from './VersionList';
import type { DocumentStoreApi } from '../state/document';
import './history.css';

export interface HistoryPanelProps {
  /** With `previewMerge` (the library has it), another branch can be merged into this one. */
  source: HistorySource & { has(id: string): Promise<boolean> } & Partial<MergeSource> & {
      /** Changes to the document's versions and branches (made here, or kept from the server). */
      subscribe?: (listener: (change: LibraryChange) => void) => () => void;
    };
  documentId: string;
  /**
   * The branch whose history it shows, and its name (shown when it is not the main one). Absent:
   * the source's default, as before branches.
   */
  branch?: string | undefined;
  branchName?: string | undefined;
  /** The document's branches, to name the branch of a version made on another one. */
  branches?: readonly Branch[] | null | undefined;
  /** Changes whenever the document was saved, so the panel reads the history again. */
  refresh?: number;
  /** Name the current state; absent when versions cannot be made (nothing is saved). */
  createVersion?: CreateVersion | null;
  onView: (target: HistoryTarget) => void;
  /** What is being viewed now, if anything. */
  viewing?: HistoryTarget | null;
  /** Nothing can be viewed or created (a sketch, a dialog or an export is open). */
  disabled?: boolean;
  /** Creating a version is off (a past state is being viewed: go back first). */
  createDisabled?: boolean;
  onClose?: () => void;
  /** The editor's store, which a merge runs on (default: the app's). */
  documents?: DocumentStoreApi;
  /** Open the Review view of an agent branch; absent: agent branches are not listed. */
  onReview?: (branch: string) => void;
}

type Loaded =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | {
      state: 'ready';
      saved: boolean;
      versions: Version[];
      sessions: Session[];
      start: number | null;
    };

/** How many labels a revision shows before "and n more". */
const LABELS_SHOWN = 3;

export function HistoryPanel({
  source,
  documentId,
  branch,
  branchName,
  branches = null,
  refresh = 0,
  createVersion = null,
  onView,
  viewing = null,
  disabled = false,
  createDisabled = false,
  onClose,
  documents,
  onReview,
}: HistoryPanelProps) {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [reload, setReload] = useState(0);
  const [form, setForm] = useState<{ name: string; description: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Versions can arrive without a save (sync keeps the server's, T7.1e): read again then.
  useEffect(() => {
    if (!source.subscribe) return undefined;
    return source.subscribe((change) => {
      if (change.id === documentId) setReload((n) => n + 1);
    });
  }, [source, documentId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (!(await source.has(documentId))) {
          if (!cancelled) {
            setLoaded({ state: 'ready', saved: false, versions: [], sessions: [], start: null });
          }
          return;
        }
        const [versions, logged, start] = await Promise.all(
          branch === undefined
            ? ([
                source.listVersions(documentId),
                source.readHistory(documentId),
                source.historyStart(documentId),
              ] as const)
            : ([
                source.listVersions(documentId),
                source.readHistory(documentId, branch),
                source.historyStart(documentId, branch),
              ] as const),
        );
        if (cancelled) return;
        if (!versions.ok) return setLoaded({ state: 'error', message: versions.message });
        if (!logged.ok) return setLoaded({ state: 'error', message: logged.message });
        const first = start.ok ? start.value : null;
        // The timeline marks this branch's versions only: its revisions are its own.
        const here =
          branch === undefined
            ? versions.value
            : versions.value.filter((v) => versionBranch(v) === branch);
        setLoaded({
          state: 'ready',
          saved: true,
          versions: versions.value,
          sessions: timeline(logged.value, here, first),
          start: first,
        });
      } catch (e) {
        if (!cancelled) {
          setLoaded({ state: 'error', message: e instanceof Error ? e.message : String(e) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, documentId, branch, refresh, reload]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form || !createVersion) return;
    const name = form.name.trim();
    if (name.length === 0) {
      setFailure('A version needs a name.');
      return;
    }
    setBusy(true);
    createVersion({ name, description: form.description.trim() })
      .then(
        (r) => {
          if (r.ok) {
            setForm(null);
            setFailure(null);
            setReload((n) => n + 1);
          } else setFailure(r.message);
        },
        (err: unknown) => setFailure(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setBusy(false));
  };

  const viewingVersion = viewing?.kind === 'version' ? viewing.version.id : null;
  const agents = agentBranches(branches);
  const openAgent = agents.find((b) => b.id === (branch ?? MAIN_BRANCH));

  return (
    <aside
      className="selection-panel history-panel"
      aria-label="History"
      data-testid="history-panel"
    >
      <div className="variables-head">
        <h2>History</h2>
        {branchName && (
          <span className="history-branch" data-testid="history-branch-name">
            {branchName}
          </span>
        )}
        {openAgent && (
          <span className="history-tag" data-testid="history-branch-review">
            {reviewStateText(openAgent.provenance.review)}
          </span>
        )}
        {createVersion && !form && (
          <button
            type="button"
            data-testid="version-create"
            disabled={disabled || createDisabled}
            title={createDisabled ? 'Go back to the current state to name it' : undefined}
            onClick={() => {
              setFailure(null);
              setForm({ name: '', description: '' });
            }}
          >
            Create version
          </button>
        )}
        {onClose && (
          <button type="button" aria-label="Close history" onClick={onClose}>
            Close
          </button>
        )}
      </div>
      {form && (
        <form className="history-form" onSubmit={submit} data-testid="version-form">
          <label>
            Name
            <input
              data-testid="version-name"
              value={form.name}
              maxLength={200}
              autoFocus
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            Description
            <textarea
              data-testid="version-description"
              value={form.description}
              maxLength={2000}
              rows={2}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </label>
          <div className="history-form-actions">
            <button
              type="submit"
              data-testid="version-save"
              disabled={busy || disabled || createDisabled}
            >
              {busy ? 'Saving...' : 'Save version'}
            </button>
            <button type="button" disabled={busy} onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {failure && (
        <p className="history-error" role="alert" data-testid="history-error">
          {failure}
        </p>
      )}
      {loaded.state === 'loading' && <p className="field-note">Reading the history...</p>}
      {loaded.state === 'error' && (
        <p className="history-error" role="alert">
          The history cannot be read: {loaded.message}
        </p>
      )}
      {loaded.state === 'ready' && (
        <>
          {onReview && (
            <AgentBranches
              branches={agents}
              current={branch ?? MAIN_BRANCH}
              onReview={onReview}
              disabled={disabled}
            />
          )}
          <h3>Versions</h3>
          <VersionList
            versions={loaded.versions}
            currentId={viewingVersion}
            disabled={disabled}
            onPick={(version) => onView({ kind: 'version', version })}
            tagOf={
              branch === undefined
                ? undefined
                : (v) => {
                    const of = versionBranch(v);
                    if (of === branch) return null;
                    const name = branches?.find((b) => b.id === of)?.name;
                    return of === MAIN_BRANCH ? MAIN_BRANCH_NAME : (name ?? 'Another branch');
                  }
            }
          />
          {loaded.saved && source.previewMerge && branches && branches.length > 1 && (
            <MergeBranch
              key={branch ?? MAIN_BRANCH}
              source={source as MergeSource}
              documentId={documentId}
              branch={branch ?? MAIN_BRANCH}
              branches={branches}
              disabled={disabled || createDisabled}
              {...(documents && { documents })}
            />
          )}
          <h3>Timeline</h3>
          {!loaded.saved && <p className="field-note">Nothing is saved yet.</p>}
          {loaded.saved && loaded.sessions.length === 0 && (
            <p className="field-note">No changes are logged yet.</p>
          )}
          {loaded.sessions.map((session) => (
            // A revision is in one session only, so its oldest revision names it uniquely.
            <section key={session.revisions.at(-1)!.revision} className="history-session">
              <h4>{sessionSpan(session)}</h4>
              <ul className="history-list">
                {session.revisions.map((r) => {
                  const target: HistoryTarget =
                    branch === undefined
                      ? { kind: 'revision', revision: r.revision }
                      : { kind: 'revision', revision: r.revision, branch };
                  const shown = sameTarget(viewing, target);
                  const more = r.labels.length - LABELS_SHOWN;
                  return (
                    <li
                      key={r.revision}
                      className={shown ? 'history-item history-current' : 'history-item'}
                      data-testid={`revision-${r.revision}`}
                    >
                      <div className="history-item-head">
                        <span className="history-name">Revision {r.revision}</span>
                        {r.versions.map((v) => (
                          <span key={v.id} className="history-tag" title={v.description}>
                            {v.name}
                          </span>
                        ))}
                        <button
                          type="button"
                          disabled={disabled || shown || !r.readable}
                          title={
                            r.readable
                              ? undefined
                              : 'Saved before the history kept this revision: it cannot be read back.'
                          }
                          aria-label={`View revision ${r.revision}`}
                          onClick={() => onView(target)}
                        >
                          View
                        </button>
                      </div>
                      <div className="history-meta">{formatWhen(r.at)}</div>
                      <div className="history-labels">
                        {r.labels.slice(0, LABELS_SHOWN).join('; ')}
                        {more > 0 && ` and ${more} more`}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </>
      )}
    </aside>
  );
}
