# Measuring

The **Measure** panel, in the side panel under the selection, shows exact measurements of whatever is selected in the 3D view, and of the whole body. Values come from the model's exact geometry, not from the triangles the view draws, so a circle measures as a true circle and a distance is not off by the mesh's facets.

## What it shows

Select faces, edges and vertices as usual: click to select one, Shift+click to add, Ctrl+click (Cmd+click on macOS) to add or remove. The selection filter limits what a click can pick.

For **each selected item**:

| Item   | Values                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------- |
| Face   | Its area. A cylindrical or spherical face (a hole wall, a round) also its radius and diameter. |
| Edge   | Its length. A circle or arc also its radius, diameter and centre; an arc the angle it spans.   |
| Vertex | Its position (x, y, z).                                                                        |

With **exactly two items selected**, **Between** adds:

- **Distance**: the shortest distance between the two, for any combination (face to face, edge to edge, vertex to face, and so on). Two items that touch are 0 apart. The view draws the two closest points (the witness points) and a dashed line between them, labelled with the distance. For parallel faces, many point pairs are equally close; the pair in the middle of them is drawn.
- **X, Y and Z distance**: how far apart those two closest points are along each axis.
- **Angle**: between two straight edges, two flat faces, or a straight edge and a flat face. A hole or other cylindrical face counts as its axis. The angle is always between 0 and 90 degrees, like the angle between two lines on paper.
- **Between normals**: for two flat faces, the angle between the directions they face (0 to 180 degrees). Two opposite sides of a block are 0 degrees apart as planes but 180 degrees apart as normals.

With nothing selected, and always at the bottom, **Body** shows the whole part: **Volume**, **Surface area**, **Centre of mass** (for a body of uniform density), **Size** (the bounding box along X, Y and Z) and the bounding box corners, **Box min** and **Box max**.

In a part of several [bodies](bodies.md), **Body** is the body the selection is on, with its name (**Body: Lid**). With nothing selected, every shown body gets a section of its own, titled with its name.

## Units

Every value is shown in the document's display units, the same ones the rest of the app uses. In a woodworking document set to feet and inches, lengths read `3' 4-1/2"`, rounded to the fraction the document uses; in a metric one, `1028.70 mm`. Angles follow the document's angle unit (degrees or radians).

Areas and volumes are shown in the square and cubic length unit (mm², cm³, in², ft³, ...). Documents with fractional inch formats show them in square and cubic inches.

## Material and mass

Pick a **Material** under Body to get the body's **Mass**. The choice is saved in the document and is one undo step, like any other change. In a part of several bodies this is the **Part material**: the material of every body that has none of its own. A body's own material is set in the Bodies list of the feature tree, and its mass uses that one. The built-in materials, with the typical density each uses and where it comes from, are listed in [Materials](materials.md).

With a material, Body also shows the **moments of inertia**, which say how hard the body is to spin (what a motor needs to speed up a spool or a flywheel):

- **Ixx**, **Iyy** and **Izz**: about axes along X, Y and Z through the centre of mass.
- **Principal moments**: the smallest, middle and largest moment, about the body's principal axes. Hover over them to see those axes as directions. A shaft's smallest principal moment is the one about its own axis.

Metric documents show g·mm² for small values and kg·m² from 0.001 kg·m² up (1 kg·m² is 1,000,000,000 g·mm²); imperial ones lb·in². They use the same typical density as the mass, so they are estimates too. A mesh body (an imported STL) shows no moments of inertia.

For the moment about any other axis (a hinge, a mate's axis), or for a whole assembly at its poses, ask an [agent](agents.md): its `measure` tool gives the full inertia tensor, the moment about an axis it names, and the total of an assembly's instances.

These are typical values, so the mass is an estimate. Real stock varies: wood with the species, the board and how dry it is; panels by maker; filament by brand. A 3D print weighs less than its solid volume suggests, because of its infill. Hover over the mass to see the density and source it used. Metric documents show grams or kilograms, imperial ones ounces or pounds.

## Copying values

Every value has a **Copy** button that puts it on the clipboard exactly as shown. **Copy all** copies every section, one value per line, for pasting into a cut list or a message.

## Good to know

- Measuring needs the geometry kernel. Scenes without it (the test scenes) say so in the panel.
- The measurement is redone whenever the selection or the model changes.
- The witness line is drawn on top of the model, so it stays visible when the closest points are behind a face.
