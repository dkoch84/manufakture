// The Review view (M8 plan T8.3b): an agent branch's review bundle, opened from History. It says
// who made the branch (the client's self-reported name and the session), its review state and the
// agent's note; then whether it may be approved and why not; then the bundle (BundleView).
//
// The app checks the bundle rather than trusting it: the bundle must describe the branch head as
// stored now (not stale), the app's own regen of that head (the editor's, with the branch open)
// must match its measurements and names (`compareRegen`; any difference is listed, never hidden),
// and the merge into Main as it would be made now must apply every change. The scripts shown are
// the branch head's own (`branchScripts`), which is what **Run scripts** allows, and a bundle
// whose scripts are not the head's blocks approval. The command list shown is the branch log's,
// replayed here from the branch's base (`logCommands`), never the bundle's; a bundle whose list
// says something else blocks approval until the agent rebuilds it. What the bundle left out at
// its limits and so could not be compared needs the reviewer's acknowledgement. Only then is **Approve** offered
// (`approveBlockers`). A branch approved whose approval no version of Main records (the tab closed
// in between) offers **Finish approval**, behind the same checks. **Request changes** stores a comment for the agent, and
// **Reject** closes the branch; both are compare-and-set from the state shown, so a decision is
// never made on a state that changed meanwhile.

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { MAIN_BRANCH, MAX_REVIEW_COMMENT, isReviewComment } from '@manufakture/library';
import { useModel, type ModelStore } from '../model/model';
import { Clipped, Guarded, Paged } from './Bounded';
import { BundleView } from './BundleView';
import type { ApproveResult } from './approve';
import {
  approvalRecorded,
  approveBlockers,
  branchScripts,
  compareRegen,
  loadReview,
  logCommands,
  reviewStateText,
  sameJson,
  type AgentBranch,
  type CommandStatus,
  type LoadedReview,
  type MeasuredHere,
  type MergeStatus,
  type RegenCheck,
  type RegenStatus,
  type ReviewSource,
} from './review';
import '../history/history.css';
import './review.css';

export interface ReviewPanelProps {
  source: ReviewSource;
  documentId: string;
  /** The agent branch reviewed, as the library lists it now. */
  branch: AgentBranch;
  /** The branch open in the editor: the app's regen is of that one. */
  openBranch: string;
  /** The editor's model: this app's regen of the open branch. */
  model: ModelStore;
  /** Measure a body of the model by its viewport id. */
  measure: (viewId: string) => Promise<MeasuredHere>;
  /** Changes when the document's branches or history change, so the panel reads again. */
  refresh?: number;
  onOpenBranch: () => void;
  /** Approve, or with `finishing` finish an approval Main does not record (approve.ts). */
  onApprove: (bundleRevision: number, finishing: boolean) => Promise<ApproveResult>;
  onClose: () => void;
  disabled?: boolean;
}

type Mode = { kind: 'idle' } | { kind: 'request'; comment: string } | { kind: 'reject' };

export function ReviewPanel({
  source,
  documentId,
  branch,
  openBranch,
  model,
  measure,
  refresh = 0,
  onOpenBranch,
  onApprove,
  onClose,
  disabled = false,
}: ReviewPanelProps) {
  const state = branch.provenance.review;
  const [review, setReview] = useState<LoadedReview | null>(null);
  // Each result is kept with what it was made for, so one made for an older branch record or
  // regen reads as waiting until the new one arrives.
  const [merged, setMerged] = useState<{ for: unknown; status: MergeStatus } | null>(null);
  const [checked, setChecked] = useState<{ for: unknown; check: RegenCheck } | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ error: boolean; text: string } | null>(null);
  // Whether a version of Main records this branch's approval, for the loadKey it was read for.
  const [recordedFor, setRecorded] = useState<{ for: unknown; recorded: boolean | null } | null>(
    null,
  );
  // The reviewer's acknowledgement of what could not be compared, for the comparison it was given.
  const [acknowledgedFor, setAcknowledged] = useState<unknown>(null);

  // The bundle and the merge preview, read again when the branch or the history changes.
  const loadKey = useMemo(() => ({ branch, refresh }), [branch, refresh]);
  useEffect(() => {
    let cancelled = false;
    const failure = (e: unknown) => (e instanceof Error ? e.message : String(e));
    void (async () => {
      try {
        const loaded = await loadReview(source, documentId, branch);
        if (!cancelled) setReview(loaded);
      } catch (e) {
        if (!cancelled) setReview({ kind: 'error', message: failure(e) });
      }
      let status: MergeStatus;
      try {
        const plan = await source.previewMerge(documentId, branch.id, MAIN_BRANCH);
        status = plan.ok
          ? { kind: 'ready', plan: plan.value }
          : { kind: 'error', message: plan.message };
      } catch (e) {
        status = { kind: 'error', message: failure(e) };
      }
      if (!cancelled) setMerged({ for: loadKey, status });
      if (branch.provenance.review === 'approved') {
        let recorded: boolean | null;
        try {
          recorded = await approvalRecorded(source, documentId, branch.id);
        } catch {
          recorded = null;
        }
        if (!cancelled) setRecorded({ for: loadKey, recorded });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, documentId, branch, loadKey]);
  const merge: MergeStatus =
    merged !== null && merged.for === loadKey ? merged.status : { kind: 'waiting' };

  // This app's regen of the head, compared with the bundle's measurements.
  const generation = useModel(model, (s) => s.generation);
  const pending = useModel(model, (s) => s.pending);
  const built = useModel(model, (s) => s.document);
  const parts = useModel(model, (s) => s.parts);
  const head = review?.kind === 'ready' ? review.head.document : null;
  const sameAsHead = useMemo(
    () => head !== null && built !== null && sameJson(built, head),
    [head, built],
  );
  const ready = review?.kind === 'ready' ? review : null;
  const comparable =
    openBranch === branch.id &&
    ready !== null &&
    !pending &&
    generation > 0 &&
    built !== null &&
    sameAsHead;
  // What a comparison is made for: the bundle read, and this regen of the head.
  const checkKey = useMemo(
    () => (comparable ? { ready, built, parts } : null),
    [comparable, ready, built, parts],
  );
  useEffect(() => {
    if (checkKey === null || checkKey.ready === null || checkKey.built === null) return undefined;
    let cancelled = false;
    const { ready: r, built: document, parts: regenerated } = checkKey;
    // The branch's base version says which scripted features the session did not run; when it
    // cannot be read nothing is left out, and those bodies show as mismatches.
    const readBase = async () => {
      if (branch.fromVersion === null) return null;
      try {
        const read = await source.readVersion(documentId, branch.fromVersion);
        return read.ok ? read.value.document : null;
      } catch {
        return null;
      }
    };
    void (async () =>
      compareRegen({
        bundle: r.bundle,
        document,
        parts: regenerated,
        measure,
        base: await readBase(),
      }))().then(
      (check) => {
        if (!cancelled) setChecked({ for: checkKey, check });
      },
      (e: unknown) => {
        if (!cancelled) {
          setChecked({
            for: checkKey,
            check: {
              mismatches: [
                `It could not be compared: ${e instanceof Error ? e.message : String(e)}`,
              ],
              unverified: [],
              notes: [],
              bodies: 0,
            },
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [checkKey, measure, source, documentId, branch.fromVersion]);
  const regen: RegenStatus =
    openBranch !== branch.id
      ? { kind: 'not-open' }
      : ready === null || pending || generation === 0 || built === null
        ? { kind: 'waiting' }
        : !sameAsHead
          ? { kind: 'edited' }
          : checked !== null && checked.for === checkKey
            ? { kind: 'done', check: checked.check }
            : { kind: 'waiting' };

  // The commands from the branch log, compared with the bundle's list.
  const [logged, setLogged] = useState<{ for: unknown; status: CommandStatus } | null>(null);
  useEffect(() => {
    if (ready === null) return undefined;
    let cancelled = false;
    logCommands(source, documentId, branch, ready.bundle, ready.head).then(
      (status) => {
        if (!cancelled) setLogged({ for: ready, status });
      },
      (e: unknown) => {
        if (!cancelled) {
          setLogged({
            for: ready,
            status: { kind: 'error', message: e instanceof Error ? e.message : String(e) },
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source, documentId, branch, ready]);
  const commands: CommandStatus =
    logged !== null && logged.for === ready ? logged.status : { kind: 'waiting' };

  // The scripts from the branch head, compared with the bundle's.
  const scriptCheck = useMemo(
    () => (ready === null ? null : branchScripts(ready.bundle, ready.head.document)),
    [ready],
  );
  const recorded =
    recordedFor !== null && recordedFor.for === loadKey ? recordedFor.recorded : null;
  const finishing = state === 'approved' && recorded === false;
  const acknowledged = regen.kind === 'done' && acknowledgedFor === regen.check;
  const blockers =
    review === null
      ? ['Reading the bundle...']
      : approveBlockers({
          state,
          review,
          regen,
          merge,
          scripts: scriptCheck?.mismatches ?? [],
          commands,
          acknowledged,
          finishing,
        });
  const read = useMemo(
    () => (sha256: string) => source.reviewImage(documentId, sha256),
    [source, documentId],
  );

  const decide = (run: () => Promise<{ error: boolean; text: string }>) => {
    setBusy(true);
    setOutcome(null);
    run()
      .then(
        (r) => {
          setOutcome(r);
          if (!r.error) setMode({ kind: 'idle' });
        },
        (e: unknown) =>
          setOutcome({ error: true, text: e instanceof Error ? e.message : String(e) }),
      )
      .finally(() => setBusy(false));
  };

  const approve = () =>
    decide(async () => {
      if (review?.kind !== 'ready') return { error: true, text: 'There is no bundle to approve.' };
      const r = await onApprove(review.revision, finishing);
      return r.ok
        ? {
            error: false,
            text: `Approved and merged into Main as one step ("${r.label}"). Undo takes the merge back; the branch stays approved.`,
          }
        : { error: true, text: r.message };
    });

  const requestChanges = (e: FormEvent) => {
    e.preventDefault();
    if (mode.kind !== 'request') return;
    const comment = mode.comment.trim();
    if (!isReviewComment(comment)) {
      setOutcome({
        error: true,
        text: `A comment is 1 to ${MAX_REVIEW_COMMENT} characters, without hidden characters.`,
      });
      return;
    }
    decide(async () => {
      const r = await source.setBranchReview(documentId, branch.id, 'changes-requested', {
        expected: 'submitted',
        comment,
      });
      return r.ok
        ? { error: false, text: 'Changes requested: the agent reads your comment with get_review.' }
        : { error: true, text: `Not changed: ${r.message}` };
    });
  };

  const reject = () =>
    decide(async () => {
      const r = await source.setBranchReview(documentId, branch.id, 'rejected', {
        expected: ['open', 'submitted', 'changes-requested'],
      });
      return r.ok
        ? { error: false, text: 'Rejected: the branch is closed, and the agent cannot write it.' }
        : { error: true, text: `Not changed: ${r.message}` };
    });

  const decidable = state === 'submitted' || finishing;
  const p = branch.provenance;
  return (
    <aside
      className="selection-panel review-panel"
      aria-label="Review"
      data-testid="review-panel"
      data-state={state}
    >
      <div className="variables-head">
        <h2>Review</h2>
        <button type="button" aria-label="Close review" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="review-who">
        <strong>
          <Clipped value={branch.name} max={120} />
        </strong>
        <br />
        Made by an agent: <Clipped value={p.clientName} max={120} testId="review-client" /> (the
        name its client gave, not checked), session <code>{p.sessionId}</code>.
      </p>
      <p>
        State:{' '}
        <span className="history-tag review-state" data-testid="review-state">
          {reviewStateText(state)}
        </span>
      </p>
      {finishing && (
        <p className="history-error" role="alert" data-testid="review-unfinished">
          This branch was approved, but its approval was never finished: no version of Main records
          it, and Main may not have its changes. Finish approval checks it again, merges what Main
          does not have yet and records the review.
        </p>
      )}
      {p.comment !== undefined && (
        <div className="review-comment" data-testid="review-comment">
          Your comment: <Clipped value={p.comment} max={600} />
        </div>
      )}
      {review === null && <p className="field-note">Reading the bundle...</p>}
      {review?.kind === 'none' && (
        <p className="field-note" data-testid="review-none">
          The agent has not submitted this branch for review: there is no bundle yet.
        </p>
      )}
      {review?.kind === 'error' && (
        <p className="history-error" role="alert" data-testid="review-error">
          The bundle cannot be read: {review.message}
        </p>
      )}
      {review?.kind === 'ready' && review.note && (
        <div className="review-note" data-testid="review-note">
          The agent&apos;s note: <Clipped value={review.note} max={600} />
        </div>
      )}

      <section className="review-checks" data-testid="review-checks">
        <h3>Checks</h3>
        <ul className="review-list">
          <li data-testid="review-check-stale">
            {review?.kind !== 'ready'
              ? 'The bundle: not read.'
              : review.stale
                ? `Stale: the branch changed after its bundle was made (bundle at revision ${review.revision}, branch at ${review.head.revision}).`
                : `The bundle describes the branch head (revision ${review.revision}).`}
          </li>
          {scriptCheck !== null && (
            <li
              data-testid="review-check-scripts"
              data-state={scriptCheck.mismatches.length > 0 ? 'mismatch' : 'match'}
            >
              {scriptCheck.mismatches.length === 0 ? (
                'The scripts shown are the branch head’s, and the bundle has the same.'
              ) : (
                <div className="history-error" role="alert">
                  The bundle’s scripts are not the branch head’s; the scripts below are the head’s:
                  <Paged items={scriptCheck.mismatches} render={(m) => <span>{m}</span>} />
                </div>
              )}
            </li>
          )}
          {ready !== null && (
            <li
              data-testid="review-check-commands"
              data-state={
                commands.kind === 'done'
                  ? commands.mismatches.length > 0
                    ? 'mismatch'
                    : 'match'
                  : commands.kind
              }
            >
              {commands.kind === 'waiting' && 'Reading the branch log...'}
              {commands.kind === 'error' && (
                <span className="history-error">
                  The branch log cannot be read, so its commands cannot be shown:{' '}
                  <Clipped value={commands.message} max={200} />
                </span>
              )}
              {commands.kind === 'done' && commands.mismatches.length === 0 && (
                <>The commands shown are the branch log’s, and the bundle lists the same.</>
              )}
              {commands.kind === 'done' && commands.mismatches.length > 0 && (
                <div className="history-error" role="alert" data-testid="review-commands-mismatch">
                  The bundle’s command list does not describe what the branch log holds, which is
                  what Approve would merge. The commands below are the log’s, replayed here; Approve
                  waits until the agent rebuilds its bundle (submits again). Where the bundle
                  differs:
                  <Paged items={commands.mismatches} render={(m) => <span>{m}</span>} />
                </div>
              )}
              {commands.kind === 'done' &&
                (commands.commands.batches.omitted > 0 ||
                  commands.commands.omittedCommands > 0) && (
                  <p className="history-error" role="alert" data-testid="review-commands-omitted">
                    The branch log is too long to list here: past this view’s limits (2,000 batches,
                    5,000 commands), {commands.commands.batches.omitted} batches and{' '}
                    {commands.commands.omittedCommands} more commands are not shown, and Approve
                    would merge them unseen. It cannot be approved here; ask the agent to split the
                    work into smaller branches.
                  </p>
                )}
            </li>
          )}
          <li
            data-testid="review-check-regen"
            data-state={
              regen.kind === 'done'
                ? regen.check.mismatches.length > 0
                  ? 'mismatch'
                  : 'match'
                : regen.kind
            }
          >
            {regen.kind === 'not-open' && (
              <>
                This app compares its own regen only with the branch open.{' '}
                <button
                  type="button"
                  data-testid="review-open-branch"
                  disabled={disabled || busy}
                  onClick={onOpenBranch}
                >
                  Open the branch
                </button>
              </>
            )}
            {regen.kind === 'waiting' && 'Comparing with this app’s regen...'}
            {regen.kind === 'edited' &&
              'The branch open here is not its saved head (it was edited here): its regen is not compared.'}
            {regen.kind === 'done' && regen.check.mismatches.length === 0 && (
              <>This app&apos;s regen matches the bundle ({regen.check.bodies} bodies compared).</>
            )}
            {regen.kind === 'done' && regen.check.mismatches.length > 0 && (
              <div className="history-error" role="alert" data-testid="review-mismatch">
                This app&apos;s regen does not match the bundle:
                <Paged items={regen.check.mismatches} render={(m) => <span>{m}</span>} />
              </div>
            )}
            {regen.kind === 'done' &&
              regen.check.mismatches.length === 0 &&
              regen.check.unverified.length > 0 && (
                <div className="review-unverified" data-testid="review-unverified">
                  <p className="history-error">
                    The bundle left some of its lists out, so this app could not compare all of its
                    regen:
                  </p>
                  <Paged items={regen.check.unverified} render={(m) => <span>{m}</span>} />
                  <label>
                    <input
                      type="checkbox"
                      data-testid="review-acknowledge"
                      checked={acknowledged}
                      disabled={disabled || busy}
                      onChange={(e) => setAcknowledged(e.target.checked ? regen.check : null)}
                    />{' '}
                    I have checked these myself
                  </label>
                </div>
              )}
            {regen.kind === 'done' &&
              regen.check.notes.map((n, i) => (
                <p key={i} className="field-note">
                  {n}
                </p>
              ))}
          </li>
          <li data-testid="review-check-merge">
            {merge.kind === 'waiting' && 'Previewing the merge into Main...'}
            {merge.kind === 'error' && <span className="history-error">{merge.message}</span>}
            {merge.kind === 'ready' && (
              <>
                Into Main now: {merge.plan.applied.length} batches apply
                {merge.plan.dropped.length > 0 && (
                  <span className="history-error">
                    , {merge.plan.dropped.length} would not apply:
                  </span>
                )}
                {merge.plan.dropped.length > 0 && (
                  <Paged
                    items={merge.plan.dropped}
                    testId="review-merge-dropped"
                    render={(d) => (
                      <span>
                        <Clipped value={d.label} max={120} />:{' '}
                        <Clipped value={d.message} max={200} />
                      </span>
                    )}
                  />
                )}
                {!merge.plan.changed && ' (nothing to merge)'}
              </>
            )}
          </li>
        </ul>
      </section>

      <div className="review-actions">
        {mode.kind === 'idle' && (
          <>
            <button
              type="button"
              className="primary"
              data-testid="review-approve"
              disabled={disabled || busy || blockers.length > 0}
              title={
                blockers.length > 0
                  ? blockers.join(' ')
                  : finishing
                    ? 'Merge what Main does not have yet and record the approval'
                    : 'Merge into Main as one step and mark approved'
              }
              onClick={approve}
            >
              {busy ? 'Working...' : finishing ? 'Finish approval' : 'Approve'}
            </button>
            <button
              type="button"
              data-testid="review-request-changes"
              disabled={disabled || busy || state !== 'submitted'}
              onClick={() => {
                setOutcome(null);
                setMode({ kind: 'request', comment: '' });
              }}
            >
              Request changes
            </button>
            <button
              type="button"
              data-testid="review-reject"
              disabled={disabled || busy || state === 'approved' || state === 'rejected'}
              onClick={() => {
                setOutcome(null);
                setMode({ kind: 'reject' });
              }}
            >
              Reject
            </button>
          </>
        )}
        {mode.kind === 'request' && (
          <form className="history-form" onSubmit={requestChanges}>
            <label>
              What should the agent change?
              <textarea
                data-testid="review-comment-input"
                value={mode.comment}
                maxLength={MAX_REVIEW_COMMENT}
                rows={4}
                autoFocus
                onChange={(e) => setMode({ kind: 'request', comment: e.target.value })}
              />
            </label>
            <div className="history-form-actions">
              <button type="submit" data-testid="review-comment-send" disabled={busy}>
                Send
              </button>
              <button type="button" disabled={busy} onClick={() => setMode({ kind: 'idle' })}>
                Cancel
              </button>
            </div>
          </form>
        )}
        {mode.kind === 'reject' && (
          <span className="branch-form" role="group" aria-label="Reject">
            <span>Reject this branch? The agent cannot write it again; Main stays as it is.</span>
            <button
              type="button"
              data-testid="review-reject-confirm"
              disabled={busy}
              onClick={reject}
            >
              Reject
            </button>
            <button type="button" disabled={busy} onClick={() => setMode({ kind: 'idle' })}>
              Cancel
            </button>
          </span>
        )}
      </div>
      {blockers.length > 0 && mode.kind === 'idle' && decidable && (
        <ul className="review-list review-blockers" data-testid="review-blockers">
          {blockers.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      )}
      {outcome && (
        <p
          className={outcome.error ? 'history-error' : 'field-note'}
          role={outcome.error ? 'alert' : 'status'}
          data-testid="review-outcome"
        >
          {outcome.text}
        </p>
      )}

      {review?.kind === 'ready' && (
        <Guarded what="This part">
          <BundleView
            bundle={review.bundle}
            scripts={scriptCheck?.scripts ?? []}
            commands={commands}
            read={read}
          />
        </Guarded>
      )}
    </aside>
  );
}
