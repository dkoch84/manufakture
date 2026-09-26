// The feature buttons in the header: each opens its dialog for a new feature, added at the
// rollback bar.

import { KIND_LABELS } from '../tree/tree';
import { KindIcon } from '../tree/icons';
import { DIALOG_KINDS, type DialogKind } from './kinds';

const TITLES: Record<DialogKind, string> = {
  extrude: 'Extrude a sketch (select it in the feature tree first, or choose it in the dialog)',
  revolve: 'Revolve a sketch about an axis',
  fillet: 'Round edges',
  chamfer: 'Bevel edges',
  shell: 'Hollow the part, removing faces',
  hole: 'Drill holes at sketch points',
  pattern: 'Repeat features or the body in a row or around an axis',
  mirror: 'Mirror features or the body about a face',
};

export function FeatureToolbar({
  disabled,
  onOpen,
}: {
  disabled: boolean;
  onOpen: (kind: DialogKind) => void;
}) {
  return (
    <div className="toolbar-group feature-toolbar" role="toolbar" aria-label="Features">
      {DIALOG_KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          disabled={disabled}
          title={TITLES[kind]}
          onClick={() => onOpen(kind)}
        >
          <KindIcon kind={kind} />
          {KIND_LABELS[kind]}
        </button>
      ))}
    </div>
  );
}
