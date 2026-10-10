# Bodies

A part can hold several separate solids, called **bodies**: a box and its lid, the two halves of a clamp, a part and the jig that holds it. Each body has its own name, colour and material, can be hidden, and is exported as its own object.

## Making bodies

An **Extrude** or **Revolve** whose **Result** is **New body** makes a body of its own, even where it overlaps a body that is already there: the two stay separate, and each keeps its full volume. The first extrusion of a part is a new body by default; after that, **Add** is the default.

**Add** joins the new solid to the bodies it touches. When it touches two or more, they become one body, which keeps the name and settings of the body made first; the others are gone from the list. An **Add** that touches no body makes a new body of its own (the feature warns that it is detached).

**Remove** (a cut) and **Intersect** change every body they reach. A cut that splits a body into separate pieces keeps them as one body; the Bodies list says how many solids it holds (**2 solids**).

## Choosing which bodies a feature changes

Extrude and Revolve (other than **New body**), **Hole**, and **Pattern** or **Mirror** of the whole body have a **Bodies** field once the part has more than one body. **All bodies**, the default, is every body there is at that point in the feature list. Untick it and choose the bodies: a cut through a box and its lid can then cut the box only. Fillets, chamfers and shells need no choice: they change the body the picked edges or faces belong to.

## The Bodies list

The [feature tree](feature-tree.md) lists the part's bodies above its features:

- **Colour swatch**: click it to pick the body's colour. New bodies get colours of their own, in turn; the first keeps the usual grey.
- **Name**: double-click it, or click **Rename**, then type and press Enter (Escape cancels). An empty name goes back to the default one: the part's name when it has one body, **Body 1**, **Body 2** and so on when it has several.
- **Material**: what the body is made of, for its mass and its mechanical and thermal properties; [Materials](materials.md) lists the built-in ones and where their values come from. **Part material** uses the part's material (set in the Measure panel), so bodies of the same stuff need no setting each.
- **Hide** and **Show**: a hidden body is not drawn and cannot be clicked or picked, so what is behind it can be. **Isolate** hides every other body; **Show all** brings them back.

Name, colour and material are saved in the document, and each change is one step for **Undo**. Hiding is part of the view, like the camera: it is not an undo step, is not saved in the file, and is remembered for each document while the app is open.

## Groups

A part with many bodies (a sim rig's frame, seat, wheel stand and pedal box, say) is easier to handle in **groups**: hide a whole subassembly at once instead of body by body.

- **Making a group**: tick the bodies in the Bodies list, or select a face, edge or vertex of each in the view (Shift adds to the selection), then click **Group** at the top of the list. The new group's name is ready to type; press Enter to keep **Group 1**. A body is in one group at most: grouping a body that is already in a group moves it.
- **The group row** shows the group's name and how many bodies it holds, with its bodies listed under it. The arrow in front collapses or expands the list.
- **Rename** works as for a body (double-clicking the name also does).
- **Hide** and **Show** hide or show every body of the group; **Isolate** hides everything else. A body's own **Hide**, **Show** and **Isolate** still work inside a group, and the group's name looks faded when all of its bodies are hidden, and in italics when only some are.
- **Add** puts the ticked (or selected) bodies into the group, taking them out of any other. **Remove** on a body's row takes it out of its group.
- **Delete** removes the group. Its bodies stay, back in the list on their own.

Groups are saved in the document like body names: creating, renaming, changing and deleting a group are each one step for **Undo**. Hiding a group is part of the view, like hiding a body: it is not an undo step and is not saved in the file. Groups change nothing else: the cut list, exports, measuring and selection treat grouped bodies exactly like the rest.

A body that is gone for now (merged into another by an **Add**, behind the rollback bar, or made by a suppressed feature) is not listed in its group, and is back in it when it returns.

## Deleting a feature that makes a body

Deleting a feature that makes a body also removes that body's name, colour and material, takes it out of its group, and takes the body out of the **Bodies** fields of the features after it, all in one undo step. A feature whose **Bodies** field named only that body is deleted with it.

## Measuring and exporting

With nothing selected, the [Measure panel](measure.md) lists every shown body with its volume, surface area and, with a material, its mass. Selecting a face, edge or vertex shows the body it belongs to.

[Export](import-export.md) writes the shown bodies by default: one named object per body in 3MF, one named product per body in STEP, and in STL one file of all of them or one file per body. The Export menu has a checkbox per body to change that.
