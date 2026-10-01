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
  | 'derived';

/** The kinds edited through a feature form (forms.ts); a derived part has a dialog of its own. */
export type FormKind = Exclude<DialogKind, 'derived'>;

export const DIALOG_KINDS: readonly DialogKind[] = [
  'extrude',
  'revolve',
  'fillet',
  'chamfer',
  'shell',
  'hole',
  'pattern',
  'mirror',
  'derived',
];

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
