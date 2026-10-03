# The 3D viewport

The viewport shows the model and is where you pick faces, edges and vertices. On start-up it shows a loading screen while the geometry kernel downloads and starts (about 42 MB on a first visit, cached after that), then the model. The model is rebuilt from the [feature tree](feature-tree.md) after every change; an empty document shows a hint to start with a sketch.

## Mouse

Navigation follows Onshape by default. Pick another preset in the toolbar under **Mouse**; the choice is remembered in this browser.

| Action | Onshape (default)                       | Fusion style        | FreeCAD (CAD style)              |
| ------ | --------------------------------------- | ------------------- | -------------------------------- |
| Orbit  | Right drag                              | Shift + middle drag | Middle + left, or middle + right |
| Pan    | Middle drag, Shift or Ctrl + right drag | Middle drag         | Middle drag                      |
| Zoom   | Wheel                                   | Wheel               | Wheel, or Ctrl + middle drag     |
| Select | Left click                              | Left click          | Left click                       |

- The wheel zooms towards the point of the model under the cursor; over empty space it zooms towards the cursor.
- Panning keeps the point you grabbed under the cursor.
- Orbiting turns about the vertical (Z) axis and the screen's horizontal axis, so the model never rolls.
- The left button never moves the camera, in any preset.

Keys, with the viewport focused (click it once): **F** zooms to fit, **Esc** clears the selection.

## Views

- **Front**, **Top**, **Right** and **Iso** in the toolbar turn to that view and fit the model. Z is up; the front view looks at the model from the -Y side.
- **Fit** (or **F**) frames the whole model without turning it.
- The **view cube** in the top right corner turns with the model. Click one of its faces, edges or corners to look from that direction; the region under the pointer is highlighted before you click. Transitions are animated.
- **Perspective / Orthographic** switches the projection. The model keeps its apparent size, and the choice is remembered.

The ground grid lies on the XY plane, with the X axis in red and the Y axis in green. A part standing on the grid hides it, seen from above or below. Its spacing follows the zoom in steps of ten (1 mm, 10 mm, 100 mm, ...), and finer lines fade in as you zoom in. **Show grid** and **Show edges** switch the grid and the model's edge lines off and on.

## Selecting

- Hover to see what a click would pick: faces light up, edges thicken and vertices show a dot. The side panel names what is under the cursor.
- **Click** selects one item, replacing the selection. **Shift + click** adds to it. **Ctrl + click** (Cmd on macOS) adds or removes one item. A plain click on empty space clears the selection.
- Edges and vertices are picked within a few pixels of the pointer, and win over the face around them.
- Only what you can see can be picked. A face, edge or vertex hidden behind the model is out of reach, even where a face next to it is in view (a fillet's far edge, say, just behind the rounded surface). When an edge is partly hidden, only its visible part counts.
- **Select: Faces, Edges, Vertices, Members** is the selection filter. Clear a box to make that kind unpickable, for example to click a face right next to an edge. Items already selected stay selected.

The side panel lists the selection in the order you picked it, by name. Two tags may appear next to a name:

- **placeholder**: the viewport made the name up because the modelling history has not named that face, edge or vertex. Faces and edges of the part always have real names; vertices and the faces of an imported STL mesh have placeholders. Placeholder names are never stored in a document.
- **fragile**: the name depends on the position of the item, so after an edit it may point at a different face or edge. Check such references after changing the model.

## Section view

**Section** cuts the model with a plane so you can see inside it.

- **On** switches the cut on and off.
- The axis menu (X, Y or Z) sets which way the plane faces, and the slider moves it across the model.
- **Flip** keeps the other side.

The cut surface is filled with a solid colour (the cap), so the model still looks solid. What is cut away cannot be hovered or selected, and the cap itself is not selectable.

## Framing members

A building's framing members (studs, plates, headers, joists, rafters) are drawn next to its bodies. Members are not bodies: each is a piece of stock with a length, a position and its cuts, and identical members share one shape, so even a house of hundreds of members draws quickly.

- **Picking**: a member is picked as a whole, never one of its faces. Hover lights it up; click selects it, with Shift and Ctrl working as for faces. A visible edge or vertex of a body near the pointer still wins over the member under it. Members can be switched off in the selection filter like any other kind.
- **Colours**: members are coloured by role (plates, studs, headers, rafters each in their own lumber tone). Hovering a wall, opening, floor or roof in the feature tree lights up every member it owns.
- **The member panel**: with a member selected, a panel in the bottom left corner of the viewport shows its role and id (`<feature id>:<member id>`, for example `opening#2:king-l`), its stock with the actual sizes, its length (the blank cut from stock) and its cuts: square ends, end cuts with their angle off square (plumb and side cuts), face cuts (seats) and notches (birdsmouths). Lengths follow the document's display units. Press **Escape** to clear it.
- **Measuring**: the measure tool works on bodies only. Members have no faces or edges to measure; their sizes are in the member panel.
- **Edges**: member outlines are drawn while the stock is at least a few pixels wide on screen; zoomed far out they are left off, which keeps large buildings fast. **Show edges** switches them off and on with the rest.

### Layers and levels

The construction tools drive two more ways to see inside a building:

- **Hiding layers**: a wall's sheathing, drywall and siding are bodies named after their layer. Hiding a layer (sheathing, say) hides it on every wall, so the framing behind shows; members and other bodies stay.
- **Level cut**: shows one level the way a floor plan does. Everything more than a cut height above the level (4' by default) is cut away, and, when asked, everything under the level too, so the levels below are hidden. Bodies and members are cut alike, and what is cut away cannot be hovered or selected. It works together with the section view.

## Exporting framing

STL and 3MF export include the members of the part being exported, after its bodies. In 3MF each member is an object of its own, named by its id; in STL they are added to the one file, or, with one file per body, written together into one more file named `<name> members.stl`. STEP export writes every member as exact geometry in the same file as the bodies, each a product named by its id: the members are built as solids only for the export (with their cuts, such as a rafter's birdsmouth), a batch per wall, floor or roof, and let go at once. The export's message says how many members it wrote, and names any it could not build. In a document with construction features the STEP file's header description is the short "not an engineering tool" notice.
