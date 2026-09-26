# Features

The row under the header holds the part features: **Extrude**, **Revolve**, **Fillet**, **Chamfer**, **Shell**, **Hole**, **Pattern** and **Mirror**. Each opens its dialog in the side panel. A new feature goes in at the rollback bar of the [feature tree](feature-tree.md); a double-click on a feature in the tree opens the same dialog to change it.

**OK** (or Enter in a field) applies the dialog as one step for Undo; **Cancel** (or Escape) leaves the part as it was. When something is missing or wrong, the dialog stays open and says what, next to the field.

## Numbers

Every number is typed as an expression: `12`, `12.5 mm`, `1/4"`, `2*#thickness + 1`. A plain number is in the document's units. Under the field, the dialog shows what the expression comes to, or why it cannot be used (a length in an angle field, an unknown variable). What you typed is kept, so an expression that uses a variable follows the variable.

## Faces and edges

A field such as **Edges** or **Faces to remove** is filled from the 3D view: while it is active (outlined in blue), every face or edge you click goes into it. Click the field to make it the active one when a dialog has more than one. **Remove** takes an entry out. Faces and edges selected before you open a new feature's dialog go straight into its field, so you can pick first and choose the tool afterwards.

Only faces and edges of the part can be used; the faces of an imported reference body cannot. The dialog stores each by the names the modelling history gives it (like `extrude#1:cap:end`), not by position, so it stays on the same face or edge when the part changes.

## The dialogs

- **Extrude**: a sketch (every closed region of it) pushed out of its plane. **Result** says what happens to the part: a new body (the default for the first), added to it, removed from it (a cut) or intersected with it. **End**: a depth, a depth split evenly to both sides, through the whole part, or up to a picked flat face. **Opposite direction** flips it; the optional **Draft angle** tapers the sides.
- **Revolve**: a sketch turned about an axis, a line of the same sketch or a straight edge of the part. **Angle** is up to a full turn; **Symmetric** splits it to both sides.
- **Fillet**: rounds the picked edges with a radius.
- **Chamfer**: bevels the picked edges, by one distance, by two, or by a distance and an angle.
- **Shell**: hollows the part with a wall thickness, removing the picked faces to open it; with none it becomes a closed hollow. **Grow the wall outward** keeps the inside as it is.
- **Hole**: a hole at every chosen point of a sketch (draw them with the sketcher's **Point** tool). **Size** fills the diameter from the standard clearance holes (M3 to M12, #6 to 1/2") for the chosen fit, and the counterbore or countersink sizes for the head; pick **Custom** to type your own.
- **Pattern**: copies of the chosen extrusions, revolves and holes (or the whole body) in a row along a picked edge or face, or around an axis. The count includes the original.
- **Mirror**: the chosen features (or the whole body) mirrored about a picked flat face.

A feature that cannot be built (a fillet wider than the faces beside the edge, for example) is still added: it shows a red cross in the tree, with the reason, and the part passes through it unchanged until it is fixed.
