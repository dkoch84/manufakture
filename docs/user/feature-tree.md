# The feature tree

The panel on the left lists the part's features in the order they are built: sketches, extrusions, fillets and so on, each with an icon for its kind, its name and a mark for how it built. The part is rebuilt from this list after every change, and the list shows the result.

A new document is empty; the 3D view says so and suggests **New sketch**. While a sketch is open the tree steps aside, since nothing in it can change until the sketch is finished or cancelled.

## Status marks

| Mark                | Meaning                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------- |
| Tick                | Built.                                                                                  |
| Triangle            | Built, with warnings (for example a reference that was found by position, not by name). |
| Cross, red name     | Failed: the feature is skipped and the part passes through it unchanged.                |
| Arrow, red name     | Not built, because a feature it depends on failed or is suppressed.                     |
| Crossed-out circle  | Suppressed: left out of the part on purpose.                                            |
| Grey, below the bar | After the rollback bar: not built.                                                      |
| Dashed circle       | Being rebuilt. The part keeps showing the last result until the new one is ready.       |

Point at a mark (or focus it and press Enter) to see what went wrong: the message from the rebuild or the geometry kernel, with every warning. A failed feature later in the list does not stop the features that do not depend on it; they still build on the part as it is.

## Working with features

- **Click** a feature to select it; Shift adds to the selection and Ctrl toggles. A selected sketch is what **Extrude**, **Revolve** and **Hole** start from, and selected extrusions, revolves and holes are what **Pattern** and **Mirror** repeat.
- **Hover** a feature to highlight it in the 3D view: the faces it made, or a sketch's curves.
- **Double-click** a feature (or press Enter) to edit it: a sketch opens in the sketcher, any other feature opens its dialog (see [Features](features.md)).
- **Rename** with the rename button on the row or F2. Enter keeps the new name, Escape keeps the old one.
- **Suppress** with the button on the row to leave a feature out of the part without deleting it; the same button brings it back. Features that depend on a suppressed one show the arrow mark.
- **Delete** with the button on the row or the Delete key. When other features are built from it (an extrusion of the sketch, a fillet on the extrusion's edges), the tree names them and asks first; they are deleted with it, as one step.

The buttons on a row appear when you point at it, focus it or select it.

## Reordering

Drag a feature up or down the list. A line shows where it will go. A move the part cannot take, such as a fillet above the extrusion whose edges it rounds, is refused: the line turns red while you drag, and after you let go the tree says which feature is in the way. With the keyboard, Alt+Up and Alt+Down move the focused feature one place.

## The rollback bar

The blue bar under the last feature marks how far the part is built. Drag it up to see the part as it was at that point; features below the bar turn grey and are not built. New features go in at the bar, so you can add a feature in the middle of the history and drag the bar back down to see the part with it. The bar also moves with the keyboard: focus it, then Up, Down, Home (the start) or End (after the last feature).

## Lost references

A fillet, chamfer, shell or pattern keeps the faces and edges it uses by name. When an edit earlier in the list removes one (a changed sketch no longer makes that side), the feature fails and its message says which reference is gone. The message has a **Re-pick** button: it opens the feature's dialog with the lost face or edge marked in red, and the next face or edge you click in the 3D view takes its place.

## Undo

Every action in the tree (a move, a suppression, a rename, a deletion, a move of the rollback bar) is one step for **Undo** (Ctrl+Z) and **Redo** (Ctrl+Y or Ctrl+Shift+Z), like every other change to the document.
