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
- **Copies**: how many. Type a number and press Enter or leave the field; each change is one undo step. In the view, copies are laid out in a row on the plate, 5 mm apart, centred on the bed. That row is only a preview and may run off the bed without anything failing; [Export for printing](#export-for-printing) packs the copies onto the plate properly.
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

- **Does not fit the bed**, with the axis and how far it overshoots (`x 20.00 mm`), or, for a part small enough to fit somewhere, the excluded area it cannot get clear of. Each item is checked on its own, one copy alone on the plate, wherever it fits: centred, against an edge, or pushed clear of an excluded area (a 240 x 220 mm part on an X1 Carbon fits beside the excluded corner, not centred over it). Where the preview row puts it does not matter. The line above the thresholds says whether every item fits. A part that does not fit the bed needs another orientation or a bigger printer. The check moves a part on the bed but never turns it: a long part that would fit diagonally, or turned a quarter about Z, is still reported. Turn it yourself with **Z 90°** and see.

  When all the copies of all the items together need more room than the plate has (an estimate from their footprints, 5 mm apart), a note under that line says so. Each part still fits on its own, but [Export for printing](#export-for-printing) writes one plate, so it will refuse those copies. The estimate is generous: without the note, an export can still find the copies too many when it packs them.

- **Overhang**: the area steeper than the threshold, and the steepest angle.
- **Too thin to print**, **Thin wall**: the area thinner than the limit, and the thinnest wall.
- **Narrow gap**: the area facing a gap narrower than the minimum, between walls of one body or of different bodies on the plate, and the narrowest gap.
- **Small hole**: a hole below the minimum hole, with its diameter.
- **Horizontal hole: teardrop or support**: a hole lying flat on its side and wider than the teardrop size.

The holes of a part a print setup prints are also checked in the model itself, outside this workspace: where the material around a hole is thinner than the setup's minimum wall, the hole shows a warning in the feature tree after every regeneration. A heat-set insert hole is checked against its insert's minimum wall instead, printed or not (see [Fits](fits.md#heat-set-inserts-and-self-tapping-screws)).

Click an issue to select what it is about and zoom the view to it; click it again to let go. A hole that a slot or a cross hole cuts into several faces is one entry, and its click selects all of them.

Everything is checked again after every change to the part or the orientation. Overhangs, bed fit and holes are quick and update at once. Walls and gaps take longer, so they run in the background a quarter of a second after you stop editing (the list says "checking walls and gaps..." meanwhile), and each new change replaces the check before it. Until a check of the mesh now drawn comes back (after an edit, or when the finer export mesh replaces the coarse one), the thickness view shows those bodies in their own colour rather than the old mesh's values. Closing the workspace stops a check on its way.

## Export for printing

The **Export** section of the Print panel saves the active setup as one file for the slicer:

- **Format**: **3MF** (the default) or **STL, one file per body**, the fallback for a slicer that does not read 3MF.
- **Mesh**: the [mesh tolerance](import-export.md#mesh-tolerance), **Normal** (0.02 mm) by default.
- **Export for printing** downloads the file. It is named after the document and the setup: `<document>-<setup>.3mf`, for instance `Jig-Plate 1.3mf`. Characters a file name cannot hold (`/ \ : * ? " < > |` and control characters) become `_`.

What the 3MF holds:

- **Every item's bodies, turned as the item is** (laid flat, turned, or as modelled) and dropped onto the bed, as the view shows them.
- **Every copy, packed onto the plate.** Copies go in rows from the front left corner of the printable area, 5 mm apart, in the order the items are listed, and clear of any excluded area. The export keeps 5 mm clear when it can, since slicers flag parts very close to an excluded area; on an X1 or P1 printer the first row starts beside the excluded corner. When keeping 5 mm clear would leave a copy off the plate (a 236 x 226 mm part on an X1 Carbon fits only right against the excluded corner), the copies are packed again with no clearance from the excluded area, still 5 mm apart from each other, and the export's message says which part sits within 5 mm of an excluded area: check it in the slicer. On a two-nozzle printer (H2D, H2D Pro, X2D), a plate with a two-colour item on it is packed in the area both nozzles reach. The packed copies are then moved to the middle of the plate when they still fit there. This is a sane starting place, not a careful arrangement: arrange the plate in the slicer as you like. Copies are never turned to fit better.
- **Each body's name and colour.** Each colour goes in the file once, and the slicer gives each colour its own filament slot (see [Colours, names and orientation in 3MF](import-export.md#colours-names-and-orientation-in-3mf)).
- **An item of several bodies stays one object** in the slicer, with a part per body, so a two-colour part is not pulled apart when the slicer arranges the plate. Add the bodies as separate items to print them as separate objects.

STL has no colours and no copies. **STL, one file per body** writes one file per body of every item (`<document>-<setup>-<item>.stl`, with the body's name after the item's when the item has several bodies), turned as the item is and placed where its first copy is on the plate; add the copies again in the slicer.

**When an export is refused.** For most reasons the section says why before you press anything, and the buttons stay off:

- an item does not fit the bed (the same check as **Does not fit the bed** in the Issues list, with the axis named, for instance `too big by x 44.00 mm`);
- an item has lost its body or its lay-flat face (**Reference lost**);
- the printer is not one this version of the app knows.

The buttons also stay off while the part is rebuilding after an edit (the section says **Waiting for the model**) and while another export runs, so the file is always made from the model as it is now. If the geometry kernel is still busy with another document when you press (a version you are viewing, say), the section says so and makes nothing.

One reason only shows after you press: **the copies need more than one plate**. Whether they fit is settled by packing them, which the export does. An export writes one plate, and manufakture's 3MF files have no plates, so it does not put copies off the bed: the message says how many fit. Lower the copies, or move some items to a second setup and export that too. The note under the bed-fit line warns of this ahead when the copies plainly need more room than the plate has, but not in every case. An item no copy of which can be placed at all is named instead, with why: on a two-nozzle printer, for instance, a one-colour part that fits the bed only where one nozzle reaches has no spot on a plate packed in the area both nozzles reach, so move it to another setup.

Every other issue (overhangs, thin walls, narrow gaps, small holes) is a warning: the export goes ahead, and its message says how many issues the list shows.

### Every configuration

In a document with [configurations](configurations.md), **Export all N configurations** exports the setup once per configuration, each from its own rebuild, one file per configuration: `<document>-<setup>-<configuration>.3mf`. A configuration whose setup is refused (say a width that makes the part too long for the bed) is named in the message; the others still export. A configuration where a feature of a part the setup prints fails is named too ("Extrude 2 fails in this configuration"), rather than exported from the features before it. **Cancel** stops the export and keeps the files already made; the configuration in progress when you cancel is not saved. Leaving the Print workspace cancels it as well. While it runs, the other exports (the header's **Export** among them) are off.

## Open in slicer

**Open in slicer** always saves a 3MF, whatever the **Format** is set to, and then shows how to open it in your slicer. Pick the slicer in that panel (OrcaSlicer by default, Bambu Studio or PrusaSlicer) and your system; the app remembers the slicer.

The browser cannot start the slicer by itself. A slicer can only be handed a file to fetch from a web address, and the app has no server to put the file on, so the hand-off is a download. The panel gives three ways on:

1. Open the file from the browser's download list. It opens in whichever program your system uses for `.3mf` files.
2. Make the slicer that program, once:
   - **Windows**: in File Explorer, right-click a `.3mf` file, **Open with**, **Choose another app**, pick the slicer and make it the one to always use. Until then Windows may open `.3mf` files in another program, such as 3D Viewer.
   - **macOS**: select a `.3mf` file in Finder, **File > Get Info**, pick the slicer under **Open with**, then **Change All**.
   - **Linux**: in your file manager, right-click a `.3mf` file, **Open With** (or **Properties**, then **Open With**), pick the slicer and set it as the default.
3. Or start the slicer and import the file (**File > Import**), or drag it from the download list onto the slicer's window.

The panel is shown once for each slicer: **Got it** closes it, and the next **Open in slicer** for the same slicer only downloads. **How to open the file in a slicer** under the buttons brings it back at any time.

## Limits

- **Meshes**: overhangs, walls and gaps are measured on the part's triangle mesh at the export tolerance (0.02 mm, the `normal` preset in [Importing and exporting](import-export.md)), the mesh the slicer gets. Until that mesh is ready (a moment after each change), or when the geometry kernel is not loaded, the view's own coarser mesh (0.1 mm) is checked. Hole sizes and directions come from the exact geometry.
- **Wall thickness** is measured straight through the wall, from each small piece of the surface. Where two walls meet at a sharp angle (a knife edge), the tip reads thin, which it is. Walls thicker than 10 mm read as thick enough.
- **Threads**: a modelled thread's hole or shaft is not checked as a hole or pin; a cosmetic thread (just the tap drill hole) is.
- **Fillets and slot ends** are curved but not holes, and are not checked as holes.
- **Two-nozzle printers** (the H2D, H2D Pro and X2D): an item whose bodies have two or more colours must fit the area both nozzles reach; one colour, the whole bed. Which filament goes to which nozzle is decided in the slicer.
- **Turning on the bed**: neither the bed-fit check nor the packing of an export turns a part about Z to make it fit; both only move it.
- **One plate per export**: copies that need a second plate refuse the export (see [Export for printing](#export-for-printing)).
- **Not modelled**: excluded areas that differ by build plate, and the clog and wrap detection zones some Bambu Lab printers add when those features are on.

## Fits

**Insert fit variables** in the Variables panel (shown under the Print panel while the workspace is open) takes its clearances from the **active setup's** printer and nozzle. See [Fits for printed parts](fits.md).
