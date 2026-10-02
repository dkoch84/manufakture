# Sketches

A sketch is a flat drawing of lines, arcs, circles and text on a plane, held in shape by constraints and dimensions. Closed areas in a sketch are what later features (extrude, revolve) turn into solids; the letters of a text are closed areas too.

## Starting and leaving a sketch

- **New sketch** in the header opens a menu: **Top (XY)**, **Front (XZ)**, **Right (YZ)**, or **Selected face** when a flat face of the model is selected. The view turns to look straight at the plane, with the sketch's x axis to the right.
- **Finish sketch** saves the sketch to the part as one step: **Undo** in the header (or Ctrl+Z) takes the whole sketch back out, **Redo** (Ctrl+Y or Ctrl+Shift+Z) puts it back.
- **Cancel** leaves the sketch without saving what you changed in it.
- The [feature tree](feature-tree.md) lists the part's sketches with its other features. A double-click on a sketch (or its edit button) opens it again; finishing an edit is again one undo step.
- Finished sketches stay visible in grey, their texts as the part was built from them.

A sketch on a face of the part stores the face itself, by its name, so it follows the face when the part changes (a taller extrusion lifts a sketch on its top). Its x axis runs along the world X axis (Y for a face that faces X), and its origin is where the world origin projects onto the face. A face of an imported reference body cannot be followed; a sketch there stores the plane as it is.

## Drawing

Pick a tool in the sketch toolbar, or press its key. **Esc** drops the shape you are drawing; a second **Esc** goes back to **Select**.

| Tool             | Key | How                                                                                                  |
| ---------------- | --- | ---------------------------------------------------------------------------------------------------- |
| Line             | L   | Click the start, then each next point. Lines chain end to start. Double-click or Esc ends the chain. |
| Rectangle        | R   | Click two opposite corners.                                                                          |
| Center rectangle |     | Click the centre, then a corner. The corners stay symmetric about the centre.                        |
| Circle           | C   | Click the centre, then a point on the circle.                                                        |
| 3-point arc      | A   | Click the start, the end, then a point the arc passes through.                                       |
| Tangent arc      | G   | Click the end of a line or arc, then where the arc ends. The arc continues the curve smoothly.       |
| Center arc       |     | Click the centre, the start, then the end. The arc goes the way you moved the pointer round.         |
| Point            | P   | Click where a point goes: a hole centre for the Hole feature, or a reference to constrain to.        |
| Text             | X   | Click where the text goes (its anchor), then type it in the Text panel. See [Text](text.md).         |
| Construction     | Q   | New geometry is construction geometry (dashed). With geometry selected, it switches that geometry.   |

You can also press, drag and release instead of clicking twice. Construction geometry helps position other geometry and never becomes part of a closed area.

### Snapping and automatic constraints

While you draw, the pointer snaps and the new geometry gets the constraints the snap implies. An orange tag next to the pointer says what will be added:

- **Coincident**: over an existing point (an end, a centre, the sketch origin) the new point lands exactly on it and stays joined to it.
- **On curve**: over a line, circle, arc or one of the sketch axes, the point stays on it.
- **Horizontal** and **Vertical**: a line drawn within a few degrees of level or upright is straightened and stays so.
- **Tangent**: a line leaving the end of an arc in the arc's direction stays tangent to it.

Hold **Shift** while you click to place a point exactly where the pointer is, with no snapping and no automatic constraints.

## Constraints

Select geometry with the **Select** tool (Shift adds to the selection, Ctrl toggles), then click a constraint in the toolbar. A button is only enabled when the selection fits it.

| Constraint    | Key | Select                                              |
| ------------- | --- | --------------------------------------------------- |
| Coincident    | I   | Two points, or a point and a curve                  |
| Horizontal    | H   | One or more lines, or two points                    |
| Vertical      | V   | One or more lines, or two points                    |
| Parallel      |     | Two lines                                           |
| Perpendicular |     | Two lines                                           |
| Tangent       | T   | A line and a circle or arc, or two circles or arcs  |
| Equal         | E   | Two lines (length), or two circles or arcs (radius) |
| Midpoint      |     | A point and a line                                  |
| Fix           |     | Points: each stays where it is                      |

Constraints show as small tags next to the geometry they hold. Click a tag to select the constraint; **Delete** (or Backspace) deletes the selection. Deleting geometry also deletes the constraints on it.

## Dimensions

Pick **Dimension** (D), click what to measure, then click where the dimension should go:

- one line: its length; one circle: its diameter; one arc: its radius;
- two points: the distance between them; a point and a line: the distance to the line;
- two lines: the angle between them, or the distance between them when they are parallel.

A circle or arc picked together with something else stands for its centre.

When you place a dimension an edit box opens with the current value. Type a new value and press **Enter**, or **Esc** to keep the measured one. Double-click a dimension later to change it, and drag its label to move it.

Values are expressions, as everywhere in manufakture:

- units: `25`, `25 mm`, `1.5in`, `3/4"`, `2' 6"`, `30deg`;
- arithmetic: `40 - 2*3`, `(10 + 5)/2`;
- variables of the document: `2*#t`, `#width/3`.

A bare number is in the document's unit (inches when the document shows feet and inches). The box shows what an expression evaluates to, and says what is wrong when it cannot be used (a length where an angle is needed, a variable that does not exist, a zero length), and Enter then does nothing. A dimension with an expression shows it with its value, for example `2*#t = 10.00 mm`.

## Constraint state

The colour of the geometry says how well it is defined:

- **blue**: it can still move;
- **black**: fully defined by its constraints and dimensions;
- **red**: over-constrained.

The status bar at the bottom of the view shows the degrees of freedom left (how many independent ways the sketch can still move), **Fully constrained** when none are left, and what the current tool expects next.

With the **Select** tool you can drag points and curves. The sketch re-solves as you drag, and everything constrained moves with it: dragging a corner of a rectangle keeps it a rectangle. Fully defined geometry does not move.

### Conflicts

When a new constraint or value cannot hold together with the others, the sketch keeps its last shape and the status bar says **Over-constrained**. The side panel lists the constraints that conflict, with the one you most likely want to remove (the newest) first, and their tags turn red. Click **Delete** next to one to remove it, or **Undo the last change**. Clicking a name selects that constraint in the sketch.

A constraint that repeats what others already say (a redundant one) is shown in amber; the sketch still solves.

## Text

The **Text** tool places a text at its **anchor**; the **Text** panel in the side panel sets its string, font, size, alignment, spacing and angle. The letters are drawn as the font shapes them and fill as regions, so a text inside a rectangle shows as letter-shaped holes in it. A text is dragged, dimensioned and constrained by its anchor, like a point: click its letters to select it. Fonts, sizes for printing and embossing are in [Text](text.md).

## Importing SVG artwork

**Import SVG** in the sketch toolbar brings the paths and shapes of an SVG file into the open sketch: sign artwork, a logo, or lettering converted to paths. To make a sketch of the artwork alone, start a **New sketch** on a plane or face and import into it before drawing anything else.

1. Click **Import SVG** and choose the `.svg` file.
2. Choose what it becomes with **Import as** (below), and set the **Scale** (1 keeps the file's own size; a number or an expression such as `#k`) and where it goes: **Place** picks the point of the artwork (its bottom left corner, its centre, or the SVG page's bottom left corner) that lands on **at X**, **Y**. Lengths are in your document's units and may be expressions such as `#width / 2`.
3. The dialog shows what the file makes and its size. Click **Import**.

The import is one step: **Undo** removes all of it. It is selected afterwards, so **Delete** takes it out again too.

### One outline (the default)

The artwork becomes one **outline**, like a [text](text.md): its shapes stay exactly as the file draws them (straight lines, and curves as curves; circular and elliptical arcs as curves within 0.001 mm), placed by an **anchor** point. Drag the anchor, or dimension and constrain it like a point. Select the artwork to set its **Scale** and **Angle** in the side panel; the scale may be an expression, so a variable can resize the whole sign later.

Each shape is filled by its own **fill rule**, as the file says and as a browser shows it: with `evenodd` the inside of an "O" is a hole however its contours run, with `nonzero` (the default) it is a hole when the inner contour runs the other way round. Shapes that overlap are joined. The filled areas are regions: extrude, cut, pocket or V-carve them, pick them with **Text only** in the Extrude dialog, or put the artwork inside a plate, which then gets artwork-shaped holes, as with text.

The solver sees only the anchor, so a whole sign fits in one sketch: up to 100,000 path commands of artwork per sketch (a long word converted to paths is a few thousand). The shapes themselves are not sketch lines: to change one, edit the file and import it again, or import it as sketch geometry.

### Sketch lines, arcs and circles

For small artwork you want to edit point by point, choose **Sketch lines, arcs and circles**. The shapes become ordinary sketch geometry: straight segments stay lines, circles stay circles, and Beziers and ellipses become arcs that stay within the **Tolerance** of the curve (0.01 mm by default). A coarser tolerance makes fewer arcs. **Curves: Lines only** uses straight lines instead, which makes many more entities but lets a sketch hold larger drawings.

The geometry gets no constraints. The solver never moves geometry that no constraint touches, so it keeps its shape and place every time the model rebuilds; the status bar counts it as free (blue, under-constrained). You can drag it, or constrain parts of it like anything you drew. It is not pinned with a **Fix** per point because the sketch solver cannot hold that many constraints.

The sketch solver has a fixed amount of memory, and every arc costs it some even without constraints: about 100 arcs fit in one sketch (eight to ten letters at the default tolerance), fewer when the sketch also has many constraints. When an import would not fit, the dialog says so and offers what to do: import it as one outline, choose **Lines only**, or raise the tolerance. This mode makes at most 3,000 entities.

### What is read

**Sizes.** A file that says its width and height in real units (`width="120mm"`, as Inkscape saves it) imports at that size. Pixels are 96 to the inch, the SVG standard; some programs (older Illustrator files among them) assume 72, so such a file comes in at three quarters of its size: set the scale to 1.333, or check the size the dialog shows.

**Shapes.** Paths (every command), rectangles (rounded too), circles, ellipses, lines, polylines and polygons, under their `transform`s, groups, nested `<svg>` elements and `<use>` references, with their `fill-rule`. Hidden elements (`display="none"`), definitions, clip paths, masks and patterns are skipped. Colours and other styles are not read: every shape is filled, so a white shape drawn over others to knock them out, or a background rectangle behind the artwork, becomes a filled region too (delete such shapes in your drawing program before importing); a shape that is only stroked imports as its outline like a filled one, and a path that does not close is closed with a straight line (as an outline) or stays an open chain that bounds nothing (as sketch geometry). Text and bitmap images are not imported: convert text to paths in your drawing program first (Inkscape: **Path > Object to Path**; Illustrator: **Type > Create Outlines**). The dialog lists what it skipped.

**Safety.** SVG files and documents can come from anyone, so the import is bounded: files over 16 MB, more than 200,000 elements, nesting deeper than 256, or `<use>` references that would draw more than 800,000 elements are refused, numbers that overflow are dropped, and artwork reaching more than 1,000 m from the page's corner is refused. An outline may have at most 20,000 shapes, and a sketch's outlines 100,000 path commands together. A document stores the artwork's shapes, not the SVG file, and checks them every time it opens. Turning artwork into regions is bounded too, for all the artwork of a rebuild together: artwork too complex for that fails its sketch with a message rather than hold the rebuild up, and the sketcher shows the same message when artwork is too complex to preview.

## Keys

| Key                        | Action                                                          |
| -------------------------- | --------------------------------------------------------------- |
| S, L, R, C, A, G, P, D     | Select, Line, Rectangle, Circle, Arc, Tangent arc, Point, Dim.  |
| X                          | Text                                                            |
| Q                          | Construction                                                    |
| H, V, I, T, E              | Constraints, with geometry selected                             |
| Delete, Backspace          | Delete the selection                                            |
| Esc                        | Drop the shape in progress, leave the tool, clear the selection |
| Ctrl+Z, Ctrl+Y             | Undo and redo inside the sketch                                 |
| Shift (held while drawing) | No snapping, no automatic constraints                           |

While you are in a sketch, undo and redo step through your sketch edits; once it is finished they step through the document's history.

## Not yet

- Trim and extend.
- Dimensions along an axis only (horizontal or vertical distance) from the dimension tool, and angles bigger than 180 degrees.
- Where dimension labels were moved to is not saved with the sketch.
