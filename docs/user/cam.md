# Machining: the Manufacture workspace

The **Manufacture** workspace sets up a part for cutting on a CNC router: which machine, the block of stock it is cut from, where the machine's zero is, the tools, and the operations (facing, profiles, pockets, holes, V-carving, 3D surfaces) in the order they cut. It makes toolpaths on demand. The Shapeoko 5 Pro 4x4 and the Shapeoko 4 XXL, in their default configurations, are the machines it is built around.

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

- **In this document**: the tools operations can use. **Edit** changes a tool's name, kind, tool number, diameter, flute length, flutes, corner radius (a bull nose), angle (a V-bit or a drill), tip (a V-bit), and its feeds and speeds per material. Sizes are expressions (`1/4"` in a millimetre document works), and out-of-range values are refused with a message: a diameter must be at least 0.01 mm (shown when toolpaths are made), a corner radius at most half the diameter, a stepover above 0 and at most 1. **Delete** is refused while an operation cuts with the tool; the message names the operations. **New tool** makes one from scratch. A tool copied from a built-in one keeps the **unverified** marks of the numbers that were not checked against Carbide 3D's figures.
- **Built-in tools (Carbide 3D)**: Carbide 3D's end mills, V-bits and a drill, with their feeds and speeds from Carbide 3D's charts. **Use in document** copies one in. Where a number was not checked against its source (a size, or a material's speeds and feeds), the tool says so.
- **Your library**: tools you keep in this browser, outside any document. **Import...** reads a tool library file (merging it), **Export** downloads yours. If the library's files cannot be read (written by a newer version, or damaged), it says so and nothing is ever saved over them; the files that could not be read are **kept aside**. **Reset library** sets the current files aside too and starts an empty library. The panel says how many files are kept aside, whether a reset set them aside or they could not be read. Only the newest five files set aside are kept; older ones are deleted.

## Operations

The buttons under the setup list add an operation: **Facing**, **Profile**, **Pocket**, **Drill**, **V-carve**, **3D surface**. Each opens a dialog: OK applies it as one undo step, Cancel or Escape changes nothing. Every number is an expression; a field says at once when a value is of the wrong kind (a length where a feed rate is expected) or out of range (a zero stepover, a negative depth, a fractional tab count), and OK refuses until it is fixed. Fields marked optional can be left empty: the stepdown, stepover and feeds then come from the tool's preset for the stock's material.

Every operation has a **name**, a **tool** and its **geometry**:

- **Faces** are picked in the view: with **Pick faces** active, click flat faces of the part. Curved faces are refused. A face's outline is what a profile or V-carve follows, and what bounds a 3D surface.
- **Sketch regions**: choose a sketch and **Add its regions**: every closed region of the sketch, whether or not a feature uses it (lettering to carve, say).
- **Holes**: for a drill, choose a hole feature and **Add its holes**.

Under **Feeds and speed**, set a spindle speed and cutting, plunge, ramp and lead feed rates to override the tool's preset for this operation.

### Facing

Flattens the stock top: **Depth** is how much it removes, **Raster angle** the direction of the passes. With no geometry it faces the whole stock top.

### Profile

Cuts around the geometry's outline: **Side** (outside, inside, on the line), **Depth** (**Blind**, a depth below the top of the geometry; or **Through the stock**, with an optional amount below its bottom), stepdown, finish allowance, **Tabs** to hold the part when cutting through (how many per loop, their width and height), **Entry** (plunge, ramp or helix, with their angle and radius; see **Entry angles** below), lead-in and lead-out, and climb or conventional milling. A profile needs at least one face or region.

### Pocket

Clears the area inside the geometry: depth, stepdown, **stepover** (a fraction of the tool's diameter: 0.4 is 40%), finish allowance, entry and climb. A pocket on a **face** stops at that face: the face is its floor, and the depth does not apply. A pocket on **sketch regions** goes to its depth. One pocket takes floor faces or regions, not both: make two pockets.

The finishing choices below them are optional:

- **Finishing pass on the walls**: by default a pocket with a finish allowance clears to the allowance, then runs one pass along the walls (and round any islands) to take it off. **No** leaves the walls oversize for a later operation; **Yes** runs the pass even with no allowance.
- **Finishing stepdown**: how deep each step of that pass goes. Empty: the whole depth in one step when the tool's flutes reach, otherwise the stepdown.
- **Floor allowance**: material the clearing leaves on the floor (empty: none). It must be less than the pocket's depth.
- **Floor pass**: by default, with a floor allowance, one more clearing pass at the bottom takes it off. **No** leaves it for a later operation.

**Entry angles.** A ramp or helix entry (profile, pocket, a V-carve's clearing and z-level roughing) takes an angle from 0.5 to 90 degrees; 1 to 5 degrees is usual on a router, 3 degrees is the default. Shallower is refused as it is typed: a ramp at a tiny angle would be hundreds of metres long. An entry that would still go round more than 10,000 times to reach one level (a helix with a hair-thin radius, say) is refused when toolpaths are made, with a message: use a steeper angle, a larger radius, a smaller stepdown or a plunge.

**Size limits.** So a document (yours, or one from someone else) cannot make the computer run out of memory, every operation is held to 3 million moves; a real job is far below that (a 300 mm square 3D finish is under half a million). An operation that would emit more, such as a hair-thin tool ramping down many levels, is refused when toolpaths are made with a message: use a larger tool, stepdown, stepover or entry angle. A profile takes at most 1,000 tabs per loop (a tab spacing asking for more places 1,000, with a warning), and a drill bores a hole in at most 1,000 rings and drills it in at most 10,000 pecks (a peck depth so small that a hole needs more is refused). All the operations of one setup together are held to 10 million moves: once they pass it, the operation that would go over and the ones after it show an error instead of a toolpath, and the setup cannot be exported until you split it or coarsen its operations. An export of more than 20 million lines of G-code is refused too.

### Drill

Drills holes: **Depth** is each hole's own depth, or blind, or through; **Peck depth** pulls the drill out every so often (empty: one plunge); **Dwell** pauses at the bottom, in seconds. With no hole features listed, it drills every round hole of the part that can be reached from above.

### V-carve

Carves the geometry with a V-bit (or an engraver), deeper where the shape is wider, for lettering and signs. **Maximum depth** limits how deep it goes (empty: as deep as the bit's shape needs). The dialog offers only V-bits and engravers.

- **Stepdown**: carve in levels no deeper than this (empty: one level, the whole depth at once). Use it for deep, wide letters in hard material.
- **Floor stepover**: where the maximum depth (or the bit's size) stops the carve, the shape has a flat floor, which the V-bit clears in rings this far apart. Empty: rings close enough to leave ridges no higher than 0.2 mm.
- **Clear the flat floor with an end mill first**: a wide letter's floor cleared by a V-bit takes many rings; an end mill does it much faster. Tick this, choose a **Clearing tool** (a flat or bull nose end mill), and optionally its stepdown, stepover (a fraction of its diameter), entry (by default a 3 degree helix) and feeds; empty ones come from that tool's preset for the stock's material. The end mill then clears the floor first, with a tool change of its own, and the V-bit carves the sloped sides and the corners the end mill cannot reach. The clearing only does something with a **Maximum depth**: without one the operation warns that there may be no floor to clear. In the list and the preview the clearing belongs to its V-carve: suppress the V-carve and the clearing goes too, and if the clearing fails the V-carve shows it as failed. The preview and the export list the clearing as **(clearing)** just before its V-carve.

### 3D surface

Machines a curved part, such as a filleted or sculpted top, from the part's own shape (its surface, meshed finely) rather than from outlines. The dialog offers ball, bull nose and flat end mills and V-bits, a ball first. **Strategy**:

- **Parallel finish**: straight passes a **stepover** apart (a distance here, unlike the 2D operations' fraction: the cusps a ball leaves get smaller as it shrinks; 0.3 to 0.5 mm with a 1/8" ball is a fine finish), at the **raster angle**, with the tool dropped onto the surface along each pass so it touches the part without cutting into it. **Pattern**: zigzag (the passes linked along the surface where that is safe) or one way (lifting between passes). **Tolerance** (default 0.01 mm) is how far the program may stray from the exact path, and **sampling** how far apart the tool is dropped along a pass (by default from the tool's size; it is never coarser than the tool's radius, nor, for a V-bit, than its sharp tip allows; the operation warns when it uses a finer one than you asked for). A V-bit samples very finely: its sharp tip allows only about 4 x tolerance x tan(half angle) between drops (0.023 mm for a 60 degree bit at the default tolerance, down to 0.001 mm at the finest), so a V-bit finish is many times slower than a ball's; keep its area small and its tolerance no finer than needed.
- **Z-level roughing**: removes the bulk of the stock in flat slices a **stepdown** apart (default half the tool's diameter), each cleared like a pocket, leaving the **stock to leave** on the part's top and sides for the finish. A flat end mill roughs closest; a round tool leaves more between the slices (it warns). Its entry (default a 3 degree helix), climb and slice grid (default 0.2 mm) are set here too; the raster angle and pattern are not used.

**Stock to leave** (empty: none) is material left on the surface; a V-bit cannot leave any.

**Work limits.** So a slip of a digit cannot keep the computer busy for hours, an operation that would take too much work is refused before it starts, with a message saying which numbers to raise: a finish that would drop the tool at more than 20 million points along its passes (the passes' total length over the sampling), and a roughing that would plan more than 100,000 clearing passes (slices times the passes one slice can need at the stepover) or trace its slice grid more than 2 billion times. A finish that needs more than 60 million drops in all, once the refinement where the surface bends is counted, or more than 3 million moves, stops with the same kind of message. Use a larger stepover, sampling, tolerance, stepdown or slice grid, or a smaller boundary.

**Boundary**: the faces and sketch regions you add limit where the tool's centre goes, seen from above. Pick a flat face to finish only inside its outline (its holes stay out), or a sketch region drawn over the area to finish. With none, a finish covers the part's whole extent and a roughing the whole stock.

**Rough first.** A finish follows the part from the stock top down in a single pass wherever there is material, and with no boundary it goes down to the part's lowest point wherever the part does not fill its box. Unless the stock is already close to the part, put a **Z-level roughing** before the finish in the same setup (a flat end mill, a stock to leave of 0.3 to 0.5 mm), then the finish with a ball. Until there is one, the finish's row in the list says **Nothing roughs before this finish**. Simulate the job (below) before cutting: it shows any gouge, and how much is left for the finish.

## The operations list

The list shows the setup's operations in the order they cut. Each row has its kind, name and tool, and a status:

- **ok**: the geometry and numbers resolved on the part as it is now.
- **Error**, with what is wrong underneath: a face or sketch that is gone, a value out of range, no feeds for the material, a face that is not parallel to the setup's XY plane. When a face is gone, **Pick geometry n again** opens the dialog with that face marked, and the next face you click takes its place.
- **Suppressed**: left out of the program.

After **Generate toolpaths**, a row also says whether its toolpath was generated or failed (and why). When you then change something it depends on (the operation, its tool, the setup, a variable it reads, or the part), the row is marked **stale**: generate again. Editing the part never fails because of an operation; the operation reports what it lost the next time it is resolved. The one exception: a part studio cannot be deleted while a setup machines it (delete the setup first).

On each row: **Edit** (or double-click, or Enter), **Rename** (or F2), **Suppress** / **Unsuppress**, **Up** and **Down** to change the cutting order, **Move to...** another setup of the same part and body (the operation keeps its name and settings), and **Delete** (or the Delete key). Each is one undo step.

**Generate toolpaths** makes the toolpaths of the setup's resolved operations in the background; nothing is generated until you ask. A 3D surface over a large part with a fine stepover takes a while; the panel says it is working, and **Cancel** next to the button stops the generation (the toolpaths you had stay as they were). The toolpaths then show in the view, where you can also simulate the cut (see below). **Export G-code** writes the setup's program for the machine, with a setup sheet (see Exporting G-code below).

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

Tick **Simulate material removal** under the slider to see the stock as the job leaves it. The simulation cuts the stock top on a grid of small squares (by default 16 across the narrowest tool's cut: its diameter, or for a V-bit or an engraver the width of its flat tip, or 1 mm when the tip is narrower; coarser on very large stock so it fits in memory), with each tool's real shape: flat, ball, bull nose and V, so a 3D finish with a ball or a bull nose is checked with the round end it really cuts with. It follows the slider, so you can watch the material come off move by move. The panel then reports:

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
- **Group operations by tool**: runs each tool's operations together, tools in the order they are first used, so there are fewer tool changes. It changes the order material comes off, so the export warns when it moves a cut through the stock ahead of other cuts (the part could come loose before they run). A V-carve's clearing always stays ahead of its V-carve: if the V-bit was used earlier in the setup, the V-carve is cut right after its clearing rather than with the V-bit's other cuts (one more tool change), so the V-bit never has to cut the whole floor.

Before anything is saved, the summary lists the files, the tools in the order they are loaded, the estimated time (no acceleration or tool change time, so a real machine takes longer), the extents of the tool tip, and every warning from the job and the post. Under it is the **setup sheet**: the files and their order, the stock size and material, the work zero (WCS origin) and how to set it, the clearance and retract heights, the tools with their numbers, every tool change in order with its spindle speed and router dial setting, and each operation with its tool, top and bottom Z, stepdown, spindle speed and feeds. **Print setup sheet** prints it and **Save setup sheet** saves it as an HTML file.

**Save G-code** downloads the file, named after the document and the setup (`Bracket - Setup 1.nc`). One file per tool is saved as one zip holding the files, numbered in the order to run them and named after their tool (`Bracket - Setup 1 - 2 of 2 - #102 1_8_ flat end mill.nc`), and the setup sheet.

The export refuses, and says why, when an operation of the setup has an error (its geometry or its toolpath), when its geometry did not resolve, or when the post cannot write the job (Carbide Motion needs a tool number on every tool, for example). Fix the operation, or suppress it to export the rest.

## Variables

Every number in a setup, a tool or an operation can read the document's variables (`#depth + 1 mm`). The **Variables** panel stays beside the setup panel; a variable's uses include the CAM fields that read it ("CAM Setup 1 / Profile 1: Depth"), and such a variable cannot be deleted until those fields stop reading it (or take its value instead). Changing a variable re-resolves the operations that read it.
