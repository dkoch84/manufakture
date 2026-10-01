// The banner shown while a version or revision is viewed in place of the open document: what is
// shown, how it differs from the current state, and the way out: Back to the current state,
// Restore it (one undo step), or Branch from it (when the app offers branches).

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
  /** Branch from the viewed state; no button without it. */
  onBranch?: () => void;
}

export function ViewerBanner({
  label,
  differences,
  pending = false,
  error = null,
  onBack,
  onRestore,
  onBranch,
}: ViewerBannerProps) {
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
          <button type="button" data-testid="history-branch" onClick={onBranch}>
            Branch
          </button>
        )}
      </div>
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
