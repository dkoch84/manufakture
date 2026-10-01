# Assemblies

An **assembly** puts parts together: a lid hinged on a box, a drawer that slides into a cabinet, a handle screwed to the drawer. It holds **instances** of parts (the part studios of this document, or parts of other documents at a named version) and **mates** between them that say how they connect and how they may still move. The parts themselves are not copied: an instance shows its part as the part studio builds it, so an edit to the part shows in every assembly that uses it.

## Assembly tabs

Assemblies are tabs next to the part studios at the bottom of the editor. **+ Assembly** adds one, named "Assembly 1", "Assembly 2" and so on, and opens it. Double-click a tab (or **Rename**) to rename it, and **Delete** removes the open assembly with its instances and mates. Every change is one step that **Undo** takes back, and undo or redo switch to the tab they changed. A reload opens the tab that was open.

In an assembly tab the feature toolbar gives way to **Insert**, **Mate** and **Interference**, and the feature tree to the assembly's tree: how many degrees of freedom it has left, its instances, and its mates.

## Inserting instances

**Insert** opens the Insert panel:

- **Part studios of this document**: **Insert** adds an instance of that part studio, at the origin. Insert the same part studio as often as you need; the instances are numbered ("Lid 1", "Lid 2").
- **A part of another document, at a version**: choose a document, one of its named versions (or **Create version now**), and a part studio, exactly as for a [derived part](derived.md), then **Insert**. The version travels inside your document, so the instance still shows after the other document changes or is deleted; to take a newer version, insert again.

The first instance of an assembly is **fixed**: it stays where it is, and the others are mated to it. **Fix** and **Unfix** in the tree change that for any instance. **Suppress** takes an instance out of the assembly without deleting it (its mates are suppressed with it). **Delete** is offered once no mate connects the instance any more; delete its mates first.

## Mating

A mate connects a **mate connector** on one instance to one on another. A connector is a point with axes, found on a face, an edge or a vertex you pick:

- on a flat face, its **centroid**, with z pointing out of the face;
- on a cylinder, cone or sphere, its **centre** on the axis (or the centroid);
- on a circular edge, the circle's **centre** (or the edge's midpoint), with z along the circle's axis;
- on a straight edge, its **midpoint**, with z along the edge;
- on a vertex, the vertex.

While the pointer is over a face, edge or vertex of an instance, a dot shows where a connector picked there would sit, with the rule's name.

**Mate** opens the Mate dialog:

1. **Kind** says what the mate leaves free between the two connectors: **Fastened** (nothing), **Revolute** (a turn about z: a hinge), **Slider** (a move along z: a drawer), **Planar** (a move in the xy plane and a turn about z), **Cylindrical** (a move along and a turn about z) or **Ball** (any turn about the point).
2. **First connector**: click a face, edge or vertex of an instance. The dialog shows what it took, and **Point** chooses another rule where the geometry allows one (a circle's centre or its midpoint, say).
3. **Second connector**: the same, on another instance. Once both are picked, the instances move to where the mate puts them, so you see the result before you accept it.
4. Adjust the second connector if the instance ends up the wrong way round: **Flip** turns its z axis round (a lid that hangs upside down inside the box lies on it once flipped), and **Rotate 90 degrees** turns it a quarter turn about z.
5. **Offset** moves the second instance along the first connector's x, y and z, and turns it about z: a handle 4 mm in front of a drawer is a fastened mate with an offset of 4 mm in z. The fields take expressions, so `#gap` or `90 deg` work as anywhere else.
6. **Limits** (revolute and slider only) keep dragging between a minimum and a maximum: angles for a revolute, lengths for a slider. Leave them empty for no limit.

**OK** adds the mate, together with where it moved the instances, as one step; **Undo** takes both back. **Cancel** or Escape leaves everything as it was.

## The mates list

Each mate shows its kind and what the last solve made of it:

- **OK**: the mate holds.
- **Redundant**: another mate already holds it (two fastened mates between the same two instances, say). It does no harm, but it adds nothing either.
- **Conflicting**: it cannot hold together with others, for example a fastened mate that contradicts a hinge. The assembly's summary says which mates disagree, and the newest of them is marked **change or suppress this one**.
- **Error**: a connector cannot be found any more, usually because the part changed and the face, edge or vertex it was on is gone. The message names it and ends in "re-pick it": **Edit** the mate and pick the connector again. Until then the mate is left out, and its instances move freely.
- **Suppressed**: switched off with **Suppress**, kept for later.

**Edit** opens the Mate dialog on the mate, to change its kind, its connectors, the flip, offset or limits. The summary at the top counts the **degrees of freedom** left: 6 for every instance that nothing holds, plus what the mates leave free. A box with a hinged lid has 1.

## Dragging

Drag an instance with the left mouse button to move it as far as its mates allow: a hinged lid turns about its hinge, a drawer on a slider moves in and out and nowhere else, and everything fastened to it moves with it. Limits stop the drag at their bounds. A fixed instance does not move; unfix it first. The camera keeps its usual buttons, and a click without moving still selects.

Letting go records where everything ended up as one step, so **Undo** puts it back.

## Interference

**Interference** opens the Interference panel, which lists every pair of instances that overlap, with the volume they share: a drawer too deep for its cabinet, a screw longer than its hole, two parts placed in the same spot. **Check** runs it on the assembly as it is shown, including an instance you are dragging.

- Pairs appear as they are found; a large assembly can take a while, and **Stop** ends the check with the pairs found so far.
- Instances that only touch (a lid lying on a box, a handle against a drawer) are not listed. Overlaps of 0.001 mm³ or less are ignored.
- Click a pair to select both instances and outline the space they share; click it again to clear it.
- An instance shows its part's bodies, and only overlaps between instances count: two bodies of the same part that overlap are the part studio's business.
- The check is never run by itself, so editing and dragging stay quick. Once the assembly changes, the panel says so: **Check again**.

Volumes are shown in the document's units. Only pairs whose bounding boxes overlap are intersected, so a spread-out assembly is checked quickly whatever its size.

## Exporting

**Export** in an assembly tab saves the whole assembly as STL, 3MF or STEP, each part written once and placed where its instances are; see [Exporting an assembly](import-export.md#exporting-an-assembly).

## How it is solved

Mates are solved in the background, in the same worker that builds the part studios, so the editor stays responsive while an assembly is solved or dragged. Assemblies that are trees of mates (each instance hanging off a fixed one, as most are) are placed exactly; a closed loop of mates (a four-bar linkage) is solved numerically from where the instances were last. That is why the poses are saved: they choose between the solutions of a loop, and they are where a mate that cannot be solved leaves its instances.

## Example

1. Make two part studios: a box of 40 x 30 x 20 mm and a lid of 40 x 30 x 5 mm (a rectangle from the origin on Top, extruded).
2. **+ Assembly**, then **Insert** the box (it is fixed) and the lid.
3. **Mate**, **Kind** revolute. Pick the box's top front edge, then the lid's bottom front edge. The lid hangs upside down inside the box: tick **Flip** and it lies on the box. **OK**: the summary says 1 degree of freedom.
4. Drag the back of the lid up: it opens about the hinge.
5. Make a drawer of 30 x 20 x 10 mm and a handle of 10 x 4 x 4 mm. In a new assembly, insert the box, the drawer and the handle.
6. Mate the box's front face to the drawer's front face with a slider, limits 0 and 25 mm. Drag the drawer: it slides out, up to 25 mm.
7. Mate the drawer's front face to the handle's front face, fastened, with an offset of 4 mm in z: the handle sits on the drawer, and the assembly still has 1 degree of freedom.
8. Pull the drawer all the way out (25 mm) and open **Interference**: **Check** finds nothing (the handle only touches the drawer).
9. Make the drawer 30 mm deep instead of 20 and **Check again**: Box 1 and Drawer 1 overlap by 1500 mm³ (30 x 5 x 10 mm, the back of the drawer inside the box). Click the pair to see where. Back to 20 mm, and the list is empty again.
