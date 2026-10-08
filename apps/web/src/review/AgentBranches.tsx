// The document's agent branches, in the History panel (M8 plan T8.3b): each with the name its
// client gave (self-reported, shown as text, never trusted), its session and its review state,
// and **Review**, which opens the Review view. Branches whose review is over (approved,
// rejected) are listed after the others.

import { clip, reviewStateText, type AgentBranch } from './review';
import '../history/history.css';
import './review.css';

const DONE = new Set(['approved', 'rejected']);

export function AgentBranches({
  branches,
  current,
  onReview,
  disabled = false,
}: {
  branches: readonly AgentBranch[];
  /** The open branch's id. */
  current: string;
  onReview: (id: string) => void;
  disabled?: boolean;
}) {
  if (branches.length === 0) return null;
  const ordered = [
    ...branches.filter((b) => !DONE.has(b.provenance.review)),
    ...branches.filter((b) => DONE.has(b.provenance.review)),
  ];
  return (
    <section className="history-agents" data-testid="agent-branches">
      <h3>Agent branches</h3>
      <ul className="history-list">
        {ordered.map((b) => (
          <li
            key={b.id}
            className={b.id === current ? 'history-item history-current' : 'history-item'}
            data-testid={`agent-branch-${b.id}`}
            data-state={b.provenance.review}
          >
            <div className="history-item-head">
              <span className="history-name" title={b.name}>
                {b.name}
              </span>
              <span className="history-tag" data-testid="agent-branch-state">
                {reviewStateText(b.provenance.review)}
              </span>
              <button
                type="button"
                data-testid="agent-branch-review"
                disabled={disabled}
                aria-label={`Review ${clip(b.name, 80)}`}
                onClick={() => onReview(b.id)}
              >
                Review
              </button>
            </div>
            <div className="history-meta">
              Agent:{' '}
              <span data-testid="agent-branch-client">{clip(b.provenance.clientName, 80)}</span>,
              session {b.provenance.sessionId}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
