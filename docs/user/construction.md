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

## What this page will cover

The construction features are being built in the M6 milestone. The sections below are an outline; each is filled in by the task that builds the feature, and until then the feature is not in the app.

- **Levels**: named floor heights a building's walls, floors and roofs stand on.
- **Walls**: a wall drawn along a line, built from a wall type's layers (framing, sheathing, drywall, siding), and how walls join at corners and tees.
- **Doors and windows**: openings placed in a wall by their rough opening, and the header each one uses.
- **Floors**: joists, rims and blocking under a floor outline, with skids for a shed.
- **Roofs**: gable and hip roofs at a pitch typed as `6/12`, with their overhangs.
- **Framing**: the members the app lays out, the framing settings, and changing a single member (deleting it, changing its stock, moving a stud).
- **Takeoff**: the lumber and sheet list, as framed, with lengths, sheet layouts and cost, exported as CSV or PDF.
- **Drawings**: plans, building elevations, framing elevations of each wall and a roof framing plan, with dimension strings.
