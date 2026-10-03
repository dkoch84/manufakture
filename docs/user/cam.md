# Machining: the Manufacture workspace

The **Manufacture** workspace sets up a part for cutting on a CNC router: which machine, the block of stock it is cut from, where the machine's zero is, the tools, and the operations (facing, profiles, pockets, holes, V-carving) in the order they cut. It makes toolpaths on demand. The Shapeoko 5 Pro 4x4 and the Shapeoko 4 XXL, in their default configurations, are the machines it is built around.

Open it with **Manufacture** in the toolbar at the top; press it again to go back to modelling. While it is open the feature tree and the modelling tools step aside: the **Manufacture** panel on the left lists the setups and operations, and the **Setup** panel on the right edits the setup shown. The view keeps showing the part, so you can pick its faces. **Print** and **Manufacture** are never open together; opening one closes the other. Manufacture is not available on an assembly tab.

Everything here is saved in the document and comes back when you reopen it. Every change (a setup, a tool, an operation, its order) is one step for Undo and Redo, and the version history lists the CAM setups and tools that differ. Nothing here changes the part: editing a setup or an operation does not rebuild anything, and toolpaths are never saved (they are made again when asked).

## Setups

A **setup** is one way the part sits on the machine: one stock, one zero point, one machine, and the operations cut from that side. A part cut from both sides has two setups. Pick a setup in the list at the top of the **Manufacture** panel; **New setup** starts one for the part studio shown.

A new setup is on the **Shapeoko 5 Pro 4x4** with the machine's default post, its stock is the part's box plus 5 mm on every side and 1 mm above, its material is the part's (see below), Z is up with the zero at the front left of the stock top, and the heights are 10 mm (clearance) and 5 mm (retract).

In the **Setup** panel:

- **Name**: type and press Enter.
- **Part**, and **Body** when the part has several: what the setup machines. A setup machines one body; on a part with several bodies, choose one. The part and the body can only be changed while the setup has no operations and no WCS face: their faces, sketches and holes belong to this part and body, and another one's look-alike features would be machined in their place. To machine another part or body, start a new setup and choose it there. A setup made while its part had one body shows **Not chosen** once a second body appears; if it already has operations or a WCS face, the body stays locked, because which body they were picked on cannot be told. Start a new setup, choose the body there, and add the operations again. Faces are picked on the setup's body only; if an undo changes the setup's part or body while an operation's dialog is open, **OK** refuses, and you close the dialog and pick again.
- **Machine**: the Shapeoko 5 Pro (4x4, 4x2, 2x2) and Shapeoko 4 (XXL, XL, Standard), the two machines cut on listed first. Below it, the machine's travel, spindle and firmware. Numbers that were not checked against Carbide 3D's own figures are marked **unverified** and listed. Changing the machine also sets the post to that machine's default.
- **Post**: the G-code dialect the program will be written in (Carbide Motion, Grbl 1.1, grblHAL, LinuxCNC, Mach3). The machine's default is marked.
- **Material**: the stock's material, which picks the tools' feeds and speeds (plywood, MDF, softwood, hardwood, plastics, aluminium, steel). A new setup takes it from the part's material (oak is cut as hardwood, PLA as a plastic, and so on); a body with its own material uses that. **Not set** means the tools' presets do not apply, and every operation needs its own feeds.
- **Delete setup** removes it with its operations. Undo brings it back.

A setup that names a machine or post this version of the app does not know (a document from a newer version) still opens; the panel says so, and nothing is generated for it until you choose another.

### Stock and heights

Under **Stock and heights**, choose how big the block is:

- **The part's box plus margins**: the part's bounding box, as it sits in the setup, grown by a margin on each side (left, right, front, back), above and below. Margins are zero or more.
- **A stock of a given size**: its X, Y and thickness, and how far the part sits in from the stock's left, front and bottom. The stock must hold the part.

The **clearance height** is where the tool travels between operations and over clamps; the **retract height** is where it lifts between passes of one operation. Both are measured up from the zero point, and the retract height may not be above the clearance height. Every field takes an expression with units (`3/4"`, `#thickness + 2 mm`) and says at once when a value is out of range. **Apply stock and heights** applies them together, as one undo step.

### Work coordinates

The zero point the machine is set to before cutting:

- **Up (machine +Z)**: which way of the model points up out of the machine. Usually model +Z. Choose another axis to cut the part turned over (model -Z) or on its side, or **Pick a face as up** and click a flat face of the part: its outward side becomes up. A face is stored by name, like a feature's reference; if a later edit removes it, the setup says so and you pick it again.
- **Origin**: the corner of the stock (seen from above, with you in front of the machine) or its centre.
- **Z zero**: the stock top, or its bottom (the spoilboard).

The small diagram under these shows where the zero is on the stock, from above and from the front.

## Tools

**Tools** at the top of the **Manufacture** panel opens the tool list. A document carries its own copies of the tools it uses, so a job does not change when a library does.

- **In this document**: the tools operations can use. **Edit** changes a tool's name, kind, tool number, diameter, flute length, flutes, corner radius (a bull nose), angle (a V-bit or a drill), tip (a V-bit), and its feeds and speeds per material. Sizes are expressions (`1/4"` in a millimetre document works), and out-of-range values are refused with a message: a diameter must be above zero, a corner radius at most half the diameter, a stepover above 0 and at most 1. **Delete** is refused while an operation cuts with the tool; the message names the operations. **New tool** makes one from scratch. A tool copied from a built-in one keeps the **unverified** marks of the numbers that were not checked against Carbide 3D's figures.
- **Built-in tools (Carbide 3D)**: Carbide 3D's end mills, V-bits and a drill, with their feeds and speeds from Carbide 3D's charts. **Use in document** copies one in. Where a number was not checked against its source (a size, or a material's speeds and feeds), the tool says so.
- **Your library**: tools you keep in this browser, outside any document. **Import...** reads a tool library file (merging it), **Export** downloads yours. If the library's files cannot be read (written by a newer version, or damaged), it says so and nothing is ever saved over them; the files that could not be read are **kept aside**. **Reset library** sets the current files aside too and starts an empty library. The panel says how many files are kept aside, whether a reset set them aside or they could not be read. Only the newest five files set aside are kept; older ones are deleted.

## Operations

The buttons under the setup list add an operation: **Facing**, **Profile**, **Pocket**, **Drill**, **V-carve**. Each opens a dialog: OK applies it as one undo step, Cancel or Escape changes nothing. Every number is an expression; a field says at once when a value is of the wrong kind (a length where a feed rate is expected) or out of range (a zero stepover, a negative depth, a fractional tab count), and OK refuses until it is fixed. Fields marked optional can be left empty: the stepdown, stepover and feeds then come from the tool's preset for the stock's material.

Every operation has a **name**, a **tool** and its **geometry**:

- **Faces** are picked in the view: with **Pick faces** active, click flat faces of the part. Curved faces are refused. A face's outline is what a profile or V-carve follows.
- **Sketch regions**: choose a sketch and **Add its regions**: every closed region of the sketch, whether or not a feature uses it (lettering to carve, say).
- **Holes**: for a drill, choose a hole feature and **Add its holes**.

Under **Feeds and speed**, set a spindle speed and cutting, plunge, ramp and lead feed rates to override the tool's preset for this operation.

### Facing

Flattens the stock top: **Depth** is how much it removes, **Raster angle** the direction of the passes. With no geometry it faces the whole stock top.

### Profile

Cuts around the geometry's outline: **Side** (outside, inside, on the line), **Depth** (**Blind**, a depth below the top of the geometry; or **Through the stock**, with an optional amount below its bottom), stepdown, finish allowance, **Tabs** to hold the part when cutting through (how many per loop, their width and height), **Entry** (plunge, ramp or helix, with their angle and radius), lead-in and lead-out, and climb or conventional milling. A profile needs at least one face or region.

### Pocket

Clears the area inside the geometry: depth, stepdown, **stepover** (a fraction of the tool's diameter: 0.4 is 40%), finish allowance, entry and climb. A pocket on a **face** stops at that face: the face is its floor, and the depth does not apply. A pocket on **sketch regions** goes to its depth. One pocket takes floor faces or regions, not both: make two pockets.

### Drill

Drills holes: **Depth** is each hole's own depth, or blind, or through; **Peck depth** pulls the drill out every so often (empty: one plunge); **Dwell** pauses at the bottom, in seconds. With no hole features listed, it drills every round hole of the part that can be reached from above.

### V-carve

Carves the geometry with a V-bit (or an engraver), deeper where the shape is wider, for lettering and signs. **Maximum depth** limits how deep it goes (empty: as deep as the bit's shape needs). The dialog offers only V-bits and engravers.

## The operations list

The list shows the setup's operations in the order they cut. Each row has its kind, name and tool, and a status:

- **ok**: the geometry and numbers resolved on the part as it is now.
- **Error**, with what is wrong underneath: a face or sketch that is gone, a value out of range, no feeds for the material, a face that is not parallel to the setup's XY plane. When a face is gone, **Pick geometry n again** opens the dialog with that face marked, and the next face you click takes its place.
- **Suppressed**: left out of the program.

After **Generate toolpaths**, a row also says whether its toolpath was generated or failed (and why). When you then change something it depends on (the operation, its tool, the setup, a variable it reads, or the part), the row is marked **stale**: generate again. Editing the part never fails because of an operation; the operation reports what it lost the next time it is resolved. The one exception: a part studio cannot be deleted while a setup machines it (delete the setup first).

On each row: **Edit** (or double-click, or Enter), **Rename** (or F2), **Suppress** / **Unsuppress**, **Up** and **Down** to change the cutting order, **Move to...** another setup of the same part and body (the operation keeps its name and settings), and **Delete** (or the Delete key). Each is one undo step.

**Generate toolpaths** makes the toolpaths of the setup's resolved operations in the background; nothing is generated until you ask. The toolpaths then show in the view (see below); simulating the cut comes in a later version. **Export G-code** writes the setup's program for the machine, with a setup sheet (see Exporting G-code below).

## Previewing toolpaths

While the workspace is open, the view shows the setup's stock as a translucent box and the work coordinates as three short axes at the WCS origin (X red, Y green, Z blue), as soon as the setup resolves. After **Generate toolpaths** it also shows the toolpaths, placed on the part where the setup puts them, and the **Preview** section under the operations list says what they add up to. Closing the workspace takes all of it away again.

The preview plays the job as it would be exported: the operations in their order, joined by the moves between them (up to the clearance height, across, and down again) and with the tool changes they need. Operations that failed or are suppressed are left out. In the view:

- cuts are drawn in their operation's colour (the swatch beside its name);
- plunges (straight down into the material) are red and ramps (sloped or helical entries) orange;
- rapids, where the machine moves at full speed without cutting, are dashed grey lines.

The table lists each operation's cutting length and estimated time, with a box to show or hide it in the view (**Linking moves** shows or hides the moves between operations), and the job's totals under it: cutting and rapid length, the number of moves and tool changes, and the estimated time. The estimate runs every move at its programmed feed and every rapid at the machine's rapid rate; a real machine takes longer, since it accelerates, changes tools and spins the spindle up.

The slider under the table steps through the job one move at a time: at move n only the moves up to n are drawn, and the tool (its diameter and shape, from the tool library) sits where move n ends. **Play** runs through the job at the chosen speed (1x is the estimated machine time); dragging the slider stops it. The line under the slider names the operation of the current move and the estimated time so far.

The preview shows the last generation. When you change an operation afterwards, its row in the list is marked **stale** and the preview keeps showing the old toolpath until you generate again.

### Simulation

Tick **Simulate material removal** under the slider to see the stock as the job leaves it. The simulation cuts the stock top on a grid of small squares (by default 16 across the narrowest tool's cut: its diameter, or for a V-bit or an engraver the width of its flat tip, or 1 mm when the tip is narrower; coarser on very large stock so it fits in memory), with each tool's real shape: flat, ball, bull nose and V. It follows the slider, so you can watch the material come off move by move. The panel then reports:

- **rapids through material**: a rapid (a full-speed move that is not meant to cut) that runs into stock still standing at that moment. On the machine this is a crash; fix it before cutting.
- **gouges** (red in the view): places where the tool cut into the part itself by more than 0.05 mm, as from a wrong offset or a depth below the part's surface.
- **material left on the part** (amber): places above the part's surface by more than 0.05 mm, such as the inside corners of a pocket, where a round tool cannot reach. Until the slider is at the end, this counts what is still to be cut too.

The check compares against the part's own shape seen from above, and allows 0.07 mm sideways (the 0.05 mm tolerance plus 0.02 mm for the small flat facets that curved surfaces are drawn with), so the tool running exactly along a wall, straight or curved, is not a gouge. The panel states this allowance. A cut into a wall wider than that is checked, but only where the centre of a grid square falls in it: at the default grid for a 6 mm tool (0.375 mm squares) a wall gouge from 0.08 mm wide may show, and one 0.45 mm wide or more always does. Material outside the part (the waste around a profile, tabs) is never reported as left over. When the part's shape is not available the panel says so and simulates the stock alone. A grid cannot show overhangs; that is fine for a 3-axis job, which cannot cut them either.

## Exporting G-code

**Export G-code**, under **Generate toolpaths**, exports the setup shown. It first generates every operation that has no toolpath yet or whose toolpath is stale, with the progress on its line and a **Cancel** button; nothing is exported from an out-of-date toolpath. It first resolves the geometry of the document as it is at that moment, so an edit made just before opening it (the stock, the heights, the feeds or the model) is never missed, and an edit made while it is open generates the changed operations again before **Save** is available.

The settings:

- **Post**: the controller the file is written for. It starts at the setup's post, which a new setup takes from its machine: **Carbide Motion** on the Shapeoko profiles, the sender those machines ship with. **Grbl 1.1**, **grblHAL**, **LinuxCNC** and **Mach3** are the others.
- **Units**: millimetres (`G21`) or inches (`G20`).
- **Tool changes**, for a job with several tools, as the post allows: **One file per tool** (Grbl's default, since Grbl refuses `M6`), **One file, M0 pause at each tool change** (Grbl and grblHAL; Grbl does not jog while paused, so zeroing Z there needs a sender that allows it), or **One file, M6 at each tool change** (Carbide Motion, which then asks for each tool; LinuxCNC; Mach3; grblHAL as an option).
- **Group operations by tool**: runs each tool's operations together, tools in the order they are first used, so there are fewer tool changes. It changes the order material comes off, so the export warns when it moves a cut through the stock ahead of other cuts (the part could come loose before they run).

Before anything is saved, the summary lists the files, the tools in the order they are loaded, the estimated time (no acceleration or tool change time, so a real machine takes longer), the extents of the tool tip, and every warning from the job and the post. Under it is the **setup sheet**: the files and their order, the stock size and material, the work zero (WCS origin) and how to set it, the clearance and retract heights, the tools with their numbers, every tool change in order with its spindle speed and router dial setting, and each operation with its tool, top and bottom Z, stepdown, spindle speed and feeds. **Print setup sheet** prints it and **Save setup sheet** saves it as an HTML file.

**Save G-code** downloads the file, named after the document and the setup (`Bracket - Setup 1.nc`). One file per tool is saved as one zip holding the files, numbered in the order to run them and named after their tool (`Bracket - Setup 1 - 2 of 2 - #102 1_8_ flat end mill.nc`), and the setup sheet.

The export refuses, and says why, when an operation of the setup has an error (its geometry or its toolpath), when its geometry did not resolve, or when the post cannot write the job (Carbide Motion needs a tool number on every tool, for example). Fix the operation, or suppress it to export the rest.

## Variables

Every number in a setup, a tool or an operation can read the document's variables (`#depth + 1 mm`). The **Variables** panel stays beside the setup panel; a variable's uses include the CAM fields that read it ("CAM Setup 1 / Profile 1: Depth"), and such a variable cannot be deleted until those fields stop reading it (or take its value instead). Changing a variable re-resolves the operations that read it.
