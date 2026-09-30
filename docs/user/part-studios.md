# Part studios

A document can hold several part studios: separate parts, each with its own features and bodies, that share the document's [variables](variables.md). A bracket and its lid, or the pieces of a small assembly, can live in one document and follow the same `#thickness`.

A new document has one part studio, **Part 1**.

## The tabs

The part studios are the tabs along the bottom of the editor, in document order. The tab that is active is the one you work on:

- the [feature tree](feature-tree.md) lists its features;
- the 3D view shows its bodies only, and measuring, the material and new sketches and features apply to it;
- the page address names it (`?part=...`, left out for the first tab), so reloading the page opens the same tab again.

Every part studio is kept built, whichever tab is active, so switching tabs rebuilds nothing.

While a sketch or a feature dialog is open, the other tabs cannot be chosen: finish or cancel it first.

## Adding, renaming, moving and removing

| Action    | How                                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Add       | **+** after the tabs. The new part studio is empty, named "Part n", and becomes the active tab.                                         |
| Rename    | Double-click a tab, press F2 on it, or **Rename** for the active one. Enter keeps the new name, Escape the old one.                     |
| Duplicate | **Duplicate** copies the active part studio, features, body names, colours and materials included, into a new tab just after it.        |
| Move      | Drag a tab onto another one, or press Alt+Left or Alt+Right on it.                                                                      |
| Delete    | **Delete** removes the active part studio. The last one cannot be deleted, nor one whose features a configuration parameter suppresses. |

Arrow keys move between tabs. A copy is independent: editing one leaves the other as it was.

Every one of these is a step you can undo.

## Undo across tabs

Undo and redo work on the whole document, not on one tab. When the step being undone or redone changed another part studio, that tab becomes active, so you see what changed. Undoing the step that added a part studio removes it, and the tab next to it becomes active.

## In files

All part studios are saved with the document and travel in its `.mfk` file (see [Documents and files](files.md)). Each part studio keeps its own feature numbering, so a duplicate has the same feature names and ids as the original.
