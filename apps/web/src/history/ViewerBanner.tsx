// The banner shown while a version or revision is viewed in place of the open document: what is
// shown, how it differs from the current state, and the way out: Back to the current state,
// Restore it (one undo step), or Branch from it (when the app offers branches): Branch asks for
// the new branch's name first.

import { useState, type FormEvent } from 'react';

export interface ViewerBannerProps {
  /** `Version "6 mm"`, `Revision 12` (history.ts `targetLabel`). */
  label: string;
  /** What differs from the current state, one line each; empty when nothing does. */
  differences: readonly string[];
  /** The viewed document is still being built, or failed to build (the reason). */
  pending?: boolean;
  error?: string | null;
  onBack: () => void;
  onRestore: () => void;
  /**
   * Branch from the viewed state, under the name given; no button without it. A promise holds
   * the form (busy) until it settles; a string it resolves to is shown as why it failed.
   */
  onBranch?: ((name: string) => void | Promise<string | null | void>) | undefined;
  /** The name the branch form starts with. */
  branchName?: string;
}

export function ViewerBanner({
  label,
  differences,
  pending = false,
  error = null,
  onBack,
  onRestore,
  onBranch,
  branchName = '',
}: ViewerBannerProps) {
  const [form, setForm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (form === null || !onBranch) return;
    const name = form.trim();
    if (name.length === 0) {
      setFailure('A branch needs a name.');
      return;
    }
    setBusy(true);
    Promise.resolve(onBranch(name))
      .then(
        (r) => {
          if (typeof r === 'string') setFailure(r);
          else {
            setForm(null);
            setFailure(null);
          }
        },
        (err: unknown) => setFailure(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setBusy(false));
  };
  return (
    <div
      className="history-viewer"
      role="region"
      aria-label="Viewing history"
      data-testid="history-viewer"
    >
      <div className="history-viewer-head">
        <strong data-testid="history-viewer-label">Viewing {label}</strong>
        <span className="history-viewer-note">
          {pending ? 'Building it...' : 'Read-only: editing is off until you go back.'}
        </span>
        <button type="button" data-testid="history-back" onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          data-testid="history-restore"
          title="Make this the current state (one step: undo takes it back)"
          onClick={onRestore}
        >
          Restore
        </button>
        {onBranch && (
          <button
            type="button"
            data-testid="history-branch"
            title="Start a branch from this state, with its own history"
            disabled={form !== null}
            onClick={() => {
              setFailure(null);
              setForm(branchName);
            }}
          >
            Branch
          </button>
        )}
      </div>
      {form !== null && (
        <form className="history-form history-branch-form" onSubmit={submit}>
          <label>
            Branch name
            <input
              data-testid="branch-name"
              value={form}
              maxLength={200}
              autoFocus
              onChange={(e) => setForm(e.target.value)}
            />
          </label>
          <div className="history-form-actions">
            <button type="submit" data-testid="branch-create" disabled={busy}>
              {busy ? 'Creating...' : 'Create branch'}
            </button>
            <button type="button" disabled={busy} onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {failure && (
        <p className="history-error" role="alert" data-testid="branch-error">
          {failure}
        </p>
      )}
      {error && (
        <p className="history-error" role="alert">
          It could not be built: {error}
        </p>
      )}
      <div className="history-compare" data-testid="history-compare">
        {differences.length === 0 ? (
          <span>Same as the current state.</span>
        ) : (
          <>
            <span>Compared with the current state:</span>
            <ul>
              {differences.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
