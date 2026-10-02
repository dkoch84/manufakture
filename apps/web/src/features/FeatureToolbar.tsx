// The feature buttons in the header: each opens its dialog for a new feature, added at the
// rollback bar. Board (a board cut from real stock, M4) sits beside Extrude, which it builds on.

import { Fragment } from 'react';
import { KIND_LABELS } from '../tree/tree';
import { BoardIcon, KindIcon } from '../tree/icons';
import { DIALOG_KINDS, type DialogKind, type ToolKind } from './kinds';

const TITLES: Record<DialogKind, string> = {
  extrude: 'Extrude a sketch (select it in the feature tree first, or choose it in the dialog)',
  revolve: 'Revolve a sketch about an axis',
  fillet: 'Round edges',
  chamfer: 'Bevel edges',
  shell: 'Hollow the part, removing faces',
  hole: 'Drill holes at sketch points',
  pattern: 'Repeat features or the body in a row or around an axis',
  mirror: 'Mirror features or the body about a face',
  thread: 'Thread a shaft or a hole (pick its round face)',
  derived: 'Insert the bodies of a part from a version of a document',
};

/** Button text where the tree's kind label is too short to say what the tool does. */
const BUTTON_TEXT: Partial<Record<DialogKind, string>> = { derived: 'Derived part' };

export function FeatureToolbar({
  disabled,
  onOpen,
}: {
  disabled: boolean;
  onOpen: (kind: ToolKind) => void;
}) {
  return (
    <div className="toolbar-group feature-toolbar" role="toolbar" aria-label="Features">
      {DIALOG_KINDS.map((kind) => (
        <Fragment key={kind}>
          <button
            type="button"
            disabled={disabled}
            title={TITLES[kind]}
            onClick={() => onOpen(kind)}
          >
            <KindIcon kind={kind} />
            {BUTTON_TEXT[kind] ?? KIND_LABELS[kind]}
          </button>
          {kind === 'extrude' && (
            <button
              type="button"
              disabled={disabled}
              title="A board from real stock: a panel from a sketch region, or a stick along a sketch line"
              onClick={() => onOpen('board')}
            >
              <BoardIcon />
              Board
            </button>
          )}
        </Fragment>
      ))}
    </div>
  );
}
