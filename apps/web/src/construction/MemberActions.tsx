// Actions on the framing member picked in the view (ADR 0015 decision 6): delete it, change its
// stock (lumber, with the M4 stock picker), or put it back as framed. Each is one undo step, a
// change to the overrides of the wall or opening that owns the member. The member's data (stock,
// length, cuts) is in the info panel over the view.

import { splitMemberFullId } from '@manufakture/domain-construction';
import { findStock } from '@manufakture/stock';
import { useState } from 'react';
import { useStore } from 'zustand';
import type { ModelStore } from '../model/model';
import type { DocumentStoreApi } from '../state/document';
import type { SelectionStore } from '../state/selection';
import { isMemberRef } from '../viewport/members';
import type { MemberStore } from '../viewport/memberStore';
import { StockPicker } from '../wood/StockPicker';
import {
  memberActionCommand,
  memberContext,
  memberOwner,
  type MemberAction,
} from './memberActions';

export function MemberActions({
  documents,
  model,
  members,
  selection,
  partId,
  disabled,
}: {
  documents: DocumentStoreApi;
  model: ModelStore;
  members: MemberStore;
  selection: SelectionStore;
  partId: string;
  disabled: boolean;
}) {
  const selected = useStore(selection, (s) => s.selected);
  const doc = useStore(documents, (s) => s.document);
  // Re-read the context when a regen lands: an override may have moved to or from this member.
  useStore(model, (s) => s.parts);
  useStore(members, (s) => s.parts);
  const ref = [...selected].reverse().find(isMemberRef);
  const split = ref ? splitMemberFullId(ref.id) : undefined;
  const context = split ? memberContext(model, members, partId, split.owner, split.id) : {};
  const owner = ref ? memberOwner(doc, partId, ref.id, context.listed) : null;
  const [stock, setStock] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  if (!ref || !owner) return null;
  const act = (action: MemberAction) => {
    const r = memberActionCommand(documents.getState().document, partId, ref.id, action, context);
    if (!r.ok) {
      setMessage(r.message);
      return;
    }
    const done = documents.getState().execute(r.command, r.label);
    // A deleted member stays selected (though gone from the view), so Restore is at hand.
    setMessage(done.ok ? null : done.error.message);
  };
  const o = owner.override;
  const state = o?.delete
    ? 'Deleted (shown again with Restore)'
    : o?.stock
      ? `Stock changed to ${findStock(o.stock)?.name ?? o.stock}`
      : 'As framed';
  // A change made for another id that the layout change moved here, or one that holds this
  // member's id but no longer applies to it.
  const note =
    o && owner.status === 'moved' && o.id !== owner.localId
      ? ` This is the change made for ${o.id}: the layout changed and it moved here.`
      : owner.heldBy !== undefined
        ? ` An earlier change made for ${owner.localId} no longer applies to it (${owner.heldStatus ?? 'lost'}); Restore removes it.`
        : '';
  return (
    <section className="construction-section" aria-label="Member" data-testid="member-actions">
      <h3>Member {ref.id}</h3>
      <p className="field-note" data-testid="member-actions-state">
        Of {owner.feature.name}. {state}.{note}
      </p>
      <div className="construction-row">
        <button
          type="button"
          data-testid="member-delete"
          disabled={disabled}
          onClick={() => act({ kind: 'delete' })}
        >
          Delete member
        </button>
        {(o || owner.heldBy !== undefined) && (
          <button
            type="button"
            data-testid="member-restore"
            disabled={disabled}
            onClick={() => act({ kind: 'restore' })}
          >
            Restore
          </button>
        )}
      </div>
      <StockPicker
        value={stock}
        units={doc.units}
        only="lumber"
        label="Change its stock to"
        testId="member-stock"
        onChange={setStock}
      />
      <button
        type="button"
        data-testid="member-stock-apply"
        disabled={disabled || stock === ''}
        onClick={() => act({ kind: 'stock', stock })}
      >
        Change stock
      </button>
      {message && (
        <p className="field-error" role="alert">
          {message}
        </p>
      )}
    </section>
  );
}
