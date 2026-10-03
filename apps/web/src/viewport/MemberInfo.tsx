// The info panel of a picked framing member (ADR 0015 decision 4): its stock, blank length and
// cuts, read from the member data regen sent (members have no B-rep, so nothing is measured;
// the measure tool works on layer bodies only). Shown over the viewport for the last member
// selected, in the document's display units.

import type { DisplayUnits } from '@manufakture/core';
import { useStore } from 'zustand';
import { formatAngleIn, formatLengthIn } from '../measure/format';
import type { DocumentStoreApi } from '../state/document';
import type { SelectionStore } from '../state/selection';
import { describeCut, findMember, isMemberRef, roleLabel, type CutSummary } from './members';
import { shownMemberView, type MemberStore } from './memberStore';

export interface MemberInfoProps {
  selection: SelectionStore;
  members: MemberStore;
  documents: DocumentStoreApi;
}

function cutText(cut: CutSummary, units: DisplayUnits): string {
  if (cut.kind === 'notch') return 'Notch (birdsmouth)';
  if (cut.kind === 'face') return 'Face cut (seat or rip)';
  const angle = cut.angle ?? 0;
  return angle < 1e-6 ? 'Square end cut' : `End cut, ${formatAngleIn(angle, units)} off square`;
}

export function MemberInfo({ selection, members, documents }: MemberInfoProps) {
  const selected = useStore(selection, (s) => s.selected);
  const view = useStore(members, shownMemberView);
  const units = useStore(documents, (s) => s.document.units);
  const ref = [...selected].reverse().find(isMemberRef);
  if (!ref) return null;
  const found = findMember(view, ref.id);
  if (!found) return null;
  const { member, set } = found;
  const len = (mm: number) => formatLengthIn(mm, units);
  const cuts = member.cuts.map(describeCut);
  return (
    <aside className="member-info" data-testid="member-info" aria-label="Member">
      <h2>{roleLabel(member.role)}</h2>
      <dl>
        <dt>Member</dt>
        <dd data-testid="member-info-id">{ref.id}</dd>
        <dt>Stock</dt>
        <dd data-testid="member-info-stock">
          {member.stock.name} ({len(member.stock.width)} x {len(member.stock.depth)})
        </dd>
        <dt>Length</dt>
        <dd data-testid="member-info-length">{len(member.length)}</dd>
        <dt>Cuts</dt>
        <dd data-testid="member-info-cuts">
          {cuts.length === 0 ? (
            'None (square ends)'
          ) : (
            <ul>
              {cuts.map((c, i) => (
                <li key={i}>{cutText(c, units)}</li>
              ))}
            </ul>
          )}
        </dd>
        <dt>Framed with</dt>
        <dd>{set.group}</dd>
      </dl>
    </aside>
  );
}
