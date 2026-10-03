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

Construction tools live in the part studio, in the **Construction** group of the feature toolbar: **Construction** opens the panel, **Wall** draws a wall, **Opening** puts a door or window in one. A building is one part studio: every wall, opening and member of it regenerates together.

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

The path is drawn in the view as it grows; **Remove last** takes back the last length or point. **Add wall** adds the wall as one undo step.

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

## Still to come

These are being built in the M6 milestone; until each task fills in its section, the feature is not in the app.

- **Floors**: joists, rims and blocking under a floor outline, with skids for a shed.
- **Roofs**: gable and hip roofs at a pitch typed as `6/12`, with their overhangs.
- **Framing settings**: the document's framing defaults and the header rules table.
- **Takeoff**: the lumber and sheet list, as framed, with lengths, sheet layouts and cost, exported as CSV or PDF.
- **Drawings**: plans, building elevations, framing elevations of each wall and a roof framing plan, with dimension strings.
