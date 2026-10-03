# Laser and plasma cutting: DXF and SVG outlines

A laser cutter or a plasma table cuts along 2D outlines. **Laser or plasma (DXF, SVG)...** in the **Export** menu writes a part's outlines as a DXF or SVG file for the cutter's own software: the outline of a flat face, the regions of a sketch, or a section through the part, with exact arcs, in millimetres, and optionally moved out by half the kerf so the part comes out the size you modelled.

It is offered in a part studio, not on an assembly tab, and only while no feature dialog, sketch, drawing, Print or Manufacture workspace is open. The dialog opens in the panel on the right; the view keeps showing the part so you can pick its faces. **Close** or Escape closes it, and so does starting a feature (from the toolbar or the tree), a sketch, a workspace or an assembly tab, so it never hides the panel you opened. Nothing in it changes the document.

## What to cut

Add one or more sources under **What to cut**:

- **Faces**: picking is on when the dialog opens; click flat faces of the part in the view. Faces already selected when you open the dialog are taken too. **Pick faces** turns picking off and on. A curved face, an edge or a face of another part is refused, and the dialog says why. A face gives its whole outline: the outer edge and every hole in it.
- **Sketch regions**: choose a sketch of the part and press **Add its regions**: every closed region of the sketch, with its holes. The sketch must lie on a plane square to one of the model axes (the Top, Front and Right planes, or a plane parallel to one); for a sketch on a slanted face, pick the face instead.
- **Section**: choose an axis and where along it the plane crosses the part (a model coordinate, which may be an expression like `#thickness / 2`; it starts at the middle of the body, written in millimetres such as `12.5 mm` so it means the same in an inch document; a bare number is read in the document's units), then **Add section**. A section across X is seen from the right, across Y from the front, across Z from the top. The plane must cut the body.

When the part has several bodies, choose the **Body** first: faces are picked on that body, and the section cuts it.

Every source must lie in a plane parallel to the first one; they are drawn in that plane, seen from the outside of the first face (or as the standard view sees a section or a sketch). Sources on parallel planes at different heights are drawn on top of each other. To export outlines in planes that are not parallel, export them one at a time.

**Remove** takes a source out again.

## Layers

Each source goes to a layer, named in the **Layer** box next to it: `face-1`, `region-1`, `section-1` and so on unless you rename it. Sources with the same layer name share one layer, so naming every source `cut` puts the whole outline on one layer; giving holes and outlines different names lets the cutting software treat them differently (cut the holes first, say). A layer needs a name. In a DXF, characters a DXF layer name cannot hold (`<>/\":;?*|=`, the backquote and anything outside plain ASCII) become `_`, and names that differ only in case count as the same; in an SVG, each group's id keeps only letters, digits, `_`, `.` and `-`. When two different names come out the same in the file (`cut` and `Cut` in a DXF, `a b` and `a_b` in an SVG), the export says so: in a DXF the later layer gets `_2` added, and a layer named `0` (DXF's own default layer) is written as `0_2`. Rename the layers to keep them apart.

## The outline

Under the sources the dialog shows the outline it read: its size in millimetres and how many loops are on how many layers. It is read again whenever the sources change. If something cannot be exported, it says what and which source: a face that a model edit removed, a sketch region that is gone, a source that is not parallel to the first, a plane that misses the body.

Lines and circular arcs come out exact. Any other curve (a spline edge, an ellipse) comes as short lines within 0.01 mm of it.

## Format

- **DXF**: an ASCII DXF (AutoCAD 2000 format), in millimetres. Each loop is one closed polyline with its arcs as exact arc segments; a loop that is a whole circle is a circle.
- **SVG**: millimetres, with the page the size of the outline (`width` and `height` in mm, the view box in mm). Each loop is one closed path with arc commands; each layer is a group named after it.

The drawing is moved so its lower left corner is at 0, 0. The file is named after the body (`Bracket.dxf`) and downloads like any other export; the status line in the header says what was written.

## Kerf

The beam of a laser or the arc of a plasma torch removes a strip of material as wide as the **kerf**. Cut along the model's outline, a part comes out half the kerf small on every side and its holes half the kerf large. With a kerf set, the export moves every outer loop out and every hole in by half the kerf, so the edge of the cut lands on the model's edge.

- Each loop is moved on its own, as the cutter follows it. Arcs stay arcs (a fillet of 4 mm inside a corner becomes one of 3.9 mm for a 0.2 mm kerf); outside corners become round, with a radius of half the kerf, which is the shape a round beam leaves there anyway.
- A hole narrower than the kerf closes up and is left out; the dialog says how many.
- `0` (or an empty box) cuts on the outline itself.

The **Kerf** box takes an expression with units (`0.2 mm`, `0.008"`). It is checked as you type and the message shows under it: the kerf must be zero or more, at most 10 mm (anything wider is not a laser or plasma kerf, and is most likely a value in the wrong units), and at most a quarter of the outline's smaller side. **Export** stays off until the kerf is accepted.

The kerf depends on the machine, the material, its thickness, the power and the speed. Measure it rather than guessing: export a 20 mm square with a kerf of 0, cut it, and measure it; the kerf is 20 mm less the size you measured.

Set the kerf here or in the cutting software, not in both: most laser and plasma software can offset the path itself, and doing both moves the cut twice.

## What it does not do

- It exports closed outlines only: no engraving lines, no open sketch curves, and a section of a body that is not closed leaves out the chains that do not close (the dialog says how many).
- It does not nest parts on a sheet or order the cuts; the cutting software does that.
- A sketch on a slanted plane cannot be added as regions; pick the face it made instead.
