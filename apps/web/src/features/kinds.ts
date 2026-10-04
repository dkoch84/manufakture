// The feature kinds that have a dialog. Apart from the dialogs themselves, which load on first
// use, so the toolbar and the feature tree can name them without loading the forms.

export type DialogKind =
  | 'extrude'
  | 'revolve'
  | 'fillet'
  | 'chamfer'
  | 'shell'
  | 'hole'
  | 'pattern'
  | 'mirror'
  | 'thread'
  | 'derived'
  | 'scripted';

/**
 * The kinds edited through a feature form (forms.ts); a derived part and a scripted feature have
 * dialogs of their own (DerivedDialog.tsx, ScriptedDialog.tsx).
 */
export type FormKind = Exclude<DialogKind, 'derived' | 'scripted'>;

export const DIALOG_KINDS: readonly DialogKind[] = [
  'extrude',
  'revolve',
  'fillet',
  'chamfer',
  'shell',
  'hole',
  'pattern',
  'mirror',
  'thread',
  'derived',
  'scripted',
];

/**
 * What a toolbar button opens: a feature dialog, the Board dialog (a `wood.board` extension) or the
 * Joint dialog (a `wood.joint` extension).
 */
export type ToolKind = DialogKind | 'board' | 'joint';

export function isDialogKind(kind: string): kind is DialogKind {
  return (DIALOG_KINDS as readonly string[]).includes(kind);
}

/** The dialog kinds whose features can take a `scope` (which bodies they act on). */
export const SCOPED_KINDS: readonly DialogKind[] = [
  'extrude',
  'revolve',
  'hole',
  'pattern',
  'mirror',
  'derived',
];
