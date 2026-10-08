// Merge, in the History panel: bring another branch's changes into the open one. The preview
// lists what applies, which ids were renamed because this branch took them meanwhile, what does
// not apply (and why), and what this branch changed that the merge replaces whole: a merge is
// last-writer-wins per feature, never per field (ADR 0009 decision 7), and the preview says so
// before anything changes. Merge then runs as one command in the editor (`replaceDocument`),
// so it is one step on the undo stack and one revision when autosave saves it. The rebase
// itself is the library's (`previewMerge`, by the sync client's replay); no server is involved.

import { useState } from 'react';
import type { ManufaktureDocument } from '@manufakture/core';
import {
  MAIN_BRANCH,
  mergeCommand,
  mergeLabel,
  type Branch,
  type LibraryResult,
  type MergePlan,
} from '@manufakture/library';
import { documentStore, type DocumentStoreApi } from '../state/document';
import './history.css';

/** The part of the library a merge needs. */
export interface MergeSource {
  previewMerge(
    id: string,
    from: string,
    into: string,
    options?: { document?: ManufaktureDocument },
  ): Promise<LibraryResult<MergePlan>>;
}

export interface MergeBranchProps {
  source: MergeSource;
  documentId: string;
  /** The open branch: what is merged into. */
  branch: string;
  /** Main first, as the library lists them. */
  branches: readonly Branch[];
  /** The editor's store: the merge is a command on it (default: the app's). */
  documents?: DocumentStoreApi;
  disabled?: boolean;
  /** After a merge ran, with its label. */
  onMerged?: (label: string) => void;
}

type State =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'plan'; plan: MergePlan; note?: string }
  | { kind: 'done'; text: string };

export function MergeBranch({
  source,
  documentId,
  branch,
  branches,
  documents = documentStore,
  disabled = false,
  onMerged,
}: MergeBranchProps) {
  const others = branches.filter((b) => b.id !== branch);
  const [from, setFrom] = useState<string>(others[0]?.id ?? '');
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [failure, setFailure] = useState<string | null>(null);
  const chosen = others.some((b) => b.id === from) ? from : (others[0]?.id ?? '');
  if (others.length === 0) return null;

  const preview = async (note?: string) => {
    setFailure(null);
    setState({ kind: 'busy' });
    try {
      const current = documents.getState().document;
      if (current.id !== documentId) throw new Error('Another document is open.');
      const r = await source.previewMerge(documentId, chosen, branch, { document: current });
      if (!r.ok) {
        setFailure(`It cannot be merged: ${r.message}`);
        setState({ kind: 'idle' });
        return;
      }
      setState(
        note === undefined
          ? { kind: 'plan', plan: r.value }
          : { kind: 'plan', plan: r.value, note },
      );
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
      setState({ kind: 'idle' });
    }
  };

  const apply = (plan: MergePlan) => {
    // The preview was made on the editor's state then: if it changed since, preview again
    // rather than replace the newer work.
    if (documents.getState().document !== plan.before) {
      void preview('The document changed since the preview; this is the merge as it is now.');
      return;
    }
    const label = mergeLabel(plan.fromName);
    const r = documents.getState().execute(mergeCommand(plan), label);
    if (!r.ok) {
      setFailure(`It cannot be merged: ${r.error.message}`);
      return;
    }
    setState({
      kind: 'done',
      text: `Merged ${plan.fromName} into ${plan.intoName}. Undo takes it back.`,
    });
    onMerged?.(label);
  };

  const plan = state.kind === 'plan' ? state.plan : null;
  return (
    <section className="history-merge" data-testid="merge-branch">
      <h3>Merge</h3>
      <div className="history-merge-pick">
        <label>
          From
          <select
            aria-label="Branch to merge"
            data-testid="merge-from"
            value={chosen}
            disabled={disabled || state.kind === 'busy' || plan !== null}
            onChange={(e) => {
              setFrom(e.target.value);
              setState({ kind: 'idle' });
            }}
          >
            {others.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        {plan === null && (
          <button
            type="button"
            data-testid="merge-preview"
            disabled={disabled || state.kind === 'busy'}
            title="See what the merge would change here, before anything changes"
            onClick={() => void preview()}
          >
            {state.kind === 'busy' ? 'Working...' : 'Preview merge'}
          </button>
        )}
      </div>
      {failure && (
        <p className="history-error" role="alert" data-testid="merge-error">
          {failure}
        </p>
      )}
      {state.kind === 'done' && (
        <p className="field-note" role="status" data-testid="merge-status">
          {state.text}
        </p>
      )}
      {plan && (
        <div className="history-merge-plan" data-testid="merge-plan">
          {state.kind === 'plan' && state.note && <p className="field-note">{state.note}</p>}
          <p className="history-description">
            Merging {plan.fromName} into {branch === MAIN_BRANCH ? 'Main' : plan.intoName}: its
            changes since the two branches parted are made again here, one by one.
          </p>
          {!plan.changed && (
            <p className="field-note" data-testid="merge-nothing">
              Nothing to merge: this branch already has everything {plan.fromName} changed.
            </p>
          )}
          {plan.changed && (
            <>
              <h4>Applies ({plan.applied.length})</h4>
              <ul className="history-merge-list" data-testid="merge-applied">
                {plan.applied.map((s, i) => (
                  <li key={i}>{s.cause === 'execute' ? s.label : `${s.label} (${s.cause})`}</li>
                ))}
              </ul>
            </>
          )}
          {plan.renamed.length > 0 && (
            <>
              <h4>Renamed ids ({plan.renamed.length})</h4>
              <p className="history-description" data-testid="merge-renamed">
                This branch made the same ids meanwhile, so the merged ones get new ones:{' '}
                {plan.renamed.map((r) => `${r.from} becomes ${r.to}`).join('; ')}.
              </p>
            </>
          )}
          {plan.dropped.length > 0 && (
            <>
              <h4>Does not apply ({plan.dropped.length})</h4>
              <ul className="history-merge-list history-merge-dropped" data-testid="merge-dropped">
                {plan.dropped.map((d, i) => (
                  <li key={i}>
                    {d.label}: {d.message}
                  </li>
                ))}
              </ul>
            </>
          )}
          {plan.replaced.length > 0 && (
            <>
              <h4>Replaced whole ({plan.replaced.length})</h4>
              <p className="history-description">
                Changed here too since the branches parted. The later change wins whole, per
                feature, not per field: {plan.fromName}&apos;s version replaces this one&apos;s.
              </p>
              <ul className="history-merge-list" data-testid="merge-replaced">
                {plan.replaced.map((name, i) => (
                  <li key={i}>{name}</li>
                ))}
              </ul>
            </>
          )}
          <div className="history-form-actions">
            <button
              type="button"
              data-testid="merge-apply"
              disabled={disabled || !plan.changed}
              onClick={() => apply(plan)}
            >
              Merge
            </button>
            <button
              type="button"
              data-testid="merge-cancel"
              onClick={() => setState({ kind: 'idle' })}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
