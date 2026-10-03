// The short "not an engineering tool" text (ADR 0015 decision 8), exported by the construction
// domain and shown as it is: once per document, at the top of the Construction panel (the tools
// that open from it do not repeat it), until the user puts it away for that document, and always
// in the construction help. The long form opens docs/user/construction.md.

import { DISCLAIMER_SHORT } from '@manufakture/domain-construction';
import { useStore } from 'zustand';
import type { ConstructionUiStore } from './state';

export function DisclaimerNotice({
  ui,
  documentId,
}: {
  ui: ConstructionUiStore;
  documentId: string;
}) {
  const hidden = useStore(ui, (s) => s.noticeHidden.has(documentId));
  if (hidden) return null;
  return (
    <div className="construction-notice" role="note" data-testid="construction-disclaimer">
      <p>{DISCLAIMER_SHORT}</p>
      <button
        type="button"
        data-testid="construction-disclaimer-hide"
        title="Put this notice away for this document; Help shows it again"
        onClick={() => ui.getState().hideNotice(documentId)}
      >
        Got it
      </button>
    </div>
  );
}

export function ConstructionHelp() {
  return (
    <details className="construction-help" data-testid="construction-help">
      <summary>Help</summary>
      <p data-testid="construction-help-disclaimer">{DISCLAIMER_SHORT}</p>
      <ul>
        <li>
          <strong>Levels</strong> are the heights walls stand on; each has a default wall height.
        </li>
        <li>
          <strong>Wall types</strong> are layer stacks, outside to inside: siding, sheathing, the
          studs, drywall. You choose the stud stock, spacing, plates and the default header.
        </li>
        <li>
          <strong>Wall</strong> draws a wall on the active level: type each length and pick its
          direction in 90 degree steps, or click points (they snap to wall ends, square to the last
          point and to the grid). Close the loop for a building outline.
        </li>
        <li>
          <strong>Opening</strong> places a door or window in a wall by its rough opening. Its
          header is the one you set on it, else your narrowest header rule wide enough, else the
          wall type&apos;s default; new documents have no header rules.
        </li>
        <li>Pick a member in the view to delete it or change its stock.</li>
      </ul>
      <p>The user guide has more: Construction (docs/user/construction.md).</p>
    </details>
  );
}
