// Approving an agent's branch (M8 plan T8.3b): its work merged into Main as one undoable step,
// labelled with the session, the review recorded on Main, and the branch set to approved. The
// Review view offers Approve only when its checks pass (`approveBlockers`); this checks again at
// the moment it acts, in an order that leaves no window for the agent:
//
// 1. Main opens in the editor (what is pending on the branch is saved first).
// 2. The merge is previewed onto Main as the editor has it: nothing may be dropped, and something
//    must change.
// 3. The branch head is read again: it must still be the revision the approved bundle names.
//    Writes only append, so the preview was made from exactly that revision.
// 4. The branch is set to approved, compare-and-set from submitted. A session write after step 3
//    first sets the branch back to open (also compare-and-set), so one of the two is refused; once
//    approved, a session refuses to write the branch at all.
// 5. The merge runs as one command in the editor (`mergeCommand`), so Undo takes it back whole.
//    When it cannot run, the branch goes back to submitted.
// 6. Main is saved.
// 7. A version of Main records the review (`ReviewReference`): the branch, the session and client,
//    the bundle's revision (the bundle stays with the branch, which is kept) and the label.
//
// Undo on Main takes the merge back but leaves the branch approved.
//
// When the tab closes (or the save or the record fails) after step 4, the branch is approved and
// no version of Main records it. The Review view sees that (`approvalRecorded`) and offers
// **Finish approval** (`finishing`): Main is saved first, and when its log already runs the merge
// under this approval's label (`mergedOnMain`: saved before the record failed) steps 2 and 5 are
// skipped, since a merge replayed twice would add the agent's features twice; otherwise the same
// steps, with step 4 checking the branch is still approved instead of setting it, and step 7
// skipped when a version records it meanwhile. A merge failure there leaves the branch approved.

import {
  MAIN_BRANCH,
  mergeCommand,
  type LibraryResult,
  type LogEntry,
  type MergePlan,
  type Version,
  type VersionMeta,
} from '@manufakture/library';
import type { DocumentStoreApi } from '../state/document';
import {
  approvalLabel,
  approvalRecorded,
  approvalVersionName,
  type AgentBranch,
  type ReviewSource,
} from './review';

export interface ApproveDeps {
  source: Pick<ReviewSource, 'open' | 'previewMerge' | 'setBranchReview' | 'listVersions'> & {
    createVersion(id: string, meta: VersionMeta, branch?: string): Promise<LibraryResult<Version>>;
    readLog(id: string, branch?: string): Promise<LibraryResult<LogEntry[]>>;
  };
  documentId: string;
  branch: AgentBranch;
  /** The head revision of the bundle the reviewer approves. */
  bundleRevision: number;
  /** Open Main in the editor; null when it worked, else why not. */
  openMain(): Promise<string | null>;
  /** The editor's store, on Main once `openMain` worked. */
  documents: DocumentStoreApi;
  /** Save what is pending; false when the save failed. */
  flush(): Promise<boolean>;
  /** **Finish approval** of a branch approved already, whose approval Main does not record. */
  finishing?: boolean;
}

export type ApproveResult = { ok: true; label: string } | { ok: false; message: string };

/**
 * Whether Main has the approval merge labelled `label` already: its log (saved) runs that merge
 * more often than it undoes it. The label names the agent session, and only an approval writes a
 * command under it.
 */
export async function mergedOnMain(
  source: Pick<ApproveDeps['source'], 'readLog'>,
  id: string,
  label: string,
): Promise<boolean | null> {
  const log = await source.readLog(id, MAIN_BRANCH);
  if (!log.ok) return null;
  let net = 0;
  for (const e of log.value) {
    if (e.label !== label) continue;
    net += e.cause === 'undo' ? -1 : 1;
  }
  return net > 0;
}

export async function approveBranch(deps: ApproveDeps): Promise<ApproveResult> {
  const { source, documentId: id, branch } = deps;
  const failed = (message: string): ApproveResult => ({ ok: false, message });
  const finishing = deps.finishing === true;
  const not = finishing ? 'Not finished' : 'Not approved';
  const label = approvalLabel(branch.provenance);

  const opened = await deps.openMain();
  if (opened !== null) return failed(opened);
  if (deps.documents.getState().document.id !== id) return failed('Another document is open.');

  // Finishing: Main, saved, may have the merge already (the record is what failed).
  let alreadyMerged = false;
  if (finishing) {
    if (!(await deps.flush())) return failed(`${not}: Main could not be saved.`);
    const merged = await mergedOnMain(source, id, label);
    if (merged === null) return failed(`${not}: the history of Main cannot be read.`);
    alreadyMerged = merged;
  }

  let plan: MergePlan | null = null;
  if (!alreadyMerged) {
    const main = deps.documents.getState().document;
    const preview = await source.previewMerge(id, branch.id, MAIN_BRANCH, { document: main });
    if (!preview.ok) return failed(`It cannot be merged into Main: ${preview.message}`);
    plan = preview.value;
    if (plan.dropped.length > 0) {
      return failed(
        `${not}: ${plan.dropped.length} of its changes would not apply on Main. Ask the agent to update from Main.`,
      );
    }
    if (!plan.changed) {
      if (!finishing) return failed(`${not}: Main already has everything it changed.`);
      plan = null;
    }
  }

  const head = await source.open(id, branch.id);
  if (!head.ok) return failed(`The branch cannot be read: ${head.message}`);
  if (head.value.revision !== deps.bundleRevision) {
    return failed(`${not}: the branch changed after its bundle was made.`);
  }

  const approved = await source.setBranchReview(id, branch.id, 'approved', {
    expected: finishing ? 'approved' : 'submitted',
  });
  if (!approved.ok) return failed(`${not}: ${approved.message}`);

  if (plan !== null) {
    // The preview was made on the editor's state: if it changed meanwhile, do not replace it.
    const r =
      deps.documents.getState().document === plan.before
        ? deps.documents.getState().execute(mergeCommand(plan), label)
        : null;
    if (r === null || !r.ok) {
      // A branch being finished stays approved: Finish approval can be tried again.
      if (!finishing) {
        await source.setBranchReview(id, branch.id, 'submitted', { expected: 'approved' });
      }
      return failed(
        r === null
          ? `${not}: Main changed while the merge was prepared. Try again.`
          : `${not}: It cannot be merged into Main: ${r.error.message}`,
      );
    }
  }
  if (!(await deps.flush())) {
    return failed(
      'Approved and merged, but Main could not be saved yet, so the review is not recorded on it. Finish approval in the Review view records it; Undo takes the merge back.',
    );
  }
  if (finishing && (await approvalRecorded(source, id, branch.id)) === true) {
    return { ok: true, label };
  }
  const version = await source.createVersion(
    id,
    {
      name: approvalVersionName(branch),
      description: label,
      review: {
        branch: branch.id,
        sessionId: branch.provenance.sessionId,
        clientName: branch.provenance.clientName,
        bundleRevision: deps.bundleRevision,
        label,
      },
    },
    MAIN_BRANCH,
  );
  if (!version.ok) {
    return failed(
      `Approved and merged, but the review could not be recorded: ${version.message}. Finish approval in the Review view records it.`,
    );
  }
  return { ok: true, label };
}
