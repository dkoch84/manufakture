# Printing: the Print workspace

The **Print** workspace shows your part the way a 3D printer will see it: on the printer's bed, turned the way you will print it, with what may print badly coloured in the view and listed beside it. It does not slice or print anything; it helps you choose an orientation and catch problems before you export for the slicer.

Open it with **Print** in the toolbar at the top; press it again to go back to modelling. While it is open the feature tree and the modelling tools step aside, and the view shows only what the active print setup prints.

## Print setups

A **print setup** is one plate: a printer, a nozzle, the parts to print and how each sits on the bed. A document can have several (a plate in PLA and one in PETG, say); pick one in the list at the top of the **Print** panel. **New setup** starts one on a **Bambu Lab X1 Carbon with a 0.4 mm nozzle**.

- **Name**: type and press Enter.
- **Printer**: every Bambu Lab printer the app knows. The build volume and any area the printer will not print on come from OrcaSlicer's printer profiles, so they are what your slicer enforces. The X1 and P1 printers, for instance, exclude an 18 x 28 mm corner at the bed's origin, and their height is 250 mm (Bambu Lab advertises 256).
- **Nozzle**: the sizes the printer is sold with. The nozzle sets the default thresholds below.
- **Delete setup** removes the setup and its items. Undo brings it back.

Setups are saved in the document and come back when you reopen it. Every change (a printer, an item, an orientation) is one step for Undo and Redo, and the version history lists setups that differ. A setup never changes the part: editing a print setup does not rebuild anything.

## Items: what to print

The **Items** list says what is on the plate. Pick a part studio, and either **All bodies** or one body, then **Add item**. Each item has:

- **Body**: change which body it prints.
- **Copies**: how many. Type a number and press Enter or leave the field; each change is one undo step. Copies are laid out in a row on the plate, 5 mm apart, centred on the bed. That layout is only a preview: the slicer arranges the plate for real, so the row may run off the bed without anything failing.
- **Remove**.

Click an item's name to make it the **active item**: the orientation tools act on it.

**When a body or face goes away.** You can always edit or delete the features that made a body or face an item names. The item then says **Reference lost** and what is missing, and offers a re-pick: another body from its **Body** list, or **Pick a face** to lay it flat again. Nothing else breaks.

A setup that names a printer this version of the app does not know (a document from a newer version) still opens; the panel says so and checks nothing until you pick a printer.

## Orienting an item

The toolbar acts on the active item:

- **Lay flat on face**: press it, then click a flat face of the item in the view. The item turns so that face lies on the bed. Only planar faces work; the panel says so if you click a curved one. Clicking an issue in the list instead lets go of the tool.
- **X 90°**, **Y 90°**, **Z 90°**: a quarter turn about the bed's axis, after the orientation the item has now. A turn about Z on a laid-flat item turns it on the bed and keeps the face it lies on.
- **Reset**: back to the item as modelled.

However it is turned, the item is always dropped onto the bed, with its lowest point at the bed's surface, as the slicer does when it loads a part. The orientation is stored as angles (expressions, so a variable works too) or as the face it lies on, never as a copy of the geometry. Picking in the view still picks the part's own faces, wherever the item sits.

## What the checks look for

The checks say what **may print badly**, never what will fail: most of the limits are estimates. Each has a default from the nozzle, and you can set your own per setup under **Thresholds** (expressions, so `#wall / 2` works). An empty field uses the default.

| Check             | Default at a 0.4 mm nozzle | Where it comes from                                                                                                                           |
| ----------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Overhang angle    | 60° from vertical          | OrcaSlicer's support threshold angle of 30°, converted (see below)                                                                            |
| Too thin to print | 0.1 mm                     | OrcaSlicer's minimum feature size, 25% of the nozzle: thinner features are not printed at all. Not editable separately; it follows the nozzle |
| Minimum wall      | 0.84 mm                    | Two line widths: a wall that holds two perimeters. An estimate                                                                                |
| Minimum gap       | 0.2 mm                     | An estimate: narrower gaps between walls may fuse                                                                                             |
| Minimum hole      | 0.8 mm                     | Two nozzle widths. An estimate: smaller holes may close up                                                                                    |
| Teardrop size     | 3 mm                       | An estimate: a hole lying horizontal and wider than this needs a teardrop shape or support at its top                                         |

### The angle convention: from vertical

Overhang angles are measured **from vertical**: a vertical wall is 0°, the underside of a 45° chamfer is 45°, a flat ceiling facing straight down is 90°. That is the familiar "45 degree rule". A surface overhangs when it is **steeper than** the threshold; one exactly at the threshold does not.

OrcaSlicer (and Bambu Studio) state the same limit **from horizontal**, as the **support threshold angle**. The two add up to 90°:

> threshold from vertical = 90° minus OrcaSlicer's support threshold angle

OrcaSlicer's default of 30° is therefore 60° here. If you change the support threshold angle in your slicer profile, set the overhang angle here to 90° minus it.

## The view: build volume and shading

The view draws the printer's build volume as a wireframe box: the plate outline at the bottom, the printable height at the top, and areas the printer will not print on crossed out in red. The bodies sit where the preview puts them.

The three buttons on the right of the toolbar colour the faces:

- **Normal**: the bodies in their own colours.
- **Overhang** (the default): faces coloured by how steeply they face down, worked out on the graphics card from the orientation every time the view is drawn.
  - dark red: a flat ceiling, facing straight down, that needs a bridge or support;
  - red: an overhang, steeper than the threshold;
  - amber: within 10° below the threshold (an estimate of where it starts to get rough);
  - blue: resting on the bed.
- **Thickness**: a heat map of wall thickness, from the wall check below: dark red for features too thin to print, red to orange for walls under the minimum, yellow to green for walls up to three times the minimum, and the body's own colour beyond that.

A legend under the Issues list names the colours of the mode shown.

## The Issues list

The **Issues** list names each problem with its worst value and the item it is on:

- **Does not fit the bed**, with the axis and how far it overshoots (`x 20.00 mm`), or the excluded area it cannot get clear of. Each item is checked on its own, one copy alone on the plate, wherever it fits: centred, against an edge, or pushed clear of an excluded area (a 240 x 220 mm part on an X1 Carbon fits beside the excluded corner, not centred over it). Where the preview row puts it does not matter. The line above the thresholds says whether every item fits. A part that does not fit the bed needs another orientation or a bigger printer.

  When all the copies of all the items together need more room than the plate has (an estimate from their footprints, 5 mm apart), a note under that line says so. It is only a note: each part still fits, and the slicer can put the rest on another plate.

- **Overhang**: the area steeper than the threshold, and the steepest angle.
- **Too thin to print**, **Thin wall**: the area thinner than the limit, and the thinnest wall.
- **Narrow gap**: the area facing a gap narrower than the minimum, between walls of one body or of different bodies on the plate, and the narrowest gap.
- **Small hole**: a hole below the minimum hole, with its diameter.
- **Horizontal hole: teardrop or support**: a hole lying flat on its side and wider than the teardrop size.

Click an issue to select what it is about and zoom the view to it; click it again to let go. A hole that a slot or a cross hole cuts into several faces is one entry, and its click selects all of them.

Everything is checked again after every change to the part or the orientation. Overhangs, bed fit and holes are quick and update at once. Walls and gaps take longer, so they run in the background a quarter of a second after you stop editing (the list says "checking walls and gaps..." meanwhile), and each new change replaces the check before it. Until a check of the mesh now drawn comes back (after an edit, or when the finer export mesh replaces the coarse one), the thickness view shows those bodies in their own colour rather than the old mesh's values. Closing the workspace stops a check on its way.

## Limits

- **Meshes**: overhangs, walls and gaps are measured on the part's triangle mesh at the export tolerance (0.02 mm, the `normal` preset in [Importing and exporting](import-export.md)), the mesh the slicer gets. Until that mesh is ready (a moment after each change), or when the geometry kernel is not loaded, the view's own coarser mesh (0.1 mm) is checked. Hole sizes and directions come from the exact geometry.
- **Wall thickness** is measured straight through the wall, from each small piece of the surface. Where two walls meet at a sharp angle (a knife edge), the tip reads thin, which it is. Walls thicker than 10 mm read as thick enough.
- **Threads**: a modelled thread's hole or shaft is not checked as a hole or pin; a cosmetic thread (just the tap drill hole) is.
- **Fillets and slot ends** are curved but not holes, and are not checked as holes.
- **Two-nozzle printers** (the H2D, H2D Pro and X2D): an item whose bodies have two or more colours must fit the area both nozzles reach; one colour, the whole bed. Which filament goes to which nozzle is decided in the slicer.
- **Not modelled**: excluded areas that differ by build plate, and the clog and wrap detection zones some Bambu Lab printers add when those features are on.

## Fits

**Insert fit variables** in the Variables panel (shown under the Print panel while the workspace is open) takes its clearances from the **active setup's** printer and nozzle. See [Fits for printed parts](fits.md).
