// The branch switcher next to the document name: which branch of the document is open, the
// others to switch to, and renaming or deleting the open one (never the main branch). A branch
// is made from a version, in the history viewer (ViewerBanner's Branch). What each action does
// to the library and the editor is the app's (App.tsx).

import { useState, type FormEvent } from 'react';
import { MAIN_BRANCH, type Branch } from '../persistence/library';
import './history.css';

export interface BranchSwitcherProps {
  /** Main first, as the library lists them. */
  branches: readonly Branch[];
  /** The open branch's id. */
  current: string;
  onSwitch: (id: string) => void;
  /** Resolve to a message when it failed, else null. */
  onRename: (id: string, name: string) => Promise<string | null>;
  onDelete: (id: string) => Promise<string | null>;
  disabled?: boolean;
}

type Mode = { kind: 'idle' } | { kind: 'rename'; name: string } | { kind: 'delete' };

export function BranchSwitcher({
  branches,
  current,
  onSwitch,
  onRename,
  onDelete,
  disabled = false,
}: BranchSwitcherProps) {
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const open = branches.find((b) => b.id === current);
  const main = current === MAIN_BRANCH;

  const run = (action: () => Promise<string | null>) => {
    setBusy(true);
    action()
      .then(
        (message) => {
          setFailure(message);
          if (message === null) setMode({ kind: 'idle' });
        },
        (e: unknown) => setFailure(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setBusy(false));
  };

  const submitRename = (e: FormEvent) => {
    e.preventDefault();
    if (mode.kind !== 'rename') return;
    const name = mode.name.trim();
    if (name.length === 0) {
      setFailure('A branch needs a name.');
      return;
    }
    run(() => onRename(current, name));
  };

  return (
    <span className="branch-switcher" data-testid="branch-switcher">
      <select
        aria-label="Branch"
        data-testid="branch-select"
        value={current}
        disabled={disabled || busy || mode.kind !== 'idle'}
        title="The branch open: each has its own history and versions"
        onChange={(e) => onSwitch(e.target.value)}
      >
        {branches.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      {!main && mode.kind === 'idle' && (
        <>
          <button
            type="button"
            data-testid="branch-rename"
            disabled={disabled || busy}
            onClick={() => {
              setFailure(null);
              setMode({ kind: 'rename', name: open?.name ?? '' });
            }}
          >
            Rename branch
          </button>
          <button
            type="button"
            data-testid="branch-delete"
            disabled={disabled || busy}
            onClick={() => {
              setFailure(null);
              setMode({ kind: 'delete' });
            }}
          >
            Delete branch
          </button>
        </>
      )}
      {mode.kind === 'rename' && (
        <form className="branch-form" onSubmit={submitRename}>
          <input
            aria-label="Branch name"
            data-testid="branch-rename-name"
            value={mode.name}
            maxLength={200}
            autoFocus
            onChange={(e) => setMode({ kind: 'rename', name: e.target.value })}
          />
          <button type="submit" data-testid="branch-rename-save" disabled={busy}>
            Save
          </button>
          <button type="button" disabled={busy} onClick={() => setMode({ kind: 'idle' })}>
            Cancel
          </button>
        </form>
      )}
      {mode.kind === 'delete' && (
        <span className="branch-form" role="group" aria-label="Delete branch">
          <span>Delete the branch {open?.name} and its history? Main stays as it is.</span>
          <button
            type="button"
            data-testid="branch-delete-confirm"
            disabled={busy}
            onClick={() => run(() => onDelete(current))}
          >
            Delete
          </button>
          <button type="button" disabled={busy} onClick={() => setMode({ kind: 'idle' })}>
            Cancel
          </button>
        </span>
      )}
      {failure && (
        <span className="history-error" role="alert" data-testid="branch-switcher-error">
          {failure}
        </span>
      )}
    </span>
  );
}
