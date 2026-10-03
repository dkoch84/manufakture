# Construction: walls, openings, floors, roofs and their framing

## Not an engineering tool

manufakture lays out framing by rules you choose: stud spacing, plate counts, corner style, header sizes, joist and rafter stock. It places the members those rules produce, draws them and counts them. It does not engineer them.

- **No structural calculation.** manufakture knows nothing of the loads on a building (its own weight, snow, wind, people and furniture, earthquakes) and does no load check, span check or bracing assessment. It does not size a single member.
- **No building code check.** Nothing it shows or exports means that a structure is adequate, meets a building code, or may be built.
- **Sizes, spacing and headers are your decisions.** The defaults are layout conventions from common framing practice, not sizings. New documents have no header rules until you write them, and every header is one you chose.
- **Code sections are cited for reference only.** Where the app or these pages name a section of a building code (such as the International Residential Code), it is a place for you to look, not a statement of what the code requires. No code table, value or text is shipped or used.
- **Warnings are about layout.** Some are labelled rules of thumb from framing practice; none is a structural assessment, and the absence of a warning says nothing about a structure.
- **Before you build,** consult your local building authority, which decides which code applies and whether you need a permit, and a qualified professional, such as a structural engineer or an experienced builder, about your design.

manufakture is free software under the GNU General Public License, version 3 or later (see [LICENSE](../../LICENSE)), and comes with no warranty, to the extent permitted by applicable law; sections 15 and 16 of the license say so in full. This page describes what the software does; it is not legal advice.

A short form of this notice appears in the construction tools, on every drawing title block and in every takeoff export.

## Getting started

Construction tools live in the part studio, in the **Construction** group of the feature toolbar: **Construction** opens the panel, **Wall** draws a wall, **Opening** puts a door or window in one, **Floor** adds a floor and **Roof** a roof. A building is one part studio: every wall, opening and member of it regenerates together.

The panel shows the short form of the notice above once for each document you open, at its top; **Got it** puts it away for that document until you reload, and **Help** always shows it again.

A document starts with no construction settings. **Start construction** adds one level and nothing else: no wall types and no header rules. Everything structural is yours to choose.

Lengths are typed in the document's units. In a feet-and-inches document `16'`, `11' 6-1/2"`, `24"` and a bare `36` (inches) all work; a metric document takes `2.4m` or `2400`.

## Levels

A level is a named height a building stands on: its **elevation** above the document's origin (negative for a basement) and its **wall height**, the height a wall on it gets unless the wall sets its own. The first level is at `0` with walls `97-1/8"` high in an inch document (the height that takes 92-5/8" precut studs under one bottom and two top plates) or `2400mm` in a metric one.

In the **Levels** section, **Add level** puts a new level on top of the highest one, as high as it. Rename a level or change its elevation or wall height and press **Save**; each change is one undo step. Level lengths are constants: a variable (`#floor`) is refused, because levels are settings, not part of the model. A wall's own height can use variables.

**Draw here** picks the level the Wall tool draws on.

## Wall types

A wall type is a stack of layers, outside to inside: siding, sheathing, the stud layer, drywall. Every wall names one.

**New wall type** asks for:

- a **name**;
- the **stud stock**, from the lumber in the stock catalog (2x4, 2x6, precut studs, metric sizes);
- **sheathing** outside the studs and **drywall** inside them, each optional, from the catalog's sheet goods;
- the **default header**: its stock, how many plies and how many jack studs at each end. Nothing is filled in for you: the wall type's default header is used for any opening no header rule covers, so it is your choice from the start.

**Edit** opens a wall type's layers. Each layer's stock is picked with the same picker as boards use; layers can be added (siding, sheathing, drywall) and removed, but a wall type always has its one stud layer. The stud layer also takes the **spacing** on centre and the number of **bottom** and **top plates**; left empty they come from the document's framing defaults (16" on centre, one bottom plate, two top plates). **Save** is one undo step, and the walls of that type rebuild. A wall type with no siding, sheathing or drywall makes framing only.

## Walls

**Wall** opens the Wall tool on the active level. Choose the level and the wall type, give the start point (it defaults to the origin), then lay out the wall the way a framer does:

1. Type a **length** and pick its **direction**: right (+X), up (+Y), left (-X) or down (-Y) in plan. **Add length** (or Enter) adds it; the next direction turns left by default, so `16'`, `12'`, `16'` goes round a building counter-clockwise.
2. Or **click points** in the view. A click snaps to the end of a wall on the level, else square to the last point (along X or Y, by whole inches or 10 mm), else to that grid.
3. Tick **Close the loop** for a building outline, or end the last length back on the start, which closes it too.

The path is drawn in the view as it grows; **Remove last** takes back the last length or point; once the path is empty, the next click in the view sets a new start point. **Add wall** adds the wall as one undo step.

A wall's framing lies on one side of its path and its outside faces the other: the path is the outside face of the studs, and the sheathing is outside it. A closed outline is always stored counter-clockwise, so its framing is inside the outline and its sheathing outside, whichever way you drew it.

At a closed wall's corners, each segment runs through at its end and the next one butts against it, with a corner stud past it (a two-stud corner unless the wall says otherwise). Separate walls that meet join their framing the same way.

### A wall's own framing settings

In the panel's **Walls** list, **Framing** opens one wall's settings: its **height** (empty: the level's), **stud spacing** on centre (empty: the wall type's, else the document's), where the **layout** starts from, **bottom plates**, **top plates**, **king studs** beside each opening, the **corner** style (two-stud, three-stud or ladder) and **blocking** (none, or one row at mid-height). **Default** and empty fields keep the wall type's or document's setting. Changing the spacing renumbers the wall's studs.

The list shows, for each wall, how many members regen framed for it and how many of each kind (studs, plates, corners, kings, jacks, headers, sills, cripples). These are the counts the takeoff uses.

## Doors and windows

**Opening** opens the Opening tool. If a member or a layer face of a wall is selected in the view, that wall is chosen; otherwise pick it in the list. Then:

- the **segment** of the wall (each with its length);
- the **kind**: a door (from the floor), a window (with a **sill height** above the wall's base) or a plain opening;
- the **rough opening** width and height;
- the **position**: centred on the segment, or a distance from the segment's start or end to the opening's centre line. A centred opening is placed at the segment's middle as it is now; it does not follow a later change of the wall's length;
- the **header**.

### Headers

An opening's header is, in this order:

1. one **set on this opening** (its stock, plies and jack studs);
2. else the narrowest of your **header rules** at least as wide as the opening (a rule reads "openings up to this width get this header");
3. else the **wall type's default** header.

New documents have **no header rules**: until you write some, every opening uses its own header or its wall type's default. The tool says which header an opening will use before you add it, and the Walls list says which one each opening used after framing: "Your header rule for openings up to 4' 0"", "The wall type's default header", or "Set on this opening", with its stock, plies and jacks. When rules exist and an opening is wider than all of them, it uses the default and the wall shows a layout warning.

The opening cuts the wall's sheathing and drywall, and the wall is framed around it: king and jack studs each side, the header plies on the jacks, a rough sill under a window, and cripples above the header and below the sill on the wall's stud layout. The layout studs in the opening's way are left out; move the opening and they come back with their old ids.

## Changing a single member

Click a member in the view to pick it; the info panel over the view shows its stock, length and cuts, and the **Member** section of the Construction panel offers:

- **Delete member**: the member is left out of the framing (and the takeoff);
- **Change stock**: frame it from another lumber size;
- **Restore**: undo either change.

Each is one undo step, stored on the wall or opening the member belongs to by the member's id (`s12` for the stud in layout slot 12, `king-l` for an opening's left king stud). Changing a wall's spacing or layout start renumbers its studs, so a change kept for a stud that no longer exists is reported on the wall.

## Floors

**Floor** opens the Floor tool. A floor hangs under its **level**: the level's elevation is the top of the subfloor, where the walls stand, and the joists, rims and skids are below it. Choose where its outline comes from:

- **Under the walls on the level**: tick the walls (a building outline is ticked for you). The outline is the outside face of their framing, so they must close a ring, running one way round with their outsides out, as a closed wall from the Wall tool does.
- **Typed points**: 4 to 64 corners, in order round the floor, each an X and a Y in the document's units.
- **A sketch**: the outer loop of straight lines of a sketch on a horizontal plane.

Then:

- the **floor type**, which holds the joist stock, an optional rim joist stock (the joist stock otherwise) and the subfloor sheets. A new document has none: **New floor type** makes one with the floor, and nothing structural is filled in for you;
- the **joists**: across the outline's shorter side (the default), across the longer side, or at an angle in plan you type (`90deg`);
- the **joist spacing** on centre (empty: the floor type's, else 16");
- **blocking**: none, or one row at mid-span;
- **On skids**: the skid stock, how many (1 to 20) and how far they run past the floor at each end.

**OK** adds the floor as one undo step, together with a new floor type if you made one. The **Floors and roofs** list in the panel shows what was framed for each floor (joists, rims, blocking, skids) and **Edit** opens the tool on it again; so does double-clicking the floor in the feature tree. Floor openings (stairs) are not part of M6.

## Roofs

**Roof** opens the Roof tool. A roof **bears on** either:

- **walls on the level**: tick them (a building outline is ticked for you). The outside of their framing must close a **rectangle** and their tops must agree: the rafters sit on the top plates, and the walls' framed thickness is the birdsmouth seat. Other footprints are refused, with the reason on the roof. The roof follows the walls: change their length or height and it rebuilds;
- **a rectangle on the level**: a corner (X, Y), the length and width at the wall line, an optional rotation in plan, the plates' height above the level (the level's wall height if empty) and the wall thickness under the rafters.

Then:

- the **roof type**, which holds the rafter, ridge and hip rafter stock and the roof sheathing. **New roof type** makes one with the roof; nothing structural is filled in;
- the **kind**: **gable** or **hip**. A gable's ridge runs along the longer side unless you choose the shorter. A hip roof needs hip rafters: if its roof type has none, the tool asks for their stock and adds it to the type in the same step;
- the **pitch** (below);
- the **eave overhang**, a gable's **rake overhang** and the **rafter spacing** (empty: the roof type's, else a 12" eave overhang, no rake overhang and 16" on centre);
- **ties**: none, ceiling joists, or rafter ties at a height above the plates, of a stock you choose, on every pair of rafters or every 2nd to 10th;
- **gable studs** on the gable walls' stud layout, cut to the roof line (gable roofs only).

**OK** adds the roof as one undo step. With roof sheathing in its type, each roof plane gets a sheathing body; over walls with sheathing or siding, a gable roof also carries those layers up to the roof line at each gable end.

### The pitch

The pitch field is a slope field. It takes:

- a **rise in 12**: `6/12` or `6:12`, and `7.5/12`;
- **degrees**: `30deg` or `30°`;
- a **percent** slope: `25%`, which is atan(0.25), shown as `3/12`.

A bare number such as `30` is refused as ambiguous ("Ambiguous: write 30° or 30/12"), since it could be degrees or a 30/12 pitch. The field shows what it read as you type, as a pitch in 12 and its angle (`6/12, 26.57°`), and the view previews the roof: its eaves at the wall line, the ridge and the gable ends or hips, with the pitch at the ridge. The pitch is kept as you typed it, so reopening the roof shows `6/12` again. It must be above 0 and below 80 degrees. The Floors and roofs list shows each roof's kind and pitch.

Rafter, ridge and hip sizes are yours: nothing checks them, and a roof below 3/12 with no ties gets a rule-of-thumb warning that a ridge beam may be needed, not a structural assessment.

## Framing settings

**Framing settings** in the panel holds the document's framing defaults: what every wall uses unless its wall type or the wall itself says otherwise. Each field left empty, or set to **Default**, uses the default shown beside it:

- **stud spacing** on centre (16"), where the **layout** starts from (the wall's start) and the **layout origin**, the first stud's centre from that end (0);
- **bottom plates** (1), **top plates** (2) and **king studs** beside each opening (1);
- the **corner** style (two-stud) and a ladder corner's **ladder spacing** (24");
- **blocking**: none, one row at mid-height, or rows at heights you list above the wall's base;
- the least distance between **plate splices** (24");
- the **plate stock lengths** the yard sells and the **precut stud lengths** (92-5/8" and 104-5/8"), as comma-separated lists of up to 20 lengths.

These are settings, not model: they take constants (`24"`), not variables. **Save** is one undo step and every wall rebuilds.

### Header rules

**Header rules** is your table of "openings up to this width get this header": a width, the header stock, its plies and its jack studs at each end. A new document has none and none are suggested: **Add rule** adds an empty row for you to fill in, **Remove rule** takes one out, and **Save rules** stores the table as one undo step. Two rules for the same width are refused. How a rule is chosen for an opening is under [Headers](#headers).

## Takeoff

**Takeoff** at the top of the Construction panel opens the Takeoff panel beside it: the lumber and sheet goods of the part studio's walls, openings, floors and roofs, and what they cost. It counts **as framed**: every member the framing rules made and every sheet face as laid, then what to buy for exactly that. No estimating allowance is added (there is no "one stud per foot of wall" row), so a lumber yard's quick estimate will not match it line for line. Hardware (nails, hangers, anchors) is not counted. The short "not an engineering tool" text heads the panel and every file it writes.

The **Takeoff** tab lists the rows in five sections, each with its total:

- **As framed**: every member, by stock and blank length (`2x4`, `7' 8-5/8"`: 51), with the roles it covers (Stud, Corner stud, King stud).
- **Linear length**: plates, blocking and fascia in all, by stock.
- **Sheet layers as laid**: wall sheathing, siding, drywall, subfloor and roof sheathing, by stock: the area covered, less openings, and the pieces laid.
- **Lumber to buy**: precut studs (studs, kings and corner studs whose length matches a precut stud), and the rest laid out on the lengths the yard sells with a 1/8" kerf. A plate longer than every length sold is bought in pieces and flagged.
- **Sheets to buy**: whole sheets, from each face's layout: full sheets from the face's corner, cut around openings, offcuts reused on the same face and then across faces.

In the two sections to buy, the quantity counts what you buy (sticks, precut studs, sheets) while the row names the members or faces cut from it, and says so under the item: "13 sticks" with "cut into 37 members". Click a row to select its members, or the layer bodies of its faces, in the viewport.

**Cost** is each row to buy times its stock's price, from the prices in the document's stock settings (per piece, foot, metre, board foot or sheet). A row with no price, a price per a unit that does not fit the stock (per sheet on lumber) or a price in another currency is left out of the total, and the panel lists those rows by number under the total, together with the rows of any stock this version's catalog does not know. Below the rows, **subtotals** give what was framed and laid per level and per feature.

The **Sheet layouts** tab draws every face to scale with its pieces (numbered by column and row from the starting corner; whole sheets, pieces from offcuts dashed, pieces cut from new sheets shaded) and its openings' cut-outs, then the sheets the partial pieces were packed on, and every lumber stick with its cuts.

**Takeoff settings** are stored with the document as one undo step:

- **Buy studs as precut studs** where their length matches (on by default);
- **Sheet waste (%)**: added to the sheets each stock needs, then rounded up (none by default);
- **Currency**: a three-letter code such as `USD`; empty uses the currency the prices state, and prices in another currency are left out;
- **Lengths the yard sells**, per lumber stock in the takeoff, as a comma-separated list (`8', 10', 12', 16'`): empty uses the catalog's lengths, and `cut` buys each piece at its own length.

**Takeoff CSV** writes one line per row (section, number, item, stock, size, quantity, total, other totals such as board feet, price, cost, what a row to buy is cut into, notes), then the subtotals and the cost; the title and the short disclaimer come first. **PDF** writes the same rows by section on Letter landscape pages for inch and foot documents, A4 landscape otherwise, with the disclaimer at the top of the first page and the foot of every page.

## Still to come

These are being built in the M6 milestone; until each task fills in its section, the feature is not in the app.

- **Drawings**: plans, building elevations, framing elevations of each wall and a roof framing plan, with dimension strings.
