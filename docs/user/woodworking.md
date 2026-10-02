# Woodworking: boards from real stock

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

## Files and history

Boards and stock overrides are saved with the document, travel in `.mfk` files, and appear in the [history](history.md): a version that differs only in its overrides says "Settings that differ: stock overrides."
