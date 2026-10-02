# Drawings

A **drawing** is a set of paper sheets showing a part studio or an assembly in views, with dimensions and notes: the drawing you take to the workshop or send to someone who makes the part. Views are computed from the model whenever it changes, so a drawing is never out of date, and dimensions measure the model itself: change a variable and every dimension that depends on it shows the new value.

## Drawing tabs

Drawings have their own tabs, to the right of the part studio and assembly tabs at the bottom of the editor. **+ Drawing** opens the **New drawing** form:

- **Name** of the drawing ("Drawing 1" unless you type another).
- **Sheet size**: A4 to A0, Letter, Tabloid, or **Custom** with a width and a height (expressions, so `#width + 100` works).
- **Orientation**: landscape or portrait.
- **Title block**: on by default, with **Title** (the document's name to start with), **Drawn by**, **Date** and **Material**.

**Create** adds the drawing, opens it and shows the Insert view panel. The drawing is shown over the part studio; click a part studio or assembly tab to go back to the model, and the drawing's tab to come back. Double-click a drawing tab (or **Rename**) to rename it; **Delete** removes the open drawing with its sheets. Every change in a drawing is one step for **Undo**, and a drawing is saved with the document.

## Sheets

The buttons at the left of the drawing toolbar are the drawing's sheets. **+ Sheet** adds another sheet of the same size, orientation and title block; **Delete sheet** removes the one shown (a drawing keeps at least one). The **Sheet** section of the side panel changes the sheet's name, size and orientation, turns its title block on or off and edits the title block's fields; a field commits when you press Enter or leave it.

**-**, **Fit** and **+** zoom the sheet.

## Views

**Insert view** opens the Insert view panel:

- **Of**: a part studio of this document, an assembly, or one of an assembly's exploded views (see [Assemblies](assemblies.md)). For a part studio with several bodies you can tick the bodies to show; none ticked shows them all.
- **Direction**: Front, Back, Left, Right, Top, Bottom or Isometric. Models are Z up: the front view looks along +Y, the top view down.
- **Scale**: `1:1`, `1:5`, `2:1`, or an imperial scale such as `1-1/2" = 1'` or `3/4" = 1'`.
- **Hidden lines** (drawn dashed) and **Tangent edges** (where a round meets a flat face, drawn thin).

**Insert** places the view on the sheet. Click a view to select it (a dashed box shows round it); drag it to move it. The **View** section of the side panel changes its direction, scale and lines, and **Delete view** removes it with its dimensions and notes.

**Project a view from it** adds a view aligned with the selected one, third angle: **Top** puts the top view above it, **Right** the right view to its right, and so on, at the same scale, on the same row or column. A view keeps its place on the paper when the model changes: it is anchored at the model's origin.

## Dimensions

Choose the kind next to **Dimension** (Horizontal, Vertical, Aligned, Radius, Diameter or Angle), or click **Dimension** to use the one shown. Then, in one view:

1. Click the first edge or vertex. A vertex near the click wins over the edges through it; where two edges lie on top of each other in the view (the front and back edge of a box seen from the front), the one nearer you is taken.
2. For a linear or angle dimension, click the second one. Radius and diameter take one circular edge, or a cylinder seen from the side (the dimension goes between its two outlines).
3. Click where the dimension goes. The dimension line (or, for a radius, diameter or angle, the value) lands at the click.

The status line under the toolbar says what to click next; **Escape** drops what you picked. A linear dimension anchors as the model does: a vertex at itself, a straight edge at its middle, a circular edge at its centre.

Values are shown in the document's display units, in fractions for an inch document with fraction display. To move a dimension, choose **Select** and drag it by its line or value. Nothing moves dimensions or notes out of each other's way: place them where they read best.

A dimension stores what it measures (the edges and vertices by their names), not a number. The **Dimensions** list in the side panel shows each one with its value and status: **OK**, **Warning** (the value is foreshortened in this view, say), or in red **Lost: re-pick** when an edit removed what it measured. **Re-pick** asks for new edges or vertices and keeps where the dimension was placed. A lost dimension is not drawn, and does not stop you from editing the model.

## Notes

Type the text in **Note text**, then click on the sheet where it goes. A note placed on a view moves with the view. Select a note to edit its text or delete it, and drag it to move it.

## Exporting and printing

- **SVG**: the sheet shown, at paper size in millimetres. It is the same picture the screen shows.
- **DXF**: the sheet shown, in millimetres, one layer per kind of line (visible, hidden, centre, dimension, text and so on), hidden lines with the HIDDEN linetype.
- **PDF**: every sheet of the drawing, a page each, at paper size, with the standard Helvetica font.
- **Print**: the sheet shown, through the browser's print dialog; choose a paper size that matches the sheet and no scaling to print to scale.

When a sheet cannot be laid out (a custom size that is not a positive length, say), the export says so and the **Problems** section of the side panel says why.

## What drawings change elsewhere

- **Variables**: a variable used in a drawing (a custom sheet size, a view's scale) lists that use under **Used in** in the Variables panel, and cannot be deleted while it is used, like any other use; **Replace with value and delete** writes its value into the drawing too.
- **Assemblies**: deleting an instance that a drawing dimension measures asks first and names the dimensions; **Delete anyway** deletes it, and those dimensions show as lost until you re-pick them.
- **Part studios and assemblies** that a drawing view shows cannot be deleted until the view is deleted.
