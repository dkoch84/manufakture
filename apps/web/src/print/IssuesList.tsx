// The Issues list of the print workspace (M3 plan, T3.1d): one row per issue with its worst value;
// a click selects what it is about and frames it in the view (`onPick`), a second click lets go.
// The wording follows ADR 0012 decision 3: what "may print badly", never what "will fail".

import type { AnalysisState } from './analysis';
import { ISSUE_TITLES, type PrintIssue } from './issues';

export interface IssuesListProps {
  issues: readonly PrintIssue[];
  /** The key of the issue framed now, or null. */
  focus: string | null;
  analysis: AnalysisState;
  /** Whether there is anything to check (a known printer and at least one placed item). */
  checking: boolean;
  onPick: (issue: PrintIssue | null) => void;
}

export function IssuesList({ issues, focus, analysis, checking, onPick }: IssuesListProps) {
  return (
    <section className="print-issues" aria-label="Issues" data-testid="print-issues">
      <h3>
        Issues{' '}
        {analysis.running && (
          <span className="print-checking" role="status" data-testid="print-analysis-running">
            checking walls and gaps...
          </span>
        )}
      </h3>
      {analysis.message !== null && (
        <p className="field-error" role="alert" data-testid="print-analysis-failed">
          Walls and gaps could not be checked: {analysis.message}
        </p>
      )}
      {!checking ? (
        <p className="field-note">Nothing to check yet.</p>
      ) : issues.length === 0 ? (
        <p className="field-note" data-testid="print-no-issues">
          {analysis.running || analysis.reply === null
            ? 'No issues found so far.'
            : 'Nothing found that may print badly.'}
        </p>
      ) : (
        <ul className="print-issue-list" data-testid="print-issue-list">
          {issues.map((issue) => (
            <li key={issue.key} className={focus === issue.key ? 'focused' : ''}>
              <button
                type="button"
                className={`print-issue print-issue-${issue.kind}`}
                aria-pressed={focus === issue.key}
                data-testid={`print-issue-${issue.kind}`}
                data-item={issue.itemId}
                data-worst={issue.worst}
                title="Select it and show it in the view"
                onClick={() => onPick(focus === issue.key ? null : issue)}
              >
                <span className="print-issue-title">{ISSUE_TITLES[issue.kind]}</span>
                <span className="print-issue-worst">{issue.worst}</span>
                <span className="print-issue-detail">
                  {issue.item}: {issue.detail}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
