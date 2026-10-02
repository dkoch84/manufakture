# Woodworking: boards from real stock, and joints

A **board** is a body cut from stock you can buy: a sheet of plywood or MDF, or a length of dimension lumber or hardwood. You choose the stock by the name it is sold under (`3/4" plywood`, `2x4`, `18 mm plywood`), and the board is built at the stock's **actual** size, which is smaller than its name says: a 2x4 is 1-1/2" x 3-1/2", and 3/4" plywood is usually 23/32" thick. Each board knows which way its grain runs, and its body is made of the stock's material.

A board is built from a sketch, like an extrusion, so draw the sketch first.

## Making a board

**Board**, next to **Extrude** in the feature toolbar, opens the Board dialog. A board is one of two forms:

- **Panel**: a closed region of a sketch, extruded by the stock's thickness. Use it for sheet goods (a shelf, a cabinet side) and for glued-up solid wood panels. Draw the panel's outline as a closed shape; the panel uses the sketch's one region, so draw one outline per sketch.
- **Stick**: the stock's cross-section run along a line of the sketch, from the line's start to its end. Use it for lumber: rails, legs, studs. Draw a single line where the board goes; a construction line works too.

The dialog opens on a panel when the sketch has a closed shape and on a stick when it has a line. Choose the sketch (a sketch selected in the feature tree is chosen for you), the form and the stock, then **OK**. The board is one step that **Undo** takes back.

While the dialog is open, the view shows the board it would build as an outline drawn over the model, with its grain arrow, and the dialog gives the blank's size (length along the grain, width, thickness) in the document's units. The outline follows every change in the dialog.

### Choosing the stock

The stock list is grouped into **Sheet goods** and **Lumber**, each entry with its name as sold and its actual size in your display units: `3/4" plywood (23/32")`, `2x4 (1-1/2" x 3-1/2")`. A stick is cut from lumber only, so the list leaves sheet goods out for sticks.

Stock comes in two sets of sizes, **US sizes** and **Metric**, with a button for each above the list. The list opens on the set that matches the document's display units: US sizes in an inch or foot document, metric sizes in a millimetre, centimetre or metre document. The other set is one click away. Which set you look at is not saved with the document; only the stock you choose is.

Sizes marked **(unverified)** are typical sizes that were not checked against a published standard (plywood and MDF thicknesses vary by maker, hardwood is surfaced to different thicknesses). Measure your stock and set its real thickness in the [Stock panel](#the-stock-panel). The US softwood sizes come from the American Softwood Lumber Standard (PS 20) and are not marked.

### Panels and grain

**Grain** sets the direction the grain runs in the sketch plane:

- **Along the longest side** (the default): along the longest straight side of the outline.
- **Along a line of the sketch**: along a line you choose, which need not be part of the outline (a construction line works).
- **At an angle**: at an angle from the sketch's x axis.

The grain decides which side of the panel is its length in the cut list. MDF and OSB have no grain; for them the direction only says which side is called the length. **Opposite side of the sketch** extrudes the panel the other way from the sketch plane.

### Sticks

A stick runs along its line from the line's start. At no rotation its thickness lies in the sketch plane and its width stands up from it. **Rotation about the line** turns it (90 degrees lays a 2x4 flat). **Thickness** and **Width** say where the line sits in the cross-section: centred, or along one face, so a stick can sit on one side of the line (a rail flush with the outline, say). **Length** gives the stick a length other than the line's, and **Width** a width other than the stock's; hardwood sold in random widths always needs a width. Every field takes an expression, so `#rail_length` or `36"` work as anywhere else.

## Boards in the feature tree

A board shows in the feature tree with a board icon, its name ("Board 1"), and the stock it is cut from (`2x4`). Double-click it to open the Board dialog again; changing the stock rebuilds it. Rename, suppress, reorder and delete work as for any feature.

A board's body is made of its stock's material (plywood, MDF, pine for softwood lumber, oak for hardwood), so its mass in the [measure panel](measure.md) is right without setting anything. If you give the body another material in the [Bodies section](bodies.md), that material stays when you change the board's stock.

A board saved by a newer version of manufakture, which this version cannot read, still opens and keeps its place in the tree. It is not built, and its row says why; you can delete, rename, suppress or move it, but not edit it, so nothing in it is lost.

## The Stock panel

The **Stock** panel, in the side panel next to Configurations, appears once a document has a board. It lists every stock the document's boards use, with the size each is built at:

- **Override** (or **Edit**) opens a short form for the stock: the **measured thickness** (and **measured width** for lumber), the **sheet size** you have in stock for sheet goods, and a **price** per piece, sheet, board foot, metre or foot, with an optional currency code (`USD`, `EUR`). Leave a field empty to keep the catalog's value.
- **Save** stores the override, and every board of that stock rebuilds at once: set 3/4" plywood to `18.2mm` and every plywood board in every part studio takes the new thickness. **Clear** removes the override. Each is one step that **Undo** takes back.
- **Override another stock** sets an override for a stock no board uses yet, so a price or a measured thickness is ready before you draw.

An overridden size shows as typed, marked **(measured)**. Overrides are measured values, not formulas: they take a length with its unit (`18.2mm`, `23/32"`), never a variable. A board that should follow a variable takes the variable in its own fields instead.

A price changes no board, so setting one rebuilds nothing. Prices and sheet sizes are kept for the cut list and sheet layouts.

**Show grain arrows on boards**, at the bottom of the panel, turns the grain arrows on the boards in the view on and off. An arrow is drawn on both broad faces of every board whose stock has a grain, pointing along the grain. The setting is part of your view, not of the document.

## Joints

A **joint** cuts two boards against each other: a groove in one where the other sits in it, a tenon and its mortise, holes for dowels or pocket screws, or the fingers of a box joint. Joints work on boards only, and the two boards must be square to each other (every face of one parallel or square to the faces of the other); a splayed or angled joint is not supported.

**Joint**, next to **Board** in the feature toolbar, opens the Joint dialog. Select the two boards in the feature tree (or a face of each in the view) first and the dialog starts with them, the first one you picked receiving; or choose them in the dialog.

### Which board is which

Every joint has two boards with different jobs:

- **Receives (A)** is the board that is cut where the other one enters it: the side a shelf sits in, the leg that takes a tenon, the board a pocket screw goes into.
- **Enters (B)** is the board that goes into A: the shelf, the rail with the tenon, the board with the pocket holes.

**Swap A and B** swaps them. While the dialog is open, the view shows what the joint would cut, drawn over the model: **solid** outlines are cut from A, **dashed** ones from B. The dialog lists the same in words ("Cut from Side (A): a groove. Cut from Shelf (B): nothing."), with the joint's sizes as built, in the document's units.

### The depth comes from the model

For a dado, a rabbet, a mortise and tenon and a box joint, draw board B reaching into board A by the depth you want: the boards overlap, and the joint cuts the overlap. A shelf drawn 6 mm into the side gets a 6 mm deep dado; a rail drawn 25 mm into the leg gets a 25 mm tenon. So the depth is not a field in the dialog: to change it, move or resize B (its sketch, or the board's length). The cut list reads the boards as you drew them, so the shelf's length already includes what sits in the dado.

Dowels and pocket screws are the other way round: B must touch A without overlapping it.

When a board moves or changes size, its joints follow: a dado moves with its shelf, and a thicker shelf (a new stock, or a measured thickness in the [Stock panel](#the-stock-panel)) gets a wider dado.

### Kinds of joint

Every size is optional unless noted, and takes an expression (`1/4"`, `#clearance`). Leave a field empty for its default.

| Joint                 | What it cuts                                                                                                                | Fields                                                                                                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Dado**              | A groove across A's face, as wide as B is thick. **Through**, or **stopped** short of one end or both (B is notched there). | **Clearance** (the total play, split on both sides), **Stop** (how far short of the end it stops; needed when stopped).                                                                                                  |
| **Rabbet**            | A step along A's edge where B sits at it. B inside A's face is a dado, not a rabbet: the dialog says so.                    | **Clearance** (all of it on the inner side).                                                                                                                                                                             |
| **Mortise and tenon** | A tenon on B's end, centred across its width; the mortise in A to match. **Square** or **rounded** mortise ends.            | **Tenon thickness** (a third of B's), **Tenon width** (B's width less two thirds of its thickness), **Tenon offset** across B's thickness, **Clearance** (added to the mortise).                                         |
| **Dowels**            | A row of holes into both boards, along the middle of where they touch.                                                      | **Dowel diameter** (8 mm), **Hole depth** into A (1.5 diameters) and into B (2.5 diameters), **How many** or **Spacing** (by default spread evenly, at least two), **Distance from the ends** (2 diameters), **Offset**. |
| **Pocket screws**     | Angled pocket holes in B, opening on the face you choose; nothing is cut from A.                                            | **How many** or **Spacing**, **Distance from the ends** (3/4"), **Pocket angle** (15 degrees, the standard jig), **Screw length** (the jig chart's for B's thickness).                                                   |
| **Box joint**         | Interlocking fingers on both boards' ends; choose which board has the first finger.                                         | **Finger width** (the thinner board's thickness, rounded to fit) or **Number of fingers**, **Clearance**.                                                                                                                |

### Warnings, hardware and refusals

- **Warnings** show in the dialog and do not stop the joint. A dado or rabbet deeper than half of A, or a dowel more than half as thick as the board it is set in, is marked as a **rule of thumb, not engineering**. A pocket screw whose tip would come out of A's far side is warned about too; the screw itself is not modelled.
- **Hardware**: dowels and pocket screws are counted with their sizes ("4 dowels, 8 mm x 32 mm"), shown in the dialog and in the feature tree, and counted for the bill of materials.
- A joint that **cannot be built** is refused before anything is applied, with the reason in the boards' names ("Shelf (B) is not square to Side (A) (about 30 degrees off)") and the field at fault marked. **OK** does nothing until it is fixed: choose another kind, swap the boards, or change the boards themselves.

A joint is one step that **Undo** takes back.

### Joints in the feature tree

A joint shows in the tree with a joint icon, its name after its kind ("Dado 7", "Mortise and tenon 9"), the boards it joins ("Shelf into Side") and its hardware ("4 dowels"). It comes after both boards, and moving it above either of them is refused. Double-click it to open the Joint dialog again. A joint saved by a newer version of manufakture, which this version cannot read, keeps its place in the tree but cannot be edited here, like such a board.

## The cut list

**Cut list**, in the toolbar once a document has a board, opens the **Cut list** panel in the side panel. It is made from the model as it is now, in the configuration shown by the configuration switcher (the panel says which), and it follows every edit.

### The list

Each row is a set of identical pieces: the same stock, material and blank size. The size is the **blank**, the board as you cut it on the saw before any joinery (a tenon's length is part of its board), given as length along the grain by width by thickness. Plywood and other sheet goods total their area; lumber totals its **board feet** (on the nominal size for softwood, `2x4`, and on rough quarters with the real width for hardwood) and its length. The **Totals** under the list add each kind up, with all the board feet together; **Hardware** lists the dowels and pocket screws the joints need.

- Rows are grouped by stock. Click a column heading to sort the rows within each group (click again to reverse).
- **Click a row** to select its bodies in the view.
- A long list of names is shortened: `Shelf 1, Shelf 2, Shelf 3` shows as `Shelf 1-3`; hover a row for every name.
- Notes on a row: **ripped** marks lumber narrower or wider than its stock (a ripped or glued-up board), counted in board feet on its real width; **sized from its shape** marks a body that is not a board (an extrusion or an import given a wood material), sized by the smallest box that holds it; **size unknown** marks such a body before it has been measured.

**Bodies that are not in the list are named above it**, in a yellow box, so the list never comes up short without saying so. The usual case is a pattern or mirror copy of a board: the copy is a plain body, not a board, and has no material, so it is left out. Give it a wood material in the [Bodies section](bodies.md) and it is listed by its shape, or make it a board of its own.

### Layouts

The **Layouts** tab shows how to cut the list from stock:

- **Sheet goods**: every sheet drawn to scale, each part numbered as its row in the list, offcuts dashed and waste shaded, with the waste percentage. **Cut order** under a sheet lists the cuts in an order a saw can make them: trims first, then the rips, then the crosscuts of each strip. A part with a grain runs along the sheet's grain; MDF parts may turn.
- **Lumber**: each stick to buy, with the pieces cut from it and what is left.
- A lumber blank wider than its stock (a panel glued up from several boards) cannot come from one stick, so it is listed under the layouts and left out of the lumber plan. A stock with no sheet size, or lumber sold in random lengths, has no layout.

The layouts are made in the background, so the page stays responsive on a large list; a percentage shows while they are being made. They are good layouts, not proven best ones.

**Saw and layout settings**, at the top of the tab, holds the **Kerf** (the width the blade removes; empty means 1/8"), the **Sheet edge trim** taken off every factory edge, the **Lumber end trim** taken off both ends of a stick, the **Stages** (2 for rip-then-crosscut layouts, or more), and whether parts follow a sheet's **grain** or may turn. **Apply** stores them with the document as one step that **Undo** takes back, and the layouts are made again. Like stock overrides, they are measured values (`3/32"`, `3mm`), not variables.

### Files for the shop

- **Cut list CSV**: one line per row with every name, the sizes in the document's units, the quantity, the total and the notes.
- **BOM CSV**: the parts per stock, the sheets and sticks to buy (once the layouts are made), and the hardware.
- **PDF**: the cut list, hardware and totals, then one page per sheet and the lumber plans, on Letter paper for inch documents and A4 otherwise.

## Files and history

Boards, joints and stock overrides are saved with the document, travel in `.mfk` files, and appear in the [history](history.md): a version that differs only in its overrides says "Settings that differ: stock overrides."
